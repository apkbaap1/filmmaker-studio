"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import {
  describeTransitionEffect,
  formatDuration,
  formatTimecode,
  TRANSITION_TIMING,
  type LaidOutClip,
} from "@/lib/timeline";
import {
  removeClipAction,
  selectClipAssetAction,
  setClipNotesAction,
  setClipTransitionAction,
  splitClipAction,
  trimClipAction,
} from "@/lib/actions/timeline";
import type { AssetRef, ClipRef, SceneRef, ShotRef, TransitionValue } from "./types";

const TRANSITIONS: Array<{ value: TransitionValue; label: string }> = [
  { value: "CUT", label: "Cut" },
  { value: "DISSOLVE", label: "Dissolve" },
  { value: "FADE", label: "Fade" },
  { value: "MATCH_CUT", label: "Match cut" },
  { value: "J_CUT", label: "J-cut" },
  { value: "L_CUT", label: "L-cut" },
];

export const TRANSITION_LABEL: Record<TransitionValue, string> = Object.fromEntries(
  TRANSITIONS.map((t) => [t.value, t.label])
) as Record<TransitionValue, string>;

function assetLabel(asset: AssetRef): string {
  const kind = asset.mimeType.startsWith("video/") ? "Video" : "Image";
  const origin = asset.source === "GENERATED" ? "generated" : "uploaded";
  const size = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : "";
  const length = asset.durationSeconds ? ` · ${formatDuration(asset.durationSeconds)}` : "";
  return `${kind} (${origin})${length}${size}`;
}

/**
 * The selected clip's details and edit controls.
 *
 * Everything here writes the *placement*. The shot's own fields are shown
 * read-only with a link back to the Shot Builder, including its stated edit
 * intent — which can be copied into the clip's transition with a button, but is
 * never applied on its own.
 */
