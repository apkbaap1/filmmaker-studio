import "server-only";

import {
  EXTENSION_BY_MIME,
  listProjectAssets,
  readAssetBytes,
  type AuthorizedAsset,
} from "@/lib/media";
import { buildExportPackage } from "./build.ts";
import { exportCsv } from "./csv.ts";
import { exportPdf } from "./pdf.ts";
import type { ExportPackage } from "./types.ts";
import { zipStream, type ZipEntry } from "./zip.ts";

/**
 * The production bundle: an export that carries the footage, not just pointers
 * to it.
 *
 * The JSON, CSV and PDF exports describe a production. This one *is* the
 * production — a single archive a filmmaker can hand to an editor, archive to a
 * drive, or open in five years, containing the media alongside enough
 * structured data to know what every file is and which decision produced it.
 *
 * ## Package structure
 *
 *   manifest.json            the full export package, plus a bundle section
 *                            recording what happened to every asset
 *   shot-list.csv            the same data as the CSV export
 *   production-report.pdf    the same data as the PDF export
 *   ASSETS.txt               human-readable index: scene → shot → file
 *   README.txt               what this is and how it was produced
 *   assets/<id>.<ext>        one file per asset, named by asset id
 *
 * ### Why assets are flat and named by id
 *
 * An asset can belong to several shots at once — a reference frame reused
 * across a scene, a still that several clips select. A tree of
 * `scene/shot/file` would copy those bytes once per reference, which for video
 * is the difference between a bundle and an unusable one. A flat directory
 * keyed by the asset's own id stores each byte once no matter how many things
 * point at it, and `ASSETS.txt` plus the manifest carry the readable mapping
 * that the directory tree would otherwise have provided.
 *
 * ### Why the manifest comes last in the archive
 *
 * The manifest states which assets were actually included, which is only known
 * after trying to read each one. Writing it first would mean either buffering
 * the entire bundle to find out, or promising inclusions that might not happen.
 * ZIP has no ordering requirement, so the archive streams assets first — one in
 * memory at a time — and the manifest is written once the outcomes are facts.
 */

export const BUNDLE_FORMAT_VERSION = 1;

export type AssetOutcome = "included" | "unavailable" | "too-large";

export interface BundledAsset {
  assetId: string;
  outcome: AssetOutcome;
  /** Where it landed in the archive. Null when it was not included. */
  bundlePath: string | null;
  mimeType: string;
  /** What the database says. Compared against what was actually read. */
  recordedBytes: number;
  /** What was actually read. Null when nothing was. */
  actualBytes: number | null;
  /** Why it is not here. Null when it is. */
  reason: string | null;
}

export interface BundleManifest {
  bundleFormatVersion: number;
  assetsTotal: number;
  assetsIncluded: number;
  assetsMissing: number;
  bytesIncluded: number;
  /**
   * True when every asset the project has is in the archive.
   *
   * A bundle with a missing asset is still produced and still useful — but it
   * says so here and in the README, because an archive that quietly drops
   * footage is worse than one that reports the gap.
   */
  complete: boolean;
  assets: BundledAsset[];
}

export interface BundleFile extends ExportPackage {
  bundle: BundleManifest;
}

export interface BundleOptions {
  /**
   * Skip any single asset larger than this. Absent means no ceiling beyond the
   * ZIP format's own 4 GiB entry limit.
   */
  maxAssetBytes?: number;
  /** Fixed timestamp for the entries, so a test can compare bytes. */
  modifiedAt?: Date;
  /** Injectable for tests; defaults to the real media reader. */
  readBytes?: (asset: AuthorizedAsset) => Promise<Buffer>;
  /** Injectable for tests; defaults to the real asset listing. */
  listAssets?: (projectId: string) => Promise<AuthorizedAsset[]>;
}

/**
 * Picks a file extension from the recorded mime type.
 *
 * The table is the storage layer's own, so a format the application accepts is
 * a format the bundle can name. Falls back to `.bin` rather than guessing from
 * the caption or the storage key: a wrong extension tells an editor's import a
 * confident lie about the contents, where `.bin` merely tells it nothing.
 */
