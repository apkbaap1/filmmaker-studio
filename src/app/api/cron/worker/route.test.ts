import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { GET } from "./route.ts";

/**
 * The scheduled worker endpoint.
 *
 * This is the one route in the application that is reachable without a session,
 * claims jobs, and calls providers that charge money. Everything here is about
 * the consequence of getting its door wrong: an open URL that spends is not a
 * bug anyone discovers from a failing page, and the bill arrives later.
 *
 * The authorisation cases run against the real handler rather than against the
 * source text, because a comment describing a check is not a check.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const URL_UNDER_TEST = "http://localhost/api/cron/worker";

function call(token?: string): Promise<Response> {
  const headers = new Headers();
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return GET(new NextRequest(URL_UNDER_TEST, { headers }));
}

describe("the scheduled worker refuses everyone but the scheduler", () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalDeadline = process.env.CRON_WORKER_DEADLINE_MS;

  after(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    if (originalDeadline === undefined) delete process.env.CRON_WORKER_DEADLINE_MS;
    else process.env.CRON_WORKER_DEADLINE_MS = originalDeadline;
  });

  it("refuses everything when no secret is configured", async () => {
    // The dangerous default. An unconfigured deployment must not leave a
    // job-claiming, money-spending endpoint open to the internet, so the
    // absence of a secret denies rather than permits.
    delete process.env.CRON_SECRET;
    for (const attempt of [undefined, "", "anything"]) {
      const response = await call(attempt);
      assert.equal(response.status, 401, `an unconfigured endpoint accepted ${String(attempt)}`);
    }
  });

  it("refuses a request with no authorization header", async () => {
    process.env.CRON_SECRET = "a-secret-for-this-test-only";
    const response = await GET(new NextRequest(URL_UNDER_TEST));
    assert.equal(response.status, 401);
  });

  it("refuses a wrong token, including one that is a prefix of the real one", async () => {
    process.env.CRON_SECRET = "a-secret-for-this-test-only";
    for (const wrong of ["", "a", "a-secret-for-this-test-onl", "a-secret-for-this-test-only-x"]) {
      const response = await call(wrong);
      assert.equal(response.status, 401, `accepted the wrong token ${JSON.stringify(wrong)}`);
    }
  });

  it("tells an unauthorised caller nothing about why", async () => {
    // Whether the secret is unset, wrong, or malformed is itself information.
    // All three answer identically.
    delete process.env.CRON_SECRET;
    const unconfigured = await (await call("anything")).json();
    process.env.CRON_SECRET = "a-secret-for-this-test-only";
    const wrong = await (await call("nope")).json();
    assert.deepEqual(unconfigured, wrong);
    assert.deepEqual(Object.keys(unconfigured), ["error"]);
  });

  it("admits the scheduler's own token", async () => {
    process.env.CRON_SECRET = "a-secret-for-this-test-only";
    // A one-millisecond budget so the run ends immediately: this asserts the
    // door opens, not what the worker does once through it.
    process.env.CRON_WORKER_DEADLINE_MS = "1";
    const response = await call("a-secret-for-this-test-only");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ran, true);
  });
});

describe("the scheduled worker is wired to the platform that calls it", () => {
  it("is scheduled at the path it is served from", () => {
    // A cron entry pointing at a path that does not exist fails as a 404 in a
    // log nobody reads, and generation simply never finishes.
    const vercel = JSON.parse(read("vercel.json")) as {
      crons: { path: string }[];
      functions: Record<string, { maxDuration: number }>;
    };
    assert.ok(
      vercel.crons.some((entry) => entry.path === "/api/cron/worker"),
      "no cron entry invokes /api/cron/worker"
    );
    assert.ok(
      "src/app/api/cron/worker/route.ts" in vercel.functions,
      "the route has no function configuration"
    );
  });

  it("gives the function longer than the worker's own budget", () => {
    // The worker must be the thing that stops the run. If the platform kills it
    // first it dies mid-step holding a lease, and that job stalls until the
    // lease expires.
    const vercel = JSON.parse(read("vercel.json")) as {
      functions: Record<string, { maxDuration: number }>;
    };
    const maxDuration = vercel.functions["src/app/api/cron/worker/route.ts"].maxDuration;
    const source = read("src/app/api/cron/worker/route.ts");
    const declared = /DEFAULT_DEADLINE_MS = ([\d_]+)/.exec(source);
    assert.ok(declared, "the route no longer declares a default deadline");
    const budgetMs = Number(declared[1].replace(/_/g, ""));
    assert.ok(
      maxDuration * 1_000 > budgetMs,
      `the platform ceiling (${maxDuration}s) does not exceed the worker budget (${budgetMs}ms)`
    );
  });

  it("is reachable without a session", () => {
    // The scheduler has no cookie. If middleware redirects it to /sign-in the
    // endpoint is never reached, and the redirect is a 200 the scheduler
    // records as success.
    const middleware = read("src/middleware.ts");
    assert.match(middleware, /"\/api\/cron\//);
  });

  it("runs on the Node runtime", () => {
    // The job runner reads from storage and speaks to provider SDKs.
    assert.match(read("src/app/api/cron/worker/route.ts"), /^export const runtime = "nodejs";$/m);
  });

  it("returns no detail when it fails", () => {
    // Reachable from the internet, so a stack trace in the body is a map.
    const source = read("src/app/api/cron/worker/route.ts");
    assert.match(source, /return NextResponse\.json\(\{ ran: false \}, \{ status: 500 \}\)/);
  });
});
