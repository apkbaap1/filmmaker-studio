import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Static guarantee that provider credentials stay on the server.
 *
 * A runtime test cannot prove this — the key is absent in tests either way. What
 * actually matters is the *import graph*: if no module reachable from a
 * "use client" entry point ever reads the key, the bundler has nothing to put in
 * the browser bundle. So this walks the real graph over the real source.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..");

const SECRET_READ = /process\.env\.(OPENAI_API_KEY|AUTH_SECRET|DATABASE_URL)/;
const SERVER_ONLY = /^\s*import\s+["']server-only["']/m;
const USE_CLIENT = /^\s*["']use client["']/;
const USE_SERVER = /^\s*["']use server["']/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return undefined; // a package, not our source

  const withoutExt = base.replace(/\.(tsx?|jsx?)$/, "");
  for (const candidate of [
    `${withoutExt}.ts`,
    `${withoutExt}.tsx`,
    path.join(withoutExt, "index.ts"),
    path.join(withoutExt, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this one
    }
  }
  return undefined;
}

const IMPORT = /(?:from\s*|import\s*)["']([^"']+)["']/g;

interface Module {
  file: string;
  source: string;
  isClient: boolean;
  isServerAction: boolean;
  readsSecret: boolean;
  hasServerOnly: boolean;
  imports: string[];
}

const modules = new Map<string, Module>();
for (const file of sourceFiles(SRC)) {
  const source = readFileSync(file, "utf8");
  const imports: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) imports.push(resolved);
  }
  modules.set(file, {
    file,
    source,
    isClient: USE_CLIENT.test(source),
    isServerAction: USE_SERVER.test(source),
    readsSecret: SECRET_READ.test(source),
    hasServerOnly: SERVER_ONLY.test(source),
    imports,
  });
}

function rel(file: string): string {
  return path.relative(SRC, file);
}

describe("provider credentials stay server-side", () => {
  it("has a source graph to check in the first place", () => {
    assert.ok(modules.size > 30, `only found ${modules.size} modules — the walk is wrong`);
    assert.ok([...modules.values()].some((m) => m.isClient), "no client components found");
    assert.ok([...modules.values()].some((m) => m.readsSecret), "no secret readers found");
  });

  it("no client component can reach a module that reads a provider secret", () => {
    // A "use server" module is a real bundler boundary: a client component that
    // imports one gets a call stub, not the module body, so the traversal stops
    // there. It is only a boundary because of that directive, which the next
    // test pins down separately.
    const seen = new Set<string>();
    const offenders: string[] = [];

    function walk(file: string, trail: string[]) {
      if (seen.has(file)) return;
      seen.add(file);
      const mod = modules.get(file);
      if (!mod) return;
      if (mod.readsSecret) {
        offenders.push([...trail, rel(file)].join(" → "));
        return;
      }
      for (const next of mod.imports) {
        const target = modules.get(next);
        if (target?.isServerAction) continue;
        walk(next, [...trail, rel(file)]);
      }
    }

    for (const mod of modules.values()) {
      if (mod.isClient) walk(mod.file, []);
    }

    assert.deepEqual(offenders, [], `a secret is reachable from the browser:\n${offenders.join("\n")}`);
  });

  it("every action module a client component imports really is a server action", () => {
    // The traversal above is only sound if each stop is genuinely a boundary.
    const notBoundaries: string[] = [];
    for (const mod of modules.values()) {
      if (!mod.isClient) continue;
      for (const imported of mod.imports) {
        const target = modules.get(imported);
        if (!target) continue;
        if (/lib\/actions\//.test(target.file) && !target.isServerAction) {
          notBoundaries.push(`${rel(mod.file)} → ${rel(target.file)}`);
        }
      }
    }
    assert.deepEqual(notBoundaries, []);
  });

  it("every module that reads a provider secret is marked server-only", () => {
    const unguarded = [...modules.values()]
      .filter((m) => m.readsSecret && !m.hasServerOnly)
      // The Prisma client and auth config are server-only by construction: they
      // are never imported by a client component (asserted above) and marking
      // them would break the edge middleware, which imports the auth config.
      .filter((m) => !/lib\/prisma\.ts$|auth\.config\.ts$|auth\.ts$/.test(m.file))
      .map((m) => rel(m.file));

    assert.deepEqual(unguarded, [], `these read a secret without a server-only guard: ${unguarded}`);
  });

  it("no secret is exposed through a NEXT_PUBLIC_ variable", () => {
    for (const mod of modules.values()) {
      const publicVars = [...mod.source.matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)].map((m) => m[1]);
      for (const name of publicVars) {
        assert.ok(
          !/KEY|SECRET|TOKEN|PASSWORD/i.test(name),
          `${rel(mod.file)} exposes ${name} to the browser`
        );
      }
    }
  });

  it("the generation UI reads no environment variable at all", () => {
    const shotDir = "app/projects/[projectId]/scenes/[sceneId]/shots/[shotId]";
    for (const name of ["shot-generation.tsx", "generation-card.tsx"]) {
      const ui = modules.get(path.join(SRC, shotDir, name));
      assert.ok(ui, `${name} moved — update this test`);
      assert.ok(ui.isClient, `${name} is a client component`);
      assert.ok(!/process\.env/.test(ui.source), `${name} must not read process.env`);
    }
  });

  it("the provider registries are only reachable from server code", () => {
    for (const registry of ["lib/ai/image-providers/index.ts", "lib/ai/video-providers/index.ts"]) {
      const file = path.join(SRC, registry);
      assert.ok(modules.has(file), `${registry} moved — update this test`);

      const clientImporters = [...modules.values()]
        .filter((m) => m.isClient && m.imports.includes(file))
        .map((m) => rel(m.file));
      assert.deepEqual(clientImporters, [], `${registry} is imported by a client component`);
    }
  });
});
