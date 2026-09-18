import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "recovery-storage-"));
process.env.VIDEO_STUB_DIR = mkdtempSync(path.join(tmpdir(), "recovery-stub-"));
process.env.VIDEO_STUB_DELAY_MS = "0";
process.env.GENERATION_POLL_INTERVAL_MS = "0";

const { claimNextJob } = await import("./queue.ts");
const { runJobStep, sanitizeError } = await import("./runner.ts");
const { drainQueue } = await import("./worker.ts");
const { resetStubJobs, stubJobCount } = await import("../ai/video-providers/local-stub.ts");
const videoProviders = await import("../ai/video-providers/index.ts");
const imageProviders = await import("../ai/image-providers/index.ts");
const { GenerationError } = await import("./state.ts");
const { resetStorageForTests } = await import("../storage/index.ts");

/**
 * Failure recovery.
 *
 * Every case in this file is a partial failure — the kind where something
 * genuinely happened and then something else did not. They are the cases that
 * decide whether a filmmaker loses work or pays twice, so each one is set up by
 * actually breaking the thing rather than by asserting on a mock's call count.
 */

const prisma = new PrismaClient();

let userId: string;
let projectId: string;
let sceneId: string;
let shotId: string;

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Recovery", email: `recovery-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const project = await prisma.project.create({ data: { title: "Recovery", ownerId: userId } });
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

async function queueJob(overrides: Record<string, unknown> = {}) {
  return prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: "a medium shot of a harbour at dawn",
      providerId: imageProviders.localStubImageProvider.id,
      nextAttemptAt: new Date(),
      ...overrides,
    },
  });
}

const read = (id: string) => prisma.generation.findUniqueOrThrow({ where: { id } });

function storedObjectCount(): number {
  const root = path.join(process.env.STORAGE_DIR!, "projects", projectId, "assets");
  try {
    return readdirSync(root).length;
  } catch {
    return 0;
  }
}

type Generate = (typeof imageProviders)["localStubImageProvider"]["generate"];

/**
 * Swaps in a misbehaving adapter for one test, then puts the real one back.
 *
 * The fake is handed the *original* `generate`, because the registry entry is
 * the same object being patched — a fake that reached for the adapter by name
 * would be calling itself.
 */
async function withImageProvider<T>(
  fake: (real: Generate) => Generate,
  run: (providerId: string) => Promise<T>
): Promise<T> {
  const provider = imageProviders.getImageProvider(imageProviders.localStubImageProvider.id);
  const original = provider.generate.bind(provider);
  provider.generate = fake(original);
  try {
    return await run(provider.id);
  } finally {
    provider.generate = original;
  }
}

describe("provider failures", () => {
  it("retries a blip, and succeeds on the next attempt", async () => {
    let calls = 0;
    const job = await queueJob();

    await withImageProvider(
      (real) => async (request) => {
        calls += 1;
        if (calls === 1) throw GenerationError.retryable("the provider timed out");
        return real(request);
      },
      async () => {
        const first = await claimNextJob({ workerId: "w1", projectId });
        assert.ok(first);
        const outcome = await runJobStep(job.id, first);
        assert.equal(outcome.kind, "retry-scheduled");

        const retrying = await read(job.id);
        assert.equal(retrying.status, "QUEUED");
        assert.equal(retrying.failureKind, "RETRYABLE");
        assert.match(retrying.error ?? "", /timed out/);
        assert.equal(retrying.leaseToken, null);

        // The backoff really is in the future, so the worker will not spin.
        assert.ok(retrying.nextAttemptAt && retrying.nextAttemptAt > new Date());

        // Its time comes.
        await prisma.generation.update({
          where: { id: job.id },
          data: { nextAttemptAt: new Date() },
        });
        const second = await claimNextJob({ workerId: "w2", projectId });
        assert.ok(second);
        assert.equal((await runJobStep(job.id, second)).kind, "completed");
      }
    );

    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
    assert.equal(done.error, null, "a successful retry clears the earlier error");
    assert.equal(done.attempts, 2);
    assert.equal(calls, 2);
  });

  it("does not retry a permanent failure, however many attempts are left", async () => {
    const job = await queueJob({ maxAttempts: 5 });

    await withImageProvider(
      () => async () => {
        throw GenerationError.permanent("the prompt was rejected by the content filter");
      },
      async () => {
        const lease = await claimNextJob({ workerId: "w1", projectId });
        assert.ok(lease);
        const outcome = await runJobStep(job.id, lease);
        assert.equal(outcome.kind, "failed");
      }
    );

    const failed = await read(job.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failureKind, "PERMANENT");
    assert.equal(failed.attempts, 1, "a permanent failure spends one attempt, not five");
    assert.match(failed.error ?? "", /content filter/);
  });

  it("gives up once the attempt ceiling is reached", async () => {
    const job = await queueJob({ maxAttempts: 2 });

    await withImageProvider(
      () => async () => {
        throw GenerationError.retryable("still down");
      },
      async () => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await prisma.generation.update({
            where: { id: job.id },
            data: { nextAttemptAt: new Date() },
          });
          const lease = await claimNextJob({ workerId: `w${attempt}`, projectId });
          assert.ok(lease, `attempt ${attempt} should be claimable`);
          await runJobStep(job.id, lease);
        }
      }
    );

    const failed = await read(job.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attempts, 2);

    // And it stays failed: nothing picks it up again on its own.
    await prisma.generation.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
    assert.equal(await claimNextJob({ workerId: "w3", projectId }), undefined);
  });
});

