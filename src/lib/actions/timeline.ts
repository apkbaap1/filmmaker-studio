"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { splitPlacement } from "@/lib/timeline";
import {
  assetMediaInfoSchema,
  clipTransitionSchema,
  clipTrimSchema,
  sequenceSchema,
} from "@/lib/validation";

/**
 * Timeline / edit-view mutations.
 *
 * Every action in this file writes `Sequence` or `TimelineClip` and nothing
 * else. There is deliberately no code path from here to a ShotListItem column:
 * trimming a clip, reordering it, giving it a transition or deleting it are edit
 * decisions, and the shot's own specification is not the timeline's to change.
 *
 * (`recordAssetMediaInfoAction` is the one exception, and it writes measured
 * facts about a *file* — duration and resolution the browser decoded — never a
 * filmmaking field.)
 */

export type ActionState = { error?: string } | undefined;

function timelinePath(projectId: string) {
  return `/projects/${projectId}/timeline`;
}

function revalidateTimeline(projectId: string) {
  revalidatePath(timelinePath(projectId));
}

/** Loads a clip only if it really belongs to this project. */
async function clipInProject(projectId: string, clipId: string) {
  return prisma.timelineClip.findFirst({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    include: { sequence: { select: { id: true } } },
  });
}

// --- sequences --------------------------------------------------------------

