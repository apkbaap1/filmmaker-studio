import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { STUB_CLIP_WEBM_BASE64 } from "./stub-clip.ts";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
} from "./types.ts";

/**
 * A local, deterministic stand-in for a real video provider.
 *
 * It exists because no video platform has been chosen for this project yet, and
 * because the pipeline needs something to exercise end to end. It is NOT a
 * simulation of any particular provider's behaviour or quality: it returns the
 * same short labelled placeholder clip for every prompt, and it does not honour
 * the requested duration. Anything it produces is evidence that the *pipeline*
 * works, never that generation works.
 *
 * ## Why its job store is on disk
 *
 * A real provider is a separate system: it keeps running when the worker dies,
 * and the job is still there afterwards. An in-memory Map does not behave that
 * way — restart the worker and every job evaporates, which would make
 * crash-recovery look like it works when it has not been tested at all. So the
 * stub keeps jobs as small files under a directory of its own, and survives
 * exactly as an external provider would.
 *
 * It holds no credentials, so unlike the OpenAI adapter it is safe to import
 * from a test. It is only registered when VIDEO_PROVIDER=local-stub.
 */

interface StubJob {
  providerJobId: string;
  idempotencyKey?: string;
  prompt: string;
  mode: string;
  durationSeconds?: number;
  /** Stored base64 so the file round-trips, and rehydrated to a Buffer on read. */
  sourceImage?: { data: string; mimeType: string };
  readyAt: number;
  failWith?: string;
}

/** What a caller sees: the same shape it submitted, with real Buffers. */
export interface RecordedStubJob extends Omit<StubJob, "sourceImage"> {
  sourceImage?: { data: Buffer; mimeType: string };
}

function rehydrate(job: StubJob): RecordedStubJob {
  return {
    ...job,
    sourceImage: job.sourceImage
      ? { data: Buffer.from(job.sourceImage.data, "base64"), mimeType: job.sourceImage.mimeType }
      : undefined,
  };
}

function jobsDir(): string {
  return process.env.VIDEO_STUB_DIR || path.join(os.tmpdir(), "filmmaker-stub-jobs");
}

/** How long a stub job stays PROCESSING, so the async states are observable. */
function processingMs(): number {
  const raw = Number(process.env.VIDEO_STUB_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

function jobFile(providerJobId: string): string {
  // The id is generated here and never taken from a caller, but it still ends
  // up as a filename, so it is hashed rather than trusted.
  const safe = createHash("sha256").update(providerJobId).digest("hex").slice(0, 32);
  return path.join(jobsDir(), `${safe}.json`);
}

function readJob(providerJobId: string): StubJob | undefined {
  try {
    return JSON.parse(readFileSync(jobFile(providerJobId), "utf8")) as StubJob;
  } catch {
    return undefined;
  }
}

function writeJob(job: StubJob): void {
  mkdirSync(jobsDir(), { recursive: true });
  writeFileSync(jobFile(job.providerJobId), JSON.stringify(job), "utf8");
}

function allJobs(): StubJob[] {
  try {
    return readdirSync(jobsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(jobsDir(), f), "utf8")) as StubJob;
        } catch {
          return undefined;
        }
      })
      .filter((j): j is StubJob => j !== undefined);
  } catch {
    return [];
  }
}

export const localStubVideoProvider: VideoGenerationProvider = {
  id: "local-stub",
  label: "Local stub (no external provider)",
  model: "local-stub-v1",
  capabilities: { kind: "stub", imageToVideo: true, maxDurationSeconds: 30 },

  // The stub really does honour the key — see `submit` — so this is a claim it
  // can back up rather than a convenience.
  supportsIdempotencyKey: true,

  isConfigured: () => true,

  async submit(request: VideoGenerationRequest): Promise<VideoJobHandle> {
    // Submitting the same key twice returns the first job. This is what a
    // provider with real idempotency support does, and it is what lets the
    // worker recover from a crash between submitting and recording the id.
    if (request.idempotencyKey) {
      const existing = allJobs().find((j) => j.idempotencyKey === request.idempotencyKey);
      if (existing) return { providerJobId: existing.providerJobId };
    }

    // A real adapter rejects a mode it cannot serve rather than silently
    // degrading to text-to-video, so the stub does too.
    let failWith: string | undefined;
    if (request.mode === "image-to-video" && !request.sourceImage) {
      failWith = "Image-to-video was requested without a source frame";
    }
    if (request.prompt.trim() === "") {
      failWith = "The prompt was empty";
    }

    // Derived from the key when there is one, so the id is stable across a
    // resubmission even if the lookup above somehow misses.
    const providerJobId = request.idempotencyKey
      ? `stub-job-${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 16)}`
      : `stub-job-${createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)}`;

    writeJob({
      providerJobId,
      idempotencyKey: request.idempotencyKey,
      prompt: request.prompt,
      mode: request.mode,
      durationSeconds: request.durationSeconds,
      sourceImage: request.sourceImage
        ? {
            data: request.sourceImage.data.toString("base64"),
            mimeType: request.sourceImage.mimeType,
          }
        : undefined,
      readyAt: Date.now() + processingMs(),
      failWith,
    });
    return { providerJobId };
  },

  async poll(providerJobId: string): Promise<VideoJobResult> {
    const job = readJob(providerJobId);
    if (!job) return { status: "failed", error: `Unknown job ${providerJobId}` };
    if (job.failWith) return { status: "failed", error: job.failWith };
    if (Date.now() < job.readyAt) return { status: "processing" };

    return {
      status: "completed",
      video: { data: Buffer.from(STUB_CLIP_WEBM_BASE64, "base64"), mimeType: "video/webm" },
    };
  },

  async findJobByIdempotencyKey(key: string): Promise<VideoJobHandle | undefined> {
    const existing = allJobs().find((j) => j.idempotencyKey === key);
    return existing ? { providerJobId: existing.providerJobId } : undefined;
  },
};

/** Test-only: what the adapter was actually handed for a given job. */
export function stubJobRequest(providerJobId: string): RecordedStubJob | undefined {
  const job = readJob(providerJobId);
  return job ? rehydrate(job) : undefined;
}

/** Test-only: how many jobs the stub has ever been asked to start. */
export function stubJobCount(): number {
  return allJobs().length;
}

/** Test-only: forget every recorded job. */
export function resetStubJobs(): void {
  if (existsSync(jobsDir())) rmSync(jobsDir(), { recursive: true, force: true });
}
