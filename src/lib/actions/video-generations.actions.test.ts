import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { PrismaClient } from "@prisma/client";

import { png } from "@/lib/ai/image-metadata.test.ts";

/**
 * Starting a video generation, and especially animating a still.
 *
 * Image-to-video is the one mode that takes something the filmmaker already
 * has and hands it to a provider, so it is the one with a source to get wrong.
 * Four guards stand between the button and a billed request, and until now
 * every one of them was only visible by reading it:
 *
 *   a source must be chosen at all
 *   it must belong to *this shot*, not merely to a project the caller can see
 *   it must actually be an image
 *   the configured provider must be able to animate one
 *
 * The UI now greys the mode out for a provider that cannot, which makes the
 * fourth guard look redundant. It is not: the UI is a courtesy and the action
 * is the rule.
 */

class NotFoundSignal extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "NotFoundSignal";
  }
}

let currentUser: { id: string; email: string; name: string } | null = null;

mock.module("next/navigation", {
  namedExports: {
    notFound: () => {
      throw new NotFoundSignal();
    },
    redirect: (to: string) => {
      throw new Error(`NEXT_REDIRECT:${to}`);
    },
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } });
mock.module("@/auth", {
  namedExports: { auth: async () => (currentUser ? { user: currentUser } : null) },
});

const { startShotVideoGenerationAction } = await import("./video-generations.ts");

const prisma = new PrismaClient();

let owner: { id: string; email: string; name: string };
let viewer: { id: string; email: string; name: string };
let projectId: string;
let sceneId: string;
let shotId: string;
let otherShotId: string;
let frameId: string;
let otherShotFrameId: string;
let clipId: string;

