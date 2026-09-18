import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GenerationError,
  IllegalTransitionError,
  TRANSITIONS,
  assertTransition,
  backoffMs,
  canTransition,
  classify,
  isTerminal,
  legalTargets,
  nextAttemptAt,
  shouldRetry,
  type Actor,
  type JobStatus,
} from "./state.ts";

const ALL_STATUSES: JobStatus[] = [
  "QUEUED",
  "PROCESSING",
  "AWAITING_PROVIDER",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];
const ALL_ACTORS: Actor[] = ["worker", "user", "system"];

describe("legal transitions", () => {
  it("lets a worker claim a queued job", () => {
    assert.equal(canTransition("QUEUED", "PROCESSING", "worker"), true);
  });

  it("lets a worker hand a job to an async provider and let go of it", () => {
    assert.equal(canTransition("PROCESSING", "AWAITING_PROVIDER", "worker"), true);
    assert.equal(canTransition("AWAITING_PROVIDER", "PROCESSING", "worker"), true);
  });

  it("lets a worker finish or fail a job it is processing", () => {
    assert.equal(canTransition("PROCESSING", "COMPLETED", "worker"), true);
    assert.equal(canTransition("PROCESSING", "FAILED", "worker"), true);
  });

  it("lets an expired lease put a job back in the queue", () => {
    assert.equal(canTransition("PROCESSING", "QUEUED", "system"), true);
  });

  it("lets a user retry a failed job, and only a failed one", () => {
    assert.equal(canTransition("FAILED", "QUEUED", "user"), true);
    assert.equal(canTransition("COMPLETED", "QUEUED", "user"), false);
    assert.equal(canTransition("CANCELLED", "QUEUED", "user"), false);
  });

  it("lets a user cancel only before anything was submitted", () => {
    assert.equal(canTransition("QUEUED", "CANCELLED", "user"), true);
    // Nothing here can actually cancel a provider job, so nothing pretends to.
    assert.equal(canTransition("PROCESSING", "CANCELLED", "user"), false);
    assert.equal(canTransition("AWAITING_PROVIDER", "CANCELLED", "user"), false);
  });
});

describe("illegal transitions", () => {
  it("never lets a user mark a generation COMPLETED, from any state", () => {
    // This is the rule the whole actor model exists for.
    for (const from of ALL_STATUSES) {
      assert.equal(
        canTransition(from, "COMPLETED", "user"),
        false,
        `a user must not be able to complete a job from ${from}`
      );
    }
  });

  it("only ever lets a worker reach COMPLETED, and only from PROCESSING", () => {
    const completions = TRANSITIONS.filter((t) => t.to === "COMPLETED");
    assert.deepEqual(
      completions.map((t) => ({ from: t.from, by: [...t.by] })),
      [{ from: "PROCESSING", by: ["worker"] }]
    );
  });

  it("does not let a user claim, submit or poll", () => {
    assert.equal(canTransition("QUEUED", "PROCESSING", "user"), false);
    assert.equal(canTransition("PROCESSING", "AWAITING_PROVIDER", "user"), false);
    assert.equal(canTransition("AWAITING_PROVIDER", "PROCESSING", "user"), false);
  });

  it("does not let a job leave a terminal state except FAILED by retry", () => {
    assert.equal(isTerminal("COMPLETED"), true);
    assert.equal(isTerminal("CANCELLED"), true);
    assert.equal(isTerminal("FAILED"), false, "FAILED is recoverable by explicit retry");

    for (const actor of ALL_ACTORS) {
      assert.deepEqual(legalTargets("COMPLETED", actor), []);
      assert.deepEqual(legalTargets("CANCELLED", actor), []);
    }
  });

  it("does not let a job skip PROCESSING on its way to a result", () => {
    for (const actor of ALL_ACTORS) {
      assert.equal(canTransition("QUEUED", "COMPLETED", actor), false);
      assert.equal(canTransition("QUEUED", "AWAITING_PROVIDER", actor), false);
    }
  });

  it("does not let a job transition to itself", () => {
    for (const status of ALL_STATUSES) {
      for (const actor of ALL_ACTORS) {
        assert.equal(canTransition(status, status, actor), false, `${status} → ${status}`);
      }
    }
  });

  it("throws, rather than quietly refusing, when asserted", () => {
    assert.doesNotThrow(() => assertTransition("QUEUED", "PROCESSING", "worker"));
    assert.throws(() => assertTransition("QUEUED", "COMPLETED", "user"), IllegalTransitionError);
    assert.throws(() => assertTransition("COMPLETED", "QUEUED", "user"), IllegalTransitionError);
  });

  it("enumerates every legal target so an accidental widening shows up here", () => {
    const table = Object.fromEntries(
      ALL_STATUSES.map((from) => [
        from,
        Object.fromEntries(ALL_ACTORS.map((actor) => [actor, legalTargets(from, actor).sort()])),
      ])
    );

    assert.deepEqual(table, {
      QUEUED: {
        worker: ["PROCESSING"],
        user: ["CANCELLED"],
        system: [],
      },
      PROCESSING: {
        worker: ["AWAITING_PROVIDER", "COMPLETED", "FAILED", "QUEUED"],
        user: [],
        system: ["QUEUED"],
      },
      AWAITING_PROVIDER: {
        worker: ["FAILED", "PROCESSING"],
        user: [],
        system: ["FAILED"],
      },
      COMPLETED: { worker: [], user: [], system: [] },
      FAILED: { worker: [], user: ["QUEUED"], system: [] },
      CANCELLED: { worker: [], user: [], system: [] },
    });
  });
});

