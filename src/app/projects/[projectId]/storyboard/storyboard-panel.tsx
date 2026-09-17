"use client";

import { useActionState, useId, useState, type DragEvent } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Textarea } from "@/components/ui";
import {
  deleteShotAction,
  duplicateShotAction,
  updateShotStoryboardFieldsAction,
} from "@/lib/actions/shots";
import type { FormState } from "@/lib/actions/shots";
import { AssetGallery, type AssetItem } from "@/components/asset-gallery";

const SHOT_TYPES = [
  "Extreme Wide Shot",
  "Wide Shot",
  "Full Shot",
  "Medium Wide",
  "Medium Shot",
  "Medium Close-Up",
  "Close-Up",
  "Extreme Close-Up",
  "Two Shot",
  "Over-the-Shoulder",
  "POV",
  "Insert",
  "Cutaway",
  "Establishing Shot",
];

const CAMERA_ANGLES = [
  "Eye Level",
  "Low Angle",
  "High Angle",
  "Dutch Angle",
  "Bird's Eye",
  "Worm's Eye",
  "Overhead",
  "Profile",
  "Three-quarter",
  "Front",
  "Rear",
];

const CAMERA_MOVEMENTS = [
  "Static",
  "Pan",
  "Tilt",
  "Dolly In",
  "Dolly Out",
  "Tracking",
  "Truck Left",
  "Truck Right",
  "Crane Up",
  "Crane Down",
  "Pedestal",
  "Orbit",
  "Arc",
  "Push In",
  "Pull Out",
  "Handheld",
  "Steadicam",
  "Gimbal",
  "Drone",
  "Whip Pan",
  "Rack Focus",
];

const TRANSITIONS = ["Cut", "Dissolve", "Fade In", "Fade Out", "Match Cut", "Smash Cut", "J Cut", "L Cut", "Cross Cut"];

export type StoryboardShot = {
  id: string;
  shotNumber: string;
  shotType: string;
  cameraAngle: string | null;
  cameraMovement: string | null;
  lens: string | null;
  durationSeconds: number | null;
  dialogueAudio: string | null;
  soundDesignNotes: string | null;
  transition: string | null;
  directorNotes: string | null;
  assets: AssetItem[];
};

