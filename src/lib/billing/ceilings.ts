import "server-only";

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { generationLimits } from "@/lib/generation-limits";
import { costMicrosFor, formatMicros, rateFor } from "./rates.ts";
import { quantityFor, spendFor, type Spend } from "./usage.ts";

/**
 * Spend ceilings: a cap on money, as opposed to a cap on attempts.
 *
 * ## Why this is not the same thing as `generation-limits.ts`
 *
 * That file counts *attempts* and has a finite default for every limit, because
 * an attempt is always countable — one call is one call, whatever it cost. Money
 * is not like that. What a call costs is knowable only from the operator's own
 * rate table, and this codebase deliberately ships without prices (see
 * `rates.ts`). So a spend ceiling cannot have a default: a default would be a
 * number of currency units in a currency nobody named, measured against prices
 * nobody configured.
 *
 * The consequence is that ceilings are **opt-in**. With nothing configured this
 * module allows everything and the attempt limits remain the only protection.
 * That is the honest position — but it is also why the two failure modes below
 * are handled the way they are, because an opt-in guard that quietly fails open
 * is worse than no guard at all.
 *
 * ## Failure mode one: a ceiling that cannot be parsed
 *
 * `rates.ts` drops a malformed entry and carries on, because the consequence is
 * a visible unpriced row in the spend report. A ceiling is the opposite: a
 * dropped ceiling is an *invisible* removal of a limit the operator asked for.
 * So a ceiling variable that is set but unintelligible refuses every paid
 * generation and names the variable. Loud and stopped beats quiet and
 * unbounded.
 *
 * ## Failure mode two: spend that cannot be measured
 *
 * A provider with no configured rate produces a null cost. Counting null as
 * zero would let an unpriced provider spend without limit — precisely the hole
 * a ceiling exists to close. So when a ceiling is configured, an unpriceable
 * call is refused by default, naming the provider that needs a rate.
 * `GENERATION_SPEND_UNPRICED=allow` opts out, and is the operator saying in
 * writing that they accept spend the ceiling cannot see.
 *
 * ## Currencies are never converted
 *
 * A ceiling is stated per currency and compared only against spend in that
 * currency, for the same reason the ledger keeps them apart: this application
 * has no exchange rate, and inventing one is the same failure as inventing a
 * price. Spend in a currency with no ceiling is unbounded, and says so.
 */

type Db = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** What happens to a call whose cost cannot be worked out. */
export type UnpricedPolicy = "block" | "allow";

export interface SpendCeilings {
  /** Currency to ceiling in micros. Empty when none is configured. */
  perProject: Map<string, number>;
  perUser: Map<string, number>;
  windowHours: number;
  unpriced: UnpricedPolicy;
  /**
   * Variables that were set but could not be read. Never silently ignored —
   * see "Failure mode one" above.
   */
  malformed: string[];
}

export interface ParsedCeiling {
  limits: Map<string, number>;
  ok: boolean;
}

/**
 * Reads a ceiling: a comma-separated list of `<amount> <CURRENCY>` pairs.
 *
 *     GENERATION_SPEND_LIMIT_PER_PROJECT="25 USD"
 *     GENERATION_SPEND_LIMIT_PER_USER="10 USD, 8 EUR"
 *
 * The currency is required and has no default, because there is no currency
 * this application could assume without being wrong for somebody. Amounts are
 * in whole currency units and converted to the micros the ledger stores.
 *
 * Any unreadable pair makes the whole value unreadable. Partially applying a
 * ceiling would mean enforcing a limit the operator did not write.
 */
export function parseCeiling(raw: string | undefined): ParsedCeiling {
  const limits = new Map<string, number>();
  const text = raw?.trim();
  if (!text) return { limits, ok: true };

  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;

    const match = /^(\d+(?:\.\d+)?)\s+([A-Za-z]{3,8})$/.exec(piece);
    if (!match) return { limits: new Map(), ok: false };

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return { limits: new Map(), ok: false };

    const currency = match[2].toUpperCase();
    // A currency named twice is ambiguous: two ceilings, and no way to tell
    // which the operator meant. Refused rather than last-one-wins.
    if (limits.has(currency)) return { limits: new Map(), ok: false };

    limits.set(currency, Math.round(amount * 1_000_000));
  }

  return { limits, ok: true };
}

