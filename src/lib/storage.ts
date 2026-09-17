/**
 * Asset storage — DEVELOPMENT-STAGE INFRASTRUCTURE.
 *
 * Files are written to the local filesystem. That is fine for `npm run dev` and
 * for a single self-hosted box with a persistent disk, and it is NOT a
 * production design:
 *
 *   - it does not survive a serverless deploy (Vercel and friends have no
 *     persistent filesystem, so uploads vanish between requests);
 *   - it does not survive a container being replaced or rescheduled;
 *   - it cannot be shared by more than one app instance, so it blocks
 *     horizontal scaling;
 *   - it has no redundancy, no lifecycle policy and no CDN in front of it.
 *
 * Generated video makes this sharper than it was for stills: clips are large,
 * and losing them loses work that cost real provider credits.
 *
 * BEFORE ANY PRODUCTION DEPLOYMENT this module must be replaced by an
 * S3-compatible object store (S3, R2, GCS, B2...) with signed URLs. The
 * interface here — saveUploadedFile / saveGeneratedImage / saveGeneratedVideo /
 * readStoredFile / deleteStoredFile — is deliberately the whole surface area, so
 * the swap is confined to this file plus whatever streams bytes to the client.
 * See "Storage: development-stage" in the README.
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";

const STORAGE_ROOT = path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), "storage", "uploads"));

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

export function isSupportedMimeType(mimeType: string): boolean {
  return mimeType in EXTENSION_BY_MIME;
}

export interface SavedFile {
  filePath: string;
  mimeType: string;
  fileSize: number;
}

export async function saveUploadedFile(projectId: string, file: File): Promise<SavedFile> {
  if (!isSupportedMimeType(file.type)) {
    throw new Error("Unsupported file type. Upload an image, video, or PDF.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return writeAssetFile(projectId, buffer, file.type);
}

export async function saveGeneratedImage(
  projectId: string,
  buffer: Buffer,
  mimeType = "image/png"
): Promise<SavedFile> {
  return writeAssetFile(projectId, buffer, mimeType);
}

export async function saveGeneratedVideo(
  projectId: string,
  buffer: Buffer,
  mimeType = "video/mp4"
): Promise<SavedFile> {
  return writeAssetFile(projectId, buffer, mimeType);
}

async function writeAssetFile(projectId: string, buffer: Buffer, mimeType: string): Promise<SavedFile> {
  const ext = EXTENSION_BY_MIME[mimeType] ?? "bin";
  const dir = path.join(STORAGE_ROOT, projectId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(dir, filename), buffer);
  return { filePath: path.join(projectId, filename), mimeType, fileSize: buffer.byteLength };
}

function resolveStoragePath(filePath: string): string {
  const resolved = path.resolve(STORAGE_ROOT, filePath);
  if (resolved !== STORAGE_ROOT && !resolved.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error("Invalid file path");
  }
  return resolved;
}

export async function readStoredFile(filePath: string): Promise<Buffer> {
  return readFile(resolveStoragePath(filePath));
}

export async function deleteStoredFile(filePath: string): Promise<void> {
  try {
    await unlink(resolveStoragePath(filePath));
  } catch {
    // file already gone — nothing to clean up
  }
}
