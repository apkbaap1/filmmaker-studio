"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { compileShotPrompt } from "@/lib/shot-prompt";
import { configuredVideoProviderId, getVideoProvider } from "@/lib/ai/video-providers";
import { checkGenerationAllowed } from "@/lib/generation-limits";
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
 *
 * Since Workstream 11.3 this file only **enqueues**. Submitting to the provider,
 * polling it and storing the clip are the worker's work (src/lib/jobs), which is
 * what lets a render outlive the tab that asked for it. Retry, cancel and status
 * are shared with the image path and live in actions/generations.ts.
 */

export type VideoMode = "VIDEO" | "IMAGE_TO_VIDEO";

export type StartVideoState = { error?: string; generationId?: string } | undefined;

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
  const { session } = await requireProjectAccess(projectId, { write: true });

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

  // The same hard ceiling as the image path. It is a no-op while the only video
  // provider is a local stub, and it is already in place for the day one is not.
  const allowed = await checkGenerationAllowed({
    projectId,
    userId: session.user.id,
    providerKind: getVideoProvider(providerId).capabilities.kind,
  });
  if (!allowed.ok) return { error: allowed.reason };

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
      model: getVideoProvider(providerId).model,
      promptProviderId: resolved.compiled.providerId,
      requestedParams: {
        durationSeconds: shot?.durationSeconds ?? null,
        providerKind: getVideoProvider(providerId).capabilities.kind,
        mode,
      } as Prisma.InputJsonValue,
      nextAttemptAt: new Date(),
      // Carried from the shot, never invented: a shot with no stated duration
      // submits none and lets the provider use its own default.
      durationSeconds: shot?.durationSeconds ?? null,
      sourceAssetId: mode === "IMAGE_TO_VIDEO" ? sourceAssetId : null,
    },
  });

  for (const path of shotPaths(projectId, sceneId, shotId)) revalidatePath(path);
  return { generationId: generation.id };
}
