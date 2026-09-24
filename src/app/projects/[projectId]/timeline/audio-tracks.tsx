"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { formatDuration, formatTimecode } from "@/lib/timeline";
import {
  gainToLinear,
  previewCanApply,
  type AudioTrackLayout,
  type LaidOutAudioClip,
} from "@/lib/audio";
import {
  addAudioClipAction,
  createAudioTrackAction,
  deleteAudioTrackAction,
  removeAudioClipAction,
  setAudioClipNotesAction,
  updateAudioClipAction,
  updateAudioTrackAction,
} from "@/lib/actions/audio";
import type { AssetRef, AudioClipRef, AudioRoleValue, AudioTrackRef } from "./types";

const ROLES: Array<{ value: AudioRoleValue; label: string }> = [
  { value: "DIALOGUE", label: "Dialogue" },
  { value: "MUSIC", label: "Music" },
  { value: "SFX", label: "SFX" },
  { value: "AMBIENCE", label: "Ambience" },
];

export const ROLE_LABEL: Record<AudioRoleValue, string> = Object.fromEntries(
  ROLES.map((r) => [r.value, r.label])
) as Record<AudioRoleValue, string>;

/** A level nobody stated prints as nothing, not as 0 dB. */
function gainLabel(gainDb: number | null): string | null {
  if (gainDb === null) return null;
  return `${gainDb > 0 ? "+" : ""}${gainDb} dB`;
}

// --- the lanes on the ruler --------------------------------------------------

export function AudioTrackLane({
  track,
  layout,
  assets,
  pxPerSecond,
  selectedClipId,
  onSelectClip,
}: {
  track: AudioTrackRef;
  layout: AudioTrackLayout<AudioClipRef>;
  assets: Record<string, AssetRef>;
  pxPerSecond: number;
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
}) {
  return (
    <div className="relative h-12 border-b border-border bg-surface">
      {layout.clips.map((entry) => (
        <AudioClipBlock
          key={entry.clip.id}
          entry={entry}
          asset={assets[entry.clip.assetId]}
          muted={track.muted}
          pxPerSecond={pxPerSecond}
          selected={entry.clip.id === selectedClipId}
          onSelect={() => onSelectClip(entry.clip.id)}
        />
      ))}
    </div>
  );
}

function AudioClipBlock({
  entry,
  asset,
  muted,
  pxPerSecond,
  selected,
  onSelect,
}: {
  entry: LaidOutAudioClip<AudioClipRef>;
  asset: AssetRef | undefined;
  muted: boolean;
  pxPerSecond: number;
  selected: boolean;
  onSelect: () => void;
}) {
  // An unmeasured placement gets a narrow marker rather than a bar: its length
  // is unknown, and a bar of an invented width would be a claim about where the
  // sound ends.
  const width =
    entry.usedSeconds === null ? 14 : Math.max(entry.usedSeconds * pxPerSecond, 3);

  return (
    <div
      onClick={onSelect}
      className={[
        "absolute top-1 flex h-10 cursor-pointer items-center gap-1 overflow-hidden rounded border px-1",
        muted ? "bg-surface-2 opacity-50" : "bg-surface-2",
        selected ? "border-accent ring-1 ring-accent" : "border-border hover:border-muted",
        entry.overlapsPrevious ? "border-dashed" : "",
      ].join(" ")}
      style={{ left: entry.startSeconds * pxPerSecond, width }}
      title={
        entry.usedSeconds === null
          ? `${asset?.caption ?? "Audio"} — length not measured yet; play once to measure it`
          : `${asset?.caption ?? "Audio"} — ${formatDuration(entry.usedSeconds)} from ${formatTimecode(entry.startSeconds)}`
      }
      data-audio-clip-id={entry.clip.id}
    >
      <span className="truncate text-[10px] text-foreground">
        {entry.usedSeconds === null ? "?" : (asset?.caption ?? "audio")}
      </span>
      {entry.overlapsPrevious && <span className="text-[9px] text-accent">⧉</span>}
    </div>
  );
}

