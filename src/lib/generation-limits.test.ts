import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const { checkGenerationAllowed, generationLimits } = await import("./generation-limits.ts");

/**
 * Cost protection.
 *
 * This is the first workstream where a button can spend money, so these run
 * against the real database: the limits are count queries, and a fake would
 * prove nothing about whether they actually see the rows they are meant to.
 */

const prisma = new PrismaClient();

let ownerId: string;
let otherUserId: string;
let projectId: string;
let secondProjectId: string;
let foreignProjectId: string;

const ENV_KEYS = [
  "GENERATION_LIMIT_PER_USER",
  "GENERATION_LIMIT_PER_PROJECT",
  "GENERATION_LIMIT_CONCURRENT",
  "GENERATION_LIMIT_PER_REQUEST",
  "GENERATION_LIMIT_WINDOW_HOURS",
] as const;

before(async () => {
  const owner = await prisma.user.create({
    data: { name: "Owner", email: `limits-${Date.now()}@example.test`, passwordHash: "x" },
  });
  const other = await prisma.user.create({
    data: { name: "Other", email: `limits-other-${Date.now()}@example.test`, passwordHash: "x" },
  });
  ownerId = owner.id;
  otherUserId = other.id;

  projectId = (await prisma.project.create({ data: { title: "One", ownerId } })).id;
  secondProjectId = (await prisma.project.create({ data: { title: "Two", ownerId } })).id;
  foreignProjectId = (
    await prisma.project.create({ data: { title: "Theirs", ownerId: otherUserId } })
  ).id;
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherUserId] } } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  await prisma.generation.deleteMany({
    where: { projectId: { in: [projectId, secondProjectId, foreignProjectId] } },
  });
});

/**
 * `startedBy` defaults to the user under test, because that is how the
 * application creates rows: every generation records who started it. The
 * per-user ceiling counts by that, so a fixture that omitted it would be
 * testing a state the application cannot produce.
 */
