import "server-only";

import { GenerationError } from "@/lib/jobs/state";
import { readImageMetadata, InvalidImageError } from "../image-metadata.ts";
import type { GeneratedImage, ImageGenerationProvider, ImageGenerationRequest } from "./types.ts";

/**
 * OpenAI gpt-image-1 — the application's first real image provider.
 *
 * Everything OpenAI-specific lives in this file: the endpoint, the
 * Authorization header, the request shape, the response shape, and which of its
 * failures are worth retrying. The worker, the compiler and the Generation model
 * know none of it. Replacing this provider means writing another file like this
 * one and changing a registry entry; no filmmaking data moves.
 *
 * ## API
 *
 *   POST {base}/images/generations        (OpenAI Images API, v1)
 *   model: gpt-image-1
 *   auth:  Authorization: Bearer $OPENAI_API_KEY
 *
 * The key is read here and nowhere else, in a module the bundler will not admit
 * to a client component. It is never returned, never logged, never stored and
 * never put in an error message.
 *
 * ## What this adapter will not do
 *
 * It does not rewrite the prompt. The text it receives is what the deterministic
 * compiler produced (or what the filmmaker edited it into), and it is sent
 * byte-for-byte. There is no "prompt improvement" step, no LLM in the path, and
 * no substitution of the filmmaker's vocabulary: an 85mm lens and a Low Angle
 * survive to the provider exactly as written.
 */

export const OPENAI_IMAGE_MODEL = "gpt-image-1";

/**
 * Sizes gpt-image-1 accepts. A request for anything else is refused rather than
 * rounded to the nearest — silently changing a filmmaker's framing is worse
 * than telling them it cannot be done.
 */
export const OPENAI_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type OpenAiImageSize = (typeof OPENAI_IMAGE_SIZES)[number];

const DEFAULT_SIZE: OpenAiImageSize = "1024x1024";

/** The documented ceiling for this model's prompt. */
const MAX_PROMPT_CHARACTERS = 32_000;

/** Generous, but bounded: a hung provider must not hold a worker indefinitely. */
const REQUEST_TIMEOUT_MS = 180_000;

function baseUrl(): string {
  // Overridable so an OpenAI-compatible endpoint (Azure OpenAI, a gateway, the
  // mock used in tests) works without touching this code.
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function isImageGenerationConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export const openAiImageProvider: ImageGenerationProvider = {
  id: "openai-gpt-image-1",
  label: "OpenAI gpt-image-1",
  model: OPENAI_IMAGE_MODEL,

  /**
   * Declared from the provider's documented behaviour, not guessed. The UI reads
   * this to decide what it may offer, and the submission path reads it to decide
   * what it must refuse.
   */
  capabilities: {
    kind: "real",
    sizes: [...OPENAI_IMAGE_SIZES],
    defaultSize: DEFAULT_SIZE,
    outputMimeTypes: ["image/png"],
    maxPromptCharacters: MAX_PROMPT_CHARACTERS,
    imagesPerRequest: 1,
    supportsReferenceImages: false,
  },

  // The Images API has no idempotency-key facility, and claiming otherwise
  // would let the worker resubmit after a crash and bill the account twice.
  supportsIdempotencyKey: false,

  isConfigured: isImageGenerationConfigured,

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    return generateImage(request.prompt, { size: request.size });
  },
};

export interface GenerateImageOptions {
  /** Provider-native size token. Unset means the model's default. */
  size?: string;
}

/**
 * Calls the provider and returns validated image bytes.
 *
 * Exported separately because the older free-text "Generate with AI" button
 * calls it directly. Both paths therefore share one HTTP implementation, one
 * set of validations and one place where the credential is read.
 */
export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {}
): Promise<GeneratedImage> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Permanent: no amount of retrying conjures a credential.
    throw GenerationError.permanent(
      "AI image generation isn't configured. Add OPENAI_API_KEY to your .env (see README) to enable it."
    );
  }

  const size = resolveSize(options.size);
  assertPromptFits(prompt);

  const response = await post(apiKey, { model: OPENAI_IMAGE_MODEL, prompt, size });
  const bytes = await parseImageResponse(response);

  // The bytes decide the metadata, not the request. Asking for 1024×1024 is not
  // evidence of having received it.
  let metadata;
  try {
    metadata = readImageMetadata(bytes);
  } catch (error) {
    if (error instanceof InvalidImageError) throw GenerationError.permanent(error.message);
    throw error;
  }

  if (!openAiImageProvider.capabilities?.outputMimeTypes.includes(metadata.mimeType)) {
    throw GenerationError.permanent(
      `The provider returned ${metadata.mimeType}, which this adapter does not expect from ${OPENAI_IMAGE_MODEL}`
    );
  }

  return {
    data: bytes,
    mimeType: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
  };
}

