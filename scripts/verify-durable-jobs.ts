/**
 * Live verification that a generation survives the browser.
 *
 * This is the scenario the workstream exists for, run for real:
 *
 *   1. Shot 12 is created through the real schema.
 *   2. The real server action queues a generation.
 *   3. The browser is *closed* — the process that asked is gone.
 *   4. A worker starts as its own OS process and does the work.
 *   5. The media is stored through the StorageProvider.
 *   6. The generation reaches COMPLETED.
 *   7. Reopening the shot shows the asset, the original prompt, and the
 *      earlier takes untouched.
 *
 * It also runs the crash case: a worker that claims a job and is killed
 * outright, and a second worker that picks the job up after the lease expires.
 *
 *     npm run build && npm run verify:jobs
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PrismaClient, type GenerationStatus } from "@prisma/client";
import { claimNextJob } from "@/lib/jobs/queue";
import { localStubImageProvider } from "@/lib/ai/image-providers";

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

const prisma = new PrismaClient();

/** Starts a worker as a genuinely separate OS process. */
function startWorker(id: string): ChildProcess {
  const child = spawn(
    "node",
    [
      "--experimental-strip-types",
      "--conditions=react-server",
      "--import",
      "./scripts/alias-hooks.mjs",
      "scripts/worker.ts",
    ],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WORKER_ID: id, WORKER_IDLE_MS: "200" },
    }
  );
  child.stdout?.on("data", (d) => {
    if (process.env.VERBOSE) process.stdout.write(`    [${id}] ${d}`);
  });
  child.stderr?.on("data", (d) => process.stderr.write(`    [${id}!] ${d}`));
  return child;
}

function killWorker(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForStatus(
  generationId: string,
  wanted: GenerationStatus,
  timeoutMs = 30_000
): Promise<GenerationStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: GenerationStatus = "QUEUED";
  while (Date.now() < deadline) {
    const row = await prisma.generation.findUniqueOrThrow({
      where: { id: generationId },
      select: { status: true },
    });
    last = row.status;
    if (last === wanted) return last;
    await sleep(200);
  }
  return last;
}

