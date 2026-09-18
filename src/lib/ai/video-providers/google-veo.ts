import "server-only";

import { GenerationError } from "@/lib/jobs/state";
import { MAX_BYTES } from "@/lib/media";
import { downloadWithLimit, MediaDownloadError } from "../media-download.ts";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
} from "./types.ts";

/**
 * Google Veo 3.1 via the Gemini Developer API — the application's first real
 * video provider.
 *
 * Everything Google-specific lives in this file: the endpoint, the header, the
 * request shape, the operation lifecycle, the result path and which failures
 * are worth retrying. The worker, the compiler, the CinematicPromptSpec and the
 * Shot model know none of it.
 *
 * ## API
 *
 *   POST {base}/models/{model}:predictLongRunning   → Operation
 *   GET  {base}/{operation.name}                    → Operation (poll)
 *   GET  {base}/files/{id}:download?alt=media       → the bytes
 *   auth: x-goog-api-key: $GOOGLE_API_KEY
 *
 * The key is read here and nowhere else, in a module the bundler will not admit
 * to a client component. It is never returned, never logged, never stored, and
 * never interpolated into an error message — see `veo-adapter.test.ts`, which
 * asserts that for every failure path.
 *
 * ## Provenance of this contract
 *
 * `docs/veo-api-contract.md` records where each field came from. In short:
 *
 *   - The endpoint, the `instances`/`parameters` envelope and the operation
 *     schema are from Google's v1beta discovery document (revision 20260918).
 *   - The field *names* inside `instances` and `parameters` are from Google's
 *     published SDK `@google/genai@2.23.0`, whose `*ToMldev` transformers are
 *     the code that builds this backend's wire format. They are NOT from the
 *     probe: the API types both containers as `any` and answers every malformed
 *     shape with a generic message and no field violations, so probing cannot
 *     reach them.
 *   - The accepted *values* in ALLOWED_DURATIONS / ALLOWED_RESOLUTIONS /
 *     ALLOWED_ASPECT_RATIOS, and the resolution→duration rules, were supplied
 *     by the filmmaker from Google's Veo 3.1 documentation. They could not be
 *     verified here: ai.google.dev is blocked by this environment's egress
 *     proxy, and no other available source carries per-model value ranges. They
 *     are therefore asserted, not measured. If Google rejects a combination
 *     this file allows, the rejection is surfaced verbatim rather than worked
 *     around — see `classifyHttpFailure`.
 *
 * ## What this adapter will not do
 *
 * It does not rewrite the prompt: `enhancePrompt` is sent explicitly false
 * rather than omitted, so Google's own rewriting cannot silently alter a
 * filmmaker's decisions. It does not truncate an over-long prompt, does not
 * substitute a parameter value it believes is more likely to be accepted, and
 * does not invent a duration, resolution or aspect ratio that was never chosen.
 * Unspecified stays unspecified: an omitted parameter is left out of the
 * request entirely.
 */

/** The three models this account exposes, all `predictLongRunning`-only. */
export const GOOGLE_VEO_MODELS = [
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-lite-generate-preview",
] as const;

export type GoogleVeoModel = (typeof GOOGLE_VEO_MODELS)[number];

const DEFAULT_MODEL: GoogleVeoModel = "veo-3.1-generate-preview";

/** Supplied by the filmmaker from Google's documentation. Not verified here. */
export const ALLOWED_DURATIONS_SECONDS = [4, 6, 8] as const;
export const ALLOWED_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const ALLOWED_RESOLUTIONS = ["720p", "1080p", "4k"] as const;

/**
 * Resolutions that Google documents as available at one clip length only.
 *
 * The rule is enforced *before* the request is sent, so an incompatible pair
 * costs nothing and fails with a message naming both halves. It is never
 * resolved by quietly changing one of them: which of the two to give up is the
 * filmmaker's decision, not the adapter's.
 */
