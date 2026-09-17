"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { sceneSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseSceneForm(formData: FormData) {
  return sceneSchema.safeParse({
    number: formData.get("number"),
    intExt: formData.get("intExt"),
    location: formData.get("location"),
    timeOfDay: formData.get("timeOfDay"),
    synopsis: formData.get("synopsis") ?? "",
    scriptText: formData.get("scriptText") ?? "",
    pageEights: formData.get("pageEights") || "1",
  });
}

export async function createSceneAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseSceneForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.scene.create({ data: { ...parsed.data, projectId } });
  revalidatePath(`/projects/${projectId}/scenes`);
  redirect(`/projects/${projectId}/scenes`);
}

export async function updateSceneAction(
  projectId: string,
  sceneId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseSceneForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.scene.update({ where: { id: sceneId }, data: parsed.data });
  revalidatePath(`/projects/${projectId}/scenes`);
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  return undefined;
}

export async function deleteSceneAction(projectId: string, sceneId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.scene.delete({ where: { id: sceneId } });
  revalidatePath(`/projects/${projectId}/scenes`);
  redirect(`/projects/${projectId}/scenes`);
}
