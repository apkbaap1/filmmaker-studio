/**
 * Workstream 11.4-R — REAL provider verification.
 *
 * Performs exactly ONE genuine, billed image generation against the live OpenAI
 * API and records the evidence, or refuses to run and says why.
 *
 *     npm run verify:real-generation
 *
 * ## This script cannot be satisfied by a mock
 *
 * That is its whole point, so the guard is structural rather than a convention:
 * it refuses to start unless the adapter is pointed at the real api.openai.com.
 * If OPENAI_BASE_URL is set to anything else — a local protocol server, a
 * gateway, a recording proxy — it aborts. A green run here therefore cannot have
 * come from anything but the real service.
 *
 * ## It spends real money
 *
 * One image. It refuses to loop, refuses to retry the provider call, and checks
 * the application's own generation limits before asking for anything.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { verifyAfterGeneration } from "./verify-after-generation.ts";

/** The only host this verification will accept. Anything else and it refuses. */
const REAL_API_HOST = "api.openai.com";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

function abort(reason: string, remedy: string): never {
  console.log("");
  console.log("=".repeat(72));
  console.log("REAL EXTERNAL GENERATION NOT PERFORMED");
  console.log("=".repeat(72));
  console.log(`Blocker: ${reason}`);
  console.log(`Remedy:  ${remedy}`);
  console.log("");
  console.log("Nothing was generated, nothing was billed, and no substitute was");
  console.log("run in its place. 11.4 remains:");
  console.log("  REAL PROVIDER INTEGRATION IMPLEMENTED - EXTERNAL VERIFICATION PENDING");
  process.exit(2);
}

/** Never prints a credential — only enough to show the right shape is present. */
function fingerprint(secret: string): string {
  const digest = createHash("sha256").update(secret).digest("hex").slice(0, 12);
  return `${secret.length} chars, sha256:${digest}…`;
}

