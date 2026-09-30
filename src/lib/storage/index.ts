import "server-only";

import { LocalStorageProvider } from "./local.ts";
import { S3StorageProvider, s3ConfigFromEnv } from "./s3.ts";
import type { StorageProvider, StorageProviderId } from "./types.ts";

/**
 * Which storage backs new media.
 *
 * S3-compatible storage when it is configured, local disk otherwise, so the
 * application runs with no cloud credentials in development and uses object
 * storage in production by configuration alone.
 *
 * Existing objects are read through the provider *recorded on the Asset*, not
 * this one — which is what lets local and object-stored assets coexist while a
 * migration runs.
 */
let cached: StorageProvider | undefined;

/**
 * True when the process is running on a platform with no persistent disk.
 *
 * `VERCEL` is set in every Vercel build and runtime. There the filesystem is
 * ephemeral and per-invocation: a file written by the request that generated it
 * is gone before the request that serves it, and the two may not even be the
 * same machine. Local disk storage is not merely inadvisable there, it silently
 * loses media.
 */
function hasNoPersistentDisk(): boolean {
  return Boolean(process.env.VERCEL);
}

export function storage(): StorageProvider {
  if (cached) return cached;
  const config = s3ConfigFromEnv();

  if (!config && hasNoPersistentDisk()) {
    // Refused rather than degraded. Falling back to local disk here would
    // accept an upload, report success, and lose the file — the worst of the
    // three possible behaviours, because nothing looks wrong until someone
    // opens the project again.
    throw new Error(
      "Object storage is required on this platform: its filesystem is ephemeral, so media written to local disk is lost. Set S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (S3_ENDPOINT too, for a non-AWS provider). See docs/DEPLOYMENT.md."
    );
  }

  cached = config ? new S3StorageProvider(config) : new LocalStorageProvider();
  return cached;
}

/** Reads an object through whichever provider actually holds it. */
export function storageFor(providerId: StorageProviderId): StorageProvider {
  if (providerId === "S3") {
    const config = s3ConfigFromEnv();
    if (!config) {
      throw new Error(
        "This asset is in S3-compatible storage, but S3 is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
      );
    }
    return new S3StorageProvider(config);
  }
  return new LocalStorageProvider();
}

/** True when object storage is configured. Used by diagnostics, never by auth. */
export function objectStorageConfigured(): boolean {
  return s3ConfigFromEnv() !== undefined;
}

/** For tests: forget the memoised provider after changing the environment. */
export function resetStorageForTests(): void {
  cached = undefined;
}

export { LocalStorageProvider } from "./local.ts";
export { S3StorageProvider, s3ConfigFromEnv } from "./s3.ts";
export * from "./types.ts";
export * from "./keys.ts";
