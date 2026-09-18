import "server-only";

import { prisma } from "@/lib/prisma";
import { storage, storageFor } from "@/lib/storage";
import {
  assertStorableMedia,
  assertValidKey,
  buildAssetKey,
  MediaTooLargeError,
  UnsupportedMediaError,
} from "@/lib/storage/keys";
import type { StorageProviderId } from "@/lib/storage/types";

/**
 * Media access — the authorization boundary for every byte of stored media.
 *
 * The rule this module exists to enforce: **a storage key is never proof of
 * anything.** Access is decided in this order, and only this order:
 *
 *     signed-in user
 *       → does this Asset exist
 *       → does its Project grant this user access
 *       → only now, a short-lived URL for the underlying object
 *
 * Nothing downstream re-checks, and nothing upstream may skip ahead. A caller
 * who knows an asset id, a storage key, a filename, a generation id or a shot
 * id and nothing else gets a 404 that is indistinguishable from the asset not
 * existing.
 */

export interface AuthorizedAsset {
  id: string;
  projectId: string;
  storageProvider: StorageProviderId;
  storageKey: string;
  mimeType: string;
  fileSize: number;
}

export type MediaAccess =
  | { ok: true; asset: AuthorizedAsset }
  | { ok: false; status: 401 | 404 };

/**
 * Resolves an asset the signed-in user is allowed to see.
 *
 * Returns 404 both for an asset that does not exist and for one belonging to
 * someone else, so the response cannot be used to discover which ids are real.
 */
export async function authorizeAsset(assetId: string): Promise<MediaAccess> {
  // Imported here rather than at the top of the file on purpose. `auth()` only
  // means anything inside a request, and NextAuth cannot even load outside
  // Next — so a module-level import would make this file, and everything that
  // stores or reads media through it, impossible to use from the background
  // worker or a test. The authorization rule is unchanged: this is still the
  // only door, and it is still shut until a session is produced.
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user?.id) return { ok: false, status: 401 };

  if (typeof assetId !== "string" || assetId.length < 8 || assetId.length > 64) {
    return { ok: false, status: 404 };
  }

  // The project join is the access check: a row only comes back when the user
  // owns the project or is a member of it.
  const asset = await prisma.asset.findFirst({
    where: {
      id: assetId,
      project: {
        OR: [{ ownerId: session.user.id }, { members: { some: { userId: session.user.id } } }],
      },
    },
    select: {
      id: true,
      projectId: true,
      storageProvider: true,
      storageKey: true,
      mimeType: true,
      fileSize: true,
    },
  });
  if (!asset) return { ok: false, status: 404 };

  try {
    // A key that is malformed — however it got into the database — is refused
    // before it can be handed to a storage provider.
    assertValidKey(asset.storageKey);
  } catch {
    return { ok: false, status: 404 };
  }

  return { ok: true, asset: { ...asset, storageProvider: asset.storageProvider } };
}

/**
 * A short-lived URL for an asset the caller has already been authorized for.
 *
 * Deliberately takes an `AuthorizedAsset` rather than an id: the type makes it
 * impossible to issue a URL without having gone through `authorizeAsset` first.
 */
export async function signedUrlForAsset(
  asset: AuthorizedAsset,
  expiresInSeconds = 300
): Promise<{ url: string; expiresAt: Date }> {
  const provider = storageFor(asset.storageProvider);
  return provider.signedDownloadUrl(asset.storageKey, {
    expiresInSeconds,
    contentType: asset.mimeType,
  });
}

/** Reads an asset's bytes server-side. Same rule: authorize first, then read. */
export async function readAssetBytes(asset: AuthorizedAsset): Promise<Buffer> {
  return storageFor(asset.storageProvider).get(asset.storageKey);
}

/**
 * Reads an inclusive byte range of an already-authorized asset.
 *
 * Falls back to reading the whole object and slicing when the provider has no
 * native range support, so the caller's behaviour does not change with the
 * backend — only how much travels through the process.
 */
export async function readAssetRange(
  asset: AuthorizedAsset,
  start: number,
  endInclusive: number
): Promise<Buffer> {
  const provider = storageFor(asset.storageProvider);
  if (provider.getRange) return provider.getRange(asset.storageKey, start, endInclusive);
  const whole = await provider.get(asset.storageKey);
  return whole.subarray(start, endInclusive + 1);
}

export interface StoredMedia {
  storageProvider: StorageProviderId;
  storageKey: string;
  mimeType: string;
  fileSize: number;
  checksum: string;
}

/**
 * Writes new media for a project.
 *
 * The key is generated here from the project id and the *verified* MIME type —
 * never from a filename the user supplied — so an upload cannot choose where it
 * lands, overwrite another object, or escape its project's prefix.
 */
export async function storeProjectMedia(
  projectId: string,
  body: Buffer,
  mimeType: string,
  options: { key?: string } = {}
): Promise<StoredMedia> {
  // The gate comes before the key and before the write: nothing unsupported or
  // oversized ever reaches a storage provider, whichever provider that is.
  assertStorableMedia(mimeType, body.byteLength);

  const provider = storage();
  // A caller may hand in a key it reserved earlier (see `reserveProjectMediaKey`)
  // so that a write which is interrupted can be repeated against the same
  // object instead of orphaning a new one on every attempt.
  const key = options.key ? assertValidKey(options.key) : buildAssetKey(projectId, mimeType);
  const stored = await provider.put(key, body, { contentType: mimeType, size: body.byteLength });

  return {
    storageProvider: provider.id,
    storageKey: stored.key,
    mimeType: stored.contentType,
    fileSize: stored.size,
    checksum: stored.checksum,
  };
}

/**
 * Picks the key an upload *will* use, without writing anything.
 *
 * This exists for the durable worker: it records the reserved key on the job
 * before the bytes are written, so an interrupted write leaves a known location
 * rather than an untracked object. Reserving costs nothing and creates nothing —
 * an unused reservation is just a string nobody ever wrote to.
 */
export function reserveProjectMediaKey(
  projectId: string,
  mimeType: string
): { storageProvider: StorageProviderId; storageKey: string } {
  assertStorableMedia(mimeType, 0);
  return { storageProvider: storage().id, storageKey: buildAssetKey(projectId, mimeType) };
}

/**
 * Removes the object behind an asset.
 *
 * Called after the database row is gone. A storage failure is reported but does
 * not resurrect the row: the application's state is the source of truth, and an
 * object with no row is a reconcilable orphan, while a row with no object is a
 * broken asset the filmmaker can see.
 */
export async function deleteStoredMedia(
  providerId: StorageProviderId,
  storageKey: string
): Promise<{ deleted: boolean; error?: string }> {
  try {
    assertValidKey(storageKey);
    await storageFor(providerId).delete(storageKey);
    return { deleted: true };
  } catch (err) {
    return { deleted: false, error: err instanceof Error ? err.message : "Storage delete failed" };
  }
}

// Re-exported so callers keep importing their errors from the module they call.
export { MediaTooLargeError, UnsupportedMediaError };