describe("failure classification", () => {
  it("takes an adapter at its word", () => {
    assert.equal(classify(GenerationError.permanent("bad prompt")), "PERMANENT");
    assert.equal(classify(GenerationError.retryable("rate limited")), "RETRYABLE");
    assert.equal(classify(GenerationError.indeterminate("submit may have landed")), "INDETERMINATE");
  });

  it("treats an unclassified error as a blip rather than a bug", () => {
    assert.equal(classify(new Error("socket hang up")), "RETRYABLE");
    assert.equal(classify("something threw a string"), "RETRYABLE");
    assert.equal(classify(undefined), "RETRYABLE");
  });

  it("retries a blip, bounded by the attempt ceiling", () => {
    assert.equal(shouldRetry("RETRYABLE", 1, 3), true);
    assert.equal(shouldRetry("RETRYABLE", 2, 3), true);
    assert.equal(shouldRetry("RETRYABLE", 3, 3), false, "the ceiling is inclusive");
    assert.equal(shouldRetry("RETRYABLE", 4, 3), false);
  });

  it("never retries a permanent failure, however many attempts are left", () => {
    for (const attempts of [0, 1, 2]) {
      assert.equal(shouldRetry("PERMANENT", attempts, 3), false);
    }
  });

  it("never retries an indeterminate failure, because it might succeed", () => {
    // Retrying here risks a second billed provider job for one generation.
    for (const attempts of [0, 1, 2]) {
      assert.equal(shouldRetry("INDETERMINATE", attempts, 3), false);
    }
  });
});

describe("backoff", () => {
  it("grows exponentially from the first retry", () => {
    assert.equal(backoffMs(1, 5_000), 5_000);
    assert.equal(backoffMs(2, 5_000), 10_000);
    assert.equal(backoffMs(3, 5_000), 20_000);
  });

  it("is capped, so a long-lived job does not drift out to hours", () => {
    assert.equal(backoffMs(50, 5_000, 300_000), 300_000);
  });

  it("does not go backwards for a zeroth attempt", () => {
    assert.equal(backoffMs(0, 5_000), 5_000);
  });

  it("schedules from the clock it is given, not from the wall clock", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(nextAttemptAt(now, 1, 5_000).toISOString(), "2026-01-01T00:00:05.000Z");
    assert.equal(nextAttemptAt(now, 3, 5_000).toISOString(), "2026-01-01T00:00:20.000Z");
  });
});