export function extensionFor(mimeType: string): string {
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

export function bundlePathFor(assetId: string, mimeType: string): string {
  return `assets/${assetId}.${extensionFor(mimeType)}`;
}

/**
 * Streams the bundle as ZIP chunks.
 *
 * The caller must already have passed `requireProjectAccess` for this project —
 * this is a whole production in one file, and it is only ever built for someone
 * who can already see all of it.
 */
export async function* bundleStream(
  projectId: string,
  options: BundleOptions = {}
): AsyncGenerator<Buffer> {
  const readBytes = options.readBytes ?? readAssetBytes;
  const listAssets = options.listAssets ?? listProjectAssets;
  const modifiedAt = options.modifiedAt ?? new Date();

  // Built before anything is written: if the project cannot be described, the
  // bundle should fail before a partial archive has been handed to a browser.
  const pkg = await buildExportPackage(projectId);
  const assets = await listAssets(projectId);

  const recorded: BundledAsset[] = [];

  async function* entries(): AsyncGenerator<ZipEntry> {
    for (const asset of assets) {
      const outcome = await bundleOneAsset(asset, readBytes, options.maxAssetBytes);
      recorded.push(outcome.record);
      if (outcome.bytes) {
        yield { path: outcome.record.bundlePath!, bytes: outcome.bytes, modifiedAt };
      }
    }

    // Everything below is derived from outcomes that are now facts.
    const manifest = summarise(recorded);
    const file: BundleFile = { ...pkg, bundle: manifest };

    yield {
      path: "manifest.json",
      bytes: Buffer.from(JSON.stringify(file, null, 2), "utf8"),
      modifiedAt,
    };
    yield {
      path: "shot-list.csv",
      bytes: Buffer.from(`﻿${exportCsv(pkg)}`, "utf8"),
      modifiedAt,
    };
    yield {
      path: "production-report.pdf",
      bytes: Buffer.from(await exportPdf(pkg)),
      modifiedAt,
    };
    yield {
      path: "ASSETS.txt",
      bytes: Buffer.from(assetIndex(pkg, recorded), "utf8"),
      modifiedAt,
    };
    yield {
      path: "README.txt",
      bytes: Buffer.from(readme(pkg, manifest), "utf8"),
      modifiedAt,
    };
  }

  yield* zipStream(entries());
}

/**
 * Reads one asset, and turns any failure into a recorded outcome.
 *
 * A storage read can fail for reasons that have nothing to do with this export
 * — an object deleted out from under the row, a bucket permission changed, a
 * provider outage. None of those should abandon a bundle that is otherwise
 * complete, so the failure becomes a line in the manifest instead of an
 * exception. What it must never become is silence.
 */
async function bundleOneAsset(
  asset: AuthorizedAsset,
  readBytes: (asset: AuthorizedAsset) => Promise<Buffer>,
  maxAssetBytes: number | undefined
): Promise<{ record: BundledAsset; bytes: Buffer | null }> {
  const base: Omit<BundledAsset, "outcome" | "bundlePath" | "actualBytes" | "reason"> = {
    assetId: asset.id,
    mimeType: asset.mimeType,
    recordedBytes: asset.fileSize,
  };

  if (maxAssetBytes !== undefined && asset.fileSize > maxAssetBytes) {
    return {
      record: {
        ...base,
        outcome: "too-large",
        bundlePath: null,
        actualBytes: null,
        reason: `Recorded as ${asset.fileSize} bytes, over this bundle's ${maxAssetBytes}-byte per-asset ceiling. The metadata is still in the manifest; the file itself must be fetched from storage.`,
      },
      bytes: null,
    };
  }

  try {
    const bytes = await readBytes(asset);
    return {
      record: {
        ...base,
        outcome: "included",
        bundlePath: bundlePathFor(asset.id, asset.mimeType),
        actualBytes: bytes.length,
        reason: null,
      },
      bytes,
    };
  } catch (error) {
    return {
      record: {
        ...base,
        outcome: "unavailable",
        bundlePath: null,
        actualBytes: null,
        reason: `Could not be read from storage: ${error instanceof Error ? error.message : String(error)}`,
      },
      bytes: null,
    };
  }
}

function summarise(assets: BundledAsset[]): BundleManifest {
  const included = assets.filter((a) => a.outcome === "included");
  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    assetsTotal: assets.length,
    assetsIncluded: included.length,
    assetsMissing: assets.length - included.length,
    bytesIncluded: included.reduce((sum, a) => sum + (a.actualBytes ?? 0), 0),
    complete: included.length === assets.length,
    assets,
  };
}

// --- the human-readable half -------------------------------------------------

/**
 * scene → shot → file, for someone who opened the archive rather than parsed it.
 *
 * An asset referenced by several shots appears under each of them, pointing at
 * the one copy — which is the mapping the flat `assets/` directory gives up in
 * exchange for storing those bytes once.
 */
