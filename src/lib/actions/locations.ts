"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { locationSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseForm(formData: FormData) {
  return locationSchema.safeParse({
    name: formData.get("name"),
    address: formData.get("address") ?? "",
    contactName: formData.get("contactName") ?? "",
    contactPhone: formData.get("contactPhone") ?? "",
    permitStatus: formData.get("permitStatus") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createLocationAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.location.create({ data: { ...parsed.data, projectId } });
  revalidatePath(`/projects/${projectId}/locations`);
  return undefined;
}

export async function updateLocationAction(
  projectId: string,
  locationId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const result = await prisma.location.updateMany({
    where: { id: locationId, ...scopedTo.location(projectId) },
    data: parsed.data,
  });
  if (missed(result)) return NOT_FOUND;
  revalidatePath(`/projects/${projectId}/locations`);
  return undefined;
}

export async function deleteLocationAction(projectId: string, locationId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.location.deleteMany({ where: { id: locationId, ...scopedTo.location(projectId) } });
  revalidatePath(`/projects/${projectId}/locations`);
}
