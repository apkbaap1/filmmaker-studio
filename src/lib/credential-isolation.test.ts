import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const { sanitizeError } = await import("./jobs/runner.ts");

/**
 * Credential isolation for the real provider.
 *
 * Workstream 11.4 made it possible for this application to hold a billable API
 * key, so the question stops being theoretical: can that key reach anywhere a
 * person other than the server operator could read it?
 *
 * Five channels are checked, because those are the five ways a secret actually
 * escapes in practice:
 *
 *   1. the client bundle   — shipped to every visitor
 *   2. the database        — readable by anyone with a backup
 *   3. the logs            — shipped to whatever aggregates them
 *   4. generated prompts   — stored, displayed, diffed and exported
 *   5. the export package  — handed to a production company as a file
 *
 * The first is a build artefact and is checked by the source-tree audit in
 * `ai/secrets.test.ts`; what is checked here is everything that could put a
 * credential into a *value* rather than a module.
 */

/** All of src/, so the "read nowhere else" claims cover the UI as well. */
const SRC = path.resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Strips comments, so prose about a rule neither satisfies nor breaks a check. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Extracts `jobLog(...)` calls with balanced parentheses.
 *
 * A regex cannot do this: the argument list contains nested calls, so anything
 * anchored on the first `)` truncates, and anything lazy runs past the end of
 * the call into the rest of the file. Both failure modes give a wrong answer
 * about whether a credential is being logged.
 */
function jobLogCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "jobLog(";
  let at = source.indexOf(marker);
  while (at !== -1) {
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at, i + 1));
    at = source.indexOf(marker, i);
  }
  return calls;
}

const files = sourceFiles(SRC).map((file) => ({
  rel: path.relative(SRC, file),
  source: code(readFileSync(file, "utf8")),
}));

/** What a real OpenAI key looks like, for the sanitiser to be tested against. */
const FAKE_KEY = "sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu";

describe("the credential is read in exactly one place", () => {
  it("is read only by the adapter", () => {
    const readers = files
      .filter((f) => /process\.env\.OPENAI_API_KEY/.test(f.source))
      .map((f) => f.rel);
    assert.deepEqual(
      readers,
      [path.join("lib", "ai", "image-providers", "openai.ts")],
      `the credential is read outside the adapter: ${readers}`
    );
  });

  it("is never assigned to a variable that outlives the request", () => {
    const adapter = files.find((f) => f.rel.endsWith(path.join("image-providers", "openai.ts")));
    assert.ok(adapter);
    // A module-level `const apiKey = process.env...` would capture the value at
    // import time and keep it alive; reading it inside the function does not.
    assert.ok(
      !/^(const|let|var)\s+\w+\s*=\s*process\.env\.OPENAI_API_KEY/m.test(adapter.source),
      "the credential is captured at module scope"
    );
  });
});

describe("the credential cannot reach the database", () => {
  it("is not written to any Prisma field", () => {
    // Nothing may put the credential, or the header carrying it, into a write.
    for (const file of files) {
      const writes = file.source.match(/prisma\.\w+\.(create|update|updateMany|upsert)/g) ?? [];
      if (writes.length === 0) continue;
      assert.ok(
        !/OPENAI_API_KEY|apiKey|Authorization/.test(file.source),
        `${file.rel} both writes to the database and mentions a credential`
      );
    }
  });

  it("is stripped from a provider error before it is recorded", () => {
    // The realistic path: the provider echoes the key in its error body, the
    // adapter includes that body in its message, and the runner stores it.
    const providerSaid = `Incorrect API key provided: ${FAKE_KEY}. You can find your API key at https://platform.openai.com/account/api-keys`;
    const stored = sanitizeError(new Error(providerSaid));

    assert.ok(!stored.includes(FAKE_KEY), "the key survived into the stored error");
    assert.match(stored, /\[redacted-key\]/);
  });

  it("strips an Authorization header out of an error", () => {
    // Two rules can both apply, and which fires first does not matter — what
    // matters is that no part of the credential survives either way.
    const stored = sanitizeError(new Error(`request failed: Bearer ${FAKE_KEY}`));
    assert.ok(!stored.includes(FAKE_KEY), "the key survived");
    assert.match(stored, /\[redacted/);

    // A bearer token that is not key-shaped is caught by the header rule alone.
    const opaque = sanitizeError(new Error("request failed: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"));
    assert.ok(!opaque.includes("eyJhbGciOiJIUzI1NiJ9"), "an opaque token survived");
    assert.match(opaque, /Bearer \[redacted\]/);
  });

  it("strips a signed URL's query, which is a credential in its own right", () => {
    const stored = sanitizeError(
      new Error("could not fetch https://bucket.example.com/o/x?X-Amz-Signature=deadbeefcafe")
    );
    assert.ok(!stored.includes("deadbeefcafe"));
    assert.match(stored, /\?\[redacted\]/);
  });

  it("bounds the stored error, so a hostile body cannot fill the column", () => {
    assert.ok(sanitizeError(new Error("x".repeat(100_000))).length <= 1000);
  });
});

describe("the credential cannot reach the logs", () => {
  it("is not passed to the job logger anywhere", () => {
    for (const file of files) {
      const calls = jobLogCalls(file.source);
      for (const call of calls) {
        assert.ok(
          !/apiKey|OPENAI_API_KEY|Authorization|Bearer/.test(call),
          `${file.rel} logs a credential: ${call.slice(0, 80)}`
        );
      }
    }
  });

  it("is refused by the logger's own allow-list even if a caller tried", async () => {
    const { jobLog } = await import("./jobs/log.ts");
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      jobLog(
        "completed",
        {
          id: "gen1",
          projectId: "proj1",
          shotId: "shot1",
          mode: "IMAGE",
          status: "COMPLETED",
          providerId: "openai-gpt-image-1",
          attempts: 1,
        },
        // A caller doing the wrong thing. The logger drops these by name.
        { apiKey: FAKE_KEY, authorization: `Bearer ${FAKE_KEY}`, signedUrl: "https://x/y?sig=1" }
      );
    } finally {
      console.log = realLog;
    }

    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(FAKE_KEY), "a credential reached a log line");
    assert.ok(!lines[0].includes("Bearer"), "an authorization header reached a log line");
    assert.ok(!lines[0].includes("sig="), "a signed URL reached a log line");
  });

  it("does not log the prompt, which is the filmmaker's work", () => {
    for (const name of ["runner.ts", "worker.ts", "queue.ts"]) {
      const source = code(readFileSync(path.join(SRC, "lib", "jobs", name), "utf8"));
      for (const call of jobLogCalls(source)) {
        assert.ok(!/promptUsed/.test(call), `${name} logs the prompt: ${call.slice(0, 80)}`);
      }
    }
  });
});

