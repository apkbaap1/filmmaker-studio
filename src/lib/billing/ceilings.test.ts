import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const { parseCeiling, spendCeilings, ceilingsAreConfigured, ceilingStatus, estimateCost, checkSpendAllowed } =
  await import("./ceilings.ts");
const { recordProviderAttempt, spendFor } = await import("./usage.ts");

/**
 * Spend ceilings.
 *
 * The attempt limits in `generation-limits.ts` can have finite defaults because
 * an attempt is always countable. Money is not: what a call costs is knowable
 * only from an operator's own rate table, and this codebase ships without
 * prices. So a ceiling is opt-in — and every test below is really about the
 * same question, which is what an opt-in guard does when it cannot do its job.
 *
 * The answer, three times over: it stops, and says why. A ceiling that quietly
 * fails open is worse than no ceiling, because the operator believes they have
 * one.
 */

const prisma = new PrismaClient();

let userId: string;
let otherUserId: string;
let projectId: string;
let otherProjectId: string;
let generationId: string;

const VEO_RATE = '{"google-veo":{"unit":"VIDEO_SECOND","micros":150000,"currency":"USD"}}';

/** Runs with a set of env vars in place, and puts them back afterwards. */
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Ceiling", email: `ceiling-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;
  const other = await prisma.user.create({
    data: { name: "Other", email: `ceiling-other-${Date.now()}@example.test`, passwordHash: "x" },
  });
  otherUserId = other.id;

  projectId = (await prisma.project.create({ data: { title: "Capped", ownerId: userId } })).id;
  otherProjectId = (await prisma.project.create({ data: { title: "Elsewhere", ownerId: userId } })).id;

  generationId = (
    await prisma.generation.create({
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
    })
  ).id;
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.generationUsage.deleteMany({ where: { projectId: { in: [projectId, otherProjectId] } } });
});

/** Puts real spend in the ledger, at a rate that makes the arithmetic legible. */
async function spend(options: { seconds: number; currency?: string; project?: string; user?: string }) {
  const currency = options.currency ?? "USD";
  await withEnv(
    { GENERATION_RATES: `{"google-veo":{"unit":"VIDEO_SECOND","micros":1000000,"currency":"${currency}"}}` },
    async () => {
      await recordProviderAttempt(
        {
          generationId,
          projectId: options.project ?? projectId,
          userId: options.user ?? userId,
          providerId: "google-veo",
          model: "veo-3.1-generate-preview",
          mode: "VIDEO",
          providerKind: "real",
          durationSeconds: options.seconds,
        },
        prisma
      );
    }
  );
}

/** An unpriced call: recorded, but with no rate configured for it. */
async function spendUnpriced() {
  await withEnv({ GENERATION_RATES: undefined }, async () => {
    await recordProviderAttempt(
      {
        generationId,
        projectId,
        userId,
        providerId: "mystery-provider",
        mode: "VIDEO",
        providerKind: "real",
        durationSeconds: 8,
      },
      prisma
    );
  });
}

const check = (overrides: Partial<Parameters<typeof checkSpendAllowed>[0]> = {}) =>
  checkSpendAllowed(
    {
      projectId,
      userId,
      providerId: "google-veo",
      model: "veo-3.1-generate-preview",
      mode: "VIDEO",
      providerKind: "real",
      durationSeconds: 8,
      ...overrides,
    },
    prisma
  );

// --- reading the configuration -----------------------------------------------

