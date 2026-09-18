import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { nextAttemptAt, type JobStatus } from "./state";

/**
 * The durable queue.
 *
 * It is the `Generation` table. There is no separate job store, no Redis and no
 * broker, because Postgres already gives the three properties that matter:
 *
 *   DURABLE          a queued job is a committed row; nothing is held in memory
 *   RESTART-SAFE     a worker that dies loses its lease, not the work
 *   MULTI-WORKER SAFE a claim is a conditional UPDATE, so exactly one wins
 *
 * ## How a claim is safe without SELECT ... FOR UPDATE
 *
 * Claiming is a compare-and-swap on `leaseToken`. A worker reads a candidate
 * row, notes the token it saw, then updates the row *conditional on that token
 * still being there*, writing a fresh one. Two workers that read the same row
 * both try; the first to commit changes the token, so the second updates zero
 * rows and moves on. No locks are held between statements and nothing depends
 * on a worker staying alive.
 *
 * The same token then guards every subsequent write. A worker whose lease
 * expired and was taken over by someone else cannot overwrite the new owner's
 * result, because its token no longer matches — it will simply find it wrote
 * nothing. That is what makes a *slow* worker (as opposed to a dead one) safe,
 * and it is the case that in-memory locks get wrong.
 */

export const DEFAULT_LEASE_MS = 2 * 60_000;

/**
 * Statuses a worker may pick up.
 *
 * PROCESSING is in this list, and it is the whole of crash recovery. A worker
 * that dies leaves its job sitting in PROCESSING; if only QUEUED and
 * AWAITING_PROVIDER were claimable, that job would be stranded forever and no
 * amount of lease expiry would rescue it. The lease conditions below are what
 * make including it safe: a PROCESSING row is only eligible when no live lease
 * covers it, which for a healthy worker is never.
 *
 * Reclaiming such a row is the state machine's `PROCESSING → QUEUED` (by
 * `system`, on lease expiry) immediately followed by `QUEUED → PROCESSING` (by
 * the new worker). It is done as one UPDATE so there is no instant in which the
 * job is visible as unclaimed and two workers could both take it.
 */
const CLAIMABLE: readonly JobStatus[] = ["QUEUED", "AWAITING_PROVIDER", "PROCESSING"] as const;

export interface ClaimOptions {
  workerId: string;
  leaseMs?: number;
  now?: Date;
  /** Restricts a worker to one project. Operational convenience, never a security boundary. */
  projectId?: string;
}

export interface Lease {
  generationId: string;
  token: string;
  workerId: string;
  expiresAt: Date;
}

export type Db = PrismaClient | Prisma.TransactionClient;

function client(db?: Db): Db {
  return db ?? defaultPrisma;
}

/**
 * Takes one eligible job, or returns undefined if there is nothing to do.
 *
 * Eligible means: claimable status, its scheduled time has arrived (or it never
 * had one), and no live lease is held on it. A row whose lease has expired is
 * eligible again by construction — that is the whole crash-recovery mechanism,
 * and it needs no sweeper process.
 */
export async function claimNextJob(
  options: ClaimOptions,
  db?: Db
): Promise<Lease | undefined> {
  const prisma = client(db);
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const eligible = {
    status: { in: [...CLAIMABLE] },
    ...(options.projectId ? { projectId: options.projectId } : {}),
    // Not yet scheduled, or its time has come.
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    AND: [
      {
        // Unheld, or held by a lease that has run out.
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
    ],
  } satisfies Prisma.GenerationWhereInput;

  // A small batch rather than one row: under contention the first candidate is
  // often taken by another worker between the read and the update, and retrying
  // the whole query would just lose the race again.
  const candidates = await prisma.generation.findMany({
    where: eligible,
    select: { id: true, leaseToken: true, attempts: true, maxAttempts: true, status: true },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: 5,
  });

  for (const candidate of candidates) {
    // A job that has used up its attempts must not be claimed again; the worker
    // that exhausted it is responsible for failing it, and `reapExhausted`
    // catches any that were orphaned mid-flight.
    if (candidate.attempts >= candidate.maxAttempts) continue;

    const token = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseMs);

    const claimed = await prisma.generation.updateMany({
      where: {
        ...eligible,
        id: candidate.id,
        // The compare-and-swap, and it must come *after* the spread: `eligible`
        // carries the broad `status in (...)` filter, and these two conditions
        // are the narrower ones that make the claim exclusive.
        status: candidate.status,
        leaseToken: candidate.leaseToken,
      },
      data: {
        status: "PROCESSING",
        leaseOwner: options.workerId,
        leaseToken: token,
        leaseExpiresAt: expiresAt,
        // Counted on claim, not on failure: a worker that dies mid-job still
        // spends an attempt, so a job that reliably kills its worker cannot
        // loop forever.
        attempts: { increment: 1 },
        lastAttemptAt: now,
        // Cleared so a stale schedule cannot make the job eligible again while
        // this worker is holding it.
        nextAttemptAt: null,
      },
    });

    if (claimed.count === 1) {
      return { generationId: candidate.id, token, workerId: options.workerId, expiresAt };
    }
  }

  return undefined;
}

