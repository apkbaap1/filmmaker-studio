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

  const boundAction = createSceneAction.bind(null, projectId);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="New scene" />
      <SceneForm action={boundAction} submitLabel="Add scene" />
    </div>
  );
}
