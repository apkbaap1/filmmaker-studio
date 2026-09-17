"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Textarea } from "@/components/ui";
import { createCrewMemberAction, deleteCrewMemberAction, updateCrewMemberAction } from "@/lib/actions/cast-crew";
import type { FormState } from "@/lib/actions/cast-crew";

type CrewMember = {
  id: string;
  name: string;
  department: string;
  position: string;
  contactEmail: string | null;
  contactPhone: string | null;
  dayRate: number | null;
  notes: string | null;
};

function CrewFields({ defaultValues }: { defaultValues?: Partial<CrewMember> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input name="name" required defaultValue={defaultValues?.name} />
        </Field>
        <Field label="Department">
          <Input name="department" required defaultValue={defaultValues?.department} placeholder="Camera, Sound, Art…" />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Position">
          <Input name="position" required defaultValue={defaultValues?.position} placeholder="1st AC, Gaffer…" />
        </Field>
        <Field label="Day rate">
          <Input name="dayRate" type="number" min="0" step="0.01" defaultValue={defaultValues?.dayRate ?? ""} />
        </Field>
        <Field label="Phone">
          <Input name="contactPhone" defaultValue={defaultValues?.contactPhone ?? ""} />
        </Field>
      </div>
      <Field label="Email">
        <Input name="contactEmail" type="email" defaultValue={defaultValues?.contactEmail ?? ""} />
      </Field>
      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={defaultValues?.notes ?? ""} />
      </Field>
    </>
  );
}

function AddCrewForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createCrewMemberAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add crew member
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <CrewFields />
        <ErrorText message={state?.error} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Adding…" : "Add"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function CrewRow({ projectId, member }: { projectId: string; member: CrewMember }) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateCrewMemberAction.bind(null, projectId, member.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundUpdate(prevState, formData);
    if (!result?.error) setEditing(false);
    return result;
  }, undefined);

  if (editing) {
    return (
      <Card className="p-4">
        <form action={formAction} className="space-y-3">
          <CrewFields defaultValues={member} />
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
          <span className="text-sm font-semibold text-foreground">{member.name}</span>
          <Badge tone="accent">{member.department}</Badge>
          <Badge>{member.position}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted">
          {[member.contactPhone, member.contactEmail].filter(Boolean).join(" · ") || "No contact info"}
          {member.dayRate ? ` · $${member.dayRate}/day` : ""}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (confirm("Remove this crew member?")) deleteCrewMemberAction(projectId, member.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function CrewList({ projectId, members }: { projectId: string; members: CrewMember[] }) {
  return (
    <div className="space-y-3">
      {members.map((m) => (
        <CrewRow key={m.id} projectId={projectId} member={m} />
      ))}
      <AddCrewForm projectId={projectId} />
    </div>
  );
}