export function ClipInspector({
  projectId,
  entry,
  shot,
  scene,
  playheadSeconds,
  onDeselect,
}: {
  projectId: string;
  entry: LaidOutClip<ClipRef>;
  shot: ShotRef | undefined;
  scene: SceneRef | undefined;
  playheadSeconds: number;
  onDeselect: () => void;
}) {
  const { clip, source, usedSeconds, startSeconds, endSeconds, trimmed } = entry;
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState(clip.notes ?? "");

  const run = (fn: () => Promise<{ error?: string } | undefined>) => {
    setError(undefined);
    startTransition(async () => {
      const result = await fn();
      if (result?.error) setError(result.error);
    });
  };

  const offsetIntoClip = playheadSeconds - startSeconds;
  const canSplit = offsetIntoClip > 0 && offsetIntoClip < usedSeconds;

  if (!shot) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted">This clip&rsquo;s shot is no longer in the project.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-sm font-semibold text-foreground">SHOT {shot.shotNumber}</p>
          <p className="text-sm text-foreground">{shot.shotType}</p>
          {scene && (
            <p className="mt-0.5 text-xs text-muted">
              Scene {scene.number} — {scene.slugline}
            </p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onDeselect}>
          Close
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[shot.cameraAngle, shot.cameraHeight, shot.cameraMovement, shot.movementSpeed]
          .filter(Boolean)
          .map((v) => (
            <Badge key={v as string}>{v}</Badge>
          ))}
        {(shot.focalLength || shot.lens) && (
          <Badge>{[shot.focalLength, shot.lens].filter(Boolean).join(" ")}</Badge>
        )}
      </div>

      {/* --- timing ------------------------------------------------------- */}
      <div className="rounded-md bg-surface-2 p-3 text-xs">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted">Source</span>
          <span className="text-foreground">
            {formatDuration(source.seconds)}{" "}
            <span className="text-muted">
              (
              {source.from === "asset"
                ? "measured from the clip"
                : source.from === "shot"
                  ? "shot's intended duration"
                  : "placeholder — no duration stated"}
              )
            </span>
          </span>
          <span className="text-muted">Used in this edit</span>
          <span className="text-foreground">
            {formatDuration(usedSeconds)} {trimmed && <span className="text-accent">trimmed</span>}
          </span>
          <span className="text-muted">Starts / ends</span>
          <span className="font-mono text-foreground">
            {formatTimecode(startSeconds)} → {formatTimecode(endSeconds)}
          </span>
        </div>
        {shot.durationSeconds != null && source.from === "asset" && (
          <p className="mt-2 text-muted">
            The Shot Builder specifies {formatDuration(shot.durationSeconds)}; the generated clip
            measures {formatDuration(source.seconds)}. Both are kept as they are.
          </p>
        )}
      </div>

      {/* --- trim ---------------------------------------------------------- */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Trim (this edit only)
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const out = String(form.get("out") ?? "").trim();
            run(() =>
              trimClipAction(projectId, clip.id, {
                inPointSeconds: Number(form.get("in") ?? 0),
                outPointSeconds: out === "" ? null : Number(out),
              })
            );
          }}
        >
          <div className="w-28">
            <Field label="In (s)">
              <Input name="in" type="number" min="0" step="0.1" defaultValue={clip.inPointSeconds} />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Out (s)">
              <Input
                name="out"
                type="number"
                min="0"
                step="0.1"
                placeholder="end"
                defaultValue={clip.outPointSeconds ?? ""}
              />
            </Field>
          </div>
          <Button type="submit" size="sm" variant="secondary" disabled={pending}>
            Apply trim
          </Button>
          {trimmed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                run(() => trimClipAction(projectId, clip.id, { inPointSeconds: 0, outPointSeconds: null }))
              }
            >
              Use whole shot
            </Button>
          )}
        </form>
        <p className="mt-1 text-xs text-muted">
          Trimming changes how much of the shot this edit plays. It does not change the shot.
        </p>
      </div>

      {/* --- transition ---------------------------------------------------- */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Edit point at this clip&rsquo;s head
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Select
              value={clip.transition ?? ""}
              disabled={pending}
              onChange={(e) =>
                run(() =>
                  setClipTransitionAction(
                    projectId,
                    clip.id,
                    e.target.value === "" ? null : e.target.value,
                    clip.transitionDurationSeconds
                  )
                )
              }
            >
              <option value="">Not specified</option>
              {TRANSITIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          {clip.transition && TRANSITION_TIMING[clip.transition] !== "instant" && (
            <div className="w-28">
              <Field label={TRANSITION_TIMING[clip.transition] === "audio-only" ? "Offset (s)" : "Length (s)"}>
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={clip.transitionDurationSeconds ?? ""}
                  disabled={pending}
                  onBlur={(e) =>
                    run(() =>
                      setClipTransitionAction(
                        projectId,
                        clip.id,
                        clip.transition,
                        e.target.value === "" ? null : Number(e.target.value)
                      )
                    )
                  }
                />
              </Field>
            </div>
          )}
        </div>
        {entry.transition ? (
          <p
            className={[
              "mt-2 rounded border px-2 py-1.5 text-xs",
              entry.transition.note === null
                ? "border-border bg-surface-2 text-foreground"
                : "border-accent/50 bg-accent/10 text-foreground",
            ].join(" ")}
          >
            {describeTransitionEffect(entry.transition)}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">
            &ldquo;Not specified&rdquo; renders as a plain boundary. Nothing is inferred from the
            shots on either side.
          </p>
        )}
        {shot.transitionNote && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Shot Builder note: &ldquo;{shot.transitionNote}&rdquo;</span>
            {TRANSITIONS.some(
              (t) => t.label.toLowerCase() === shot.transitionNote?.trim().toLowerCase()
            ) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  const match = TRANSITIONS.find(
                    (t) => t.label.toLowerCase() === shot.transitionNote?.trim().toLowerCase()
                  );
                  if (match) {
                    run(() =>
                      setClipTransitionAction(projectId, clip.id, match.value, clip.transitionDurationSeconds)
                    );
                  }
                }}
              >
                Use it here
              </Button>
            )}
          </div>
        )}
        {shot.editPoint && <p className="mt-1 text-xs text-muted">Edit point: {shot.editPoint}</p>}
      </div>

      {/* --- which asset represents the shot -------------------------------- */}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Asset in this edit
        </p>
        {shot.assets.length === 0 ? (
          <p className="text-xs text-muted">
            Nothing generated or uploaded for this shot yet — the player shows a slate.
          </p>
        ) : (
          <Select
            value={clip.selectedAssetId ?? ""}
            disabled={pending}
            onChange={(e) =>
              run(() =>
                selectClipAssetAction(projectId, clip.id, e.target.value === "" ? null : e.target.value)
              )
            }
          >
            <option value="">Newest video, else storyboard frame</option>
            {shot.assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {assetLabel(asset)}
              </option>
            ))}
          </Select>
        )}
        <p className="mt-1 text-xs text-muted">
          {shot.generations.total} generation{shot.generations.total === 1 ? "" : "s"} for this shot
          {shot.generations.processing > 0 && ` · ${shot.generations.processing} running`}
          {shot.generations.failed > 0 && ` · ${shot.generations.failed} failed`}. Choosing one here
          never removes the others.
        </p>
      </div>

      {/* --- notes ---------------------------------------------------------- */}
      <div>
        <Field label="Edit note">
          <Textarea
            rows={2}
            value={notes}
            disabled={pending}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => run(() => setClipNotesAction(projectId, clip.id, notes))}
            placeholder="Why this cut sits here"
          />
        </Field>
      </div>

      <ErrorText message={error} />

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Link href={`/projects/${projectId}/scenes/${shot.sceneId}/shots/${shot.id}`}>
          <Button size="sm" variant="secondary">
            Open shot design
          </Button>
        </Link>
        <Link href={`/projects/${projectId}/scenes/${shot.sceneId}`}>
          <Button size="sm" variant="secondary">
            Open in Shot Builder
          </Button>
        </Link>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !canSplit}
          title={canSplit ? undefined : "Move the playhead inside this clip to split it"}
          onClick={() => run(() => splitClipAction(projectId, clip.id, offsetIntoClip, source.seconds))}
        >
          Split at playhead
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() => {
            if (!confirm("Remove this clip from the edit? The shot itself is kept.")) return;
            startTransition(async () => {
              await removeClipAction(projectId, clip.id);
              onDeselect();
            });
          }}
        >
          Remove from edit
        </Button>
      </div>
    </Card>
  );
}
