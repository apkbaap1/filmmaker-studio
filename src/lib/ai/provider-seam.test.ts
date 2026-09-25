import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { listImageProviders } from "./image-providers/index.ts";
import { listVideoProviders } from "./video-providers/index.ts";
import { listProviders } from "../prompt/index.ts";

/**
 * The seam between the filmmaking model and the platforms that render it.
 *
 * The claim the whole prompt-compiler design rests on is that one
 * provider-independent CinematicPromptSpec renders to many providers, and that
 * adding one touches nothing outside its own adapter file and the registry.
 * With a single real provider of each kind, that claim had never been tested —
 * every seam had only ever had to satisfy one implementation, which is the
 * condition under which an abstraction looks right and is not.
 *
 * Adding a second real image provider tested it. These are the results, kept as
 * a standing guard rather than a one-off report: each is a property that held,
 * and would stop holding quietly if someone reached across the seam.
 */

const AI = path.resolve(import.meta.dirname);
const SRC = path.resolve(AI, "..", "..");

function adapterFiles(dir: string): string[] {
  return readdirSync(path.join(AI, dir))
    .filter((f) => f.endsWith(".ts") && !["index.ts", "types.ts"].includes(f))
    .map((f) => path.join(AI, dir, f));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the model knows nothing about any provider", () => {
  it("keeps every provider's name out of the filmmaking layer", () => {
    // If the compiler, the IR or the schema had to learn a vendor's name, the
    // "provider-independent specification" would be a fiction.
    const VENDORS = ["openai", "gpt-image", "gemini", "veo", "google-api", "x-goog"];
    const LAYERS = [
      path.join(SRC, "lib/prompt/compiler.ts"),
      path.join(SRC, "lib/prompt/types.ts"),
      path.join(SRC, "lib/prompt/render.ts"),
      path.join(SRC, "lib/prompt/context.ts"),
      path.join(SRC, "lib/blocking.ts"),
      path.join(SRC, "lib/timeline.ts"),
      path.join(SRC, "lib/audio.ts"),
    ];

    for (const file of LAYERS) {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const vendor of VENDORS) {
        assert.ok(
          !text.includes(vendor),
          `${path.relative(SRC, file)} names ${vendor}; the filmmaking layer must not know a vendor`
        );
      }
    }
  });

  it("gives every adapter the same interface, whatever it talks to", () => {
    for (const provider of listImageProviders()) {
      assert.equal(typeof provider.id, "string");
      assert.equal(typeof provider.label, "string");
      assert.equal(typeof provider.model, "string");
      assert.equal(typeof provider.isConfigured, "function");
      assert.equal(typeof provider.generate, "function");
    }
    for (const provider of listVideoProviders()) {
      assert.equal(typeof provider.submit, "function");
      assert.equal(typeof provider.poll, "function");
      assert.equal(typeof provider.supportsIdempotencyKey, "boolean");
    }
  });

  it("has more than one real image provider, so the seam is actually loaded", () => {
    // The test that gives all the others their meaning. A single implementation
    // can satisfy any interface.
    const real = listImageProviders().filter((p) => p.capabilities?.kind === "real");
    assert.ok(real.length >= 2, `only ${real.length} real image provider(s): ${real.map((p) => p.id).join(", ")}`);
  });
});

