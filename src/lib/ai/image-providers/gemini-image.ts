import "server-only";

import { GenerationError } from "@/lib/jobs/state";
import { readImageMetadata, InvalidImageError } from "../image-metadata.ts";
import type { GeneratedImage, ImageGenerationProvider, ImageGenerationRequest } from "./types.ts";

/**
 * Google Gemini image generation — the application's second real image provider.
 *
 * Its reason for existing is partly to render images and partly to audit a
 * claim: that one provider-independent CinematicPromptSpec renders to many
 * providers, and that adding one touches nothing outside its own adapter file
 * and the registry. With a single real provider of each kind, every seam had
 * only ever had to satisfy one implementation.
 *
 * The audit found one thing. See **Where this did not fit** below.
 *
 * ## API
 *
 *   POST {base}/models/{model}:generateContent
 *   auth: x-goog-api-key: $GOOGLE_API_KEY
 *   body: { contents: [{ role, parts: [{ text }] }],
 *           generationConfig: { responseModalities: ["IMAGE"] } }
 *
 * Every line of that is traced to Google's own SDK in
 * `docs/gemini-image-api-contract.md`, which also records why Imagen's
 * `generateImages` was abandoned: it is Vertex-only, and Vertex needs
 * service-account OAuth rather than the API key this application holds.
 *
 * **Implemented, not verified.** No request has been made to the live service.
 *
 * ## Where this did not fit
 *
 * `GenerateContentConfig` has no field for a rendered image's dimensions, so
 * this provider cannot be asked for a size. The capability interface assumed
 * every image provider picks from a set of size tokens; `defaultSize` is now
 * optional and absent means "does not accept a size". That was the whole of the
 * change outside this file and the registry — which is the result the seam was
 * being tested for.
 *
 * ## What this adapter will not do
 *
 * It does not rewrite the prompt, and it does not name a model. The text is
 * sent byte-for-byte as the compiler produced it, and `GOOGLE_IMAGE_MODEL` has
 * no default because which models serve image output is a fact about Google's
 * catalogue rather than about its SDK.
 */

export const GEMINI_IMAGE_MODEL_ENV = "GOOGLE_IMAGE_MODEL";

/**
 * Mime types this adapter will accept back.
 *
 * Wider than the OpenAI adapter's single entry because the response carries its
 * own `mimeType` rather than the adapter knowing in advance. Anything outside
 * this list is refused: an asset whose bytes are not an image the rest of the
 * application can display is worse than a failed generation.
 */
export const GEMINI_IMAGE_OUTPUT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * The Gemini API's own ceiling is expressed in tokens, not characters, and this
 * adapter cannot count tokens. This is a generous character bound whose only
 * job is to stop something absurd reaching a billed endpoint; the provider's
 * real limit is enforced by the provider, and its refusal is classified as
 * permanent below.
 */
const MAX_PROMPT_CHARACTERS = 100_000;

const REQUEST_TIMEOUT_MS = 180_000;

function baseUrl(): string {
  // The same variable the Veo adapter reads, so one gateway or test server
  // configures both Google adapters.
  return (
    process.env.GOOGLE_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
}

/** The operator's chosen model, or undefined. Never defaulted — see the doc above. */
export function configuredGeminiImageModel(): string | undefined {
  const model = process.env[GEMINI_IMAGE_MODEL_ENV]?.trim();
  return model ? model : undefined;
}

export function isGeminiImageConfigured(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY) && Boolean(configuredGeminiImageModel());
}

export const geminiImageProvider: ImageGenerationProvider = {
  id: "google-gemini-image",
  label: "Google Gemini (image)",

  /**
   * A getter rather than a fixed string: the model is the operator's to choose
   * and is read at call time, so changing it does not require a restart to be
   * reflected in the audit trail.
   */
  get model(): string {
    return configuredGeminiImageModel() ?? "(no model configured)";
  },

  capabilities: {
    kind: "real",
    // Empty, and `defaultSize` absent: the API has no size parameter for image
    // output, so there is nothing to offer and nothing to send.
    sizes: [],
    outputMimeTypes: [...GEMINI_IMAGE_OUTPUT_MIME_TYPES],
    maxPromptCharacters: MAX_PROMPT_CHARACTERS,
    imagesPerRequest: 1,
    supportsReferenceImages: false,
  },

  // No idempotency-key facility on this endpoint. Claiming one would let the
  // worker resubmit after a crash and bill a second render.
  supportsIdempotencyKey: false,

  isConfigured: isGeminiImageConfigured,

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    return generateGeminiImage(request.prompt, request.size);
  },
};