function SuggestInput({
  name,
  options,
  defaultValue,
  required,
  placeholder,
}: {
  name: string;
  options: string[];
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input name={name} list={listId} required={required} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

function coverImage(assets: AssetItem[]): AssetItem | undefined {
  return assets.find((a) => a.mimeType.startsWith("image/"));
}

export function StoryboardPanel({
  projectId,
  sceneId,
  shot,
  index,
  imageGenAvailable,
  onDragStart,
  onDragOver,
  onDrop,
  isDragging,
}: {
  projectId: string;
  sceneId: string;
  shot: StoryboardShot;
  index: number;
  imageGenAvailable: boolean;
  onDragStart: (index: number) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (index: number) => void;
  isDragging: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const [videoNote, setVideoNote] = useState(false);

  const boundUpdate = updateShotStoryboardFieldsAction.bind(null, projectId, sceneId, shot.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async (prevState, formData) => {
      const result = await boundUpdate(prevState, formData);
      if (!result?.error) setEditing(false);
      return result;
    },
    undefined
  );

  const cover = coverImage(shot.assets);

  return (
    <Card
      className={`overflow-hidden ${isDragging ? "opacity-40" : ""}`}
      draggable={!editing}
      onDragStart={() => onDragStart(index)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(index)}
    >
      <div className="relative flex aspect-video items-center justify-center border-b border-border bg-surface-2">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/assets/${cover.id}/file`} alt={cover.caption ?? `Shot ${shot.shotNumber}`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-muted">
            <span className="text-2xl">🎬</span>
            <span className="text-xs">No frame yet</span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-xs font-semibold text-white">
          {shot.shotNumber}
        </span>
        {shot.durationSeconds != null && (
          <span className="absolute right-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-xs text-white">
            {shot.durationSeconds}s
          </span>
        )}
        {shot.transition && (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white">
            {shot.transition} →
          </span>
        )}
      </div>

      <div className="p-3">
        {editing ? (
          <form action={formAction} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Shot #">
                <Input name="shotNumber" required defaultValue={shot.shotNumber} />
              </Field>
              <Field label="Shot size">
                <SuggestInput name="shotType" options={SHOT_TYPES} defaultValue={shot.shotType} required />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Camera angle">
                <SuggestInput name="cameraAngle" options={CAMERA_ANGLES} defaultValue={shot.cameraAngle ?? ""} />
              </Field>
              <Field label="Camera movement">
                <SuggestInput name="cameraMovement" options={CAMERA_MOVEMENTS} defaultValue={shot.cameraMovement ?? ""} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Lens">
                <Input name="lens" defaultValue={shot.lens ?? ""} placeholder="35mm" />
              </Field>
              <Field label="Duration (s)">
                <Input name="durationSeconds" type="number" min="0" step="0.1" defaultValue={shot.durationSeconds ?? ""} />
              </Field>
            </div>
            <Field label="Dialogue / audio">
              <Textarea name="dialogueAudio" rows={2} defaultValue={shot.dialogueAudio ?? ""} />
            </Field>
            <Field label="Sound">
              <Textarea name="soundDesignNotes" rows={2} defaultValue={shot.soundDesignNotes ?? ""} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Transition">
                <SuggestInput name="transition" options={TRANSITIONS} defaultValue={shot.transition ?? ""} />
              </Field>
              <Field label="Director's note">
                <Input name="directorNotes" defaultValue={shot.directorNotes ?? ""} />
              </Field>
            </div>
            <ErrorText message={state?.error} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-[11px] text-muted">
              For camera height, focal length, composition, blocking, and other detailed fields, use the Shot
              Builder on the scene page.
            </p>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="accent">{shot.shotType}</Badge>
              {shot.cameraAngle && <Badge>{shot.cameraAngle}</Badge>}
              {shot.cameraMovement && <Badge>{shot.cameraMovement}</Badge>}
            </div>
            {shot.lens && <p className="mt-1.5 text-xs text-muted">Lens: {shot.lens}</p>}
            {shot.dialogueAudio && (
              <p className="mt-1.5 text-xs text-muted">
                <span className="font-medium text-foreground">Dialogue:</span> {shot.dialogueAudio}
              </p>
            )}
            {shot.soundDesignNotes && (
              <p className="mt-1 text-xs text-muted">
                <span className="font-medium text-foreground">Sound:</span> {shot.soundDesignNotes}
              </p>
            )}
            {shot.directorNotes && (
              <p className="mt-1.5 text-xs italic text-muted">&ldquo;{shot.directorNotes}&rdquo;</p>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (confirm(`Duplicate shot ${shot.shotNumber}?`)) {
                    duplicateShotAction(projectId, sceneId, shot.id);
                  }
                }}
              >
                Duplicate
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  if (confirm(`Delete shot ${shot.shotNumber}?`)) {
                    deleteShotAction(projectId, sceneId, shot.id);
                  }
                }}
              >
                Delete
              </Button>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setShowAssets((v) => !v)}>
                {showAssets ? "Hide" : "Manage"} visuals ({shot.assets.length})
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setVideoNote((v) => !v)}>
                Generate video
              </Button>
            </div>
            {videoNote && (
              <p className="mt-1 text-[11px] text-muted">
                Video previsualization isn&apos;t wired up yet — planned for Phase 5, once a video provider is
                chosen.
              </p>
            )}
            {showAssets && (
              <div className="mt-2">
                <AssetGallery
                  projectId={projectId}
                  scope={{ sceneId, shotId: shot.id }}
                  assets={shot.assets}
                  imageGenAvailable={imageGenAvailable}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
