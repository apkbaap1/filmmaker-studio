/**
 * End-to-end verification of the local → object storage migration.
 *
 * Runs the *shipped* `scripts/migrate-storage.ts` as a subprocess against a
 * real Postgres row, a real file on local disk and a real S3-protocol server,
 * and checks the three properties that make the migration trustworthy:
 *
 *   - a report run changes nothing;
 *   - an apply run only repoints a row after the uploaded object has been read
 *     back and its checksum matched;
 *   - a corrupted upload leaves the row pointing at local disk.
 *
 *     npm run verify:migration
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { LocalStorageProvider } from "../src/lib/storage/local.ts";

const BUCKET = "filmmaker-migration-test";

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

interface Obj { body: Buffer; contentType: string }

/** Set to corrupt what the bucket hands back, to prove verification is real. */
let corruptReads = false;

function s3Mock(store: Map<string, Obj>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.replace(/^\//, "").split("/");
    const bucket = segments.shift();
    const key = segments.join("/");
    if (bucket !== BUCKET) return void res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        store.set(key, {
          body: Buffer.concat(chunks),
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
        });
        res.writeHead(200, { ETag: '"x"' }).end();
      });
      return;
    }
    const object = store.get(key);
    if (!object) return void res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
    if (req.method === "DELETE") { store.delete(key); return void res.writeHead(204).end(); }

    const body = corruptReads ? Buffer.from("tampered in transit") : object.body;
    res.writeHead(200, { "Content-Type": object.contentType, "Content-Length": String(body.byteLength) });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

function runMigrate(env: Record<string, string>, apply: boolean): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const args = [
      "--experimental-strip-types",
      "--conditions=react-server",
      "scripts/migrate-storage.ts",
      ...(apply ? ["--apply"] : []),
    ];
    const child = spawn("node", args, { cwd: process.cwd(), env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 0, out }));
  });
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const store = new Map<string, Obj>();
  const server = createServer(s3Mock(store));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const s3Env = {
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REGION: "us-east-1",
    S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: "true",
  };

  const run = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: { name: "Migration", email: `migration-${run}@example.test`, passwordHash: "x" },
  });
  const project = await prisma.project.create({ data: { title: `Migration ${run}`, ownerId: user.id } });

  // A pre-migration asset: legacy key shape, bytes really on local disk.
  const local = new LocalStorageProvider();
  const body = Buffer.from(`original frame ${run}`);
  const checksum = createHash("sha256").update(body).digest("hex");
  const legacyKey = `${project.id}/${randomUUID()}.png`;
  await local.put(legacyKey, body, { contentType: "image/png" });

  const asset = await prisma.asset.create({
    data: {
      projectId: project.id,
      type: "IMAGE",
      source: "UPLOADED",
      storageProvider: "LOCAL",
      storageKey: legacyKey,
      mimeType: "image/png",
      fileSize: body.byteLength,
    },
  });

  const localFilePath = path.join(process.env.STORAGE_DIR || path.join(process.cwd(), "storage", "uploads"), legacyKey);

  try {
    console.log("1. Report run");
    {
      const { out } = await runMigrate(s3Env, false);
      const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      check("a report run leaves the row untouched", after.storageProvider === "LOCAL" && after.storageKey === legacyKey);
      check("a report run uploads nothing", store.size === 0, `${store.size} objects in the bucket`);
      check("the report names the destination key it would use", out.includes(`projects/${project.id}/assets/`));
    }

    console.log("\n2. A corrupted upload must not repoint the row");
    {
      corruptReads = true;
      const { out } = await runMigrate(s3Env, true);
      corruptReads = false;
      const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      check(
        "the row still points at local disk when the read-back does not verify",
        after.storageProvider === "LOCAL" && after.storageKey === legacyKey,
        `${after.storageProvider}:${after.storageKey}`
      );
      check("the failure is reported rather than swallowed", out.includes("did not verify"));
      store.clear();
    }

    console.log("\n3. Apply run");
    {
      const { out, code } = await runMigrate(s3Env, true);
      const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      const canonicalKey = after.storageKey;

      check("the migration exits clean", code === 0, `exit ${code}`);
      check("the row now points at object storage", after.storageProvider === "S3", after.storageProvider);
      check(
        "the legacy key was rewritten to the canonical shape",
        canonicalKey.startsWith(`projects/${project.id}/assets/`) && canonicalKey.endsWith("/original.png"),
        canonicalKey
      );
      check("the checksum was recorded", after.checksum === checksum, `${after.checksum?.slice(0, 16)}…`);
      check(
        "the object is in the bucket, byte for byte",
        store.get(canonicalKey)?.body.equals(body) === true,
        `${store.get(canonicalKey)?.body.byteLength} bytes`
      );

      // The rule that matters most: the source is still there.
      const stillLocal = await readFile(localFilePath);
      check("the local file was NOT deleted", stillLocal.equals(body), localFilePath);
      check(
        "the operator is told the local file is now redundant, and that it was left alone",
        out.includes("NOT been deleted") && out.includes(legacyKey)
      );
    }

    console.log("\n4. Re-running is safe");
    {
      const before = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      const { out, code } = await runMigrate(s3Env, true);
      const after = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
      check(
        "an already-migrated asset is skipped, not re-uploaded",
        code === 0 && after.storageKey === before.storageKey && out.includes("No assets are on local storage")
      );
    }
  } finally {
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await local.delete(legacyKey).catch(() => {});
    await prisma.$disconnect();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