export async function generateGeminiImage(
  prompt: string,
  requestedSize?: string
): Promise<GeneratedImage> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw GenerationError.permanent(
      "Google image generation isn't configured. Add GOOGLE_API_KEY to your .env (see README)."
    );
  }

  const model = configuredGeminiImageModel();
  if (!model) {
    // Refusing beats guessing: a wrong model id produces a 404 on a path that
    // may already have been billed elsewhere, and nothing in this codebase can
    // know Google's current catalogue.
    throw GenerationError.permanent(
      `No model is configured for ${geminiImageProvider.label}. Set ${GEMINI_IMAGE_MODEL_ENV} to a Gemini model that returns images — this adapter deliberately ships without a default, because which models do is not knowable from here.`
    );
  }

  if (requestedSize) {
    // Refused rather than ignored. Silently dropping a stated size would hand
    // back an image of some other shape and call it what was asked for.
    throw GenerationError.permanent(
      `${geminiImageProvider.label} cannot be asked for a size — the API has no parameter for one. Leave the size unset.`
    );
  }

  assertPromptFits(prompt);

  const response = await post(apiKey, model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  const inline = await parseImageResponse(response);
  const bytes = Buffer.from(inline.data, "base64");
  if (bytes.byteLength === 0) {
    throw GenerationError.permanent("The provider returned an empty image");
  }

  // The bytes decide, not the response's own claim about them: a declared
  // mimeType is what the provider says it sent, and the header is what it
  // actually sent.
  let metadata;
  try {
    metadata = readImageMetadata(bytes);
  } catch (error) {
    if (error instanceof InvalidImageError) throw GenerationError.permanent(error.message);
    throw error;
  }

  if (!(GEMINI_IMAGE_OUTPUT_MIME_TYPES as readonly string[]).includes(metadata.mimeType)) {
    throw GenerationError.permanent(
      `The provider returned ${metadata.mimeType}, which this adapter does not expect from ${model}`
    );
  }

  return {
    data: bytes,
    mimeType: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
  };
}

function assertPromptFits(prompt: string): void {
  if (prompt.trim() === "") throw GenerationError.permanent("The prompt was empty");
  if (prompt.length > MAX_PROMPT_CHARACTERS) {
    throw GenerationError.permanent(
      `The prompt is ${prompt.length} characters, past this adapter's ${MAX_PROMPT_CHARACTERS} bound. Shorten it rather than letting it be cut off mid-description.`
    );
  }
}

async function post(
  apiKey: string,
  model: string,
  body: Record<string, unknown>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${baseUrl()}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        // Header, never `?key=`: a URL is logged by proxies, written into error
        // messages and kept in browser history.
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw GenerationError.retryable(
        `The provider did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
      );
    }
    throw GenerationError.retryable(`Could not reach the provider: ${describe(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

interface InlineImage {
  data: string;
  mimeType?: string;
}

/**
 * Turns a response into inline image data, or a correctly-classified failure.
 *
 * A model asked for an image may still answer with text — a refusal, a safety
 * message, an explanation. That is a response with no image in it, and it is
 * reported as such rather than as an empty success.
 */
async function parseImageResponse(response: Response): Promise<InlineImage> {
  if (!response.ok) throw classifyHttpFailure(response, await safeText(response));

  const raw = await safeText(response);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw GenerationError.retryable(
      `The provider returned a non-JSON body with status 200: ${summarise(raw)}`
    );
  }

  const inline = extractInlineImage(json);
  if (!inline) {
    const text = extractText(json);
    throw GenerationError.permanent(
      text
        ? `The provider answered with text instead of an image: ${text.slice(0, 200)}`
        : `The provider's response contained no image data: ${summarise(raw)}`
    );
  }
  return inline;
}

function partsOf(json: unknown): unknown[] {
  if (!json || typeof json !== "object") return [];
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const first = candidates[0];
  if (!first || typeof first !== "object") return [];
  const content = (first as { content?: unknown }).content;
  if (!content || typeof content !== "object") return [];
  const parts = (content as { parts?: unknown }).parts;
  return Array.isArray(parts) ? parts : [];
}

/** The first part that actually carries image bytes. Others are skipped, not merged. */
function extractInlineImage(json: unknown): InlineImage | undefined {
  for (const part of partsOf(json)) {
    if (!part || typeof part !== "object") continue;
    const inline = (part as { inlineData?: unknown }).inlineData;
    if (!inline || typeof inline !== "object") continue;

    const data = (inline as { data?: unknown }).data;
    if (typeof data !== "string" || data.length === 0) continue;

    const mimeType = (inline as { mimeType?: unknown }).mimeType;
    return { data, mimeType: typeof mimeType === "string" ? mimeType : undefined };
  }
  return undefined;
}

/** Whatever the model said instead, so the failure can quote it. */
function extractText(json: unknown): string | undefined {
  const texts: string[] = [];
  for (const part of partsOf(json)) {
    if (!part || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim() !== "") texts.push(text.trim());
  }
  return texts.length > 0 ? texts.join(" ") : undefined;
}

/**
 * Maps an HTTP failure onto the retry policy.
 *
 * Same distinction as every other adapter here: a credential or a rejected
 * request fails identically forever and must not consume attempts, while a rate
 * limit or a 5xx is the provider having a moment.
 */
function classifyHttpFailure(response: Response, body: string): GenerationError {
  const detail = providerMessage(body) ?? summarise(body);
  const status = response.status;

  if (status === 401 || status === 403) {
    return GenerationError.permanent(
      `The provider rejected the credentials (${status}). Check GOOGLE_API_KEY. — ${detail}`
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    // Also where a wrong GOOGLE_IMAGE_MODEL lands, which is why the message
    // names the variable.
    return GenerationError.permanent(
      `The provider rejected the request (${status}): ${detail}. If this names the model, check ${GEMINI_IMAGE_MODEL_ENV}.`
    );
  }
  if (status === 429) {
    return GenerationError.retryable(`Rate limited by the provider (429): ${detail}`);
  }
  if (status >= 500) {
    return GenerationError.retryable(`The provider failed (${status}): ${detail}`);
  }
  return GenerationError.retryable(`Unexpected provider status ${status}: ${detail}`);
}

/** Google's error envelope: `{ error: { code, message, status } }`. */
function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === "string" ? message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function summarise(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "(empty body)";
  if (/^<!doctype html|^<html/i.test(trimmed)) return "(an HTML page)";
  return trimmed.slice(0, 200);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