const FIXED_DURATION_RESOLUTIONS: Record<string, number> = {
  "1080p": 8,
  "4k": 8,
};

/**
 * A prompt this long is over the 480-token budget under any tokenisation, so
 * rejecting it costs nothing and saves a guaranteed provider rejection.
 *
 * Deliberately far above the real limit. Veo's tokeniser is not available here,
 * so a tight character estimate would reject prompts that would in fact be
 * accepted — and silently dropping a filmmaker's words to fit is exactly what
 * this pipeline exists to prevent. Everything between a normal prompt and this
 * ceiling is left for Google to judge, and its verdict is surfaced as-is.
 */
const CERTAINLY_OVER_BUDGET_CHARACTERS = 5_000;

const REQUEST_TIMEOUT_MS = 180_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;

function baseUrl(): string {
  return (
    process.env.GOOGLE_API_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");
}

function configuredModel(): GoogleVeoModel {
  const requested = process.env.GOOGLE_VEO_MODEL?.trim();
  if (!requested) return DEFAULT_MODEL;
  const match = GOOGLE_VEO_MODELS.find((m) => m === requested);
  if (!match) {
    throw GenerationError.permanent(
      `GOOGLE_VEO_MODEL is set to "${requested}", which is not one of: ${GOOGLE_VEO_MODELS.join(", ")}`
    );
  }
  return match;
}

export function isVideoGenerationConfigured(): boolean {
  return Boolean(process.env.GOOGLE_API_KEY);
}

/**
 * Reads the credential.
 *
 * Returns it rather than storing it in module scope so that a key configured
 * after import is still seen, and so nothing holds it longer than one request.
 * The thrown message names the variable, never the value.
 */
function credential(): string {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    throw GenerationError.permanent(
      "GOOGLE_API_KEY is not set on the server, so no video can be generated."
    );
  }
  return key;
}

export const googleVeoVideoProvider: VideoGenerationProvider = {
  id: "google-veo",
  label: "Google Veo 3.1",
  get model(): string {
    // A getter, so an env change is reflected without a reimport, and so the
    // audit trail records the model actually used for this generation.
    try {
      return configuredModel();
    } catch {
      return DEFAULT_MODEL;
    }
  },
  capabilities: {
    kind: "real",
    imageToVideo: true,
    maxDurationSeconds: 8,
    allowedDurationsSeconds: [...ALLOWED_DURATIONS_SECONDS],
  },
  /**
   * `predictLongRunning` exposes no idempotency facility, and nothing in the
   * discovery document or the SDK provides one, so this is false. The worker
   * therefore parks a crash between "submitted" and "job id recorded" as
   * INDETERMINATE rather than resubmitting — which is correct, because a
   * resubmission here would start and bill a second render.
   */
  supportsIdempotencyKey: false,
  isConfigured: isVideoGenerationConfigured,
  submit,
  poll,
};

// --- submit -----------------------------------------------------------------

export interface VeoRequestBody {
  instances: Array<Record<string, unknown>>;
  parameters?: Record<string, unknown>;
}

/**
 * Builds the wire body.
 *
 * Exported so the tests can assert the exact JSON without a network round trip,
 * and so the validation rules are testable in isolation from HTTP.
 */
export function buildRequestBody(request: VideoGenerationRequest): VeoRequestBody {
  assertPromptPresent(request);
  assertPromptFits(request.prompt);
  assertModeConsistent(request);

  const duration = validateDuration(request.durationSeconds);
  const aspectRatio = validateAspectRatio(request.aspectRatio);
  const resolution = validateResolution(request.resolution);
  assertResolutionDurationCompatible(resolution, duration);

  const instance: Record<string, unknown> = { prompt: request.prompt };
  if (request.sourceImage) {
    instance.image = {
      bytesBase64Encoded: request.sourceImage.data.toString("base64"),
      mimeType: request.sourceImage.mimeType,
    };
  }

  const parameters: Record<string, unknown> = {
    sampleCount: 1,
    // Explicit, not omitted: Google's prompt rewriting must never be inherited
    // from a server-side default. See the header.
    enhancePrompt: false,
  };
  if (duration !== undefined) parameters.durationSeconds = duration;
  if (aspectRatio !== undefined) parameters.aspectRatio = aspectRatio;
  if (resolution !== undefined) parameters.resolution = resolution;

  return { instances: [instance], parameters };
}

