import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { SceneForm } from "../scene-form";
import { updateSceneAction } from "@/lib/actions/scenes";
import { ShotList } from "./shot-list";
import { DeleteSceneButton } from "./delete-scene-button";
import { AssetGallery } from "@/components/asset-gallery";
import { isImageGenerationConfigured } from "@/lib/ai/openai-image";

export default async function SceneDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; sceneId: string }>;
}) {
  const { projectId, sceneId } = await params;
  await requireProjectAccess(projectId);

  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, projectId },
    include: {
      shots: { orderBy: { createdAt: "asc" }, include: { assets: true } },
      assets: { where: { shotId: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!scene) notFound();

  const imageGenAvailable = isImageGenerationConfigured();

  const boundAction = updateSceneAction.bind(null, projectId, sceneId);

  return (
    <div className="space-y-8">
      <div>
        <PageHeader
          title={`Scene ${scene.number}`}
          actions={<DeleteSceneButton projectId={projectId} sceneId={sceneId} />}
        />
        <SceneForm
          action={boundAction}
          submitLabel="Save scene"
          defaultValues={{
            number: scene.number,
            intExt: scene.intExt,
            location: scene.location,
            timeOfDay: scene.timeOfDay,
            synopsis: scene.synopsis ?? "",
            scriptText: scene.scriptText ?? "",
            pageEights: scene.pageEights,
          }}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Storyboard</h2>
        <AssetGallery
          projectId={projectId}
          scope={{ sceneId }}
          assets={scene.assets}
          imageGenAvailable={imageGenAvailable}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">
          Shot list ({scene.shots.length})
        </h2>
        <ShotList
          projectId={projectId}
          sceneId={sceneId}
          shots={scene.shots}
          imageGenAvailable={imageGenAvailable}
        />
      </div>
    </div>
  );
}
