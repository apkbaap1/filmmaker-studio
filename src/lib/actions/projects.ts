"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess, requireSession } from "@/lib/access";
import { projectSchema } from "@/lib/validation";

export type FormState = { error?: string } | undefined;

function parseProjectForm(formData: FormData) {
  return projectSchema.safeParse({
    title: formData.get("title"),
    logline: formData.get("logline") ?? "",
    description: formData.get("description") ?? "",
    genre: formData.get("genre") ?? "",
    format: formData.get("format") ?? "",
    status: formData.get("status") ?? "",
  });
}

export async function createProjectAction(
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const session = await requireSession();
  const parsed = parseProjectForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const project = await prisma.project.create({
    data: {
      ...parsed.data,
      status: parsed.data.status || "Development",
      ownerId: session.user.id,
      members: {
        create: { userId: session.user.id, role: "OWNER" },
      },
    },
  });

  revalidatePath("/dashboard");
  redirect(`/projects/${project.id}`);
}

export async function updateProjectAction(
  projectId: string,
  _prevState: FormState,
  formData: FormData
): Promise<FormState> {
  await requireProjectAccess(projectId, { write: true });
  const parsed = parseProjectForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { ...parsed.data, status: parsed.data.status || "Development" },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/dashboard");
  return undefined;
}

export async function deleteProjectAction(projectId: string) {
  const { isOwner } = await requireProjectAccess(projectId, { write: true });
  if (!isOwner) {
    return;
  }
  await prisma.project.delete({ where: { id: projectId } });
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
