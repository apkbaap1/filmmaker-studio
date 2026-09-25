import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { listProviders } from "../prompt/index.ts";
import { listVideoProviders } from "../ai/video-providers/index.ts";
import { listImageProviders } from "../ai/image-providers/index.ts";

/**
 * Phase 10 — the standing rule that no provider is claimed without an adapter.
 *
 * The app names real commercial platforms in its documentation and in the UI's
 * explanation of what is *not* implemented. That is fine; presenting one as
 * available when no adapter exists is not. These tests draw that line
 * mechanically rather than trusting a careful reading.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..");

/**
 * Platforms with no adapter. Naming one is fine; presenting it as available is
 * not, so every mention must sit next to wording that says it is unimplemented.
 */
const UNIMPLEMENTED = ["seedance", "higgsfield", "runway", "luma", "pika", "sora", "kling"];

/**
 * Platforms that now have a real adapter, and the file that implements each.
 *
 * Moving a name here is not a way to silence the rule above: the test below
 * requires the adapter file to exist *and* to be registered in the provider
 * registry, so a name can only be moved once the code genuinely backs it.
 */
const IMPLEMENTED: Array<{
  name: string;
  file: string;
  providerId: string;
  kind: "image" | "video";
}> = [
  {
    name: "veo",
    file: "lib/ai/video-providers/google-veo.ts",
    providerId: "google-veo",
    kind: "video",
  },
  {
    name: "gemini",
    file: "lib/ai/image-providers/gemini-image.ts",
    providerId: "google-gemini-image",
    kind: "image",
  },
];

/** Which registry an entry has to appear in — video is no longer the only one. */
const REGISTRIES = {
  image: () => listImageProviders().map((p) => p.id),
  video: () => listVideoProviders().map((p) => p.id),
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no provider is claimed without an adapter", () => {
  it("registers only prompt adapters that actually exist as files", () => {
    const registered = listProviders().map((p) => p.id);
    assert.deepEqual(registered, ["generic"], "only the generic adapter is implemented");

    const files = readdirSync(path.join(SRC, "lib/prompt/providers"))
      .filter((f) => f.endsWith(".ts") && !["index.ts", "types.ts"].includes(f))
      .map((f) => f.replace(/\.ts$/, ""));
    assert.deepEqual(files.sort(), ["generic"]);
  });

  it("registers only image and video adapters that exist as files", () => {
    for (const dir of ["lib/ai/image-providers", "lib/ai/video-providers"]) {
      const files = readdirSync(path.join(SRC, dir)).filter(
        (f) => f.endsWith(".ts") && !["index.ts", "types.ts", "stub-clip.ts"].includes(f)
      );
      assert.ok(files.length > 0, `${dir} has at least one adapter`);
      for (const name of UNIMPLEMENTED) {
        assert.ok(
          !files.some((f) => f.toLowerCase().includes(name)),
          `${dir} must not contain a ${name} adapter file that nothing registers`
        );
      }
    }
  });

  it("backs every implemented platform with a registered adapter", () => {
    for (const { name, file, providerId, kind } of IMPLEMENTED) {
      assert.ok(
        statSync(path.join(SRC, file)).isFile(),
        `${name} is listed as implemented but ${file} does not exist`
      );
      const registered = REGISTRIES[kind]();
      assert.ok(
        registered.includes(providerId),
        `${name} has an adapter file but "${providerId}" is not registered: ${registered.join(", ")}`
      );
      assert.ok(
        !UNIMPLEMENTED.includes(name),
        `${name} cannot be both implemented and unimplemented`
      );
    }
  });

  it("never presents an unimplemented platform as available", () => {
    // Every mention must sit next to wording that says it is NOT implemented.
    const NEGATIONS = ["no ", "not ", "none", "until then", "once you", "adding", "choose", "chosen", "later"];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const name of UNIMPLEMENTED) {
        const pattern = new RegExp(`.{0,220}${name}.{0,120}`, "gi");
        for (const match of text.match(pattern) ?? []) {
          const context = match.toLowerCase();
          assert.ok(
            NEGATIONS.some((n) => context.includes(n)),
            `${path.relative(SRC, file)} mentions ${name} without saying it is unimplemented:\n${match.trim()}`
          );
        }
      }
    }
  });

  it("says outright that a stub is a stub", () => {
    const stub = readFileSync(path.join(SRC, "lib/ai/video-providers/local-stub.ts"), "utf8");
    assert.ok(/NOT a simulation|stand-in|placeholder/i.test(stub));
    const build = readFileSync(path.join(SRC, "lib/export/build.ts"), "utf8");
    assert.ok(
      build.includes("NOT AI-generated media"),
      "the export's transparency note must name stub output for what it is"
    );
  });
});

describe("Prompt Studio adds no source of truth", () => {
  const studioFiles = sourceFiles(path.join(SRC, "app/projects/[projectId]/studio"));

  it("has files to check", () => {
    assert.ok(studioFiles.length >= 4);
  });

  it("imports no action that writes a Shot, Scene, blocking or timeline", () => {
    // The Studio may save a prompt version and record a continuity decision.
    // Everything else about the filmmaking data is read-only from here.
    const ALLOWED = ["prompt-versions", "continuity"];
    for (const file of studioFiles) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/@\/lib\/actions\/([\w-]+)/g)) {
        assert.ok(
          ALLOWED.includes(match[1]),
          `${path.relative(SRC, file)} imports actions/${match[1]}; the Studio must not write filmmaking data`
        );
      }
    }
  });

  it("reads prompts from the compiler rather than storing its own copy", () => {
    const page = readFileSync(
      path.join(SRC, "app/projects/[projectId]/studio/[shotId]/page.tsx"),
      "utf8"
    );
    for (const compilerEntry of ["generateImagePrompt", "generateVideoPrompt", "generateImageToVideoPrompt", "compileSpec"]) {
      assert.ok(page.includes(compilerEntry), `the Studio compiles via ${compilerEntry}`);
    }
  });

  it("keeps the three layers separate in what it hands the UI", () => {
    const page = readFileSync(
      path.join(SRC, "app/projects/[projectId]/studio/[shotId]/page.tsx"),
      "utf8"
    );
    // Layer 1 overview, Layer 2 specs, Layer 3 rendered prompts + per-adapter.
    for (const prop of ["overview=", "specs=", "prompts=", "providerOutputs="]) {
      assert.ok(page.includes(prop), `the Studio passes ${prop} as its own layer`);
    }
  });
});

describe("export code touches no credential", () => {
  it("reads no API key anywhere in the export path", () => {
    for (const file of sourceFiles(path.join(SRC, "lib/export"))) {
      const text = readFileSync(file, "utf8");
      assert.ok(
        !/process\.env\.\w*(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/.test(text),
        `${path.relative(SRC, file)} must not read a credential`
      );
    }
  });

  it("exports the provider's identity, never its credentials", () => {
    const types = readFileSync(path.join(SRC, "lib/export/types.ts"), "utf8");
    assert.ok(types.includes("credentials are not"), "the contract is stated in the type file");
    // Strip the doc comment that states the rule, then check the shape itself.
    const shapeOnly = types.replace(/\/\*\*[\s\S]*?\*\//g, "");
    for (const field of ["apiKey", "secret", "token", "password"]) {
      assert.ok(
        !new RegExp(`\\b${field}\\b`, "i").test(shapeOnly),
        `the export shape must have no ${field} field`
      );
    }
  });
});
