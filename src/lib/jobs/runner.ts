import "server-only";

import { Prisma } from "@prisma/client";
import type { Generation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  MediaTooLargeError,
  UnsupportedMediaError,
  readAssetBytes,
  reserveProjectMediaKey,
  storeProjectMedia,
} from "@/lib/media";
import { getImageProvider } from "@/lib/ai/image-providers";
import { getVideoProvider } from "@/lib/ai/video-providers";
import { InvalidVideoError, readVideoMetadata } from "@/lib/ai/video-metadata";
import { GenerationError, classify, shouldRetry, type FailureKind } from "./state";
import { releaseForRetry, updateLeased, type Lease, type Db } from "./queue";
import type { PrismaClient } from "@prisma/client";
import { jobLog } from "./log";

/**
 * What a worker actually does with a claimed job.
 *
 * The worker loop knows nothing about providers and this module knows nothing
 * about scheduling: the loop claims and this runs one step. Every provider call
 * goes through the `ImageGenerationProvider` / `VideoGenerationProvider`
 * interfaces — there is no HTTP here and no vendor name anywhere.
 *
 * ## The shape of one step
 *
 * A step is short by design. An asynchronous video job is submitted, its id is
 * recorded, and the job goes back to AWAITING_PROVIDER with the lease released,
 * so no worker is held for the minutes a render takes. A later step claims it
 * again and polls once. That is what keeps N workers able to carry far more
 * than N in-flight generations.
 *
 * ## Ordering, and why it is this way round
 *
 * Completion is: reserve a key → write the bytes → in ONE transaction, create
 * the Asset and mark the job COMPLETED. The key is reserved and recorded
 * *before* the write so that an interrupted write leaves a known object rather
 * than an untracked one, and so a retry rewrites the same key instead of
 * littering the bucket. The Asset and the status move together so that
 * COMPLETED can never mean "we lost the file".
 */

export type StepOutcome =
  | { kind: "completed"; assetId: string }
  | { kind: "submitted"; providerJobId: string }
  | { kind: "still-processing" }
  | { kind: "retry-scheduled"; reason: string }
  | { kind: "failed"; failureKind: FailureKind; reason: string }
  | { kind: "lease-lost" };

interface StagedMedia {
  storageProvider: "LOCAL" | "S3";
  storageKey: string;
  mimeType: string;
}

/**
 * The provider-native size frozen on the job at submission.
 *
 * Undefined for a generation queued before the column existed, or by a path that
 * records none — in which case the adapter uses its own default, which is what
 * happened at the time anyway.
 */
function requestedSize(generation: Generation): string | undefined {
  const params = generation.requestedParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const size = (params as Record<string, unknown>).size;
  return typeof size === "string" ? size : undefined;
}

/** Reads the real/stub flag frozen on the job at submission. */
function providerKindFor(generation: Generation): string | undefined {
  const params = generation.requestedParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const kind = (params as Record<string, unknown>).providerKind;
  return typeof kind === "string" ? kind : undefined;
}

function stagedFrom(value: Prisma.JsonValue | null): StagedMedia | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { storageProvider, storageKey, mimeType } = record;
  if (
    (storageProvider === "LOCAL" || storageProvider === "S3") &&
    typeof storageKey === "string" &&
    typeof mimeType === "string"
  ) {
    return { storageProvider, storageKey, mimeType };
  }
  return undefined;
}

/** Truncated and stripped of anything that could carry a credential. */
function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return raw
    // A presigned URL's query carries a signature; a bare host is enough to debug.
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?[redacted]")
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

/**
 * Runs one step of a claimed job.
 *
 * Every write is conditional on the lease still being held, so a worker that
 * has been slow enough to lose its job cannot overwrite the new owner's result.
 * When that happens the step stops with `lease-lost` — a normal outcome, not an
 * error.
 */
export async function runJobStep(
  generationId: string,
  lease: Lease,
  now = new Date(),
  db: Db = prisma
): Promise<StepOutcome> {
  const generation = await db.generation.findUnique({ where: { id: generationId } });
  if (!generation) return { kind: "lease-lost" };

  try {
    if (generation.mode === "IMAGE") return await runImageStep(generation, lease, now, db);
    return await runVideoStep(generation, lease, now, db);
  } catch (error) {
    return failOrRetry(generation, lease, error, now, db);
  }
}