function unpricedPolicy(): UnpricedPolicy {
  return process.env.GENERATION_SPEND_UNPRICED?.trim().toLowerCase() === "allow"
    ? "allow"
    : "block";
}

export function spendCeilings(): SpendCeilings {
  const project = parseCeiling(process.env.GENERATION_SPEND_LIMIT_PER_PROJECT);
  const user = parseCeiling(process.env.GENERATION_SPEND_LIMIT_PER_USER);

  const malformed: string[] = [];
  if (!project.ok) malformed.push("GENERATION_SPEND_LIMIT_PER_PROJECT");
  if (!user.ok) malformed.push("GENERATION_SPEND_LIMIT_PER_USER");

  const raw = Number(process.env.GENERATION_SPEND_WINDOW_HOURS);
  return {
    perProject: project.limits,
    perUser: user.limits,
    // Defaults to the attempt window so that an operator who has set one
    // rolling window does not silently get two of different lengths.
    windowHours:
      Number.isInteger(raw) && raw > 0 ? raw : generationLimits().windowHours,
    unpriced: unpricedPolicy(),
    malformed,
  };
}

/** True when anything at all is configured — including a broken configuration. */
export function ceilingsAreConfigured(ceilings: SpendCeilings): boolean {
  return (
    ceilings.perProject.size > 0 ||
    ceilings.perUser.size > 0 ||
    ceilings.malformed.length > 0
  );
}

export type SpendCheck = {
  ok: boolean;
  /** Why it was refused. Present only when `ok` is false. */
  reason?: string;
  /**
   * The measured total is knowably incomplete, but not enough to refuse.
   * Surfaced so an operator can see the ceiling is weaker than it looks.
   */
  warning?: string;
};

const ALLOWED: SpendCheck = { ok: true };

/** What this call is expected to cost, before it is made. */
export interface EstimatedCost {
  micros: number | null;
  currency: string | null;
  /** The rate key it was priced from, or null when nothing priced it. */
  source: string | null;
}

export function estimateCost(facts: {
  providerId: string;
  model?: string | null;
  mode: "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";
  durationSeconds?: number | null;
  images?: number;
}): EstimatedCost {
  const rate = rateFor(facts.providerId, facts.model);
  if (!rate) return { micros: null, currency: null, source: null };

  const { quantity } = quantityFor(facts);
  return {
    micros: costMicrosFor(rate, quantity),
    currency: rate.currency,
    source: rate.source,
  };
}

/** The first ceiling this spend would cross, or null when it crosses none. */
function crossed(
  spend: Spend,
  ceilings: Map<string, number>,
  estimate: EstimatedCost
): { currency: string; spentMicros: number; addingMicros: number; ceilingMicros: number } | null {
  for (const [currency, ceilingMicros] of ceilings) {
    const spentMicros = spend.pricedMicros[currency] ?? 0;
    // A ceiling in another currency is still checked against what has already
    // been spent in it: a ceiling already breached is breached whatever this
    // particular call is priced in.
    const addingMicros =
      estimate.currency === currency && estimate.micros !== null ? estimate.micros : 0;

    if (spentMicros + addingMicros > ceilingMicros) {
      return { currency, spentMicros, addingMicros, ceilingMicros };
    }
  }
  return null;
}

function refusal(
  scope: "This project" | "You",
  hit: NonNullable<ReturnType<typeof crossed>>,
  windowHours: number
): string {
  const spent = formatMicros(hit.spentMicros, hit.currency);
  const ceiling = formatMicros(hit.ceilingMicros, hit.currency);
  const adding =
    hit.addingMicros > 0 ? ` This generation would add ${formatMicros(hit.addingMicros, hit.currency)}.` : "";
  return `${scope} ${scope === "You" ? "have" : "has"} spent ${spent} in the last ${windowHours}h; the ceiling is ${ceiling}.${adding}`;
}

/**
 * Decides whether one more paid generation is within the configured ceilings.
 *
 * Checked before the generation row is created, and the estimate is added to
 * the total rather than compared against it: the point is to stop the call that
 * *would* cross the line, not to notice afterwards that it did.
 */