describe("the credential cannot reach a prompt", () => {
  it("is not readable from anything on the compiler's path", () => {
    // The compiler is pure and reads no environment at all; if that ever
    // changed, a credential could be interpolated into a prompt and then
    // stored, displayed, diffed and exported.
    const promptModules = files.filter((f) => f.rel.startsWith(path.join("lib", "prompt")));
    assert.ok(promptModules.length > 3, "the prompt module walk found too little");

    for (const file of promptModules) {
      assert.ok(
        !/process\.env/.test(file.source),
        `${file.rel} reads the environment; a compiler must not`
      );
    }
  });

  it("is not read by the module that turns a shot into a prompt", () => {
    const bridge = files.find((f) => f.rel === path.join("lib", "shot-prompt.ts"));
    assert.ok(bridge, "shot-prompt.ts moved — update this test");
    assert.ok(!/process\.env/.test(bridge.source));
  });
});

describe("the credential cannot reach an export", () => {
  it("is not read anywhere in the export package builder", () => {
    const exportModules = files.filter((f) => f.rel.startsWith(path.join("lib", "export")));
    assert.ok(exportModules.length >= 3, "the export module walk found too little");

    for (const file of exportModules) {
      assert.ok(
        !/process\.env\.(OPENAI_API_KEY|S3_SECRET_ACCESS_KEY|S3_ACCESS_KEY_ID|MEDIA_URL_SECRET|AUTH_SECRET)/.test(
          file.source
        ),
        `${file.rel} reads a credential`
      );
    }
  });

  it("carries the provider's identity but never its credential", async () => {
    const types = readFileSync(path.join(SRC, "lib", "export", "types.ts"), "utf8");
    // Identity is wanted in an export — it is the audit trail.
    assert.match(types, /imageProvider/);
    // A key, a token or a secret is not.
    assert.ok(
      !/apiKey|api_key|secret|token/i.test(code(types)),
      "the export schema has a field that could hold a credential"
    );
  });

  it("only exports an error that has already been through the sanitiser", () => {
    // The export emits `generation.error` verbatim, so the column itself has to
    // be clean — which is what the database tests above establish. This pins
    // the dependency so it cannot be quietly broken by writing an unsanitised
    // error somewhere new.
    const runner = files.find((f) => f.rel === path.join("lib", "jobs", "runner.ts"));
    assert.ok(runner);

    // Only values being *recorded*, not TypeScript parameter annotations such as
    // `error: unknown` in a function signature.
    const recorded = [...runner.source.matchAll(/error:\s*([A-Za-z_][\w.]*)/g)]
      .map((match) => match[1])
      .filter((value) => value !== "unknown");

    assert.ok(recorded.length > 0, "no error writes found — update this test");
    const unexpected = [...new Set(recorded)].filter(
      (value) => value !== "null" && value !== "message"
    );
    assert.deepEqual(
      unexpected,
      [],
      `the runner records an error from something other than the sanitiser: ${unexpected}`
    );

    // …and `message` has to be the sanitiser's output, not the raw error.
    assert.match(
      runner.source,
      /const message = sanitizeError\(/,
      "the recorded `message` must come from sanitizeError"
    );
  });
});
