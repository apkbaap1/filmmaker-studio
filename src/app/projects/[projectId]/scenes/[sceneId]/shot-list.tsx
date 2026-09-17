"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import { createShotAction, deleteShotAction, updateShotAction } from "@/lib/actions/shots";
import type { FormState } from "@/lib/actions/shots";
import { AssetGallery, type AssetItem } from "@/components/asset-gallery";

type CameraAngle =
  | "EYE_LEVEL"
  | "LOW_ANGLE"
  | "HIGH_ANGLE"
  | "DUTCH_ANGLE"
  | "BIRDS_EYE"
  | "WORMS_EYE"
  | "OVER_THE_SHOULDER"
  | "POV";

const CAMERA_ANGLE_LABEL: Record<CameraAngle, string> = {
  EYE_LEVEL: "Eye level",
  LOW_ANGLE: "Low angle",
  HIGH_ANGLE: "High angle",
  DUTCH_ANGLE: "Dutch angle",
  BIRDS_EYE: "Bird's eye",
  WORMS_EYE: "Worm's eye",
  OVER_THE_SHOULDER: "Over-the-shoulder",
  POV: "POV",
};

type Shot = {
  id: string;
  shotNumber: string;
  shotType: string;
  description: string | null;
  cameraMovement: string | null;
  lens: string | null;
  equipmentNotes: string | null;
  status: "PLANNED" | "SHOT" | "CUT";
  cameraAngle: CameraAngle | null;
  lightingNotes: string | null;
  soundDesignNotes: string | null;
  assets: AssetItem[];
};

const STATUS_TONE = { PLANNED: "default", SHOT: "green", CUT: "red" } as const;

function ShotFields({ defaultValues }: { defaultValues?: Partial<Shot> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Shot #">
          <Input name="shotNumber" required defaultValue={defaultValues?.shotNumber} placeholder="1A" />
        </Field>
        <Field label="Shot type">
          <Input
            name="shotType"
            required
            defaultValue={defaultValues?.shotType}
            placeholder="Wide, Close-up, OTS…"
          />
        </Field>
        <Field label="Camera movement">
          <Input name="cameraMovement" defaultValue={defaultValues?.cameraMovement ?? ""} placeholder="Static, Dolly…" />
        </Field>
        <Field label="Lens">
          <Input name="lens" defaultValue={defaultValues?.lens ?? ""} placeholder="35mm" />
        </Field>
      </div>
      <Field label="Description">
        <Input
          name="description"
          defaultValue={defaultValues?.description ?? ""}
          placeholder="What the shot shows"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Camera angle">
          <Select name="cameraAngle" defaultValue={defaultValues?.cameraAngle ?? ""}>
            <option value="">Not set</option>
            {Object.entries(CAMERA_ANGLE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Equipment notes">
          <Input
            name="equipmentNotes"
            defaultValue={defaultValues?.equipmentNotes ?? ""}
            placeholder="Gimbal, slider, drone…"
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lighting notes">
          <Textarea
            name="lightingNotes"
            rows={2}
            defaultValue={defaultValues?.lightingNotes ?? ""}
            placeholder="Key/fill/back setup, practicals, gels, time of day light…"
          />
        </Field>
        <Field label="Sound design notes">
          <Textarea
            name="soundDesignNotes"
            rows={2}
            defaultValue={defaultValues?.soundDesignNotes ?? ""}
            placeholder="Ambience, foley, music cues, dialogue capture notes…"
          />
        </Field>
      </div>
    </>
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

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Shot {shot.shotNumber}</span>
            <Badge tone="accent">{shot.shotType}</Badge>
            <Badge tone={STATUS_TONE[shot.status]}>{shot.status}</Badge>
            {shot.cameraAngle && <Badge>{CAMERA_ANGLE_LABEL[shot.cameraAngle]}</Badge>}
          </div>
          {shot.description && <p className="mt-1.5 text-sm text-muted">{shot.description}</p>}
          <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted">
            {shot.cameraMovement && <span>Movement: {shot.cameraMovement}</span>}
            {shot.lens && <span>Lens: {shot.lens}</span>}
            {shot.equipmentNotes && <span>Equipment: {shot.equipmentNotes}</span>}
          </div>
          {(shot.lightingNotes || shot.soundDesignNotes) && (
            <div className="mt-2 space-y-1 text-xs text-muted">
              {shot.lightingNotes && (
                <p>
                  <span className="font-medium text-foreground">Lighting:</span> {shot.lightingNotes}
                </p>
              )}
              {shot.soundDesignNotes && (
                <p>
                  <span className="font-medium text-foreground">Sound:</span> {shot.soundDesignNotes}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
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
