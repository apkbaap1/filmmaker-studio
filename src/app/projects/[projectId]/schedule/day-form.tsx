"use client";

import { useActionState } from "react";
import { Button, Card, ErrorText, Field, Input, Textarea } from "@/components/ui";
import type { FormState } from "@/lib/actions/schedule";

export function DayForm({
  action,
  defaultValues,
  submitLabel,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: {
    dayNumber?: number;
    date?: string;
    callTime?: string;
    wrapTime?: string;
    location?: string;
    weather?: string;
    notes?: string;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <Card className="p-6">
      <form action={formAction} className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Day #">
            <Input name="dayNumber" type="number" min="1" required defaultValue={defaultValues?.dayNumber} />
          </Field>
          <Field label="Date">
            <Input name="date" type="date" required defaultValue={defaultValues?.date} />
          </Field>
          <Field label="Call time">
            <Input name="callTime" defaultValue={defaultValues?.callTime} placeholder="7:00 AM" />
          </Field>
          <Field label="Wrap time">
            <Input name="wrapTime" defaultValue={defaultValues?.wrapTime} placeholder="7:00 PM" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Primary location">
            <Input name="location" defaultValue={defaultValues?.location} placeholder="Where the crew reports" />
          </Field>
          <Field label="Weather">
            <Input name="weather" defaultValue={defaultValues?.weather} placeholder="Sunny, 72°F" />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea name="notes" rows={3} defaultValue={defaultValues?.notes} placeholder="Parking, safety notes, meals…" />
        </Field>
        <ErrorText message={state?.error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </form>
    </Card>
  );
}
