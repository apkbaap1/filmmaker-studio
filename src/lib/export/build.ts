import "server-only";

import { prisma } from "@/lib/prisma";
import { formatSlugline } from "@/lib/scene-format";
import { deriveBlockingContext } from "@/lib/blocking";
import {
  buildShotContext,
  compileSpec,
  listProviders,
  type CinematicPromptSpec,
  type ShotVisualizationContext,
} from "@/lib/prompt";
import { getImageProvider } from "@/lib/ai/image-providers";
import { configuredVideoProviderId, getVideoProvider, localStubVideoProvider } from "@/lib/ai/video-providers";
import { layOutClips, resolveClipAsset } from "@/lib/timeline";
import {
  analyseContinuity,
  type AnalysisInput,
  type ContinuityScene,
  type ContinuityShot,
} from "@/lib/continuity";
import type {
  ExportPackage,
  ExportPrompts,
  ExportScene,
  ExportShot,
  ProviderTransparency,
} from "./types.ts";

/**
 * Assembles the production export.
 *
 * Reads the project and recompiles every prompt from the Shot at export time, so
 * the package reflects the current specification rather than a cached copy.
 * Generations are copied verbatim: their `promptUsed` is the historical record
 * of what actually produced an asset and must never be re-rendered.
 */
export async function buildExportPackage(projectId: string): Promise<ExportPackage> {
  const [project, scenes, decisions, sequence] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.scene.findMany({
      where: { projectId },
      orderBy: [{ order: "asc" }, { number: "asc" }],
      include: {
        characters: { orderBy: { characterName: "asc" } },
        shots: {
          orderBy: [{ order: "asc" }, { createdAt: "asc" }],
          include: {
            assets: { orderBy: { createdAt: "desc" } },
            generations: { orderBy: { createdAt: "asc" } },
            promptVersions: { orderBy: [{ mode: "asc" }, { version: "asc" }] },
          },
        },
      },
    }),
    prisma.continuityDecision.findMany({ where: { projectId } }),
    prisma.sequence.findFirst({
      where: { projectId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { clips: { orderBy: { order: "asc" } } },
    }),
  ]);

  const adapters = listProviders();
  const exportScenes: ExportScene[] = scenes.map((scene) => ({
    id: scene.id,
    number: scene.number,
    slugline: formatSlugline(scene.intExt, scene.location, scene.timeOfDay),
    intExt: scene.intExt,
    location: scene.location,
    timeOfDay: scene.timeOfDay,
    synopsis: scene.synopsis,
    characters: scene.characters.map((c) => c.characterName),
    shots: scene.shots.map((shot): ExportShot => {
      const subjectLabel = scene.characters[0]?.characterName ?? "Subject";
      const context = buildShotContext(
        shot,
        scene,
        scene.characters,
        deriveBlockingContext(shot.blocking, subjectLabel)
      );

      return {
        id: shot.id,
        shotNumber: shot.shotNumber,
        structuredData: structuredDataOf(shot),
        blocking: (shot.blocking ?? null) as unknown,
        prompts: renderAllPrompts(context, adapters),
        promptVersions: shot.promptVersions.map((v) => ({
          version: v.version,
          mode: v.mode,
          source: v.source,
          text: v.text,
          promptProviderId: v.promptProviderId,
          sourceAssetId: v.sourceAssetId,
          label: v.label,
          createdAt: v.createdAt.toISOString(),
        })),
        generations: shot.generations.map((g) => ({
          id: g.id,
          mode: g.mode,
          source: g.source,
          status: g.status,
          promptUsed: g.promptUsed,
          promptEdited: g.promptEdited,
          providerId: g.providerId,
          promptProviderId: g.promptProviderId,
          durationSeconds: g.durationSeconds,
          error: g.error,
          assetId: g.assetId,
          sourceAssetId: g.sourceAssetId,
          createdAt: g.createdAt.toISOString(),
        })),
        storyboardAssetId:
          shot.assets.find((a) => a.mimeType.startsWith("image/"))?.id ?? null,
        assets: shot.assets.map((a) => ({
          id: a.id,
          type: a.type,
          source: a.source,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
          caption: a.caption,
          prompt: a.prompt,
          durationSeconds: a.durationSeconds,
          width: a.width,
          height: a.height,
          createdAt: a.createdAt.toISOString(),
          storagePath: a.filePath,
        })),
      };
    }),
  }));

  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    providerTransparency: providerTransparency(),
    project: {
      id: project.id,
      title: project.title,
      logline: project.logline,
      genre: project.genre,
      format: project.format,
      status: project.status,
    },
    scenes: exportScenes,
    timeline: buildTimeline(sequence, scenes),
    continuity: buildContinuity(scenes, decisions, sequence),
  };
}

/** Layer 1, flattened for readability. Values are copied, never recomputed. */
function structuredDataOf(shot: Record<string, unknown>): Record<string, string | number | null> {
  const fields = [
    "shotType", "description", "status",
    "cameraAngle", "cameraHeight", "lens", "focalLength", "cameraMovement",
    "cameraStartPosition", "cameraEndPosition", "movementSpeed",
    "initialFraming", "finalFraming",
    "subjectMovement", "subjectStartPosition", "subjectEndPosition", "characterBlocking",
    "environmentalMovement", "wardrobe", "hairMakeup", "characterProps",
    "composition", "finalComposition", "framing", "depthOfField",
    "lightingNotes", "mood",
    "durationSeconds", "dialogueAudio", "sfx", "soundDesignNotes",
    "transition", "editPoint", "equipmentNotes", "directorNotes",
  ];
  const out: Record<string, string | number | null> = {};
  for (const field of fields) {
    const value = shot[field];
    out[field] = typeof value === "string" || typeof value === "number" ? value : null;
  }
  return out;
}

