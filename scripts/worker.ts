/**
 * The generation worker.
 *
 *     npm run worker
 *
 * Runs independently of the web application: it needs the database, the storage
 * configuration and the provider configuration, and nothing else. No browser,
 * no open tab and no HTTP request has to exist for a generation to finish.
 *
 * Run as many as you like — claiming is safe across processes and machines. See
 * README > "Background generation".
 */
import { PrismaClient } from "@prisma/client";
import { newWorkerId, runWorker } from "@/lib/jobs/worker";
import { queueDepth } from "@/lib/jobs/queue";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const workerId = process.env.WORKER_ID || newWorkerId();
  const controller = new AbortController();

  // Graceful shutdown: stop claiming, let the step in flight finish. Anything
  // still running when the process is killed outright is recovered by lease
  // expiry, so neither path loses work.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        console.log(JSON.stringify({ at: new Date().toISOString(), event: "worker-forced" }));
        process.exit(1);
      }
      stopping = true;
      console.log(
        JSON.stringify({ at: new Date().toISOString(), event: "worker-stopping", workerId })
      );
      controller.abort();
    });
  }

  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "worker-started",
      workerId,
      queue: await queueDepth(prisma),
    })
  );

  const stats = await runWorker({
    workerId,
    signal: controller.signal,
    idleMs: Number(process.env.WORKER_IDLE_MS) || 1_000,
    db: prisma,
  });

  console.log(
    JSON.stringify({ at: new Date().toISOString(), event: "worker-stopped", workerId, ...stats })
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), event: "worker-crashed" }));
  console.error(err);
  process.exit(1);
});
