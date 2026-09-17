"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, ErrorText } from "@/components/ui";
import { deleteGenerationAction } from "@/lib/actions/generations";

export type GenerationMode = "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";

export type GenerationItem = {
  id: string;
  mode: GenerationMode;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  source: "QUICK" | "STRUCTURED";
  promptUsed: string;
  promptEdited: boolean;
  error: string | null;
  providerId: string;
  durationSeconds: number | null;
  createdAt: string;
  assetId: string | null;
  assetMimeType: string | null;
  sourceAssetId: string | null;
};

const STATUS_TONE = {
  QUEUED: "default",
  PROCESSING: "accent",
  COMPLETED: "green",
  FAILED: "red",
} as const;

const STATUS_LABEL = {
  QUEUED: "Queued",
  PROCESSING: "Generating…",
  COMPLETED: "Completed",
  FAILED: "Failed",
} as const;

export const MODE_LABEL: Record<GenerationMode, string> = {
  IMAGE: "Image",
  VIDEO: "Video",
  IMAGE_TO_VIDEO: "Image → Video",
};

/**
 * One generation attempt, whatever mode produced it. The prompt that was used is
 * always reachable from the card, because that is the only reliable record of
 * what made this particular result.
 */
export function GenerationCard({
  projectId,
  generation,
  onRetry,
}: {
  projectId: string;
  generation: GenerationItem;
  onRetry: (generation: GenerationItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();

  const src = generation.assetId ? `/api/assets/${generation.assetId}/file` : undefined;
  const mime = generation.assetMimeType ?? "";

  return (
    <Card className="overflow-hidden">
      {src && mime.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="Generated frame" className="aspect-video w-full object-cover" />
      ) : src && mime.startsWith("video/") ? (
        <video src={src} controls loop className="aspect-video w-full bg-black object-contain" />
      ) : (
        <div className="flex aspect-video items-center justify-center bg-surface-2 text-xs text-muted">
          {STATUS_LABEL[generation.status]}
        </div>
      )}

      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[generation.status]}>{STATUS_LABEL[generation.status]}</Badge>
          <Badge>{MODE_LABEL[generation.mode]}</Badge>
          {generation.source === "QUICK" && <Badge>Free text</Badge>}
          {generation.promptEdited && <Badge tone="accent">Prompt edited</Badge>}
        </div>

        <p className="text-xs text-muted">
          {new Date(generation.createdAt).toLocaleString()} · {generation.providerId}
          {generation.durationSeconds != null && ` · ${generation.durationSeconds}s requested`}
        </p>

        {generation.sourceAssetId && (
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/assets/${generation.sourceAssetId}/file`}
              alt="Source frame"
              className="h-10 w-16 rounded border border-border object-cover"
            />
            <span className="text-xs text-muted">Animated from this frame</span>
          </div>
        )}

        {generation.error && <ErrorText message={generation.error} />}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-accent hover:underline"
        >
          {expanded ? "Hide prompt" : "Show prompt used"}
        </button>
        {expanded && (
          <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-2 text-xs text-foreground">
            {generation.promptUsed}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {generation.status === "FAILED" && (
            <Button size="sm" variant="secondary" onClick={() => onRetry(generation)}>
              Retry this prompt
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (!confirm("Remove this generation from the history? The result itself is kept."))
                return;
              startTransition(async () => {
                await deleteGenerationAction(projectId, generation.id);
              });
            }}
          >
            Remove
          </Button>
        </div>
      </div>
    </Card>
  );
}
