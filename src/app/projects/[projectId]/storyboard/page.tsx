import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { EmptyState, PageHeader } from "@/components/ui";
import { isImageGenerationConfigured } from "@/lib/ai/openai-image";
import { StoryboardSceneGroup } from "./storyboard-scene-group";

export default async function StoryboardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const scenes = await prisma.scene.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    include: {
      shots: {
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        include: { assets: { orderBy: { createdAt: "desc" } } },
      },
    },
  });

  const totalShots = scenes.reduce((sum, s) => sum + s.shots.length, 0);
  const imageGenAvailable = isImageGenerationConfigured();

  return (
    <div>
      <PageHeader
        title="Storyboard"
        subtitle={
          scenes.length
            ? `${totalShots} shots across ${scenes.length} scenes, in chronological order`
            : "Your film's shot-by-shot visual plan"
        }
      />

      {scenes.length === 0 ? (
        <EmptyState
          title="No scenes yet"
          description="Add scenes in the Script tab, then come back here to storyboard them shot by shot."
        />
      ) : (
        <div className="space-y-10">
          {scenes.map((scene) => (
            <StoryboardSceneGroup
              key={scene.id}
              projectId={projectId}
              sceneId={scene.id}
              sceneNumber={scene.number}
              intExt={scene.intExt}
              location={scene.location}
              timeOfDay={scene.timeOfDay}
              shots={scene.shots}
              imageGenAvailable={imageGenAvailable}
            />
          ))}
        </div>
      )}
    </div>
  );
}
