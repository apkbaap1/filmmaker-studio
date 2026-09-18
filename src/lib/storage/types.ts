/**
 * Media storage — the provider-independent interface.
 *
 * The application knows about *objects addressed by a storage key*, and nothing
 * else. It never learns whether the bytes sit on a disk, in S3, in R2 or
 * anywhere else, and no vendor's SDK appears outside an adapter. Swapping
 * providers is a configuration change, not a code change.
 *
 * The key is an opaque, application-generated string. It is never derived from
 * a filename a user supplied, never parsed for meaning, and — this is the part
 * that matters for security — **never treated as proof of authorization**. A
 * caller must already have established that the requester may see the Asset
 * before any method here is reached. See `src/lib/media.ts`.
 */

export type StorageProviderId = "LOCAL" | "S3";

export interface StoredObject {
  key: string;
  contentType: string;
  size: number;
  /** Strong-ish integrity check written at upload time. */
  checksum: string;
}

export interface ObjectMetadata {
  contentType: string;
  size: number;
  lastModified?: Date;
  checksum?: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface PutOptions {
  contentType: string;
  /** Bytes. Enforced by the caller before this point; recorded here. */
  size?: number;
}

export interface StorageProvider {
  readonly id: StorageProviderId;
  /** Human-readable, for the admin/diagnostic surfaces. Never a credential. */
  readonly description: string;

  put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject>;

  /**
   * Reads the whole object into memory. Only for server-side work that genuinely
   * needs the bytes — the image a video generation animates, an export bundle.
   * Serving media to a browser goes through `signedDownloadUrl` instead, so a
   * large clip never travels through the application process.
   */
  get(key: string): Promise<Buffer>;

  /**
   * Reads a byte range, inclusive of both ends.
   *
   * Exists so the media route can answer a browser's `Range` request for a
   * video without pulling a 500MB clip through the application process to
   * serve 64KB of it. Optional: a provider that cannot do it is served whole
   * objects instead, which is correct but slower.
   */
  getRange?(key: string, start: number, endInclusive: number): Promise<Buffer>;

  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  head(key: string): Promise<ObjectMetadata | undefined>;

  /**
   * A short-lived URL for one object.
   *
   * This is a *delivery* mechanism, not an authorization boundary: it is only
   * ever issued after the application has checked project access. Its expiry
   * limits how long a leaked link stays useful, nothing more.
   */
  signedDownloadUrl(key: string, options?: { expiresInSeconds?: number; contentType?: string }): Promise<SignedUrl>;

  /**
   * A short-lived URL a browser may PUT to directly.
   *
   * Implemented where the provider supports it so large uploads need not pass
   * through the application. Not wired into the UI: the current server-mediated
   * upload is the simplest secure flow, and direct upload would be added when a
   * real file-size problem justifies it.
   */
  signedUploadUrl?(
    key: string,
    options: { contentType: string; expiresInSeconds?: number; maxBytes?: number }
  ): Promise<SignedUrl>;
}

/** Thrown for a key that is malformed or outside the caller's scope. */
export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    // The key is echoed truncated: enough to debug, not enough to paste a
    // traversal attempt straight into a log aggregator.
    super(`Invalid storage key: ${key.slice(0, 64)}`);
    this.name = "InvalidStorageKeyError";
  }
}

export class ObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No object at key: ${key.slice(0, 64)}`);
    this.name = "ObjectNotFoundError";
  }
}
