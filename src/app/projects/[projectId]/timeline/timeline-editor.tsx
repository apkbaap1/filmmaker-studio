"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Badge, Button, Card } from "@/components/ui";
import {
  clipAtTime,
  formatDuration,
  formatTimecode,
  groupByScene,
  layOutClips,
  resolveClipAsset,
  type LaidOutClip,
} from "@/lib/timeline";
import { addClipAction, populateSequenceAction, reorderClipsAction } from "@/lib/actions/timeline";
import {
  audioClipsAtTime,
  layOutAudioTrack,
  layOutSyncAudio,
  previewVolume,
  sequenceRuntime,
} from "@/lib/audio";
import { ClipInspector, TRANSITION_LABEL } from "./clip-inspector";
import { TimelinePlayer, type PlayerLayer } from "./timeline-player";
import { AudioEngine, type Sound } from "./audio-engine";
import {
  AddAudioTrack,
  AudioClipInspector,
  AudioTrackHeader,
  AudioTrackLane,
} from "./audio-tracks";
import type {
  AssetRef,
  AudioTrackRef,
  ClipRef,
  SceneRef,
  SequenceRef,
  ShotRef,
} from "./types";

/** Pixels per second at zoom 1. Zoom multiplies it. */
const BASE_PX_PER_SECOND = 28;
const ZOOMS = [0.5, 1, 2, 4];
/** How often the playhead advances during previz playback. */
const TICK_MS = 100;

/** Asset resolution is a rule, not a rendering detail — it lives in lib/timeline. */
function assetFor(shot: ShotRef | undefined, clip: ClipRef): AssetRef | undefined {
  if (!shot) return undefined;
  return resolveClipAsset(shot.assets, clip.selectedAssetId);
}

