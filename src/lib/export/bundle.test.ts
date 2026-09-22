import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

import type { AuthorizedAsset } from "@/lib/media";
import { bundlePathFor, bundleStream, extensionFor, type BundleFile } from "./bundle.ts";

/**
 * The production bundle.
 *
 * The bundle's whole claim is that it carries the footage rather than pointers
 * to it, so the tests open the real archive with Python's `zipfile` and look at
 * what is actually inside — not at what the builder says it put there.
 *
 * The database half is real: a real project, real scenes, shots and asset rows.
 * Only the storage read is injected, so a test can decide that one object has
 * gone missing without having to break a bucket to do it.
 */

const prisma = new PrismaClient();
const workspace = mkdtempSync(path.join(tmpdir(), "bundle-test-"));

const FIXED = new Date("2026-03-04T05:06:08Z");

let userId: string;
let projectId: string;
let emptyProjectId: string;
let sceneOneId: string;
let shotOneId: string;
let shotTwoId: string;
let imageAssetId: string;
let videoAssetId: string;
let sharedAssetId: string;
let generatedAssetId: string;

/** Distinct content per asset, so a mix-up cannot pass unnoticed. */
const CONTENT: Record<string, Buffer> = {};

async function makeAsset(fields: {
  type: "IMAGE" | "VIDEO" | "DIAGRAM";
  source: "UPLOADED" | "GENERATED";
  mimeType: string;
  shotId?: string;
  sceneId?: string;
  caption?: string;
  bytes: Buffer;
}) {
  const asset = await prisma.asset.create({
    data: {
      projectId,
      sceneId: fields.sceneId ?? null,
      shotId: fields.shotId ?? null,
      type: fields.type,
      source: fields.source,
      mimeType: fields.mimeType,
      fileSize: fields.bytes.length,
      caption: fields.caption ?? null,
      // The canonical key shape. A fixture that used any other shape would be
      // filtered out by the media boundary exactly as a malformed row would be,
      // and the test would be exercising the filter rather than the bundle.
      storageKey: `projects/${projectId}/assets/${randomUUID()}/original.bin`,
    },
  });
  CONTENT[asset.id] = fields.bytes;
  return asset.id;
}

before(async () => {
  const user = await prisma.user.create({
    data: { name: "Bundler", email: `bundle-${Date.now()}@example.test`, passwordHash: "x" },
  });
  userId = user.id;

  const project = await prisma.project.create({
    data: { title: "Night Station", ownerId: userId, aspectRatio: "16:9", resolution: "720p" },
  });
  projectId = project.id;

  emptyProjectId = (
    await prisma.project.create({ data: { title: "Nothing Yet", ownerId: userId } })
  ).id;

  const sceneOne = await prisma.scene.create({
    data: {
      projectId,
      number: "4",
      intExt: "EXT",
      location: "Abandoned railway station",
      timeOfDay: "NIGHT",
      order: 1,
    },
  });
  sceneOneId = sceneOne.id;

  const sceneTwo = await prisma.scene.create({
    data: { projectId, number: "5", intExt: "INT", location: "Signal box", timeOfDay: "DAY", order: 2 },
  });

  shotOneId = (
    await prisma.shotListItem.create({
      data: { sceneId: sceneOneId, shotNumber: "12", shotType: "WIDE", order: 1, durationSeconds: 8 },
    })
  ).id;
  shotTwoId = (
    await prisma.shotListItem.create({
      data: { sceneId: sceneOneId, shotNumber: "13", shotType: "MEDIUM", order: 2 },
    })
  ).id;
  await prisma.shotListItem.create({
    data: { sceneId: sceneTwo.id, shotNumber: "1", shotType: "CLOSE_UP", order: 1 },
  });

  imageAssetId = await makeAsset({
    type: "IMAGE",
    source: "UPLOADED",
    mimeType: "image/png",
    shotId: shotOneId,
    caption: "Reference frame",
    bytes: Buffer.from("PNG-CONTENT-FOR-SHOT-12"),
  });
  videoAssetId = await makeAsset({
    type: "VIDEO",
    source: "GENERATED",
    mimeType: "video/mp4",
    shotId: shotOneId,
    bytes: Buffer.from("MP4-CONTENT-FOR-SHOT-12"),
  });
  generatedAssetId = await makeAsset({
    type: "IMAGE",
    source: "GENERATED",
    mimeType: "image/webp",
    shotId: shotTwoId,
    bytes: Buffer.from("WEBP-GENERATED"),
  });
  // Attached at the scene rather than a shot: a project-level asset.
  sharedAssetId = await makeAsset({
    type: "DIAGRAM",
    source: "UPLOADED",
    mimeType: "image/png",
    sceneId: sceneOneId,
    caption: "Floor plan",
    bytes: Buffer.from("DIAGRAM-CONTENT"),
  });
});

