import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { safeCallbackUrl, withCallback, DEFAULT_CALLBACK } from "./callback-url.ts";

/**
 * The deployment surface.
 *
 * These guard the things that fail *silently* — a credential baked into an
 * image, a health check behind auth, a worker that was quietly dropped from the
 * stack. None of them would break a test or a build; each would be discovered
 * in production, by somebody else.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

describe("no image carries a secret", () => {
  const SECRET_NAMES = [
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "S3_SECRET_ACCESS_KEY",
    "S3_ACCESS_KEY_ID",
    "MEDIA_URL_SECRET",
    "DATABASE_URL",
  ];

  it("sets no real credential in a Dockerfile layer", () => {
    // An ENV in a layer is in the image, and an image is pushed to a registry.
    const dockerfile = read("Dockerfile");
    for (const name of SECRET_NAMES) {
      assert.ok(
        !new RegExp(`^\\s*(ENV|ARG)\\s+${name}`, "m").test(dockerfile),
        `Dockerfile bakes ${name} into a layer`
      );
    }
  });

  it("uses a placeholder for the one secret the build insists on", () => {
    // `next build` refuses to start without AUTH_SECRET, so the build stage
    // sets one — and it must be obviously not a real value, and must not reach
    // a runtime stage.
    const dockerfile = read("Dockerfile");
    const buildStage = dockerfile.slice(
      dockerfile.indexOf("AS build"),
      dockerfile.indexOf("AS web")
    );
    assert.match(buildStage, /ENV AUTH_SECRET=/);
    assert.match(buildStage, /placeholder/i, "it must read as a placeholder to anyone scanning");

    const runtime = dockerfile.slice(dockerfile.indexOf("AS web"));
    assert.ok(
      !/ENV AUTH_SECRET=/.test(runtime),
      "a runtime stage must take AUTH_SECRET from the environment, not a layer"
    );
  });

  it("keeps .env out of the build context", () => {
    // The whole file, not a variable: one COPY . . with .env present puts every
    // credential in the image at once.
    const ignore = read(".dockerignore");
    assert.match(ignore, /^\.env$/m);
    assert.match(ignore, /^\.env\.\*$/m);
    assert.match(ignore, /^!\.env\.example$/m, "the example is documentation and may stay");
  });

  it("runs neither runtime image as root", () => {
    const dockerfile = read("Dockerfile");
    const stages = dockerfile.split(/^FROM /m).filter((s) => /AS (web|worker)\b/.test(s));
    assert.equal(stages.length, 2, "there should be exactly two runtime targets");
    for (const stage of stages) {
      assert.match(stage, /^USER app$/m, `a runtime stage still runs as root:\n${stage.slice(0, 80)}`);
    }
  });
});

describe("the compose stack is the whole app", () => {
  const compose = read("docker-compose.yml");

  it("runs a worker, without which every generation stays queued", () => {
    // The failure this prevents is the worst kind: the app looks up, accepts
    // work, and silently never does it.
    assert.match(compose, /^ {2}worker:$/m);
    assert.match(compose, /target: worker/);
  });

  it("applies migrations before anything serves or claims", () => {
    assert.match(compose, /^ {2}migrate:$/m);
    assert.match(compose, /prisma", "migrate", "deploy"/);
    // `dev` would invent a migration against a production database.
    assert.ok(!/migrate", "dev"/.test(compose));
  });

  it("makes web and worker wait for the migration to succeed", () => {
    const waits = compose.match(/condition: service_completed_successfully/g) ?? [];
    assert.equal(waits.length, 2, "both web and worker must wait");
  });

  it("refuses to start without the two secrets that have no safe default", () => {
    // `${VAR:?message}` fails the command rather than starting with an empty
    // password or an unsigned session.
    assert.match(compose, /POSTGRES_PASSWORD:\?/);
    assert.match(compose, /AUTH_SECRET:\?/);
  });

  it("gives provider credentials to the worker and not to the web server", () => {
    // Nothing the web container serves calls a provider, so a compromise there
    // should reach no billable account.
    const web = compose.slice(compose.indexOf("\n  web:"), compose.indexOf("\n  worker:"));
    const worker = compose.slice(compose.indexOf("\n  worker:"));

    for (const key of ["OPENAI_API_KEY", "GOOGLE_API_KEY"]) {
      assert.ok(!web.includes(key), `the web service is given ${key}`);
      assert.ok(worker.includes(key), `the worker is not given ${key}`);
    }
  });

  it("does not publish the database to the host by default", () => {
    const postgres = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("\n  migrate:"));
    assert.ok(
      !/^ {4}ports:/m.test(postgres),
      "Postgres must not be reachable from outside the compose network by default"
    );
  });
});

describe("health is reachable without a session", () => {
  it("is listed as public in the middleware", () => {
    // A load balancer has no session. Behind auth, this endpoint reports every
    // container as unhealthy and the deployment never comes up.
    const middleware = read("src/middleware.ts");
    assert.match(middleware, /"\/api\/health"/);
  });

  it("reports a failure as one word, not as a description of the infrastructure", () => {
    const route = read("src/app/api/health/route.ts");
    assert.match(route, /status: "unhealthy"/);
    // No error text, no hostname, no database name in the response body.
    assert.ok(
      !/NextResponse\.json\(\s*\{[^}]*error/.test(route),
      "an unauthenticated endpoint must not return the error"
    );
    assert.match(route, /console\.error/, "but the operator still gets the cause, in the logs");
  });

  it("queries in a way a migration cannot break", () => {
    const route = read("src/app/api/health/route.ts");
    assert.match(route, /SELECT 1/, "no table, so a schema change cannot make the app look dead");
  });
});

describe("invitations survive the middleware", () => {
  it("is public, so someone without an account can still read the invitation", () => {
    // Redirecting straight to sign-in looks equivalent and is not: the invitee
    // may have no account, and would arrive at sign-up having lost the token.
    const middleware = read("src/middleware.ts");
    assert.match(middleware, /"\/invitations\/"/);
  });

  it("carries the callback from sign-in to sign-up", () => {
    const page = read("src/app/sign-in/page.tsx");
    assert.match(page, /withCallback\("\/sign-up", callbackUrl\)/);

    // The link must be in the server's first HTML rather than appearing after
    // hydration, so it works with JavaScript off. That means the page reads the
    // query itself and is not a client component.
    //
    // Asserted as code, not as vocabulary: an earlier version of this test
    // searched for the string "useSearchParams" and failed on the comment
    // explaining why it is not used.
    assert.match(page, /await searchParams/, "the page reads the query server-side");
    assert.ok(
      !/^\s*["']use client["']/m.test(page),
      "the sign-in page must stay a server component"
    );
  });
});

describe("where a callback may point", () => {
  it("keeps a path within the application", () => {
    assert.equal(safeCallbackUrl("/invitations/abc"), "/invitations/abc");
    assert.equal(safeCallbackUrl("/projects/123/timeline"), "/projects/123/timeline");
  });

  it("refuses to send anyone off-site", () => {
    // An open redirect on a sign-in link is how a phishing page borrows a real
    // domain's credibility — and the link most likely to be followed here is an
    // invitation somebody was sent.
    for (const hostile of [
      "https://elsewhere.example/steal",
      "http://elsewhere.example",
      "//elsewhere.example",
      "javascript:alert(1)",
      "",
      "   ",
    ]) {
      assert.equal(
        safeCallbackUrl(hostile),
        DEFAULT_CALLBACK,
        `${JSON.stringify(hostile)} must not survive`
      );
    }
  });

  it("refuses anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, ["/ok"]]) {
      assert.equal(safeCallbackUrl(value), DEFAULT_CALLBACK);
    }
  });

  it("leaves a link clean when there is nothing to carry", () => {
    assert.equal(withCallback("/sign-up", DEFAULT_CALLBACK), "/sign-up");
    assert.equal(
      withCallback("/sign-up", "/invitations/abc"),
      "/sign-up?callbackUrl=%2Finvitations%2Fabc"
    );
  });

  it("encodes the callback so a query string cannot be smuggled into it", () => {
    const link = withCallback("/sign-up", "/a?b=c&d=e");
    assert.equal(link, "/sign-up?callbackUrl=%2Fa%3Fb%3Dc%26d%3De");
    assert.equal(new URL(link, "https://x.test").searchParams.get("callbackUrl"), "/a?b=c&d=e");
  });
});

describe("the runtime image stays small", () => {
  it("builds a standalone server rather than shipping node_modules", () => {
    // The difference between an image measured in hundreds of megabytes and one
    // in tens, on every deploy and every rollback.
    const config = read("next.config.ts");
    assert.match(config, /output: "standalone"/);

    const dockerfile = read("Dockerfile");
    assert.match(dockerfile, /\.next\/standalone/);
    assert.match(dockerfile, /\.next\/static/, "static assets are not in the standalone output");
    assert.match(dockerfile, /\/app\/public/, "nor is the public directory");
  });
});
