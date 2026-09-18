import "server-only";

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_LEASE_MS,
  claimNextJob,
  heartbeat,
  reapExhausted,
  type Db,
  type Lease,
} from "./queue";
import { runJobStep, type StepOutcome } from "./runner";
import { jobLog } from "./log";

/**
 * The worker loop.
 *
 * Deliberately dull: claim a job, run one step, repeat; sleep when there is
 * nothing to do. All the interesting behaviour is in the queue (who may claim
 * what) and the runner (what a step does), which is what makes both testable
 * without ever starting this.
 *
 * It depends on nothing but the database. No HTTP request, no browser and no
 * other worker has to be alive for it to make progress, and it can be started,
 * stopped and restarted at any moment: an interrupted job is simply one whose
 * lease expires, and the next worker to come along picks it up.
 */

export interface WorkerOptions {
  workerId?: string;
  /** How long to sleep when the queue is empty. */
  idleMs?: number;
  leaseMs?: number;
  /** Stop after this many steps. Used by tests; unset means run forever. */
  maxSteps?: number;
  /** Stop once the queue is empty. Used by tests and one-shot drains. */
  stopWhenIdle?: boolean;
  projectId?: string;
  signal?: AbortSignal;
  db?: Db;
}

export interface WorkerStats {
  claimed: number;
  completed: number;
  submitted: number;
  stillProcessing: number;
  retried: number;
  failed: number;
  leaseLost: number;
  reaped: number;
}

export function newWorkerId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export async function runWorker(options: WorkerOptions = {}): Promise<WorkerStats> {
  const workerId = options.workerId ?? newWorkerId();
  const idleMs = options.idleMs ?? 1_000;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const db = options.db ?? prisma;

  const stats: WorkerStats = {
    claimed: 0,
    completed: 0,
    submitted: 0,
    stillProcessing: 0,
    retried: 0,
    failed: 0,
    leaseLost: 0,
    reaped: 0,
  };

  let steps = 0;
  while (!options.signal?.aborted) {
    if (options.maxSteps !== undefined && steps >= options.maxSteps) break;

    // Jobs whose worker died after spending the last attempt would otherwise sit
    // unclaimable and unexplained.
    stats.reaped += await reapExhausted(new Date(), db);

    const lease = await claimNextJob(
      { workerId, leaseMs, projectId: options.projectId },
      db
    );

    if (!lease) {
      if (options.stopWhenIdle) break;
      await sleep(idleMs, options.signal);
      continue;
    }

    stats.claimed += 1;
    steps += 1;

    const outcome = await withHeartbeat(lease, leaseMs, db, () =>
      runJobStep(lease.generationId, lease, new Date(), db)
    );
    record(stats, outcome);
  }

  return stats;
}

function record(stats: WorkerStats, outcome: StepOutcome): void {
  switch (outcome.kind) {
    case "completed":
      stats.completed += 1;
      break;
    case "submitted":
      stats.submitted += 1;
      break;
    case "still-processing":
      stats.stillProcessing += 1;
      break;
    case "retry-scheduled":
      stats.retried += 1;
      break;
    case "failed":
      stats.failed += 1;
      break;
    case "lease-lost":
      stats.leaseLost += 1;
      break;
  }
}

/**
 * Keeps the lease alive while a step runs.
 *
 * A generation can legitimately take longer than one lease. Without this, a
 * slow-but-healthy worker would have its job stolen mid-flight and the work
 * would be done twice. The heartbeat is what distinguishes "slow" from "dead" —
 * and when it fails, the job really has been taken over and the runner's
 * lease checks stop the old worker from writing anything.
 */
async function withHeartbeat<T>(
  lease: Lease,
  leaseMs: number,
  db: Db,
  work: () => Promise<T>
): Promise<T> {
  const every = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void heartbeat(lease, leaseMs, new Date(), db).catch(() => {
      // A failed heartbeat is not fatal here: the runner's own lease-guarded
      // writes are what actually keep two workers from colliding.
    });
  }, every);
  // Never hold the process open just for a heartbeat.
  timer.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Drains the queue and returns. Used by tests and by one-shot operational runs. */
export async function drainQueue(options: Omit<WorkerOptions, "stopWhenIdle"> = {}): Promise<WorkerStats> {
  return runWorker({ ...options, stopWhenIdle: true });
}

export { jobLog };
