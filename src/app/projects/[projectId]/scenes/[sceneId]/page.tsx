import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Badge, Card, PageHeader } from "@/components/ui";
import { SceneForm } from "../scene-form";
import { updateSceneAction } from "@/lib/actions/scenes";
import { ShotList } from "./shot-list";
import { DeleteSceneButton } from "./delete-scene-button";
import { AssetGallery } from "@/components/asset-gallery";
import { isImageGenerationConfigured } from "@/lib/ai/openai-image";
import { formatSlugline } from "@/lib/scene-format";

export default async function SceneDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; sceneId: string }>;
}) {
  const { projectId, sceneId } = await params;
  await requireProjectAccess(projectId);

  const [scene, castMembers] = await Promise.all([
    prisma.scene.findFirst({
      where: { id: sceneId, projectId },
      include: {
        shots: { orderBy: { createdAt: "asc" }, include: { assets: true } },
        assets: { where: { shotId: null }, orderBy: { createdAt: "desc" } },
        characters: { orderBy: { characterName: "asc" } },
      },
    }),
    prisma.castMember.findMany({
      where: { projectId },
      orderBy: { characterName: "asc" },
      select: { id: true, characterName: true, actorName: true },
    }),
  ]);
  if (!scene) notFound();

  const imageGenAvailable = isImageGenerationConfigured();
  const boundAction = updateSceneAction.bind(null, projectId, sceneId);

  return (
    <div className="space-y-8">
      <div>
        <PageHeader
          title="Visualization Studio"
          actions={<DeleteSceneButton projectId={projectId} sceneId={sceneId} />}
        />

        <Card className="mb-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-accent">
                Scene {scene.number}
              </p>
              <p className="mt-1 font-mono text-lg text-foreground">
                {formatSlugline(scene.intExt, scene.location, scene.timeOfDay)}
              </p>
            </div>
            <Badge>{scene.pageEights} eighths</Badge>
          </div>

          {scene.characters.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {scene.characters.map((c) => (
                <Badge key={c.id} tone="accent">
                  {c.characterName}
                </Badge>
              ))}
            </div>
          )}

          {scene.synopsis && <p className="mt-3 text-sm text-muted">{scene.synopsis}</p>}

          {(scene.emotionalBeat || scene.directorNotes) && (
            <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border/60 pt-3 text-sm sm:grid-cols-2">
              {scene.emotionalBeat && (
                <p>
                  <span className="font-medium text-foreground">Emotional beat:</span>{" "}
                  <span className="text-muted">{scene.emotionalBeat}</span>
                </p>
              )}
              {scene.directorNotes && (
                <p>
                  <span className="font-medium text-foreground">Director&apos;s notes:</span>{" "}
                  <span className="text-muted">{scene.directorNotes}</span>
                </p>
              )}
            </div>
          )}
        </Card>

        <SceneForm
          action={boundAction}
          submitLabel="Save scene"
          castMembers={castMembers}
          defaultValues={{
            number: scene.number,
            intExt: scene.intExt,
            location: scene.location,
            timeOfDay: scene.timeOfDay,
            synopsis: scene.synopsis ?? "",
            scriptText: scene.scriptText ?? "",
            action: scene.action ?? "",
            emotionalBeat: scene.emotionalBeat ?? "",
            directorNotes: scene.directorNotes ?? "",
            pageEights: scene.pageEights,
            characterIds: scene.characters.map((c) => c.id),
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
          Shot Builder ({scene.shots.length})
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
