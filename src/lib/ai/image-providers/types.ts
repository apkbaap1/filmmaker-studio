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
  /**
   * The image's true dimensions, read from the returned bytes rather than from
   * what was requested. An adapter that cannot determine them omits them: the
   * Asset then records null, which is honest, where a guess would not be.
   */
  width?: number;
  height?: number;
}

/**
 * What an adapter's provider can actually do.
 *
 * Declared rather than assumed, so the UI can offer only what is real and the
 * submission path can refuse a configuration explicitly instead of quietly
 * rounding the filmmaker's request to something the provider likes better.
 */
export interface ImageProviderCapabilities {
  /**
   * `real` means an external service is called and billed. `stub` means output
   * is produced locally and is never evidence of AI generation. The UI and the
   * logs both surface this, so the two can never be confused.
   */
  kind: "real" | "stub";
  /**
   * Provider-native size tokens, e.g. "1024x1024". Empty when the provider has
   * no size parameter at all.
   */
  sizes: string[];
  /**
   * Which of `sizes` is sent when the filmmaker states none.
   *
   * Optional, and absent means *this provider does not accept a size* — not
   * that it has a default this adapter failed to name. The field was required
   * until a second provider arrived whose API has no dimension parameter for
   * image output, which is exactly the assumption a single implementation could
   * never have exposed.
   */
  defaultSize?: string;
  /** What the provider returns. Anything else is refused. */
  outputMimeTypes: string[];
  maxPromptCharacters: number;
  imagesPerRequest: number;
  supportsReferenceImages: boolean;
}

export interface ImageGenerationProvider {
  id: string;
  label: string;
  /**
   * Which model the adapter calls, for the audit trail. Not a secret — the API
   * key itself is read inside `generate` and never returned or logged.
   */
  model: string;
  /** What this provider can actually do. Optional only so older adapters stay valid. */
  capabilities?: ImageProviderCapabilities;

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
