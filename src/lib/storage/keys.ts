import { randomUUID } from "node:crypto";
import { InvalidStorageKeyError } from "./types.ts";

/**
 * Storage keys.
 *
 * Every key is generated here and nowhere else. A key is
 *
 *     projects/{projectId}/assets/{uuid}/original.{ext}
 *
 * which gives three properties that matter:
 *
 *   - **Nothing a user typed appears in it.** The uploaded filename is
 *     discarded entirely, so `../../etc/passwd` and `..%2f..%2f` have nowhere
 *     to go. The extension comes from an allow-list keyed on the *verified*
 *     MIME type, not from the name.
 *   - **Collisions are impossible.** A fresh UUID per asset means an upload can
 *     never overwrite an existing object, even for two files uploaded in the
 *     same millisecond with the same name.
 *   - **Cross-project confusion is visible.** The project id is the first
 *     segment, so a key from another project is obvious in storage and in logs
 *     — though it is still the database, never the key, that decides access.
 *
 * The scene and shot are deliberately *not* in the key. An asset can be
 * reattached to a different shot, and a key that encoded the old one would
 * either lie or force a copy of the object.
 */

/** MIME types the application accepts, and the extension each one gets. */
export const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
};

export function isSupportedMimeType(mimeType: string): boolean {
  return mimeType in EXTENSION_BY_MIME;
}

/** Per-kind upload ceilings, so one clip cannot exhaust a bucket or a request. */
export const MAX_BYTES = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  other: 25 * 1024 * 1024,
} as const;

export function maxBytesFor(mimeType: string): number {
  if (mimeType.startsWith("image/")) return MAX_BYTES.image;
  if (mimeType.startsWith("video/")) return MAX_BYTES.video;
  return MAX_BYTES.other;
}

/**
 * The rule every piece of stored media must satisfy, in one place.
 *
 * Kept here rather than inline in the upload path so that the check the
 * application runs and the check the tests run are literally the same function,
 * and so a new caller cannot store media without going past it.
 */
export function assertStorableMedia(mimeType: string, byteLength: number): void {
  if (!isSupportedMimeType(mimeType)) throw new UnsupportedMediaError(mimeType);
  if (!Number.isFinite(byteLength) || byteLength < 0) throw new MediaTooLargeError(byteLength, 0);
  const limit = maxBytesFor(mimeType);
  if (byteLength > limit) throw new MediaTooLargeError(byteLength, limit);
}

export class UnsupportedMediaError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported file type: ${String(mimeType).slice(0, 80)}`);
    this.name = "UnsupportedMediaError";
  }
}

export class MediaTooLargeError extends Error {
  constructor(size: number, limit: number) {
    super(
      `File is ${Math.round(size / 1024 / 1024)}MB; the limit is ${Math.round(limit / 1024 / 1024)}MB`
    );
    this.name = "MediaTooLargeError";
  }
}

const CUID_LIKE = /^[a-z0-9_-]{8,64}$/i;

/** Builds the one key shape the application uses. */
export function buildAssetKey(projectId: string, mimeType: string): string {
  if (!CUID_LIKE.test(projectId)) throw new InvalidStorageKeyError(projectId);
  const extension = EXTENSION_BY_MIME[mimeType];
  if (!extension) throw new InvalidStorageKeyError(mimeType);
  return `projects/${projectId}/assets/${randomUUID()}/original.${extension}`;
}

/**
 * The only shape a key is ever allowed to have.
 *
 * Applied on every read and write, so a key that reached the database through
 * some other path — a bad migration, a hand-edited row — still cannot be used
 * to walk out of the bucket.
 */
const KEY_PATTERN =
  /^projects\/[A-Za-z0-9_-]{8,64}\/assets\/[0-9a-f-]{36}\/original\.[a-z0-9]{2,5}$/;

/**
 * The shape written before this workstream: `{projectId}/{uuid}.{ext}`.
 *
 * Accepted so assets created earlier keep working rather than being orphaned by
 * a schema change, and equally strict about what characters may appear — a
 * legacy key still cannot traverse. `npm run storage:migrate` rewrites these
 * into the canonical shape; the tolerance is removed once no legacy keys remain.
 */
const LEGACY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export function isLegacyKey(key: string): boolean {
  return typeof key === "string" && LEGACY_KEY_PATTERN.test(key);
}

export function assertValidKey(key: string): string {
  if (typeof key !== "string" || (!KEY_PATTERN.test(key) && !LEGACY_KEY_PATTERN.test(key))) {
    throw new InvalidStorageKeyError(String(key));
  }
  // Belt and braces: the pattern already forbids these, but traversal is the
  // one thing that must not get through on a future pattern edit.
  if (key.includes("..") || key.includes("//") || key.startsWith("/")) {
    throw new InvalidStorageKeyError(key);
  }
  return key;
}

/** True when the key belongs to this project. Diagnostic only — never authorization. */
export function keyBelongsToProject(key: string, projectId: string): boolean {
  return key.startsWith(`projects/${projectId}/`) || key.startsWith(`${projectId}/`);
}

/** The canonical key a legacy one becomes, preserving its uuid and extension. */
export function canonicaliseLegacyKey(key: string, projectId: string): string {
  if (!isLegacyKey(key)) throw new InvalidStorageKeyError(key);
  const [, filename] = key.split("/");
  const dot = filename.lastIndexOf(".");
  return `projects/${projectId}/assets/${filename.slice(0, dot)}/original.${filename.slice(dot + 1)}`;
}
