"use client";

import { useActionState, useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { deleteBudgetLineItemAction, updateBudgetLineItemAction } from "@/lib/actions/budget";
import type { FormState } from "@/lib/actions/budget";

type LineItem = {
  id: string;
  description: string;
  estimated: number;
  actual: number;
  notes: string | null;
};

export function LineItemRow({ projectId, item }: { projectId: string; item: LineItem }) {
  const [editing, setEditing] = useState(false);
  const boundUpdate = updateBudgetLineItemAction.bind(null, projectId, item.id);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundUpdate(prevState, formData);
    if (!result?.error) setEditing(false);
    return result;
  }, undefined);

  if (editing) {
    return (
      <Card className="p-3">
        <form action={formAction} className="space-y-2">
          <div className="grid grid-cols-4 gap-2">
            <Field label="Description">
              <Input name="description" required defaultValue={item.description} />
            </Field>
            <Field label="Estimated">
              <Input name="estimated" type="number" min="0" step="0.01" defaultValue={item.estimated} />
            </Field>
            <Field label="Actual">
              <Input name="actual" type="number" min="0" step="0.01" defaultValue={item.actual} />
            </Field>
            <Field label="Notes">
              <Input name="notes" defaultValue={item.notes ?? ""} />
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
        </form>
      </Card>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.description}</p>
        {item.notes && <p className="truncate text-xs text-muted">{item.notes}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-4 text-sm">
        <span className="text-muted">Est ${item.estimated.toLocaleString()}</span>
        <span className="text-foreground">Actual ${item.actual.toLocaleString()}</span>
        <div className="flex gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (confirm("Remove this line item?")) deleteBudgetLineItemAction(projectId, item.id);
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
