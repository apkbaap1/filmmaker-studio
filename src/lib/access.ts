import { redirect, notFound } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) redirect("/sign-in");
  return session;
}

export async function requireProjectAccess(
  projectId: string,
  opts: { write?: boolean } = {}
) {
  const session = await requireSession();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { members: { where: { userId: session.user.id } } },
  });

  if (!project) notFound();

  const isOwner = project.ownerId === session.user.id;
  const membership = project.members[0];
  const hasAccess = isOwner || !!membership;
  if (!hasAccess) notFound();

  if (opts.write && !isOwner && membership?.role === "VIEWER") {
    notFound();
  }

  return { session, project, isOwner };
}