async function submit(request: VideoGenerationRequest): Promise<VideoJobHandle> {
  const model = configuredModel();
  const body = buildRequestBody(request);

  const response = await send(`${baseUrl()}/models/${model}:predictLongRunning`, {
    method: "POST",
    body: JSON.stringify(body),
    contentType: true,
  });

  if (!response.ok) throw classifyHttpFailure(response.status, await safeText(response));

  const operation = await parseJson(response);
  const name = readOperationName(operation);
  if (!name) {
    throw GenerationError.indeterminate(
      "Google accepted the request but returned no operation name, so it is not known whether a render was started. It was not resubmitted, because that could bill a second one."
    );
  }
  return { providerJobId: name };
}

// --- poll -------------------------------------------------------------------

async function poll(providerJobId: string): Promise<VideoJobResult> {
  // The operation name is the path, exactly as returned.
  const response = await send(`${baseUrl()}/${stripLeadingSlash(providerJobId)}`, {
    method: "GET",
  });

  if (!response.ok) throw classifyHttpFailure(response.status, await safeText(response));

  const operation = (await parseJson(response)) as Record<string, unknown>;

  if (operation.done !== true) return { status: "processing" };

  if (operation.error) {
    return { status: "failed", error: describeOperationError(operation.error) };
  }

  const uri = readVideoUri(operation);
  if (!uri) {
    // done, no error, no sample: Google filtered the result. Reported as a
    // failure rather than retried — the same prompt will be filtered again.
    return { status: "failed", error: describeMissingSample(operation) };
  }

  const bytes = await downloadVideo(uri);
  return {
    status: "completed",
    video: { data: bytes.bytes, mimeType: bytes.contentType ?? "video/mp4" },
  };
}

/**
 * Fetches the rendered clip through the server, under the same 500 MB ceiling
 * the storage layer enforces.
 *
 * The returned URI is a Files API resource, not a public link: the credential
 * is required on this request too. The cap is enforced during the transfer by
 * `downloadWithLimit`, so an oversized render is abandoned mid-stream rather
 * than buffered and then rejected.
 */