// --- the track header --------------------------------------------------------

export function AudioTrackHeader({
  projectId,
  track,
  audioAssets,
  playheadSeconds,
}: {
  projectId: string;
  track: AudioTrackRef;
  audioAssets: AssetRef[];
  playheadSeconds: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState("");

  function run(fn: () => Promise<{ error?: string } | undefined | void>) {
    setError(null);
    start(async () => {
      const result = await fn();
      if (result && "error" in result && result.error) setError(result.error);
    });
  }

  const boost = gainToLinear(track.gainDb);

  return (
    <div className="flex h-12 items-center gap-1.5 border-b border-r border-border px-2">
      <Button
        size="sm"
        variant={track.muted ? "primary" : "ghost"}
        disabled={pending}
        title={track.muted ? "Unmute this track" : "Mute this track"}
        onClick={() =>
          run(() =>
            updateAudioTrackAction(projectId, track.id, {
              name: track.name,
              role: track.role,
              gainDb: track.gainDb,
              muted: !track.muted,
            })
          )
        }
      >
        {track.muted ? "M" : "·"}
      </Button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold text-foreground">{track.name}</p>
        <p className="truncate text-[10px] text-muted">
          {ROLE_LABEL[track.role]}
          {gainLabel(track.gainDb) && ` · ${gainLabel(track.gainDb)}`}
          {!previewCanApply(boost) && (
            <span title="The preview player cannot boost above unity; the level is stored and applied on export.">
              {" "}
              ⚠
            </span>
          )}
        </p>
      </div>

      {audioAssets.length > 0 && (
        <Select
          value={addingId}
          disabled={pending}
          title={`Place a recording at ${formatTimecode(playheadSeconds)}`}
          onChange={(e) => {
            const assetId = e.target.value;
            setAddingId("");
            if (!assetId) return;
            run(() => addAudioClipAction(projectId, track.id, assetId, playheadSeconds));
          }}
        >
          <option value="">+ at playhead</option>
          {audioAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.caption ?? a.id.slice(0, 8)}
            </option>
          ))}
        </Select>
      )}

      {error && <ErrorText message={error} />}
    </div>
  );
}

// --- creating and editing tracks ---------------------------------------------

export function AddAudioTrack({
  projectId,
  sequenceId,
}: {
  projectId: string;
  sequenceId: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<AudioRoleValue>("MUSIC");

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-44">
        <Field label="Track name">
          <Input
            value={name}
            placeholder="Score"
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      <div className="w-36">
        <Field label="Carries">
          <Select
            value={role}
            disabled={pending}
            onChange={(e) => setRole(e.target.value as AudioRoleValue)}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button
        size="sm"
        disabled={pending || name.trim() === ""}
        onClick={() => {
          setError(null);
          start(async () => {
            const result = await createAudioTrackAction(projectId, sequenceId, {
              name: name.trim(),
              role,
            });
            if (result?.error) setError(result.error);
            else setName("");
          });
        }}
      >
        Add track
      </Button>
      {error && <ErrorText message={error} />}
    </div>
  );
}

// --- the inspector -----------------------------------------------------------

