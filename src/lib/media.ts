import "server-only";

import { prisma } from "@/lib/prisma";
import { storage, storageFor } from "@/lib/storage";
import {
  assertStorableMedia,
  assertValidKey,
  buildAssetKey,
  EXTENSION_BY_MIME,
  MAX_BYTES,
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

/**
 * Every asset in a project, as already-authorized handles.
 *
 * The precondition is in the name and enforced by the caller: this is for code
 * that has *already* passed `requireProjectAccess` for this exact project id,
 * which is the same check `authorizeAsset` performs per asset. Re-deriving it
 * once per asset would mean a session lookup and a join for every file in a
 * bundle, to reach the conclusion the route already reached.
 *
 * A row whose storage key is malformed is left out rather than returned, for
 * the same reason `authorizeAsset` refuses one: a bad key must never reach a
 * storage provider, however it got into the database.
 */
export async function listProjectAssets(projectId: string): Promise<AuthorizedAsset[]> {
  const assets = await prisma.asset.findMany({
    where: { projectId },
    select: {
      id: true,
      projectId: true,
      storageProvider: true,
      storageKey: true,
      mimeType: true,
      fileSize: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return assets.filter((asset) => {
    try {
      assertValidKey(asset.storageKey);
      return true;
    } catch {
      return false;
    }
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

/**
 * The size ceilings storage enforces, re-exported for callers that must refuse
 * an oversized transfer *before* it reaches storage — a provider adapter
 * streaming a generated file, for instance.
 *
 * Re-exported rather than imported from `lib/storage/keys` directly so the
 * media boundary stays absolute: one module reaches storage, and everything
 * else comes through here. Sharing the constant is also what stops a caller's
 * own ceiling drifting away from the one that actually rejects the write.
 */
export { MAX_BYTES };

/**
 * The extension each accepted MIME type gets, re-exported for the export layer.
 *
 * Shared rather than copied: the extension a file is stored under and the
 * extension it is given inside a bundle are the same fact, and two tables would
 * drift the first time a format was added to one of them.
 */
export { EXTENSION_BY_MIME };
