"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, ErrorText, Field, Select, Textarea } from "@/components/ui";
import {
  runGenerationAction,
  startShotImageGenerationAction,
} from "@/lib/actions/generations";
import {
  pollVideoGenerationAction,
  runVideoGenerationAction,
  startShotVideoGenerationAction,
} from "@/lib/actions/video-generations";
import { GenerationCard, MODE_LABEL, type GenerationItem, type GenerationMode } from "./generation-card";

export type SourceFrame = { id: string; label: string };

const MODES: GenerationMode[] = ["IMAGE", "VIDEO", "IMAGE_TO_VIDEO"];

const BLURB: Record<GenerationMode, string> = {
  IMAGE:
    "A still frame. Temporal fields are deliberately left out — a still has no time axis — but they stay in the spec for the video modes.",
  VIDEO:
    "A clip compiled from the shot's temporal fields: opening and closing framing, camera and subject positions, movement and its speed, environmental movement and duration. Axes you did not state simply do not appear, and a stable composition is stated as held rather than animated.",
  IMAGE_TO_VIDEO:
    "Animates one of this shot's existing frames. The prompt is an explicit PRESERVE / ANIMATE contract: everything you stated as fixed is listed as fixed, and only motion you actually specified is listed as moving.",
};

/** How often an in-flight video job is re-checked. */
const POLL_MS = 2500;

/**
 * The generation surface for a shot: three modes over one compiler.
 *
 * Every tab shows the prompt the compiler produced for that mode *before*
 * anything is sent, and every tab lets it be edited. An edited prompt is
 * submitted and recorded verbatim — switching tabs, regenerating, or reloading
 * never silently recompiles over an explicit edit.
 *
 * Video jobs are polled in the background. The page stays usable throughout, and
 * because the provider's job handle lives on the row rather than in this
 * component, a reload picks polling back up instead of losing the job.
 */
