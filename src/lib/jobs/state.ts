/**
 * The generation job state machine.
 *
 * Pure: no database, no provider, no clock beyond what is passed in. The rules
 * live here so that "can this job go there?" has exactly one answer, and so the
 * illegal transitions can be tested as directly as the legal ones.
 *
 * The transition that matters most is the one that is *absent*: nothing reaches
 * COMPLETED except by finishing the work. No client action, no retry, no lease
 * expiry can put a job there.
 */

export type JobStatus =
  | "QUEUED"
  | "PROCESSING"
  | "AWAITING_PROVIDER"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type FailureKind = "RETRYABLE" | "PERMANENT" | "INDETERMINATE";

/**
 * Who is asking for a transition. A transition is legal only for the actors
 * listed against it, which is how "the browser must never be able to mark a
 * generation COMPLETED" becomes a checkable rule rather than a convention.
 *
 * - `worker` the background worker, holding a valid lease
 * - `user`   a server action on behalf of a signed-in project member
 * - `system` lease reclamation, which no human triggers
 */
export type Actor = "worker" | "user" | "system";

export interface Transition {
  from: JobStatus;
  to: JobStatus;
  by: readonly Actor[];
  why: string;
}

export const TRANSITIONS: readonly Transition[] = [
  {
    from: "QUEUED",
    to: "PROCESSING",
    by: ["worker"],
    why: "a worker claimed the job",
  },
  {
    from: "QUEUED",
    to: "CANCELLED",
    by: ["user"],
    why: "cancelled before anything was submitted to a provider",
  },
  {
    from: "PROCESSING",
    to: "AWAITING_PROVIDER",
    by: ["worker"],
    why: "handed to an asynchronous provider; the worker is free again",
  },
  {
    from: "PROCESSING",
    to: "COMPLETED",
    by: ["worker"],
    why: "media stored and the Asset recorded",
  },
  {
    from: "PROCESSING",
    to: "FAILED",
    by: ["worker"],
    why: "a permanent failure, or the attempt ceiling was reached",
  },
  {
    from: "PROCESSING",
    to: "QUEUED",
    by: ["worker", "system"],
    why: "a retryable failure with attempts left, or an expired lease reclaimed",
  },
  {
    from: "AWAITING_PROVIDER",
    to: "PROCESSING",
    by: ["worker"],
    why: "a worker claimed the job to poll the provider",
  },
  {
    from: "AWAITING_PROVIDER",
    to: "FAILED",
    by: ["worker", "system"],
    why: "the provider reported failure, or the job outlived its attempts",
  },
  {
    from: "FAILED",
    to: "QUEUED",
    by: ["user"],
    why: "an explicit retry; never automatic",
  },
] as const;

/** Terminal states. Nothing leaves these except FAILED, and only by explicit retry. */
export const TERMINAL: readonly JobStatus[] = ["COMPLETED", "CANCELLED"] as const;

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus, by: Actor): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.by.includes(by));
}

export function legalTargets(from: JobStatus, by: Actor): JobStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.by.includes(by)).map((t) => t.to);
}

/** Thrown rather than returned: an illegal transition is a bug, not a user error. */
export class IllegalTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;
  readonly by: Actor;

  constructor(from: JobStatus, to: JobStatus, by: Actor) {
    super(`A ${by} may not move a generation from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
    this.by = by;
  }
}

export function assertTransition(from: JobStatus, to: JobStatus, by: Actor): void {
  if (!canTransition(from, to, by)) throw new IllegalTransitionError(from, to, by);
}

// --- failure classification -------------------------------------------------

/**
 * A failure an adapter or the runner can describe precisely.
 *
 * Adapters are expected to throw this so the worker does not have to guess from
 * a message string. An error that is *not* one of these is treated as retryable
 * but still bounded by the attempt ceiling: an unknown fault is more often a
 * blip than a bug in the request, and retrying it three times is cheap where
 * refusing it outright loses real work.
 */
export class GenerationError extends Error {
  readonly kind: FailureKind;

  constructor(message: string, kind: FailureKind, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GenerationError";
    this.kind = kind;
  }

  /** The request itself is wrong. Retrying it will fail identically. */
  static permanent(message: string, cause?: unknown): GenerationError {
    return new GenerationError(message, "PERMANENT", cause);
  }

  /** A blip: network, rate limit, a storage write that did not land. */
  static retryable(message: string, cause?: unknown): GenerationError {
    return new GenerationError(message, "RETRYABLE", cause);
  }

  /** We cannot tell whether an expensive provider job was created. */
  static indeterminate(message: string, cause?: unknown): GenerationError {
    return new GenerationError(message, "INDETERMINATE", cause);
  }
}

export function classify(error: unknown): FailureKind {
  if (error instanceof GenerationError) return error.kind;
  return "RETRYABLE";
}

/**
 * Whether a failure should go back in the queue.
 *
 * PERMANENT never retries — repeating an invalid prompt or a rejected
 * configuration just burns attempts. INDETERMINATE never retries either, for
 * the opposite reason: it might succeed, and that is exactly the danger.
 */
export function shouldRetry(kind: FailureKind, attempts: number, maxAttempts: number): boolean {
  if (kind !== "RETRYABLE") return false;
  return attempts < maxAttempts;
}

// --- scheduling -------------------------------------------------------------

/** Exponential backoff, capped. Deterministic, so a test can assert the schedule. */
export function backoffMs(attempts: number, baseMs = 5_000, capMs = 5 * 60_000): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

export function nextAttemptAt(now: Date, attempts: number, baseMs?: number, capMs?: number): Date {
  return new Date(now.getTime() + backoffMs(attempts, baseMs, capMs));
}
