import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { PageHeader } from "@/components/ui";
import { formatSlugline } from "@/lib/scene-format";
import {
  analyseContinuity,
  applyDecisions,
  characterTimeline,
  propTimeline,
  trackedCharacters,
  trackedProps,
  type AnalysisInput,
  type ContinuityScene,
  type ContinuityShot,
  type DecisionStatus,
} from "@/lib/continuity";
import { ContinuityPanel } from "./continuity-panel";

/**
 * Continuity.
 *
 * Read-only over the filmmaking data: this page loads Scenes, Shots and their
 * blocking, derives findings, and writes nothing. Findings are recomputed on
 * every load, so a difference the filmmaker fixes disappears by itself — only
 * their decisions are stored, and those attach by the finding's stable key.
 */
export default async function ContinuityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const [scenes, shots, decisionRows, sequence] = await Promise.all([
    prisma.scene.findMany({ where: { projectId }, orderBy: [{ order: "asc" }, { number: "asc" }] }),
    prisma.shotListItem.findMany({
      where: { scene: { projectId } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.continuityDecision.findMany({ where: { projectId } }),
    prisma.sequence.findFirst({
      where: { projectId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { clips: { orderBy: { order: "asc" }, select: { shotId: true } } },
    }),
  ]);

  const input: AnalysisInput = {
    shots: shots.map(
      (s): ContinuityShot => ({
        id: s.id,
        sceneId: s.sceneId,
        shotNumber: s.shotNumber,
        shotType: s.shotType,
        order: s.order,
        wardrobe: s.wardrobe,
        hairMakeup: s.hairMakeup,
        characterProps: s.characterProps,
        lightingNotes: s.lightingNotes,
        cameraAngle: s.cameraAngle,
        cameraHeight: s.cameraHeight,
        lens: s.lens,
        focalLength: s.focalLength,
        cameraMovement: s.cameraMovement,
        composition: s.composition,
        framing: s.framing,
        blocking: s.blocking,
      })
    ),
    scenes: Object.fromEntries(
      scenes.map((s): [string, ContinuityScene] => [
        s.id,
        {
          id: s.id,
          number: s.number,
          location: s.location,
          timeOfDay: s.timeOfDay,
          intExt: s.intExt,
        },
      ])
    ),
    // Shots the filmmaker placed next to each other in an edit count as
    // explicitly related, even across scene boundaries.
    editOrder: sequence?.clips.map((c) => c.shotId),
  };

  const decisions: Record<string, DecisionStatus> = Object.fromEntries(
    decisionRows.map((d) => [d.findingKey, d.status as DecisionStatus])
  );
  const findings = applyDecisions(analyseContinuity(input), decisions);

  const characters = trackedCharacters(input);
  const props = trackedProps(input);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Continuity"
        subtitle="Differences between related shots, explained. Nothing here changes your shots."
      />
      <ContinuityPanel
        projectId={projectId}
        findings={findings}
        shots={Object.fromEntries(
          shots.map((s) => [
            s.id,
            {
              shotNumber: s.shotNumber,
              shotType: s.shotType,
              sceneId: s.sceneId,
              sceneNumber: input.scenes[s.sceneId]?.number ?? "—",
            },
          ])
        )}
        scenes={Object.fromEntries(
          scenes.map((s) => [
            s.id,
            { number: s.number, slugline: formatSlugline(s.intExt, s.location, s.timeOfDay) },
          ])
        )}
        characterTimelines={Object.fromEntries(
          characters.map((name) => [name, characterTimeline(input, name)])
        )}
        propTimelines={Object.fromEntries(props.map((name) => [name, propTimeline(input, name)]))}
      />
    </div>
  );
}
