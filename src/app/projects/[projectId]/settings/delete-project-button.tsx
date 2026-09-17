"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui";
import { deleteProjectAction } from "@/lib/actions/projects";

export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="danger"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this project and everything in it? This cannot be undone.")) return;
        startTransition(() => {
          deleteProjectAction(projectId);
        });
      }}
    >
      {pending ? "Deleting…" : "Delete project"}
    </Button>
  );
}