export async function checkSpendAllowed(
  options: {
    projectId: string;
    userId: string;
    providerId: string;
    model?: string | null;
    mode: "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";
    providerKind: "real" | "stub";
    durationSeconds?: number | null;
    images?: number;
    now?: Date;
  },
  db: Db = defaultPrisma
): Promise<SpendCheck> {
  // A stub spends nothing, so no ceiling can apply to it.
  if (options.providerKind === "stub") return ALLOWED;

  const ceilings = spendCeilings();
  if (!ceilingsAreConfigured(ceilings)) return ALLOWED;

  if (ceilings.malformed.length > 0) {
    return {
      ok: false,
      reason: `${ceilings.malformed.join(" and ")} could not be read, so the spend ceiling is not in force. Generation is stopped until it is fixed. The format is "25 USD", or "25 USD, 20 EUR" for more than one currency.`,
    };
  }

  const estimate = estimateCost(options);

  if (estimate.micros === null && ceilings.unpriced === "block") {
    return {
      ok: false,
      reason: `No rate is configured for ${options.providerId}${options.model ? ` (${options.model})` : ""}, so this generation's cost cannot be counted against the spend ceiling. Add it to GENERATION_RATES, or set GENERATION_SPEND_UNPRICED=allow to accept spend the ceiling cannot see.`,
    };
  }

  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - ceilings.windowHours * 3_600_000);

  const [projectSpend, userSpend] = await Promise.all([
    ceilings.perProject.size > 0
      ? spendFor({ projectId: options.projectId, since }, db)
      : null,
    ceilings.perUser.size > 0 ? spendFor({ userId: options.userId, since }, db) : null,
  ]);

  if (projectSpend) {
    const hit = crossed(projectSpend, ceilings.perProject, estimate);
    if (hit) return { ok: false, reason: refusal("This project", hit, ceilings.windowHours) };
  }
  if (userSpend) {
    const hit = crossed(userSpend, ceilings.perUser, estimate);
    if (hit) return { ok: false, reason: refusal("You", hit, ceilings.windowHours) };
  }

  return { ok: true, warning: incompleteness(ceilings, projectSpend, userSpend, estimate) };
}

/**
 * Ways the measured total is known to be lower than the real one.
 *
 * None of these is enough to refuse — the ceiling has not been crossed by what
 * can be seen — but each means it is weaker than it looks, and an operator
 * reading "you are at half your ceiling" deserves to know when that figure is
 * missing something.
 */
function incompleteness(
  ceilings: SpendCeilings,
  projectSpend: Spend | null,
  userSpend: Spend | null,
  estimate: EstimatedCost
): string | undefined {
  const notes: string[] = [];

  const unpriced = (projectSpend?.unpricedCalls ?? 0) + (userSpend?.unpricedCalls ?? 0);
  if (unpriced > 0) {
    notes.push(
      `${unpriced} earlier call${unpriced === 1 ? "" : "s"} in this window had no configured rate, so the totals below are lower than the real bill.`
    );
  }

  // A priced call in a currency nobody set a ceiling for is unbounded. Worth
  // saying, because it looks protected and is not.
  if (
    estimate.currency &&
    !ceilings.perProject.has(estimate.currency) &&
    !ceilings.perUser.has(estimate.currency)
  ) {
    notes.push(`No ceiling is set for ${estimate.currency}, so spend in it is not capped.`);
  }

  return notes.length > 0 ? notes.join(" ") : undefined;
}

/**
 * Where a scope stands against its ceilings, for the spend report.
 *
 * Read-only and does not consider a prospective call — this answers "how much
 * of the ceiling is used", not "may I generate".
 */
export interface CeilingStatus {
  currency: string;
  spentMicros: number;
  ceilingMicros: number;
  /** 0 to 1, clamped: a breached ceiling reads as full rather than over-full. */
  fraction: number;
  over: boolean;
}

export function ceilingStatus(
  spend: Spend,
  ceilings: Map<string, number>
): CeilingStatus[] {
  return [...ceilings].map(([currency, ceilingMicros]) => {
    const spentMicros = spend.pricedMicros[currency] ?? 0;
    return {
      currency,
      spentMicros,
      ceilingMicros,
      fraction: ceilingMicros > 0 ? Math.min(1, spentMicros / ceilingMicros) : 1,
      over: spentMicros > ceilingMicros,
    };
  });
}
