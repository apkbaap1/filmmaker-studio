"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import { createShotAction, deleteShotAction, updateShotAction } from "@/lib/actions/shots";
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

const TRANSITIONS = [
  "Cut",
  "Dissolve",
  "Fade In",
  "Fade Out",
  "Match Cut",
  "Smash Cut",
  "J Cut",
  "L Cut",
  "Cross Cut",
];

const STATUS_TONE = { PLANNED: "default", SHOT: "green", CUT: "red" } as const;

type Shot = {
  id: string;
  shotNumber: string;
  shotType: string;
  description: string | null;
  status: "PLANNED" | "SHOT" | "CUT";

  cameraAngle: string | null;
  cameraHeight: string | null;
  lens: string | null;
  focalLength: string | null;
  cameraMovement: string | null;
  cameraStartPosition: string | null;
  cameraEndPosition: string | null;
  movementSpeed: string | null;

  subjectMovement: string | null;
  subjectStartPosition: string | null;
  subjectEndPosition: string | null;
  characterBlocking: string | null;
  environmentalMovement: string | null;
  wardrobe: string | null;

  composition: string | null;
  finalComposition: string | null;
  framing: string | null;
  initialFraming: string | null;
  finalFraming: string | null;
  depthOfField: string | null;

  lightingNotes: string | null;
  mood: string | null;

  durationSeconds: number | null;
  dialogueAudio: string | null;
  sfx: string | null;
  soundDesignNotes: string | null;

  transition: string | null;
  editPoint: string | null;

  equipmentNotes: string | null;
  directorNotes: string | null;

  assets: AssetItem[];
};

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{children}</p>
  );
}

