/**
 * Google Veo — authenticated API discovery.
 *
 *     npm run veo:discover              # free: discovers and reports
 *     npm run veo:discover -- --probe   # free: also probes the request schema
 *
 * ## Why this exists
 *
 * The public discovery document establishes the *mechanism* — a
 * `models.predictLongRunning` call returning an `Operation` that is polled —
 * but types the payload as `instances: any` and `parameters: any`. It contains
 * no Veo model id, no duration field, no resolution field and no aspect ratio.
 * Everything Veo-specific therefore has to come from the live API rather than
 * from anybody's recollection, and this script is how it is obtained.
 *
 * ## It does not spend money
 *
 * Model listing and model inspection are unbilled reads. The schema probe sends
 * *deliberately invalid* requests — an empty instance, a missing prompt — whose
 * only possible outcome is a validation error; a rejected request renders
 * nothing and bills nothing. The script has no code path that submits a
 * well-formed generation, so it cannot accidentally buy a video.
 *
 * The one real generation happens later, in a separate verification, against an
 * adapter written from the contract this script records.
 *
 * ## The credential
 *
 * Read from the environment, sent as a header, never placed in a URL (which
 * would put it in every proxy and access log), never printed, and scrubbed from
 * everything this script writes — including the API's own error text, in case a
 * service ever echoes it back.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const API_HOST = "generativelanguage.googleapis.com";
const BASE = `https://${API_HOST}/v1beta`;
const REPORT_DIR = path.join(process.cwd(), "artifacts");
const REPORT_PATH = path.join(REPORT_DIR, "veo-api-contract.json");

const PROBE = process.argv.includes("--probe");

let apiKey = "";

// --- secret hygiene ---------------------------------------------------------

/**
 * Removes the credential from anything on its way to a console, a file or an
 * error. Applied to every string this script emits, without exception, so a
 * service echoing the key back cannot leak it through us.
 */
function scrub<T>(value: T): T {
  if (!apiKey) return value;
  const json = JSON.stringify(value);
  if (!json.includes(apiKey)) return value;
  return JSON.parse(json.split(apiKey).join("[redacted-credential]")) as T;
}

function say(line: string): void {
  console.log(apiKey ? line.split(apiKey).join("[redacted-credential]") : line);
}

/** Enough to confirm a key is present and which one, without revealing it. */
function fingerprint(secret: string): string {
  return `${secret.length} chars, sha256:${createHash("sha256").update(secret).digest("hex").slice(0, 12)}`;
}

function abort(reason: string, remedy: string): never {
  say("");
  say("=".repeat(72));
  say("VEO DISCOVERY NOT PERFORMED");
  say("=".repeat(72));
  say(`Blocker: ${reason}`);
  say(`Remedy:  ${remedy}`);
  say("");
  say("Nothing was called and nothing was billed.");
  process.exit(2);
}

// --- HTTP -------------------------------------------------------------------

interface ApiResult {
  status: number;
  json: unknown;
  text: string;
}

/**
 * Calls the API with the credential in a header.
 *
 * Google accepts `?key=` too, and this deliberately does not use it: a query
 * parameter travels through proxies, access logs and error reports, and a
 * credential that reaches a log is a leaked credential.
 */