describe("reading a ceiling", () => {
  it("reads one currency", () => {
    const parsed = parseCeiling("25 USD");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.limits.get("USD"), 25_000_000);
  });

  it("reads several, and keeps them apart", () => {
    const parsed = parseCeiling("25 USD, 20 EUR");
    assert.equal(parsed.limits.get("USD"), 25_000_000);
    assert.equal(parsed.limits.get("EUR"), 20_000_000);
  });

  it("reads a fractional amount without floating-point drift", () => {
    assert.equal(parseCeiling("0.50 USD").limits.get("USD"), 500_000);
    assert.equal(parseCeiling("12.34 GBP").limits.get("GBP"), 12_340_000);
  });

  it("treats nothing set as no ceiling rather than a ceiling of zero", () => {
    // The difference matters: a ceiling of zero would stop every generation.
    for (const raw of [undefined, "", "   "]) {
      const parsed = parseCeiling(raw);
      assert.equal(parsed.ok, true, `${JSON.stringify(raw)} is not a configuration error`);
      assert.equal(parsed.limits.size, 0);
    }
  });

  it("refuses a ceiling with no currency, because there is no currency to assume", () => {
    for (const raw of ["25", "25.00", "USD", "$25"]) {
      assert.equal(parseCeiling(raw).ok, false, `${raw} must not parse`);
    }
  });

  it("refuses the whole value when any part of it is unreadable", () => {
    // Applying the readable half would enforce a limit the operator did not
    // write, which is a different bug from not enforcing one.
    const parsed = parseCeiling("25 USD, twenty EUR");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.limits.size, 0, "not even the part that parsed");
  });

  it("refuses a currency named twice rather than picking one", () => {
    assert.equal(parseCeiling("25 USD, 30 USD").ok, false);
  });

  it("refuses a negative ceiling", () => {
    assert.equal(parseCeiling("-5 USD").ok, false);
  });

  it("normalises the currency's case", () => {
    assert.equal(parseCeiling("25 usd").limits.get("USD"), 25_000_000);
  });

  it("accepts any currency name, because the rate table does too", () => {
    // An operator whose GENERATION_RATES say "currency": "CREDITS" needs to be
    // able to cap credits. Restricting this to ISO codes would make a rate
    // impossible to put a ceiling on.
    assert.equal(parseCeiling("25 CREDITS").limits.get("CREDITS"), 25_000_000);
  });

  it("requires a space, so an amount and a currency cannot run together", () => {
    assert.equal(parseCeiling("25USD").ok, false);
  });
});

describe("the configured state", () => {
  it("is unconfigured when nothing is set", async () => {
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: undefined,
        GENERATION_SPEND_LIMIT_PER_USER: undefined,
      },
      async () => {
        assert.equal(ceilingsAreConfigured(spendCeilings()), false);
      }
    );
  });

  it("counts a broken configuration as configured", async () => {
    // Otherwise a typo would read as "no ceiling wanted" and the guard would
    // vanish exactly when someone was trying to turn it on.
    await withEnv({ GENERATION_SPEND_LIMIT_PER_PROJECT: "twenty USD" }, async () => {
      const ceilings = spendCeilings();
      assert.equal(ceilingsAreConfigured(ceilings), true);
      assert.deepEqual(ceilings.malformed, ["GENERATION_SPEND_LIMIT_PER_PROJECT"]);
    });
  });

  it("blocks unpriced calls unless told otherwise", async () => {
    await withEnv({ GENERATION_SPEND_UNPRICED: undefined }, async () => {
      assert.equal(spendCeilings().unpriced, "block");
    });
    await withEnv({ GENERATION_SPEND_UNPRICED: "allow" }, async () => {
      assert.equal(spendCeilings().unpriced, "allow");
    });
    // Anything that is not the word "allow" is the safe reading.
    await withEnv({ GENERATION_SPEND_UNPRICED: "yes" }, async () => {
      assert.equal(spendCeilings().unpriced, "block");
    });
  });

  it("falls back to the attempt window rather than a second one of its own", async () => {
    await withEnv(
      { GENERATION_SPEND_WINDOW_HOURS: undefined, GENERATION_LIMIT_WINDOW_HOURS: "6" },
      async () => {
        assert.equal(spendCeilings().windowHours, 6);
      }
    );
    await withEnv(
      { GENERATION_SPEND_WINDOW_HOURS: "12", GENERATION_LIMIT_WINDOW_HOURS: "6" },
      async () => {
        assert.equal(spendCeilings().windowHours, 12);
      }
    );
  });
});

// --- pricing the call that has not happened yet ------------------------------

describe("estimating what a call will cost", () => {
  it("prices a video by its stated length", async () => {
    await withEnv({ GENERATION_RATES: VEO_RATE }, async () => {
      const estimate = estimateCost({
        providerId: "google-veo",
        model: "veo-3.1-generate-preview",
        mode: "VIDEO",
        durationSeconds: 8,
      });
      assert.equal(estimate.micros, 1_200_000, "8 seconds at 150000 micros");
      assert.equal(estimate.currency, "USD");
    });
  });

  it("returns an unknown cost rather than zero when nothing prices it", async () => {
    await withEnv({ GENERATION_RATES: undefined }, async () => {
      const estimate = estimateCost({ providerId: "google-veo", mode: "VIDEO", durationSeconds: 8 });
      assert.equal(estimate.micros, null, "unknown is not free");
      assert.equal(estimate.currency, null);
      assert.equal(estimate.source, null);
    });
  });
});

