"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { scopedTo } from "@/lib/authz";
import { assetUploadSchema, generateImageSchema } from "@/lib/validation";
import { deleteStoredFile, saveGeneratedImage, saveUploadedFile } from "@/lib/storage";
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
    saved = await saveUploadedFile(projectId, file);
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
      filePath: saved.filePath,
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

  let buffer: Buffer;
  try {
    buffer = await generateImage(parsed.data.prompt);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Image generation failed" };
  }

  const saved = await saveGeneratedImage(projectId, buffer);

  await prisma.asset.create({
    data: {
      projectId,
      sceneId: scope.sceneId ?? null,
      shotId: scope.shotId ?? null,
      type: "IMAGE",
      source: "GENERATED",
      filePath: saved.filePath,
      mimeType: saved.mimeType,
      fileSize: saved.fileSize,
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
  await deleteStoredFile(asset.filePath);

  revalidateScope(projectId, asset.sceneId ?? undefined);
}
