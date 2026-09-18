"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { scopedTo } from "@/lib/authz";
import { readStoredFile, saveGeneratedVideo } from "@/lib/storage";
import { compileShotPrompt } from "@/lib/shot-prompt";
import {
  configuredVideoProviderId,
  getVideoProvider,
} from "@/lib/ai/video-providers";
import { DEFAULT_PROVIDER_ID } from "@/lib/prompt";
import { generationPromptSchema } from "@/lib/validation";

/**
 * Video previsualization: Shot → compiler → CinematicPromptSpec → video (or
 * image-to-video) renderer → prompt adapter → video provider adapter → Asset.
 *
 * Three actions rather than two, because video generation is a real job:
 *
 *   start…  creates the QUEUED row and returns immediately
 *   run…    submits to the provider and records its job handle → PROCESSING
 *   poll…   asks the provider whether the job finished
 *
 * Nothing here blocks: `poll` returns the current state and the page keeps
 * working. A refresh, or closing the tab entirely, loses nothing — the provider
 * job id is on the row, so polling can resume later.
 *
 * Phase 5's image path is untouched and lives in actions/generations.ts.
 */

export type VideoMode = "VIDEO" | "IMAGE_TO_VIDEO";

export type StartVideoState = { error?: string; generationId?: string } | undefined;
export type PollVideoState = {
  status?: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  error?: string;
};

const PROMPT_MODE = {
  VIDEO: "video",
  IMAGE_TO_VIDEO: "image-to-video",
} as const;

function shotPaths(projectId: string, sceneId: string, shotId: string) {
  return [
    `/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`,
    `/projects/${projectId}/scenes/${sceneId}`,
    `/projects/${projectId}/storyboard`,
    `/projects/${projectId}/visualization`,
  ];
}

export async function startShotVideoGenerationAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  mode: VideoMode,
  sourceAssetId: string | null,
  _prevState: StartVideoState,
  formData: FormData
): Promise<StartVideoState> {
  await requireProjectAccess(projectId, { write: true });

  const providerId = configuredVideoProviderId();
  if (!providerId) {
    return {
      error:
        "No video provider is configured. Set VIDEO_PROVIDER in .env once you have chosen one — see README.",
    };
  }

  const parsed = generationPromptSchema.safeParse({ prompt: formData.get("prompt") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  if (mode === "IMAGE_TO_VIDEO") {
    if (!sourceAssetId) return { error: "Choose a source frame to animate" };
    const source = await prisma.asset.findFirst({
      where: { id: sourceAssetId, projectId, shotId },
    });
    if (!source) return { error: "That source frame does not belong to this shot" };
    if (!source.mimeType.startsWith("image/")) {
      return { error: "The source frame must be an image" };
    }
    if (!getVideoProvider(providerId).capabilities.imageToVideo) {
      return { error: "The configured video provider does not support image-to-video" };
    }
  }

  // Recompiled server-side: the spec snapshot must describe the shot as it
  // actually is, and `promptEdited` is decided by comparison rather than by a
  // flag the client could set.
  const resolved = await compileShotPrompt(
    projectId,
    sceneId,
    shotId,
    PROMPT_MODE[mode],
    DEFAULT_PROVIDER_ID
  );
  if (!resolved) return { error: "Shot not found" };

  const shot = await prisma.shotListItem.findFirst({
    where: { id: shotId, sceneId },
    select: { durationSeconds: true },
  });

  const submitted = parsed.data.prompt;
  const generation = await prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode,
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: submitted,
      promptEdited: submitted.trim() !== resolved.compiled.text.trim(),
      specSnapshot: resolved.compiled.spec as unknown as Prisma.InputJsonValue,
      providerId,
      promptProviderId: resolved.compiled.providerId,
      // Carried from the shot, never invented: a shot with no stated duration
      // submits none and lets the provider use its own default.
      durationSeconds: shot?.durationSeconds ?? null,
      sourceAssetId: mode === "IMAGE_TO_VIDEO" ? sourceAssetId : null,
    },
  });

  for (const path of shotPaths(projectId, sceneId, shotId)) revalidatePath(path);
  return { generationId: generation.id };
}

