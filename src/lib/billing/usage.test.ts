import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const { rateFor, costMicrosFor, configuredRates } = await import("./rates.ts");
const { quantityFor, recordProviderAttempt, spendFor } = await import("./usage.ts");

/**
 * Spend accounting.
 *
 * The rule every test here defends is the same one: **unknown cost is not
 * zero**. An application that reports a real bill as free is worse than one
 * that reports nothing, because the first is believed.
 */

const prisma = new PrismaClient();

let userId: string;
let otherUserId: string;
let projectId: string;
let generationId: string;

function withRates(json: string | undefined, run: () => void): void {
  const saved = process.env.GENERATION_RATES;
  if (json === undefined) delete process.env.GENERATION_RATES;
  else process.env.GENERATION_RATES = json;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env.GENERATION_RATES;
    else process.env.GENERATION_RATES = saved;
  }
}

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Spend", email: `spend-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const other = await prisma.user.create({
    data: { name: "Other", email: `other-${Date.now()}@example.test`, passwordHash: "x" },
  });
  otherUserId = other.id;

  const project = await prisma.project.create({ data: { title: "Spend", ownerId: userId } });
  projectId = project.id;

  const generation = await prisma.generation.create({
    data: {
      projectId,
      createdById: userId,
      mode: "VIDEO",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: "a wide establishing shot",
      providerId: "google-veo",
      durationSeconds: 8,
    },
  });
  generationId = generation.id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: projectId } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generationUsage.deleteMany({ where: { projectId } });
});

const veoFacts = {
  generationId: "",
  projectId: "",
  userId: "",
  providerId: "google-veo",
  model: "veo-3.1-generate-preview",
  mode: "VIDEO" as const,
  providerKind: "real" as const,
  durationSeconds: 8,
};

function facts(overrides: Partial<typeof veoFacts> = {}) {
  return { ...veoFacts, generationId, projectId, userId, ...overrides };
}

// --- rates -------------------------------------------------------------------

describe("provider rates", () => {
  it("ships with no prices at all", () => {
    withRates(undefined, () => {
      assert.equal(configuredRates().size, 0, "a guessed default price would be a fabricated fact");
      assert.equal(rateFor("google-veo", "veo-3.1-generate-preview"), undefined);
    });
  });

  it("reads a configured rate", () => {
    withRates('{"google-veo":{"unit":"VIDEO_SECOND","micros":150000,"currency":"USD"}}', () => {
      const rate = rateFor("google-veo");
      assert.equal(rate?.micros, 150000);
      assert.equal(rate?.unit, "VIDEO_SECOND");
      assert.equal(rate?.currency, "USD");
      assert.match(rate?.source ?? "", /GENERATION_RATES\[google-veo\]/);
    });
  });

  it("lets a model-specific rate win over the provider's", () => {
    withRates(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":150000,"currency":"USD"},' +
        '"google-veo:veo-3.1-lite-generate-preview":{"unit":"VIDEO_SECOND","micros":50000,"currency":"USD"}}',
      () => {
        assert.equal(rateFor("google-veo", "veo-3.1-lite-generate-preview")?.micros, 50000);
        assert.equal(rateFor("google-veo", "veo-3.1-generate-preview")?.micros, 150000);
      }
    );
  });

  it("drops a malformed entry rather than guessing what was meant", () => {
    withRates(
      '{"a":{"unit":"BANANAS","micros":1,"currency":"USD"},' +
        '"b":{"unit":"IMAGE","micros":-5,"currency":"USD"},' +
        '"c":{"unit":"IMAGE","micros":1.5,"currency":"USD"},' +
        '"d":{"unit":"IMAGE","micros":100,"currency":"USD"}}',
      () => {
        const table = configuredRates();
        assert.deepEqual([...table.keys()], ["d"], "only the well-formed entry survives");
      }
    );
  });

  it("survives unparseable configuration without throwing", () => {
    withRates("{not json", () => {
      assert.equal(configuredRates().size, 0);
    });
  });

  it("rounds to whole micros rather than truncating", () => {
    const rate = { unit: "VIDEO_SECOND" as const, micros: 333, currency: "USD", source: "t" };
    assert.equal(costMicrosFor(rate, 8), 2664);
    assert.equal(costMicrosFor(rate, 0.5), 167, "half up, so the ledger is not always slightly low");
  });
});

// --- what was consumed -------------------------------------------------------

describe("billable quantity", () => {
  it("bills video by the seconds the filmmaker actually chose", () => {
    withRates('{"google-veo":{"unit":"VIDEO_SECOND","micros":100,"currency":"USD"}}', () => {
      assert.deepEqual(quantityFor(facts({ durationSeconds: 8 })), {
        quantity: 8,
        unit: "VIDEO_SECOND",
      });
    });
  });

  it("falls back to one CALL when the clip length was never chosen", () => {
    withRates('{"google-veo":{"unit":"VIDEO_SECOND","micros":100,"currency":"USD"}}', () => {
      // The provider used a default this application does not know. Assuming
      // one here would invent the filmmaker's decision and then invoice it.
      assert.deepEqual(quantityFor(facts({ durationSeconds: null })), {
        quantity: 1,
        unit: "CALL",
      });
    });
  });

  it("bills images per image", () => {
    withRates('{"openai-image":{"unit":"IMAGE","micros":40000,"currency":"USD"}}', () => {
      assert.deepEqual(
        quantityFor(facts({ providerId: "openai-image", model: "gpt-image-1", mode: "IMAGE" })),
        { quantity: 1, unit: "IMAGE" }
      );
    });
  });
});

