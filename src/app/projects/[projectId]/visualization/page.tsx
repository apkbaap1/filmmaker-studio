import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Card, PageHeader } from "@/components/ui";
import { AssetGallery } from "@/components/asset-gallery";
import { isImageGenerationConfigured } from "@/lib/ai/openai-image";

export default async function VisualizationPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const [moodboardAssets, scenes] = await Promise.all([
    prisma.asset.findMany({
      where: { projectId, sceneId: null, shotId: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.scene.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { assets: true } } },
    }),
  ]);

  const imageGenAvailable = isImageGenerationConfigured();

  return (
    <div className="space-y-10">
      <div>
        <PageHeader
          title="Visualization"
          subtitle="Mood boards, concept art, and diagrams for the whole production"
        />
        <AssetGallery
          projectId={projectId}
          scope={{}}
          assets={moodboardAssets}
          imageGenAvailable={imageGenAvailable}
        />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Storyboards by scene</h2>
        {scenes.length === 0 ? (
          <p className="text-sm text-muted">Add scenes in the Script tab to start storyboarding them.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {scenes.map((scene) => (
              <Link key={scene.id} href={`/projects/${projectId}/scenes/${scene.id}`}>
                <Card className="p-4 transition-colors hover:border-accent/60">
                  <p className="font-medium text-foreground">
                    Scene {scene.number} — {scene.location}
                  </p>
                  <p className="mt-1 text-xs text-muted">{scene._count.assets} visuals</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
