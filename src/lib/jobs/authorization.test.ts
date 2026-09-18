import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "authz-storage-"));
process.env.VIDEO_STUB_DIR = mkdtempSync(path.join(tmpdir(), "authz-stub-"));
process.env.VIDEO_STUB_DELAY_MS = "0";
process.env.GENERATION_POLL_INTERVAL_MS = "0";

const { claimNextJob } = await import("./queue.ts");
const { runJobStep } = await import("./runner.ts");
const { drainQueue } = await import("./worker.ts");
const { scopedTo } = await import("../authz.ts");
const imageProviders = await import("../ai/image-providers/index.ts");

/**
 * Authorization around durable jobs.
 *
 * The server actions themselves call `requireProjectAccess`, which needs a real
 * session and is covered end-to-end by the live verification script. What is
 * tested here is the layer underneath, which is where the Workstream 11.1
 * vulnerability actually lived: the *database writes*. Every one of them carries
 * its project scope, so knowing a generation id is not enough to touch it.
 */

const prisma = new PrismaClient();

let ownerId: string;
let strangerId: string;
let projectId: string;
let otherProjectId: string;
let shotId: string;
let otherShotId: string;

before(async () => {
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `authz-owner-${Date.now()}@example.test`, passwordHash: "x" },
  });
  const stranger = await prisma.user.create({
    data: { name: "Stranger", email: `authz-other-${Date.now()}@example.test`, passwordHash: "x" },
  });
  ownerId = owner.id;
  strangerId = stranger.id;

  const mine = await prisma.project.create({ data: { title: "Mine", ownerId } });
  const theirs = await prisma.project.create({ data: { title: "Theirs", ownerId: strangerId } });
  projectId = mine.id;
  otherProjectId = theirs.id;

  const sceneA = await prisma.scene.create({
    data: { projectId, number: "1", intExt: "INT", location: "A", timeOfDay: "DAY", order: 1 },
  });
  const sceneB = await prisma.scene.create({
    data: {
      projectId: otherProjectId,
      number: "1",
      intExt: "INT",
      location: "B",
      timeOfDay: "DAY",
      order: 1,
    },
  });
  shotId = (
    await prisma.shotListItem.create({
      data: { sceneId: sceneA.id, shotNumber: "12", shotType: "MEDIUM", order: 1 },
    })
  ).id;
  otherShotId = (
    await prisma.shotListItem.create({
      data: { sceneId: sceneB.id, shotNumber: "12", shotType: "MEDIUM", order: 1 },
    })
  ).id;
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generation.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
  await prisma.asset.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
});

async function queueFor(project: string, shot: string) {
  return prisma.generation.create({
    data: {
      projectId: project,
      shotId: shot,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: "a medium shot",
      providerId: imageProviders.localStubImageProvider.id,
      nextAttemptAt: new Date(),
    },
  });
}

describe("project scoping on generation writes", () => {
  it("does not retry another project's generation, even with its exact id", async () => {
    const victim = await queueFor(otherProjectId, otherShotId);
    await prisma.generation.update({ where: { id: victim.id }, data: { status: "FAILED" } });

    // Exactly the write `retryGenerationAction` performs, with the attacker's
    // project as the scope. This is the shape of the 11.1 vulnerability.
    const result = await prisma.generation.updateMany({
      where: { id: victim.id, status: "FAILED", ...scopedTo.generation(projectId) },
      data: { status: "QUEUED", attempts: 0 },
    });

    assert.equal(result.count, 0, "the scope must stop the write reaching another project");
    assert.equal(
      (await prisma.generation.findUniqueOrThrow({ where: { id: victim.id } })).status,
      "FAILED"
    );
  });

  it("does not cancel another project's generation", async () => {
    const victim = await queueFor(otherProjectId, otherShotId);

    const result = await prisma.generation.updateMany({
      where: { id: victim.id, status: "QUEUED", ...scopedTo.generation(projectId) },
      data: { status: "CANCELLED" },
    });

    assert.equal(result.count, 0);
    assert.equal(
      (await prisma.generation.findUniqueOrThrow({ where: { id: victim.id } })).status,
      "QUEUED"
    );
  });

  it("does not delete another project's generation", async () => {
    const victim = await queueFor(otherProjectId, otherShotId);

    const result = await prisma.generation.deleteMany({
      where: { id: victim.id, ...scopedTo.generation(projectId) },
    });

    assert.equal(result.count, 0);
    assert.ok(await prisma.generation.findUnique({ where: { id: victim.id } }));
  });

  it("does not list another project's generations", async () => {
    await queueFor(otherProjectId, otherShotId);
    const visible = await prisma.generation.findMany({
      where: { shotId: otherShotId, ...scopedTo.generation(projectId) },
    });
    assert.deepEqual(visible, [], "a shot id from another project reveals nothing");
  });

  it("does the same write successfully within the right project", async () => {
    // The mirror image, so the tests above are proving a scope and not a typo.
    const mine = await queueFor(projectId, shotId);
    await prisma.generation.update({ where: { id: mine.id }, data: { status: "FAILED" } });

    const result = await prisma.generation.updateMany({
      where: { id: mine.id, status: "FAILED", ...scopedTo.generation(projectId) },
      data: { status: "QUEUED", attempts: 0 },
    });
    assert.equal(result.count, 1);
  });
});

describe("the worker's own scoping", () => {
  it("stores a generation's output under the generation's project", async () => {
    const job = await queueFor(otherProjectId, otherShotId);

    // A worker scoped to *this* project must not pick it up at all.
    assert.equal(await claimNextJob({ workerId: "w1", projectId }), undefined);

    // And when it is processed, it lands in its own project.
    await drainQueue({ workerId: "w2", projectId: otherProjectId, db: prisma });

    const done = await prisma.generation.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(done.status, "COMPLETED");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
    assert.equal(asset.projectId, otherProjectId);
    assert.ok(
      asset.storageKey.startsWith(`projects/${otherProjectId}/`),
      "the object key belongs to the generation's project"
    );
  });

  it("refuses a source frame that belongs to another project", async () => {
    // The frame is real, and in the stranger's project.
    const foreignFrame = await prisma.asset.create({
      data: {
        projectId: otherProjectId,
        type: "IMAGE",
        source: "UPLOADED",
        storageProvider: "LOCAL",
        storageKey: `projects/${otherProjectId}/assets/11111111-1111-1111-1111-111111111111/original.png`,
        mimeType: "image/png",
        fileSize: 10,
      },
    });

    // A generation in *our* project pointing at it — the row a tampered request
    // would have to produce.
    const job = await prisma.generation.create({
      data: {
        projectId,
        shotId,
        mode: "IMAGE_TO_VIDEO",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: "animate it",
        providerId: "local-stub",
        sourceAssetId: foreignFrame.id,
        nextAttemptAt: new Date(),
      },
    });

    const lease = await claimNextJob({ workerId: "w1", projectId });
    assert.ok(lease);
    const outcome = await runJobStep(job.id, lease);

    assert.equal(outcome.kind, "failed");
    const after = await prisma.generation.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.failureKind, "PERMANENT");
    assert.match(after.error ?? "", /no longer available in this project/);
  });
});
