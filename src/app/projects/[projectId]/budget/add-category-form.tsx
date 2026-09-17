"use client";

import { useActionState, useState } from "react";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { createBudgetCategoryAction } from "@/lib/actions/budget";
import type { FormState } from "@/lib/actions/budget";

export function AddCategoryForm({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createBudgetCategoryAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add category
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="Category name">
            <Input name="name" required placeholder="Camera, Locations, Post-Production…" autoFocus />
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </form>
      <ErrorText message={state?.error} />
    </Card>
  );
}
