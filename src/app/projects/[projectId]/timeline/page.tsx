import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess } from "@/lib/access";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatSlugline } from "@/lib/scene-format";
import { TimelineEditor } from "./timeline-editor";
import { CreateSequenceForm } from "./sequence-controls";
import type {
  AssetRef,
  AudioTrackRef,
  ClipRef,
  SceneRef,
  SequenceRef,
  ShotRef,
  TransitionValue,
} from "./types";

/**
 * Edit view.
 *
 * Reads the project's real Scenes, Shots and Assets and arranges *placements* of
 * them. There is no second copy of a shot anywhere in this page: every clip
 * carries a shotId and the shot data is sent once, so the timeline cannot drift
 * from the Shot Builder or the storyboard.
 */
export default async function TimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ sequence?: string }>;
}) {
  const { projectId } = await params;
  const { sequence: requestedSequenceId } = await searchParams;
  await requireProjectAccess(projectId);

  const sequences = await prisma.sequence.findMany({
    where: { projectId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });

  if (sequences.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Timeline"
          subtitle="Arrange your shots into an edit and watch the scene play through."
        />
        <EmptyState
          title="No edit yet"
          description="An edit is an ordered arrangement of shots you already have. Creating one never changes a shot — it only decides what plays, in what order, and for how long."
        />
        <Card className="p-5">
          <CreateSequenceForm projectId={projectId} />
        </Card>
      </div>
    );
  }

  const active = sequences.find((s) => s.id === requestedSequenceId) ?? sequences[0];

  const [clips, audioTracks] = await Promise.all([
    prisma.timelineClip.findMany({
      where: { sequenceId: active.id },
      orderBy: { order: "asc" },
    }),
    prisma.audioTrack.findMany({
      where: { sequenceId: active.id },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { clips: { orderBy: { startSeconds: "asc" } } },
    }),
  ]);

  const [allShots, allAssets, generations] = await Promise.all([
    prisma.shotListItem.findMany({
      where: { scene: { projectId } },
      orderBy: [{ scene: { order: "asc" } }, { order: "asc" }, { createdAt: "asc" }],
      include: { scene: true },
    }),
    prisma.asset.findMany({
      // Audio is included whether or not it hangs off a shot: a score belongs
      // to the production, not to one setup.
      where: { projectId, OR: [{ shotId: { not: null } }, { type: "AUDIO" }] },
      orderBy: { createdAt: "desc" },
    }),
    prisma.generation.groupBy({
      by: ["shotId", "status"],
      where: { projectId, shotId: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const toAssetRef = (asset: (typeof allAssets)[number]): AssetRef => ({
    id: asset.id,
    mimeType: asset.mimeType,
    caption: asset.caption,
    prompt: asset.prompt,
    source: asset.source,
    type: asset.type,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt.toISOString(),
  });

  /** Every audio asset in the project, placeable on any track. */
  const audioAssets = allAssets.filter((a) => a.type === "AUDIO").map(toAssetRef);

  const assetsByShot = new Map<string, AssetRef[]>();
  for (const asset of allAssets) {
    if (!asset.shotId || asset.type === "AUDIO") continue;
    const list = assetsByShot.get(asset.shotId) ?? [];
    list.push({
      id: asset.id,
      mimeType: asset.mimeType,
      caption: asset.caption,
      prompt: asset.prompt,
      source: asset.source,
      type: asset.type,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt.toISOString(),
    });
    assetsByShot.set(asset.shotId, list);
  }

  const countsByShot = new Map<string, ShotRef["generations"]>();
  for (const row of generations) {
    if (!row.shotId) continue;
    const counts = countsByShot.get(row.shotId) ?? {
      total: 0,
      completed: 0,
      processing: 0,
      failed: 0,
    };
    const n = row._count._all;
    counts.total += n;
    if (row.status === "COMPLETED") counts.completed += n;
    if (row.status === "FAILED") counts.failed += n;
    if (row.status === "QUEUED" || row.status === "PROCESSING") counts.processing += n;
    countsByShot.set(row.shotId, counts);
  }

  const scenes: Record<string, SceneRef> = {};
  const shots: Record<string, ShotRef> = {};
  for (const shot of allShots) {
    scenes[shot.scene.id] ??= {
      id: shot.scene.id,
      number: shot.scene.number,
      slugline: formatSlugline(shot.scene.intExt, shot.scene.location, shot.scene.timeOfDay),
    };
    const assets = assetsByShot.get(shot.id) ?? [];
    shots[shot.id] = {
      id: shot.id,
      sceneId: shot.sceneId,
      shotNumber: shot.shotNumber,
      shotType: shot.shotType,
      cameraAngle: shot.cameraAngle,
      cameraHeight: shot.cameraHeight,
      cameraMovement: shot.cameraMovement,
      movementSpeed: shot.movementSpeed,
      lens: shot.lens,
      focalLength: shot.focalLength,
      durationSeconds: shot.durationSeconds,
      transitionNote: shot.transition,
      editPoint: shot.editPoint,
      directorNotes: shot.directorNotes,
      assets,
      // The same frame the storyboard panel shows: newest image for the shot.
      storyboardAssetId: assets.find((a) => a.mimeType.startsWith("image/"))?.id ?? null,
      generations: countsByShot.get(shot.id) ?? { total: 0, completed: 0, processing: 0, failed: 0 },
    };
  }

  const placedShotIds = new Set(clips.map((c) => c.shotId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Timeline"
        subtitle={`${active.name} — ${clips.length} clip${clips.length === 1 ? "" : "s"}`}
        actions={
          sequences.length > 1 ? (
            <div className="flex flex-wrap gap-1">
              {sequences.map((s) => (
                <Link key={s.id} href={`/projects/${projectId}/timeline?sequence=${s.id}`}>
                  <Button variant={s.id === active.id ? "primary" : "ghost"} size="sm">
                    {s.name}
                  </Button>
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />

      <TimelineEditor
        projectId={projectId}
        sequence={{ id: active.id, name: active.name, notes: active.notes } satisfies SequenceRef}
        clips={clips.map(
          (c): ClipRef => ({
            id: c.id,
            shotId: c.shotId,
            order: c.order,
            inPointSeconds: c.inPointSeconds,
            outPointSeconds: c.outPointSeconds,
            transition: c.transition as TransitionValue | null,
            transitionDurationSeconds: c.transitionDurationSeconds,
            audioMuted: c.audioMuted,
            selectedAssetId: c.selectedAssetId,
            notes: c.notes,
          })
        )}
        audioTracks={audioTracks.map(
          (t): AudioTrackRef => ({
            id: t.id,
            name: t.name,
            role: t.role,
            order: t.order,
            muted: t.muted,
            gainDb: t.gainDb,
            clips: t.clips.map((c) => ({
              id: c.id,
              assetId: c.assetId,
              startSeconds: c.startSeconds,
              inPointSeconds: c.inPointSeconds,
              outPointSeconds: c.outPointSeconds,
              gainDb: c.gainDb,
              fadeInSeconds: c.fadeInSeconds,
              fadeOutSeconds: c.fadeOutSeconds,
              notes: c.notes,
            })),
          })
        )}
        audioAssets={audioAssets}
        shots={shots}
        scenes={scenes}
        unplacedShotIds={allShots.filter((s) => !placedShotIds.has(s.id)).map((s) => s.id)}
      />
    </div>
  );
}
