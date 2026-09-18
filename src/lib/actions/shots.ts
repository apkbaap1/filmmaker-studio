"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { shotSchema, storyboardShotSchema, temporalShotSchema } from "@/lib/validation";
import { blockingSchema } from "@/lib/blocking";

export type FormState = { error?: string } | undefined;

function parseShotForm(formData: FormData) {
  return shotSchema.safeParse({
    shotNumber: formData.get("shotNumber"),
    shotType: formData.get("shotType"),
    description: formData.get("description") ?? "",
    status: formData.get("status") || "PLANNED",

    cameraAngle: formData.get("cameraAngle") ?? "",
    cameraHeight: formData.get("cameraHeight") ?? "",
    lens: formData.get("lens") ?? "",
    focalLength: formData.get("focalLength") ?? "",
    cameraMovement: formData.get("cameraMovement") ?? "",
    cameraStartPosition: formData.get("cameraStartPosition") ?? "",
    cameraEndPosition: formData.get("cameraEndPosition") ?? "",
    movementSpeed: formData.get("movementSpeed") ?? "",

    initialFraming: formData.get("initialFraming") ?? "",
    finalFraming: formData.get("finalFraming") ?? "",

    subjectMovement: formData.get("subjectMovement") ?? "",
    subjectStartPosition: formData.get("subjectStartPosition") ?? "",
    subjectEndPosition: formData.get("subjectEndPosition") ?? "",
    characterBlocking: formData.get("characterBlocking") ?? "",
    environmentalMovement: formData.get("environmentalMovement") ?? "",
    wardrobe: formData.get("wardrobe") ?? "",
    hairMakeup: formData.get("hairMakeup") ?? "",
    characterProps: formData.get("characterProps") ?? "",

    composition: formData.get("composition") ?? "",
    finalComposition: formData.get("finalComposition") ?? "",
    framing: formData.get("framing") ?? "",
    depthOfField: formData.get("depthOfField") ?? "",

    lightingNotes: formData.get("lightingNotes") ?? "",
    mood: formData.get("mood") ?? "",

    durationSeconds: formData.get("durationSeconds") || undefined,
    dialogueAudio: formData.get("dialogueAudio") ?? "",
    sfx: formData.get("sfx") ?? "",
    soundDesignNotes: formData.get("soundDesignNotes") ?? "",

    transition: formData.get("transition") ?? "",
    editPoint: formData.get("editPoint") ?? "",

    equipmentNotes: formData.get("equipmentNotes") ?? "",
    directorNotes: formData.get("directorNotes") ?? "",
  });
}

/** Optional string fields submit as "" from empty form inputs — store those as null. */
function nullifyEmptyStrings<T extends Record<string, unknown>>(data: T): T {
  const result = { ...data };
  for (const key of Object.keys(result)) {
    if (result[key] === "") {
      (result as Record<string, unknown>)[key] = null;
    }
  }
  return result;
}

export async function createShotAction(
  projectId: string,
  sceneId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseShotForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.shotListItem.create({
    data: { ...nullifyEmptyStrings(parsed.data), sceneId },
  });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
  return undefined;
}

export async function updateShotAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseShotForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.shotListItem.update({
    where: { id: shotId },
    data: nullifyEmptyStrings(parsed.data),
  });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
  return undefined;
}

export async function deleteShotAction(projectId: string, sceneId: string, shotId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.shotListItem.delete({ where: { id: shotId } });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
}

// --- Storyboard view actions ---
// These reuse the same ShotListItem model and createShotAction/deleteShotAction
// above. The one addition is a partial-update action: the storyboard panel only
// edits a subset of a shot's fields, so it must never touch (and risk wiping)
// the rest of the Phase 1 Shot Builder fields that aren't shown on the panel.

function parseStoryboardShotForm(formData: FormData) {
  return storyboardShotSchema.safeParse({
    shotNumber: formData.get("shotNumber"),
    shotType: formData.get("shotType"),
    cameraAngle: formData.get("cameraAngle") ?? "",
    cameraMovement: formData.get("cameraMovement") ?? "",
    lens: formData.get("lens") ?? "",
    durationSeconds: formData.get("durationSeconds") || undefined,
    dialogueAudio: formData.get("dialogueAudio") ?? "",
    soundDesignNotes: formData.get("soundDesignNotes") ?? "",
    transition: formData.get("transition") ?? "",
    directorNotes: formData.get("directorNotes") ?? "",
  });
}

export async function updateShotStoryboardFieldsAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseStoryboardShotForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.shotListItem.update({
    where: { id: shotId },
    data: nullifyEmptyStrings(parsed.data),
  });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
  return undefined;
}

export async function duplicateShotAction(projectId: string, sceneId: string, shotId: string) {
  await requireProjectAccess(projectId, { write: true });

  // Shots created before any manual reordering all share order=0, so the whole
  // scene is renumbered here. That makes "insert directly after the source"
  // well-defined instead of appending the copy to the end of the scene.
  const shots = await prisma.shotListItem.findMany({
    where: { sceneId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });

  const sourceIndex = shots.findIndex((s) => s.id === shotId);
  if (sourceIndex === -1) return;
  const source = shots[sourceIndex];

  // `blocking` is pulled out of the spread because Prisma's Json input type does
  // not accept a plain `JsonValue | null` read back off a row; it is re-attached
  // below only when the source actually has blocking to copy.
  const { id, createdAt, updatedAt, blocking, ...copyableFields } = source;
  void id;
  void createdAt;
  void updatedAt;

  await prisma.$transaction([
    ...shots.map((s, i) =>
      prisma.shotListItem.update({
        where: { id: s.id },
        data: { order: i <= sourceIndex ? i : i + 1 },
      })
    ),
    prisma.shotListItem.create({
      data: {
        ...copyableFields,
        ...(blocking == null ? {} : { blocking: blocking as Prisma.InputJsonValue }),
        shotNumber: `${source.shotNumber} copy`,
        order: sourceIndex + 1,
      },
    }),
  ]);

  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
}

/**
 * Saves the composition canvas's spatial blocking. A partial update touching
 * only the `blocking` column — the canvas must never write the Shot's textual
 * fields as a side effect of dragging something.
 */
export async function updateShotBlockingAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  blocking: unknown
): Promise<{ error?: string } | undefined> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = blockingSchema.safeParse(blocking);
  if (!parsed.success) {
    return { error: "Could not save the canvas layout" };
  }

  await prisma.shotListItem.updateMany({
    where: { id: shotId, sceneId },
    data: { blocking: parsed.data },
  });

  revalidatePath(`/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`);
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  return undefined;
}

/**
 * Saves the temporal transition fields from the shot-design page. Partial, for
 * the same reason as the storyboard's panel edit: it must not clobber fields it
 * does not display.
 */
export async function updateShotTemporalAction(
  projectId: string,
  sceneId: string,
  shotId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });

  const parsed = temporalShotSchema.safeParse({
    composition: formData.get("composition") ?? "",
    finalComposition: formData.get("finalComposition") ?? "",
    framing: formData.get("framing") ?? "",
    initialFraming: formData.get("initialFraming") ?? "",
    finalFraming: formData.get("finalFraming") ?? "",
    cameraMovement: formData.get("cameraMovement") ?? "",
    movementSpeed: formData.get("movementSpeed") ?? "",
    cameraStartPosition: formData.get("cameraStartPosition") ?? "",
    cameraEndPosition: formData.get("cameraEndPosition") ?? "",
    subjectMovement: formData.get("subjectMovement") ?? "",
    subjectStartPosition: formData.get("subjectStartPosition") ?? "",
    subjectEndPosition: formData.get("subjectEndPosition") ?? "",
    environmentalMovement: formData.get("environmentalMovement") ?? "",
    durationSeconds: formData.get("durationSeconds") || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.shotListItem.updateMany({
    where: { id: shotId, sceneId },
    data: nullifyEmptyStrings(parsed.data),
  });

  revalidatePath(`/projects/${projectId}/scenes/${sceneId}/shots/${shotId}`);
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  revalidatePath(`/projects/${projectId}/storyboard`);
  return undefined;
}

export async function reorderShotsAction(
  projectId: string,
  sceneId: string,
  orderedShotIds: string[]
) {
  await requireProjectAccess(projectId, { write: true });

  await prisma.$transaction(
    orderedShotIds.map((shotId, index) =>
      // updateMany (not update) so the sceneId filter is enforced at the
      // database level instead of requiring a compound unique key.
      prisma.shotListItem.updateMany({
        where: { id: shotId, sceneId },
        data: { order: index },
      })
    )
  );

  revalidatePath(`/projects/${projectId}/storyboard`);
}
