import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

// Each test process gets its own storage root and stub job store, so parallel
// test files cannot see each other's objects.
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "jobs-storage-"));
process.env.VIDEO_STUB_DIR = mkdtempSync(path.join(tmpdir(), "jobs-stub-"));
process.env.VIDEO_STUB_DELAY_MS = "0";
process.env.GENERATION_POLL_INTERVAL_MS = "0";

const { claimNextJob, heartbeat, holdsLease, reapExhausted, releaseForRetry, updateLeased } =
  await import("./queue.ts");
const { runJobStep } = await import("./runner.ts");
const { drainQueue } = await import("./worker.ts");
const { localStubVideoProvider, resetStubJobs, stubJobCount } = await import(
  "../ai/video-providers/local-stub.ts"
);
const { localStubImageProvider } = await import("../ai/image-providers/local-stub.ts");

/**
 * Durable-job tests against a real PostgreSQL.
 *
 * These deliberately use the real database rather than a fake: the entire
 * mechanism *is* a set of conditional UPDATEs, and a fake queue would prove
 * nothing about whether two workers can claim the same row. "Worker A crashes"
 * is modelled the only way it can be — by simply never calling the worker
 * again and letting the lease run out, exactly as a killed process would.
 */

const prisma = new PrismaClient();

let userId: string;
let projectId: string;
let sceneId: string;
let shotId: string;

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Jobs", email: `jobs-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const project = await prisma.project.create({ data: { title: "Jobs", ownerId: userId } });
  projectId = project.id;
  const scene = await prisma.scene.create({
    data: { projectId, number: "1", intExt: "INT", location: "Stage", timeOfDay: "DAY", order: 1 },
  });
  sceneId = scene.id;
  const shot = await prisma.shotListItem.create({
    data: { sceneId, shotNumber: "12", shotType: "MEDIUM", order: 1 },
  });
  shotId = shot.id;
});

after(async () => {
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generation.deleteMany({ where: { projectId } });
  await prisma.asset.deleteMany({ where: { projectId } });
  resetStubJobs();
});

interface QueueOptions {
  mode?: "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";
  prompt?: string;
  providerId?: string;
  maxAttempts?: number;
  sourceAssetId?: string;
}

async function queueJob(options: QueueOptions = {}) {
  const mode = options.mode ?? "IMAGE";
  return prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode,
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: options.prompt ?? "a medium shot of a harbour at dawn",
      providerId:
        options.providerId ?? (mode === "IMAGE" ? localStubImageProvider.id : localStubVideoProvider.id),
      maxAttempts: options.maxAttempts ?? 3,
      sourceAssetId: options.sourceAssetId ?? null,
      nextAttemptAt: new Date(),
    },
  });
}

const read = (id: string) => prisma.generation.findUniqueOrThrow({ where: { id } });

describe("claiming", () => {
  it("claims a queued job and takes a lease on it", async () => {
    const job = await queueJob();
    const lease = await claimNextJob({ workerId: "w1", projectId });

    assert.ok(lease, "a queued job should be claimable");
    assert.equal(lease.generationId, job.id);

    const after = await read(job.id);
    assert.equal(after.status, "PROCESSING");
    assert.equal(after.leaseOwner, "w1");
    assert.equal(after.leaseToken, lease.token);
    assert.equal(after.attempts, 1, "the attempt is spent on claim, not on failure");
    assert.ok(after.leaseExpiresAt && after.leaseExpiresAt > new Date());
  });

  it("gives one job to exactly one of two workers racing for it", async () => {
    await queueJob();

    // Both read the same row before either writes — the case an in-memory lock
    // would get wrong across processes.
    const [a, b] = await Promise.all([
      claimNextJob({ workerId: "w1", projectId }),
      claimNextJob({ workerId: "w2", projectId }),
    ]);

    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one worker may hold the job");
  });

  it("hands ten jobs to four workers without any two colliding", async () => {
    for (let i = 0; i < 10; i += 1) await queueJob({ prompt: `shot ${i}` });

    const leases = (
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          Promise.all([
            claimNextJob({ workerId: `w${i}`, projectId }),
            claimNextJob({ workerId: `w${i}`, projectId }),
            claimNextJob({ workerId: `w${i}`, projectId }),
          ])
        )
      )
    )
      .flat()
      .filter((l) => l !== undefined);

    const ids = leases.map((l) => l.generationId);
    assert.equal(new Set(ids).size, ids.length, "no generation was claimed twice");
  });

  it("finds nothing when every job is already held", async () => {
    await queueJob();
    assert.ok(await claimNextJob({ workerId: "w1", projectId }));
    assert.equal(await claimNextJob({ workerId: "w2", projectId }), undefined);
  });

  it("does not claim a job whose scheduled time has not come", async () => {
    const job = await queueJob();
    await prisma.generation.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    assert.equal(await claimNextJob({ workerId: "w1", projectId }), undefined);
  });

  it("does not claim a terminal job", async () => {
    for (const status of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
      await prisma.generation.deleteMany({ where: { projectId } });
      const job = await queueJob();
      await prisma.generation.update({ where: { id: job.id }, data: { status } });
      assert.equal(
        await claimNextJob({ workerId: "w1", projectId }),
        undefined,
        `${status} must not be claimable`
      );
    }
  });
});

