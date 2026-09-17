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
    cameraMovement: formData.get("cameraMovement") ?? "",
    lens: formData.get("lens") ?? "",
    equipmentNotes: formData.get("equipmentNotes") ?? "",
    status: formData.get("status") || "PLANNED",
    cameraAngle: formData.get("cameraAngle") ?? "",
    lightingNotes: formData.get("lightingNotes") ?? "",
    soundDesignNotes: formData.get("soundDesignNotes") ?? "",
  });
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
    data: { ...parsed.data, cameraAngle: parsed.data.cameraAngle || null, sceneId },
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
    data: { ...parsed.data, cameraAngle: parsed.data.cameraAngle || null },
  });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  return undefined;
}

export async function deleteShotAction(projectId: string, sceneId: string, shotId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.shotListItem.delete({ where: { id: shotId } });
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
}
