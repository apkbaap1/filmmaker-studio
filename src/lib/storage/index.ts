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

export function storage(): StorageProvider {
  if (cached) return cached;
  const config = s3ConfigFromEnv();
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
