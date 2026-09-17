"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { shotSchema } from "@/lib/validation";

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

    subjectMovement: formData.get("subjectMovement") ?? "",
    characterBlocking: formData.get("characterBlocking") ?? "",

    composition: formData.get("composition") ?? "",
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
  return undefined;
}

export async function deleteShotAction(projectId: string, sceneId: string, shotId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.shotListItem.delete({ where: { id: shotId } });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
}