async function downloadVideo(uri: string): Promise<{ bytes: Buffer; contentType?: string }> {
  const url = downloadUrlFor(uri);
  try {
    const result = await downloadWithLimit(url, {
      maxBytes: MAX_BYTES.video,
      headers: { "x-goog-api-key": credential() },
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return { bytes: result.bytes, contentType: result.contentType };
  } catch (error) {
    if (error instanceof MediaDownloadError) throw classifyDownloadFailure(error);
    throw error;
  }
}

/**
 * Decides whether a failed download is worth another attempt.
 *
 * Only `too-large` is permanent, and for a reason worth stating: it is a
 * property of the render rather than of the network, so every retry would
 * re-download the same oversized file, spend the same bandwidth and fail
 * identically. The other three can all be transient, and stay bounded by the
 * job's attempt ceiling rather than by a judgement made here.
 *
 * Exported so each branch is tested directly — a 500 MB transfer is not
 * something a test suite should perform to reach this code.
 */
export function classifyDownloadFailure(error: MediaDownloadError): GenerationError {
  if (error.kind === "too-large") {
    return GenerationError.permanent(`The generated video is too large to store: ${error.message}`);
  }
  return GenerationError.retryable(
    `Downloading the generated video failed (${error.kind}): ${error.message}`
  );
}

/**
 * Turns the operation's `video.uri` into the authenticated download URL.
 *
 * Google returns an absolute URL; the file id is the segment after `files/`.
 * Rebuilding the URL from our own base rather than following the returned one
 * keeps the request pointed at the configured host.
 */
export function downloadUrlFor(uri: string): string {
  const afterFiles = uri.split("files/")[1];
  if (!afterFiles) {
    throw GenerationError.permanent(
      `Google returned a video URI in an unrecognised form, with no "files/" segment: ${uri}`
    );
  }
  const id = afterFiles.match(/[A-Za-z0-9_-]+/)?.[0];
  if (!id) {
    throw GenerationError.permanent(`Google returned a video URI with no readable file id: ${uri}`);
  }
  return `${baseUrl()}/files/${id}:download?alt=media`;
}

// --- response reading -------------------------------------------------------

function readOperationName(operation: unknown): string | undefined {
  if (!isRecord(operation)) return undefined;
  const name = operation.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * `response.generateVideoResponse.generatedSamples[0].video.uri`
 *
 * Note the singular `generateVideoResponse` wrapping the plural
 * `generatedSamples` — that asymmetry is Google's, not a typo.
 */
export function readVideoUri(operation: unknown): string | undefined {
  if (!isRecord(operation)) return undefined;
  const response = operation.response;
  if (!isRecord(response)) return undefined;
  const inner = response.generateVideoResponse;
  if (!isRecord(inner)) return undefined;
  const samples = inner.generatedSamples;
  if (!Array.isArray(samples) || samples.length === 0) return undefined;
  const first = samples[0];
  if (!isRecord(first)) return undefined;
  const video = first.video;
  if (!isRecord(video)) return undefined;
  return typeof video.uri === "string" && video.uri.length > 0 ? video.uri : undefined;
}

function describeMissingSample(operation: Record<string, unknown>): string {
  const response = isRecord(operation.response) ? operation.response : undefined;
  const inner =
    response && isRecord(response.generateVideoResponse) ? response.generateVideoResponse : undefined;
  const filtered = inner?.raiMediaFilteredCount;
  const reasons = inner?.raiMediaFilteredReasons;

  if (filtered !== undefined && filtered !== 0) {
    const why = Array.isArray(reasons) && reasons.length > 0 ? `: ${reasons.join("; ")}` : "";
    return `Google's safety filters rejected the generated video${why}. The same prompt will be filtered again, so this will not be retried.`;
  }
  return "Google reported the operation complete but returned no video, and gave no reason.";
}

function describeOperationError(error: unknown): string {
  if (!isRecord(error)) return "Google reported the operation failed, without detail.";
  const parts: string[] = [];
  if (typeof error.status === "string") parts.push(error.status);
  if (typeof error.message === "string") parts.push(error.message);
  if (typeof error.code === "number") parts.push(`code ${error.code}`);
  return parts.length > 0 ? parts.join(" — ") : "Google reported the operation failed.";
}

// --- validation -------------------------------------------------------------

function assertPromptPresent(request: VideoGenerationRequest): void {
  if (!request.prompt || request.prompt.trim().length === 0) {
    throw GenerationError.permanent("Veo requires a prompt, and none was supplied.");
  }
}

function assertPromptFits(prompt: string): void {
  if (prompt.length > CERTAINLY_OVER_BUDGET_CHARACTERS) {
    throw GenerationError.permanent(
      `The prompt is ${prompt.length} characters, which is over Veo's 480-token budget under any tokenisation. It was not shortened automatically, because deciding what to cut is the filmmaker's call.`
    );
  }
}

function assertModeConsistent(request: VideoGenerationRequest): void {
  if (request.mode === "image-to-video" && !request.sourceImage) {
    throw GenerationError.permanent(
      "Image-to-video was requested but no source frame was supplied."
    );
  }
  if (request.mode === "text-to-video" && request.sourceImage) {
    throw GenerationError.permanent(
      "Text-to-video was requested but a source frame was supplied. Sending it would silently change the mode."
    );
  }
}

export function validateDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!ALLOWED_DURATIONS_SECONDS.includes(value as (typeof ALLOWED_DURATIONS_SECONDS)[number])) {
    throw GenerationError.permanent(
      `Veo accepts a duration of ${ALLOWED_DURATIONS_SECONDS.join(", ")} seconds; ${value} was requested. It was not rounded to a supported value.`
    );
  }
  return value;
}

export function validateAspectRatio(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ALLOWED_ASPECT_RATIOS.includes(value as (typeof ALLOWED_ASPECT_RATIOS)[number])) {
    throw GenerationError.permanent(
      `Veo accepts an aspect ratio of ${ALLOWED_ASPECT_RATIOS.join(" or ")}; "${value}" was requested.`
    );
  }
  return value;
}

