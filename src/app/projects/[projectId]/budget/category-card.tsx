"use client";

import { useActionState, useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { createBudgetLineItemAction, deleteBudgetCategoryAction } from "@/lib/actions/budget";
import type { FormState } from "@/lib/actions/budget";
import { LineItemRow } from "./line-item-row";

type LineItem = {
  id: string;
  description: string;
  estimated: number;
  actual: number;
  notes: string | null;
};

function AddLineItemForm({ projectId, categoryId }: { projectId: string; categoryId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createBudgetLineItemAction.bind(null, projectId, categoryId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        + Add line item
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-border p-3">
      <form action={formAction} className="space-y-2">
        <div className="grid grid-cols-4 gap-2">
          <Field label="Description">
            <Input name="description" required />
          </Field>
          <Field label="Estimated">
            <Input name="estimated" type="number" min="0" step="0.01" defaultValue={0} />
          </Field>
          <Field label="Actual">
            <Input name="actual" type="number" min="0" step="0.01" defaultValue={0} />
          </Field>
          <Field label="Notes">
            <Input name="notes" />
          </Field>
        </div>
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
    </div>
  );
}

export function CategoryCard({
  projectId,
  category,
}: {
  projectId: string;
  category: { id: string; name: string; items: LineItem[] };
}) {
  const estimatedTotal = category.items.reduce((sum, i) => sum + i.estimated, 0);
  const actualTotal = category.items.reduce((sum, i) => sum + i.actual, 0);

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{category.name}</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            Est ${estimatedTotal.toLocaleString()} · Actual ${actualTotal.toLocaleString()}
          </span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (confirm(`Delete "${category.name}" and all its line items?`)) {
                deleteBudgetCategoryAction(projectId, category.id);
              }
            }}
          >
            Delete category
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {category.items.map((item) => (
          <LineItemRow key={item.id} projectId={projectId} item={item} />
        ))}
        <AddLineItemForm projectId={projectId} categoryId={category.id} />
      </div>
    </Card>
  );
}
