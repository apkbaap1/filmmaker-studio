"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { createShotAction, deleteShotAction, updateShotAction } from "@/lib/actions/shots";
import type { FormState } from "@/lib/actions/shots";

type Shot = {
  id: string;
  shotNumber: string;
  shotType: string;
  description: string | null;
  cameraMovement: string | null;
  lens: string | null;
  equipmentNotes: string | null;
  status: "PLANNED" | "SHOT" | "CUT";
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
      <div className="grid grid-cols-2 gap-3">
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

function ShotRow({ projectId, sceneId, shot }: { projectId: string; sceneId: string; shot: Shot }) {
  const [editing, setEditing] = useState(false);
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
    <Card className="flex items-start justify-between gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Shot {shot.shotNumber}</span>
          <Badge tone="accent">{shot.shotType}</Badge>
          <Badge tone={STATUS_TONE[shot.status]}>{shot.status}</Badge>
        </div>
        {shot.description && <p className="mt-1.5 text-sm text-muted">{shot.description}</p>}
        <div className="mt-1.5 flex flex-wrap gap-3 text-xs text-muted">
          {shot.cameraMovement && <span>Movement: {shot.cameraMovement}</span>}
          {shot.lens && <span>Lens: {shot.lens}</span>}
          {shot.equipmentNotes && <span>Equipment: {shot.equipmentNotes}</span>}
        </div>
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
    </Card>
  );
}

export function ShotList({
  projectId,
  sceneId,
  shots,
}: {
  projectId: string;
  sceneId: string;
  shots: Shot[];
}) {
  return (
    <div className="space-y-3">
      {shots.map((shot) => (
        <ShotRow key={shot.id} projectId={projectId} sceneId={sceneId} shot={shot} />
      ))}
      <AddShotForm projectId={projectId} sceneId={sceneId} />
    </div>
  );
}
