import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Button, PageHeader } from "@/components/ui";
import { formatSlugline } from "@/lib/scene-format";
import { deriveBlockingContext } from "@/lib/blocking";
import {
  buildShotContext,
  compileSpec,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateVideoPrompt,
  listProviders,
} from "@/lib/prompt";
import { providerTransparency } from "@/lib/export/build";
import {
  analyseContinuity,
  applyDecisions,
  type AnalysisInput,
  type ContinuityScene,
  type ContinuityShot,
  type DecisionStatus,
} from "@/lib/continuity";
import { ShotStudio } from "./shot-studio";

/**
 * Prompt Studio — shot level.
 *
 * The three layers are assembled here and kept apart all the way to the UI:
 * Layer 1 the Shot's structured data, Layer 2 the provider-independent spec,
 * Layer 3 one rendering per adapter per mode. Nothing is collapsed into a single
 * editable blob, and no value on this page is stored twice.
 */
export default async function ShotStudioPage({
  params,
}: {
  params: Promise<{ projectId: string; shotId: string }>;
}) {
  const { projectId, shotId } = await params;
  await requireProjectAccess(projectId);

  const shot = await prisma.shotListItem.findFirst({
    where: { id: shotId, scene: { projectId } },
    include: {
      scene: { include: { characters: { orderBy: { characterName: "asc" } } } },
      assets: { orderBy: { createdAt: "desc" } },
      generations: { orderBy: { createdAt: "desc" }, include: { asset: true } },
      promptVersions: { orderBy: [{ mode: "asc" }, { version: "desc" }] },
      timelineClips: { include: { sequence: true } },
    },
  });
  if (!shot) notFound();

  const scene = shot.scene;
  const subjectLabel = scene.characters[0]?.characterName ?? "Subject";
  const context = buildShotContext(
    shot,
    scene,
    scene.characters,
    deriveBlockingContext(shot.blocking, subjectLabel)
  );

  const adapters = listProviders();
  const image = generateImagePrompt(context);
  const video = generateVideoPrompt(context);
  const imageToVideo = generateImageToVideoPrompt(context);

  // Continuity for this shot only, from the same analyser the Continuity tab
  // uses — findings are derived, never stored, so these cannot disagree.
  const [allScenes, decisionRows, sequence] = await Promise.all([
    prisma.scene.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { number: "asc" }],
      include: { shots: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    }),
    prisma.continuityDecision.findMany({ where: { projectId } }),
    prisma.sequence.findFirst({
      where: { projectId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { clips: { orderBy: { order: "asc" }, select: { shotId: true } } },
    }),
  ]);

  const analysisInput: AnalysisInput = {
    shots: allScenes.flatMap((s) => s.shots.map((x) => x as unknown as ContinuityShot)),
    scenes: Object.fromEntries(
      allScenes.map((s): [string, ContinuityScene] => [
        s.id,
        { id: s.id, number: s.number, location: s.location, timeOfDay: s.timeOfDay, intExt: s.intExt },
      ])
    ),
    editOrder: sequence?.clips.map((c) => c.shotId),
  };
  const shotNumbers = new Map(
    allScenes.flatMap((s) => s.shots).map((x) => [x.id, x.shotNumber])
  );
  const findings = applyDecisions(
    analyseContinuity(analysisInput),
    Object.fromEntries(decisionRows.map((d) => [d.findingKey, d.status as DecisionStatus]))
  ).filter((f) => f.shotAId === shotId || f.shotBId === shotId);

  const clip = shot.timelineClips[0];

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Shot ${shot.shotNumber} — Prompt Studio`}
        subtitle={`Scene ${scene.number} · ${formatSlugline(scene.intExt, scene.location, scene.timeOfDay)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/projects/${projectId}/studio`}>
              <Button variant="secondary" size="sm">
                All shots
              </Button>
            </Link>
            <Link href={`/projects/${projectId}/scenes/${scene.id}/shots/${shotId}`}>
              <Button variant="secondary" size="sm">
                Shot design
              </Button>
            </Link>
          </div>
        }
      />

      <ShotStudio
        projectId={projectId}
        sceneId={scene.id}
        shotId={shotId}
        overview={{
          sceneNumber: scene.number,
          slugline: formatSlugline(scene.intExt, scene.location, scene.timeOfDay),
          shotNumber: shot.shotNumber,
          shotType: shot.shotType,
          description: shot.description,
          characters: scene.characters.map((c) => c.characterName),
          location: scene.location,
          timeOfDay: scene.timeOfDay,
          camera: [shot.cameraAngle, shot.cameraHeight, shot.cameraMovement, shot.movementSpeed].filter(
            (v): v is string => Boolean(v)
          ),
          lens: [shot.focalLength, shot.lens].filter((v): v is string => Boolean(v)).join(" ") || null,
          composition: shot.composition,
          lighting: shot.lightingNotes,
          mood: shot.mood,
          durationSeconds: shot.durationSeconds,
          blocking: shot.blocking as unknown,
          storyboardAssetId:
            shot.assets.find((a) => a.mimeType.startsWith("image/"))?.id ?? null,
          timeline: clip
            ? {
                sequenceName: clip.sequence.name,
                inPointSeconds: clip.inPointSeconds,
                outPointSeconds: clip.outPointSeconds,
                transition: clip.transition,
              }
            : null,
        }}
        prompts={{
          IMAGE: { text: image.text, providerId: image.providerId },
          VIDEO: { text: video.text, providerId: video.providerId },
          IMAGE_TO_VIDEO: { text: imageToVideo.text, providerId: imageToVideo.providerId },
        }}
        specs={{
          IMAGE: compileSpec(context, "image") as unknown,
          VIDEO: compileSpec(context, "video") as unknown,
          IMAGE_TO_VIDEO: imageToVideo.spec as unknown,
        }}
        providerOutputs={{
          IMAGE: Object.fromEntries(
            adapters.map((a) => [a.id, { label: a.label, text: a.formatImagePrompt(image.spec) }])
          ),
          VIDEO: Object.fromEntries(
            adapters.map((a) => [a.id, { label: a.label, text: a.formatVideoPrompt(video.spec) }])
          ),
          IMAGE_TO_VIDEO: Object.fromEntries(
            adapters.map((a) => [
              a.id,
              { label: a.label, text: a.formatImageToVideoPrompt(imageToVideo.spec) },
            ])
          ),
        }}
        versions={shot.promptVersions.map((v) => ({
          id: v.id,
          mode: v.mode,
          version: v.version,
          source: v.source,
          text: v.text,
          promptProviderId: v.promptProviderId,
          sourceAssetId: v.sourceAssetId,
          label: v.label,
          createdAt: v.createdAt.toISOString(),
        }))}
        generations={shot.generations.map((g) => ({
          id: g.id,
          mode: g.mode,
          status: g.status,
          source: g.source,
          promptUsed: g.promptUsed,
          promptEdited: g.promptEdited,
          providerId: g.providerId,
          durationSeconds: g.durationSeconds,
          createdAt: g.createdAt.toISOString(),
          assetId: g.assetId,
          assetMimeType: g.asset?.mimeType ?? null,
          assetWidth: g.asset?.width ?? null,
          assetHeight: g.asset?.height ?? null,
          assetDurationSeconds: g.asset?.durationSeconds ?? null,
          sourceAssetId: g.sourceAssetId,
        }))}
        sourceFrames={shot.assets
          .filter((a) => a.mimeType.startsWith("image/"))
          .map((a) => ({ id: a.id, label: a.caption ?? `Frame ${a.createdAt.toLocaleString()}` }))}
        findings={findings.map((f) => ({
          key: f.key,
          category: f.category,
          severity: f.severity,
          subject: f.subject ?? null,
          whatChanged: f.whatChanged,
          whyItMayMatter: f.whyItMayMatter,
          status: f.status ?? null,
          shotA: shotNumbers.get(f.shotAId) ?? f.shotAId,
          shotB: shotNumbers.get(f.shotBId) ?? f.shotBId,
        }))}
        transparency={providerTransparency()}
      />
    </div>
  );
}