/**
 * Extends a lease the worker still holds.
 *
 * Returns false when the lease is gone — the job was taken over while this
 * worker was busy. A worker that sees false must stop touching the job: someone
 * else owns the outcome now.
 */
export async function heartbeat(
  lease: Lease,
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
  db?: Db
): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + leaseMs);
  const updated = await client(db).generation.updateMany({
    where: { id: lease.generationId, leaseToken: lease.token },
    data: { leaseExpiresAt: expiresAt },
  });
  if (updated.count === 1) {
    lease.expiresAt = expiresAt;
    return true;
  }
  return false;
}

/** True while this worker still owns the job. */
export async function holdsLease(lease: Lease, db?: Db): Promise<boolean> {
  const row = await client(db).generation.findFirst({
    where: { id: lease.generationId, leaseToken: lease.token },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Writes to a job, but only while this worker still holds it.
 *
 * Every worker-side mutation goes through here. Returning a boolean rather than
 * throwing is deliberate: losing a lease is a normal, expected outcome of a slow
 * job, not an error, and the caller's job is to stop rather than to recover.
 */
export async function updateLeased(
  lease: Lease,
  data: Prisma.GenerationUpdateManyMutationInput,
  db?: Db
): Promise<boolean> {
  const updated = await client(db).generation.updateMany({
    where: { id: lease.generationId, leaseToken: lease.token },
    data,
  });
  return updated.count === 1;
}

/** Hands a job back for a later attempt, releasing the lease. */
export async function releaseForRetry(
  lease: Lease,
  options: { status: "QUEUED" | "AWAITING_PROVIDER"; attempts: number; now?: Date; delayMs?: number },
  db?: Db
): Promise<boolean> {
  const now = options.now ?? new Date();
  const when =
    options.delayMs === undefined
      ? nextAttemptAt(now, options.attempts)
      : new Date(now.getTime() + options.delayMs);

  return updateLeased(
    lease,
    {
      status: options.status,
      nextAttemptAt: when,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
    db
  );
}

/**
 * Fails jobs that ran out of attempts while nobody was holding them.
 *
 * The ordinary path is for the worker that exhausts a job to fail it directly.
 * This covers the case where the worker died in between: without it, such a job
 * would sit unclaimable and unexplained forever.
 */
export async function reapExhausted(now = new Date(), db?: Db): Promise<number> {
  const prisma = client(db);
  const stuck = await prisma.generation.findMany({
    where: {
      status: { in: [...CLAIMABLE] },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    select: { id: true, attempts: true, maxAttempts: true },
  });

  const exhausted = stuck.filter((g) => g.attempts >= g.maxAttempts).map((g) => g.id);
  if (exhausted.length === 0) return 0;

  const result = await prisma.generation.updateMany({
    where: { id: { in: exhausted }, status: { in: [...CLAIMABLE] } },
    data: {
      status: "FAILED",
      failureKind: "RETRYABLE",
      error:
        "Gave up after the maximum number of attempts. The last attempt did not report why — its worker did not finish.",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
    },
  });
  return result.count;
}

/** How much work is waiting. Diagnostics only. */
export async function queueDepth(db?: Db): Promise<Record<string, number>> {
  const rows = await client(db).generation.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
