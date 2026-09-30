import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { drainQueue, newWorkerId, type WorkerStats } from "@/lib/jobs/worker";
import { queueDepth } from "@/lib/jobs/queue";

/**
 * The worker, driven by a scheduler instead of a process.
 *
 * ## Why this exists
 *
 * Generation is a long-running job: submit to a provider, then poll it for
 * minutes. `npm run worker` is a process that sits there doing that, and on a
 * host with containers it is the right answer.
 *
 * A serverless platform has no such thing. Every function invocation is bounded
 * and then killed, so nothing can sit and wait. The only way a job finishes
 * there is if something invokes an endpoint on a schedule and that endpoint does
 * as much as it can before its time runs out. That is what this is.
 *
 * It is a worse worker than the process, and the difference is honest: jobs
 * advance in bursts at the scheduler's cadence rather than continuously, so a
 * generation takes at least one interval longer than it needs to. If the
 * platform can run a container, run `npm run worker` instead.
 *
 * ## Why running twice is safe
 *
 * It claims through the same compare-and-swap lease as every other worker.
 * Two overlapping invocations cannot take the same job, and one that is killed
 * mid-step loses its lease by expiry and the job is picked up again. That was
 * built in 11.3 and is tested against a real database; nothing here is new
 * concurrency, which is the point of reusing it.
 *
 * ## Why it stops early
 *
 * `deadlineMs` is deliberately shorter than any platform's function limit. A
 * worker killed by the platform mid-write leaves a job leased until the lease
 * expires — recoverable, but it stalls that job for the lease duration. Ending
 * cleanly with time to spare costs a few seconds of throughput and avoids that.
 */

// Node, not Edge: the job runner reads from storage and speaks to providers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Well under any platform's function ceiling — see the note above. */
const DEFAULT_DEADLINE_MS = 50_000;

function deadlineMs(): number {
  const raw = Number(process.env.CRON_WORKER_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600_000) : DEFAULT_DEADLINE_MS;
}

/**
 * How long to wait before draining again when every remaining job is with a
 * provider and not yet due for its next poll.
 *
 * Short, because the whole point of staying inside one invocation is to notice
 * a provider finishing sooner than the next scheduler tick would.
 */
const POLL_GAP_MS = 2_000;

/**
 * Statuses that mean there is still something for a worker to advance.
 *
 * A job with any of these is either claimable now or waiting on a provider that
 * will make it claimable shortly. Everything else is terminal, and no
 * amount of sitting here changes it.
 */
const IN_FLIGHT = ["QUEUED", "PROCESSING", "AWAITING_PROVIDER"] as const;

function inFlight(depth: Record<string, number>): number {
  return IN_FLIGHT.reduce((total, status) => total + (depth[status] ?? 0), 0);
}

function zeroStats(): WorkerStats {
  return {
    claimed: 0,
    completed: 0,
    submitted: 0,
    stillProcessing: 0,
    retried: 0,
    failed: 0,
    leaseLost: 0,
    reaped: 0,
  };
}

function addStats(a: WorkerStats, b: WorkerStats): WorkerStats {
  const out = { ...a };
  for (const key of Object.keys(out) as (keyof WorkerStats)[]) out[key] += b[key];
  return out;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/**
 * Whether this request is the scheduler's.
 *
 * Fails closed. With no `CRON_SECRET` configured the endpoint refuses
 * everything, because the alternative — an open URL that claims jobs and calls
 * billed providers — is the single worst thing that could be left exposed here.
 * A misconfiguration that stops generation is recoverable in a minute; one that
 * lets the internet spend money is not.
 */
function isAuthorised(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;

  // Hashed before comparing so the comparison is over two fixed-length values:
  // timingSafeEqual throws on a length mismatch, and the length of a secret is
  // itself something not worth leaking.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    // No detail: an unauthenticated caller learns nothing about whether the
    // secret is set, wrong, or simply absent.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const workerId = process.env.WORKER_ID || newWorkerId();
  const controller = new AbortController();
  const budget = deadlineMs();
  const timer = setTimeout(() => controller.abort(), budget);
  const startedAt = Date.now();

  try {
    const before = await queueDepth();

    // Drain what is claimable, then keep going only while something is still in
    // flight. This is the difference between a bounded invocation and the
    // long-lived process: the process can afford to sit on an empty queue, and
    // this cannot — every second here is billed whether or not there is work.
    // So an empty queue ends the run immediately and the next tick picks up
    // whatever arrives, while a job waiting on a provider is worth staying for,
    // because finishing it now beats finishing it a tick later.
    let stats = zeroStats();
    let depth = before;
    let drains = 0;

    while (inFlight(depth) > 0 && !controller.signal.aborted) {
      stats = addStats(stats, await drainQueue({ workerId, signal: controller.signal }));
      drains += 1;
      depth = await queueDepth();
      if (inFlight(depth) === 0) break;
      // Everything left is with a provider and not yet due for another poll.
      await sleep(POLL_GAP_MS, controller.signal);
    }

    const after = depth;
    const body = {
      ran: true,
      workerId,
      elapsedMs: Date.now() - startedAt,
      budgetMs: budget,
      // True when the clock ran out rather than the queue. Persistent `true`
      // means the schedule is not keeping up with the work.
      hitDeadline: controller.signal.aborted,
      // How many drain passes it took. 0 means the queue was already empty and
      // this invocation cost nothing but two queries.
      drains,
      queueBefore: before,
      queueAfter: after,
      ...stats,
    };

    // The scheduler's log is the only place anyone sees this, so it is a line
    // worth reading: what it claimed, what finished, what is left.
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "cron-worker", ...body }));
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("[cron-worker] failed", error);
    // 500 so the scheduler records a failure. The body says nothing: this
    // endpoint is reachable from the internet and a stack trace is a map.
    return NextResponse.json({ ran: false }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
