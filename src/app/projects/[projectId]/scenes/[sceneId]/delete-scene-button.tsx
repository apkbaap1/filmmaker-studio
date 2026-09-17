"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui";
import { deleteSceneAction } from "@/lib/actions/scenes";

export function DeleteSceneButton({ projectId, sceneId }: { projectId: string; sceneId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this scene and all its shots?")) return;
        startTransition(() => {
          deleteSceneAction(projectId, sceneId);
        });
      }}
    >
      {pending ? "Deleting…" : "Delete scene"}
    </Button>
  );
}