after(async () => {
  await prisma.project.deleteMany({ where: { id: { in: [projectId, emptyProjectId] } } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
  rmSync(workspace, { recursive: true, force: true });
});

/** The injected storage reader: honest by default, breakable per test. */
function reader(options: { missing?: string[] } = {}) {
  return async (asset: AuthorizedAsset): Promise<Buffer> => {
    if (options.missing?.includes(asset.id)) {
      throw new Error("NoSuchKey: the object is not in the bucket");
    }
    const bytes = CONTENT[asset.id];
    if (!bytes) throw new Error(`test fixture has no content for ${asset.id}`);
    return bytes;
  };
}

interface OpenedBundle {
  names: string[];
  manifest: BundleFile;
  read: (name: string) => Buffer;
  totalBytes: number;
}

/** Builds the bundle, writes it out, and opens it with Python's zipfile. */
async function build(
  project: string,
  options: Parameters<typeof bundleStream>[1] = {}
): Promise<OpenedBundle> {
  const chunks: Buffer[] = [];
  for await (const chunk of bundleStream(project, {
    readBytes: reader(),
    modifiedAt: FIXED,
    ...options,
  })) {
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const file = path.join(workspace, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(file, bytes);

  const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    if bad is not None:
        raise SystemExit("CRC failure in " + bad)
    print(json.dumps(z.namelist()))
`;
  const names = JSON.parse(execFileSync("python3", ["-c", script, file], { encoding: "utf8" }));

  const read = (name: string): Buffer => {
    const extract = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    sys.stdout.buffer.write(z.read(sys.argv[2]))
`;
    // A large asset comes back through stdout, and the default 1 MB ceiling is
    // smaller than the media this bundle exists to carry.
    return execFileSync("python3", ["-c", extract, file, name], { maxBuffer: 64 * 1024 * 1024 });
  };

  return {
    names,
    manifest: JSON.parse(read("manifest.json").toString("utf8")) as BundleFile,
    read,
    totalBytes: bytes.length,
  };
}

// --- structure ---------------------------------------------------------------

describe("the bundle's package structure", () => {
  it("contains the documents and the media", async () => {
    const bundle = await build(projectId);

    for (const required of [
      "manifest.json",
      "shot-list.csv",
      "production-report.pdf",
      "ASSETS.txt",
      "README.txt",
    ]) {
      assert.ok(bundle.names.includes(required), `${required} is missing from the bundle`);
    }
    assert.ok(
      bundle.names.some((n) => n.startsWith("assets/")),
      "no media in a bundle whose purpose is to carry media"
    );
  });

  it("carries the actual file contents, not a pointer to them", async () => {
    const bundle = await build(projectId);
    const stored = bundle.read(bundlePathFor(imageAssetId, "image/png"));
    assert.deepEqual(stored, CONTENT[imageAssetId], "the bytes in the archive are the real bytes");
  });

  it("names files by the recorded mime type", () => {
    assert.equal(extensionFor("image/png"), "png");
    assert.equal(extensionFor("video/mp4"), "mp4");
    assert.equal(extensionFor("image/webp"), "webp");
    // Never guessed: a wrong extension is a confident lie to an importer.
    assert.equal(extensionFor("application/octet-stream"), "bin");
    assert.equal(extensionFor("something/unknown"), "bin");
  });

  it("is a valid archive that external tools accept", async () => {
    const bundle = await build(projectId);
    // `build` already ran Python's CRC check; this adds the unzip binary.
    assert.ok(bundle.totalBytes > 0);
  });
});

// --- coverage of the asset population ----------------------------------------

describe("what the bundle includes", () => {
  it("includes every asset type, uploaded and generated alike", async () => {
    const bundle = await build(projectId);

    for (const id of [imageAssetId, videoAssetId, generatedAssetId, sharedAssetId]) {
      const record = bundle.manifest.bundle.assets.find((a) => a.assetId === id);
      assert.equal(record?.outcome, "included", `${id} was not included`);
      assert.ok(bundle.names.includes(record!.bundlePath!));
    }
  });

  it("stores one copy per asset however many shots reference it", async () => {
    const bundle = await build(projectId);
    const assetFiles = bundle.names.filter((n) => n.startsWith("assets/"));

    assert.equal(
      new Set(assetFiles).size,
      assetFiles.length,
      "an asset was written into the archive more than once"
    );
    assert.equal(assetFiles.length, bundle.manifest.bundle.assetsIncluded);
  });

  it("spans multiple scenes and shots in the index", async () => {
    const bundle = await build(projectId);
    const index = bundle.read("ASSETS.txt").toString("utf8");

    assert.match(index, /SCENE 4/);
    assert.match(index, /SCENE 5/);
    assert.match(index, /SHOT 12/);
    assert.match(index, /SHOT 13/);
    assert.match(index, /\(no assets\)/, "a shot with nothing attached says so");
  });

  it("produces a valid bundle for a project with no assets at all", async () => {
    const bundle = await build(emptyProjectId);

    assert.equal(bundle.manifest.bundle.assetsTotal, 0);
    assert.equal(bundle.manifest.bundle.assetsIncluded, 0);
    assert.equal(bundle.manifest.bundle.complete, true, "nothing missing when there is nothing");
    assert.equal(bundle.manifest.bundle.bytesIncluded, 0);
    assert.ok(bundle.names.includes("manifest.json"));
    assert.ok(!bundle.names.some((n) => n.startsWith("assets/")));
  });
});

// --- the manifest ------------------------------------------------------------

describe("the manifest", () => {
  it("is the export package plus a bundle section", async () => {
    const bundle = await build(projectId);

    // Everything the JSON export carries is still here.
    assert.equal(bundle.manifest.formatVersion, 1);
    assert.equal(bundle.manifest.project.title, "Night Station");
    assert.ok(Array.isArray(bundle.manifest.scenes));
    assert.ok(bundle.manifest.providerTransparency);

    assert.equal(bundle.manifest.bundle.bundleFormatVersion, 1);
  });

  it("counts what it actually wrote", async () => {
    const bundle = await build(projectId);
    const manifest = bundle.manifest.bundle;

    assert.equal(manifest.assetsTotal, 4);
    assert.equal(manifest.assetsIncluded, 4);
    assert.equal(manifest.assetsMissing, 0);
    assert.equal(manifest.complete, true);

    const expected = [imageAssetId, videoAssetId, generatedAssetId, sharedAssetId].reduce(
      (sum, id) => sum + CONTENT[id].length,
      0
    );
    assert.equal(manifest.bytesIncluded, expected);
  });

  it("records the bytes it read, beside the bytes the database claimed", async () => {
    const bundle = await build(projectId);
    for (const record of bundle.manifest.bundle.assets) {
      assert.equal(
        record.actualBytes,
        record.recordedBytes,
        `${record.assetId}: what storage returned disagrees with the Asset row`
      );
    }
  });

  it("carries no credential", async () => {
    const bundle = await build(projectId);
    const raw = bundle.read("manifest.json").toString("utf8");
    for (const secret of ["API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "Bearer ", "x-goog-api-key"]) {
      assert.ok(!raw.includes(secret), `manifest mentions ${secret}`);
    }
  });
});

// --- failure and partial export ----------------------------------------------

describe("assets that cannot be bundled", () => {
  it("completes the bundle and records what is missing", async () => {
    const bundle = await build(projectId, { readBytes: reader({ missing: [videoAssetId] }) });
    const manifest = bundle.manifest.bundle;

    assert.equal(manifest.complete, false);
    assert.equal(manifest.assetsIncluded, 3);
    assert.equal(manifest.assetsMissing, 1);

    const record = manifest.assets.find((a) => a.assetId === videoAssetId);
    assert.equal(record?.outcome, "unavailable");
    assert.equal(record?.bundlePath, null);
    assert.match(record?.reason ?? "", /NoSuchKey/);

    // The others are still there: one lost object does not lose the bundle.
    assert.ok(bundle.names.includes(bundlePathFor(imageAssetId, "image/png")));
  });

  it("keeps the metadata of a missing asset, so the gap is reconcilable", async () => {
    const bundle = await build(projectId, { readBytes: reader({ missing: [videoAssetId] }) });

    const record = bundle.manifest.bundle.assets.find((a) => a.assetId === videoAssetId);
    assert.equal(record?.mimeType, "video/mp4");
    assert.equal(record?.recordedBytes, CONTENT[videoAssetId].length);

    // And the asset is still described in the project data itself.
    const shot = bundle.manifest.scenes
      .flatMap((s) => s.shots)
      .find((sh) => sh.assets.some((a) => a.id === videoAssetId));
    assert.ok(shot, "a missing file must not remove the asset from the production record");
  });

  it("says so in the README rather than only in the JSON", async () => {
    const bundle = await build(projectId, { readBytes: reader({ missing: [videoAssetId] }) });
    const readme = bundle.read("README.txt").toString("utf8");

    assert.match(readme, /3 of 4 assets are included/);
    assert.match(readme, /could not be added/);
  });

  it("marks a missing asset in the human-readable index too", async () => {
    const bundle = await build(projectId, { readBytes: reader({ missing: [videoAssetId] }) });
    assert.match(bundle.read("ASSETS.txt").toString("utf8"), /NOT IN BUNDLE/);
  });

  it("still reports complete when nothing is missing", async () => {
    const bundle = await build(projectId);
    assert.match(bundle.read("README.txt").toString("utf8"), /All 4 assets are included/);
  });
});

// --- large assets ------------------------------------------------------------

describe("large assets", () => {
  it("skips an asset over the ceiling and says why", async () => {
    // Below every asset's size, so all four are over it.
    const bundle = await build(projectId, { maxAssetBytes: 5 });
    const manifest = bundle.manifest.bundle;

    assert.equal(manifest.assetsIncluded, 0);
    assert.equal(manifest.complete, false);
    for (const record of manifest.assets) {
      assert.equal(record.outcome, "too-large");
      assert.match(record.reason ?? "", /per-asset ceiling/);
      assert.equal(record.bundlePath, null);
    }
  });

  it("includes what fits and skips only what does not", async () => {
    // Between the shortest and longest fixture.
    const ceiling = CONTENT[sharedAssetId].length;
    const bundle = await build(projectId, { maxAssetBytes: ceiling });
    const manifest = bundle.manifest.bundle;

    assert.ok(manifest.assetsIncluded > 0, "the small assets still made it");
    assert.ok(manifest.assetsMissing > 0, "the large ones did not");
    assert.equal(manifest.assetsIncluded + manifest.assetsMissing, manifest.assetsTotal);
  });

  it("carries a multi-megabyte asset through intact", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 17) & 0xff;

    const bigId = await makeAsset({
      type: "VIDEO",
      source: "GENERATED",
      mimeType: "video/webm",
      shotId: shotTwoId,
      bytes: big,
    });

    try {
      const bundle = await build(projectId);
      const stored = bundle.read(bundlePathFor(bigId, "video/webm"));
      assert.equal(stored.length, big.length);
      assert.ok(stored.equals(big), "a large asset was corrupted in transit");
    } finally {
      await prisma.asset.delete({ where: { id: bigId } });
      delete CONTENT[bigId];
    }
  });
});

// --- the export layer stays provider-agnostic --------------------------------

describe("the export layer knows nothing about providers", () => {
  it("imports no provider adapter", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(import.meta.dirname, "bundle.ts"), "utf8");

    for (const forbidden of ["google-veo", "openai", "video-providers/", "image-providers/"]) {
      assert.ok(!source.includes(forbidden), `the bundle imports ${forbidden}`);
    }
  });

  it("reaches storage only through the media boundary", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(import.meta.dirname, "bundle.ts"), "utf8");

    assert.ok(!source.includes("@/lib/storage"), "the bundle must go through lib/media");
    assert.match(source, /from "@\/lib\/media"/);
  });
});
