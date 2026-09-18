import "server-only";

import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertValidKey } from "./keys.ts";
import {
  ObjectNotFoundError,
  type ObjectMetadata,
  type PutOptions,
  type SignedUrl,
  type StorageProvider,
  type StoredObject,
} from "./types.ts";

/**
 * S3-compatible object storage.
 *
 * Written against the S3 API rather than any one vendor, so AWS S3,
 * Cloudflare R2, Backblaze B2, MinIO and Google Cloud Storage's S3 endpoint all
 * work from configuration alone. `forcePathStyle` is on because that is what
 * every non-AWS implementation expects; AWS accepts it too.
 *
 * The bucket is expected to be PRIVATE. Nothing here makes an object public,
 * and there is deliberately no method that could: media reaches a browser only
 * through a short-lived presigned URL, issued after the application has checked
 * project access.
 *
 * Credentials come from the environment and stay inside this module. They are
 * never returned, never logged, and never reach a response body — the presigned
 * URL carries a *signature*, which is not the key that produced it.
 */
export interface S3Config {
  bucket: string;
  region: string;
  /** Required for non-AWS S3-compatible endpoints; omit for AWS itself. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function s3ConfigFromEnv(): S3Config | undefined {
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;

  return {
    bucket,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    accessKeyId,
    secretAccessKey,
    // Path style unless explicitly turned off, because it is what the
    // S3-compatible vendors need and AWS tolerates.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  };
}

/** True when a provider error means "no such object" rather than a real failure. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.Code === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export class S3StorageProvider implements StorageProvider {
  readonly id = "S3" as const;
  readonly description: string;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    // Endpoint and bucket only — no part of the credential appears here, and
    // this string is shown in diagnostics.
    this.description = `S3-compatible (${config.endpoint ?? "aws"}/${config.bucket})`;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    assertValidKey(key);
    const checksum = createHash("sha256").update(body).digest("hex");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: body.byteLength,
        // Recorded on the object so a later integrity check does not need the
        // database to say what the bytes should hash to.
        Metadata: { sha256: checksum },
      })
    );
    return { key, contentType: options.contentType, size: body.byteLength, checksum };
  }

  async get(key: string): Promise<Buffer> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new ObjectNotFoundError(key);
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw err;
      throw new ObjectNotFoundError(key);
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    assertValidKey(key);
    if (endInclusive < start) return Buffer.alloc(0);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=${start}-${endInclusive}`,
        })
      );
      const bytes = await result.Body?.transformToByteArray();
      if (!bytes) throw new ObjectNotFoundError(key);
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) throw err;
      throw new ObjectNotFoundError(key);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // "Already gone" is this method's success condition, and it has to mean
      // the same thing on every backend: deletion runs *after* the Asset row is
      // removed, so a retry must not turn a completed delete into an error.
      // AWS itself answers 204 for an absent key, but S3-compatible servers
      // differ, so the absence is normalised here rather than assumed.
      if (!isNotFound(err)) throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== undefined;
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return {
        contentType: result.ContentType ?? "application/octet-stream",
        size: Number(result.ContentLength ?? 0),
        lastModified: result.LastModified,
        checksum: result.Metadata?.sha256,
      };
    } catch {
      return undefined;
    }
  }

  async signedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; contentType?: string } = {}
  ): Promise<SignedUrl> {
    assertValidKey(key);
    const expiresIn = options.expiresInSeconds ?? 300;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
      }),
      { expiresIn }
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async signedUploadUrl(
    key: string,
    options: { contentType: string; expiresInSeconds?: number; maxBytes?: number }
  ): Promise<SignedUrl> {
    assertValidKey(key);
    const expiresIn = options.expiresInSeconds ?? 300;
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
        // Signed in, so a browser cannot quietly PUT a larger object than the
        // application authorised.
        ContentLength: options.maxBytes,
      }),
      { expiresIn }
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }
}