// --- image: the provider returns bytes inline --------------------------------

async function runImageStep(
  generation: Generation,
  lease: Lease,
  now: Date,
  db: Db
): Promise<StepOutcome> {
  const provider = getImageProvider(generation.providerId);

  // Recorded before the call, so a crash during it is visible afterwards.
  if (
    !(await updateLeased(
      lease,
      { submissionAttemptedAt: now, model: provider.model },
      db
    ))
  ) {
    return { kind: "lease-lost" };
  }

  const image = await provider.generate({
    // The prompt is read from the job, never recompiled. A shot edited after
    // queuing does not change what is already in flight.
    prompt: generation.promptUsed,
    // Likewise the size: what was requested at submission, not what the
    // adapter's default happens to be today.
    size: requestedSize(generation),
    idempotencyKey: generation.idempotencyKey,
  });

  return storeAndComplete(generation, lease, image.data, image.mimeType, "IMAGE", now, db, {
    width: image.width,
    height: image.height,
  });
}

// --- video: submit, let go, poll later ---------------------------------------

async function runVideoStep(
  generation: Generation,
  lease: Lease,
  now: Date,
  db: Db
): Promise<StepOutcome> {
  const provider = getVideoProvider(generation.providerId);

  if (generation.providerJobId) {
    return pollVideo(generation, lease, generation.providerJobId, now, db);
  }

  // Recovery: a previous attempt reached the provider but did not get as far as
  // recording the job id. Resubmitting blindly here is how a filmmaker ends up
  // paying twice for one clip.
  if (generation.submissionAttemptedAt) {
    const recovered = await recoverSubmission(generation, provider);
    if (recovered) {
      if (!(await recordSubmission(lease, recovered, now, db))) return { kind: "lease-lost" };
      return pollVideo(generation, lease, recovered, now, db);
    }
    if (!provider.supportsIdempotencyKey) {
      // Neither a lookup nor an idempotency key: we genuinely cannot tell
      // whether a job exists. Parked rather than guessed — see the state
      // machine's INDETERMINATE.
      throw GenerationError.indeterminate(
        "A previous attempt reached the provider but did not record a job id, and this provider offers no idempotency key or job lookup. It was not resubmitted, because that could create a second billed job. Retry explicitly if you have checked the provider."
      );
    }
    // Falls through: the key makes a resubmission safe.
  }

  const sourceImage = await loadSourceFrame(generation, db);

  if (!(await updateLeased(lease, { submissionAttemptedAt: now, model: provider.model }, db))) {
    return { kind: "lease-lost" };
  }

  const { providerJobId } = await provider.submit({
    prompt: generation.promptUsed,
    mode: generation.mode === "IMAGE_TO_VIDEO" ? "image-to-video" : "text-to-video",
    durationSeconds: generation.durationSeconds ?? undefined,
    aspectRatio: generation.aspectRatio ?? undefined,
    resolution: generation.resolution ?? undefined,
    sourceImage,
    idempotencyKey: generation.idempotencyKey,
  });

  if (!(await recordSubmission(lease, providerJobId, now, db))) return { kind: "lease-lost" };

  jobLog("submitted", generation, { providerJobId, model: provider.model });
  return { kind: "submitted", providerJobId };
}

async function recoverSubmission(
  generation: Generation,
  provider: ReturnType<typeof getVideoProvider>
): Promise<string | undefined> {
  if (!provider.findJobByIdempotencyKey) return undefined;
  try {
    const found = await provider.findJobByIdempotencyKey(generation.idempotencyKey);
    return found?.providerJobId;
  } catch {
    // A lookup that fails tells us nothing; fall back to the rules above.
    return undefined;
  }
}

/**
 * Records the provider's job id and hands the job back to the queue.
 *
 * The lease is released here on purpose: the provider now owns the work, and
 * holding a worker while it renders would defeat the point of the async
 * interface.
 */
async function recordSubmission(
  lease: Lease,
  providerJobId: string,
  now: Date,
  db: Db
): Promise<boolean> {
  return updateLeased(
    lease,
    {
      providerJobId,
      submittedAt: now,
      status: "AWAITING_PROVIDER",
      nextAttemptAt: new Date(now.getTime() + pollIntervalMs()),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: null,
      failureKind: null,
    },
    db
  );
}

