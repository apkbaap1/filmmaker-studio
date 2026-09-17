"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { castMemberSchema, crewMemberSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseCastForm(formData: FormData) {
  return castMemberSchema.safeParse({
    characterName: formData.get("characterName"),
    actorName: formData.get("actorName") ?? "",
    contactEmail: formData.get("contactEmail") ?? "",
    contactPhone: formData.get("contactPhone") ?? "",
    status: formData.get("status") || "CONSIDERING",
    notes: formData.get("notes") ?? "",
  });
}

export async function createCastMemberAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseCastForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.castMember.create({ data: { ...parsed.data, projectId } });
  revalidatePath(`/projects/${projectId}/cast-crew`);
  return undefined;
}

export async function updateCastMemberAction(
  projectId: string,
  castId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseCastForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.castMember.update({ where: { id: castId }, data: parsed.data });
  revalidatePath(`/projects/${projectId}/cast-crew`);
  return undefined;
}

export async function deleteCastMemberAction(projectId: string, castId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.castMember.delete({ where: { id: castId } });
  revalidatePath(`/projects/${projectId}/cast-crew`);
}

function parseCrewForm(formData: FormData) {
  return crewMemberSchema.safeParse({
    name: formData.get("name"),
    department: formData.get("department"),
    position: formData.get("position"),
    contactEmail: formData.get("contactEmail") ?? "",
    contactPhone: formData.get("contactPhone") ?? "",
    dayRate: formData.get("dayRate") || undefined,
    notes: formData.get("notes") ?? "",
  });
}

export async function createCrewMemberAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseCrewForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.crewMember.create({ data: { ...parsed.data, projectId } });
  revalidatePath(`/projects/${projectId}/cast-crew`);
  return undefined;
}

export async function updateCrewMemberAction(
  projectId: string,
  crewId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseCrewForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.crewMember.update({ where: { id: crewId }, data: parsed.data });
  revalidatePath(`/projects/${projectId}/cast-crew`);
  return undefined;
}

export async function deleteCrewMemberAction(projectId: string, crewId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.crewMember.delete({ where: { id: crewId } });
  revalidatePath(`/projects/${projectId}/cast-crew`);
}
