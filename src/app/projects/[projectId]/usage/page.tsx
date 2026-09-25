import { PageHeader } from "@/components/ui";
import { requireProjectAccess } from "@/lib/access";
import {
  pricingIsConfigured,
  recentAttempts,
  spendByPerson,
  spendFor,
  usageBreakdown,
} from "@/lib/billing/usage";
import { ceilingStatus, spendCeilings } from "@/lib/billing/ceilings";
import {
  CeilingMisconfigured,
  CeilingUsage,
  NoUsageYet,
  RecentAttempts,
  SpendByPerson,
  SpendSummary,
  UsageByProvider,
} from "./usage-views";

/**
 * Generation spend for one project.
 *
 * Authorization is `requireProjectAccess`, the same gate every other project
 * page uses — it 404s a project the viewer cannot reach, so the page never
 * distinguishes "no access" from "does not exist". Every query below is scoped
 * to the project id it returns, so nothing from another project can appear
 * here even if a query were wrong about its own filter.
 *
 * Read-only by design: nothing on this screen can start a generation or spend
 * money. It is the receipt, not the till.
 */
export default async function UsagePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  await requireProjectAccess(projectId);

  const ceilings = spendCeilings();
  // The ceiling is measured over its own rolling window, not over all time, so
  // it is a separate query from the lifetime figures below rather than a slice
  // of them.
  const since = new Date(Date.now() - ceilings.windowHours * 3_600_000);

  const [spend, groups, people, attempts, windowSpend] = await Promise.all([
    spendFor({ projectId }),
    usageBreakdown({ projectId }),
    spendByPerson({ projectId }),
    recentAttempts({ projectId, limit: 50 }),
    ceilings.perProject.size > 0 ? spendFor({ projectId, since }) : null,
  ]);

  const configured = pricingIsConfigured();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage & spend"
        subtitle="What every paid provider call consumed, and what it cost where a rate is configured."
      />

      {/* Shown above everything, and even on a project with no spend yet: a
          ceiling that is set but unreadable stops generation, and that is the
          first thing someone looking at this page needs to know. */}
      {ceilings.malformed.length > 0 && <CeilingMisconfigured variables={ceilings.malformed} />}

      {windowSpend && (
        <CeilingUsage
          statuses={ceilingStatus(windowSpend, ceilings.perProject)}
          windowHours={ceilings.windowHours}
          unpricedCalls={windowSpend.unpricedCalls}
          unpricedPolicy={ceilings.unpriced}
        />
      )}

      {spend.totalCalls === 0 ? (
        <NoUsageYet />
      ) : (
        <>
          <SpendSummary spend={spend} groups={groups} pricingConfigured={configured} />
          <UsageByProvider groups={groups} />
          <SpendByPerson people={people} />
          <RecentAttempts attempts={attempts} projectId={projectId} />
        </>
      )}
    </div>
  );
}
