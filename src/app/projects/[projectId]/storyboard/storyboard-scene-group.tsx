"use client";

import { useActionState, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { Badge, Button, Card, ErrorText, Field, Input } from "@/components/ui";
import { createShotAction, reorderShotsAction } from "@/lib/actions/shots";
import type { FormState } from "@/lib/actions/shots";
import { StoryboardPanel, type StoryboardShot } from "./storyboard-panel";
import { formatSlugline } from "@/lib/scene-format";

function AddShotTile({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const [open, setOpen] = useState(false);
  const boundAction = createShotAction.bind(null, projectId, sceneId);
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prevState, formData) => {
    const result = await boundAction(prevState, formData);
    if (!result?.error) setOpen(false);
    return result;
  }, undefined);

  if (!open) {
    return (
      <Card className="flex aspect-[3/4] min-h-[180px] items-center justify-center border-dashed p-4">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          + Add shot
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-3">
      <form action={formAction} className="space-y-2">
        <Field label="Shot #">
          <Input name="shotNumber" required placeholder="1A" />
        </Field>
        <Field label="Shot size">
          <Input name="shotType" required placeholder="Wide Shot" />
        </Field>
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

export function StoryboardSceneGroup({
  projectId,
  sceneId,
  sceneNumber,
  intExt,
  location,
  timeOfDay,
  shots,
  imageGenAvailable,
}: {
  projectId: string;
  sceneId: string;
  sceneNumber: string;
  intExt: string;
  location: string;
  timeOfDay: string;
  shots: StoryboardShot[];
  imageGenAvailable: boolean;
}) {
  // Shots always render in the order the server sent them (already sorted by
  // the persisted `order` field). No separate client-side order state: that
  // would go stale the moment a shot is added/duplicated/deleted elsewhere,
  // since this component doesn't remount when its `shots` prop changes.
  const dragIndex = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function handleDragStart(index: number) {
    dragIndex.current = index;
    setDraggingId(shots[index]?.id ?? null);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
  }

  function handleDrop(dropIndex: number) {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDraggingId(null);
    if (from === null || from === dropIndex) return;

    const next = shots.map((s) => s.id);
    const [moved] = next.splice(from, 1);
    next.splice(dropIndex, 0, moved);
    reorderShotsAction(projectId, sceneId, next);
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Link href={`/projects/${projectId}/scenes/${sceneId}`} className="hover:underline">
          <span className="font-mono text-sm font-semibold text-foreground">
            SCENE {sceneNumber} — {formatSlugline(intExt, location, timeOfDay)}
          </span>
        </Link>
        <Badge>{shots.length} shots</Badge>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {shots.map((shot, index) => (
          <StoryboardPanel
            key={shot.id}
            projectId={projectId}
            sceneId={sceneId}
            shot={shot}
            index={index}
            imageGenAvailable={imageGenAvailable}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            isDragging={draggingId === shot.id}
          />
        ))}
        <AddShotTile projectId={projectId} sceneId={sceneId} />
      </div>
    </div>
  );
}