async function makeUser(label: string) {
  const email = `${label}-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await prisma.user.create({ data: { name: label, email, passwordHash: "x" } });
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * A real asset: bytes in storage as well as a row.
 *
 * The row alone is not enough. Animating a still means *reading* it back and
 * handing it to the provider, so a fixture with no object behind it fails at
 * the storage boundary — which is what happened the first time this was
 * written, and is the right failure for the code to produce.
 */
async function makeAsset(fields: { shotId: string; type: "IMAGE" | "VIDEO"; mimeType: string }) {
  const { storeProjectMedia } = await import("@/lib/media");
  const bytes = fields.type === "IMAGE" ? png(640, 360) : Buffer.from("MP4-BYTES-FOR-A-TEST-CLIP");
  const stored = await storeProjectMedia(projectId, bytes, fields.mimeType);

  const asset = await prisma.asset.create({
    data: {
      projectId,
      shotId: fields.shotId,
      type: fields.type,
      source: "GENERATED",
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      checksum: stored.checksum,
      mimeType: stored.mimeType,
      fileSize: stored.fileSize,
    },
  });
  return asset.id;
}

before(async () => {
  owner = await makeUser("owner");
  viewer = await makeUser("viewer");

  projectId = (await prisma.project.create({ data: { title: "Night Station", ownerId: owner.id } })).id;
  await prisma.projectMember.create({ data: { projectId, userId: viewer.id, role: "VIEWER" } });

  const scene = await prisma.scene.create({
    data: { projectId, number: "4", location: "Station", order: 1 },
  });
  sceneId = scene.id;
  shotId = (
    await prisma.shotListItem.create({
      data: { sceneId, shotNumber: "12", shotType: "WIDE", order: 1, durationSeconds: 8 },
    })
  ).id;
  otherShotId = (
    await prisma.shotListItem.create({
      data: { sceneId, shotNumber: "13", shotType: "MEDIUM", order: 2 },
    })
  ).id;

  frameId = await makeAsset({ shotId, type: "IMAGE", mimeType: "image/png" });
  otherShotFrameId = await makeAsset({ shotId: otherShotId, type: "IMAGE", mimeType: "image/png" });
  // A clip attached to this shot — an asset that is here and is not a still.
  clipId = await makeAsset({ shotId, type: "VIDEO", mimeType: "video/mp4" });

  // The stub is the only video provider that needs no credential, and it
  // declares imageToVideo, so the happy path below is a real code path rather
  // than a mock of one.
  process.env.VIDEO_PROVIDER = "local-stub";
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, viewer.id] } } });
  await prisma.$disconnect();
  delete process.env.VIDEO_PROVIDER;
});

beforeEach(async () => {
  await prisma.generation.deleteMany({ where: { projectId } });
  currentUser = owner;
  process.env.VIDEO_PROVIDER = "local-stub";
});

function form(prompt = "a slow push in on the platform clock") {
  const data = new FormData();
  data.set("prompt", prompt);
  return data;
}

const start = (
  mode: "VIDEO" | "IMAGE_TO_VIDEO",
  sourceAssetId: string | null,
  prompt?: string
) => startShotVideoGenerationAction(projectId, sceneId, shotId, mode, sourceAssetId, undefined, form(prompt));

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the action to throw, and it resolved");
}

describe("animating a still", () => {
  it("queues a job that remembers which frame it came from", async () => {
    const result = await start("IMAGE_TO_VIDEO", frameId);
    assert.equal(result?.error, undefined);

    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.ok(generation);
    assert.equal(generation.mode, "IMAGE_TO_VIDEO");
    assert.equal(generation.status, "QUEUED");
    assert.equal(generation.sourceAssetId, frameId, "the card shows this back as 'animated from'");
    assert.equal(generation.createdById, owner.id);
  });

  it("carries the shot's stated duration and never invents one", async () => {
    await start("IMAGE_TO_VIDEO", frameId);
    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(generation?.durationSeconds, 8, "read from the shot");

    // A shot with no stated duration submits none, and the provider applies its
    // own default rather than one chosen here.
    await prisma.generation.deleteMany({ where: { projectId } });
    const bare = await startShotVideoGenerationAction(
      projectId,
      sceneId,
      otherShotId,
      "IMAGE_TO_VIDEO",
      otherShotFrameId,
      undefined,
      form()
    );
    assert.equal(bare?.error, undefined);
    const second = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(second?.durationSeconds, null);
  });

  it("refuses without a source frame", async () => {
    const result = await start("IMAGE_TO_VIDEO", null);
    assert.match(result?.error ?? "", /Choose a source frame/);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });

  it("refuses a frame belonging to a different shot", async () => {
    // It is in this project and the caller can see it. Only the shot scoping
    // stops it, which is why it is the interesting case.
    const result = await start("IMAGE_TO_VIDEO", otherShotFrameId);
    assert.match(result?.error ?? "", /does not belong to this shot/);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });

  it("refuses an asset that is not an image", async () => {
    const result = await start("IMAGE_TO_VIDEO", clipId);
    assert.match(result?.error ?? "", /must be an image/);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });

  it("refuses a source id that does not exist", async () => {
    const result = await start("IMAGE_TO_VIDEO", "not-a-real-asset-id");
    assert.match(result?.error ?? "", /does not belong to this shot/);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });

  it("refuses a viewer, who cannot spend on someone else's project", async () => {
    currentUser = viewer;
    const error = await caught(() => start("IMAGE_TO_VIDEO", frameId));
    assert.equal(error.name, "NotFoundSignal");
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });
});

describe("plain text-to-video", () => {
  it("queues without a source frame", async () => {
    const result = await start("VIDEO", null);
    assert.equal(result?.error, undefined);

    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(generation?.mode, "VIDEO");
    assert.equal(generation?.sourceAssetId, null);
  });

  it("ignores a source frame it was handed anyway", async () => {
    // The mode decides, not the argument. A stale sourceAssetId left over from
    // the UI switching modes must not become an animation nobody asked for.
    const result = await start("VIDEO", frameId);
    assert.equal(result?.error, undefined);

    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(generation?.sourceAssetId, null);
  });
});

describe("when no video provider is configured", () => {
  it("refuses rather than falling back to one", async () => {
    // There is deliberately no default: nothing here should quietly pick a
    // provider, least of all a billed one.
    delete process.env.VIDEO_PROVIDER;
    const result = await start("IMAGE_TO_VIDEO", frameId);

    assert.match(result?.error ?? "", /No video provider is configured/);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });
});

describe("the prompt", () => {
  it("refuses an empty one", async () => {
    const result = await start("IMAGE_TO_VIDEO", frameId, "  ");
    assert.ok(result?.error);
    assert.equal(await prisma.generation.count({ where: { projectId } }), 0);
  });

  it("records the text that was actually submitted", async () => {
    const typed = "hold on the clock, then drift left past the bench";
    await start("IMAGE_TO_VIDEO", frameId, typed);

    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(generation?.promptUsed, typed);
    assert.equal(
      generation?.promptEdited,
      true,
      "compared against the compiled text, not taken from a flag the client set"
    );
  });
});

describe("the whole path, not just the queueing", () => {
  /**
   * Queue an animation through the real action, then drive it through the real
   * worker with the real stub provider, and look at what came out.
   *
   * The tests above prove a job is written correctly. This proves the thing the
   * roadmap item actually asked for: that a still already in the project can be
   * turned into a clip attached to the same shot, with the frame it came from
   * still recorded. Nothing here is mocked except the session.
   */
  it("turns a still into a clip attached to the same shot", async () => {
    const { claimNextJob } = await import("@/lib/jobs/queue");
    const { runJobStep } = await import("@/lib/jobs/runner");

    // The stub holds a job PROCESSING for a while so the asynchronous states
    // are observable in the UI. This test wants the states, not the wait.
    const savedDelay = process.env.VIDEO_STUB_DELAY_MS;
    process.env.VIDEO_STUB_DELAY_MS = "0";

    const queued = await start("IMAGE_TO_VIDEO", frameId);
    assert.equal(queued?.error, undefined);

    // Submit, then poll. The stub answers asynchronously like a real provider,
    // so this is the same two-step lifecycle a billed job goes through.
    for (let step = 0; step < 12; step += 1) {
      const lease = await claimNextJob({ workerId: "test-worker" });
      if (!lease) break;
      await runJobStep(lease.generationId, lease);

      const state = await prisma.generation.findUnique({ where: { id: lease.generationId } });
      if (state?.status === "COMPLETED" || state?.status === "FAILED") break;
      // A job waiting on the provider is released back to the queue with a
      // `nextAttemptAt` in the near future; move past it rather than sleeping.
      await prisma.generation.updateMany({
        where: { id: lease.generationId, status: "AWAITING_PROVIDER" },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
    }

    if (savedDelay === undefined) delete process.env.VIDEO_STUB_DELAY_MS;
    else process.env.VIDEO_STUB_DELAY_MS = savedDelay;

    const generation = await prisma.generation.findFirst({ where: { projectId } });
    assert.equal(generation?.status, "COMPLETED", generation?.error ?? "no error recorded");
    assert.ok(generation?.assetId, "a clip was produced");
    assert.equal(generation?.sourceAssetId, frameId, "and it still says which frame it came from");

    const clip = await prisma.asset.findUnique({ where: { id: generation!.assetId! } });
    assert.ok(clip);
    assert.equal(clip.type, "VIDEO");
    assert.ok(clip.mimeType.startsWith("video/"), clip.mimeType);
    assert.equal(clip.shotId, shotId, "attached to the shot, so the timeline can find it");
    assert.ok(clip.fileSize > 0, "with bytes actually stored");

    await prisma.asset.deleteMany({ where: { id: clip.id } });
  });
});
