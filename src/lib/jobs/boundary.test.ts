import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Static audit of the job boundary.
 *
 * Two rules are asserted over the real source rather than at runtime, because
 * both are about code that does not exist yet:
 *
 *   1. **The browser cannot finish a job.** No server action may write
 *      COMPLETED, set an assetId, or touch a lease. The next person to add a
 *      "mark as done" action would otherwise quietly undo the whole workstream.
 *   2. **The worker never trusts a client.** It works from the Generation row's
 *      own projectId and shotId, never from a parameter, so it cannot be
 *      steered at another project's media.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..");
const ACTIONS = path.join(SRC, "lib", "actions");
const JOBS = path.join(SRC, "lib", "jobs");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Strips comments, so prose about a rule cannot satisfy or break a check for it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const actionFiles = sourceFiles(ACTIONS).map((file) => ({
  rel: path.relative(SRC, file),
  source: code(readFileSync(file, "utf8")),
}));

/** Every `prisma.generation.<write>(...)` call, with balanced-paren arguments. */
function generationWrites(source: string): string[] {
  const calls: string[] = [];
  const pattern = /prisma\.generation\.(update|updateMany|upsert|create|createMany)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(match.index, i + 1));
  }
  return calls;
}

describe("the browser cannot finish a job", () => {
  it("finds the action modules it is auditing", () => {
    assert.ok(actionFiles.length > 5, "the action walk found suspiciously little");
    assert.ok(
      actionFiles.some((f) => f.rel.endsWith(path.join("actions", "generations.ts"))),
      "actions/generations.ts moved — update this test"
    );
  });

  it("has no server action that writes COMPLETED", () => {
    const offenders = actionFiles
      .filter((f) => generationWrites(f.source).some((call) => /status:\s*"COMPLETED"/.test(call)))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [], `these let a client complete a generation: ${offenders}`);
  });

  it("has no server action that attaches an Asset to a generation", () => {
    // Attaching an Asset is completion by another name.
    const offenders = actionFiles
      .filter((f) => generationWrites(f.source).some((call) => /\bassetId:/.test(call)))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [], `these set a generation's assetId from a client: ${offenders}`);
  });

  it("has no server action that grants itself a lease", () => {
    // Clearing a lease is legitimate — retry and cancel both release a stale one.
    // Setting one to anything else is a client taking a worker's job.
    const grants = (call: string): string[] =>
      [...call.matchAll(/lease(?:Token|Owner|ExpiresAt)\s*:\s*([^,\n}]+)/g)]
        .map((m) => m[1].trim())
        .filter((value) => value !== "null");

    const offenders = actionFiles
      .filter((f) => generationWrites(f.source).some((call) => grants(call).length > 0))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [], `these take a worker's lease from a client: ${offenders}`);
  });

  it("has no server action that moves a job to PROCESSING or AWAITING_PROVIDER", () => {
    const offenders = actionFiles
      .filter((f) =>
        generationWrites(f.source).some((call) =>
          /status:\s*"(PROCESSING|AWAITING_PROVIDER)"/.test(call)
        )
      )
      .map((f) => f.rel);
    assert.deepEqual(offenders, [], `these claim work on a client's behalf: ${offenders}`);
  });

  it("has no server action that calls a generation provider", () => {
    // The whole point: an action enqueues, it does not generate.
    const offenders = actionFiles
      .filter((f) => /\.(submit|poll|generate)\s*\(/.test(f.source))
      .filter((f) => /getVideoProvider|getImageProvider/.test(f.source))
      .map((f) => f.rel);
    assert.deepEqual(offenders, [], `these run a provider inside a request: ${offenders}`);
  });

  it("scopes every client-facing generation write to the project", () => {
    // The Workstream 11.1 rule, still holding for the new retry/cancel actions.
    const unscoped = actionFiles.flatMap((f) =>
      generationWrites(f.source)
        .filter((call) => /update|delete/i.test(call.slice(0, 40)))
        .filter((call) => !/scopedTo\.generation\(/.test(call))
        .map(() => f.rel)
    );
    assert.deepEqual(unscoped, [], `these write a generation without a project scope: ${unscoped}`);
  });

  it("checks project access in every exported generation action", () => {
    const generations = actionFiles.find((f) =>
      f.rel.endsWith(path.join("actions", "generations.ts"))
    );
    assert.ok(generations);

    const exported = [...generations.source.matchAll(/export async function (\w+)/g)].map(
      (m) => m[1]
    );
    assert.ok(exported.length >= 4, `expected several actions, found ${exported.join(", ")}`);

    // Each action's body must reach requireProjectAccess before anything else.
    for (const name of exported) {
      const start = generations.source.indexOf(`export async function ${name}`);
      const next = exported
        .map((other) => generations.source.indexOf(`export async function ${other}`))
        .filter((at) => at > start)
        .sort((a, b) => a - b)[0];
      const body = generations.source.slice(start, next === undefined ? undefined : next);
      assert.match(body, /requireProjectAccess\(/, `${name} does not check project access`);
    }
  });
});

describe("the worker never trusts a client", () => {
  const runner = code(readFileSync(path.join(JOBS, "runner.ts"), "utf8"));

  it("resolves the source frame through the job's own project", () => {
    assert.match(
      runner,
      /where:\s*\{\s*id:\s*generation\.sourceAssetId,\s*projectId:\s*generation\.projectId\s*\}/,
      "the source frame must be scoped by the generation's own projectId"
    );
  });

  it("takes no projectId parameter of its own", () => {
    // Every exported function here works from a generation id and a lease. A
    // projectId argument would be a client-supplied value by another name.
    const signatures = [...runner.matchAll(/export async function \w+\(([^)]*)\)/g)].map((m) => m[1]);
    for (const signature of signatures) {
      assert.ok(
        !/projectId\s*:/.test(signature),
        `a runner entry point takes a projectId: ${signature.trim()}`
      );
    }
  });

  it("writes media only under the job's own project", () => {
    assert.ok(
      !/storeProjectMedia\(\s*(?!generation\.projectId)/.test(runner),
      "media must be stored under the generation's own projectId"
    );
    assert.ok(
      !/reserveProjectMediaKey\(\s*(?!generation\.projectId)/.test(runner),
      "keys must be reserved under the generation's own projectId"
    );
  });

  it("never reaches for the session", () => {
    // A worker has no user. Reading a session here would mean it had been given
    // a request's identity from somewhere it should not have.
    for (const file of ["runner.ts", "worker.ts", "queue.ts"]) {
      const source = readFileSync(path.join(JOBS, file), "utf8");
      assert.ok(!/from\s+["']@\/auth["']/.test(source), `${file} imports auth`);
      assert.ok(!/\bauth\(\)/.test(code(source)), `${file} reads a session`);
    }
  });
});

describe("job logging", () => {
  const log = code(readFileSync(path.join(JOBS, "log.ts"), "utf8"));

  it("logs an allow-list of fields rather than the whole row", () => {
    // A column added later must not start appearing in logs on its own.
    assert.ok(!/\.\.\.(subject|generation|row)\b/.test(log), "the subject is spread into the log");
  });

  it("never logs a prompt", () => {
    for (const file of ["runner.ts", "worker.ts", "queue.ts", "log.ts"]) {
      const source = code(readFileSync(path.join(JOBS, file), "utf8"));
      assert.ok(
        !/jobLog\([^)]*promptUsed/.test(source),
        `${file} logs the prompt, which is the filmmaker's work and belongs in the database`
      );
    }
  });
});