/** A text input with a curated dropdown of suggestions the filmmaker can still override with free text. */
function SuggestInput({
  name,
  options,
  defaultValue,
  placeholder,
}: {
  name: string;
  options: string[];
  defaultValue?: string;
  placeholder?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input name={name} list={listId} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

function ShotFields({ defaultValues }: { defaultValues?: Partial<Shot> }) {
  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Shot</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Shot #">
            <Input name="shotNumber" required defaultValue={defaultValues?.shotNumber} placeholder="1A" />
          </Field>
          <Field label="Shot type">
            <SuggestInput name="shotType" options={SHOT_TYPES} defaultValue={defaultValues?.shotType} placeholder="Wide Shot" />
          </Field>
          <Field label="Duration (seconds)">
            <Input
              name="durationSeconds"
              type="number"
              min="0"
              step="0.1"
              defaultValue={defaultValues?.durationSeconds ?? ""}
              placeholder="6"
            />
          </Field>
          <Field label="Status">
            <Select name="status" defaultValue={defaultValues?.status ?? "PLANNED"}>
              <option value="PLANNED">Planned</option>
              <option value="SHOT">Shot</option>
              <option value="CUT">Cut</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Description">
            <Input
              name="description"
              defaultValue={defaultValues?.description ?? ""}
              placeholder="What the shot shows"
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Camera</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Camera angle">
            <SuggestInput name="cameraAngle" options={CAMERA_ANGLES} defaultValue={defaultValues?.cameraAngle ?? ""} placeholder="Eye Level" />
          </Field>
          <Field label="Camera height">
            <Input name="cameraHeight" defaultValue={defaultValues?.cameraHeight ?? ""} placeholder="Chest level" />
          </Field>
          <Field label="Lens">
            <Input name="lens" defaultValue={defaultValues?.lens ?? ""} placeholder="Prime, zoom…" />
          </Field>
          <Field label="Focal length">
            <Input name="focalLength" defaultValue={defaultValues?.focalLength ?? ""} placeholder="35mm" />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Camera movement">
            <SuggestInput name="cameraMovement" options={CAMERA_MOVEMENTS} defaultValue={defaultValues?.cameraMovement ?? ""} placeholder="Static" />
          </Field>
          <Field label="Movement speed">
            <Input name="movementSpeed" defaultValue={defaultValues?.movementSpeed ?? ""} placeholder="Slow, fast…" />
          </Field>
          <Field label="Start position">
            <Input name="cameraStartPosition" defaultValue={defaultValues?.cameraStartPosition ?? ""} placeholder="Wide, by the door" />
          </Field>
          <Field label="End position">
            <Input name="cameraEndPosition" defaultValue={defaultValues?.cameraEndPosition ?? ""} placeholder="Tight on face" />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Subject &amp; blocking</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Subject movement">
            <Input
              name="subjectMovement"
              defaultValue={defaultValues?.subjectMovement ?? ""}
              placeholder="Walks toward camera and stops"
            />
          </Field>
          <Field label="Character blocking">
            <Input
              name="characterBlocking"
              defaultValue={defaultValues?.characterBlocking ?? ""}
              placeholder="Character positions relative to frame/each other"
            />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Subject start position">
            <Input
              name="subjectStartPosition"
              defaultValue={defaultValues?.subjectStartPosition ?? ""}
              placeholder="Mid-platform, back to camera"
            />
          </Field>
          <Field label="Subject end position">
            <Input
              name="subjectEndPosition"
              defaultValue={defaultValues?.subjectEndPosition ?? ""}
              placeholder="Facing camera, centre frame"
            />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Environmental movement"
            hint="Movement in the environment itself — not the camera, not the subject."
          >
            <Input
              name="environmentalMovement"
              defaultValue={defaultValues?.environmentalMovement ?? ""}
              placeholder="Light fog drifting through the station"
            />
          </Field>
          <Field
            label="Wardrobe"
            hint="Listed under PRESERVE when animating a frame, so costume stays put."
          >
            <Input
              name="wardrobe"
              defaultValue={defaultValues?.wardrobe ?? ""}
              placeholder="Charcoal overcoat, damp shoulders"
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Composition &amp; framing</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Composition (spatial placement)">
            <Input name="composition" defaultValue={defaultValues?.composition ?? ""} placeholder="Subject on the left third" />
          </Field>
          <Field label="Framing (shot scale)">
            <Input name="framing" defaultValue={defaultValues?.framing ?? ""} placeholder="Tight, loose…" />
          </Field>
          <Field label="Depth of field">
            <Input name="depthOfField" defaultValue={defaultValues?.depthOfField ?? ""} placeholder="Shallow, deep…" />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Initial framing (only if it changes)">
            <Input name="initialFraming" defaultValue={defaultValues?.initialFraming ?? ""} placeholder="Wide" />
          </Field>
          <Field label="Final framing (only if it changes)">
            <Input name="finalFraming" defaultValue={defaultValues?.finalFraming ?? ""} placeholder="Tight" />
          </Field>
          <Field label="Final composition (only if placement changes)">
            <Input
              name="finalComposition"
              defaultValue={defaultValues?.finalComposition ?? ""}
              placeholder="Leave empty to hold the composition"
            />
          </Field>
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Leave the final fields empty unless that axis actually changes — a camera move on its own
          never implies a framing or composition change.
        </p>
      </div>

      <div>
        <SectionLabel>Lighting &amp; mood</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Lighting notes">
            <Textarea
              name="lightingNotes"
              rows={2}
              defaultValue={defaultValues?.lightingNotes ?? ""}
              placeholder="Key/fill/back setup, practicals, gels, time of day light…"
            />
          </Field>
          <Field label="Mood">
            <Input name="mood" defaultValue={defaultValues?.mood ?? ""} placeholder="Suspenseful, tender, chaotic…" />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Audio</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Dialogue / audio">
            <Textarea
              name="dialogueAudio"
              rows={2}
              defaultValue={defaultValues?.dialogueAudio ?? ""}
              placeholder="Lines spoken or audio present in this shot"
            />
          </Field>
          <Field label="SFX">
            <Input name="sfx" defaultValue={defaultValues?.sfx ?? ""} placeholder="Footsteps, door creak…" />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Sound design notes">
            <Textarea
              name="soundDesignNotes"
              rows={2}
              defaultValue={defaultValues?.soundDesignNotes ?? ""}
              placeholder="Ambience, foley, music cues, dialogue capture notes…"
            />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Edit</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Transition">
            <SuggestInput name="transition" options={TRANSITIONS} defaultValue={defaultValues?.transition ?? ""} placeholder="Cut" />
          </Field>
          <Field label="Edit point">
            <Input name="editPoint" defaultValue={defaultValues?.editPoint ?? ""} placeholder="On action, on line, on look…" />
          </Field>
        </div>
      </div>

      <div>
        <SectionLabel>Notes</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Equipment notes">
            <Input
              name="equipmentNotes"
              defaultValue={defaultValues?.equipmentNotes ?? ""}
              placeholder="Gimbal, slider, drone…"
            />
          </Field>
          <Field label="Director's notes">
            <Input
              name="directorNotes"
              defaultValue={defaultValues?.directorNotes ?? ""}
              placeholder="Anything else for this shot"
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

function AddShotForm({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createShotAction.bind(null, projectId, sceneId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async (prevState, formData) => {
      const result = await boundAction(prevState, formData);
      if (!result?.error) setOpen(false);
      return result;
    },
    undefined
  );

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add shot
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3" key={open ? "open" : "closed"}>
        <ShotFields />
        <ErrorText message={state?.error} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Adding…" : "Add shot"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ShotRow({
  projectId,
  sceneId,
  shot,
  imageGenAvailable,
}: {
  projectId: string;
  sceneId: string;
  shot: Shot;
  imageGenAvailable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const boundUpdate = updateShotAction.bind(null, projectId, sceneId, shot.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async (prevState, formData) => {
      const result = await boundUpdate(prevState, formData);
      if (!result?.error) setEditing(false);
      return result;
    },
    undefined
  );

  if (editing) {
    return (
      <Card className="p-4">
        <form action={formAction} className="space-y-3">
          <ShotFields defaultValues={shot} />
          <ErrorText message={state?.error} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  const cameraLine = [
    shot.cameraAngle,
    shot.cameraHeight,
    shot.focalLength ? `${shot.focalLength} lens` : shot.lens,
    shot.cameraMovement,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Shot {shot.shotNumber}</span>
            <Badge tone="accent">{shot.shotType}</Badge>
            <Badge tone={STATUS_TONE[shot.status]}>{shot.status}</Badge>
            {shot.durationSeconds != null && <Badge>{shot.durationSeconds}s</Badge>}
          </div>
          {shot.description && <p className="mt-1.5 text-sm text-muted">{shot.description}</p>}
          {cameraLine && <p className="mt-1.5 text-xs text-muted">{cameraLine}</p>}
          {(shot.subjectMovement || shot.characterBlocking) && (
            <p className="mt-1 text-xs text-muted">
              {[shot.subjectMovement, shot.characterBlocking].filter(Boolean).join(" · ")}
            </p>
          )}
          {(shot.composition || shot.framing || shot.depthOfField) && (
            <p className="mt-1 text-xs text-muted">
              {[shot.composition, shot.framing, shot.depthOfField].filter(Boolean).join(" · ")}
            </p>
          )}
          {(shot.lightingNotes || shot.mood) && (
            <div className="mt-2 space-y-1 text-xs text-muted">
              {shot.mood && (
                <p>
                  <span className="font-medium text-foreground">Mood:</span> {shot.mood}
                </p>
              )}
              {shot.lightingNotes && (
                <p>
                  <span className="font-medium text-foreground">Lighting:</span> {shot.lightingNotes}
                </p>
              )}
            </div>
          )}
          {(shot.dialogueAudio || shot.sfx || shot.soundDesignNotes) && (
            <div className="mt-2 space-y-1 text-xs text-muted">
              {shot.dialogueAudio && (
                <p>
                  <span className="font-medium text-foreground">Dialogue/audio:</span> {shot.dialogueAudio}
                </p>
              )}
              {shot.sfx && (
                <p>
                  <span className="font-medium text-foreground">SFX:</span> {shot.sfx}
                </p>
              )}
              {shot.soundDesignNotes && (
                <p>
                  <span className="font-medium text-foreground">Sound design:</span> {shot.soundDesignNotes}
                </p>
              )}
            </div>
          )}
          {(shot.transition || shot.editPoint) && (
            <p className="mt-1 text-xs text-muted">
              {[shot.transition && `Transition: ${shot.transition}`, shot.editPoint && `Edit point: ${shot.editPoint}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {shot.directorNotes && (
            <p className="mt-1 text-xs italic text-muted">&ldquo;{shot.directorNotes}&rdquo;</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href={`/projects/${projectId}/scenes/${sceneId}/shots/${shot.id}`}>
            <Button variant="secondary" size="sm">
              Design
            </Button>
          </Link>
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (confirm("Delete this shot?")) {
                deleteShotAction(projectId, sceneId, shot.id);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-3 border-t border-border/60 pt-3">
        <Button variant="ghost" size="sm" onClick={() => setShowRefs((v) => !v)}>
          {showRefs ? "Hide" : "Show"} references ({shot.assets.length})
        </Button>
        {showRefs && (
          <div className="mt-2">
            <AssetGallery
              projectId={projectId}
              scope={{ sceneId, shotId: shot.id }}
              assets={shot.assets}
              imageGenAvailable={imageGenAvailable}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

export function ShotList({
  projectId,
  sceneId,
  shots,
  imageGenAvailable,
}: {
  projectId: string;
  sceneId: string;
  shots: Shot[];
  imageGenAvailable: boolean;
}) {
  return (
    <div className="space-y-3">
      {shots.map((shot) => (
        <ShotRow
          key={shot.id}
          projectId={projectId}
          sceneId={sceneId}
          shot={shot}
          imageGenAvailable={imageGenAvailable}
        />
      ))}
      <AddShotForm projectId={projectId} sceneId={sceneId} />
    </div>
  );
}
