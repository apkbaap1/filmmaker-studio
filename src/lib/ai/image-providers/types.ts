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
  /** True when the server has the credentials this provider needs. */
  isConfigured(): boolean;
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}
