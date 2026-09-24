"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { audioClipSchema, audioTrackSchema } from "@/lib/validation";

/**
 * Audio track and placement mutations.
 *
 * The same rule the picture actions follow: everything here writes `AudioTrack`
 * or `AudioClip` and nothing else. Placing a recording under a scene does not
 * touch the scene, and muting a clip's sync sound does not touch the shot or the
 * asset — a mute is a decision about this edit, and the file is still the file.
 */

export type ActionState = { error?: string } | undefined;

function revalidateTimeline(projectId: string) {
  revalidatePath(`/projects/${projectId}/timeline`);
}

/** Loads a track only if it really belongs to this project. */
async function trackInProject(projectId: string, trackId: string) {
  return prisma.audioTrack.findFirst({
    where: { id: trackId, ...scopedTo.audioTrack(projectId) },
    select: { id: true, sequenceId: true },
  });
}

// --- tracks ------------------------------------------------------------------

export async function createAudioTrackAction(
  projectId: string,
  sequenceId: string,
  input: { name: string; role: string }
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = audioTrackSchema.safeParse({
    name: input.name,
    role: input.role,
    // A new track states no level and is not muted. Null is unity, not 0 dB
    // chosen — the distinction the schema exists to keep.
    gainDb: null,
    muted: false,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const sequence = await prisma.sequence.findFirst({ where: { id: sequenceId, projectId } });
  if (!sequence) return { error: "Sequence not found" };

  const count = await prisma.audioTrack.count({ where: { sequenceId } });
  await prisma.audioTrack.create({
    data: {
      sequenceId,
      name: parsed.data.name,
      role: parsed.data.role,
      order: count,
      muted: false,
      gainDb: null,
    },
  });

  revalidateTimeline(projectId);
  return undefined;
}

export async function updateAudioTrackAction(
  projectId: string,
  trackId: string,
  input: { name: string; role: string; gainDb: number | null; muted: boolean }
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = audioTrackSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const updated = await prisma.audioTrack.updateMany({
    where: { id: trackId, ...scopedTo.audioTrack(projectId) },
    data: {
      name: parsed.data.name,
      role: parsed.data.role,
      gainDb: parsed.data.gainDb,
      muted: parsed.data.muted,
    },
  });
  if (missed(updated)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}

/**
 * Deletes a track and its placements. The audio assets themselves are untouched
 * and stay in the project, so the same recordings can be placed again.
 */
export async function deleteAudioTrackAction(projectId: string, trackId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.audioTrack.deleteMany({
    where: { id: trackId, ...scopedTo.audioTrack(projectId) },
  });
  revalidateTimeline(projectId);
}

export async function reorderAudioTracksAction(
  projectId: string,
  sequenceId: string,
  orderedTrackIds: string[]
) {
  await requireProjectAccess(projectId, { write: true });

  await prisma.$transaction(
    orderedTrackIds.map((trackId, index) =>
      prisma.audioTrack.updateMany({
        where: { id: trackId, sequenceId, sequence: { projectId } },
        data: { order: index },
      })
    )
  );
  revalidateTimeline(projectId);
}

// --- placements --------------------------------------------------------------

/**
 * Places an audio asset on a track at a stated position.
 *
 * `startSeconds` is required rather than appended to the end of the track:
 * sound is placed against the picture, and defaulting it to "after the last
 * clip" would be this layer deciding an edit it was not asked to make.
 */
export async function addAudioClipAction(
  projectId: string,
  trackId: string,
  assetId: string,
  startSeconds: number
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const track = await trackInProject(projectId, trackId);
  if (!track) return { error: "Track not found" };

  // The asset has to be in this project *and* be audio: a track playing a PNG
  // would be a placement that can never make a sound.
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, projectId, type: "AUDIO" },
    select: { id: true },
  });
  if (!asset) return { error: "That audio asset does not belong to this project" };

  const parsed = audioClipSchema.safeParse({
    startSeconds,
    inPointSeconds: 0,
    outPointSeconds: null,
    gainDb: null,
    fadeInSeconds: null,
    fadeOutSeconds: null,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid placement" };

  await prisma.audioClip.create({
    data: { trackId, assetId, startSeconds: parsed.data.startSeconds },
  });

  revalidateTimeline(projectId);
  return undefined;
}

export async function updateAudioClipAction(
  projectId: string,
  clipId: string,
  input: {
    startSeconds: number;
    inPointSeconds: number;
    outPointSeconds: number | null;
    gainDb: number | null;
    fadeInSeconds: number | null;
    fadeOutSeconds: number | null;
  }
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = audioClipSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid placement" };

  const updated = await prisma.audioClip.updateMany({
    where: { id: clipId, ...scopedTo.audioClip(projectId) },
    data: parsed.data,
  });
  if (missed(updated)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}

export async function setAudioClipNotesAction(
  projectId: string,
  clipId: string,
  notes: string
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const noted = await prisma.audioClip.updateMany({
    where: { id: clipId, ...scopedTo.audioClip(projectId) },
    data: { notes: notes.trim() ? notes.slice(0, 2000) : null },
  });
  if (missed(noted)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}

/** Removes a placement. The recording stays in the project. */
export async function removeAudioClipAction(projectId: string, clipId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.audioClip.deleteMany({
    where: { id: clipId, ...scopedTo.audioClip(projectId) },
  });
  revalidateTimeline(projectId);
}

/**
 * Silences a picture clip's own sound.
 *
 * Its own, not the track's: this is the audio inside the video representing the
 * shot. Muting it leaves the shot, the generation and the asset exactly as they
 * were — the filmmaker has decided this edit does not use that sound, not that
 * the sound is wrong.
 */
export async function setClipAudioMutedAction(
  projectId: string,
  clipId: string,
  muted: boolean
): Promise<ActionState> {
  await requireProjectAccess(projectId, { write: true });

  const updated = await prisma.timelineClip.updateMany({
    where: { id: clipId, ...scopedTo.timelineClip(projectId) },
    data: { audioMuted: muted },
  });
  if (missed(updated)) return NOT_FOUND;

  revalidateTimeline(projectId);
  return undefined;
}
