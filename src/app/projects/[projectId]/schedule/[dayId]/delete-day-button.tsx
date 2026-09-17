"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui";
import { deleteScheduleDayAction } from "@/lib/actions/schedule";

export function DeleteDayButton({ projectId, dayId }: { projectId: string; dayId: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="danger"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!confirm("Delete this shoot day?")) return;
        startTransition(() => {
          deleteScheduleDayAction(projectId, dayId);
        });
      }}
    >
      {pending ? "Deleting…" : "Delete day"}
    </Button>
  );
}
