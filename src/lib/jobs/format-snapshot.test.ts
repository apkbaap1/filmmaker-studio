import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "format-storage-"));
process.env.VIDEO_STUB_DIR = mkdtempSync(path.join(tmpdir(), "format-stub-"));
process.env.VIDEO_STUB_DELAY_MS = "0";
process.env.GENERATION_POLL_INTERVAL_MS = "0";

const { claimNextJob } = await import("./queue.ts");
const { runJobStep } = await import("./runner.ts");
const { resetStubJobs } = await import("../ai/video-providers/local-stub.ts");
const videoProviders = await import("../ai/video-providers/index.ts");
const { resetStorageForTests } = await import("../storage/index.ts");

/**
 * The project's format reaches the provider, and reaches it as a snapshot.
 *
 * Two separate guarantees, and the second is the one worth a test of its own:
 * a generation records the frame shape and resolution it was *submitted* with,
 * so changing the project's format afterwards cannot rewrite history and make a
 * past render claim parameters it never had. That is the same rule the prompt
 * snapshot follows, applied to the two values 11.5 added.
 */

const prisma = new PrismaClient();

let userId: string;
let projectId: string;
let sceneId: string;
let shotId: string;

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Format", email: `format-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const project = await prisma.project.create({
    data: { title: "Format", ownerId: userId, aspectRatio: "16:9", resolution: "720p" },
  });
  projectId = project.id;
  const scene = await prisma.scene.create({
    data: { projectId, number: "1", intExt: "EXT", location: "Platform", timeOfDay: "NIGHT", order: 1 },
  });
  sceneId = scene.id;
  const shot = await prisma.shotListItem.create({
    data: { sceneId, shotNumber: "12", shotType: "WIDE", order: 1, durationSeconds: 8 },
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
  resetStorageForTests();
});

/** Queues a video job carrying whatever snapshot the test wants to assert on. */
async function queueVideoJob(snapshot: {
  aspectRatio?: string | null;
  resolution?: string | null;
  durationSeconds?: number | null;
}) {
  return prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId,
      mode: "VIDEO",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: "a wide establishing shot of an abandoned railway station at night",
      providerId: videoProviders.localStubVideoProvider.id,
      nextAttemptAt: new Date(),
      ...snapshot,
    },
  });
}

/**
 * Runs one step with the stub's `submit` replaced by a recorder.
 *
 * Patching the registered provider rather than injecting a fake keeps the test
 * on the real code path: the runner still resolves the provider through the
 * registry exactly as the worker does.
 */
async function recordSubmission(generationId: string): Promise<Record<string, unknown>> {
  const provider = videoProviders.getVideoProvider(videoProviders.localStubVideoProvider.id);
  const original = provider.submit;
  let seen: Record<string, unknown> | undefined;

  Object.assign(provider, {
    submit: async (request: Record<string, unknown>) => {
      seen = request;
      return { providerJobId: `recorded-${generationId}` };
    },
  });

  try {
    const lease = await claimNextJob({ workerId: "format-worker", projectId });
    assert.ok(lease, "the job was not claimable");
    await runJobStep(generationId, lease);
  } finally {
    Object.assign(provider, { submit: original });
  }

  assert.ok(seen, "the provider was never asked to submit");
  return seen;
}

describe("the project's format reaches the provider", () => {
  it("passes a chosen aspect ratio and resolution through to submit", async () => {
    const job = await queueVideoJob({ aspectRatio: "16:9", resolution: "720p", durationSeconds: 8 });
    const request = await recordSubmission(job.id);

    assert.equal(request.aspectRatio, "16:9");
    assert.equal(request.resolution, "720p");
    assert.equal(request.durationSeconds, 8);
  });

  it("omits what the filmmaker never chose, rather than defaulting it", async () => {
    const job = await queueVideoJob({ aspectRatio: null, resolution: null, durationSeconds: null });
    const request = await recordSubmission(job.id);

    assert.equal(
      request.aspectRatio,
      undefined,
      "an unchosen aspect ratio must not become a value the filmmaker never picked"
    );
    assert.equal(request.resolution, undefined);
    assert.equal(request.durationSeconds, undefined);
  });

  it("carries one without inventing the other", async () => {
    const job = await queueVideoJob({ aspectRatio: "9:16", resolution: null });
    const request = await recordSubmission(job.id);

    assert.equal(request.aspectRatio, "9:16");
    assert.equal(request.resolution, undefined);
  });
});

describe("the format is a submission snapshot", () => {
  it("does not follow the project when its format changes afterwards", async () => {
    const job = await queueVideoJob({ aspectRatio: "16:9", resolution: "720p" });

    // The filmmaker reformats the film after this generation was queued.
    await prisma.project.update({
      where: { id: projectId },
      data: { aspectRatio: "9:16", resolution: "4k" },
    });

    const request = await recordSubmission(job.id);

    assert.equal(
      request.aspectRatio,
      "16:9",
      "the generation must be submitted with the format it recorded, not the project's current one"
    );
    assert.equal(request.resolution, "720p");

    // And the row still reports what it was submitted with.
    const after = await prisma.generation.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.aspectRatio, "16:9");
    assert.equal(after.resolution, "720p");
  });

  it("keeps the project's own format as the live value for the next generation", async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.equal(project.aspectRatio, "9:16", "the project itself was reformatted");
    assert.equal(project.resolution, "4k");
  });
});
