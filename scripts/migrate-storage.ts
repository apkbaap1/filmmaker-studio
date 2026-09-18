/**
 * Local disk → object storage migration.
 *
 * Run with `npm run storage:migrate` (a report, nothing is changed) and then
 * `npm run storage:migrate -- --apply` once the report looks right.
 *
 * The safety rules this script is built around:
 *
 *  1. **Verify before recording.** An Asset row is only repointed after the
 *     object has been read back out of the destination and its SHA-256 matches
 *     the bytes that went in. A row that points at an object nobody has proven
 *     exists is worse than one that still points at local disk.
 *
 *  2. **Never delete the source.** The local files stay exactly where they are.
 *     The script prints what became redundant and leaves the decision — and the
 *     backup — to an operator. Deleting them is a separate, human step.
 *
 *  3. **Never invent bytes.** A missing local file, a checksum that disagrees
 *     with the one already recorded, or a key that fails validation is reported
 *     and skipped. It is never papered over and never counted as migrated.
 *
 * It is safe to re-run: assets already on the destination are skipped, and an
 * interrupted run leaves every un-migrated row still pointing at local disk.
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { LocalStorageProvider } from "../src/lib/storage/local.ts";
import { S3StorageProvider, s3ConfigFromEnv } from "../src/lib/storage/s3.ts";
import { canonicaliseLegacyKey, isLegacyKey } from "../src/lib/storage/keys.ts";
import type { StorageProvider } from "../src/lib/storage/types.ts";

const APPLY = process.argv.includes("--apply");

interface Outcome {
  assetId: string;
  projectId: string;
  fromKey: string;
  toKey: string;
  status: "migrated" | "rekeyed" | "skipped" | "failed";
  detail?: string;
  bytes?: number;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const local = new LocalStorageProvider();
  const s3Config = s3ConfigFromEnv();
  const destination: StorageProvider | undefined = s3Config
    ? new S3StorageProvider(s3Config)
    : undefined;

  const mode = destination ? "migrate" : "rekey";
  console.log(
    destination
      ? `Destination: ${destination.description}`
      : "S3 is not configured — running in re-key mode: legacy local keys are canonicalised in place, nothing is uploaded."
  );
  console.log(APPLY ? "Mode: APPLY (the database will be written)" : "Mode: REPORT ONLY (pass --apply to write)");
  console.log("");

  const assets = await prisma.asset.findMany({
    where: { storageProvider: "LOCAL" },
    select: { id: true, projectId: true, storageKey: true, checksum: true, mimeType: true, fileSize: true },
    orderBy: { createdAt: "asc" },
  });

  if (assets.length === 0) {
    console.log("No assets are on local storage. Nothing to do.");
    await prisma.$disconnect();
    return;
  }
  console.log(`${assets.length} asset(s) on local storage.\n`);

  const outcomes: Outcome[] = [];

  for (const asset of assets) {
    const targetKey = isLegacyKey(asset.storageKey)
      ? canonicaliseLegacyKey(asset.storageKey, asset.projectId)
      : asset.storageKey;

    const base: Outcome = {
      assetId: asset.id,
      projectId: asset.projectId,
      fromKey: asset.storageKey,
      toKey: targetKey,
      status: "skipped",
    };

    // --- read the source ------------------------------------------------
    let body: Buffer;
    try {
      body = await local.get(asset.storageKey);
    } catch (err) {
      outcomes.push({
        ...base,
        status: "failed",
        detail: `local file unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const checksum = sha256(body);

    // A checksum already on the row is a claim about these bytes. If it
    // disagrees, something changed the file underneath us and this is not a
    // migration problem to solve automatically.
    if (asset.checksum && asset.checksum !== checksum) {
      outcomes.push({
        ...base,
        status: "failed",
        detail: `checksum mismatch: row says ${asset.checksum.slice(0, 12)}…, file is ${checksum.slice(0, 12)}…`,
      });
      continue;
    }

    if (!destination) {
      // Re-key mode: canonicalise a legacy local key by copying the object to
      // its new key and verifying, still without deleting the old one.
      if (targetKey === asset.storageKey) {
        outcomes.push({ ...base, status: "skipped", detail: "key is already canonical", bytes: body.byteLength });
        continue;
      }
      if (!APPLY) {
        outcomes.push({ ...base, status: "rekeyed", detail: "would re-key (dry run)", bytes: body.byteLength });
        continue;
      }
      try {
        await local.put(targetKey, body, { contentType: asset.mimeType, size: body.byteLength });
        const readBack = await local.get(targetKey);
        if (sha256(readBack) !== checksum) {
          outcomes.push({ ...base, status: "failed", detail: "re-keyed copy did not verify" });
          continue;
        }
        await prisma.asset.update({
          where: { id: asset.id },
          data: { storageKey: targetKey, checksum },
        });
        outcomes.push({ ...base, status: "rekeyed", bytes: body.byteLength });
      } catch (err) {
        outcomes.push({
          ...base,
          status: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // --- upload + verify ------------------------------------------------
    if (!APPLY) {
      outcomes.push({ ...base, status: "migrated", detail: "would upload (dry run)", bytes: body.byteLength });
      continue;
    }

    try {
      await destination.put(targetKey, body, { contentType: asset.mimeType, size: body.byteLength });

      // Verification is a real read-back, not a trust in the write returning
      // successfully. This is the step that earns the right to change the row.
      const readBack = await destination.get(targetKey);
      if (readBack.byteLength !== body.byteLength || sha256(readBack) !== checksum) {
        outcomes.push({
          ...base,
          status: "failed",
          detail: "uploaded object did not verify — the row was left pointing at local disk",
        });
        continue;
      }

      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          storageProvider: "S3",
          storageKey: targetKey,
          checksum,
          fileSize: body.byteLength,
        },
      });
      outcomes.push({ ...base, status: "migrated", bytes: body.byteLength });
    } catch (err) {
      outcomes.push({
        ...base,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await prisma.$disconnect();
  report(outcomes, mode, destination !== undefined);
}

function report(outcomes: Outcome[], mode: string, hasDestination: boolean): void {
  const by = (status: Outcome["status"]) => outcomes.filter((o) => o.status === status);
  const migrated = by("migrated");
  const rekeyed = by("rekeyed");
  const skipped = by("skipped");
  const failed = by("failed");

  for (const o of outcomes) {
    const marker = { migrated: "→", rekeyed: "↻", skipped: "·", failed: "✗" }[o.status];
    const size = o.bytes !== undefined ? ` (${(o.bytes / 1024).toFixed(0)}KB)` : "";
    console.log(`${marker} ${o.assetId} ${o.fromKey} → ${o.toKey}${size}${o.detail ? `  — ${o.detail}` : ""}`);
  }

  console.log("");
  console.log(`mode:     ${mode}${APPLY ? "" : " (dry run)"}`);
  console.log(`migrated: ${migrated.length}`);
  if (!hasDestination) console.log(`re-keyed: ${rekeyed.length}`);
  console.log(`skipped:  ${skipped.length}`);
  console.log(`failed:   ${failed.length}`);

  const verified = APPLY ? [...migrated, ...rekeyed] : [];
  if (verified.length > 0) {
    console.log("");
    console.log(
      `${verified.length} local file(s) are now redundant. They have NOT been deleted — verify a backup, confirm the application serves these assets from the new location, and remove them by hand:`
    );
    for (const o of verified) console.log(`  storage/uploads/${o.fromKey}`);
  }

  if (failed.length > 0) {
    console.log("");
    console.log("Some assets did not migrate. Their rows still point at local disk and are still being served from there.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