/** Refuses an unsupported size rather than quietly substituting one. */
function resolveSize(requested: string | undefined): OpenAiImageSize {
  if (!requested) return DEFAULT_SIZE;
  if ((OPENAI_IMAGE_SIZES as readonly string[]).includes(requested)) {
    return requested as OpenAiImageSize;
  }
  throw GenerationError.permanent(
    `${OPENAI_IMAGE_MODEL} cannot render ${requested}. It supports ${OPENAI_IMAGE_SIZES.join(", ")}.`
  );
}

function assertPromptFits(prompt: string): void {
  if (prompt.trim() === "") {
    throw GenerationError.permanent("The prompt was empty");
  }
  if (prompt.length > MAX_PROMPT_CHARACTERS) {
    // Truncating would silently drop the end of a compiled prompt — often the
    // lighting and mood — and the filmmaker would never know which.
    throw GenerationError.permanent(
      `The prompt is ${prompt.length} characters; ${OPENAI_IMAGE_MODEL} accepts at most ${MAX_PROMPT_CHARACTERS}. Shorten it rather than letting it be cut off mid-description.`
    );
  }
}

async function post(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(`${baseUrl()}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // A transport failure — DNS, TLS, a reset, our own timeout — is exactly the
    // kind of thing that works on the next attempt.
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

/**
 * Turns a response into image bytes, or into a correctly-classified failure.
 *
 * Nothing here trusts the provider: the status is checked, the body is checked
 * for being JSON at all, the payload is checked for actually containing image
 * data, and the decoded bytes are checked for being an image.
 */
async function parseImageResponse(response: Response): Promise<Buffer> {
  if (!response.ok) throw classifyHttpFailure(response, await safeText(response));

  const raw = await safeText(response);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // A 200 that is not JSON means something between us and the provider
    // answered — a proxy, a captive portal, a gateway error page.
    throw GenerationError.retryable(
      `The provider returned a non-JSON body with status 200: ${summarise(raw)}`
    );
  }

  const b64 = extractBase64(json);
  if (!b64) {
    throw GenerationError.permanent(
      `The provider's response contained no image data: ${summarise(raw)}`
    );
  }

  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength === 0) {
    throw GenerationError.permanent("The provider returned an empty image");
  }
  return bytes;
}

function extractBase64(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (!first || typeof first !== "object") return undefined;
  const b64 = (first as { b64_json?: unknown }).b64_json;
  return typeof b64 === "string" && b64.length > 0 ? b64 : undefined;
}

/**
 * Maps an HTTP failure onto the retry policy.
 *
 * The distinction that matters: 401 and 400 will fail identically forever and
 * must not consume attempts, while 429 and 5xx are the provider having a moment.
 */
function classifyHttpFailure(response: Response, body: string): GenerationError {
  const detail = providerMessage(body) ?? summarise(body);
  const status = response.status;

  if (status === 401 || status === 403) {
    return GenerationError.permanent(
      `The provider rejected the credentials (${status}). Check OPENAI_API_KEY. — ${detail}`
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    // A rejected prompt, an unknown model, an invalid parameter.
    return GenerationError.permanent(`The provider rejected the request (${status}): ${detail}`);
  }
  if (status === 429) {
    const retryAfter = retryAfterSeconds(response);
    return GenerationError.retryable(
      `Rate limited by the provider (429)${retryAfter ? `, retry after ${retryAfter}s` : ""}: ${detail}`
    );
  }
  if (status >= 500) {
    return GenerationError.retryable(`The provider failed (${status}): ${detail}`);
  }
  // An unexpected status is treated as transient but stays bounded by the
  // attempt ceiling, which is the safer way round for something unrecognised.
  return GenerationError.retryable(`Unexpected provider status ${status}: ${detail}`);
}

/**
 * Reads the provider's own retry hint, where it gives one.
 *
 * Exported so the worker's scheduling can honour it. Note what this is *not*: a
 * rate limiter. Nothing here paces requests ahead of time — see README.
 */
export function retryAfterSeconds(response: Response): number | undefined {
  const header =
    response.headers.get("retry-after") ??
    response.headers.get("x-ratelimit-reset-requests") ??
    undefined;
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3_600);

  // Retry-After may also be an HTTP date.
  const at = Date.parse(header);
  if (Number.isFinite(at)) {
    return Math.max(0, Math.min(3_600, Math.round((at - Date.now()) / 1000)));
  }
  return undefined;
}

/** Pulls the provider's own error text out of its JSON envelope, if it sent one. */
function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed?.error?.message;
    return typeof message === "string" ? message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/** A short, safe excerpt of a response body for an error message. */
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
