"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import { createCastMemberAction, deleteCastMemberAction, updateCastMemberAction } from "@/lib/actions/cast-crew";
import type { FormState } from "@/lib/actions/cast-crew";

type CastMember = {
  id: string;
  characterName: string;
  actorName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: "CONSIDERING" | "OFFERED" | "CONFIRMED" | "DECLINED";
  notes: string | null;
};

const STATUS_TONE = { CONSIDERING: "default", OFFERED: "accent", CONFIRMED: "green", DECLINED: "red" } as const;

function CastFields({ defaultValues }: { defaultValues?: Partial<CastMember> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Character">
          <Input name="characterName" required defaultValue={defaultValues?.characterName} />
        </Field>
        <Field label="Actor">
          <Input name="actorName" defaultValue={defaultValues?.actorName ?? ""} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Email">
          <Input name="contactEmail" type="email" defaultValue={defaultValues?.contactEmail ?? ""} />
        </Field>
        <Field label="Phone">
          <Input name="contactPhone" defaultValue={defaultValues?.contactPhone ?? ""} />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={defaultValues?.status ?? "CONSIDERING"}>
            <option value="CONSIDERING">Considering</option>
            <option value="OFFERED">Offered</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="DECLINED">Declined</option>
          </Select>
        </Field>
      </div>
      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={defaultValues?.notes ?? ""} />
      </Field>
    </>
  );
}

function AddCastForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createCastMemberAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add cast member
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <CastFields />
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

function CastRow({ projectId, member }: { projectId: string; member: CastMember }) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateCastMemberAction.bind(null, projectId, member.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundUpdate(prevState, formData);
    if (!result?.error) setEditing(false);
    return result;
  }, undefined);

  if (editing) {
    return (
      <Card className="p-4">
        <form action={formAction} className="space-y-3">
          <CastFields defaultValues={member} />
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
          <span className="text-sm font-semibold text-foreground">{member.characterName}</span>
          <Badge tone={STATUS_TONE[member.status]}>{member.status}</Badge>
        </div>
        <p className="mt-0.5 text-sm text-muted">{member.actorName || "Uncast"}</p>
        <p className="mt-1 text-xs text-muted">
          {[member.contactPhone, member.contactEmail].filter(Boolean).join(" · ") || "No contact info"}
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
            if (confirm("Remove this cast member?")) deleteCastMemberAction(projectId, member.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function CastList({ projectId, members }: { projectId: string; members: CastMember[] }) {
  return (
    <div className="space-y-3">
      {members.map((m) => (
        <CastRow key={m.id} projectId={projectId} member={m} />
      ))}
      <AddCastForm projectId={projectId} />
    </div>
  );
}