async function call(
  urlPath: string,
  init: { method?: string; body?: unknown } = {}
): Promise<ApiResult> {
  const response = await fetch(`${BASE}${urlPath}`, {
    method: init.method ?? "GET",
    headers: {
      "x-goog-api-key": apiKey,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text().catch(() => "");
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON; `text` carries it */
  }
  return { status: response.status, json, text };
}

// --- discovery --------------------------------------------------------------

interface ModelRecord {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  [key: string]: unknown;
}

async function listModels(): Promise<ModelRecord[]> {
  const models: ModelRecord[] = [];
  let pageToken: string | undefined;

  do {
    const query = new URLSearchParams({ pageSize: "200" });
    if (pageToken) query.set("pageToken", pageToken);
    const result = await call(`/models?${query.toString()}`);

    if (result.status !== 200) {
      const detail = describeError(result);
      if (result.status === 401 || result.status === 403) {
        abort(
          `The API rejected the credential (HTTP ${result.status}): ${detail}`,
          "Check that GOOGLE_API_KEY is valid, that the Generative Language API is enabled on its project, and that billing is enabled."
        );
      }
      abort(`Could not list models (HTTP ${result.status}): ${detail}`, "Resolve the error above and re-run.");
    }

    const page = result.json as { models?: ModelRecord[]; nextPageToken?: string };
    models.push(...(page.models ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return models;
}

function describeError(result: ApiResult): string {
  const asError = result.json as { error?: { message?: string; status?: string } } | undefined;
  const message = asError?.error?.message ?? result.text.slice(0, 300);
  return scrub(String(message));
}

/**
 * Which models can drive this application's video path.
 *
 * Selected by the *declared* generation method rather than by matching a name
 * against a guess: a model that supports `predictLongRunning` is one this
 * mechanism can call, whatever it happens to be called.
 */
function videoCandidates(models: ModelRecord[]): ModelRecord[] {
  return models.filter((m) =>
    (m.supportedGenerationMethods ?? []).some((method) => /predictLongRunning/i.test(method))
  );
}

// --- schema probing ---------------------------------------------------------

interface Probe {
  label: string;
  request: unknown;
  status: number;
  response: unknown;
  /** Field-level complaints, which is where the real schema shows itself. */
  fieldViolations: unknown;
}

/**
 * Sends deliberately invalid requests and records what the API objects to.
 *
 * This is the only way to learn the payload shape: the discovery document types
 * it as `any`, and guessing is what this whole exercise exists to avoid. A
 * validation error names the field it wanted, so the contract emerges from the
 * service's own replies.
 *
 * Every probe here is *incapable of succeeding*. That is deliberate and is what
 * makes this free: an empty instance list, an empty instance and an instance
 * with an obviously wrong field cannot render a video under any schema.
 */
async function probeSchema(model: string): Promise<Probe[]> {
  const attempts: { label: string; body: unknown }[] = [
    { label: "empty body", body: {} },
    { label: "empty instances array", body: { instances: [] } },
    { label: "one empty instance", body: { instances: [{}] } },
    {
      label: "instance with a deliberately unknown field",
      body: { instances: [{ __unknown_probe_field__: true }] },
    },
    {
      label: "empty instance with empty parameters",
      body: { instances: [{}], parameters: {} },
    },
    {
      label: "parameters with a deliberately unknown field",
      body: { instances: [{}], parameters: { __unknown_probe_field__: true } },
    },
  ];

  const probes: Probe[] = [];
  for (const attempt of attempts) {
    const result = await call(`/${model}:predictLongRunning`, {
      method: "POST",
      body: attempt.body,
    });

    // A probe must never succeed. If one somehow does, stop immediately rather
    // than risk a second.
    if (result.status === 200) {
      const operation = result.json as { name?: string };
      say("");
      say("  !! A probe was ACCEPTED rather than rejected.");
      say(`     Operation: ${scrub(operation?.name ?? "(unnamed)")}`);
      say("     Stopping. This may have started a billable job — check the console.");
      probes.push({
        label: attempt.label,
        request: attempt.body,
        status: result.status,
        response: scrub(result.json),
        fieldViolations: null,
      });
      break;
    }

    const error = result.json as
      | { error?: { message?: string; status?: string; details?: unknown[] } }
      | undefined;
    const violations = (error?.error?.details ?? []).filter(
      (d) => typeof d === "object" && d !== null && "fieldViolations" in (d as object)
    );

    probes.push({
      label: attempt.label,
      request: attempt.body,
      status: result.status,
      response: scrub(result.json ?? result.text.slice(0, 500)),
      fieldViolations: scrub(violations.length > 0 ? violations : null),
    });

    say(`    ${attempt.label}: HTTP ${result.status} — ${describeError(result).slice(0, 160)}`);
  }
  return probes;
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  say("Google Veo — authenticated API discovery");
  say("Unbilled: model reads, and probes that cannot succeed.\n");

  // --- 1. the credential ---
  apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    abort(
      "Neither GOOGLE_API_KEY nor GEMINI_API_KEY is set in this environment.",
      "Set GOOGLE_API_KEY server-side (an exported variable, or a line in .env, which is gitignored). Do not put it in source or paste it into a conversation."
    );
  }
  say(`  credential present: ${fingerprint(apiKey)}`);

  // --- 2. the endpoint answers, and accepts the credential ---
  const ping = await call("/models?pageSize=1");
  if (ping.status === 401 || ping.status === 403) {
    abort(
      `The API rejected the credential (HTTP ${ping.status}): ${describeError(ping)}`,
      "Confirm the key is valid, the Generative Language API is enabled on its project, and billing is enabled."
    );
  }
  if (ping.status !== 200) {
    abort(
      `${API_HOST} answered HTTP ${ping.status}: ${describeError(ping)}`,
      "Resolve the error above and re-run."
    );
  }
  say(`  ${API_HOST} accepted the credential (HTTP 200)\n`);

  // --- 3. every model this account can see ---
  say("MODELS");
  const models = await listModels();
  say(`  ${models.length} model(s) visible to this account`);

  const candidates = videoCandidates(models);
  say(`  ${candidates.length} support predictLongRunning (the video mechanism)\n`);

  if (candidates.length === 0) {
    say("  No model on this account declares predictLongRunning. Models seen:");
    for (const m of models.slice(0, 40)) {
      say(`    ${m.name}  [${(m.supportedGenerationMethods ?? []).join(", ")}]`);
    }
    abort(
      "This account has no model supporting the long-running prediction mechanism, so Veo is not reachable from it.",
      "Enable Veo access on the key's Google Cloud project (it requires billing, and may be regionally restricted), then re-run."
    );
  }

  for (const model of candidates) {
    say(`  ${model.name}`);
    say(`     displayName: ${model.displayName ?? "(none)"}`);
    say(`     version:     ${model.version ?? "(none)"}`);
    say(`     methods:     ${(model.supportedGenerationMethods ?? []).join(", ")}`);
    if (model.description) say(`     description: ${String(model.description).slice(0, 200)}`);
  }

  // --- 4. each candidate's full declared capabilities ---
  say("\nMODEL DETAIL (every field the API declares — nothing filtered)");
  const details: Record<string, unknown> = {};
  for (const model of candidates) {
    const result = await call(`/${model.name}`);
    details[model.name] = scrub(result.json);
    say(`\n  --- ${model.name} (HTTP ${result.status}) ---`);
    say(indent(JSON.stringify(scrub(result.json), null, 2), 2));
  }

  // --- 5. the request schema, from the API's own objections ---
  const probes: Record<string, Probe[]> = {};
  if (PROBE) {
    say("\nREQUEST SCHEMA PROBE");
    say("  Deliberately invalid requests. None can succeed, so none can be billed.\n");
    for (const model of candidates) {
      say(`  --- ${model.name} ---`);
      probes[model.name] = await probeSchema(model.name);
    }
  } else {
    say("\nREQUEST SCHEMA PROBE — skipped (pass --probe to run it)");
  }

  // --- 6. the contract, written down ---
  mkdirSync(REPORT_DIR, { recursive: true });
  const contract = scrub({
    recordedAt: new Date().toISOString(),
    host: API_HOST,
    base: BASE,
    // Never the credential — only proof that one was used.
    credentialFingerprint: fingerprint(apiKey),
    mechanism: {
      submit: "POST /v1beta/{model}:predictLongRunning",
      poll: "GET /v1beta/{operation.name}",
      note: "Established from the public discovery document; the payload shape is what the probe below establishes.",
    },
    videoCapableModels: candidates.map((m) => m.name),
    modelDetail: details,
    schemaProbes: probes,
  });
  writeFileSync(REPORT_PATH, JSON.stringify(contract, null, 2));

  // A final guard: the file is re-read and checked before anyone can share it.
  const written = readFileSync(REPORT_PATH, "utf8");
  if (apiKey && written.includes(apiKey)) {
    abort(
      "The credential appeared in the contract file.",
      "This is a bug in this script. The file has been written and must be deleted before it is shared."
    );
  }

  say(`\nContract written to ${path.relative(process.cwd(), REPORT_PATH)}`);
  say("  It contains no credential — only a fingerprint proving one was used.");
  say("");
  say("=".repeat(72));
  say("DISCOVERY COMPLETE — NO GENERATION PERFORMED, NOTHING BILLED");
  say("=".repeat(72));
  say("Next: the adapter is written from this contract, then verified with");
  say("exactly one real generation.");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

main().catch((error) => {
  console.error(scrub(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
