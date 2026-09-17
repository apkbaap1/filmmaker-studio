"use client";

import { useActionState, useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import { createEquipmentAction, deleteEquipmentAction, updateEquipmentAction } from "@/lib/actions/equipment";
import type { FormState } from "@/lib/actions/equipment";

type EquipmentItem = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  source: "OWNED" | "RENTED" | "BORROWED";
  dailyCost: number | null;
  vendor: string | null;
  notes: string | null;
};

const SOURCE_TONE = { OWNED: "green", RENTED: "accent", BORROWED: "default" } as const;

function EquipmentFields({ defaultValues }: { defaultValues?: Partial<EquipmentItem> }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input name="name" required defaultValue={defaultValues?.name} placeholder="RED Komodo, C-stand…" />
        </Field>
        <Field label="Category">
          <Input name="category" required defaultValue={defaultValues?.category} placeholder="Camera, Lighting, Grip, Audio…" />
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Field label="Quantity">
          <Input name="quantity" type="number" min="1" defaultValue={defaultValues?.quantity ?? 1} />
        </Field>
        <Field label="Source">
          <Select name="source" defaultValue={defaultValues?.source ?? "OWNED"}>
            <option value="OWNED">Owned</option>
            <option value="RENTED">Rented</option>
            <option value="BORROWED">Borrowed</option>
          </Select>
        </Field>
        <Field label="Daily cost">
          <Input name="dailyCost" type="number" min="0" step="0.01" defaultValue={defaultValues?.dailyCost ?? ""} />
        </Field>
        <Field label="Vendor">
          <Input name="vendor" defaultValue={defaultValues?.vendor ?? ""} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea name="notes" rows={2} defaultValue={defaultValues?.notes ?? ""} />
      </Field>
    </>
  );
}

function AddEquipmentForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createEquipmentAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add equipment
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <EquipmentFields />
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

function EquipmentRow({ projectId, item }: { projectId: string; item: EquipmentItem }) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateEquipmentAction.bind(null, projectId, item.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundUpdate(prevState, formData);
    if (!result?.error) setEditing(false);
    return result;
  }, undefined);

  if (editing) {
    return (
      <Card className="p-4">
        <form action={formAction} className="space-y-3">
          <EquipmentFields defaultValues={item} />
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
          <span className="text-sm font-semibold text-foreground">
            {item.quantity > 1 ? `${item.quantity}× ` : ""}
            {item.name}
          </span>
          <Badge>{item.category}</Badge>
          <Badge tone={SOURCE_TONE[item.source]}>{item.source}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted">
          {item.dailyCost ? `$${item.dailyCost}/day` : "No cost set"}
          {item.vendor ? ` · ${item.vendor}` : ""}
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
            if (confirm("Remove this equipment item?")) deleteEquipmentAction(projectId, item.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

export function EquipmentList({ projectId, items }: { projectId: string; items: EquipmentItem[] }) {
  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <EmptyState title="No equipment yet" description="Track what you own, rent, or need to borrow." />
      )}
      {items.map((item) => (
        <EquipmentRow key={item.id} projectId={projectId} item={item} />
      ))}
      <AddEquipmentForm projectId={projectId} />
    </div>
  );
}
