import "server-only";

/**
 * What a provider charges, as configured by the operator.
 *
 * ## Why there are no default prices
 *
 * This file ships with an empty rate table, and that is deliberate. Provider
 * pricing is not knowable from inside this codebase: it changes without notice,
 * it differs per account, per region and per model, and a preview model may not
 * be priced publicly at all. A hard-coded number would be a guess wearing the
 * costume of a fact, and the whole point of this ledger is to survive an audit.
 *
 * So an unconfigured provider yields no rate, the usage row records `null`
 * cost, and the aggregation reports it as unpriced. That is strictly more
 * useful than a confident wrong total: the operator can see exactly which calls
 * are unaccounted for and configure them, whereas a fabricated figure would
 * quietly under- or over-state a real bill with nothing to flag it.
 *
 * ## Configuration
 *
 * One JSON object in GENERATION_RATES, keyed by `providerId` or, to override a
 * single model, `providerId:model`. The more specific key wins.
 *
 *   GENERATION_RATES='{
 *     "openai-image":            { "unit": "IMAGE",        "micros": 40000, "currency": "USD" },
 *     "google-veo:veo-3.1-lite-generate-preview":
 *                                { "unit": "VIDEO_SECOND", "micros": 150000, "currency": "USD" }
 *   }'
 *
 * The values above are illustrative placeholders, not Google's or OpenAI's
 * prices. Take the real ones from the provider's own pricing page.
 *
 * Money is in **micros** — millionths of one currency unit — as an integer.
 * A fraction of a cent per second of video is exactly the scale at which
 * floating-point currency goes wrong, so it is never stored as a float.
 */

export type UsageUnit = "IMAGE" | "VIDEO_SECOND" | "CALL";

export interface ProviderRate {
  unit: UsageUnit;
  /** Cost of one unit, in millionths of a currency unit. */
  micros: number;
  currency: string;
  /** The configuration key this came from, carried through to the ledger. */
  source: string;
}

const UNITS: readonly UsageUnit[] = ["IMAGE", "VIDEO_SECOND", "CALL"] as const;

/**
 * Parses GENERATION_RATES.
 *
 * A malformed entry is dropped rather than guessed at, and never throws: a
 * typo in an operator's rate table must not stop generation from working. The
 * consequence of a dropped entry is an unpriced usage row, which is visible in
 * the spend report — a loud enough failure without being a fatal one.
 */
export function configuredRates(): Map<string, ProviderRate> {
  const raw = process.env.GENERATION_RATES?.trim();
  const table = new Map<string, ProviderRate>();
  if (!raw) return table;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return table;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return table;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;

    const unit = entry.unit;
    const micros = entry.micros;
    const currency = entry.currency;

    if (typeof unit !== "string" || !UNITS.includes(unit as UsageUnit)) continue;
    // Negative or non-integer money is a configuration error, not a discount.
    if (typeof micros !== "number" || !Number.isInteger(micros) || micros < 0) continue;
    if (typeof currency !== "string" || currency.length === 0) continue;

    table.set(key, {
      unit: unit as UsageUnit,
      micros,
      currency,
      source: `GENERATION_RATES[${key}]`,
    });
  }
  return table;
}

/**
 * The rate for one provider and model, or undefined when none is configured.
 *
 * Undefined is a first-class answer here, not an error case. Callers must
 * record the usage anyway and leave the cost null.
 */
export function rateFor(providerId: string, model?: string | null): ProviderRate | undefined {
  const table = configuredRates();
  if (model) {
    const specific = table.get(`${providerId}:${model}`);
    if (specific) return specific;
  }
  return table.get(providerId);
}

/**
 * Multiplies a rate by a quantity, rounding to whole micros.
 *
 * Rounds half up rather than truncating: truncation is a systematic
 * under-count, and a spend figure that is quietly always a little low is worse
 * than one that is occasionally a micro high.
 */
export function costMicrosFor(rate: ProviderRate, quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;
  return Math.round(rate.micros * quantity);
}

/** Formats micros for display. Presentation only — never used for arithmetic. */
export function formatMicros(micros: number, currency: string): string {
  const units = micros / 1_000_000;
  return `${units.toFixed(units < 1 ? 4 : 2)} ${currency}`;
}