export function AudioClipInspector({
  projectId,
  track,
  entry,
  asset,
  onDeselect,
}: {
  projectId: string;
  track: AudioTrackRef;
  entry: LaidOutAudioClip<AudioClipRef>;
  asset: AssetRef | undefined;
  onDeselect: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const clip = entry.clip;

  function save(changes: Partial<AudioClipRef>) {
    setError(null);
    start(async () => {
      const result = await updateAudioClipAction(projectId, clip.id, {
        startSeconds: changes.startSeconds ?? clip.startSeconds,
        inPointSeconds: changes.inPointSeconds ?? clip.inPointSeconds,
        outPointSeconds:
          changes.outPointSeconds !== undefined ? changes.outPointSeconds : clip.outPointSeconds,
        gainDb: changes.gainDb !== undefined ? changes.gainDb : clip.gainDb,
        fadeInSeconds:
          changes.fadeInSeconds !== undefined ? changes.fadeInSeconds : clip.fadeInSeconds,
        fadeOutSeconds:
          changes.fadeOutSeconds !== undefined ? changes.fadeOutSeconds : clip.fadeOutSeconds,
      });
      if (result?.error) setError(result.error);
    });
  }

  const number = (value: string): number | null => (value === "" ? null : Number(value));

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {asset?.caption ?? "Audio placement"}
          </p>
          <p className="text-xs text-muted">
            {track.name} · {ROLE_LABEL[track.role]}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onDeselect}>
          Close
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge>{formatTimecode(entry.startSeconds)}</Badge>
        {entry.usedSeconds === null ? (
          <Badge tone="accent">length not measured</Badge>
        ) : (
          <Badge>{formatDuration(entry.usedSeconds)}</Badge>
        )}
        {track.muted && <Badge tone="accent">track muted</Badge>}
        {entry.overlapsPrevious && <Badge tone="accent">overlaps the previous placement</Badge>}
      </div>

      {entry.usedSeconds === null && (
        <p className="rounded border border-accent/50 bg-accent/10 px-2 py-1.5 text-xs text-foreground">
          This file has not been decoded yet, so its length is unknown and the ruler cannot show
          where it ends. Play the sequence once and the browser will report it.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Starts at (s)">
          <Input
            type="number"
            min="0"
            step="0.1"
            defaultValue={clip.startSeconds}
            disabled={pending}
            onBlur={(e) => save({ startSeconds: Number(e.target.value) })}
          />
        </Field>
        <Field label="Level (dB)">
          <Input
            type="number"
            min="-60"
            max="12"
            step="0.5"
            placeholder="unity"
            defaultValue={clip.gainDb ?? ""}
            disabled={pending}
            onBlur={(e) => save({ gainDb: number(e.target.value) })}
          />
        </Field>
        <Field label="In point (s)">
          <Input
            type="number"
            min="0"
            step="0.1"
            defaultValue={clip.inPointSeconds}
            disabled={pending}
            onBlur={(e) => save({ inPointSeconds: Number(e.target.value) })}
          />
        </Field>
        <Field label="Out point (s)">
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="end of file"
            defaultValue={clip.outPointSeconds ?? ""}
            disabled={pending}
            onBlur={(e) => save({ outPointSeconds: number(e.target.value) })}
          />
        </Field>
        <Field label="Fade in (s)">
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="none"
            defaultValue={clip.fadeInSeconds ?? ""}
            disabled={pending}
            onBlur={(e) => save({ fadeInSeconds: number(e.target.value) })}
          />
        </Field>
        <Field label="Fade out (s)">
          <Input
            type="number"
            min="0"
            step="0.1"
            placeholder="none"
            defaultValue={clip.fadeOutSeconds ?? ""}
            disabled={pending}
            onBlur={(e) => save({ fadeOutSeconds: number(e.target.value) })}
          />
        </Field>
      </div>

      <p className="text-xs text-muted">
        An empty level is unity — no level stated. An empty fade is no ramp at all, which is not
        the same as a ramp of zero length.
      </p>

      <Field label="Notes">
        <Input
          defaultValue={clip.notes ?? ""}
          disabled={pending}
          onBlur={(e) => {
            setError(null);
            start(async () => {
              const result = await setAudioClipNotesAction(projectId, clip.id, e.target.value);
              if (result?.error) setError(result.error);
            });
          }}
        />
      </Field>

      {error && <ErrorText message={error} />}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            onDeselect();
            start(() => removeAudioClipAction(projectId, clip.id));
          }}
        >
          Remove placement
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            onDeselect();
            start(() => deleteAudioTrackAction(projectId, track.id));
          }}
        >
          Delete the whole track
        </Button>
      </div>
      <p className="text-xs text-muted">
        Removing a placement leaves the recording in the project; it can be placed again.
      </p>
    </Card>
  );
}
