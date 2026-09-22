import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const { recordProviderAttempt, usageBreakdown, recentAttempts, spendByPerson, pricingIsConfigured } =
  await import("./usage.ts");

/**
 * The spend report, and the boundary between it and the UI.
 *
 * Two things are checked here. The queries must never return another project's
 * rows, because the page's authorization gate is only as good as the scoping
 * underneath it. And the page must actually call that gate — checked
 * statically, because a server component that 404s is not something a unit test
 * can exercise, and "someone will notice if it is removed" is not a guarantee.
 */

const prisma = new PrismaClient();

const SRC = path.resolve(import.meta.dirname, "..", "..");
const USAGE_PAGE = path.join(SRC, "app", "projects", "[projectId]", "usage", "page.tsx");
const USAGE_VIEWS = path.join(SRC, "app", "projects", "[projectId]", "usage", "usage-views.tsx");

let userId: string;
let otherUserId: string;
let projectId: string;
let otherProjectId: string;
let generationId: string;
let otherGenerationId: string;

async function seedProject(title: string, ownerId: string) {
  const project = await prisma.project.create({ data: { title, ownerId } });
  const generation = await prisma.generation.create({
    data: {
      projectId: project.id,
      createdById: ownerId,
      mode: "VIDEO",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: "a shot",
      providerId: "google-veo",
      durationSeconds: 8,
    },
  });
  return { projectId: project.id, generationId: generation.id };
}

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Reporter", email: `report-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const other = await prisma.user.create({
    data: { name: "Stranger", email: `stranger-${Date.now()}@example.test`, passwordHash: "x" },
  });
  otherUserId = other.id;

  ({ projectId, generationId } = await seedProject("Mine", userId));
  ({ projectId: otherProjectId, generationId: otherGenerationId } = await seedProject(
    "Theirs",
    otherUserId
  ));
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generationUsage.deleteMany({
    where: { projectId: { in: [projectId, otherProjectId] } },
  });
  delete process.env.GENERATION_RATES;
});

function facts(overrides: Record<string, unknown> = {}) {
  return {
    generationId,
    projectId,
    userId,
    providerId: "google-veo",
    model: "veo-3.1-generate-preview",
    mode: "VIDEO" as const,
    providerKind: "real" as const,
    durationSeconds: 8,
    ...overrides,
  };
}

// --- scoping -----------------------------------------------------------------

describe("the report never crosses a project boundary", () => {
  beforeEach(async () => {
    await recordProviderAttempt(facts(), prisma);
    await recordProviderAttempt(
      facts({ projectId: otherProjectId, generationId: otherGenerationId, userId: otherUserId }),
      prisma
    );
  });

  it("breaks usage down for one project only", async () => {
    const groups = await usageBreakdown({ projectId }, prisma);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].calls, 1, "the other project's attempt must not appear");
  });

  it("lists attempts for one project only", async () => {
    const attempts = await recentAttempts({ projectId }, prisma);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].generationId, generationId);
  });

  it("attributes people within one project only", async () => {
    const people = await spendByPerson({ projectId }, prisma);
    assert.deepEqual(
      people.map((p) => p.name),
      ["Reporter"],
      "a stranger from another project must not be listed"
    );
  });

  it("returns nothing for an unscoped breakdown rather than the whole table", async () => {
    assert.deepEqual(await usageBreakdown({}, prisma), []);
    assert.deepEqual(await recentAttempts({}, prisma), []);
  });
});

// --- what the report says ----------------------------------------------------

describe("the report distinguishes usage from cost", () => {
  it("keeps an unpriced group's cost null rather than zero", async () => {
    await recordProviderAttempt(facts(), prisma);

    const [group] = await usageBreakdown({ projectId }, prisma);
    assert.equal(group.quantity, 8, "usage is known even when the price is not");
    assert.equal(group.costMicros, null, "null, so the UI can say Unpriced rather than show 0.00");
    assert.equal(group.unpricedCalls, 1);
  });

  it("keeps the priced and unpriced halves of one group separable", async () => {
    process.env.GENERATION_RATES =
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":100000,"currency":"USD"}}';
    await recordProviderAttempt(facts(), prisma);
    delete process.env.GENERATION_RATES;
    await recordProviderAttempt(facts(), prisma);

    const groups = await usageBreakdown({ projectId }, prisma);
    const priced = groups.find((g) => g.currency === "USD");
    const unpriced = groups.find((g) => g.currency === null);

    assert.equal(priced?.costMicros, 800_000);
    assert.equal(unpriced?.costMicros, null);
    assert.equal(unpriced?.unpricedCalls, 1, "not summed into the priced group as zero");
  });

  it("caps the attempt list without affecting the totals", async () => {
    for (let i = 0; i < 5; i += 1) await recordProviderAttempt(facts(), prisma);

    const attempts = await recentAttempts({ projectId, limit: 2 }, prisma);
    const groups = await usageBreakdown({ projectId }, prisma);

    assert.equal(attempts.length, 2, "the list is truncated");
    assert.equal(groups[0].calls, 5, "the totals still come from the whole ledger");
  });

  it("reports whether pricing is configured at all", () => {
    assert.equal(pricingIsConfigured(), false);
    process.env.GENERATION_RATES = '{"google-veo":{"unit":"CALL","micros":1,"currency":"USD"}}';
    assert.equal(pricingIsConfigured(), true);
  });
});

// --- the server/UI boundary --------------------------------------------------

describe("the usage page's boundary", () => {
  const page = readFileSync(USAGE_PAGE, "utf8");
  const views = readFileSync(USAGE_VIEWS, "utf8");

  it("gates on requireProjectAccess before reading anything", () => {
    assert.match(page, /requireProjectAccess\(projectId\)/);

    const gate = page.indexOf("requireProjectAccess(projectId)");
    for (const query of ["spendFor(", "usageBreakdown(", "spendByPerson(", "recentAttempts("]) {
      assert.ok(
        page.indexOf(query) > gate,
        `${query} must not run before the authorization check`
      );
    }
  });

  it("scopes every query to the project from the route", () => {
    for (const query of ["spendFor(", "usageBreakdown(", "spendByPerson(", "recentAttempts("]) {
      const at = page.indexOf(query);
      const call = page.slice(at, at + 80);
      assert.match(call, /projectId/, `${query} must be scoped to the project`);
    }
  });

  it("is read-only — nothing here can start or bill a generation", () => {
    for (const forbidden of ["use server", "generation.create", "recordProviderAttempt", "fetch("]) {
      assert.ok(!page.includes(forbidden), `the spend report must not contain ${forbidden}`);
      assert.ok(!views.includes(forbidden), `the spend views must not contain ${forbidden}`);
    }
  });

  it("renders no credential, and no email address", () => {
    for (const secret of ["API_KEY", "process.env", "user.email", "email"]) {
      assert.ok(!views.includes(secret), `the spend views must not reference ${secret}`);
    }
  });

  it("never prints a bare zero in place of an unknown cost", () => {
    // The formatter is the single place cost becomes text, and it has to branch
    // on null before it can format anything.
    assert.match(views, /costMicros === null \|\| currency === null/);
    assert.match(views, /Unpriced/);
  });
});