function pollIntervalMs(): number {
  const raw = Number(process.env.GENERATION_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
}

async function pollVideo(
  generation: Generation,
  lease: Lease,
  providerJobId: string,
  now: Date,
  db: Db
): Promise<StepOutcome> {
  const result = await getVideoProvider(generation.providerId).poll(providerJobId);

  if (result.status === "processing") {
    // Back to AWAITING_PROVIDER without spending the attempt budget: waiting is
    // not failing, and a slow render must not exhaust a job's retries.
    const released = await updateLeased(
      lease,
      {
        status: "AWAITING_PROVIDER",
        nextAttemptAt: new Date(now.getTime() + pollIntervalMs()),
        attempts: { decrement: 1 },
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      db
    );
    return released ? { kind: "still-processing" } : { kind: "lease-lost" };
  }

  if (result.status === "failed") {
    // The provider reached a verdict, so this is its answer rather than a blip.
    throw GenerationError.permanent(result.error);
  }

  // Measured from the returned bytes, exactly as the image path measures a
  // still. Until now a generated clip's width, height and duration stayed null
  // until a browser happened to play it — so a clip nobody opened had no
  // recorded length, and the timeline silently fell back to the shot's
  // *intended* duration instead.
  let measured;
  try {
    measured = readVideoMetadata(result.video.data);
  } catch (error) {
    // A provider that returns something unreadable will do so again: an HTML
    // error page, a truncated download or a container this application cannot
    // measure are all permanent as far as this job is concerned.
    if (error instanceof InvalidVideoError) throw GenerationError.permanent(error.message);
    throw error;
  }

  return storeAndComplete(
    generation,
    lease,
    result.video.data,
    // The container decides the type, not the provider's claim about it.
    measured.mimeType,
    "VIDEO",
    now,
    db,
    {
      width: measured.width,
      height: measured.height,
      durationSeconds: measured.durationSeconds ?? undefined,
    }
  );
}

async function loadSourceFrame(
  generation: Generation,
  db: Db
): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (!generation.sourceAssetId) return undefined;

  // Resolved through the job's own projectId — never a client-supplied one — so
  // the worker cannot be steered at another project's media.
  const asset = await db.asset.findFirst({
    where: { id: generation.sourceAssetId, projectId: generation.projectId },
    select: {
      id: true,
      projectId: true,
      storageProvider: true,
      storageKey: true,
      mimeType: true,
      fileSize: true,
    },
  });
  if (!asset) {
    throw GenerationError.permanent("The source frame is no longer available in this project");
  }
  return { data: await readAssetBytes(asset), mimeType: asset.mimeType };
}

// --- completion --------------------------------------------------------------

/**
 * Stores the media and records the result atomically.
 *
 * Three steps, in an order chosen so every interruption is recoverable:
 *
 *   1. reserve a key and write it to the job    (crash here → nothing written)
 *   2. put the bytes at that key                (crash here → a known object,
 *                                                rewritten identically on retry)
 *   3. create the Asset and mark COMPLETED in one transaction
 *                                               (crash here → job stays
 *                                                un-completed, step 2 repeats
 *                                                against the same key)
 *
 * Nothing is ever marked COMPLETED before the bytes are safely stored.
 */
async function storeAndComplete(
  generation: Generation,
  lease: Lease,
  body: Buffer,
  mimeType: string,
  assetType: "IMAGE" | "VIDEO",
  now: Date,
  db: Db,
  /**
   * Measured from the returned bytes. Absent when nothing could measure them,
   * in which case the Asset records null rather than a number nobody measured.
   * `durationSeconds` applies to video only; a still has no time axis.
   */
  measured: { width?: number; height?: number; durationSeconds?: number } = {}
): Promise<StepOutcome> {
  let staged = stagedFrom(generation.stagedMedia);
  if (!staged) {
    try {
      staged = { ...reserveProjectMediaKey(generation.projectId, mimeType), mimeType };
    } catch (error) {
      // An adapter that hands back a media type the application does not accept,
      // or something far too large, will do exactly the same thing next time.
      // That is a permanent fault in the adapter, not a blip worth retrying.
      if (error instanceof UnsupportedMediaError || error instanceof MediaTooLargeError) {
        throw GenerationError.permanent(
          `The provider returned media this application does not accept: ${sanitizeError(error)}`
        );
      }
      throw error;
    }
  }

  if (
    !(await updateLeased(
      lease,
      { stagedMedia: staged as unknown as Prisma.InputJsonValue },
      db
    ))
  ) {
    return { kind: "lease-lost" };
  }

  let stored;
  try {
    stored = await storeProjectMedia(generation.projectId, body, mimeType, {
      key: staged.storageKey,
    });
  } catch (error) {
    if (error instanceof UnsupportedMediaError || error instanceof MediaTooLargeError) {
      throw GenerationError.permanent(
        `The provider returned media this application does not accept: ${sanitizeError(error)}`
      );
    }
    // Any other storage failure is usually transient — a bucket hiccup, a disk
    // that was briefly full — so it is retryable and the reserved key is kept.
    throw GenerationError.retryable(`Could not store the generated media: ${sanitizeError(error)}`);
  }

  // One transaction: the Asset and the status move together, so a COMPLETED job
  // always has an Asset and an Asset from a job is always reachable.
  // A transaction client cannot open a nested transaction, so completion needs
  // the real client. In tests `db` is the client; in the worker it always is.
  const client = db as PrismaClient;
  const assetId = await client.$transaction(async (tx: Prisma.TransactionClient) => {
    const asset = await tx.asset.create({
      data: {
        projectId: generation.projectId,
        sceneId: generation.sceneId,
        shotId: generation.shotId,
        type: assetType,
        source: "GENERATED",
        storageProvider: stored.storageProvider,
        storageKey: stored.storageKey,
        checksum: stored.checksum,
        mimeType: stored.mimeType,
        fileSize: stored.fileSize,
        width: measured.width ?? null,
        height: measured.height ?? null,
        durationSeconds: measured.durationSeconds ?? null,
        prompt: generation.promptUsed,
      },
    });

    const completed = await tx.generation.updateMany({
      where: { id: generation.id, leaseToken: lease.token },
      data: {
        status: "COMPLETED",
        assetId: asset.id,
        completedAt: now,
        error: null,
        failureKind: null,
        stagedMedia: Prisma.DbNull,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      },
    });

    // Losing the lease here means another worker has taken the job over. Rolling
    // back keeps us from leaving a second Asset behind for one generation.
    if (completed.count !== 1) throw new LeaseLostDuringCompletion();
    return asset.id;
  });

  jobLog("completed", generation, {
    assetId,
    storageKey: stored.storageKey,
    model: generation.model,
    // So a log line on its own distinguishes a paid external render from a local
    // placeholder, without the reader having to know which provider ids are which.
    providerKind: providerKindFor(generation),
    width: measured.width,
    height: measured.height,
    durationSeconds: measured.durationSeconds,
  });
  return { kind: "completed", assetId };
}

class LeaseLostDuringCompletion extends Error {
  constructor() {
    super("The lease was lost while completing");
    this.name = "LeaseLostDuringCompletion";
  }
}

// --- failure -----------------------------------------------------------------

async function failOrRetry(
  generation: Generation,
  lease: Lease,
  error: unknown,
  now: Date,
  db: Db
): Promise<StepOutcome> {
  if (error instanceof LeaseLostDuringCompletion) return { kind: "lease-lost" };

  const failureKind = classify(error);
  const message = sanitizeError(error);

  // `attempts` was incremented at claim time, so it already counts this one.
  if (shouldRetry(failureKind, generation.attempts, generation.maxAttempts)) {
    const released = await releaseForRetry(
      lease,
      { status: "QUEUED", attempts: generation.attempts, now },
      db
    );
    if (!released) return { kind: "lease-lost" };

    await db.generation.updateMany({
      where: { id: generation.id },
      data: { error: message, failureKind },
    });

    jobLog("retry-scheduled", generation, { failureKind, attempt: generation.attempts });
    return { kind: "retry-scheduled", reason: message };
  }

  const failed = await updateLeased(
    lease,
    {
      status: "FAILED",
      error: message,
      failureKind,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    },
    db
  );
  if (!failed) return { kind: "lease-lost" };

  jobLog("failed", generation, { failureKind, attempt: generation.attempts });
  return { kind: "failed", failureKind, reason: message };
}

export { sanitizeError };
