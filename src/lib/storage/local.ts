import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
 * Local filesystem storage — DEVELOPMENT ONLY.
 *
 * Kept so the application runs with no cloud credentials, and so the test suite
 * exercises the same interface production uses. It is not a production store:
 * it does not survive a serverless deploy or a replaced container, cannot be
 * shared between app instances, and has no redundancy. See the README.
 *
 * Its "signed URL" is a real HMAC over the key and an expiry, pointing back at
 * the application's own media route. That keeps the interface honest — callers
 * get a short-lived URL in development exactly as they do in production — while
 * being clear that the application, not a CDN, is still serving the bytes.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly id = "LOCAL" as const;
  readonly description = "Local filesystem (development only)";

  private readonly root: string;
  private readonly signingKey: string;

  constructor(root = process.env.STORAGE_DIR || path.join(process.cwd(), "storage", "uploads")) {
    this.root = path.resolve(root);
    // Falls back to AUTH_SECRET so a dev install needs no extra configuration;
    // the value never leaves the server and never appears in a URL.
    this.signingKey = process.env.MEDIA_URL_SECRET || process.env.AUTH_SECRET || "development-only";
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const resolved = path.resolve(this.root, key);
    // Second line of defence: even a key that somehow passed validation cannot
    // address a path outside the storage root.
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new ObjectNotFoundError(key);
    }
    return resolved;
  }

  async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return {
      key,
      contentType: options.contentType,
      size: body.byteLength,
      checksum: createHash("sha256").update(body).digest("hex"),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new ObjectNotFoundError(key);
    }
  }

  async getRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
    const length = endInclusive - start + 1;
    if (length <= 0) return Buffer.alloc(0);
    let handle;
    try {
      handle = await open(this.resolve(key), "r");
    } catch {
      throw new ObjectNotFoundError(key);
    }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch {
      // Already gone is the desired end state.
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async head(key: string): Promise<ObjectMetadata | undefined> {
    try {
      const info = await stat(this.resolve(key));
      return { contentType: "application/octet-stream", size: info.size, lastModified: info.mtime };
    } catch {
      return undefined;
    }
  }

  async signedDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number } = {}
  ): Promise<SignedUrl> {
    assertValidKey(key);
    const expiresInSeconds = options.expiresInSeconds ?? 300;
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = signKey(this.signingKey, key, expires);
    const params = new URLSearchParams({ key, expires: String(expires), signature });
    return {
      url: `/api/media?${params.toString()}`,
      expiresAt: new Date(expires * 1000),
    };
  }
}

/** HMAC over the exact key and expiry. Both are echoed in the URL and both are signed. */
export function signKey(secret: string, key: string, expiresAtEpochSeconds: number): string {
  return createHmac("sha256", secret).update(`${key}:${expiresAtEpochSeconds}`).digest("hex");
}

/**
 * Checks a local signed URL.
 *
 * Compares in constant time, and rejects an expired link even when the
 * signature is valid — an old URL must stop working, which is the entire point
 * of putting an expiry in it.
 */
export function verifySignedKey(
  secret: string,
  key: string,
  expiresAtEpochSeconds: number,
  signature: string
): { ok: true } | { ok: false; reason: "expired" | "bad-signature" } {
  const expected = signKey(secret, key, expiresAtEpochSeconds);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  if (Math.floor(Date.now() / 1000) > expiresAtEpochSeconds) return { ok: false, reason: "expired" };
  return { ok: true };
}

export function mediaSigningKey(): string {
  return process.env.MEDIA_URL_SECRET || process.env.AUTH_SECRET || "development-only";
}