export function TimelineEditor({
  projectId,
  sequence,
  clips,
  audioTracks,
  audioAssets,
  shots,
  scenes,
  unplacedShotIds,
}: {
  projectId: string;
  sequence: SequenceRef;
  clips: ClipRef[];
  audioTracks: AudioTrackRef[];
  /** Every audio asset in the project, placeable on any track. */
  audioAssets: AssetRef[];
  shots: Record<string, ShotRef>;
  scenes: Record<string, SceneRef>;
  unplacedShotIds: string[];
}) {
  const [zoom, setZoom] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedAudioClipId, setSelectedAudioClipId] = useState<string | null>(null);
  const [playheadSeconds, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragIndex = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const pxPerSecond = BASE_PX_PER_SECOND * zoom;

  // The layout is derived from the server's clips on every render. There is no
  // client-side copy of the order: a stale one would silently disagree with the
  // database the moment anything else changed a clip.
  const layout = useMemo(
    () =>
      layOutClips(clips, (clip) => {
        const shot = shots[clip.shotId];
        const asset = assetFor(shot, clip);
        return {
          shotDurationSeconds: shot?.durationSeconds,
          assetDurationSeconds: asset?.mimeType.startsWith("video/") ? asset.durationSeconds : null,
        };
      }),
    [clips, shots]
  );

  const assetsById = useMemo(() => {
    const map: Record<string, AssetRef> = {};
    for (const asset of audioAssets) map[asset.id] = asset;
    for (const shot of Object.values(shots)) for (const a of shot.assets) map[a.id] = a;
    return map;
  }, [audioAssets, shots]);

  // Sound laid out against the picture that has already been positioned: a
  // J-cut's reach is measured from where the dissolves left things.
  const syncAudio = useMemo(
    () =>
      layOutSyncAudio(layout, (clip) => {
        const shot = shots[clip.shotId];
        const asset = assetFor(shot, clip);
        const isVideo = Boolean(asset?.mimeType.startsWith("video/"));
        return { hasAudio: isVideo, sourceSeconds: isVideo ? asset?.durationSeconds ?? null : null };
      }),
    [layout, shots]
  );

  const trackLayouts = useMemo(
    () =>
      audioTracks.map((track) => ({
        track,
        layout: layOutAudioTrack(track.clips, (clip) => assetsById[clip.assetId]?.durationSeconds ?? null),
      })),
    [audioTracks, assetsById]
  );

  const runtime = useMemo(
    () =>
      sequenceRuntime(
        layout.totalSeconds,
        syncAudio.endSeconds,
        trackLayouts.map((t) => t.layout.endSeconds)
      ),
    [layout.totalSeconds, syncAudio.endSeconds, trackLayouts]
  );

  const sceneGroups = useMemo(
    () => groupByScene(layout, (clip) => shots[clip.shotId]?.sceneId ?? "unknown"),
    [layout, shots]
  );

  const current = clipAtTime(layout, playheadSeconds);

  /** Turns a laid-out clip into the shot + asset the viewport should show. */
  const layerFor = useCallback(
    (entry: LaidOutClip<ClipRef> | undefined, offsetSeconds: number): PlayerLayer => {
      const shot = entry ? shots[entry.clip.shotId] : undefined;
      return {
        shot,
        asset: entry ? assetFor(shot, entry.clip) : undefined,
        offsetSeconds,
        inPointSeconds: entry?.clip.inPointSeconds ?? 0,
      };
    },
    [shots]
  );

  const playerLayer = layerFor(current?.entry, current?.offsetSeconds ?? 0);
  const incomingLayer = current?.incoming
    ? layerFor(current.incoming.entry, current.incoming.offsetSeconds)
    : undefined;

  const selected = layout.clips.find((e) => e.clip.id === selectedClipId);

  const selectedAudio = useMemo(() => {
    for (const { track, layout: trackLayout } of trackLayouts) {
      const entry = trackLayout.clips.find((c) => c.clip.id === selectedAudioClipId);
      if (entry) return { track, entry };
    }
    return undefined;
  }, [trackLayouts, selectedAudioClipId]);

  /**
   * Every sound that could play, with its position and level at the playhead.
   *
   * Computed for all of them rather than only the sounding ones so the engine's
   * elements stay mounted and loaded; a silent one is handed a null position
   * and pauses itself.
   */
  const sounds = useMemo((): Sound[] => {
    const list: Sound[] = [];

    for (const segment of syncAudio.segments) {
      const shot = shots[segment.clip.shotId];
      const asset = assetFor(shot, segment.clip);
      if (!asset?.mimeType.startsWith("video/")) continue;
      const sounding =
        !segment.silent &&
        playheadSeconds >= segment.startSeconds &&
        playheadSeconds < segment.endSeconds;
      list.push({
        key: `sync-${segment.clip.id}`,
        assetId: asset.id,
        sourceSeconds: sounding
          ? segment.sourceInSeconds + (playheadSeconds - segment.startSeconds)
          : null,
        // Sync sound carries no level of its own: a clip is either in the mix
        // or muted. A per-clip gain would be a mixing feature, and inventing
        // one here would be a control nothing else in the app knows about.
        volume: 1,
        measured: asset.durationSeconds !== null,
      });
    }

    for (const { track, layout: trackLayout } of trackLayouts) {
      for (const entry of trackLayout.clips) {
        const active = track.muted
          ? []
          : audioClipsAtTime(trackLayout, playheadSeconds, track.gainDb).filter(
              (a) => a.laidOut.clip.id === entry.clip.id
            );
        const sounding = active[0];
        list.push({
          key: `track-${entry.clip.id}`,
          assetId: entry.clip.assetId,
          sourceSeconds: sounding ? sounding.sourceSeconds : null,
          volume: sounding ? previewVolume(sounding.gain) : 0,
          measured: entry.measured,
        });
      }
    }

    return list;
  }, [syncAudio, trackLayouts, shots, playheadSeconds]);

  // --- playback -------------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPlayhead((t) => {
        const next = t + TICK_MS / 1000;
        if (next >= runtime.totalSeconds) {
          setPlaying(false);
          return runtime.totalSeconds;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, runtime.totalSeconds]);

  const seekToPixel = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const seconds = (clientX - rect.left + track.scrollLeft) / pxPerSecond;
      setPlayhead(Math.min(Math.max(seconds, 0), runtime.totalSeconds));
    },
    [pxPerSecond, runtime.totalSeconds]
  );

  // --- reorder --------------------------------------------------------------
  function handleDrop(dropIndex: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDraggingId(null);
    if (from === null || from === dropIndex) return;

    const next = layout.clips.map((e) => e.clip.id);
    const [moved] = next.splice(from, 1);
    next.splice(dropIndex, 0, moved);
    void reorderClipsAction(projectId, sequence.id, next);
  }

  const ticks = useMemo(() => {
    const step = zoom >= 4 ? 1 : zoom >= 2 ? 2 : zoom >= 1 ? 5 : 10;
    const marks: number[] = [];
    for (let t = 0; t <= Math.max(runtime.totalSeconds, step); t += step) marks.push(t);
    return marks;
  }, [zoom, runtime.totalSeconds]);

  const trackWidth = Math.max(runtime.totalSeconds * pxPerSecond, 480);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="space-y-3">
          <TimelinePlayer
            projectId={projectId}
            layer={playerLayer}
            incoming={incomingLayer}
            mixProgress={current?.incoming?.progress ?? 0}
            playing={playing}
            playheadSeconds={playheadSeconds}
            totalSeconds={runtime.totalSeconds}
          />
          <AudioEngine projectId={projectId} sounds={sounds} playing={playing} />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (playheadSeconds >= runtime.totalSeconds) setPlayhead(0);
                setPlaying((p) => !p);
              }}
              disabled={runtime.totalSeconds === 0}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setPlaying(false); setPlayhead(0); }}>
              Go to start
            </Button>
            <span className="font-mono text-sm text-foreground">{formatTimecode(playheadSeconds)}</span>
            <span className="text-xs text-muted">
              of {formatDuration(runtime.totalSeconds)} · {layout.clips.length} clips
              {runtime.audioSeconds > runtime.pictureSeconds && (
                <span
                  className="text-accent"
                  title={`The cut runs ${formatDuration(runtime.pictureSeconds)}; sound carries on past the last frame.`}
                >
                  {" "}
                  · sound to {formatDuration(runtime.audioSeconds)}
                </span>
              )}
              {layout.overlapSeconds > 0 && (
                <span
                  className="text-accent"
                  title={`Straight cuts throughout would run ${formatDuration(layout.straightCutSeconds)}.`}
                >
                  {" "}
                  · {formatDuration(layout.overlapSeconds)} shorter than a straight cut
                </span>
              )}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <span className="text-xs text-muted">Zoom</span>
              {ZOOMS.map((z) => (
                <Button
                  key={z}
                  size="sm"
                  variant={z === zoom ? "primary" : "ghost"}
                  onClick={() => setZoom(z)}
                >
                  {z}×
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div>
          {selectedAudio ? (
            <AudioClipInspector
              projectId={projectId}
              track={selectedAudio.track}
              entry={selectedAudio.entry}
              asset={assetsById[selectedAudio.entry.clip.assetId]}
              onDeselect={() => setSelectedAudioClipId(null)}
            />
          ) : selected ? (
            <ClipInspector
              projectId={projectId}
              entry={selected}
              audio={syncAudio.segments.find((seg) => seg.clip.id === selected.clip.id)}
              shot={shots[selected.clip.shotId]}
              scene={scenes[shots[selected.clip.shotId]?.sceneId ?? ""]}
              playheadSeconds={playheadSeconds}
              onDeselect={() => setSelectedClipId(null)}
            />
          ) : (
            <Card className="p-4">
              <p className="text-sm font-semibold text-foreground">No clip selected</p>
              <p className="mt-1 text-xs text-muted">
                Click a clip to inspect it, trim it, set its edit point, or choose which generated
                asset represents it. Drag clips to reorder. Nothing you do here changes the shots
                themselves.
              </p>
            </Card>
          )}
        </div>
      </div>

      {/* --- the timeline itself -------------------------------------------- */}
      <Card className="overflow-hidden">
        {layout.clips.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-foreground">This edit is empty.</p>
            <p className="mt-1 text-xs text-muted">
              Add shots below, or start from every shot in the project in scene order.
            </p>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => void populateSequenceAction(projectId, sequence.id)}
            >
              Add every shot in scene order
            </Button>
          </div>
        ) : (
          <div className="flex">
            <div className="w-44 shrink-0 border-r border-border bg-surface-2">
              <div className="h-7 border-b border-border" />
              <div className="h-6 border-b border-border" />
              <div
                className="flex items-center border-b border-border px-2 text-[11px] font-semibold text-muted"
                style={{ height: 112 }}
              >
                PICTURE
              </div>
              {trackLayouts.map(({ track }) => (
                <AudioTrackHeader
                  key={track.id}
                  projectId={projectId}
                  track={track}
                  audioAssets={audioAssets}
                  playheadSeconds={playheadSeconds}
                />
              ))}
            </div>

            <div ref={trackRef} className="flex-1 overflow-x-auto">
            <div className="relative" style={{ width: trackWidth, minWidth: "100%" }}>
              {/* time ruler */}
              <div
                className="relative h-7 cursor-pointer border-b border-border bg-surface-2"
                onClick={(e) => { setPlaying(false); seekToPixel(e.clientX); }}
              >
                {ticks.map((t) => (
                  <div
                    key={t}
                    className="absolute top-0 h-full border-l border-border/70 pl-1 text-[10px] leading-7 text-muted"
                    style={{ left: t * pxPerSecond }}
                  >
                    {formatTimecode(t)}
                  </div>
                ))}
              </div>

              {/* scene bands */}
              <div
                className="relative h-6 cursor-pointer border-b border-border bg-surface"
                onClick={(e) => { setPlaying(false); seekToPixel(e.clientX); }}
              >
                {sceneGroups.map((group, i) => {
                  const scene = scenes[group.sceneId];
                  const width = (group.endSeconds - group.startSeconds) * pxPerSecond;
                  return (
                    <div
                      key={`${group.sceneId}-${i}`}
                      className="absolute top-0 flex h-full items-center overflow-hidden whitespace-nowrap border-l border-border px-2 text-[11px] text-muted"
                      style={{ left: group.startSeconds * pxPerSecond, width }}
                      title={scene ? `Scene ${scene.number} — ${scene.slugline}` : undefined}
                    >
                      {scene ? `SC ${scene.number} · ${scene.slugline}` : "Unknown scene"}
                    </div>
                  );
                })}
              </div>

              {/* clips */}
              <div
                className="relative bg-surface"
                style={{ height: 112 }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) { setPlaying(false); seekToPixel(e.clientX); }
                }}
              >
                {/* Where a dissolve makes two clips play at once. Drawn over
                    both, because the overlap is the thing being shown — the
                    clips underneath are already positioned to overlap. */}
                {layout.clips
                  .filter((entry) => entry.overlapSeconds > 0)
                  .map((entry) => (
                    <div
                      key={`mix-${entry.clip.id}`}
                      className="pointer-events-none absolute top-1 z-20 rounded-sm border border-accent/70 bg-accent/25"
                      style={{
                        left: entry.startSeconds * pxPerSecond,
                        width: entry.overlapSeconds * pxPerSecond,
                        height: 104,
                      }}
                      title={`${formatDuration(entry.overlapSeconds)} dissolve — these seconds play once, not twice`}
                    />
                  ))}

                {layout.clips.map((entry, index) => (
                  <ClipBlock
                    key={entry.clip.id}
                    entry={entry}
                    index={index}
                    shot={shots[entry.clip.shotId]}
                    asset={assetFor(shots[entry.clip.shotId], entry.clip)}
                    pxPerSecond={pxPerSecond}
                    selected={entry.clip.id === selectedClipId}
                    dragging={draggingId === entry.clip.id}
                    onSelect={(clientX) => {
                      setSelectedClipId(entry.clip.id);
                      setPlaying(false);
                      // Seek to where inside the clip you clicked, not to its
                      // head — otherwise the playhead can never sit inside a
                      // clip and "Split at playhead" is unreachable.
                      seekToPixel(clientX);
                    }}
                    onDragStart={() => {
                      dragIndex.current = index;
                      setDraggingId(entry.clip.id);
                    }}
                    onDragOver={(e: DragEvent<HTMLDivElement>) => e.preventDefault()}
                    onDrop={() => handleDrop(index)}
                  />
                ))}

              </div>

              {/* --- audio lanes ----------------------------------------- */}
              {trackLayouts.map(({ track, layout: trackLayout }) => (
                <AudioTrackLane
                  key={track.id}
                  track={track}
                  layout={trackLayout}
                  assets={assetsById}
                  pxPerSecond={pxPerSecond}
                  selectedClipId={selectedAudioClipId}
                  onSelectClip={(clipId) => {
                    setSelectedAudioClipId(clipId);
                    setSelectedClipId(null);
                    setPlaying(false);
                  }}
                />
              ))}

              {/* Playhead. Spans every row, which is how its position is read:
                  a sound is under the picture it plays with, or deliberately
                  is not. */}
              <div
                className="pointer-events-none absolute inset-y-0 z-30 w-px bg-accent"
                style={{ left: playheadSeconds * pxPerSecond }}
              >
                <div className="-ml-[3px] h-[7px] w-[7px] rounded-full bg-accent" />
              </div>
            </div>
            </div>
          </div>
        )}
      </Card>

      {/* --- audio tracks ---------------------------------------------------- */}
      <Card className="p-4">
        <p className="text-sm font-semibold text-foreground">Sound</p>
        <p className="mb-3 mt-1 text-xs text-muted">
          A track carries sound that is not tied to a shot: a score, a narration pass, room tone.
          Sound that belongs to a shot is inside the video that shot plays, and is muted from the
          clip inspector rather than from here.
          {audioAssets.length === 0 && (
            <>
              {" "}
              No audio has been uploaded to this project yet — add some from the Visualization tab,
              then place it at the playhead.
            </>
          )}
        </p>
        <AddAudioTrack projectId={projectId} sequenceId={sequence.id} />
      </Card>

      {/* --- shots not in this edit ------------------------------------------ */}
      <Card className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Shots not in this edit</h3>
          <Badge>{unplacedShotIds.length}</Badge>
        </div>
        <p className="mb-3 text-xs text-muted">
          Removing a clip from the edit leaves its shot here, intact with all its camera data,
          blocking and generations. Add it back whenever you want.
        </p>
        {unplacedShotIds.length === 0 ? (
          <p className="text-xs text-muted">Every shot in the project is placed in this edit.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {unplacedShotIds.map((shotId) => {
              const shot = shots[shotId];
              if (!shot) return null;
              const scene = scenes[shot.sceneId];
              return (
                <Button
                  key={shotId}
                  size="sm"
                  variant="secondary"
                  onClick={() => void addClipAction(projectId, sequence.id, shotId)}
                >
                  + {scene ? `SC${scene.number} ` : ""}Shot {shot.shotNumber} · {shot.shotType}
                </Button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function ClipBlock({
  entry,
  index,
  shot,
  asset,
  pxPerSecond,
  selected,
  dragging,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  entry: LaidOutClip<ClipRef>;
  index: number;
  shot: ShotRef | undefined;
  asset: AssetRef | undefined;
  pxPerSecond: number;
  selected: boolean;
  dragging: boolean;
  onSelect: (clientX: number) => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
}) {
  const width = Math.max(entry.usedSeconds * pxPerSecond, 2);
  const transition = entry.clip.transition;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={(e) => onSelect(e.clientX)}
      className={[
        "absolute top-1 flex cursor-pointer flex-col overflow-hidden rounded border bg-surface-2 transition-opacity",
        selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-muted",
        dragging ? "opacity-40" : "",
      ].join(" ")}
      style={{ left: entry.startSeconds * pxPerSecond, width, height: 104 }}
      title={shot ? `Shot ${shot.shotNumber} — ${shot.shotType}` : "Missing shot"}
      data-clip-id={entry.clip.id}
      data-shot-number={shot?.shotNumber}
    >
      {/* Explicit edit points get a marker; an unspecified boundary gets nothing. */}
      {transition && (
        <div className="absolute left-0 top-0 z-10 bg-accent px-1 text-[9px] font-semibold text-white">
          {TRANSITION_LABEL[transition]}
        </div>
      )}

      <div className="flex h-12 w-full items-center justify-center overflow-hidden bg-black/40">
        {asset?.mimeType.startsWith("image/") ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/assets/${asset.id}/file`}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : asset?.mimeType.startsWith("video/") ? (
          <span className="text-[10px] text-muted">▶ clip</span>
        ) : (
          <span className="text-[10px] text-muted">no visual</span>
        )}
      </div>

      <div className="min-w-0 flex-1 px-1.5 py-1">
        <p className="truncate font-mono text-[10px] font-semibold text-foreground">
          {shot ? `${shot.shotNumber}` : "—"}
          <span className="ml-1 font-sans font-normal text-muted">#{index + 1}</span>
        </p>
        <p className="truncate text-[10px] text-muted">{shot?.shotType}</p>
        <p className="truncate text-[10px] text-muted">
          {formatDuration(entry.usedSeconds)}
          {entry.trimmed && <span className="text-accent"> ✂</span>}
          {entry.source.from === "placeholder" && <span title="No duration stated"> ?</span>}
        </p>
      </div>
    </div>
  );
}
