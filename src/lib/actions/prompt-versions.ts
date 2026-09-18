"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { compileShotPrompt } from "@/lib/shot-prompt";
import { DEFAULT_PROVIDER_ID } from "@/lib/prompt";
import { promptsDiffer } from "@/lib/diff";
import { promptVersionSchema } from "@/lib/validation";

/**
 * Prompt versions.
 *
 * A version is a saved draft. A Generation is an actual use, and already stores
 * the exact text that was sent — nothing here can alter that record, which is
 * what keeps a generated asset's history honest.
 *
 * Saving appends. There is deliberately no update or delete: a later
 * compilation never overwrites an edited version, it becomes a new one beside
 * it, and the filmmaker chooses which to use.
 */

export type ActionState = { error?: string; version?: number } | undefined;

const PROMPT_MODE = {
  IMAGE: "image",
  VIDEO: "video",
  IMAGE_TO_VIDEO: "image-to-video",
} as const;

export async function savePromptVersionAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  mode: "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO",
  text: string,
  sourceAssetId?: string | null,
  label?: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = promptVersionSchema.safeParse({ mode, text, label: label ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid prompt" };

  // Recompiled server-side so COMPILED vs EDITED is decided by comparison
  // rather than by a flag the client could set.
  const resolved = await compileShotPrompt(
    projectId,
    sceneId,
    shotId,
    PROMPT_MODE[mode],
    DEFAULT_PROVIDER_ID
  );
  if (!resolved) return { error: "Shot not found" };

  const latest = await prisma.promptVersion.findFirst({
    where: { shotId, mode },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const created = await prisma.promptVersion.create({
    data: {
      shotId,
      mode,
      version: (latest?.version ?? 0) + 1,
      source: promptsDiffer(parsed.data.text, resolved.compiled.text) ? "EDITED" : "COMPILED",
      text: parsed.data.text,
      specSnapshot: resolved.compiled.spec as unknown as Prisma.InputJsonValue,
      promptProviderId: resolved.compiled.providerId,
      sourceAssetId: mode === "IMAGE_TO_VIDEO" ? (sourceAssetId ?? null) : null,
      label: parsed.data.label || null,
    },
  });

  revalidatePath(`/projects/${projectId}/studio/${shotId}`);
  return { version: created.version };
}

/**
 * Removes a saved draft.
 *
 * Only ever a draft: generations keep their own copy of what was sent, so this
 * can never erase the record of how an existing asset was made.
 */
export async function deletePromptVersionAction(
  projectId: string,
  shotId: string,
  versionId: string
) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.promptVersion.deleteMany({
    where: { id: versionId, shotId, shot: { scene: { projectId } } },
  });
  revalidatePath(`/projects/${projectId}/studio/${shotId}`);
}
