"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { scopedTo } from "@/lib/authz";
import { assetUploadSchema, generateImageSchema } from "@/lib/validation";
import { deleteStoredMedia, storeProjectMedia } from "@/lib/media";
import { generateImage } from "@/lib/ai/openai-image";

export type FormState = { error?: string } | undefined;

export type AssetScope = { sceneId?: string; shotId?: string };

function revalidateScope(projectId: string, sceneId?: string) {
  revalidatePath(`/projects/${projectId}/visualization`);
  if (sceneId) revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
}

export async function uploadAssetAction(
  projectId: string,
  scope: AssetScope,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload" };
  }

  const parsed = assetUploadSchema.safeParse({
    caption: formData.get("caption") ?? "",
    type: formData.get("type") || "IMAGE",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  let saved;
  try {
    // The key is derived from the project and the verified MIME type inside
    // `storeProjectMedia` — never from `file.name`, so an uploaded filename
    // cannot choose where the object lands.
    saved = await storeProjectMedia(projectId, Buffer.from(await file.arrayBuffer()), file.type);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Upload failed" };
  }

  await prisma.asset.create({
    data: {
      projectId,
      sceneId: scope.sceneId ?? null,
      shotId: scope.shotId ?? null,
      type: parsed.data.type,
      source: "UPLOADED",
      storageProvider: saved.storageProvider,
      storageKey: saved.storageKey,
      checksum: saved.checksum,
      mimeType: saved.mimeType,
      fileSize: saved.fileSize,
      caption: parsed.data.caption || null,
    },
  });

  revalidateScope(projectId, scope.sceneId);
  return undefined;
}

export async function generateImageAction(
  projectId: string,
  scope: AssetScope,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = generateImageSchema.safeParse({
    prompt: formData.get("prompt"),
    caption: formData.get("caption") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // The free-text path shares the adapter with the structured one, so it gets
  // the same response validation and the same measured dimensions.
  let image;
  try {
    image = await generateImage(parsed.data.prompt);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Image generation failed" };
  }

  let saved;
  try {
    saved = await storeProjectMedia(projectId, image.data, image.mimeType);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not store the generated image" };
  }

  await prisma.asset.create({
    data: {
      projectId,
      sceneId: scope.sceneId ?? null,
      shotId: scope.shotId ?? null,
      type: "IMAGE",
      source: "GENERATED",
      storageProvider: saved.storageProvider,
      storageKey: saved.storageKey,
      checksum: saved.checksum,
      mimeType: saved.mimeType,
      fileSize: saved.fileSize,
      width: image.width ?? null,
      height: image.height ?? null,
      caption: parsed.data.caption || null,
      prompt: parsed.data.prompt,
    },
  });

  revalidateScope(projectId, scope.sceneId);
  return undefined;
}

export async function deleteAssetAction(projectId: string, assetId: string) {
  await requireProjectAccess(projectId, { write: true });

  const asset = await prisma.asset.findFirst({ where: { id: assetId, projectId } });
  if (!asset) return;

  await prisma.asset.deleteMany({ where: { id: assetId, ...scopedTo.asset(projectId) } });
  // The row is gone first: an object with no row is a reconcilable orphan, a
  // row with no object is a broken asset the filmmaker can see.
  await deleteStoredMedia(asset.storageProvider, asset.storageKey);

  revalidateScope(projectId, asset.sceneId ?? undefined);
}
