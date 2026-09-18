/**
 * Image-generation provider adapter.
 *
 * This is the *rendering* half of the pipeline, deliberately separate from the
 * prompt-side `PromptProvider` (src/lib/prompt/providers): that one turns a
 * CinematicPromptSpec into text, this one turns text into pixels. Keeping them
 * apart means a platform can be swapped on either side independently, and the
 * filmmaking data model stays coupled to neither.
 *
 * An adapter only ever receives a finished prompt string. It never sees the
 * Shot, the spec, or the database.
 */
export interface ImageGenerationRequest {
  prompt: string;
  /** Provider-native size token, e.g. "1024x1024". Omitted means the adapter's default. */
  size?: string;
  /**
   * Stable across retries of one Generation. Image generation returns inline,
   * so there is no job id to lose — but a provider that honours the key still
   * spares the caller a second billed render after a mid-flight crash.
   */
  idempotencyKey?: string;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageGenerationProvider {
  id: string;
  label: string;
  /**
   * Which model the adapter calls, for the audit trail. Not a secret — the API
   * key itself is read inside `generate` and never returned or logged.
   */
  model: string;
  /**
   * Whether `generate` honours `idempotencyKey`. Optional, and absent reads as
   * false — the safe way round, so an adapter has to opt in deliberately rather
   * than inherit a guarantee it does not offer.
   */
  supportsIdempotencyKey?: boolean;

  /** True when the server has the credentials this provider needs. */
  isConfigured(): boolean;
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}
