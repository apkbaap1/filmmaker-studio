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
