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
let musicAssetId: string;
let sequenceId: string;

/** Distinct content per asset, so a mix-up cannot pass unnoticed. */
const CONTENT: Record<string, Buffer> = {};

async function makeAsset(fields: {
  type: "IMAGE" | "VIDEO" | "DIAGRAM" | "AUDIO";
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
  // Measured at 12s while the clip below uses only 8 of them, so there are 4
  // seconds of tail handle for an L-cut to carry into.
  await prisma.asset.update({ where: { id: videoAssetId }, data: { durationSeconds: 12 } });
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

  // Sound belongs to the production rather than to any one shot, so it hangs
  // off neither a scene nor a shot.
  musicAssetId = await makeAsset({
    type: "AUDIO",
    source: "UPLOADED",
    mimeType: "audio/mpeg",
    caption: "Main theme",
    bytes: Buffer.from("MP3-CONTENT-MAIN-THEME"),
  });
  await prisma.asset.update({
    where: { id: musicAssetId },
    data: { durationSeconds: 30 },
  });

  const sequence = await prisma.sequence.create({
    data: { projectId, name: "Main edit", order: 0 },
  });
  sequenceId = sequence.id;
  await prisma.timelineClip.create({
    data: {
      sequenceId,
      shotId: shotOneId,
      order: 0,
      selectedAssetId: videoAssetId,
      outPointSeconds: 8,
    },
  });
  await prisma.timelineClip.create({
    data: {
      sequenceId,
      shotId: shotTwoId,
      order: 1,
      transition: "L_CUT",
      transitionDurationSeconds: 1,
      audioMuted: true,
    },
  });

  const track = await prisma.audioTrack.create({
    data: { sequenceId, name: "Score", role: "MUSIC", order: 0, gainDb: -6 },
  });
  await prisma.audioClip.create({
    data: {
      trackId: track.id,
      assetId: musicAssetId,
      startSeconds: 2,
      fadeInSeconds: 1,
    },
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

    assert.equal(manifest.assetsTotal, 5);
    assert.equal(manifest.assetsIncluded, 5);
    assert.equal(manifest.assetsMissing, 0);
    assert.equal(manifest.complete, true);

    const expected = [
      imageAssetId,
      videoAssetId,
      generatedAssetId,
      sharedAssetId,
      musicAssetId,
    ].reduce(
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
    assert.equal(manifest.assetsIncluded, 4);
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

    assert.match(readme, /4 of 5 assets are included/);
    assert.match(readme, /could not be added/);
  });

  it("marks a missing asset in the human-readable index too", async () => {
    const bundle = await build(projectId, { readBytes: reader({ missing: [videoAssetId] }) });
    assert.match(bundle.read("ASSETS.txt").toString("utf8"), /NOT IN BUNDLE/);
  });

  it("still reports complete when nothing is missing", async () => {
    const bundle = await build(projectId);
    assert.match(bundle.read("README.txt").toString("utf8"), /All 5 assets are included/);
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

describe("sound in the bundle", () => {
  it("carries the audio file itself, not a reference to it", async () => {
    const bundle = await build(projectId);
    const at = bundlePathFor(musicAssetId, "audio/mpeg");

    assert.ok(bundle.names.includes(at), `expected ${at} in ${bundle.names.join(", ")}`);
    assert.equal(bundle.read(at).toString(), "MP3-CONTENT-MAIN-THEME");
  });

  it("gives an audio file the extension its format actually uses", () => {
    assert.equal(extensionFor("audio/mpeg"), "mp3");
    assert.equal(extensionFor("audio/wav"), "wav");
    assert.equal(extensionFor("audio/ogg"), "ogg");
    // Still no guessing for a format the application does not accept.
    assert.equal(extensionFor("audio/x-aiff"), "bin");
  });

  it("records the track and where its placement sits", async () => {
    const bundle = await build(projectId);
    const tracks = bundle.manifest.timeline?.audioTracks ?? [];

    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].name, "Score");
    assert.equal(tracks[0].role, "MUSIC");
    assert.equal(tracks[0].gainDb, -6);
    assert.equal(tracks[0].clips.length, 1);
    assert.equal(tracks[0].clips[0].startSeconds, 2);
    assert.equal(tracks[0].clips[0].endSeconds, 32, "a measured 30s file placed at 2s");
    assert.equal(tracks[0].clips[0].lengthMeasured, true);
    assert.equal(tracks[0].clips[0].fadeInSeconds, 1);
    assert.equal(tracks[0].clips[0].fadeOutSeconds, null, "no ramp was asked for");
  });

  it("reports a runtime that counts the sound, not just the cut", async () => {
    const bundle = await build(projectId);
    const timeline = bundle.manifest.timeline;
    assert.ok(timeline);

    // Two shots: one 8s, one with no stated duration (the 4s placeholder).
    assert.equal(timeline.runtime.pictureSeconds, timeline.totalSeconds);
    // The score runs to 32s, past the last frame.
    assert.equal(timeline.runtime.audioSeconds, 32);
    assert.equal(timeline.runtime.totalSeconds, 32);
    assert.ok(
      timeline.runtime.totalSeconds > timeline.runtime.pictureSeconds,
      "the mix outlasts the cut, and the export says both"
    );
  });

  it("names the track in ASSETS.txt so the score is findable by hand", async () => {
    const bundle = await build(projectId);
    const index = bundle.read("ASSETS.txt").toString();

    assert.match(index, /AUDIO TRACK — Score \(music\)/);
    assert.match(index, new RegExp(bundlePathFor(musicAssetId, "audio/mpeg")));
    assert.match(index, /2s–32s/);
    // Listed under its track rather than dumped in the orphan list, which is
    // where an asset attached to no shot would otherwise land.
    const orphanSection = index.slice(index.indexOf("PROJECT-LEVEL ASSETS"));
    assert.ok(
      orphanSection === "" || !orphanSection.includes(bundlePathFor(musicAssetId, "audio/mpeg")),
      "the score is a placement, not an orphan"
    );
  });

  it("records a clip played silent, and where an L-cut put the sound", async () => {
    const bundle = await build(projectId);
    const clips = bundle.manifest.timeline?.clips ?? [];

    const muted = clips.find((c) => c.audioMuted);
    assert.ok(muted, "the second clip is muted in this edit");
    assert.equal(muted.audio?.silent, true);
    assert.equal(muted.audio?.silentReason, "muted");

    // The L-cut sits at the second clip's head, so it is the *first* clip's
    // sound that runs past its picture.
    const first = clips.find((c) => !c.audioMuted);
    assert.ok(first);
    assert.ok(
      first.audio && first.audio.endSeconds > first.endSeconds,
      "the first clip's sound carries past its last frame"
    );
  });

  it("still puts no credentials in a manifest that now carries a mix", async () => {
    const bundle = await build(projectId);
    const text = JSON.stringify(bundle.manifest);
    for (const secret of ["sk-", "AKIA", "api_key", "apiKey", "Authorization", "secret"]) {
      assert.ok(!text.includes(secret), `manifest must not contain ${secret}`);
    }
  });
});
