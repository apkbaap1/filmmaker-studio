"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, ErrorText, Textarea } from "@/components/ui";
import {
  deleteGenerationAction,
  runGenerationAction,
  startShotImageGenerationAction,
} from "@/lib/actions/generations";

export type GenerationItem = {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  source: "QUICK" | "STRUCTURED";
  promptUsed: string;
  promptEdited: boolean;
  error: string | null;
  providerId: string;
  createdAt: string;
  assetId: string | null;
  assetMimeType: string | null;
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

function GenerationCard({
  projectId,
  generation,
  onRetry,
}: {
  projectId: string;
  generation: GenerationItem;
  onRetry: (generationId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Card className="overflow-hidden">
      {generation.assetId && generation.assetMimeType?.startsWith("image/") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/assets/${generation.assetId}/file`}
          alt="Generated frame"
          className="aspect-video w-full object-cover"
        />
      ) : (
        <div className="flex aspect-video items-center justify-center bg-surface-2 text-xs text-muted">
          {STATUS_LABEL[generation.status]}
        </div>
      )}

      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[generation.status]}>{STATUS_LABEL[generation.status]}</Badge>
          <Badge>{generation.source === "STRUCTURED" ? "From shot" : "Free text"}</Badge>
          {generation.promptEdited && <Badge tone="accent">Prompt edited</Badge>}
        </div>

        <p className="text-xs text-muted">
          {new Date(generation.createdAt).toLocaleString()} · {generation.providerId}
        </p>

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
            <Button size="sm" variant="secondary" onClick={() => onRetry(generation.id)}>
              Retry this prompt
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (!confirm("Remove this generation from the history? The image itself is kept.")) return;
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

/**
 * Filmmaker Generation — path B.
 *
 * The prompt shown here is compiled on the server from the Shot itself
 * (Shot → compiler → CinematicPromptSpec → image renderer → provider adapter).
 * It is displayed before anything is generated, and it is editable: an edited
 * prompt is submitted verbatim and recorded as the prompt that was used.
 *
 * The quick free-text "Generate with AI" button in the reference gallery is
 * unchanged and still available — this is an extra path, not a replacement.
 */
export function ShotImageGeneration({
  projectId,
  sceneId,
  shotId,
  compiledPrompt,
  providerLabel,
  imageGenAvailable,
  generations,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  compiledPrompt: string;
  providerLabel: string;
  imageGenAvailable: boolean;
  generations: GenerationItem[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(compiledPrompt);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const edited = prompt.trim() !== compiledPrompt.trim();
  const hasCompleted = generations.some((g) => g.status === "COMPLETED");

  async function generate(text: string) {
    setError(undefined);
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("prompt", text);
      const started = await startShotImageGenerationAction(
        projectId,
        sceneId,
        shotId,
        undefined,
        formData
      );
      if (!started?.generationId) {
        setError(started?.error ?? "Could not start the generation");
        return;
      }
      // The queued row exists; show it before the slow call begins.
      router.refresh();
      const result = await runGenerationAction(projectId, started.generationId);
      if (result.error) setError(result.error);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function retry(generationId: string) {
    setError(undefined);
    setBusy(true);
    try {
      const result = await runGenerationAction(projectId, generationId);
      if (result.error) setError(result.error);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Generate image from this shot</h3>
        <Badge tone="accent">{providerLabel}</Badge>
        {edited && <Badge>edited</Badge>}
      </div>

      <p className="mb-3 text-xs text-muted">
        Compiled from the shot&rsquo;s own fields — lens, angle, shot size, composition, lighting and
        blocking — by the prompt compiler. Nothing here was inferred: a field you left blank does not
        appear. Edit it if you want, and the edited text is what gets sent and recorded.
      </p>

      {editing ? (
        <Textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      ) : (
        <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-foreground">
          {prompt || "Nothing specified yet — fill in the shot's fields above."}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !imageGenAvailable || prompt.trim().length < 3}
          onClick={() => generate(prompt)}
        >
          {busy ? "Generating…" : hasCompleted ? "Regenerate" : "Generate image"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit prompt"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(prompt);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy prompt"}
        </Button>
        {edited && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPrompt(compiledPrompt);
              setError(undefined);
            }}
          >
            Reset to compiled
          </Button>
        )}
        {!imageGenAvailable && (
          <span className="text-xs text-muted">
            AI generation needs an OPENAI_API_KEY — see README
          </span>
        )}
      </div>

      <ErrorText message={error} />

      {generations.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            Generations ({generations.length})
          </p>
          <p className="mb-3 text-xs text-muted">
            Every attempt is kept. Regenerating adds a new one rather than replacing what came before.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {generations.map((generation) => (
              <GenerationCard
                key={generation.id}
                projectId={projectId}
                generation={generation}
                onRetry={retry}
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