async function main(): Promise<void> {
  console.log("Workstream 11.4-R — real provider verification\n");
  console.log("PREFLIGHT (nothing is called until every check passes)\n");

  // --- 1. the credential exists, and only server-side --------------------
  const apiKey = process.env.OPENAI_API_KEY;
  if (!check("a provider credential is present in the server environment", Boolean(apiKey))) {
    abort(
      "OPENAI_API_KEY is not set in this environment.",
      "Set OPENAI_API_KEY in the server environment (never in client code or a committed file) and re-run."
    );
  }
  console.log(`        credential fingerprint: ${fingerprint(apiKey!)}`);

  // --- 2. the credential is not reachable from the browser ---------------
  const { readdirSync, readFileSync, statSync, existsSync } = await import("node:fs");
  const path = await import("node:path");

  const staticDir = path.join(process.cwd(), ".next", "static");
  if (existsSync(staticDir)) {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(staticDir);

    const leaking = files.filter((file) => readFileSync(file, "utf8").includes(apiKey!));
    check(
      "the credential appears in no client bundle",
      leaking.length === 0,
      `${files.length} chunks scanned`
    );
    if (leaking.length > 0) {
      abort(
        `The credential is present in ${leaking.length} client chunk(s).`,
        "Fix the leak before generating anything. Do not proceed."
      );
    }
  } else {
    check("a built client bundle was available to scan", false, "run `npm run build` first");
    abort(
      "No .next/static build to scan for credential leakage.",
      "Run `npm run build`, then re-run this verification."
    );
  }

  // --- 3. the adapter is pointed at the real service ---------------------
  const baseUrl = process.env.OPENAI_BASE_URL;
  const host = baseUrl ? new URL(baseUrl).host : REAL_API_HOST;
  if (
    !check(
      "the adapter is pointed at the real provider, not a mock",
      host === REAL_API_HOST,
      baseUrl ? `OPENAI_BASE_URL host is ${host}` : "OPENAI_BASE_URL unset — the real API"
    )
  ) {
    abort(
      `OPENAI_BASE_URL points at ${host}, which is not ${REAL_API_HOST}.`,
      "Unset OPENAI_BASE_URL. This verification is meaningless against anything but the real service, so it refuses to run."
    );
  }

  // --- 4. the model is one the implemented request path supports ---------
  const { getImageProvider, configuredImageProviderId } = await import("@/lib/ai/image-providers");
  const providerId = configuredImageProviderId();
  const provider = getImageProvider(providerId);

  check("the configured provider is the real adapter", providerId === "openai-gpt-image-1", providerId);
  check("it declares itself real, not a stub", provider.capabilities?.kind === "real");
  check("it reports itself configured", provider.isConfigured() === true);
  check(
    "its model is the one the request path sends",
    provider.model === "gpt-image-1",
    provider.model
  );
  const size = provider.capabilities?.defaultSize;
  check(
    "the size to be requested is one the provider supports",
    Boolean(size && provider.capabilities?.sizes.includes(size)),
    String(size)
  );

  // --- 5. outbound network ------------------------------------------------
  // A HEAD to the models endpoint: cheap, unbilled, and it proves the tunnel
  // opens. An auth failure here would still prove reachability, which is what
  // this check is about.
  //
  // Getting *an* HTTP response is not the same as reaching the provider. An
  // egress proxy that denies the destination answers the CONNECT with a 403,
  // which arrives here looking like a perfectly ordinary response. Treating any
  // status as "reachable" would let this script march on and spend a credit
  // against a host it cannot actually talk to.
  //
  let reached = false;
  let reachDetail = "";
  let status = 0;
  let body = "";

  try {
    const response = await fetch(`https://${REAL_API_HOST}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    status = response.status;
    body = await response.text().catch(() => "");
    // Only a response the provider itself could have produced counts. 200 is a
    // real listing; 401 is the provider rejecting a key, which still proves the
    // tunnel opened.
    reached = status === 200 || status === 401;
    reachDetail = `HTTP ${status}`;
  } catch (error) {
    reachDetail = error instanceof Error ? error.message : String(error);
  }

  if (!check(`${REAL_API_HOST} answered as itself`, reached, reachDetail)) {
    if (status === 403 || status === 407) {
      abort(
        `Outbound HTTPS to ${REAL_API_HOST} was denied by an egress policy (HTTP ${status}). This is the proxy refusing the destination, not the provider answering.`,
        "An organization egress policy must allow api.openai.com for this session. Per the proxy's own documentation a 403/407 must be reported, not retried or routed around."
      );
    }
    abort(
      `Could not reach ${REAL_API_HOST}: ${reachDetail}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      "Restore outbound HTTPS to api.openai.com and re-run."
    );
  }

  if (status === 401) {
    check("the provider accepted the credential", false, "HTTP 401 — the key is rejected");
    abort(
      "The provider rejected the credential (HTTP 401).",
      "Check that OPENAI_API_KEY is valid and has image-generation access."
    );
  }
  check("the provider accepted the credential", status === 200, `HTTP ${status}`);

  // --- 6. the shot ---------------------------------------------------------
  const prisma = new PrismaClient();
  const shot = await prisma.shotListItem.findFirst({
    where: { shotNumber: "12", scene: { number: "4", location: { contains: "RAILWAY" } } },
    include: { scene: true },
  });
  if (!shot) {
    await prisma.$disconnect();
    abort("Shot 12 of the railway-station scene was not found.", "Restore the project fixture.");
  }
  const projectId = shot.scene.projectId;
  check(
    "Shot 12 is the abandoned railway station",
    shot.scene.location.includes("RAILWAY"),
    `${shot.scene.location} · ${shot.scene.timeOfDay} · ${shot.shotType} · ${shot.cameraAngle}`
  );

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  // --- 7. the application's own limits permit one more --------------------
  const { checkGenerationAllowed } = await import("@/lib/generation-limits");
  const allowed = await checkGenerationAllowed({
    projectId,
    userId: project.ownerId,
    providerKind: "real",
  });
  if (!check("the generation limits permit this test", allowed.ok, allowed.ok ? "" : allowed.reason)) {
    await prisma.$disconnect();
    abort(
      `The application's own cost ceiling refused the request: ${allowed.ok ? "" : allowed.reason}`,
      "Wait for the window to roll over, or raise the relevant GENERATION_LIMIT_* value deliberately."
    );
  }

  console.log("\nPreflight passed. Performing exactly ONE real, billed generation.\n");

  // --- the one real generation --------------------------------------------
  const { compileShotImagePrompt } = await import("@/lib/shot-prompt");
  const { DEFAULT_PROVIDER_ID } = await import("@/lib/prompt");
  const { drainQueue } = await import("@/lib/jobs/worker");
  const { storageFor } = await import("@/lib/storage");

  const resolved = await compileShotImagePrompt(projectId, shot.sceneId, shot.id, DEFAULT_PROVIDER_ID);
  if (!resolved) {
    await prisma.$disconnect();
    abort("Shot 12 did not compile.", "Investigate the compiler before spending a credit.");
  }
  const promptText = resolved.compiled.text;
  const before = await prisma.generation.findMany({
    where: { shotId: shot.id },
    select: { id: true, status: true, assetId: true, promptUsed: true },
  });

  const requestedAt = new Date();
  const generation = await prisma.generation.create({
    data: {
      projectId,
      sceneId: shot.sceneId,
      shotId: shot.id,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: promptText,
      specSnapshot: resolved.compiled.spec as never,
      providerId,
      model: provider.model,
      promptProviderId: resolved.compiled.providerId,
      requestedParams: { size, providerKind: "real", imagesRequested: 1 } as never,
      // One attempt. A retry would be a second billed call, and this script
      // exists to make exactly one.
      maxAttempts: 1,
      nextAttemptAt: new Date(),
    },
  });

  console.log(`  Generation ${generation.id} queued at ${requestedAt.toISOString()}`);
  console.log("  Handing it to a worker…\n");

  const stats = await drainQueue({ workerId: "verify-real", projectId, db: prisma });
  await sleep(200);

  const done = await prisma.generation.findUniqueOrThrow({ where: { id: generation.id } });

  if (done.status !== "COMPLETED") {
    console.log(`  The generation ended ${done.status}: ${done.error ?? "no error recorded"}`);
    await prisma.$disconnect();
    abort(
      `The real provider call did not produce an image (${done.status}, ${done.failureKind}).`,
      "Read the recorded error above. Nothing is claimed as verified."
    );
  }

  console.log("EVIDENCE\n");
  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
  const bytes = await storageFor(asset.storageProvider).get(asset.storageKey);

  const evidence = {
    provider: providerId,
    providerLabel: provider.label,
    model: done.model,
    requestedSize: size,
    requestedAt: requestedAt.toISOString(),
    submittedAt: done.submissionAttemptedAt?.toISOString() ?? null,
    completedAt: done.completedAt?.toISOString() ?? null,
    elapsedMs:
      done.submissionAttemptedAt && done.completedAt
        ? done.completedAt.getTime() - done.submissionAttemptedAt.getTime()
        : null,
    generationId: done.id,
    // The adapter rejects every non-2xx, so a completed generation establishes
    // a 2xx. No status is invented beyond what that proves.
    providerResponseStatus: "2xx (the adapter fails the job on any non-2xx)",
    assetId: asset.id,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    fileSize: asset.fileSize,
    checksum: asset.checksum,
    storageProvider: asset.storageProvider,
    storageKey: asset.storageKey,
  };
  console.log(JSON.stringify(evidence, null, 2));
  console.log("");

  check("the worker completed exactly one generation", stats.completed === 1, JSON.stringify(stats));
  check(
    "the job was claimed exactly once, so no second paid call was made",
    stats.claimed === 1,
    `${stats.claimed} claim(s), ${stats.retried} retry/retries`
  );
  check("no retry was scheduled into a second provider call", stats.retried === 0);
  check(
    "the CinematicPromptSpec snapshot was persisted with the generation",
    done.specSnapshot !== null && typeof done.specSnapshot === "object"
  );
  check("the generation is COMPLETED", done.status === "COMPLETED");
  check("it points at an Asset", asset.id === done.assetId);
  check("the MIME type was validated", asset.mimeType === "image/png", asset.mimeType);
  check(
    "dimensions were measured from the returned bytes",
    asset.width !== null && asset.height !== null,
    `${asset.width}x${asset.height}`
  );
  check(
    "the stored bytes match the recorded checksum",
    createHash("sha256").update(bytes).digest("hex") === asset.checksum,
    `${bytes.byteLength} bytes`
  );
  check(
    "the bytes are a real PNG",
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );

  console.log("\nPROMPT INTEGRITY\n");
  check("the generation's prompt is the compiled prompt", done.promptUsed === promptText);
  check(
    "the filmmaker's values survived to the provider",
    ["Medium Close-Up", "Low Angle", "85mm"].every((v) => done.promptUsed.includes(v))
  );
  check("the Asset carries the same prompt", asset.prompt === promptText);

  console.log("\nSTORAGE\n");
  check(
    "stored through the StorageProvider, under this project's prefix",
    asset.storageKey.startsWith(`projects/${projectId}/assets/`),
    asset.storageKey
  );
  check(
    "no provider-specific filesystem path was used",
    !asset.storageKey.includes("openai") && !asset.storageKey.includes(".."),
    "the key is application-generated"
  );

  // Persistence, a real browser refresh and the stranger checks are shared with
  // the mock-backed verification, so this code has already been exercised
  // before the one real run depends on it.
  await verifyAfterGeneration({
    prisma,
    check,
    projectId,
    sceneId: shot.sceneId,
    shotId: shot.id,
    generationId: done.id,
    assetId: asset.id,
    assetChecksum: asset.checksum,
    assetMimeType: asset.mimeType,
    promptText,
    before,
  });

  console.log("\nAUTHORIZATION (the read query the application itself uses)\n");
  const outsiderId = (
    await prisma.user.create({
      data: {
        name: "Verification outsider",
        email: `verify-outsider-${randomUUID().slice(0, 8)}@example.test`,
        passwordHash: "x",
      },
    })
  ).id;

  try {
    const visibleGeneration = await prisma.generation.findFirst({
      where: {
        id: done.id,
        project: {
          OR: [{ ownerId: outsiderId }, { members: { some: { userId: outsiderId } } }],
        },
      },
    });
    check("an outsider's own query returns no Generation", visibleGeneration === null);

    const visibleAsset = await prisma.asset.findFirst({
      where: {
        id: asset.id,
        project: {
          OR: [{ ownerId: outsiderId }, { members: { some: { userId: outsiderId } } }],
        },
      },
    });
    check("an outsider's own query returns no Asset", visibleAsset === null);
  } finally {
    await prisma.user.delete({ where: { id: outsiderId } }).catch(() => {});
  }

  await prisma.$disconnect();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nREAL EXTERNAL GENERATION PERFORMED, BUT CHECKS FAILED — see above.");
    process.exit(1);
  }
  console.log("");
  console.log("=".repeat(72));
  console.log("REAL PROVIDER VERIFIED");
  console.log("=".repeat(72));
  console.log(`One genuine image was generated by ${providerId} (${done.model}) and passed`);
  console.log("through the worker, validation, the StorageProvider, the Asset and the");
  console.log(`database. Generation ${done.id}, Asset ${asset.id}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