async function existing(
  project: string,
  count: number,
  status: "COMPLETED" | "QUEUED" = "COMPLETED",
  createdAt?: Date,
  startedBy: string | null = ownerId
) {
  for (let i = 0; i < count; i += 1) {
    await prisma.generation.create({
      data: {
        projectId: project,
        createdById: startedBy,
        mode: "IMAGE",
        source: "STRUCTURED",
        status,
        promptUsed: `prompt ${i}`,
        providerId: "openai-gpt-image-1",
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }
}

const allow = (overrides: Partial<Parameters<typeof checkGenerationAllowed>[0]> = {}) =>
  checkGenerationAllowed({
    projectId,
    userId: ownerId,
    providerKind: "real",
    ...overrides,
  });

describe("limit configuration", () => {
  it("has a finite default for every limit", () => {
    const limits = generationLimits();
    for (const [name, value] of Object.entries(limits)) {
      assert.ok(Number.isFinite(value) && value > 0, `${name} must have a finite default`);
    }
  });

  it("is configurable from the environment", () => {
    process.env.GENERATION_LIMIT_PER_USER = "7";
    process.env.GENERATION_LIMIT_WINDOW_HOURS = "3";
    const limits = generationLimits();
    assert.equal(limits.perUserPerWindow, 7);
    assert.equal(limits.windowHours, 3);
  });

  it("ignores a nonsensical setting rather than disabling the limit", () => {
    // A typo in an env var must not silently mean "no ceiling".
    for (const bad of ["0", "-5", "lots", "", "1.5"]) {
      process.env.GENERATION_LIMIT_PER_USER = bad;
      assert.equal(generationLimits().perUserPerWindow, 50, `"${bad}" should fall back`);
    }
  });
});

describe("what is counted", () => {
  it("does not throttle a local stub, which costs nothing", async () => {
    process.env.GENERATION_LIMIT_PER_PROJECT = "1";
    await existing(projectId, 20);
    assert.deepEqual(await allow({ providerKind: "stub" }), { ok: true });
  });

  it("counts attempts, not successes", async () => {
    // A failed generation still cost a provider call.
    process.env.GENERATION_LIMIT_PER_PROJECT = "3";
    await prisma.generation.createMany({
      data: ["FAILED", "FAILED", "COMPLETED"].map((status, i) => ({
        projectId,
        mode: "IMAGE" as const,
        source: "STRUCTURED" as const,
        status: status as "FAILED" | "COMPLETED",
        promptUsed: `p${i}`,
        providerId: "openai-gpt-image-1",
      })),
    });

    const result = await allow();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /limit is 3/);
  });

  it("only counts inside the rolling window", async () => {
    process.env.GENERATION_LIMIT_PER_PROJECT = "2";
    process.env.GENERATION_LIMIT_WINDOW_HOURS = "24";
    // Yesterday's generations do not hold today's budget hostage.
    await existing(projectId, 5, "COMPLETED", new Date(Date.now() - 48 * 3_600_000));
    assert.deepEqual(await allow(), { ok: true });
  });
});

describe("the ceilings", () => {
  it("stops a project that has used its window", async () => {
    process.env.GENERATION_LIMIT_PER_PROJECT = "2";
    await existing(projectId, 2);

    const result = await allow();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /This project has started 2/);
  });

  it("stops a project with too many in flight at once", async () => {
    // The guard against a double-click or a retry loop fanning out.
    process.env.GENERATION_LIMIT_CONCURRENT = "2";
    await existing(projectId, 2, "QUEUED");

    const result = await allow();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /already has 2 generations in progress/);
  });

  it("stops a user who has used their window, across all of their projects", async () => {
    // Otherwise the per-project cap is sidestepped by making more projects.
    process.env.GENERATION_LIMIT_PER_USER = "3";
    process.env.GENERATION_LIMIT_PER_PROJECT = "100";
    await existing(projectId, 2);
    await existing(secondProjectId, 1);

    const result = await allow();
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /You have started 3/);
  });

  it("does not count another user's generations against this one", async () => {
    process.env.GENERATION_LIMIT_PER_USER = "3";
    // Started by someone else, in their own project.
    await existing(foreignProjectId, 10, "COMPLETED", undefined, otherUserId);
    assert.deepEqual(await allow(), { ok: true });
  });

  it("does not count a collaborator's work on a shared project", async () => {
    // The case the old approximation got wrong: counting every generation in
    // every project the user could reach meant one busy collaborator could lock
    // everyone else out of a shared project without them generating anything.
    process.env.GENERATION_LIMIT_PER_USER = "3";
    await existing(projectId, 10, "COMPLETED", undefined, otherUserId);
    assert.deepEqual(await allow(), { ok: true });
  });

  it("still counts a generation whose creator is unknown against nobody", async () => {
    // Rows predating attribution. Charging them to a known person would be
    // worse than leaving them uncounted.
    process.env.GENERATION_LIMIT_PER_USER = "3";
    await existing(projectId, 10, "COMPLETED", undefined, null);
    assert.deepEqual(await allow(), { ok: true });
  });

  it("refuses a request for more images than one request may ask for", async () => {
    process.env.GENERATION_LIMIT_PER_REQUEST = "1";
    const result = await allow({ count: 4 });
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : "", /at most 1 generation/);
  });

  it("allows the very next generation when nothing is over the line", async () => {
    process.env.GENERATION_LIMIT_PER_PROJECT = "5";
    await existing(projectId, 4);
    assert.deepEqual(await allow(), { ok: true });
  });

  it("explains which ceiling was hit, so the message is actionable", async () => {
    process.env.GENERATION_LIMIT_PER_PROJECT = "1";
    await existing(projectId, 1);
    const result = await allow();
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.reason, /\d+/, "the message states the numbers involved");
      assert.ok(result.reason.length < 250);
    }
  });
});
