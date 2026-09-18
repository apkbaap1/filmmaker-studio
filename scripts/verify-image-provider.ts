/**
 * End-to-end verification of the real image adapter.
 *
 * The full path is exercised with the production code at every stage:
 *
 *   Shot 12 -> context -> CinematicPromptSpec -> compiled prompt
 *           -> Generation (QUEUED) -> worker claims -> REAL OpenAI adapter
 *           -> HTTP -> validation -> StorageProvider -> Asset -> COMPLETED
 *
 * The one substitution is the server at the other end of the socket: a local
 * process speaking the OpenAI Images protocol, because this environment has
 * neither a credential nor egress to api.openai.com.
 *
 * **This is not evidence that OpenAI works.** It is evidence that everything on
 * this side of the wire is correct. The distinction is kept sharp in the report
 * and in this script's own output.
 *
 *     npm run verify:image-provider
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  const raster = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface Seen {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

const seen: Seen[] = [];
let mode: "image" | "rate-limited" | "bad-credentials" | "html" = "image";

const provider = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* recorded as empty */
    }
    seen.push({ authorization: req.headers.authorization, body });

    if (mode === "bad-credentials") {
      return void res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
    }
    if (mode === "rate-limited") {
      return void res
        .writeHead(429, { "content-type": "application/json", "retry-after": "1" })
        .end(JSON.stringify({ error: { message: "Rate limit reached" } }));
    }
    if (mode === "html") {
      return void res
        .writeHead(200, { "content-type": "text/html" })
        .end("<html><body>gateway error</body></html>");
    }

    const size = String(body.size ?? "1024x1024");
    const [w, h] = size.split("x").map(Number);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ b64_json: png(w, h).toString("base64") }] }));
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as AddressInfo).port;

  // Point the real adapter at the local protocol server, and give it a
  // syntactically valid but entirely fake key.
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.OPENAI_API_KEY = "sk-verification-not-a-real-key";
  process.env.IMAGE_PROVIDER = "openai-gpt-image-1";

  const prisma = new PrismaClient();
  const { drainQueue } = await import("@/lib/jobs/worker");
  const { compileShotImagePrompt } = await import("@/lib/shot-prompt");
  const { getImageProvider, configuredImageProviderId } = await import("@/lib/ai/image-providers");
  const { DEFAULT_PROVIDER_ID } = await import("@/lib/prompt");
  const { storageFor } = await import("@/lib/storage");

  console.log("Provider under test: the real OpenAI adapter");
  console.log(`Server at the other end: a local OpenAI-protocol mock on 127.0.0.1:${port}`);
  console.log("This is NOT a call to OpenAI.\n");

  // --- the real Shot 12 -------------------------------------------------
  const shot = await prisma.shotListItem.findFirst({
    where: { shotNumber: "12", scene: { number: "4", location: { contains: "RAILWAY" } } },
    include: { scene: { include: { project: true } } },
  });
  if (!shot) throw new Error("Shot 12 of the railway-station scene was not found");

  const projectId = shot.scene.projectId;
  const sceneId = shot.sceneId;

  console.log("1. The shot");
  check(
    "Shot 12 is the abandoned railway station, at night",
    shot.scene.location.includes("RAILWAY") && shot.scene.timeOfDay === "NIGHT",
    `${shot.scene.location} · ${shot.scene.timeOfDay}`
  );
  check(
    "its filmmaking values are as the filmmaker set them",
    shot.shotType === "Medium Close-Up" && shot.cameraAngle === "Low Angle",
    `${shot.shotType} · ${shot.cameraAngle} · ${shot.focalLength ?? "no focal length"}`
  );

  // --- compile ----------------------------------------------------------
  console.log("\n2. Compile");
  const resolved = await compileShotImagePrompt(projectId, sceneId, shot.id, DEFAULT_PROVIDER_ID);
  if (!resolved) throw new Error("the shot did not compile");
  const promptText = resolved.compiled.text;

  check("a CinematicPromptSpec was produced", Boolean(resolved.compiled.spec));
  check(
    "the filmmaker's values survive into the prompt",
    ["Medium Close-Up", "Low Angle", "85mm"].every((v) => promptText.includes(v)),
    ["Medium Close-Up", "Low Angle", "85mm"].filter((v) => promptText.includes(v)).join(", ")
  );

  const before = await prisma.generation.count({ where: { shotId: shot.id } });

  // --- queue ------------------------------------------------------------
  console.log("\n3. Queue");
  const providerId = configuredImageProviderId();
  const adapter = getImageProvider(providerId);
  check("the configured provider is the real adapter", providerId === "openai-gpt-image-1", providerId);
  check("it declares itself real, not a stub", adapter.capabilities?.kind === "real");
  check("it reports itself configured", adapter.isConfigured() === true);

  const generation = await prisma.generation.create({
    data: {
      projectId,
      sceneId,
      shotId: shot.id,
      mode: "IMAGE",
      source: "STRUCTURED",
      status: "QUEUED",
      promptUsed: promptText,
      specSnapshot: resolved.compiled.spec as never,
      providerId,
      model: adapter.model,
      promptProviderId: resolved.compiled.providerId,
      requestedParams: { size: adapter.capabilities?.defaultSize, providerKind: "real", imagesRequested: 1 } as never,
      nextAttemptAt: new Date(),
    },
  });
  check("the generation is QUEUED", generation.status === "QUEUED");
  check("the exact prompt was captured before submission", generation.promptUsed === promptText);

  // --- worker -----------------------------------------------------------
  console.log("\n4. The worker runs it");
  const stats = await drainQueue({ workerId: "verify-image", projectId, db: prisma });
  check("the worker completed it", stats.completed === 1, JSON.stringify(stats));

  check("the provider was actually called", seen.length === 1, `${seen.length} HTTP request(s)`);
  const request = seen[0];
  check(
    "the request carried a bearer credential",
    request?.authorization?.startsWith("Bearer ") === true
  );
  check(
    "the prompt reached the provider byte-for-byte",
    request?.body.prompt === promptText,
    "no rewriting between the compiler and the wire"
  );
  check("the model was the adapter's", request?.body.model === adapter.model, String(request?.body.model));
  check("the requested size was sent", request?.body.size === adapter.capabilities?.defaultSize, String(request?.body.size));

  // --- result -----------------------------------------------------------
  console.log("\n5. Validation, storage and the Asset");
  const done = await prisma.generation.findUniqueOrThrow({ where: { id: generation.id } });
  check("the generation is COMPLETED", done.status === "COMPLETED", done.status);
  check("it points at an Asset", done.assetId !== null);
  check("a completion time was recorded", done.completedAt !== null);

  const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
  check("the Asset belongs to the project, scene and shot", 
    asset.projectId === projectId && asset.sceneId === sceneId && asset.shotId === shot.id);
  check("the MIME type was validated", asset.mimeType === "image/png", asset.mimeType);
  check(
    "the dimensions were measured from the bytes",
    asset.width === 1024 && asset.height === 1024,
    `${asset.width}x${asset.height}`
  );
  check("a checksum was recorded", Boolean(asset.checksum));
  check("the Asset carries the prompt that made it", asset.prompt === promptText);

  const bytes = await storageFor(asset.storageProvider).get(asset.storageKey);
  check(
    "the bytes are in storage and match the checksum",
    createHash("sha256").update(bytes).digest("hex") === asset.checksum,
    `${bytes.byteLength} bytes`
  );
  check(
    "they are a real PNG",
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
  check(
    "it was stored through the StorageProvider, keyed by project",
    asset.storageKey.startsWith(`projects/${projectId}/assets/`),
    asset.storageKey
  );

  // --- history ----------------------------------------------------------
  console.log("\n6. History");
  const after = await prisma.generation.count({ where: { shotId: shot.id } });
  check("earlier generations were not overwritten", after === before + 1, `${before} -> ${after}`);

  await prisma.shotListItem.update({
    where: { id: shot.id },
    data: { mood: `edited after generation ${randomUUID().slice(0, 6)}` },
  });
  const afterEdit = await prisma.generation.findUniqueOrThrow({ where: { id: generation.id } });
  check(
    "editing the shot afterwards does not alter the generation",
    afterEdit.promptUsed === promptText && afterEdit.assetId === done.assetId
  );

  // --- failures ---------------------------------------------------------
  console.log("\n7. Failure handling against the same real adapter");

  async function runFailure(
    label: string,
    serverMode: typeof mode,
    expectStatus: "FAILED" | "QUEUED",
    expectKind: string | null
  ) {
    mode = serverMode;
    const job = await prisma.generation.create({
      data: {
        projectId,
        sceneId,
        shotId: shot!.id,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: promptText,
        providerId,
        model: adapter.model,
        maxAttempts: 1,
        requestedParams: { size: adapter.capabilities?.defaultSize, providerKind: "real" } as never,
        nextAttemptAt: new Date(),
      },
    });
    await drainQueue({ workerId: "verify-failure", projectId, db: prisma });
    const row = await prisma.generation.findUniqueOrThrow({ where: { id: job.id } });

    check(
      `${label}: the generation did not become COMPLETED`,
      row.status !== "COMPLETED",
      row.status
    );
    check(`${label}: classified as ${expectKind}`, row.failureKind === expectKind, String(row.failureKind));
    check(`${label}: no Asset was created`, row.assetId === null);
    check(
      `${label}: the credential is not in the recorded error`,
      !(row.error ?? "").includes("sk-verification-not-a-real-key")
    );
    mode = "image";
    return row;
  }

  await runFailure("invalid credentials", "bad-credentials", "FAILED", "PERMANENT");
  await runFailure("an HTML page instead of JSON", "html", "FAILED", "RETRYABLE");
  await runFailure("rate limiting", "rate-limited", "FAILED", "RETRYABLE");

  // --- cleanup ----------------------------------------------------------
  await prisma.generation.deleteMany({
    where: { shotId: shot.id, id: { not: generation.id } , status: "FAILED" },
  });
  await prisma.$disconnect();
  provider.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("\nREAL EXTERNAL GENERATION NOT PERFORMED — the server above was a local");
  console.log("protocol mock. No request left this machine and no provider was billed.");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  provider.close();
  process.exit(1);
});
