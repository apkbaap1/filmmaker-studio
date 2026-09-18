import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { formatSlugline } from "@/lib/scene-format";
import { providerTransparency } from "@/lib/export/build";
import {
  analyseContinuity,
  applyDecisions,
  type AnalysisInput,
  type ContinuityScene,
  type ContinuityShot,
  type DecisionStatus,
} from "@/lib/continuity";
import { StudioIndex, type StudioRow } from "./studio-index";

/**
 * Prompt Studio — project level.
 *
 * An interface over the existing systems, not a new store: every number on this
 * page is read from the Shots, their generations and the continuity analyser.
 */
export default async function StudioPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const [scenes, decisionRows, sequence] = await Promise.all([
    prisma.scene.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { number: "asc" }],
      include: {
        shots: {
          orderBy: [{ order: "asc" }, { createdAt: "asc" }],
          include: {
            generations: { select: { mode: true, status: true, providerId: true } },
            promptVersions: { select: { id: true, source: true } },
            assets: { select: { id: true, mimeType: true }, orderBy: { createdAt: "desc" } },
          },
        },
      },
    }),
    prisma.continuityDecision.findMany({ where: { projectId } }),
    prisma.sequence.findFirst({
      where: { projectId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { clips: { orderBy: { order: "asc" }, select: { shotId: true } } },
    }),
  ]);

  const allShots = scenes.flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })));

  const analysisInput: AnalysisInput = {
    shots: allShots.map(({ shot }) => shot as unknown as ContinuityShot),
    scenes: Object.fromEntries(
      scenes.map((s): [string, ContinuityScene] => [
        s.id,
        { id: s.id, number: s.number, location: s.location, timeOfDay: s.timeOfDay, intExt: s.intExt },
      ])
    ),
    editOrder: sequence?.clips.map((c) => c.shotId),
  };
  const findings = applyDecisions(
    analyseContinuity(analysisInput),
    Object.fromEntries(decisionRows.map((d) => [d.findingKey, d.status as DecisionStatus]))
  );

  const inTimeline = new Set(sequence?.clips.map((c) => c.shotId) ?? []);

  const rows: StudioRow[] = allShots.map(({ scene, shot }) => {
    const shotFindings = findings.filter(
      (f) => f.shotAId === shot.id || f.shotBId === shot.id
    );
    return {
      shotId: shot.id,
      sceneId: scene.id,
      sceneNumber: scene.number,
      slugline: formatSlugline(scene.intExt, scene.location, scene.timeOfDay),
      shotNumber: shot.shotNumber,
      shotType: shot.shotType,
      storyboardAssetId: shot.assets.find((a) => a.mimeType.startsWith("image/"))?.id ?? null,
      generations: {
        image: shot.generations.filter((g) => g.mode === "IMAGE").length,
        video: shot.generations.filter((g) => g.mode === "VIDEO").length,
        imageToVideo: shot.generations.filter((g) => g.mode === "IMAGE_TO_VIDEO").length,
        completed: shot.generations.filter((g) => g.status === "COMPLETED").length,
        failed: shot.generations.filter((g) => g.status === "FAILED").length,
        running: shot.generations.filter((g) => g.status === "QUEUED" || g.status === "PROCESSING")
          .length,
      },
      savedVersions: shot.promptVersions.length,
      editedVersions: shot.promptVersions.filter((v) => v.source === "EDITED").length,
      openFindings: shotFindings.filter((f) => f.status === undefined).length,
      decidedFindings: shotFindings.filter((f) => f.status !== undefined).length,
      inTimeline: inTimeline.has(shot.id),
      blocked: shot.blocking !== null,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prompt Studio"
        subtitle="Every shot's prompts, generations, continuity and export — one view over the work you have already done."
      />
      <StudioIndex
        projectId={projectId}
        rows={rows}
        transparency={providerTransparency()}
      />
    </div>
  );
}