// --- the gate ----------------------------------------------------------------

describe("with no ceiling configured", () => {
  it("allows everything, leaving the attempt limits as the only guard", async () => {
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: undefined,
        GENERATION_SPEND_LIMIT_PER_USER: undefined,
        GENERATION_RATES: undefined,
      },
      async () => {
        const result = await check();
        assert.equal(result.ok, true, "a ceiling nobody asked for must not appear on its own");
      }
    );
  });
});

describe("a ceiling that cannot be read", () => {
  it("stops generation instead of quietly not applying", async () => {
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "twenty USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check();
        assert.equal(result.ok, false);
        assert.match(result.reason ?? "", /GENERATION_SPEND_LIMIT_PER_PROJECT/);
        assert.match(result.reason ?? "", /could not be read/);
        // The fix is in the message, because the operator is the only one who
        // can apply it and they are not reading this file.
        assert.match(result.reason ?? "", /25 USD/);
      }
    );
  });

  it("names both variables when both are broken", async () => {
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: "lots",
        GENERATION_SPEND_LIMIT_PER_USER: "more",
        GENERATION_RATES: VEO_RATE,
      },
      async () => {
        const result = await check();
        assert.match(result.reason ?? "", /GENERATION_SPEND_LIMIT_PER_PROJECT/);
        assert.match(result.reason ?? "", /GENERATION_SPEND_LIMIT_PER_USER/);
      }
    );
  });
});

describe("spend the ceiling cannot measure", () => {
  it("refuses a call no rate can price, and says which provider needs one", async () => {
    // The hole this closes: counting an unpriceable call as zero would let an
    // unpriced provider spend without limit, under a ceiling that reports
    // itself as untouched.
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: undefined },
      async () => {
        const result = await check();
        assert.equal(result.ok, false);
        assert.match(result.reason ?? "", /No rate is configured for google-veo/);
        assert.match(result.reason ?? "", /GENERATION_RATES/);
        assert.match(result.reason ?? "", /GENERATION_SPEND_UNPRICED=allow/);
      }
    );
  });

  it("lets it through when the operator has said so in writing", async () => {
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD",
        GENERATION_RATES: undefined,
        GENERATION_SPEND_UNPRICED: "allow",
      },
      async () => {
        const result = await check();
        assert.equal(result.ok, true);
      }
    );
  });

  it("warns when earlier calls in the window were unpriced", async () => {
    await spend({ seconds: 5 });
    await spendUnpriced();

    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check();
        assert.equal(result.ok, true, "the measured total is still under the ceiling");
        assert.match(result.warning ?? "", /1 earlier call/);
        assert.match(result.warning ?? "", /lower than the real bill/);
      }
    );
  });

  it("warns when a ceiling names a currency nothing is priced in", async () => {
    // The quiet trap this warning exists for: "25 dollars" parses, because a
    // currency may be called anything the rate table calls it. It simply never
    // matches USD spend, and without the warning it would look like protection.
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: "25 dollars",
        GENERATION_SPEND_LIMIT_PER_USER: undefined,
        GENERATION_RATES: VEO_RATE,
      },
      async () => {
        const result = await check();
        assert.equal(result.ok, true, "nothing is priced in DOLLARS, so nothing crosses it");
        assert.match(result.warning ?? "", /No ceiling is set for USD/);
      }
    );
  });

  it("warns when the call's currency has no ceiling at all", async () => {
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: "25 EUR",
        GENERATION_SPEND_LIMIT_PER_USER: undefined,
        GENERATION_RATES: VEO_RATE,
      },
      async () => {
        const result = await check();
        assert.equal(result.ok, true);
        assert.match(result.warning ?? "", /No ceiling is set for USD/);
      }
    );
  });
});

