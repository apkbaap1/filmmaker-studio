"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { saveGeneratedImage } from "@/lib/storage";
import { compileShotImagePrompt } from "@/lib/shot-prompt";
import { DEFAULT_IMAGE_PROVIDER_ID, getImageProvider } from "@/lib/ai/image-providers";
import { DEFAULT_PROVIDER_ID } from "@/lib/prompt";
import { generationPromptSchema } from "@/lib/validation";

/**
 * Structured image generation: Shot → compiler → CinematicPromptSpec → prompt
 * text → image provider adapter → stored Asset.
 *
 * Split into two actions on purpose. `startShotImageGeneration` returns as soon
 * as the QUEUED row exists, so the page can show the attempt immediately and
 * stay interactive; `runGeneration` does the slow provider call and moves the
 * row through PROCESSING to COMPLETED or FAILED. A refresh mid-flight shows the
 * real state rather than losing the attempt.
 *
 * The free-text "Generate with AI" path in actions/assets.ts is untouched and
 * remains the quick way in — this is an additional path, not a replacement.
 */

export type StartGenerationState = { error?: string; generationId?: string } | undefined;

export type RunGenerationState = { error?: string };

function shotPaths(projectId: string, sceneId: string, shotId: string) {
  return [
    `/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`,
    `/projects/${projectId}/scenes/${sceneId}`,
    `/projects/${projectId}/storyboard`,
    `/projects/${projectId}/visualization`,
  ];
}

export async function startShotImageGenerationAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  _prevState: StartGenerationState,
  formData: FormData
): Promise<StartGenerationState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = generationPromptSchema.safeParse({ prompt: formData.get("prompt") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Recompiled here rather than trusted from the form: the spec snapshot has to
  // describe the shot as it actually is, and `promptEdited` has to be decided by
  // comparing against the real compiled text, not by a client-supplied flag.
  const resolved = await compileShotImagePrompt(projectId, sceneId, shotId, DEFAULT_PROVIDER_ID);
  if (!resolved) return { error: "Shot not found" };

  const submitted = parsed.data.prompt;
  const generation = await prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      // Verbatim. An edited prompt is the prompt — nothing downstream
      // re-derives it from the spec.
      promptUsed: submitted,
      promptEdited: submitted.trim() !== resolved.compiled.text.trim(),
      specSnapshot: resolved.compiled.spec as unknown as Prisma.InputJsonValue,
      providerId: DEFAULT_IMAGE_PROVIDER_ID,
      promptProviderId: resolved.compiled.providerId,
    },
  });

  for (const path of shotPaths(projectId, sceneId, shotId)) revalidatePath(path);
  return { generationId: generation.id };
}

export async function runGenerationAction(
  projectId: string,
  generationId: string
): Promise<RunGenerationState> {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({
    where: { id: generationId, projectId },
  });
  if (!generation) return { error: "Generation not found" };
  if (generation.status === "COMPLETED") return {};

  // Claim the row before the slow call so a double-submit can't run it twice.
  const claimed = await prisma.generation.updateMany({
    where: { id: generationId, status: { in: ["QUEUED", "FAILED"] } },
    data: { status: "PROCESSING", error: null },
  });
  if (claimed.count === 0) return { error: "That generation is already running" };

  const provider = getImageProvider(generation.providerId);

  try {
    const image = await provider.generate({ prompt: generation.promptUsed });
    const saved = await saveGeneratedImage(projectId, image.data, image.mimeType);

    const asset = await prisma.asset.create({
      data: {
        projectId,
        sceneId: generation.sceneId,
        shotId: generation.shotId,
        type: "IMAGE",
        source: "GENERATED",
        filePath: saved.filePath,
        mimeType: saved.mimeType,
        fileSize: saved.fileSize,
        prompt: generation.promptUsed,
      },
    });

    await prisma.generation.update({
      where: { id: generationId },
      data: { status: "COMPLETED", assetId: asset.id, error: null },
    });
  } catch (err) {
    // The provider's message is surfaced as-is (it is the useful part — a
    // missing key, a content rejection, a rate limit) and the attempt is kept
    // rather than deleted, so the history shows what was tried.
    const message = err instanceof Error ? err.message : "Image generation failed";
    await prisma.generation.update({
      where: { id: generationId },
      data: { status: "FAILED", error: message.slice(0, 1000) },
    });
    return { error: message };
  } finally {
    if (generation.sceneId && generation.shotId) {
      for (const path of shotPaths(projectId, generation.sceneId, generation.shotId)) {
        revalidatePath(path);
      }
    }
  }

  return {};
}

export async function deleteGenerationAction(projectId: string, generationId: string) {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({ where: { id: generationId, projectId } });
  if (!generation) return;

  // Only the attempt record is removed. The generated Asset is left in the
  // gallery — deleting it is a separate, explicit action.
  await prisma.generation.delete({ where: { id: generationId } });

  if (generation.sceneId && generation.shotId) {
    for (const path of shotPaths(projectId, generation.sceneId, generation.shotId)) {
      revalidatePath(path);
    }
  }
}