export async function createSequenceAction(
  projectId: string,
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = sequenceSchema.safeParse({
    name: formData.get("name"),
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const count = await prisma.sequence.count({ where: { projectId } });
  await prisma.sequence.create({
    data: {
      projectId,
      name: parsed.data.name,
      notes: parsed.data.notes || null,
      order: count,
    },
  });

  revalidateTimeline(projectId);
  return undefined;
}

export async function renameSequenceAction(
  projectId: string,
  sequenceId: string,
  name: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = sequenceSchema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.sequence.updateMany({
    where: { id: sequenceId, projectId },
    data: { name: parsed.data.name },
  });
  revalidateTimeline(projectId);
  return undefined;
}

/** Deletes the edit. Every shot it referenced is untouched and still in the project. */
export async function deleteSequenceAction(projectId: string, sequenceId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.sequence.deleteMany({ where: { id: sequenceId, projectId } });
  revalidateTimeline(projectId);
}

/**
 * Fills an empty sequence with every shot in the project, in scene then shot
 * order — a starting point, not a rule. Skips shots already placed, so running
 * it twice does not duplicate anything.
 */
export async function populateSequenceAction(projectId: string, sequenceId: string) {
  await requireProjectAccess(projectId, { write: true });

  const sequence = await prisma.sequence.findFirst({ where: { id: sequenceId, projectId } });
  if (!sequence) return;

  const [shots, existing] = await Promise.all([
    prisma.shotListItem.findMany({
      where: { scene: { projectId } },
      orderBy: [{ scene: { order: "asc" } }, { order: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    }),
    prisma.timelineClip.findMany({ where: { sequenceId }, select: { shotId: true, order: true } }),
  ]);

  const placed = new Set(existing.map((c) => c.shotId));
  let next = existing.reduce((max, c) => Math.max(max, c.order + 1), 0);

  const toAdd = shots.filter((s) => !placed.has(s.id));
  if (toAdd.length === 0) return;

  await prisma.timelineClip.createMany({
    data: toAdd.map((shot) => ({ sequenceId, shotId: shot.id, order: next++ })),
  });

  revalidateTimeline(projectId);
}

// --- clips ------------------------------------------------------------------

/**
 * Places a shot in the sequence. This creates a *placement* — the shot itself is
 * not moved, copied or modified, and the same shot may appear more than once.
 */
export async function addClipAction(
  projectId: string,
  sequenceId: string,
  shotId: string,
  afterClipId?: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const [sequence, shot] = await Promise.all([
    prisma.sequence.findFirst({ where: { id: sequenceId, projectId } }),
    prisma.shotListItem.findFirst({ where: { id: shotId, scene: { projectId } } }),
  ]);
  if (!sequence) return { error: "Sequence not found" };
  if (!shot) return { error: "That shot does not belong to this project" };

  const clips = await prisma.timelineClip.findMany({
    where: { sequenceId },
    orderBy: { order: "asc" },
    select: { id: true },
  });

  const afterIndex = afterClipId ? clips.findIndex((c) => c.id === afterClipId) : clips.length - 1;
  const insertAt = afterIndex + 1;

  await prisma.$transaction([
    ...clips.slice(insertAt).map((c, i) =>
      prisma.timelineClip.updateMany({
        where: { id: c.id, ...scopedTo.timelineClip(projectId) },
        data: { order: insertAt + i + 1 },
      })
    ),
    prisma.timelineClip.create({ data: { sequenceId, shotId, order: insertAt } }),
  ]);

  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Removes a placement from the edit.
 *
 * The ShotListItem is untouched: the shot keeps its number, its camera data, its
 * blocking, its generations and its storyboard panel, and can be reinserted with
 * addClipAction at any time.
 */
export async function removeClipAction(projectId: string, clipId: string) {
  await requireProjectAccess(projectId, { write: true });

  const clip = await clipInProject(projectId, clipId);
  if (!clip) return;

  await prisma.timelineClip.deleteMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
  });
  await renumber(clip.sequenceId);
  revalidateTimeline(projectId);
}

export async function reorderClipsAction(
  projectId: string,
  sequenceId: string,
  orderedClipIds: string[]
) {
  await requireProjectAccess(projectId, { write: true });

  await prisma.$transaction(
    orderedClipIds.map((clipId, index) =>
      // updateMany so the sequence filter is enforced by the database rather
      // than trusted from the client's list.
      prisma.timelineClip.updateMany({
        where: { id: clipId, sequenceId, sequence: { projectId } },
        data: { order: index },
      })
    )
  );

  revalidateTimeline(projectId);
}

/**
 * Sets the clip's in/out points.
 *
 * This is the action the source-of-truth rule is about: it writes
 * `inPointSeconds` / `outPointSeconds` on the placement and never
 * `Shot.durationSeconds`. A 6-second shot trimmed to 3.5 seconds here is still
 * a 6-second shot in the Shot Builder.
 */
export async function trimClipAction(
  projectId: string,
  clipId: string,
  trim: { inPointSeconds: number; outPointSeconds: number | null }
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = clipTrimSchema.safeParse(trim);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid trim" };

  const clip = await clipInProject(projectId, clipId);
  if (!clip) return { error: "Clip not found" };

  const trimmed = await prisma.timelineClip.updateMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    data: {
      inPointSeconds: parsed.data.inPointSeconds,
      outPointSeconds: parsed.data.outPointSeconds,
    },
  });
  if (missed(trimmed)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Splits a clip in two at `atSeconds` from its head. Both halves reference the
 * same shot and the same selected asset; only the trims differ.
 */
export async function splitClipAction(
  projectId: string,
  clipId: string,
  atSeconds: number,
  sourceSeconds: number
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const clip = await clipInProject(projectId, clipId);
  if (!clip) return { error: "Clip not found" };

  const halves = splitPlacement(clip, sourceSeconds, atSeconds);
  if (!halves) return { error: "Choose a split point inside the clip" };

  const later = await prisma.timelineClip.findMany({
    where: { sequenceId: clip.sequenceId, order: { gt: clip.order } },
    orderBy: { order: "asc" },
    select: { id: true },
  });

  await prisma.$transaction([
    ...later.map((c, i) =>
      prisma.timelineClip.updateMany({
        where: { id: c.id, ...scopedTo.timelineClip(projectId) },
        data: { order: clip.order + 2 + i },
      })
    ),
    prisma.timelineClip.updateMany({
      where: { id: clipId, ...scopedTo.timelineClip(projectId) },
      data: halves.first,
    }),
    prisma.timelineClip.create({
      data: {
        sequenceId: clip.sequenceId,
        shotId: clip.shotId,
        order: clip.order + 1,
        inPointSeconds: halves.second.inPointSeconds,
        outPointSeconds: halves.second.outPointSeconds,
        selectedAssetId: clip.selectedAssetId,
        // The second half starts on a new boundary the filmmaker has not chosen
        // an edit for, so it gets none rather than inheriting the first half's.
        transition: null,
      },
    }),
  ]);

  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Sets the edit at this clip's head. `null` means "not specified" and renders as
 * a plain boundary — it is not the same as choosing CUT, and neither is ever
 * inferred from the shots on either side.
 */
export async function setClipTransitionAction(
  projectId: string,
  clipId: string,
  transition: string | null,
  durationSeconds: number | null
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = clipTransitionSchema.safeParse({ transition, durationSeconds });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid transition" };

  const clip = await clipInProject(projectId, clipId);
  if (!clip) return { error: "Clip not found" };

  const updated = await prisma.timelineClip.updateMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    data: {
      transition: parsed.data.transition,
      transitionDurationSeconds: parsed.data.durationSeconds,
    },
  });
  if (missed(updated)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Chooses which of the shot's assets represents it in this edit. `null` returns
 * the clip to the default (the shot's most recent completed generation). Other
 * generations are never touched or removed.
 */
export async function selectClipAssetAction(
  projectId: string,
  clipId: string,
  assetId: string | null
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const clip = await clipInProject(projectId, clipId);
  if (!clip) return { error: "Clip not found" };

  if (assetId) {
    const asset = await prisma.asset.findFirst({
      where: { id: assetId, projectId, shotId: clip.shotId },
    });
    if (!asset) return { error: "That asset does not belong to this shot" };
  }

  const selected = await prisma.timelineClip.updateMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    data: { selectedAssetId: assetId },
  });
  if (missed(selected)) return NOT_FOUND;
  revalidateTimeline(projectId);
  return undefined;
}

export async function setClipNotesAction(
  projectId: string,
  clipId: string,
  notes: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });
  const clip = await clipInProject(projectId, clipId);
  if (!clip) return { error: "Clip not found" };

  const noted = await prisma.timelineClip.updateMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    data: { notes: notes.trim() ? notes.slice(0, 2000) : null },
  });
  if (missed(noted)) return NOT_FOUND;
  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Stores what a player actually decoded about an asset: its real length and
 * pixel size. Measured, never guessed — and it describes the file, not the shot,
 * so the shot's intended duration is left alone even when the two disagree.
 */
export async function recordAssetMediaInfoAction(
  projectId: string,
  assetId: string,
  info: { durationSeconds?: number; width?: number; height?: number }
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = assetMediaInfoSchema.safeParse(info);
  if (!parsed.success) return { error: "Invalid media info" };

  await prisma.asset.updateMany({
    where: { id: assetId, projectId },
    data: {
      ...(parsed.data.durationSeconds !== undefined
        ? { durationSeconds: parsed.data.durationSeconds }
        : {}),
      ...(parsed.data.width !== undefined ? { width: parsed.data.width } : {}),
      ...(parsed.data.height !== undefined ? { height: parsed.data.height } : {}),
    },
  });

  revalidateTimeline(projectId);
  return undefined;
}

/** Closes gaps left by a delete so `order` stays 0..n-1. */
async function renumber(sequenceId: string) {
  const clips = await prisma.timelineClip.findMany({
    where: { sequenceId },
    orderBy: { order: "asc" },
    select: { id: true },
  });
  await prisma.$transaction(
    clips.map((c, i) =>
      prisma.timelineClip.updateMany({
        // authz-safe: `clips` was read from a sequence already scoped to the project.
        where: { id: c.id },
        data: { order: i },
      })
    )
  );
}