export function ShotGeneration({
  projectId,
  sceneId,
  shotId,
  prompts,
  imageProviderLabel,
  imageGenAvailable,
  videoProviderLabel,
  videoGenAvailable,
  sourceFrames,
  generations,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  prompts: Record<GenerationMode, string>;
  imageProviderLabel: string;
  imageGenAvailable: boolean;
  videoProviderLabel: string | null;
  videoGenAvailable: boolean;
  sourceFrames: SourceFrame[];
  generations: GenerationItem[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<GenerationMode>("IMAGE");
  const [drafts, setDrafts] = useState<Record<GenerationMode, string>>(prompts);
  const [editing, setEditing] = useState(false);
  const [sourceAssetId, setSourceAssetId] = useState(sourceFrames[0]?.id ?? "");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const prompt = drafts[mode];
  const compiled = prompts[mode];
  const edited = prompt.trim() !== compiled.trim();
  const forMode = generations.filter((g) => g.mode === mode);
  const hasCompleted = forMode.some((g) => g.status === "COMPLETED");

  const isVideo = mode !== "IMAGE";
  const available = isVideo ? videoGenAvailable : imageGenAvailable;
  const providerLabel = isVideo ? videoProviderLabel : imageProviderLabel;
  const blocked =
    mode === "IMAGE_TO_VIDEO" && sourceFrames.length === 0
      ? "Generate or upload an image for this shot first — image-to-video needs a source frame."
      : undefined;

  // --- background polling for in-flight video jobs ---------------------------
  // Driven by what the server rendered, so a reload resumes rather than orphans.
  const inFlight = generations
    .filter((g) => g.mode !== "IMAGE" && (g.status === "QUEUED" || g.status === "PROCESSING"))
    .map((g) => g.id)
    .join(",");
  const polling = useRef(false);

  useEffect(() => {
    if (!inFlight) return;
    const ids = inFlight.split(",");
    const timer = setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const results = await Promise.all(
          ids.map((id) => pollVideoGenerationAction(projectId, id))
        );
        if (results.some((r) => r.status === "COMPLETED" || r.status === "FAILED")) {
          router.refresh();
        }
      } finally {
        polling.current = false;
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, projectId, router]);

  const generate = useCallback(
    async (text: string) => {
      setError(undefined);
      setBusy(true);
      try {
        const formData = new FormData();
        formData.set("prompt", text);

        if (mode === "IMAGE") {
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
          router.refresh();
          const result = await runGenerationAction(projectId, started.generationId);
          if (result.error) setError(result.error);
        } else {
          const started = await startShotVideoGenerationAction(
            projectId,
            sceneId,
            shotId,
            mode,
            mode === "IMAGE_TO_VIDEO" ? sourceAssetId : null,
            undefined,
            formData
          );
          if (!started?.generationId) {
            setError(started?.error ?? "Could not start the generation");
            return;
          }
          router.refresh();
          // Returns as soon as the provider accepts the job; the poll loop above
          // takes it from there, so this never holds the UI.
          const result = await runVideoGenerationAction(projectId, started.generationId);
          if (result.error) setError(result.error);
        }
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [mode, projectId, sceneId, shotId, sourceAssetId, router]
  );

  const retry = useCallback(
    async (generation: GenerationItem) => {
      setError(undefined);
      setBusy(true);
      try {
        const result =
          generation.mode === "IMAGE"
            ? await runGenerationAction(projectId, generation.id)
            : await runVideoGenerationAction(projectId, generation.id);
        if (result.error) setError(result.error);
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [projectId, router]
  );

  return (
    <Card className="p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Generate from this shot</h3>
        {providerLabel ? <Badge tone="accent">{providerLabel}</Badge> : <Badge>no provider</Badge>}
        {edited && <Badge>edited</Badge>}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {MODES.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={m === mode ? "primary" : "ghost"}
            onClick={() => {
              setMode(m);
              setEditing(false);
              setError(undefined);
            }}
          >
            {MODE_LABEL[m]}
          </Button>
        ))}
      </div>

      <p className="mb-3 text-xs text-muted">{BLURB[mode]}</p>

      {mode === "IMAGE_TO_VIDEO" && sourceFrames.length > 0 && (
        <div className="mb-3 max-w-md">
          <Field label="Source frame to animate">
            <Select value={sourceAssetId} onChange={(e) => setSourceAssetId(e.target.value)}>
              {sourceFrames.map((frame) => (
                <option key={frame.id} value={frame.id}>
                  {frame.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {editing ? (
        <Textarea
          rows={12}
          value={prompt}
          onChange={(e) => setDrafts((d) => ({ ...d, [mode]: e.target.value }))}
        />
      ) : (
        <p className="whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs text-foreground">
          {prompt || "Nothing specified yet — fill in the shot's fields above."}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !available || Boolean(blocked) || prompt.trim().length < 3}
          onClick={() => generate(prompt)}
        >
          {busy
            ? "Starting…"
            : hasCompleted
              ? `Regenerate ${MODE_LABEL[mode].toLowerCase()}`
              : `Generate ${MODE_LABEL[mode].toLowerCase()}`}
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
              setDrafts((d) => ({ ...d, [mode]: compiled }));
              setError(undefined);
            }}
          >
            Reset to compiled
          </Button>
        )}
      </div>

      {blocked && <p className="mt-2 text-xs text-muted">{blocked}</p>}
      {!available && (
        <p className="mt-2 text-xs text-muted">
          {isVideo
            ? "No video provider is configured. Set VIDEO_PROVIDER in .env once you have chosen one — see README."
            : "AI generation needs an OPENAI_API_KEY — see README."}
        </p>
      )}

      <ErrorText message={error} />

      {forMode.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {MODE_LABEL[mode]} generations ({forMode.length})
          </p>
          <p className="mb-3 text-xs text-muted">
            Every attempt is kept with the exact prompt that produced it. Regenerating adds a new one
            rather than replacing what came before.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {forMode.map((generation) => (
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