describe("lease expiry and worker crashes", () => {
  it("makes a job available again once its holder's lease runs out", async () => {
    const job = await queueJob();

    // Worker A claims, then "crashes": we simply never call it again.
    const crashed = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(crashed);
    assert.equal(await claimNextJob({ workerId: "worker-b", projectId }), undefined);

    // Time passes and the lease expires. No sweeper runs; expiry is enough.
    const later = new Date(Date.now() + 60_000);
    const recovered = await claimNextJob({ workerId: "worker-b", projectId, now: later });

    assert.ok(recovered, "the job must become available again after a crash");
    assert.equal(recovered.generationId, job.id);
    assert.notEqual(recovered.token, crashed.token, "the new owner gets a new token");

    const after = await read(job.id);
    assert.equal(after.leaseOwner, "worker-b");
    assert.equal(after.attempts, 2, "the crashed attempt was counted");
  });

  it("stops a crashed worker that wakes up from clobbering the new owner", async () => {
    const job = await queueJob();
    const stale = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(stale);

    const fresh = await claimNextJob({
      workerId: "worker-b",
      projectId,
      now: new Date(Date.now() + 60_000),
    });
    assert.ok(fresh);

    // Worker A comes back to life and tries to finish the job it thinks it owns.
    const wrote = await updateLeased(stale, { status: "COMPLETED", error: "from the zombie" });
    assert.equal(wrote, false, "a lost lease must not be able to write");

    const after = await read(job.id);
    assert.equal(after.status, "PROCESSING");
    assert.equal(after.leaseOwner, "worker-b");
    assert.equal(after.error, null);
  });

  it("lets a slow-but-alive worker keep its job by heartbeating", async () => {
    await queueJob();
    const lease = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(lease);

    const extended = await heartbeat(lease, 60_000, new Date());
    assert.equal(extended, true);

    // The heartbeat is what separates "slow" from "dead".
    const later = new Date(Date.now() + 1_000);
    assert.equal(await claimNextJob({ workerId: "worker-b", projectId, now: later }), undefined);
    assert.equal(await holdsLease(lease), true);
  });

  it("reports a heartbeat on a lost lease rather than silently succeeding", async () => {
    await queueJob();
    const stale = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(stale);
    await claimNextJob({ workerId: "worker-b", projectId, now: new Date(Date.now() + 60_000) });

    assert.equal(await heartbeat(stale, 60_000), false);
    assert.equal(await holdsLease(stale), false);
  });

  it("fails a job whose attempts ran out while nobody was holding it", async () => {
    const job = await queueJob({ maxAttempts: 1 });
    const lease = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(lease);
    assert.equal((await read(job.id)).attempts, 1);

    // The worker dies without reporting anything. Without the reaper this job
    // would sit un-claimable and unexplained forever.
    const reaped = await reapExhausted(new Date(Date.now() + 60_000));
    assert.equal(reaped, 1);

    const after = await read(job.id);
    assert.equal(after.status, "FAILED");
    assert.ok(after.error?.includes("maximum number of attempts"));
    assert.equal(after.leaseToken, null);
  });

  it("does not reap a job that still has attempts left", async () => {
    await queueJob({ maxAttempts: 3 });
    await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.equal(await reapExhausted(new Date(Date.now() + 60_000)), 0);
  });
});

describe("retry scheduling", () => {
  it("releases a job for a later attempt and lets go of the lease", async () => {
    const job = await queueJob();
    const lease = await claimNextJob({ workerId: "w1", projectId });
    assert.ok(lease);

    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(await releaseForRetry(lease, { status: "QUEUED", attempts: 1, now }), true);

    const after = await read(job.id);
    assert.equal(after.status, "QUEUED");
    assert.equal(after.leaseToken, null);
    assert.equal(after.nextAttemptAt?.toISOString(), "2026-01-01T00:00:05.000Z");
  });

  it("refuses to release a job this worker no longer holds", async () => {
    await queueJob();
    const stale = await claimNextJob({ workerId: "w1", projectId, leaseMs: 50 });
    assert.ok(stale);
    await claimNextJob({ workerId: "w2", projectId, now: new Date(Date.now() + 60_000) });

    assert.equal(await releaseForRetry(stale, { status: "QUEUED", attempts: 1 }), false);
  });
});

