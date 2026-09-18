import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { deriveBlockingContext, parseBlocking } from "@/lib/blocking";
import { formatSlugline } from "@/lib/scene-format";
import {
  buildShotContext,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateVideoPrompt,
} from "@/lib/prompt";
import { getImageProvider } from "@/lib/ai/image-providers";
import { configuredVideoProviderId, getVideoProvider } from "@/lib/ai/video-providers";
import { ShotDesign } from "./shot-design";
import { ShotGeneration } from "./shot-generation";

export default async function ShotDesignPage({
  params,
}: {
  params: Promise<{ projectId: string; sceneId: string; shotId: string }>;
}) {
  const { projectId, sceneId, shotId } = await params;
  await requireProjectAccess(projectId);

  const shot = await prisma.shotListItem.findFirst({
    where: { id: shotId, sceneId },
    include: { scene: { include: { characters: { orderBy: { characterName: "asc" } } } } },
  });
  if (!shot || shot.scene.projectId !== projectId) notFound();

  const scene = shot.scene;
  const subjectLabel = scene.characters[0]?.characterName ?? "Subject";
  const blocking = parseBlocking(shot.blocking, subjectLabel);

  // The same chain the compiler uses, rendered here so the filmmaker can see
  // that what they set on this page is exactly what reaches the prompt.
  const context = buildShotContext(
    shot,
    scene,
    scene.characters,
    deriveBlockingContext(shot.blocking, subjectLabel)
  );
  const imagePrompt = generateImagePrompt(context);
  const videoPrompt = generateVideoPrompt(context);
  const imageToVideoPrompt = generateImageToVideoPrompt(context);

  const generations = await prisma.generation.findMany({
    where: { shotId, projectId },
    orderBy: { createdAt: "desc" },
    include: { asset: { select: { mimeType: true } } },
  });

  // Stills already attached to this shot are what image-to-video can animate.
  const sourceFrames = await prisma.asset.findMany({
    where: { shotId, projectId, type: "IMAGE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, caption: true, source: true, createdAt: true },
  });

  // Only whether a provider is configured crosses to the browser — never a key.
  const imageProvider = getImageProvider();
  const videoProviderId = configuredVideoProviderId();
  const videoProvider = videoProviderId ? getVideoProvider(videoProviderId) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Shot ${shot.shotNumber} — design`}
        subtitle={`${scene.number}. ${formatSlugline(scene.intExt, scene.location, scene.timeOfDay)}`}
        actions={
          <Link href={`/projects/${projectId}/scenes/${sceneId}`}>
            <Button variant="secondary" size="sm">
              Back to Shot Builder
            </Button>
          </Link>
        }
      />

      <ShotDesign
        projectId={projectId}
        sceneId={sceneId}
        shotId={shotId}
        initialBlocking={blocking}
        subjectLabel={subjectLabel}
        cameraHeightLabel={shot.cameraHeight}
        initialValues={{
          composition: shot.composition ?? "",
          finalComposition: shot.finalComposition ?? "",
          framing: shot.framing ?? "",
          initialFraming: shot.initialFraming ?? "",
          finalFraming: shot.finalFraming ?? "",
          cameraMovement: shot.cameraMovement ?? "",
          movementSpeed: shot.movementSpeed ?? "",
          cameraStartPosition: shot.cameraStartPosition ?? "",
          cameraEndPosition: shot.cameraEndPosition ?? "",
          subjectMovement: shot.subjectMovement ?? "",
          subjectStartPosition: shot.subjectStartPosition ?? "",
          subjectEndPosition: shot.subjectEndPosition ?? "",
          environmentalMovement: shot.environmentalMovement ?? "",
          durationSeconds: shot.durationSeconds?.toString() ?? "",
        }}
      />

      <ShotGeneration
        projectId={projectId}
        sceneId={sceneId}
        shotId={shotId}
        prompts={{
          IMAGE: imagePrompt.text,
          VIDEO: videoPrompt.text,
          IMAGE_TO_VIDEO: imageToVideoPrompt.text,
        }}
        imageProviderLabel={imageProvider.label}
        imageGenAvailable={imageProvider.isConfigured()}
        videoProviderLabel={videoProvider?.label ?? null}
        videoGenAvailable={Boolean(videoProvider)}
        sourceFrames={sourceFrames.map((asset) => ({
          id: asset.id,
          label:
            asset.caption ??
            `${asset.source === "GENERATED" ? "Generated" : "Uploaded"} frame · ${asset.createdAt.toLocaleString()}`,
        }))}
        generations={generations.map((g) => ({
          id: g.id,
          mode: g.mode,
          status: g.status,
          failureKind: g.failureKind,
          attempts: g.attempts,
          maxAttempts: g.maxAttempts,
          source: g.source,
          promptUsed: g.promptUsed,
          promptEdited: g.promptEdited,
          error: g.error,
          providerId: g.providerId,
          durationSeconds: g.durationSeconds,
          createdAt: g.createdAt.toISOString(),
          assetId: g.assetId,
          assetMimeType: g.asset?.mimeType ?? null,
          sourceAssetId: g.sourceAssetId,
        }))}
      />

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Compiled from this shot</h3>
          <Badge tone="accent">{videoPrompt.spec.motion.movementKind}</Badge>
          {videoPrompt.spec.continuity.preserve.length === 0 &&
            videoPrompt.spec.continuity.animate.length === 0 && <Badge>no transitions stated</Badge>}
        </div>
        <p className="mb-3 text-xs text-muted">
          Live output of the Phase 3 compiler for this shot. Read-only here — the Prompt Studio comes
          later.
        </p>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Image prompt</p>
            <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-foreground">
              {imagePrompt.text || "Nothing specified yet."}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Video prompt</p>
            <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-foreground">
              {videoPrompt.text || "Nothing specified yet."}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
