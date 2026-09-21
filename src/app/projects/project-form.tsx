"use client";

import { useActionState } from "react";
import { Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import type { FormState } from "@/lib/actions/projects";

const STATUSES = ["Development", "Pre-Production", "Production", "Post-Production", "Completed"];

export function ProjectForm({
  action,
  defaultValues,
  submitLabel,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: {
    title?: string;
    logline?: string;
    description?: string;
    genre?: string;
    format?: string;
    aspectRatio?: string | null;
    resolution?: string | null;
    status?: string;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <Field label="Title">
          <Input name="title" required defaultValue={defaultValues?.title} placeholder="The film's title" />
        </Field>
        <Field label="Logline">
          <Input
            name="logline"
            defaultValue={defaultValues?.logline}
            placeholder="A one-sentence summary of the story"
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Genre">
            <Input name="genre" defaultValue={defaultValues?.genre} placeholder="Drama, Thriller…" />
          </Field>
          <Field label="Format">
            <Input name="format" defaultValue={defaultValues?.format} placeholder="Feature, Short, Series…" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Aspect ratio">
            <Input
              name="aspectRatio"
              defaultValue={defaultValues?.aspectRatio ?? ""}
              placeholder="16:9, 9:16…"
            />
          </Field>
          <Field label="Delivery resolution">
            <Input
              name="resolution"
              defaultValue={defaultValues?.resolution ?? ""}
              placeholder="720p, 1080p, 4k…"
            />
          </Field>
        </div>
        <Field label="Status">
          <Select name="status" defaultValue={defaultValues?.status ?? "Development"}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description">
          <Textarea
            name="description"
            rows={4}
            defaultValue={defaultValues?.description}
            placeholder="Notes, synopsis, or anything else worth keeping here"
          />
        </Field>
        <ErrorText message={state?.error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </form>
    </Card>
  );
}