describe("storage failures", () => {
  /**
   * Breaks the storage backend for the duration of one call.
   *
   * The storage root is pointed *inside a regular file*, so the provider's own
   * `mkdir` fails with ENOTDIR. A real write really does fail, rather than a
   * mock pretending to — and it fails the way a misconfigured or full disk
   * would, at the moment of writing rather than before it.
   */
  async function withBrokenStorage<T>(run: () => Promise<T>): Promise<T> {
    const real = process.env.STORAGE_DIR!;
    const blocker = path.join(tmpdir(), `not-a-directory-${process.pid}-${Date.now()}`);
    writeFileSync(blocker, "this is a file, not a directory");

    process.env.STORAGE_DIR = path.join(blocker, "uploads");
    resetStorageForTests();
    try {
      return await run();
    } finally {
      process.env.STORAGE_DIR = real;
      resetStorageForTests();
      rmSync(blocker, { force: true });
    }
  }

  it("keeps the job alive and creates no Asset when the media cannot be stored", async () => {
    const job = await queueJob();

    const outcome = await withBrokenStorage(async () => {
      const lease = await claimNextJob({ workerId: "w1", projectId });
      assert.ok(lease);
      return runJobStep(job.id, lease);
    });

    assert.equal(outcome.kind, "retry-scheduled", "a storage blip is worth another go");

    const after = await read(job.id);
    assert.notEqual(after.status, "COMPLETED", "storage failed, so nothing may be complete");
    assert.equal(after.assetId, null);
    assert.equal(after.failureKind, "RETRYABLE");
    assert.equal(
      await prisma.asset.count({ where: { projectId } }),
      0,
      "no Asset may exist for media that was never stored"
    );
  });

  it("reuses the reserved key on a retry rather than orphaning a new object", async () => {
    const job = await queueJob();
    // A delta: earlier tests in this file leave their own objects on disk, and
    // what matters here is how many *this* job creates across two attempts.
    const before = storedObjectCount();

    const staged = await withBrokenStorage(async () => {
      const lease = await claimNextJob({ workerId: "w1", projectId });
      assert.ok(lease);
      await runJobStep(job.id, lease);
      return (await read(job.id)).stagedMedia as { storageKey: string } | null;
    });

    assert.ok(staged?.storageKey, "the key is reserved and recorded before the write is attempted");

    // Storage comes back; the retry writes to the key it already reserved.
    await prisma.generation.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
    const second = await claimNextJob({ workerId: "w2", projectId });
    assert.ok(second);
    assert.equal((await runJobStep(job.id, second)).kind, "completed");

    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
    assert.equal(asset.storageKey, staged.storageKey, "the reserved key is the one that was used");
    assert.equal(
      storedObjectCount() - before,
      1,
      "two attempts must leave one object, not one orphan per attempt"
    );
  });

  it("refuses media the application does not accept, and does not retry it", async () => {
    const job = await queueJob({ maxAttempts: 5 });

    await withImageProvider(
      () => async () => ({ data: Buffer.from("<svg onload=alert(1)/>"), mimeType: "image/svg+xml" }),
      async () => {
        const lease = await claimNextJob({ workerId: "w1", projectId });
        assert.ok(lease);
        const outcome = await runJobStep(job.id, lease);
        assert.equal(outcome.kind, "failed");
      }
    );

    const after = await read(job.id);
    assert.equal(after.status, "FAILED");
    assert.equal(
      after.failureKind,
      "PERMANENT",
      "an adapter returning a type we reject will do so again; retrying is pointless"
    );
    assert.equal(after.attempts, 1);
    assert.equal(await prisma.asset.count({ where: { projectId } }), 0);
  });
});

describe("worker crashes", () => {
  it("recovers a job whose worker died mid-generation", async () => {
    const job = await queueJob();

    // Worker A claims and is killed: we never call runJobStep at all.
    const dead = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(dead);
    assert.equal((await read(job.id)).status, "PROCESSING");

    // Nothing was produced.
    assert.equal(await prisma.asset.count({ where: { projectId } }), 0);

    // Worker B arrives after the lease expires and finishes the job.
    const lease = await claimNextJob({
      workerId: "worker-b",
      projectId,
      now: new Date(Date.now() + 60_000),
    });
    assert.ok(lease, "the abandoned job must be recoverable");
    assert.equal((await runJobStep(job.id, lease)).kind, "completed");

    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
    assert.ok(done.assetId);
    assert.equal(done.attempts, 2, "the dead worker's attempt was counted");
  });

  it("does not let a resurrected worker write a second Asset", async () => {
    const job = await queueJob({ mode: "IMAGE" });

    const stale = await claimNextJob({ workerId: "worker-a", projectId, leaseMs: 50 });
    assert.ok(stale);

    const fresh = await claimNextJob({
      workerId: "worker-b",
      projectId,
      now: new Date(Date.now() + 60_000),
    });
    assert.ok(fresh);
    assert.equal((await runJobStep(job.id, fresh)).kind, "completed");

    // Worker A wakes up and runs the step it was in the middle of.
    const zombie = await runJobStep(job.id, stale);
    assert.equal(zombie.kind, "lease-lost");

    assert.equal(
      await prisma.asset.count({ where: { projectId } }),
      1,
      "one generation must produce exactly one Asset"
    );
    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
  });
});

