import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { formatMicros } from "@/lib/billing/rates";
import type { AttemptRow, PersonSpend, Spend, UsageGroup } from "@/lib/billing/usage";

/**
 * The spend report's presentation layer.
 *
 * One rule runs through all of it: **usage and cost are different columns, and
 * an unpriced call is shown as unpriced.** Never as zero, never as a dash that
 * could be read as nothing, and never folded into a total. A filmmaker looking
 * at this screen must be able to tell at a glance whether a number is the whole
 * story, and the answer is visible on every row.
 *
 * These are server components: they render from data the page already fetched
 * behind `requireProjectAccess`, hold no state, and reach nothing themselves.
 */

const UNIT_LABEL: Record<string, string> = {
  IMAGE: "images",
  VIDEO_SECOND: "video seconds",
  CALL: "calls",
};

function unitLabel(unit: string, quantity: number): string {
  const label = UNIT_LABEL[unit] ?? unit.toLowerCase();
  return quantity === 1 ? label.replace(/s$/, "") : label;
}

/** Formats money, or says plainly that there is no price rather than printing 0. */
function cost(costMicros: number | null, currency: string | null) {
  if (costMicros === null || currency === null) {
    return <span className="text-muted">Unpriced</span>;
  }
  return <span className="tabular-nums">{formatMicros(costMicros, currency)}</span>;
}

// --- summary -----------------------------------------------------------------

/**
 * Totals what was consumed, per unit.
 *
 * Never across units: adding video seconds to images would produce a number
 * that looks like a total and means nothing. Derived from the groups the page
 * already fetched rather than from another query, so the figure cannot drift
 * away from the breakdown below it.
 */
function totalsByUnit(groups: UsageGroup[]): Array<{ unit: string; quantity: number }> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    totals.set(group.unit, (totals.get(group.unit) ?? 0) + group.quantity);
  }
  return [...totals.entries()].map(([unit, quantity]) => ({ unit, quantity }));
}

export function SpendSummary({
  spend,
  groups,
  pricingConfigured,
}: {
  spend: Spend;
  groups: UsageGroup[];
  pricingConfigured: boolean;
}) {
  const currencies = Object.entries(spend.pricedMicros);
  const usage = totalsByUnit(groups);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Paid attempts" value={String(spend.totalCalls)} hint="Calls to a billed provider" />
        <Stat
          label="Usage"
          value={
            usage.length === 0
              ? "—"
              : usage
                  .map((u) => `${u.quantity.toLocaleString()} ${unitLabel(u.unit, u.quantity)}`)
                  .join(" · ")
          }
          hint="What was consumed — not a cost"
        />
        <Stat
          label="Priced"
          value={
            currencies.length === 0
              ? "—"
              : currencies.map(([c, micros]) => formatMicros(micros, c)).join(" · ")
          }
          hint={`${spend.pricedCalls} of ${spend.totalCalls} attempts`}
        />
        <Stat
          label="Unpriced"
          value={String(spend.unpricedCalls)}
          hint="Cost not known — excluded from the total"
          tone={spend.unpricedCalls > 0 ? "warn" : "default"}
        />
      </div>

      {spend.unpricedCalls > 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium text-foreground">
            {spend.unpricedCalls} attempt{spend.unpricedCalls === 1 ? "" : "s"} could not be priced
          </p>
          <p className="mt-1 text-sm text-muted">
            {pricingIsMissingEntirely(pricingConfigured)
              ? "No provider rates are configured, so this application does not know what these calls cost. It records what they consumed and refuses to guess a price — an invented figure would look authoritative and be wrong."
              : "A rate is configured, but not one that matches what these calls consumed. Check that the unit in GENERATION_RATES matches how the provider bills."}{" "}
            Set the real figures from the provider&rsquo;s own pricing page in{" "}
            <code className="rounded bg-surface px-1 py-0.5 text-xs">GENERATION_RATES</code> and this
            history becomes priceable — nothing needs regenerating.
          </p>
        </Card>
      )}

      {currencies.length > 1 && (
        <p className="text-sm text-muted">
          Totals are kept per currency and never converted: this application has no exchange rate,
          and inventing one would be the same error as inventing a price.
        </p>
      )}
    </div>
  );
}