// --- the ledger --------------------------------------------------------------

describe("recording a provider call", () => {
  it("records an unconfigured provider as unpriced, not as free", async () => {
    await withRatesAsync(undefined, async () => {
      const row = await recordProviderAttempt(facts(), prisma);
      assert.ok(row);
      assert.equal(row.costMicros, null, "no rate must mean unknown, never 0");
      assert.equal(row.currency, null);
      assert.equal(row.rateSource, "unconfigured");
      assert.equal(row.quantity, 8, "what was consumed is still recorded, so it can be priced later");
    });
  });

  it("prices a call when a rate is configured", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":150000,"currency":"USD"}}',
      async () => {
        const row = await recordProviderAttempt(facts(), prisma);
        assert.equal(row?.costMicros, 1_200_000, "8 seconds at 150000 micros");
        assert.equal(row?.currency, "USD");
      }
    );
  });

  it("does not apply a rate priced in a different unit than was consumed", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"IMAGE","micros":40000,"currency":"USD"}}',
      async () => {
        const row = await recordProviderAttempt(facts({ durationSeconds: 8 }), prisma);
        assert.equal(row?.costMicros, null, "seconds must not be billed at a per-image rate");
        assert.match(row?.rateSource ?? "", /unapplied/);
      }
    );
  });

  it("records nothing for a stub, which costs nothing", async () => {
    const row = await recordProviderAttempt(facts({ providerKind: "stub" }), prisma);
    assert.equal(row, undefined);
    assert.equal(await prisma.generationUsage.count({ where: { projectId } }), 0);
  });

  it("records one row per attempt, so a resubmission is counted again", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":100000,"currency":"USD"}}',
      async () => {
        // The same generation, submitted twice: failed once, retried, billed twice.
        await recordProviderAttempt(facts(), prisma);
        await recordProviderAttempt(facts(), prisma);

        const spend = await spendFor({ projectId }, prisma);
        assert.equal(spend.totalCalls, 2, "collapsing these would hide the money the retry cost");
        assert.equal(spend.pricedMicros.USD, 1_600_000);
      }
    );
  });
});

// --- aggregation -------------------------------------------------------------

describe("spend totals", () => {
  it("keeps unpriced calls out of the total and counts them separately", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":100000,"currency":"USD"}}',
      async () => {
        await recordProviderAttempt(facts(), prisma);
      }
    );
    await withRatesAsync(undefined, async () => {
      await recordProviderAttempt(facts(), prisma);
    });

    const spend = await spendFor({ projectId }, prisma);
    assert.equal(spend.pricedCalls, 1);
    assert.equal(spend.unpricedCalls, 1);
    assert.equal(spend.totalCalls, 2);
    assert.equal(spend.pricedMicros.USD, 800_000, "the unpriced call is not summed as zero");
  });

  it("never converts between currencies", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":100000,"currency":"USD"}}',
      async () => {
        await recordProviderAttempt(facts(), prisma);
      }
    );
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":90000,"currency":"EUR"}}',
      async () => {
        await recordProviderAttempt(facts(), prisma);
      }
    );

    const spend = await spendFor({ projectId }, prisma);
    assert.deepEqual(Object.keys(spend.pricedMicros).sort(), ["EUR", "USD"]);
    assert.equal(spend.pricedMicros.USD, 800_000);
    assert.equal(spend.pricedMicros.EUR, 720_000);
  });

  it("attributes spend to the person who started the generation", async () => {
    await withRatesAsync(
      '{"google-veo":{"unit":"VIDEO_SECOND","micros":100000,"currency":"USD"}}',
      async () => {
        await recordProviderAttempt(facts({ userId }), prisma);
        await recordProviderAttempt(facts({ userId: otherUserId }), prisma);
      }
    );

    const mine = await spendFor({ userId }, prisma);
    const theirs = await spendFor({ userId: otherUserId }, prisma);

    assert.equal(mine.totalCalls, 1, "a collaborator's spend is not charged to me");
    assert.equal(theirs.totalCalls, 1);
    assert.equal(mine.pricedMicros.USD, 800_000);
  });

  it("returns an empty total for an unscoped query rather than the whole table", async () => {
    const spend = await spendFor({}, prisma);
    assert.equal(spend.totalCalls, 0);
  });
});

/** The async twin of `withRates`, for the cases that touch the database. */
async function withRatesAsync(json: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env.GENERATION_RATES;
  if (json === undefined) delete process.env.GENERATION_RATES;
  else process.env.GENERATION_RATES = json;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.GENERATION_RATES;
    else process.env.GENERATION_RATES = saved;
  }
}