describe("crashing after submitting to a provider", () => {
  it("adopts the existing provider job instead of starting a second one", async () => {
    const job = await queueJob({ mode: "VIDEO", providerId: videoProviders.localStubVideoProvider.id });

    // Submit for real, then simulate the worker dying before it could record
    // the job id — the exact window that risks paying twice.
    const first = await claimNextJob({ workerId: "worker-a", projectId });
    assert.ok(first);
    await runJobStep(job.id, first);
    assert.equal(stubJobCount(), 1);

    await prisma.generation.update({
      where: { id: job.id },
      data: {
        providerJobId: null,
        status: "QUEUED",
        submittedAt: null,
        nextAttemptAt: new Date(),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });

    const second = await claimNextJob({ workerId: "worker-b", projectId });
    assert.ok(second);
    await runJobStep(job.id, second);

    assert.equal(stubJobCount(), 1, "the provider must not be asked to render twice");
    const after = await read(job.id);
    assert.ok(after.providerJobId, "the existing provider job was adopted");
  });

  it("parks the job rather than guessing when the provider cannot be asked", async () => {
    const real = videoProviders.getVideoProvider(videoProviders.localStubVideoProvider.id);
    const original = {
      supportsIdempotencyKey: real.supportsIdempotencyKey,
      findJobByIdempotencyKey: real.findJobByIdempotencyKey,
    };

    // A provider with neither an idempotency key nor a job lookup: the honest
    // worst case, and the one where a retry could genuinely bill twice.
    Object.assign(real, { supportsIdempotencyKey: false, findJobByIdempotencyKey: undefined });

    try {
      const job = await queueJob({
        mode: "VIDEO",
        providerId: real.id,
        status: "QUEUED",
        // The tell-tale of a crash mid-submission.
        submissionAttemptedAt: new Date(),
      });

      const lease = await claimNextJob({ workerId: "worker-b", projectId });
      assert.ok(lease);
      const outcome = await runJobStep(job.id, lease);

      assert.equal(outcome.kind, "failed");
      const after = await read(job.id);
      assert.equal(after.status, "FAILED");
      assert.equal(after.failureKind, "INDETERMINATE");
      assert.match(after.error ?? "", /did not record a job id/);
      assert.match(after.error ?? "", /second billed job/);
      assert.equal(stubJobCount(), 0, "nothing was submitted on the recovery path");
    } finally {
      Object.assign(real, original);
    }
  });
});

describe("duplicate completions", () => {
  it("ignores a repeated poll after a job has already completed", async () => {
    const job = await queueJob({ mode: "VIDEO", providerId: videoProviders.localStubVideoProvider.id });

    await drainQueue({ workerId: "w1", projectId, db: prisma });
    await drainQueue({ workerId: "w1", projectId, db: prisma });

    const done = await read(job.id);
    assert.equal(done.status, "COMPLETED");
    const assetId = done.assetId;

    // Everything below is what a duplicated provider callback would do.
    for (let i = 0; i < 3; i += 1) {
      await drainQueue({ workerId: `w${i}`, projectId, db: prisma });
    }

    const stillDone = await read(job.id);
    assert.equal(stillDone.status, "COMPLETED");
    assert.equal(stillDone.assetId, assetId, "the Asset did not change");
    assert.equal(await prisma.asset.count({ where: { projectId } }), 1);
  });
});

describe("error reporting", () => {
  it("never records a credential in a job's error", () => {
    const cases: [string, RegExp][] = [
      ["request failed with key sk-abcdef0123456789abcdef", /\[redacted-key\]/],
      ["rejected: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", /Bearer \[redacted\]/],
      [
        "could not fetch https://bucket.example.com/object?X-Amz-Signature=deadbeef&X-Amz-Expires=900",
        /\?\[redacted\]/,
      ],
    ];
    for (const [raw, expected] of cases) {
      const clean = sanitizeError(new Error(raw));
      assert.match(clean, expected);
      assert.ok(!clean.includes("sk-abcdef0123456789abcdef"));
      assert.ok(!clean.includes("eyJhbGciOiJIUzI1NiJ9"));
      assert.ok(!clean.includes("deadbeef"));
    }
  });

  it("truncates a runaway provider message", () => {
    const clean = sanitizeError(new Error("x".repeat(50_000)));
    assert.ok(clean.length <= 1000, `error was ${clean.length} characters`);
  });
});