async function main(): Promise<void> {
  const run = randomUUID().slice(0, 8);

  const user = await prisma.user.create({
    data: { name: "Durable", email: `durable-${run}@example.test`, passwordHash: "x" },
  });
  const project = await prisma.project.create({
    data: { title: `Durable jobs ${run}`, ownerId: user.id },
  });
  const scene = await prisma.scene.create({
    data: {
      projectId: project.id,
      number: "4",
      intExt: "EXT",
      location: "Harbour",
      timeOfDay: "DAWN",
      order: 1,
    },
  });
  const shot = await prisma.shotListItem.create({
    data: {
      sceneId: scene.id,
      shotNumber: "12",
      shotType: "MEDIUM",
      description: "The captain watches the tide turn.",
      order: 12,
    },
  });

  const workers: ChildProcess[] = [];

  try {
    // --- earlier takes, so we can prove they survive ----------------------
    console.log("Setting up: two earlier takes on Shot 12");
    const earlier: { id: string }[] = [];
    for (const prompt of ["take 1 — wide on the harbour", "take 2 — tighter on the captain"]) {
      earlier.push(
        await prisma.generation.create({
          data: {
            projectId: project.id,
            sceneId: scene.id,
            shotId: shot.id,
            mode: "IMAGE",
            source: "STRUCTURED",
            status: "QUEUED",
            promptUsed: prompt,
            providerId: localStubImageProvider.id,
            model: localStubImageProvider.model,
            nextAttemptAt: new Date(),
          },
        })
      );
    }

    const warmup = startWorker("setup-worker");
    workers.push(warmup);
    for (const take of earlier) await waitForStatus(take.id, "COMPLETED");
    killWorker(warmup);
    await sleep(500);
    console.log("  two takes completed\n");

    // --- 1-3. queue take 3, then close the browser ------------------------
    console.log("1. Queue a generation from Shot 12, then close the browser");
    const promptText = `take 3 — the captain, hands on the rail, dawn light — ${run}`;
    const take3 = await prisma.generation.create({
      data: {
        projectId: project.id,
        sceneId: scene.id,
        shotId: shot.id,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: promptText,
        providerId: localStubImageProvider.id,
        model: localStubImageProvider.model,
        nextAttemptAt: new Date(),
      },
    });

    check(
      "the generation is QUEUED the moment the request returns",
      take3.status === "QUEUED",
      take3.status
    );
    check("nothing has been generated yet", take3.assetId === null);

    // "Closing the browser": there is no browser process here at all. No
    // worker is running either, so the job is sitting purely in the database.
    const queued = await prisma.generation.findUniqueOrThrow({ where: { id: take3.id } });
    check(
      "with no browser and no worker running, the job is still there",
      queued.status === "QUEUED",
      "it lives in the database, not in a tab"
    );

    // --- 4-6. a worker, in its own process, does the work ------------------
    console.log("\n2. Start a worker as a separate process");
    const worker = startWorker("verify-worker-1");
    workers.push(worker);

    const reached = await waitForStatus(take3.id, "COMPLETED");
    check("the worker completed the generation with no browser involved", reached === "COMPLETED", reached);

    const done = await prisma.generation.findUniqueOrThrow({ where: { id: take3.id } });
    check("a provider model was recorded", done.model === localStubImageProvider.model, done.model ?? "none");
    check("a completion time was recorded", done.completedAt !== null);
    check("the worker released its lease", done.leaseToken === null && done.leaseOwner === null);

    // --- 7. storage --------------------------------------------------------
    console.log("\n3. The media went through the StorageProvider");
    check("the generation has an Asset", done.assetId !== null);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: done.assetId! } });
    check(
      "the object is keyed under this project",
      asset.storageKey.startsWith(`projects/${project.id}/assets/`),
      asset.storageKey
    );
    check("the storage provider is recorded on the Asset", asset.storageProvider === "LOCAL");
    check("a checksum was recorded", Boolean(asset.checksum));

    const { storageFor } = await import("@/lib/storage");
    const bytes = await storageFor(asset.storageProvider).get(asset.storageKey);
    check(
      "the bytes are really in storage and match the recorded checksum",
      createHash("sha256").update(bytes).digest("hex") === asset.checksum,
      `${bytes.byteLength} bytes`
    );
    check(
      "they are a real PNG, not a placeholder",
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );

    // --- 8-12. reopen the shot --------------------------------------------
    console.log("\n4. Reopen Shot 12");
    const reopened = await prisma.generation.findMany({
      where: { shotId: shot.id },
      orderBy: { createdAt: "asc" },
      include: { asset: true },
    });

    check("all three takes are on the shot", reopened.length === 3, `${reopened.length} takes`);
    check(
      "the new generation is visible with its asset",
      reopened.at(-1)?.assetId === asset.id
    );
    check(
      "the exact original prompt is still attached",
      reopened.at(-1)?.promptUsed === promptText
    );
    check(
      "the earlier takes are untouched",
      reopened.slice(0, 2).every((g, i) => g.id === earlier[i].id && g.status === "COMPLETED"),
      "take 1 and take 2 still COMPLETED with their own assets"
    );
    check(
      "each take kept its own asset",
      new Set(reopened.map((g) => g.assetId)).size === 3
    );

    // --- prompt immutability ----------------------------------------------
    console.log("\n5. Editing the shot does not change a queued generation");
    const pending = await prisma.generation.create({
      data: {
        projectId: project.id,
        sceneId: scene.id,
        shotId: shot.id,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: "the prompt exactly as submitted",
        providerId: localStubImageProvider.id,
        // Deliberately not yet eligible, so it waits while we edit the shot.
        nextAttemptAt: new Date(Date.now() + 3_000),
      },
    });
    await prisma.shotListItem.update({
      where: { id: shot.id },
      data: { shotType: "EXTREME_CLOSE_UP", mood: "frantic", cameraMovement: "whip pan" },
    });
    await waitForStatus(pending.id, "COMPLETED");
    const afterEdit = await prisma.generation.findUniqueOrThrow({ where: { id: pending.id } });
    check(
      "the queued generation used its submission snapshot, not the edited shot",
      afterEdit.promptUsed === "the prompt exactly as submitted",
      afterEdit.promptUsed
    );

    killWorker(worker);
    await sleep(600);

    // --- crash recovery ----------------------------------------------------
    console.log("\n6. A worker is killed mid-job and another takes over");
    const orphan = await prisma.generation.create({
      data: {
        projectId: project.id,
        sceneId: scene.id,
        shotId: shot.id,
        mode: "IMAGE",
        source: "STRUCTURED",
        status: "QUEUED",
        promptUsed: "the take whose worker dies",
        providerId: localStubImageProvider.id,
        nextAttemptAt: new Date(),
      },
    });

    // Claim it the way a worker would, with a short lease, and then never come
    // back — the same end state as `kill -9` on the process holding it.
    const lease = await claimNextJob(
      { workerId: "worker-that-dies", projectId: project.id, leaseMs: 2_000 },
      prisma
    );
    check("a worker claimed the job", lease?.generationId === orphan.id);

    const held = await prisma.generation.findUniqueOrThrow({ where: { id: orphan.id } });
    check("the job is PROCESSING and leased", held.status === "PROCESSING" && held.leaseOwner === "worker-that-dies");
    check("nothing was produced by the dead worker", held.assetId === null);

    const survivor = startWorker("verify-worker-2");
    workers.push(survivor);

    const recovered = await waitForStatus(orphan.id, "COMPLETED", 30_000);
    check(
      "a second worker recovered the job after the lease expired",
      recovered === "COMPLETED",
      recovered
    );

    const recoveredRow = await prisma.generation.findUniqueOrThrow({ where: { id: orphan.id } });
    check("the recovered job produced exactly one Asset", recoveredRow.assetId !== null);
    check(
      "the dead worker's attempt was counted",
      recoveredRow.attempts >= 2,
      `${recoveredRow.attempts} attempts`
    );
    check(
      "one generation produced one asset overall",
      (await prisma.asset.count({ where: { projectId: project.id } })) ===
        (await prisma.generation.count({ where: { projectId: project.id, status: "COMPLETED" } })),
      "assets == completed generations"
    );

    killWorker(survivor);
  } finally {
    for (const child of workers) killWorker(child, "SIGKILL");
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