/**
 * Layer 2 once, Layer 3 once per adapter. The spec is compiled a single time and
 * every adapter formats that same spec — which is the architecture, stated in
 * data: one provider-independent specification, many renderings.
 */
function renderAllPrompts(
  context: ShotVisualizationContext,
  adapters: ReturnType<typeof listProviders>
): ExportPrompts {
  const image = compileSpec(context, "image");
  const video = compileSpec(context, "video");
  const imageToVideo = compileSpec(context, "image-to-video");

  const byAdapter = (spec: CinematicPromptSpec, format: keyof (typeof adapters)[number]) =>
    Object.fromEntries(
      adapters.map((a) => [a.id, (a[format] as (s: CinematicPromptSpec) => string)(spec)])
    );

  return {
    spec: image,
    image: byAdapter(image, "formatImagePrompt"),
    video: byAdapter(video, "formatVideoPrompt"),
    imageToVideo: byAdapter(imageToVideo, "formatImageToVideoPrompt"),
  };
}

/**
 * States plainly what produced the media. A stub is named as a stub, here and in
 * the UI, so nothing in an export can be mistaken for real provider output.
 */
export function providerTransparency(): ProviderTransparency {
  const image = getImageProvider();
  const videoId = configuredVideoProviderId();
  const video = videoId ? getVideoProvider(videoId) : undefined;
  const videoIsStub = video?.id === localStubVideoProvider.id;

  const notes: string[] = [];
  notes.push(
    image.isConfigured()
      ? `Images: ${image.label} (${image.model}) is configured.`
      : `Images: no provider key configured — image prompts are provider-ready but nothing was generated through a real provider.`
  );
  notes.push(
    !video
      ? "Video: no provider configured. Video prompts are provider-ready; nothing was generated."
      : videoIsStub
        ? `Video: the LOCAL STUB was used. Any clip in this package is a placeholder, NOT AI-generated media.`
        : `Video: ${video.label} (${video.model}) is configured.`
  );

  return {
    imageProvider: {
      id: image.id,
      label: image.label,
      model: image.model,
      configured: image.isConfigured(),
    },
    videoProvider: video
      ? { id: video.id, label: video.label, model: video.model, isStub: videoIsStub }
      : null,
    note: notes.join(" "),
  };
}


function buildTimeline(
  sequence: {
    name: string;
    clips: Array<{
      id: string;
      shotId: string;
      order: number;
      inPointSeconds: number;
      outPointSeconds: number | null;
      transition: string | null;
      transitionDurationSeconds: number | null;
      selectedAssetId: string | null;
    }>;
  } | null,
  scenes: Array<{ shots: Array<{ id: string; shotNumber: string; durationSeconds: number | null; assets: Array<{ id: string; mimeType: string; durationSeconds: number | null }> }> }>
): ExportPackage["timeline"] {
  if (!sequence) return undefined;

  const shotsById = new Map(scenes.flatMap((s) => s.shots).map((s) => [s.id, s]));
  const layout = layOutClips(sequence.clips, (clip) => {
    const shot = shotsById.get(clip.shotId);
    const asset = shot ? resolveClipAsset(shot.assets, clip.selectedAssetId) : undefined;
    return {
      // Read from the shot, never written back: an export must not change a
      // shot's stated duration.
      shotDurationSeconds: shot?.durationSeconds,
      assetDurationSeconds: asset?.mimeType.startsWith("video/") ? asset.durationSeconds : null,
    };
  });

  return {
    sequenceName: sequence.name,
    totalSeconds: layout.totalSeconds,
    clips: layout.clips.map((entry) => ({
      shotId: entry.clip.shotId,
      shotNumber: shotsById.get(entry.clip.shotId)?.shotNumber ?? "—",
      order: entry.clip.order,
      inPointSeconds: entry.clip.inPointSeconds,
      outPointSeconds: entry.clip.outPointSeconds ?? null,
      usedSeconds: entry.usedSeconds,
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
      transition: entry.clip.transition,
      transitionDurationSeconds: entry.clip.transitionDurationSeconds,
      selectedAssetId: entry.clip.selectedAssetId,
    })),
  };
}

function buildContinuity(
  scenes: Array<{
    id: string;
    number: string;
    location: string;
    timeOfDay: string;
    intExt: string;
    shots: Array<Record<string, unknown> & { id: string; shotNumber: string }>;
  }>,
  decisions: Array<{ findingKey: string; status: string }>,
  sequence: { clips: Array<{ shotId: string }> } | null
): ExportPackage["continuity"] {
  const input: AnalysisInput = {
    shots: scenes.flatMap((scene) =>
      scene.shots.map((shot) => ({ ...shot, sceneId: scene.id }) as unknown as ContinuityShot)
    ),
    scenes: Object.fromEntries(
      scenes.map((s): [string, ContinuityScene] => [
        s.id,
        { id: s.id, number: s.number, location: s.location, timeOfDay: s.timeOfDay, intExt: s.intExt },
      ])
    ),
    editOrder: sequence?.clips.map((c) => c.shotId),
  };

  const numbers = new Map(input.shots.map((s) => [s.id, s.shotNumber]));
  const byKey = new Map(decisions.map((d) => [d.findingKey, d.status]));

  return analyseContinuity(input).map((f) => ({
    key: f.key,
    category: f.category,
    severity: f.severity,
    relation: f.relation,
    shotA: numbers.get(f.shotAId) ?? f.shotAId,
    shotB: numbers.get(f.shotBId) ?? f.shotBId,
    subject: f.subject ?? null,
    whatChanged: f.whatChanged,
    whyItMayMatter: f.whyItMayMatter,
    decision: byKey.get(f.key) ?? null,
  }));
}

