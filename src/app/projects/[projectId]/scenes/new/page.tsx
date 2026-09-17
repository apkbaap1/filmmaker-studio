import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { SceneForm } from "../scene-form";
import { createSceneAction } from "@/lib/actions/scenes";

export default async function NewScenePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId, { write: true });

  const castMembers = await prisma.castMember.findMany({
    where: { projectId },
    orderBy: { characterName: "asc" },
    select: { id: true, characterName: true, actorName: true },
  });

  const boundAction = createSceneAction.bind(null, projectId);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New scene" />
      <SceneForm action={boundAction} submitLabel="Add scene" castMembers={castMembers} />
    </div>
  );
}