export function validateResolution(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ALLOWED_RESOLUTIONS.includes(value as (typeof ALLOWED_RESOLUTIONS)[number])) {
    throw GenerationError.permanent(
      `Veo accepts a resolution of ${ALLOWED_RESOLUTIONS.join(", ")}; "${value}" was requested.`
    );
  }
  return value;
}

/**
 * Rejects a resolution/duration pair Google documents as unavailable.
 *
 * A fixed-duration resolution with no duration at all is also rejected: the
 * request would otherwise inherit Google's default length, which is not the
 * one this resolution supports, and the filmmaker never chose it.
 */
export function assertResolutionDurationCompatible(
  resolution: string | undefined,
  duration: number | undefined
): void {
  if (resolution === undefined) return;
  const required = FIXED_DURATION_RESOLUTIONS[resolution];
  if (required === undefined) return;

  if (duration === undefined) {
    throw GenerationError.permanent(
      `Veo supports ${resolution} at ${required} seconds only, and no duration was chosen. Set the duration to ${required} seconds, or choose a different resolution.`
    );
  }
  if (duration !== required) {
    throw GenerationError.permanent(
      `Veo supports ${resolution} at ${required} seconds only; ${duration} seconds was requested. Neither value was changed automatically.`
    );
  }
}

// --- HTTP -------------------------------------------------------------------

async function send(
  url: string,
  init: { method: string; body?: string; contentType?: boolean }
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        "x-goog-api-key": credential(),
        ...(init.contentType ? { "content-type": "application/json" } : {}),
      },
      body: init.body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    if (controller.signal.aborted) {
      throw GenerationError.retryable(
        `Google did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
      );
    }
    throw GenerationError.retryable(`Could not reach Google: ${describe(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps an HTTP status to a retry decision.
 *
 * The detail comes from Google's own error body, which is safe to include: it
 * describes the request, never the credential. The key is not interpolated
 * anywhere in this function, and `veo-adapter.test.ts` asserts that for each
 * branch.
 */
function classifyHttpFailure(status: number, body: string): GenerationError {
  const detail = providerMessage(body) ?? summarise(body);

  if (status === 401 || status === 403) {
    return GenerationError.permanent(
      `Google rejected the credentials (${status}). Check GOOGLE_API_KEY, that the Gemini API is enabled on its project, and that billing is enabled. — ${detail}`
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return GenerationError.permanent(`Google rejected the request (${status}): ${detail}`);
  }
  if (status === 429) {
    return GenerationError.retryable(`Rate limited or out of quota (429): ${detail}`);
  }
  if (status >= 500) {
    return GenerationError.retryable(`Google failed (${status}): ${detail}`);
  }
  return GenerationError.retryable(`Unexpected status ${status} from Google: ${detail}`);
}

function providerMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message;
      const status = parsed.error.status;
      if (typeof message === "string") {
        return typeof status === "string" ? `${status}: ${message}` : message;
      }
    }
  } catch {
    // not JSON; fall through to the summary
  }
  return undefined;
}

function summarise(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "no response body";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await safeText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw GenerationError.retryable(
      `Google returned a response that is not JSON: ${summarise(text)}`
    );
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