/** Hands the job to the provider. Returns as soon as it is accepted. */
export async function runVideoGenerationAction(
  projectId: string,
  generationId: string
): Promise<PollVideoState> {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({
    where: { id: generationId, projectId },
    include: { sourceAsset: true },
  });
  if (!generation) return { error: "Generation not found" };
  if (generation.mode === "IMAGE") return { error: "That is an image generation" };
  if (generation.status === "COMPLETED") return { status: "COMPLETED" };

  // Claim the row before submitting, so a double-click cannot create two jobs.
  const claimed = await prisma.generation.updateMany({
    where: { id: generationId, status: { in: ["QUEUED", "FAILED"] }, ...scopedTo.generation(projectId) },
    data: { status: "PROCESSING", error: null },
  });
  if (claimed.count === 0) return { error: "That generation is already running" };

  try {
    const provider = getVideoProvider(generation.providerId);

    const sourceImage = generation.sourceAsset
      ? {
          data: await readStoredFile(generation.sourceAsset.filePath),
          mimeType: generation.sourceAsset.mimeType,
        }
      : undefined;

    const { providerJobId } = await provider.submit({
      prompt: generation.promptUsed,
      mode: generation.mode === "IMAGE_TO_VIDEO" ? "image-to-video" : "text-to-video",
      durationSeconds: generation.durationSeconds ?? undefined,
      sourceImage,
    });

    await prisma.generation.updateMany({
      where: { id: generationId, ...scopedTo.generation(projectId) },
      data: { providerJobId },
    });
    return { status: "PROCESSING" };
  } catch (err) {
    return failGeneration(projectId, generationId, err);
  }
}

/**
 * Asks the provider whether the job finished, and stores the clip if it has.
 * Safe to call repeatedly; safe to call after a page reload.
 */
export async function pollVideoGenerationAction(
  projectId: string,
  generationId: string
): Promise<PollVideoState> {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({
    where: { id: generationId, projectId },
  });
  if (!generation) return { error: "Generation not found" };
  if (generation.status === "COMPLETED" || generation.status === "FAILED") {
    return { status: generation.status, error: generation.error ?? undefined };
  }
  if (!generation.providerJobId) return { status: generation.status };

  try {
    const result = await getVideoProvider(generation.providerId).poll(generation.providerJobId);
    if (result.status === "processing") return { status: "PROCESSING" };
    if (result.status === "failed") return failGeneration(projectId, generationId, new Error(result.error));

    const saved = await saveGeneratedVideo(projectId, result.video.data, result.video.mimeType);
    const asset = await prisma.asset.create({
      data: {
        projectId,
        sceneId: generation.sceneId,
        shotId: generation.shotId,
        type: "VIDEO",
        source: "GENERATED",
        filePath: saved.filePath,
        mimeType: saved.mimeType,
        fileSize: saved.fileSize,
        prompt: generation.promptUsed,
      },
    });

    await prisma.generation.updateMany({
      where: { id: generationId, ...scopedTo.generation(projectId) },
      data: { status: "COMPLETED", assetId: asset.id, error: null },
    });

    if (generation.sceneId && generation.shotId) {
      for (const path of shotPaths(projectId, generation.sceneId, generation.shotId)) {
        revalidatePath(path);
      }
    }
    return { status: "COMPLETED" };
  } catch (err) {
    return failGeneration(projectId, generationId, err);
  }
}

/**
 * Records the failure on the row rather than discarding the attempt, so the
 * history shows what was tried and why it did not work.
 */
async function failGeneration(
  projectId: string,
  generationId: string,
  err: unknown
): Promise<PollVideoState> {
  const message = err instanceof Error ? err.message : "Video generation failed";
  await prisma.generation.updateMany({
    where: { id: generationId, ...scopedTo.generation(projectId) },
    data: { status: "FAILED", error: message.slice(0, 1000) },
  });
  return { status: "FAILED", error: message };
}
