"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, scopedTo } from "@/lib/authz";
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
    action: formData.get("action") ?? "",
    emotionalBeat: formData.get("emotionalBeat") ?? "",
    directorNotes: formData.get("directorNotes") ?? "",
    pageEights: formData.get("pageEights") || "1",
    characterIds: formData.getAll("characterIds"),
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

  const { characterIds, ...data } = parsed.data;
  const scene = await prisma.scene.create({
    data: {
      ...data,
      projectId,
      characters: { connect: characterIds.map((id) => ({ id })) },
    },
  });
  revalidatePath(`/projects/${projectId}/scenes`);
  redirect(`/projects/${projectId}/scenes/${scene.id}`);
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

  const { characterIds, ...data } = parsed.data;

  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, ...scopedTo.scene(projectId) },
    select: { id: true },
  });
  if (!scene) return NOT_FOUND;

  // Characters are filtered to this project too: a scene must not be able to
  // reference a cast member from someone else's production.
  const owned = await prisma.castMember.findMany({
    where: { id: { in: characterIds }, ...scopedTo.castMember(projectId) },
    select: { id: true },
  });

  await prisma.scene.update({
    // authz-safe: `scene.id` came from the scoped read above.
    where: { id: scene.id },
    data: {
      ...data,
      characters: { set: owned.map((c) => ({ id: c.id })) },
    },
  });
  revalidatePath(`/projects/${projectId}/scenes`);
  revalidatePath(`/projects/${projectId}/scenes/${sceneId}`);
  return undefined;
}

export async function deleteSceneAction(projectId: string, sceneId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.scene.deleteMany({ where: { id: sceneId, ...scopedTo.scene(projectId) } });
  revalidatePath(`/projects/${projectId}/scenes`);
  redirect(`/projects/${projectId}/scenes`);
}
