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
    imageToVideo: boolean;
    maxDurationSeconds?: number;
    /** Set only when the provider accepts a fixed set of clip lengths. */
    allowedDurationsSeconds?: number[];
  };
  /** True when the server has the credentials and configuration this provider needs. */
  isConfigured(): boolean;
  submit(request: VideoGenerationRequest): Promise<VideoJobHandle>;
  poll(providerJobId: string): Promise<VideoJobResult>;
}
