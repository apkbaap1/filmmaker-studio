import "server-only";

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { costMicrosFor, rateFor, type UsageUnit } from "./rates.ts";

/**
 * The spend ledger: one row per call to a paid provider.
 *
 * ## Why per attempt, not per generation
 *
 * A job that is submitted, fails, and is resubmitted was billed twice. Writing
 * one row per Generation would collapse those and understate the bill by
 * exactly the amount that matters — the money spent on the attempt that did not
 * work. So this records attempts, and `spendFor` sums them.
 *
 * ## Why it never records a stub
 *
 * The local stub costs nothing. Recording zero-cost rows for it would bury real
 * spend in noise and make "how much has this project cost" require a filter to
 * answer correctly. A stub call is simply not a billable event.
 *
 * ## Why unknown cost is carried rather than defaulted
 *
 * When no rate is configured, the row still records what was consumed and
 * leaves the cost null. `spendFor` then reports priced and unpriced separately.
 * Summing an unpriced call as zero would make a real bill look free, which is
 * the one error this table exists to prevent.
 */

type Db = PrismaClient | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export interface AttemptFacts {
  generationId: string;
  projectId: string;
  userId?: string | null;
  providerId: string;
  model?: string | null;
  mode: "IMAGE" | "VIDEO" | "IMAGE_TO_VIDEO";
  providerKind: "real" | "stub";
  /**
   * Clip length, for video. Absent when the filmmaker never chose one — in that
   * case the provider used a default this application does not know, so the
   * billable seconds are genuinely unknown and the row falls back to CALL.
   */
  durationSeconds?: number | null;
  /** Number of images, for the image modes. Defaults to one. */
  images?: number;
}

/**
 * Decides what was consumed, in the unit the configured rate bills in.
 *
 * The rate's unit leads, because the operator knows how their contract is
 * priced and this code does not. With no rate configured the quantity is still
 * recorded, so that configuring a rate later makes the history priceable.
 */
export function quantityFor(facts: AttemptFacts): { quantity: number; unit: UsageUnit } {
  const rate = rateFor(facts.providerId, facts.model);
  const isVideo = facts.mode === "VIDEO" || facts.mode === "IMAGE_TO_VIDEO";

  if (rate?.unit === "CALL") return { quantity: 1, unit: "CALL" };

  if (isVideo) {
    const seconds = facts.durationSeconds;
    // A clip of unstated length bills an unknown number of seconds. Recording
    // an assumed default here would be inventing the filmmaker's decision and
    // then invoicing them for it.
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
      return { quantity: 1, unit: "CALL" };
    }
    return { quantity: seconds, unit: "VIDEO_SECOND" };
  }

  return { quantity: facts.images ?? 1, unit: "IMAGE" };
}

export interface RecordedAttempt {
  id: string;
  quantity: number;
  unit: UsageUnit;
  costMicros: number | null;
  currency: string | null;
  rateSource: string;
}

/**
 * Records one billable provider call.
 *
 * Returns undefined for a stub, which is not a billable event. Never throws on
 * a missing rate: an unpriced call is recorded as unpriced.
 */
export async function recordProviderAttempt(
  facts: AttemptFacts,
  db: Db = defaultPrisma
): Promise<RecordedAttempt | undefined> {
  if (facts.providerKind === "stub") return undefined;

  const { quantity, unit } = quantityFor(facts);
  const rate = rateFor(facts.providerId, facts.model);

  // A rate priced in a different unit than what was consumed cannot be applied
  // without assuming a conversion, so it is not applied at all.
  const applicable = rate && rate.unit === unit ? rate : undefined;
  const costMicros = applicable ? costMicrosFor(applicable, quantity) : null;

  const row = await db.generationUsage.create({
    data: {
      generationId: facts.generationId,
      projectId: facts.projectId,
      userId: facts.userId ?? null,
      providerId: facts.providerId,
      model: facts.model ?? null,
      mode: facts.mode,
      quantity,
      unit,
      unitCostMicros: applicable?.micros ?? null,
      currency: applicable?.currency ?? null,
      costMicros,
      rateSource: applicable
        ? applicable.source
        : rate
          ? `unapplied: rate is per ${rate.unit}, call consumed ${unit}`
          : "unconfigured",
    },
  });

  return {
    id: row.id,
    quantity,
    unit,
    costMicros,
    currency: applicable?.currency ?? null,
    rateSource: row.rateSource,
  };
}

export interface Spend {
  /** Total of the calls that could be priced, per currency. */
  pricedMicros: Record<string, number>;
  /** How many calls were priced, and how many were not. */
  pricedCalls: number;
  /**
   * Calls whose cost is not known, because no rate was configured.
   *
   * Reported separately and never folded into the totals: a figure that silently
   * treats unpriced spend as nothing is worse than no figure at all.
   */
  unpricedCalls: number;
  totalCalls: number;
}

const EMPTY: Spend = { pricedMicros: {}, pricedCalls: 0, unpricedCalls: 0, totalCalls: 0 };

/**
 * Sums the ledger for a project, a user, or both.
 *
 * Currencies are kept apart rather than converted: this application has no
 * exchange rate and inventing one would be the same failure as inventing a
 * price.
 */
export async function spendFor(
  scope: { projectId?: string; userId?: string; since?: Date },
  db: Db = defaultPrisma
): Promise<Spend> {
  if (!scope.projectId && !scope.userId) return EMPTY;

  const rows = await db.generationUsage.findMany({
    where: {
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.userId ? { userId: scope.userId } : {}),
      ...(scope.since ? { occurredAt: { gte: scope.since } } : {}),
    },
    select: { costMicros: true, currency: true },
  });

  const spend: Spend = { pricedMicros: {}, pricedCalls: 0, unpricedCalls: 0, totalCalls: rows.length };

  for (const row of rows) {
    if (row.costMicros === null || row.currency === null) {
      spend.unpricedCalls += 1;
      continue;
    }
    spend.pricedMicros[row.currency] = (spend.pricedMicros[row.currency] ?? 0) + row.costMicros;
    spend.pricedCalls += 1;
  }
  return spend;
}