function assetIndex(pkg: ExportPackage, recorded: BundledAsset[]): string {
  const byId = new Map(recorded.map((r) => [r.assetId, r]));
  const lines: string[] = [`${pkg.project.title} — asset index`, ""];

  for (const scene of pkg.scenes) {
    lines.push(`SCENE ${scene.number} — ${scene.slugline}`);
    for (const shot of scene.shots) {
      lines.push(`  SHOT ${shot.shotNumber}`);
      if (shot.assets.length === 0) {
        lines.push("    (no assets)");
        continue;
      }
      for (const asset of shot.assets) {
        const record = byId.get(asset.id);
        const where = record?.bundlePath ?? `NOT IN BUNDLE — ${record?.reason ?? "unknown"}`;
        const caption = asset.caption ? ` — ${asset.caption}` : "";
        lines.push(`    ${asset.type}: ${where}${caption}`);
      }
    }
    lines.push("");
  }

  // Sound placed on a track, so an editor opening the archive can find the
  // score without reading the manifest. Audio is not attached to a shot, so
  // without this it would only ever appear in the orphan list below.
  const placedAudio = new Set<string>();
  for (const track of pkg.timeline?.audioTracks ?? []) {
    lines.push(`AUDIO TRACK — ${track.name} (${track.role.toLowerCase()})${track.muted ? " — MUTED" : ""}`);
    if (track.clips.length === 0) lines.push("    (no placements)");
    for (const placement of track.clips) {
      placedAudio.add(placement.assetId);
      const record = byId.get(placement.assetId);
      const where = record?.bundlePath ?? `NOT IN BUNDLE — ${record?.reason ?? "unknown"}`;
      const at =
        placement.endSeconds === null
          ? `${placement.startSeconds}s–? (length not measured)`
          : `${placement.startSeconds}s–${placement.endSeconds}s`;
      lines.push(`    ${at}: ${where}${placement.caption ? ` — ${placement.caption}` : ""}`);
    }
    lines.push("");
  }

  const orphans = recorded.filter(
    (r) =>
      !placedAudio.has(r.assetId) &&
      !pkg.scenes.some((s) => s.shots.some((sh) => sh.assets.some((a) => a.id === r.assetId)))
  );
  if (orphans.length > 0) {
    lines.push("PROJECT-LEVEL ASSETS (not attached to a shot)");
    for (const orphan of orphans) {
      lines.push(`  ${orphan.bundlePath ?? `NOT IN BUNDLE — ${orphan.reason}`}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function readme(pkg: ExportPackage, manifest: BundleManifest): string {
  const completeness = manifest.complete
    ? `All ${manifest.assetsTotal} assets are included.`
    : `${manifest.assetsIncluded} of ${manifest.assetsTotal} assets are included. ` +
      `${manifest.assetsMissing} could not be added — manifest.json says which and why, ` +
      `under "bundle". Their metadata is still present; only the files are missing.`;

  return `${pkg.project.title} — production bundle
Generated ${pkg.generatedAt}

WHAT THIS IS
  A complete export of this production: the structured filmmaking data, the
  prompts and generations that produced the media, the edit, and the media
  files themselves.

CONTENTS
  manifest.json          Everything, as structured data. The "bundle" section
                         records what happened to every asset.
  shot-list.csv          The shot list, for a spreadsheet.
  production-report.pdf  A readable report.
  ASSETS.txt             scene -> shot -> file, for finding things by hand.
  assets/                The media, sound included. One file per asset, named
                         by its id.

ASSETS
  ${completeness}

  Files are named by asset id rather than by scene and shot, because one asset
  can belong to several shots and naming by position would store those bytes
  once per reference. ASSETS.txt and manifest.json carry the mapping.

HOW THE MEDIA WAS PRODUCED
  ${pkg.providerTransparency.note}

  Image provider: ${pkg.providerTransparency.imageProvider.label} (${pkg.providerTransparency.imageProvider.model})
  Video provider: ${
    pkg.providerTransparency.videoProvider
      ? `${pkg.providerTransparency.videoProvider.label} (${pkg.providerTransparency.videoProvider.model})${
          pkg.providerTransparency.videoProvider.isStub ? " — STUB, not AI-generated media" : ""
        }`
      : "none configured"
  }

  No credentials are in this bundle. Provider and model identifiers are part of
  the production record; API keys never pass through the export layer.
`;
}
