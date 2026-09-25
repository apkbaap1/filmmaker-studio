import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * The generation server actions, called directly.
 *
 * These are the actions with money behind them, and the ones whose rules were
 * previously only visible by reading them: a VIEWER must not be able to start a
 * generation, a job already with a provider must not be cancellable, and a
 * generation belonging to another project must be invisible rather than
 * forbidden.
 *
 * The harness is the one built in 12.7 — the session substituted, `next/*`
 * replaced with throws a test can catch, and everything else real. `notFound()`
 * throwing is the behaviour of `requireProjectAccess`, not an artefact: a
 * caller who cannot see a project gets a 404, never a 403.
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

const { retryGenerationAction, cancelGenerationAction, deleteGenerationAction, generationStatesAction } =
  await import("./generations.ts");

const prisma = new PrismaClient();

let owner: { id: string; email: string; name: string };
let viewer: { id: string; email: string; name: string };
let stranger: { id: string; email: string; name: string };
let projectId: string;
let otherProjectId: string;
let sceneId: string;
let shotId: string;
let otherShotId: string;

async function makeUser(label: string) {
  const email = `${label}-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await prisma.user.create({ data: { name: label, email, passwordHash: "x" } });
  return { id: user.id, email: user.email, name: user.name };
}

before(async () => {
  owner = await makeUser("owner");
  viewer = await makeUser("viewer");
  stranger = await makeUser("stranger");

  projectId = (await prisma.project.create({ data: { title: "Night Station", ownerId: owner.id } })).id;
  otherProjectId = (await prisma.project.create({ data: { title: "Elsewhere", ownerId: owner.id } })).id;

  await prisma.projectMember.create({ data: { projectId, userId: viewer.id, role: "VIEWER" } });

  const scene = await prisma.scene.create({
    data: { projectId, number: "4", location: "Station", order: 1 },
  });
  sceneId = scene.id;
  shotId = (
    await prisma.shotListItem.create({
      data: { sceneId, shotNumber: "12", shotType: "WIDE", order: 1 },
    })
  ).id;

  // A shot in the other project, so a read can be aimed across the boundary.
  const otherScene = await prisma.scene.create({
    data: { projectId: otherProjectId, number: "1", location: "Signal box", order: 1 },
  });
  otherShotId = (
    await prisma.shotListItem.create({
      data: { sceneId: otherScene.id, shotNumber: "1", shotType: "CLOSE_UP", order: 1 },
    })
  ).id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, viewer.id, stranger.id] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generation.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
  currentUser = owner;
});

async function makeGeneration(
  status: "QUEUED" | "PROCESSING" | "AWAITING_PROVIDER" | "COMPLETED" | "FAILED" | "CANCELLED",
  project = projectId
) {
  return prisma.generation.create({
    data: {
      projectId: project,
      sceneId: project === projectId ? sceneId : null,
      shotId: project === projectId ? shotId : otherShotId,
      createdById: owner.id,
      mode: "IMAGE",
      source: "STRUCTURED",
      status,
      promptUsed: "a wide establishing shot",
      providerId: "openai-gpt-image-1",
      attempts: status === "FAILED" ? 3 : 0,
      error: status === "FAILED" ? "the provider failed (503)" : null,
    },
  });
}

async function caught(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the action to throw, and it resolved");
}

describe("retrying a generation", () => {
  it("requeues a failed one and gives it a fresh attempt budget", async () => {
    // The point of a human pressing Retry: attempts are the worker's business
    // and are already bounded, so only a person resets them.
    const generation = await makeGeneration("FAILED");
    const result = await retryGenerationAction(projectId, generation.id);
    assert.equal(result.error, undefined);

    const after = await prisma.generation.findUnique({ where: { id: generation.id } });
    assert.equal(after?.status, "QUEUED");
    assert.equal(after?.attempts, 0);
    assert.equal(after?.error, null);
    assert.equal(after?.submissionAttemptedAt, null, "cleared, so the worker resubmits");
  });

  it("refuses to retry anything that has not failed", async () => {
    for (const status of ["QUEUED", "PROCESSING", "COMPLETED", "CANCELLED"] as const) {
      const generation = await makeGeneration(status);
      const result = await retryGenerationAction(projectId, generation.id);
      assert.match(result.error ?? "", /cannot be retried/, status);

      const after = await prisma.generation.findUnique({ where: { id: generation.id } });
      assert.equal(after?.status, status, `${status} must be untouched`);
    }
  });

  it("cannot reach a generation in another project", async () => {
    // Not "forbidden" — invisible. The project itself is reachable by this
    // caller, so the scoping has to be on the row, not only on the project.
    const elsewhere = await makeGeneration("FAILED", otherProjectId);
    const result = await retryGenerationAction(projectId, elsewhere.id);

    assert.match(result.error ?? "", /not found/i);
    const after = await prisma.generation.findUnique({ where: { id: elsewhere.id } });
    assert.equal(after?.status, "FAILED", "and it is not requeued");
  });

  it("refuses a viewer, who cannot spend money on someone else's project", async () => {
    const generation = await makeGeneration("FAILED");
    currentUser = viewer;

    const error = await caught(() => retryGenerationAction(projectId, generation.id));
    assert.equal(error.name, "NotFoundSignal");

    const after = await prisma.generation.findUnique({ where: { id: generation.id } });
    assert.equal(after?.status, "FAILED");
  });

  it("shows a stranger nothing", async () => {
    const generation = await makeGeneration("FAILED");
    currentUser = stranger;
    const error = await caught(() => retryGenerationAction(projectId, generation.id));
    assert.equal(error.name, "NotFoundSignal");
  });
});

describe("cancelling a generation", () => {
  it("cancels one that has not been submitted anywhere", async () => {
    const generation = await makeGeneration("QUEUED");
    const result = await cancelGenerationAction(projectId, generation.id);
    assert.equal(result.error, undefined);

    const after = await prisma.generation.findUnique({ where: { id: generation.id } });
    assert.equal(after?.status, "CANCELLED");
  });

  it("refuses once a job is with a provider", async () => {
    // Honest rather than conservative: no adapter here can call a provider job
    // back, and a Cancel button that quietly did nothing would be worse than
    // no button.
    for (const status of ["PROCESSING", "AWAITING_PROVIDER"] as const) {
      const generation = await makeGeneration(status);
      const result = await cancelGenerationAction(projectId, generation.id);
      assert.ok(result.error, `${status} must not be cancellable`);

      const after = await prisma.generation.findUnique({ where: { id: generation.id } });
      assert.equal(after?.status, status);
    }
  });

  it("refuses a completed generation", async () => {
    const generation = await makeGeneration("COMPLETED");
    const result = await cancelGenerationAction(projectId, generation.id);
    assert.ok(result.error);
  });

  it("cannot reach another project's generation", async () => {
    const elsewhere = await makeGeneration("QUEUED", otherProjectId);
    const result = await cancelGenerationAction(projectId, elsewhere.id);

    assert.match(result.error ?? "", /not found/i);
    const after = await prisma.generation.findUnique({ where: { id: elsewhere.id } });
    assert.equal(after?.status, "QUEUED");
  });

  it("refuses a viewer", async () => {
    const generation = await makeGeneration("QUEUED");
    currentUser = viewer;
    const error = await caught(() => cancelGenerationAction(projectId, generation.id));
    assert.equal(error.name, "NotFoundSignal");
  });
});

describe("deleting a generation", () => {
  it("removes the attempt record and leaves the asset alone", async () => {
    // The generated image belongs in the gallery. Deleting it is a separate,
    // explicit action — losing a render by tidying up an attempt log would be
    // a nasty surprise.
    const generation = await makeGeneration("COMPLETED");
    const asset = await prisma.asset.create({
      data: {
        projectId,
        shotId,
        type: "IMAGE",
        source: "GENERATED",
        mimeType: "image/png",
        fileSize: 1024,
        storageKey: `projects/${projectId}/assets/${crypto.randomUUID()}/original.png`,
      },
    });
    await prisma.generation.update({
      where: { id: generation.id },
      data: { assetId: asset.id },
    });

    await deleteGenerationAction(projectId, generation.id);

    assert.equal(await prisma.generation.count({ where: { id: generation.id } }), 0);
    assert.ok(await prisma.asset.findUnique({ where: { id: asset.id } }), "the render stays");

    await prisma.asset.delete({ where: { id: asset.id } });
  });

  it("cannot reach another project's generation", async () => {
    const elsewhere = await makeGeneration("COMPLETED", otherProjectId);
    await deleteGenerationAction(projectId, elsewhere.id);
    assert.equal(
      await prisma.generation.count({ where: { id: elsewhere.id } }),
      1,
      "a row in another project must survive"
    );
  });

  it("refuses a viewer", async () => {
    const generation = await makeGeneration("COMPLETED");
    currentUser = viewer;
    const error = await caught(() => deleteGenerationAction(projectId, generation.id));
    assert.equal(error.name, "NotFoundSignal");
    assert.equal(await prisma.generation.count({ where: { id: generation.id } }), 1);
  });
});

describe("reading generation state", () => {
  it("lets a viewer read, since seeing is not spending", async () => {
    // The one generation action a VIEWER may call. Reading a status costs
    // nothing and is how the shot page stops showing a spinner.
    await makeGeneration("QUEUED");
    currentUser = viewer;

    const states = await generationStatesAction(projectId, shotId);
    assert.equal(states.length, 1);
    assert.equal(states[0].status, "QUEUED");
  });

  it("returns nothing for a shot in another project", async () => {
    // The caller owns both projects, so the project gate lets them through and
    // only the row-level scope stops the read. That is the case worth testing.
    await makeGeneration("QUEUED", otherProjectId);
    const states = await generationStatesAction(projectId, otherShotId);
    assert.deepEqual(states, [], "a shot from elsewhere leaks no status");
  });

  it("sends a signed-out caller to sign in", async () => {
    currentUser = null;
    const error = await caught(() => generationStatesAction(projectId, shotId));
    assert.match(error.message, /NEXT_REDIRECT:\/sign-in/);
  });
});
