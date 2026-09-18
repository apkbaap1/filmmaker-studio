"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { continuityDecisionSchema } from "@/lib/validation";

/**
 * Continuity decisions.
 *
 * The only writes this phase makes. There is deliberately no action here that
 * can touch a Shot, a Scene, blocking, the timeline or a prompt: continuity
 * analysis is read-only with respect to filmmaking data, and the filmmaker makes
 * those changes themselves.
 *
 * Findings are not stored at all — they are recomputed from the shots on every
 * load. A decision attaches to one by its deterministic key, so it survives
 * re-analysis, and clearing it simply reopens the finding.
 */

export type ActionState = { error?: string } | undefined;

export async function setContinuityDecisionAction(
  projectId: string,
  findingKey: string,
  status: string,
  note?: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = continuityDecisionSchema.safeParse({ findingKey, status, note: note ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid decision" };

  await prisma.continuityDecision.upsert({
    where: { projectId_findingKey: { projectId, findingKey: parsed.data.findingKey } },
    create: {
      projectId,
      findingKey: parsed.data.findingKey,
      status: parsed.data.status,
      note: parsed.data.note || null,
    },
    update: { status: parsed.data.status, note: parsed.data.note || null },
  });

  revalidatePath(`/projects/${projectId}/continuity`);
  return undefined;
}

/** Reopens a finding. The underlying difference was never removed. */
export async function clearContinuityDecisionAction(projectId: string, findingKey: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.continuityDecision.deleteMany({ where: { projectId, findingKey } });
  revalidatePath(`/projects/${projectId}/continuity`);
}
