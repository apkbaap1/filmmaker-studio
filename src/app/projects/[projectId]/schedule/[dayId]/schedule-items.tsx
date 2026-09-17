"use client";

import { useActionState, useState } from "react";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";
import { createScheduleItemAction, deleteScheduleItemAction } from "@/lib/actions/schedule";
import type { FormState } from "@/lib/actions/schedule";

type SceneOption = { id: string; number: string; location: string; intExt: string };

type ScheduleItem = {
  id: string;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  scene: { id: string; number: string; location: string; intExt: string } | null;
};

function AddItemForm({
  projectId,
  dayId,
  scenes,
}: {
  projectId: string;
  dayId: string;
  scenes: SceneOption[];
}) {
  const [open, setOpen] = useState(false);
  const boundAction = createScheduleItemAction.bind(null, projectId, dayId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async (prevState, formData) => {
      const result = await boundAction(prevState, formData);
      if (!result?.error) setOpen(false);
      return result;
    },
    undefined
  );

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        + Add scene to this day
      </Button>
    );
  }

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Scene">
            <Select name="sceneId" required defaultValue="">
              <option value="" disabled>
                Choose a scene
              </option>
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.number} — {s.intExt}. {s.location}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start time">
            <Input name="startTime" placeholder="9:00 AM" />
          </Field>
          <Field label="End time">
            <Input name="endTime" placeholder="11:00 AM" />
          </Field>
        </div>
        <Field label="Notes">
          <Input name="notes" placeholder="Blocking, special setups…" />
        </Field>
        <ErrorText message={state?.error} />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Adding…" : "Add to schedule"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ScheduleItems({
  projectId,
  dayId,
  items,
  availableScenes,
}: {
  projectId: string;
  dayId: string;
  items: ScheduleItem[];
  availableScenes: SceneOption[];
}) {
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <Card key={item.id} className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {item.scene ? `Scene ${item.scene.number} — ${item.scene.intExt}. ${item.scene.location}` : "Scene removed"}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              {[item.startTime, item.endTime].filter(Boolean).join(" – ")}
              {item.notes ? ` · ${item.notes}` : ""}
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (confirm("Remove this scene from the day?")) {
                deleteScheduleItemAction(projectId, dayId, item.id);
              }
            }}
          >
            Remove
          </Button>
        </Card>
      ))}
      <AddItemForm projectId={projectId} dayId={dayId} scenes={availableScenes} />
    </div>
  );
}