describe("the project ceiling", () => {
  it("allows a call that stays under it", async () => {
    await spend({ seconds: 10 }); // 10 USD
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check();
        assert.equal(result.ok, true, "10 spent + 1.20 estimated is under 25");
      }
    );
  });

  it("refuses the call that would cross it, rather than the one after", async () => {
    // 24.50 spent, a 1.20 call pending, a 25 ceiling. Counting only what has
    // been spent would allow this and land at 25.70.
    await spend({ seconds: 24.5 });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check();
        assert.equal(result.ok, false);
        assert.match(result.reason ?? "", /This project has spent/);
        assert.match(result.reason ?? "", /would add/);
      }
    );
  });

  it("counts only this project's spend", async () => {
    await spend({ seconds: 30, project: otherProjectId });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        assert.equal((await check()).ok, true, "another project's bill is not this one's");
      }
    );
  });

  it("keeps currencies apart instead of converting them", async () => {
    // 30 EUR of spend against a 25 USD ceiling. There is no exchange rate here
    // and inventing one would be the same failure as inventing a price.
    await spend({ seconds: 30, currency: "EUR" });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        assert.equal((await check()).ok, true);
      }
    );
  });

  it("refuses when a ceiling in any currency is already breached", async () => {
    // The pending call is in USD, but the EUR ceiling has already gone. A
    // breached ceiling is breached whatever this particular call is priced in.
    await spend({ seconds: 30, currency: "EUR" });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 EUR, 100 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check();
        assert.equal(result.ok, false);
        assert.match(result.reason ?? "", /EUR/);
      }
    );
  });
});

describe("the per-user ceiling", () => {
  it("follows the person across projects", async () => {
    // Otherwise the project ceiling is sidestepped by making more projects.
    await spend({ seconds: 20, project: otherProjectId });
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: undefined,
        GENERATION_SPEND_LIMIT_PER_USER: "20 USD",
        GENERATION_RATES: VEO_RATE,
      },
      async () => {
        const result = await check();
        assert.equal(result.ok, false);
        assert.match(result.reason ?? "", /You have spent/);
      }
    );
  });

  it("does not charge one person's spend to another", async () => {
    await spend({ seconds: 30, user: otherUserId });
    await withEnv(
      {
        GENERATION_SPEND_LIMIT_PER_PROJECT: undefined,
        GENERATION_SPEND_LIMIT_PER_USER: "20 USD",
        GENERATION_RATES: VEO_RATE,
      },
      async () => {
        assert.equal((await check()).ok, true);
      }
    );
  });
});

describe("what a ceiling never applies to", () => {
  it("lets the local stub through, ceiling or not", async () => {
    // A stub costs nothing, so no amount of it can cross a spend ceiling.
    // Throttling it would only get in the way during development.
    await spend({ seconds: 1000 });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "1 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        const result = await check({ providerKind: "stub" });
        assert.equal(result.ok, true);
      }
    );
  });

  it("ignores spend older than the window", async () => {
    await spend({ seconds: 100 });
    await withEnv(
      { GENERATION_SPEND_LIMIT_PER_PROJECT: "25 USD", GENERATION_RATES: VEO_RATE },
      async () => {
        // The spend above was recorded just now; a check dated two days later
        // sees it fall out of a rolling 24h window.
        const later = new Date(Date.now() + 48 * 3_600_000);
        assert.equal((await check({ now: later })).ok, true);
        assert.equal((await check()).ok, false, "and is still inside it right now");
      }
    );
  });
});

// --- reporting ---------------------------------------------------------------

describe("how much of a ceiling is used", () => {
  it("reports each currency against its own ceiling", async () => {
    await spend({ seconds: 5 });
    const spent = await spendFor({ projectId }, prisma);
    const status = ceilingStatus(spent, new Map([["USD", 20_000_000]]));

    assert.equal(status.length, 1);
    assert.equal(status[0].spentMicros, 5_000_000);
    assert.equal(status[0].fraction, 0.25);
    assert.equal(status[0].over, false);
  });

  it("reports a ceiling with no spend against it as empty, not missing", async () => {
    const spent = await spendFor({ projectId }, prisma);
    const status = ceilingStatus(spent, new Map([["USD", 20_000_000]]));
    assert.equal(status[0].spentMicros, 0);
    assert.equal(status[0].fraction, 0);
  });

  it("clamps a breached ceiling at full while still reporting it as over", async () => {
    await spend({ seconds: 30 });
    const spent = await spendFor({ projectId }, prisma);
    const status = ceilingStatus(spent, new Map([["USD", 20_000_000]]));

    assert.equal(status[0].fraction, 1, "a bar cannot be more than full");
    assert.equal(status[0].over, true, "but the fact that it is over is not lost");
    assert.equal(status[0].spentMicros, 30_000_000, "nor is the real figure");
  });
});
