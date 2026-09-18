"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { equipmentSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseForm(formData: FormData) {
  return equipmentSchema.safeParse({
    name: formData.get("name"),
    category: formData.get("category"),
    quantity: formData.get("quantity") || "1",
    source: formData.get("source") || "OWNED",
    dailyCost: formData.get("dailyCost") || undefined,
    vendor: formData.get("vendor") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createEquipmentAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.equipment.create({ data: { ...parsed.data, projectId } });
  revalidatePath(`/projects/${projectId}/equipment`);
  return undefined;
}

export async function updateEquipmentAction(
  projectId: string,
  equipmentId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const result = await prisma.equipment.updateMany({
    where: { id: equipmentId, ...scopedTo.equipment(projectId) },
    data: parsed.data,
  });
  if (missed(result)) return NOT_FOUND;
  revalidatePath(`/projects/${projectId}/equipment`);
  return undefined;
}

export async function deleteEquipmentAction(projectId: string, equipmentId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.equipment.deleteMany({ where: { id: equipmentId, ...scopedTo.equipment(projectId) } });
  revalidatePath(`/projects/${projectId}/equipment`);
}
