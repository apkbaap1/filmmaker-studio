"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { NOT_FOUND, missed, scopedTo } from "@/lib/authz";
import { scheduleDaySchema, scheduleItemSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseDayForm(formData: FormData) {
  return scheduleDaySchema.safeParse({
    dayNumber: formData.get("dayNumber"),
    date: formData.get("date"),
    callTime: formData.get("callTime") ?? "",
    wrapTime: formData.get("wrapTime") ?? "",
    location: formData.get("location") ?? "",
    weather: formData.get("weather") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createScheduleDayAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseDayForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const day = await prisma.scheduleDay.create({
    data: { ...parsed.data, date: new Date(parsed.data.date), projectId },
  });

  revalidatePath(`/projects/${projectId}/schedule`);
  redirect(`/projects/${projectId}/schedule/${day.id}`);
}

export async function updateScheduleDayAction(
  projectId: string,
  dayId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseDayForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await prisma.scheduleDay.updateMany({
    where: { id: dayId, ...scopedTo.scheduleDay(projectId) },
    data: { ...parsed.data, date: new Date(parsed.data.date) },
  });
  if (missed(result)) return NOT_FOUND;

  revalidatePath(`/projects/${projectId}/schedule`);
  revalidatePath(`/projects/${projectId}/schedule/${dayId}`);
  return undefined;
}

export async function deleteScheduleDayAction(projectId: string, dayId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.scheduleDay.deleteMany({ where: { id: dayId, ...scopedTo.scheduleDay(projectId) } });
  revalidatePath(`/projects/${projectId}/schedule`);
  redirect(`/projects/${projectId}/schedule`);
}

function parseItemForm(formData: FormData) {
  return scheduleItemSchema.safeParse({
    sceneId: formData.get("sceneId") ?? "",
    startTime: formData.get("startTime") ?? "",
    endTime: formData.get("endTime") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createScheduleItemAction(
  projectId: string,
  dayId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseItemForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.scheduleItem.create({
    data: {
      scheduleDayId: dayId,
      sceneId: parsed.data.sceneId || null,
      startTime: parsed.data.startTime || null,
      endTime: parsed.data.endTime || null,
      notes: parsed.data.notes || null,
    },
  });

  revalidatePath(`/projects/${projectId}/schedule/${dayId}`);
  return undefined;
}

export async function deleteScheduleItemAction(projectId: string, dayId: string, itemId: string) {
  await requireProjectAccess(projectId, { write: true });
  await prisma.scheduleItem.deleteMany({
    where: { id: itemId, ...scopedTo.scheduleItem(projectId) },
  });
  revalidatePath(`/projects/${projectId}/schedule/${dayId}`);
}
