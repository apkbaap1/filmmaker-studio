"use client";

import { useActionState } from "react";
import { Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import type { FormState } from "@/lib/actions/scenes";

export function SceneForm({
  action,
  defaultValues,
  submitLabel,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: {
    number?: string;
    intExt?: string;
    location?: string;
    timeOfDay?: string;
    synopsis?: string;
    scriptText?: string;
    pageEights?: number;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Scene #">
            <Input name="number" required defaultValue={defaultValues?.number} placeholder="1" />
          </Field>
          <Field label="Int / Ext">
            <Select name="intExt" defaultValue={defaultValues?.intExt ?? "INT"}>
              <option value="INT">INT</option>
              <option value="EXT">EXT</option>
              <option value="INT_EXT">INT/EXT</option>
            </Select>
          </Field>
          <Field label="Time of day">
            <Select name="timeOfDay" defaultValue={defaultValues?.timeOfDay ?? "DAY"}>
              <option value="DAY">DAY</option>
              <option value="NIGHT">NIGHT</option>
              <option value="DAWN">DAWN</option>
              <option value="DUSK">DUSK</option>
            </Select>
          </Field>
          <Field label="Page eighths">
            <Input
              name="pageEights"
              type="number"
              step="0.125"
              min="0"
              defaultValue={defaultValues?.pageEights ?? 1}
            />
          </Field>
        </div>
        <Field label="Location">
          <Input
            name="location"
            required
            defaultValue={defaultValues?.location}
            placeholder="COFFEE SHOP, KITCHEN, PARKING LOT…"
          />
        </Field>
        <Field label="Synopsis">
          <Input
            name="synopsis"
            defaultValue={defaultValues?.synopsis}
            placeholder="What happens in this scene, in one line"
          />
        </Field>
        <Field label="Script text">
          <Textarea
            name="scriptText"
            rows={8}
            defaultValue={defaultValues?.scriptText}
            placeholder="Paste or write the scene's script pages here"
            className="font-mono"
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