describe("what an adapter is allowed to reach", () => {
  it("never imports the database", () => {
    // An adapter that could read a Shot would be able to make decisions the
    // compiler is supposed to have already made.
    for (const dir of ["image-providers", "video-providers"]) {
      for (const file of adapterFiles(dir)) {
        const text = readFileSync(file, "utf8");
        assert.ok(
          !/from "@\/lib\/prisma"|from "@prisma\/client"/.test(text),
          `${path.relative(SRC, file)} imports the database`
        );
      }
    }
  });

  it("never imports the compiler or the spec", () => {
    for (const dir of ["image-providers", "video-providers"]) {
      for (const file of adapterFiles(dir)) {
        const text = readFileSync(file, "utf8");
        assert.ok(
          !/from "@\/lib\/prompt/.test(text) && !/from "\.\.\/\.\.\/prompt/.test(text),
          `${path.relative(SRC, file)} reaches into the prompt layer; it receives finished text`
        );
      }
    }
  });

  it("reads its own credential and nobody else's", () => {
    // One adapter quietly falling back to another's key would make an audit
    // trail that names the wrong account.
    const KEYS: Record<string, string[]> = {
      "openai.ts": ["OPENAI_API_KEY"],
      "gemini-image.ts": ["GOOGLE_API_KEY"],
      "google-veo.ts": ["GOOGLE_API_KEY"],
    };
    const ALL = ["OPENAI_API_KEY", "GOOGLE_API_KEY", "S3_SECRET_ACCESS_KEY", "AUTH_SECRET"];

    for (const dir of ["image-providers", "video-providers"]) {
      for (const file of adapterFiles(dir)) {
        const name = path.basename(file);
        const allowed = KEYS[name] ?? [];
        const text = readFileSync(file, "utf8");
        for (const key of ALL) {
          if (allowed.includes(key)) continue;
          assert.ok(
            !text.includes(key),
            `${path.relative(SRC, file)} reads ${key}, which is not its credential`
          );
        }
      }
    }
  });

  it("never puts a credential in a URL", () => {
    // A URL is logged by proxies, written into error messages and kept in
    // browser history. Both Google adapters send a header instead.
    for (const dir of ["image-providers", "video-providers"]) {
      for (const file of adapterFiles(dir)) {
        const text = readFileSync(file, "utf8");
        assert.ok(
          !/[?&]key=\$\{|[?&]key=" \+|[?&]api_key=\$\{/.test(text),
          `${path.relative(SRC, file)} appears to put a credential in a query string`
        );
      }
    }
  });
});

describe("what adding a provider is allowed to change", () => {
  it("registers every adapter under the id it declares for itself", () => {
    // The shape that makes adding one a single line: `[x.id]: x`. An entry
    // keyed by a string literal could name an adapter something other than
    // what it calls itself, and the audit trail would record the wrong thing.
    for (const dir of ["image-providers", "video-providers"]) {
      const index = readFileSync(path.join(AI, dir, "index.ts"), "utf8");
      // No `s` flag: this tsconfig target does not allow one, and none is needed
      // — `[^}]*` already spans newlines.
      const block = index.match(/const providers[^=]*=\s*\{([^}]*)\}/);
      assert.ok(block, `${dir}/index.ts has no provider map`);

      const entries = block[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("//"));
      assert.ok(entries.length > 0);

      for (const entry of entries) {
        assert.match(
          entry,
          /^\[(\w+)\.id\]:\s*\1,?$/,
          `${dir}/index.ts registers "${entry}" by something other than the adapter's own id`
        );
      }
    }
  });

  it("does not branch on which provider it is holding", () => {
    for (const dir of ["image-providers", "video-providers"]) {
      const index = readFileSync(path.join(AI, dir, "index.ts"), "utf8");
      for (const provider of [...listImageProviders(), ...listVideoProviders()]) {
        assert.ok(
          !new RegExp(`(if|switch|case)[^\\n]*["\'\`]${provider.id}["\'\`]`).test(index),
          `${dir}/index.ts special-cases ${provider.id}`
        );
      }
    }
  });

  it("leaves the submission path free of per-provider branching", () => {
    // The one place a provider's identity could leak into shared code. It reads
    // capabilities; it must not read names.
    const actions = readFileSync(path.join(SRC, "lib/actions/generations.ts"), "utf8");
    for (const provider of listImageProviders()) {
      assert.ok(
        !actions.includes(`"${provider.id}"`),
        `generations.ts names ${provider.id}; it should only read capabilities`
      );
    }
  });

  it("describes an unknown provider id without crashing", () => {
    // Rows outlive registry entries: a generation made by a provider that has
    // since been removed still has to render in the UI and the export.
    const files = sourceFiles(path.join(SRC, "lib/ai"));
    const index = files.find((f) => f.endsWith("image-providers/index.ts"));
    assert.ok(index);
    const text = readFileSync(index, "utf8");
    assert.match(text, /if \(!provider\)/, "describeImageProvider must handle an id it does not know");
  });
});

describe("what the second provider found", () => {
  it("has one capability that not every provider can answer", () => {
    // `defaultSize` was required until a provider arrived whose API has no
    // dimension parameter at all. The interface now says absent means "does not
    // accept a size" — the single change outside the new adapter and the
    // registry, and the reason this workstream was worth doing.
    const types = readFileSync(path.join(AI, "image-providers/types.ts"), "utf8");
    assert.match(types, /defaultSize\?: string;/, "defaultSize must be optional");
    assert.match(types, /does not accept a size/i, "and must say what absent means");

    const withSizes = listImageProviders().filter((p) => (p.capabilities?.sizes.length ?? 0) > 0);
    const withoutSizes = listImageProviders().filter((p) => p.capabilities?.sizes.length === 0);
    assert.ok(withSizes.length > 0 && withoutSizes.length > 0, "both shapes are represented");
  });

  it("keeps a provider that declares sizes honest about its default", () => {
    // Optional does not mean "may be wrong": a provider that offers sizes must
    // default to one of them.
    for (const provider of listImageProviders()) {
      const caps = provider.capabilities;
      if (!caps || caps.sizes.length === 0) continue;
      assert.ok(
        caps.defaultSize && caps.sizes.includes(caps.defaultSize),
        `${provider.id} defaults to ${caps.defaultSize}, which is not in ${caps.sizes.join(", ")}`
      );
    }
  });

  it("keeps a provider that declares no sizes from naming a default", () => {
    for (const provider of listImageProviders()) {
      const caps = provider.capabilities;
      if (!caps || caps.sizes.length > 0) continue;
      assert.equal(
        caps.defaultSize,
        undefined,
        `${provider.id} names a default size while accepting none`
      );
    }
  });

  it("leaves the prompt layer at exactly one adapter, untouched", () => {
    // Two rendering providers, still one prompt provider: the two halves of the
    // pipeline are independent, which is the other half of the claim.
    assert.deepEqual(listProviders().map((p) => p.id), ["generic"]);
  });
});
