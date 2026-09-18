"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, ErrorText } from "@/components/ui";
import { deleteGenerationAction } from "@/lib/actions/generations";

export type GenerationMode = "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";

export type GenerationItem = {
  id: string;
  mode: GenerationMode;
  status: "QUEUED" | "PROCESSING" | "AWAITING_PROVIDER" | "COMPLETED" | "FAILED" | "CANCELLED";
  failureKind: "RETRYABLE" | "PERMANENT" | "INDETERMINATE" | null;
  attempts: number;
  maxAttempts: number;
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
  AWAITING_PROVIDER: "accent",
  COMPLETED: "green",
  FAILED: "red",
  CANCELLED: "default",
} as const;

/**
 * Worded from the filmmaker's point of view. "Queued" says the job is safe and
 * waiting rather than that nothing is happening, which matters now that leaving
 * the page is genuinely harmless.
 */
const STATUS_LABEL = {
  QUEUED: "Queued",
  PROCESSING: "Generating…",
  AWAITING_PROVIDER: "With the provider…",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
} as const;

/** States a worker will still act on — nothing here needs the page to stay open. */
const IN_FLIGHT = new Set(["QUEUED", "PROCESSING", "AWAITING_PROVIDER"]);

/**
 * What a failure means, in the filmmaker's terms. INDETERMINATE gets the longest
 * explanation because it is the one where the honest answer is "we do not know",
 * and a retry is a decision rather than a click.
 */
const FAILURE_NOTE = {
  RETRYABLE: "This looked temporary, and it was retried automatically before giving up.",
  PERMANENT: "The provider rejected this outright, so it was not retried.",
  INDETERMINATE:
    "A worker reached the provider but did not get confirmation back, and this provider cannot be asked whether the job exists. It was not retried, because that could start — and bill for — a second generation. Check the provider before retrying.",
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
  onCancel,
}: {
  projectId: string;
  generation: GenerationItem;
  onRetry: (generation: GenerationItem) => void;
  onCancel: (generation: GenerationItem) => void;
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

        {IN_FLIGHT.has(generation.status) && (
          <p className="text-xs text-muted">
            Running on the server. You can close this page — it will carry on without you.
            {generation.attempts > 1 && ` Attempt ${generation.attempts} of ${generation.maxAttempts}.`}
          </p>
        )}

        {generation.status === "FAILED" && generation.failureKind && (
          <p className="text-xs text-muted">{FAILURE_NOTE[generation.failureKind]}</p>
        )}

        <div className="flex flex-wrap gap-2">
          {generation.status === "FAILED" && (
            <Button size="sm" variant="secondary" onClick={() => onRetry(generation)}>
              Retry this prompt
            </Button>
          )}
          {/* Only offered where it is real: once a provider has the job, nothing
              here can call it back, so no button pretends otherwise. */}
          {generation.status === "QUEUED" && (
            <Button size="sm" variant="ghost" onClick={() => onCancel(generation)}>
              Cancel
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
