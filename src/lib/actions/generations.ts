"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { missed, scopedTo } from "@/lib/authz";
import { canTransition } from "@/lib/jobs/state";
import type { GenerationFailureKind, GenerationStatus } from "@prisma/client";
import { compileShotImagePrompt } from "@/lib/shot-prompt";
import { configuredImageProviderId, getImageProvider } from "@/lib/ai/image-providers";
import { DEFAULT_PROVIDER_ID } from "@/lib/prompt";
import { generationPromptSchema } from "@/lib/validation";

/**
 * Structured image generation: Shot → compiler → CinematicPromptSpec → prompt
 * text → durable job → worker → image provider adapter → stored Asset.
 *
 * These actions **enqueue and observe**. They do not generate. Starting a
 * generation writes a QUEUED row and returns; a background worker does the
 * provider call, stores the media and moves the row to COMPLETED. That is what
 * makes a generation survive a refresh, a closed tab or a dead laptop — the
 * browser was never the thing driving it.
 *
 * Nothing here may move a job to COMPLETED. The state machine
 * (src/lib/jobs/state.ts) encodes that as a rule, and the only legal completer
 * is a worker holding a lease.
 *
 * The free-text "Generate with AI" path in actions/assets.ts is untouched and
 * remains the quick way in — this is an additional path, not a replacement.
 */

export type StartGenerationState = { error?: string; generationId?: string } | undefined;

export type JobActionState = { error?: string };

export interface GenerationStateView {
  id: string;
  status: GenerationStatus;
  error: string | null;
  failureKind: GenerationFailureKind | null;
  assetId: string | null;
  attempts: number;
  maxAttempts: number;
}

function revalidateShot(projectId: string, sceneId: string | null, shotId: string | null) {
  if (!sceneId || !shotId) return;
  for (const path of shotPaths(projectId, sceneId, shotId)) revalidatePath(path);
}

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
  const providerId = configuredImageProviderId();

  const generation = await prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      // Verbatim, and frozen here. This is the submission snapshot: the worker
      // uses this text and never recompiles, so editing the shot afterwards
      // cannot change what is already in flight.
      promptUsed: submitted,
      promptEdited: submitted.trim() !== resolved.compiled.text.trim(),
      specSnapshot: resolved.compiled.spec as unknown as Prisma.InputJsonValue,
      providerId,
      model: getImageProvider(providerId).model,
      promptProviderId: resolved.compiled.providerId,
      // Eligible immediately. The worker's claim query treats a null as "now"
      // too, but being explicit keeps the queue readable in psql.
      nextAttemptAt: new Date(),
    },
  });

  for (const path of shotPaths(projectId, sceneId, shotId)) revalidatePath(path);
  return { generationId: generation.id };
}

/**
 * Puts a failed generation back in the queue.
 *
 * The only way out of FAILED, and deliberately manual: automatic retries are
 * the worker's business and are already bounded, so a job that reached FAILED
 * has either exhausted them or hit something that will not fix itself. A human
 * saying "try again" resets the attempt budget; nothing else does.
 */
export async function retryGenerationAction(
  projectId: string,
  generationId: string
): Promise<JobActionState> {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({
    where: { id: generationId, ...scopedTo.generation(projectId) },
    select: { id: true, status: true, sceneId: true, shotId: true, failureKind: true },
  });
  if (!generation) return { error: "Generation not found" };

  if (!canTransition(generation.status, "QUEUED", "user")) {
    return { error: `A ${generation.status.toLowerCase()} generation cannot be retried` };
  }

  // Scoped in the write itself, per the Workstream 11.1 rule, and conditional on
  // the status so a concurrent worker cannot have its result overwritten.
  const requeued = await prisma.generation.updateMany({
    where: { id: generationId, status: "FAILED", ...scopedTo.generation(projectId) },
    data: {
      status: "QUEUED",
      attempts: 0,
      error: null,
      failureKind: null,
      nextAttemptAt: new Date(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      // Cleared so the worker treats this as a fresh submission. For an
      // INDETERMINATE failure that is the point: the operator has checked the
      // provider and is explicitly accepting the risk of a second job.
      submissionAttemptedAt: null,
    },
  });
  if (missed(requeued)) return { error: "That generation is no longer failed" };

  revalidateShot(projectId, generation.sceneId, generation.shotId);
  return {};
}

/**
 * Cancels a generation that has not been submitted anywhere yet.
 *
 * Only from QUEUED, and that limit is honest rather than conservative: once a
 * job is with a provider, none of the adapters here can actually call it back,
 * and a Cancel button that quietly did nothing would be worse than no button.
 */
export async function cancelGenerationAction(
  projectId: string,
  generationId: string
): Promise<JobActionState> {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({
    where: { id: generationId, ...scopedTo.generation(projectId) },
    select: { id: true, status: true, sceneId: true, shotId: true },
  });
  if (!generation) return { error: "Generation not found" };

  if (!canTransition(generation.status, "CANCELLED", "user")) {
    return {
      error:
        generation.status === "QUEUED"
          ? "That generation cannot be cancelled"
          : "This generation has already been sent to the provider and cannot be called back",
    };
  }

  const cancelled = await prisma.generation.updateMany({
    // The status condition is the race guard: if a worker claimed it in the
    // meantime the update matches nothing, and the job keeps running.
    where: { id: generationId, status: "QUEUED", ...scopedTo.generation(projectId) },
    data: {
      status: "CANCELLED",
      nextAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (missed(cancelled)) return { error: "A worker has already picked that generation up" };

  revalidateShot(projectId, generation.sceneId, generation.shotId);
  return {};
}

/**
 * The current state of this shot's generations.
 *
 * Read-only, and the whole of the browser's involvement after clicking
 * Generate: the page asks what the jobs are doing, it does not drive them.
 */
export async function generationStatesAction(
  projectId: string,
  shotId: string
): Promise<GenerationStateView[]> {
  await requireProjectAccess(projectId);

  const rows = await prisma.generation.findMany({
    where: { shotId, ...scopedTo.generation(projectId) },
    select: {
      id: true,
      status: true,
      error: true,
      failureKind: true,
      assetId: true,
      attempts: true,
      maxAttempts: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    error: row.error,
    failureKind: row.failureKind,
    assetId: row.assetId,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  }));
}

export async function deleteGenerationAction(projectId: string, generationId: string) {
  await requireProjectAccess(projectId, { write: true });

  const generation = await prisma.generation.findFirst({ where: { id: generationId, projectId } });
  if (!generation) return;

  // Only the attempt record is removed. The generated Asset is left in the
  // gallery — deleting it is a separate, explicit action.
  await prisma.generation.deleteMany({
    where: { id: generationId, ...scopedTo.generation(projectId) },
  });

  if (generation.sceneId && generation.shotId) {
    for (const path of shotPaths(projectId, generation.sceneId, generation.shotId)) {
      revalidatePath(path);
    }
  }
}
