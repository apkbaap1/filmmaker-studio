"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { budgetCategorySchema, budgetLineItemSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

export async function createBudgetCategoryAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = budgetCategorySchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const count = await prisma.budgetCategory.count({ where: { projectId } });
  await prisma.budgetCategory.create({ data: { name: parsed.data.name, projectId, order: count } });
  revalidatePath(`/projects/${projectId}/budget`);
  return undefined;
}

export async function deleteBudgetCategoryAction(projectId: string, categoryId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.budgetCategory.deleteMany({
    where: { id: categoryId, ...scopedTo.budgetCategory(projectId) },
  });
  revalidatePath(`/projects/${projectId}/budget`);
}

function parseLineItemForm(formData: FormData) {
  return budgetLineItemSchema.safeParse({
    description: formData.get("description"),
    estimated: formData.get("estimated") || "0",
    actual: formData.get("actual") || "0",
    notes: formData.get("notes") ?? "",
  });
}

export async function createBudgetLineItemAction(
  projectId: string,
  categoryId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseLineItemForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.budgetLineItem.create({ data: { ...parsed.data, categoryId } });
  revalidatePath(`/projects/${projectId}/budget`);
  return undefined;
}

export async function updateBudgetLineItemAction(
  projectId: string,
  itemId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseLineItemForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const result = await prisma.budgetLineItem.updateMany({
    where: { id: itemId, ...scopedTo.budgetLineItem(projectId) },
    data: parsed.data,
  });
  if (missed(result)) return NOT_FOUND;
  revalidatePath(`/projects/${projectId}/budget`);
  return undefined;
}

export async function deleteBudgetLineItemAction(projectId: string, itemId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.budgetLineItem.deleteMany({
    where: { id: itemId, ...scopedTo.budgetLineItem(projectId) },
  });
  revalidatePath(`/projects/${projectId}/budget`);
}
