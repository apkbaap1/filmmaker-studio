"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, ErrorText, Field, Select, Textarea } from "@/components/ui";
import {
  cancelGenerationAction,
  generationStatesAction,
  retryGenerationAction,
  startShotImageGenerationAction,
} from "@/lib/actions/generations";
import { startShotVideoGenerationAction } from "@/lib/actions/video-generations";
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

/** How often the page asks the server what the worker has been doing. */
const REFRESH_MS = 2500;

/** States a worker is still going to act on. */
const IN_FLIGHT = new Set(["QUEUED", "PROCESSING", "AWAITING_PROVIDER"]);

/**
 * The generation surface for a shot: three modes over one compiler.
 *
 * Every tab shows the prompt the compiler produced for that mode *before*
 * anything is sent, and every tab lets it be edited. An edited prompt is
 * submitted and recorded verbatim — switching tabs, regenerating, or reloading
 * never silently recompiles over an explicit edit.
 *
 * This component does not run generations. Clicking Generate writes a durable
 * job and returns; a background worker submits it, polls the provider and stores
 * the result. What is below is a *view* of those jobs, refreshed while any of
 * them is still in flight.
 *
 * That is the whole point of Workstream 11.3: closing this tab, navigating away
 * or losing the network does not affect a generation in the slightest, because
 * the browser was never the thing carrying it.
 */
export function ShotGeneration({
  projectId,
  sceneId,
  shotId,
  prompts,
  imageProviderLabel,
  imageGenAvailable,
  imageProviderKind,
  videoProviderLabel,
  videoGenAvailable,
  videoProviderKind,
  sourceFrames,
  generations,
}: {
  projectId: string;
  sceneId: string;
  shotId: string;
  prompts: Record<GenerationMode, string>;
  imageProviderLabel: string;
  imageGenAvailable: boolean;
  imageProviderKind: "real" | "stub";
  videoProviderLabel: string | null;
  videoGenAvailable: boolean;
  videoProviderKind: "real" | "stub" | null;
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
  const providerKind = isVideo ? videoProviderKind : imageProviderKind;
  const blocked =
    mode === "IMAGE_TO_VIDEO" && sourceFrames.length === 0
      ? "Generate or upload an image for this shot first — image-to-video needs a source frame."
      : undefined;

  // --- observing the worker -------------------------------------------------
  // Refreshing a view, not driving a job. If this component never renders again,
  // every generation below still finishes.
  const inFlight = generations.filter((g) => IN_FLIGHT.has(g.status)).length;
  const checking = useRef(false);

  useEffect(() => {
    if (inFlight === 0) return;
    const timer = setInterval(async () => {
      if (checking.current) return;
      checking.current = true;
      try {
        const states = await generationStatesAction(projectId, shotId);
        const settled = states.some(
          (state) =>
            !IN_FLIGHT.has(state.status) &&
            generations.find((g) => g.id === state.id)?.status !== state.status
        );
        // Also refresh when a job appears or disappears, so a worker finishing
        // between renders is never missed.
        if (settled || states.length !== generations.length) router.refresh();
      } catch {
        // A failed status check is not worth surfacing: the next tick retries,
        // and nothing about the job depends on this request.
      } finally {
        checking.current = false;
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [inFlight, projectId, shotId, generations, router]);

  const generate = useCallback(
    async (text: string) => {
      setError(undefined);
      setBusy(true);
      try {
        const formData = new FormData();
        formData.set("prompt", text);

        // Both paths do the same thing: write a queued job and stop. Nothing
        // here waits for a provider, so the button comes back immediately even
        // for a clip that will take minutes.
        const started =
          mode === "IMAGE"
            ? await startShotImageGenerationAction(projectId, sceneId, shotId, undefined, formData)
            : await startShotVideoGenerationAction(
                projectId,
                sceneId,
                shotId,
                mode,
                mode === "IMAGE_TO_VIDEO" ? sourceAssetId : null,
                undefined,
                formData
              );

        if (!started?.generationId) {
          setError(started?.error ?? "Could not queue the generation");
          return;
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
        const result = await retryGenerationAction(projectId, generation.id);
        if (result.error) setError(result.error);
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [projectId, router]
  );

  const cancel = useCallback(
    async (generation: GenerationItem) => {
      setError(undefined);
      setBusy(true);
      try {
        const result = await cancelGenerationAction(projectId, generation.id);
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
        {/* Said before the button is pressed, not only after: whether this will
            call a paid external model or render a local placeholder. */}
        {available && providerKind === "stub" && <Badge>local stub</Badge>}
        {available && providerKind === "real" && <Badge tone="green">real provider</Badge>}
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

      {available && providerKind === "stub" && (
        <p className="mb-3 text-xs text-muted">
          This is a local stub. It produces a deterministic placeholder so the pipeline can be
          exercised end to end — it does not call any external AI model, and nothing it returns is
          a render of this prompt.
        </p>
      )}

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
                onCancel={cancel}
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
