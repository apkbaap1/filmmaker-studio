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
import { ClipInspector, TRANSITION_LABEL } from "./clip-inspector";
import { TimelinePlayer, type PlayerLayer } from "./timeline-player";
import type { AssetRef, ClipRef, SceneRef, SequenceRef, ShotRef } from "./types";

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
  shots,
  scenes,
  unplacedShotIds,
}: {
  projectId: string;
  sequence: SequenceRef;
  clips: ClipRef[];
  shots: Record<string, ShotRef>;
  scenes: Record<string, SceneRef>;
  unplacedShotIds: string[];
}) {
  const [zoom, setZoom] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
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

  // --- playback -------------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPlayhead((t) => {
        const next = t + TICK_MS / 1000;
        if (next >= layout.totalSeconds) {
          setPlaying(false);
          return layout.totalSeconds;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, layout.totalSeconds]);

  const seekToPixel = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const seconds = (clientX - rect.left + track.scrollLeft) / pxPerSecond;
      setPlayhead(Math.min(Math.max(seconds, 0), layout.totalSeconds));
    },
    [pxPerSecond, layout.totalSeconds]
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
    for (let t = 0; t <= Math.max(layout.totalSeconds, step); t += step) marks.push(t);
    return marks;
  }, [zoom, layout.totalSeconds]);

  const trackWidth = Math.max(layout.totalSeconds * pxPerSecond, 480);

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
            totalSeconds={layout.totalSeconds}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                if (playheadSeconds >= layout.totalSeconds) setPlayhead(0);
                setPlaying((p) => !p);
              }}
              disabled={layout.totalSeconds === 0}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setPlaying(false); setPlayhead(0); }}>
              Go to start
            </Button>
            <span className="font-mono text-sm text-foreground">{formatTimecode(playheadSeconds)}</span>
            <span className="text-xs text-muted">
              of {formatDuration(layout.totalSeconds)} · {layout.clips.length} clips
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
          {selected ? (
            <ClipInspector
              projectId={projectId}
              entry={selected}
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
          <div ref={trackRef} className="overflow-x-auto">
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

                {/* Playhead. Starts above this row so it crosses the ruler and
                    the scene band too, which is how you read its position. */}
                <div
                  className="pointer-events-none absolute bottom-0 z-20 w-px bg-accent"
                  style={{ left: playheadSeconds * pxPerSecond, top: -52 }}
                >
                  <div className="-ml-[3px] h-[7px] w-[7px] rounded-full bg-accent" />
                </div>
              </div>
            </div>
          </div>
        )}
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
