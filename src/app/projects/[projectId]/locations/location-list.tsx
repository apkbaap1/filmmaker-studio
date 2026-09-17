"use client";

import { useActionState, useState } from "react";
import { Button, Card, EmptyState, ErrorText, Field, Input, Textarea } from "@/components/ui";
import { createLocationAction, deleteLocationAction, updateLocationAction } from "@/lib/actions/locations";
import type { FormState } from "@/lib/actions/locations";

type LocationItem = {
  id: string;
  name: string;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  permitStatus: string | null;
  notes: string | null;
};

function LocationFields({ defaultValues }: { defaultValues?: Partial<LocationItem> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input name="name" required defaultValue={defaultValues?.name} />
        </Field>
        <Field label="Permit status">
          <Input name="permitStatus" defaultValue={defaultValues?.permitStatus ?? ""} placeholder="Not needed, Pending, Approved…" />
        </Field>
      </div>
      <Field label="Address">
        <Input name="address" defaultValue={defaultValues?.address ?? ""} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact name">
          <Input name="contactName" defaultValue={defaultValues?.contactName ?? ""} />
        </Field>
        <Field label="Contact phone">
          <Input name="contactPhone" defaultValue={defaultValues?.contactPhone ?? ""} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={defaultValues?.notes ?? ""} placeholder="Parking, access, power, restrictions…" />
      </Field>
    </>
  );
}

function AddLocationForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createLocationAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add location
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <LocationFields />
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

function LocationRow({ projectId, location }: { projectId: string; location: LocationItem }) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateLocationAction.bind(null, projectId, location.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundUpdate(prevState, formData);
    if (!result?.error) setEditing(false);
    return result;
  }, undefined);

  if (editing) {
    return (
      <Card className="p-4">
        <form action={formAction} className="space-y-3">
          <LocationFields defaultValues={location} />
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
        <p className="text-sm font-semibold text-foreground">{location.name}</p>
        {location.address && <p className="mt-0.5 text-sm text-muted">{location.address}</p>}
        <p className="mt-1 text-xs text-muted">
          {location.permitStatus ? `Permit: ${location.permitStatus} · ` : ""}
          {[location.contactName, location.contactPhone].filter(Boolean).join(" · ") || "No contact set"}
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
            if (confirm("Remove this location?")) deleteLocationAction(projectId, location.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function LocationList({ projectId, locations }: { projectId: string; locations: LocationItem[] }) {
  return (
    <div className="space-y-3">
      {locations.length === 0 && (
        <EmptyState title="No locations yet" description="Add scouting notes and permit status for each location." />
      )}
      {locations.map((l) => (
        <LocationRow key={l.id} projectId={projectId} location={l} />
      ))}
      <AddLocationForm projectId={projectId} />
    </div>
  );
}