function pricingIsMissingEntirely(configured: boolean): boolean {
  return !configured;
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn";
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === "warn" ? "text-amber-500" : "text-foreground"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

// --- by provider and model ---------------------------------------------------

export function UsageByProvider({ groups }: { groups: UsageGroup[] }) {
  if (groups.length === 0) return null;

  return (
    <Card className="p-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">By provider and model</h2>
        <p className="mt-0.5 text-xs text-muted">
          Usage is what was consumed. Cost is what it was priced at — the two are separate columns
          on purpose.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 text-right font-medium">Attempts</th>
              <th className="px-4 py-2 text-right font-medium">Usage</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr
                key={`${group.providerId}|${group.model}|${group.unit}|${group.currency}`}
                className="border-b border-border last:border-0"
              >
                <td className="px-4 py-2.5 font-medium text-foreground">{group.providerId}</td>
                <td className="px-4 py-2.5 text-muted">{group.model ?? "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{group.calls}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {group.quantity.toLocaleString()}{" "}
                  <span className="text-muted">{unitLabel(group.unit, group.quantity)}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {cost(group.costMicros, group.currency)}
                  {group.unpricedCalls > 0 && group.costMicros !== null && (
                    <span className="ml-2 text-xs text-amber-500">
                      +{group.unpricedCalls} unpriced
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// --- by person ---------------------------------------------------------------

export function SpendByPerson({ people }: { people: PersonSpend[] }) {
  if (people.length === 0) return null;

  return (
    <Card className="p-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">By who started it</h2>
      </div>
      <ul className="divide-y divide-border">
        {people.map((person) => (
          <li
            key={person.userId ?? "unknown"}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{person.name}</p>
              {person.userId === null && (
                <p className="text-xs text-muted">
                  Generations from before spend attribution existed. Charged to nobody rather than
                  to someone convenient.
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 text-sm">
              <span className="tabular-nums text-muted">
                {person.calls} attempt{person.calls === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums">
                {Object.entries(person.pricedMicros).length === 0
                  ? <span className="text-muted">Unpriced</span>
                  : Object.entries(person.pricedMicros)
                      .map(([c, micros]) => formatMicros(micros, c))
                      .join(" · ")}
              </span>
              {person.unpricedCalls > 0 && (
                <Badge tone="default">{person.unpricedCalls} unpriced</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- the individual calls ----------------------------------------------------

/**
 * The whole-page empty state.
 *
 * An empty ledger genuinely means nothing was spent, so unlike the error state
 * this one is safe to state plainly — but it still says *why* it might be
 * empty, because "no paid generations" and "generations ran but were not
 * recorded" would otherwise look identical to someone reading the screen.
 */
export function NoUsageYet() {
  return (
    <Card className="p-0">
      <EmptyState
        title="No paid generations yet"
        description="Nothing in this project has called a billed provider. The local stub costs nothing and is not a billable event, so it is never recorded here."
      />
    </Card>
  );
}

export function RecentAttempts({
  attempts,
  projectId,
}: {
  attempts: AttemptRow[];
  projectId: string;
}) {
  if (attempts.length === 0) return null;

  return (
    <Card className="p-0">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Recent attempts</h2>
        <p className="mt-0.5 text-xs text-muted">
          One row per provider call. A generation that was submitted, failed and resubmitted appears
          twice, because it was billed twice.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Provider / model</th>
              <th className="px-4 py-2 font-medium">Mode</th>
              <th className="px-4 py-2 font-medium">Started by</th>
              <th className="px-4 py-2 text-right font-medium">Usage</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => (
              <tr key={attempt.id} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                  {attempt.occurredAt.toISOString().replace("T", " ").slice(0, 16)}
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-medium text-foreground">{attempt.providerId}</span>
                  {attempt.model && (
                    <span className="block text-xs text-muted">{attempt.model}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{attempt.mode}</td>
                <td className="px-4 py-2.5 text-muted">{attempt.startedBy?.name ?? "Unknown"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {attempt.quantity.toLocaleString()}{" "}
                  <span className="text-muted">{unitLabel(attempt.unit, attempt.quantity)}</span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {cost(attempt.costMicros, attempt.currency)}
                  {attempt.costMicros === null && (
                    <span className="block text-xs text-muted">{attempt.rateSource}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-4 py-2 text-xs text-muted">
        Showing the most recent {attempts.length}. The totals above are computed from the whole
        ledger, not from this list.{" "}
        <Link href={`/projects/${projectId}`} className="underline hover:text-foreground">
          Back to overview
        </Link>
      </div>
    </Card>
  );
}
