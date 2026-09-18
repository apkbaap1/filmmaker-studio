/**
 * Video-generation provider adapter.
 *
 * Third member of the provider family, and deliberately shaped unlike the other
 * two:
 *
 *   PromptProvider           CinematicPromptSpec → text   (src/lib/prompt/providers)
 *   ImageGenerationProvider  text → pixels, inline        (src/lib/ai/image-providers)
 *   VideoGenerationProvider  text → a *job*, polled       (here)
 *
 * Video generation is asynchronous everywhere it exists, so the interface is
 * submit-then-poll rather than one awaited call. That is not a stylistic choice:
 * modelling it as a single call would force the request to be held open for
 * minutes and would lose the job if the page went away.
 *
 * An adapter receives a finished prompt string and, for image-to-video, the
 * source frame's bytes. It never sees the Shot, the spec, or the database —
 * provider-specific requirements belong in the adapter, not in the IR.
 */
export type VideoGenerationMode = "text-to-video" | "image-to-video";

export interface VideoGenerationRequest {
  prompt: string;
  mode: VideoGenerationMode;
  /** What the filmmaker asked for. An adapter may clamp it; it must not invent one. */
  durationSeconds?: number;
  /** Required for image-to-video, absent otherwise. */
  sourceImage?: { data: Buffer; mimeType: string };
  /**
   * Stable for the lifetime of one Generation, including across retries.
   *
   * An adapter whose provider supports idempotency keys must pass this through,
   * so that a resubmission after a crashed worker returns the *existing* job
   * rather than starting — and billing — a second one. Adapters whose provider
   * has no such facility ignore it and declare `supportsIdempotencyKey: false`.
   */
  idempotencyKey?: string;
}

export interface VideoJobHandle {
  providerJobId: string;
}

export type VideoJobResult =
  | { status: "processing" }
  | { status: "completed"; video: { data: Buffer; mimeType: string } }
  | { status: "failed"; error: string };

export interface VideoGenerationProvider {
  id: string;
  label: string;
  /** Which model the adapter drives, for the audit trail. Never a credential. */
  model: string;
  capabilities: {
    /**
     * `real` means an external service is called and billed; `stub` means the
     * clip is produced locally and is never evidence of AI generation. Reported
     * in the UI and the logs so the two can never be confused.
     */
    kind: "real" | "stub";
    imageToVideo: boolean;
    maxDurationSeconds?: number;
    /** Set only when the provider accepts a fixed set of clip lengths. */
    allowedDurationsSeconds?: number[];
  };
  /**
   * Whether `submit` honours `idempotencyKey` — that is, whether submitting the
   * same key twice is guaranteed to yield one provider job.
   *
   * This is the single most consequential flag in the interface. The worker
   * uses it to decide what to do after crashing between "submitted" and
   * "recorded the job id": with a true here it can safely resubmit, and without
   * it the job is parked as INDETERMINATE rather than risking a duplicate.
   * An adapter must not claim true unless its provider actually guarantees it.
   */
  supportsIdempotencyKey: boolean;

  /** True when the server has the credentials and configuration this provider needs. */
  isConfigured(): boolean;
  submit(request: VideoGenerationRequest): Promise<VideoJobHandle>;
  poll(providerJobId: string): Promise<VideoJobResult>;

  /**
   * Finds a job previously submitted under an idempotency key, if the provider
   * can be asked. Implementing this is the other way out of the crash window:
   * the worker adopts the existing job instead of resubmitting.
   */
  findJobByIdempotencyKey?(key: string): Promise<VideoJobHandle | undefined>;
}
