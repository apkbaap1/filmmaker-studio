"use client";

import { useActionState } from "react";
import { Button, Card, ErrorText, Field, Input, Select, Textarea } from "@/components/ui";
import type { FormState } from "@/lib/actions/scenes";

export type CastMemberOption = { id: string; characterName: string; actorName: string | null };

export function SceneForm({
  action,
  defaultValues,
  submitLabel,
  castMembers,
}: {
  action: (prevState: FormState, formData: FormData) => Promise<FormState>;
  defaultValues?: {
    number?: string;
    intExt?: string;
    location?: string;
    timeOfDay?: string;
    synopsis?: string;
    scriptText?: string;
    action?: string;
    emotionalBeat?: string;
    directorNotes?: string;
    pageEights?: number;
    characterIds?: string[];
  };
  submitLabel: string;
  castMembers: CastMemberOption[];
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const selectedCharacterIds = new Set(defaultValues?.characterIds ?? []);

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

        <Field label="Characters in this scene">
          {castMembers.length === 0 ? (
            <p className="text-sm text-muted">
              No cast members yet — add them in the Cast &amp; Crew tab to assign them here.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2 rounded-md border border-border bg-surface p-3">
              {castMembers.map((c) => (
                <label
                  key={c.id}
                  className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1.5 text-sm text-foreground"
                >
                  <input
                    type="checkbox"
                    name="characterIds"
                    value={c.id}
                    defaultChecked={selectedCharacterIds.has(c.id)}
                    className="accent-accent"
                  />
                  {c.characterName}
                  {c.actorName ? ` (${c.actorName})` : ""}
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field label="Synopsis">
          <Input
            name="synopsis"
            defaultValue={defaultValues?.synopsis}
            placeholder="What happens in this scene, in one line"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Action">
            <Textarea
              name="action"
              rows={4}
              defaultValue={defaultValues?.action}
              placeholder="What characters physically do in this scene"
            />
          </Field>
          <Field label="Dialogue / script">
            <Textarea
              name="scriptText"
              rows={4}
              defaultValue={defaultValues?.scriptText}
              placeholder="Paste or write the scene's dialogue / script pages here"
              className="font-mono"
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Emotional beat">
            <Input
              name="emotionalBeat"
              defaultValue={defaultValues?.emotionalBeat}
              placeholder="Tension rising, quiet dread, release…"
            />
          </Field>
          <Field label="Director's notes">
            <Input
              name="directorNotes"
              defaultValue={defaultValues?.directorNotes}
              placeholder="Tone, pacing, references for this scene"
            />
          </Field>
        </div>

        <ErrorText message={state?.error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </form>
    </Card>
  );
}