describe("running a job to completion", () => {
  it("stores the media and records the Asset in one move", async () => {
    const job = await queueJob({ mode: "IMAGE" });
    const stats = await drainQueue({ workerId: "w1", projectId, db: prisma });

    assert.equal(stats.completed, 1);
    const after = await read(job.id);
    assert.equal(after.status, "COMPLETED");
    assert.ok(after.assetId, "a completed job must have produced an Asset");
    assert.ok(after.completedAt);
    assert.equal(after.leaseToken, null, "the lease is given back");
    assert.equal(after.stagedMedia, null, "the staging record is cleared");

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: after.assetId! } });
    assert.equal(asset.projectId, projectId);
    assert.equal(asset.shotId, shotId);
    assert.equal(asset.source, "GENERATED");
    assert.equal(asset.mimeType, "image/png");
    assert.ok(asset.checksum, "the stored object's checksum is recorded");
    assert.equal(asset.prompt, job.promptUsed, "the Asset carries the prompt that made it");
  });

  it("never reports COMPLETED without an Asset behind it", async () => {
    for (let i = 0; i < 3; i += 1) await queueJob({ prompt: `take ${i + 1}` });
    await drainQueue({ workerId: "w1", projectId, db: prisma });

    const completed = await prisma.generation.findMany({
      where: { projectId, status: "COMPLETED" },
    });
    assert.equal(completed.length, 3);
    for (const generation of completed) {
      assert.ok(generation.assetId, `${generation.id} is COMPLETED with no Asset`);
    }
  });

  it("keeps every take rather than overwriting the previous one", async () => {
    // In sequence, as a filmmaker actually works — and so `createdAt` gives a
    // deterministic order to assert against.
    const takes = [];
    for (const prompt of ["take 1 — wide", "take 2 — tighter", "take 3 — tightest"]) {
      takes.push(await queueJob({ prompt }));
    }
    await drainQueue({ workerId: "w1", projectId, db: prisma });

    const rows = await prisma.generation.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.promptUsed),
      takes.map((t) => t.promptUsed),
      "each take kept its own prompt"
    );
    assert.equal(new Set(rows.map((r) => r.assetId)).size, 3, "each take has its own Asset");
  });
});

describe("the prompt is a submission snapshot", () => {
  it("submits the prompt the job was created with, not a recompiled one", async () => {
    const job = await queueJob({ mode: "VIDEO", prompt: "the prompt as it was at submission" });

    // The filmmaker keeps working on the shot after queuing — the ordinary case.
    await prisma.shotListItem.update({
      where: { id: shotId },
      data: { shotType: "EXTREME_CLOSE_UP", cameraMovement: "whip pan", mood: "frantic" },
    });

    await drainQueue({ workerId: "w1", projectId, db: prisma });
    await drainQueue({ workerId: "w1", projectId, db: prisma });

    const after = await read(job.id);
    assert.equal(after.promptUsed, "the prompt as it was at submission");
    assert.ok(after.providerJobId);

    const { stubJobRequest } = await import("../ai/video-providers/local-stub.ts");
    assert.equal(
      stubJobRequest(after.providerJobId!)?.prompt,
      "the prompt as it was at submission",
      "the provider received the frozen prompt, not the edited shot"
    );
  });
});

describe("asynchronous video jobs", () => {
  it("submits, releases the worker, and completes on a later poll", async () => {
    // A real, short render time. The stub fixes a job's readiness when it is
    // submitted, exactly as a provider does — so this has to be waited out
    // rather than reconfigured afterwards.
    process.env.VIDEO_STUB_DELAY_MS = "300";
    const job = await queueJob({ mode: "VIDEO" });

    const lease = await claimNextJob({ workerId: "w1", projectId });
    assert.ok(lease);
    const submitted = await runJobStep(job.id, lease);
    assert.equal(submitted.kind, "submitted");

    const afterSubmit = await read(job.id);
    assert.equal(afterSubmit.status, "AWAITING_PROVIDER");
    assert.ok(afterSubmit.providerJobId);
    assert.ok(afterSubmit.submittedAt);
    assert.equal(afterSubmit.leaseToken, null, "the worker is free while the provider renders");

    // A later claim polls; the provider is not ready yet.
    const pollLease = await claimNextJob({ workerId: "w2", projectId });
    assert.ok(pollLease);
    assert.equal((await runJobStep(job.id, pollLease)).kind, "still-processing");
    assert.equal(
      (await read(job.id)).attempts,
      1,
      "waiting on a provider must not spend the retry budget"
    );

    // Now it is.
    await new Promise((resolve) => setTimeout(resolve, 400));
    process.env.VIDEO_STUB_DELAY_MS = "0";
    const finalLease = await claimNextJob({ workerId: "w3", projectId });
    assert.ok(finalLease);
    assert.equal((await runJobStep(job.id, finalLease)).kind, "completed");

    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.assetId);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
    assert.equal(asset.type, "VIDEO");
    assert.equal(asset.mimeType, "video/webm");
  });

  it("does not create a second provider job when polled repeatedly", async () => {
    process.env.VIDEO_STUB_DELAY_MS = "10000";
    const job = await queueJob({ mode: "VIDEO" });

    for (let i = 0; i < 4; i += 1) {
      const lease = await claimNextJob({ workerId: `w${i}`, projectId });
      assert.ok(lease, `claim ${i}`);
      await runJobStep(job.id, lease);
    }

    assert.equal(stubJobCount(), 1, "one generation must mean one provider job");
    process.env.VIDEO_STUB_DELAY_MS = "0";
  });
});
