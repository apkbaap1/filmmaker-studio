import { STUB_CLIP_WEBM_BASE64 } from "./stub-clip.ts";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
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
 * It holds no credentials, so unlike the OpenAI adapter it is safe to import
 * from a test. It is only registered when VIDEO_PROVIDER=local-stub.
 */

interface StubJob {
  request: VideoGenerationRequest;
  readyAt: number;
  failWith?: string;
}

const jobs = new Map<string, StubJob>();
let counter = 0;

/** How long a stub job stays PROCESSING, so the async states are observable. */
function processingMs(): number {
  const raw = Number(process.env.VIDEO_STUB_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

export const localStubVideoProvider: VideoGenerationProvider = {
  id: "local-stub",
  label: "Local stub (no external provider)",
  model: "local-stub-v1",
  capabilities: { imageToVideo: true, maxDurationSeconds: 30 },

  isConfigured: () => true,

  async submit(request) {
    // A real adapter rejects a mode it cannot serve rather than silently
    // degrading to text-to-video, so the stub does too.
    let failWith: string | undefined;
    if (request.mode === "image-to-video" && !request.sourceImage) {
      failWith = "Image-to-video was requested without a source frame";
    }
    if (request.prompt.trim() === "") {
      failWith = "The prompt was empty";
    }

    const providerJobId = `stub-job-${++counter}`;
    jobs.set(providerJobId, { request, readyAt: Date.now() + processingMs(), failWith });
    return { providerJobId };
  },

  async poll(providerJobId): Promise<VideoJobResult> {
    const job = jobs.get(providerJobId);
    if (!job) return { status: "failed", error: `Unknown job ${providerJobId}` };
    if (job.failWith) return { status: "failed", error: job.failWith };
    if (Date.now() < job.readyAt) return { status: "processing" };

    return {
      status: "completed",
      video: { data: Buffer.from(STUB_CLIP_WEBM_BASE64, "base64"), mimeType: "video/webm" },
    };
  },
};

/** Test-only: what the adapter was actually handed for a given job. */
export function stubJobRequest(providerJobId: string): VideoGenerationRequest | undefined {
  return jobs.get(providerJobId)?.request;
}

/** Test-only: forget every recorded job. */
export function resetStubJobs(): void {
  jobs.clear();
  counter = 0;
}
