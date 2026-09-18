"use client";

import { useActionState } from "react";
import { Button, ErrorText, Field, Input } from "@/components/ui";
import { createSequenceAction } from "@/lib/actions/timeline";
import type { ActionState } from "@/lib/actions/timeline";

export function CreateSequenceForm({ projectId }: { projectId: string }) {
  const bound = createSequenceAction.bind(null, projectId);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(bound, undefined);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 flex-1">
        <Field label="Edit name">
          <Input name="name" defaultValue="Main edit" required />
        </Field>
      </div>
      <ErrorText message={state?.error} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create edit"}
      </Button>
    </form>
  );
}
