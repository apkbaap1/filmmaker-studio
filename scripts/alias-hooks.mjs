/**
 * Resolves the `@/` path alias, and extensionless imports, for plain Node.
 *
 * The application's TypeScript config maps `@/*` to `src/*` and lets an import
 * omit its extension. Next's bundler understands both; `node` understands
 * neither. Without this, anything reachable from such a module — the worker, the
 * job runner, the media layer — could only ever run inside Next, which would
 * make the worker untestable and unrunnable as its own process.
 *
 * It resolves specifiers and nothing else: no transpiling, no rewriting, no
 * substitutions. `node --experimental-strip-types` still does the TypeScript.
 *
 *     node --import ./scripts/alias-hooks.mjs ...
 */
import { register } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Mirrors the module resolution the bundler performs for an extensionless import. */
function resolveFile(base) {
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]
    .find(isFile);
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = resolveFile(path.join(SRC, specifier.slice(2)));
    if (target) return nextResolve(pathToFileURL(target).href, context);
  }

  // A Next subpath import — `next/navigation`, `next/cache`. Next ships these
  // as plain `.js` files at its package root and relies on a bundler to find
  // them; Node's resolver reports the bare form as a missing module. Resolving
  // them here is what lets a server action be imported by a test at all, and
  // therefore what lets the session be substituted and the action exercised
  // directly rather than only described by reading its source.
  if (/^next\/[\w-]+$/.test(specifier) && !path.extname(specifier)) {
    const target = path.join(ROOT, "node_modules", `${specifier}.js`);
    if (isFile(target)) return nextResolve(pathToFileURL(target).href, context);
  }

  // A relative import with no extension, which TypeScript permits and Node does not.
  if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
    const from = path.dirname(fileURLToPath(context.parentURL));
    const target = resolveFile(path.resolve(from, specifier));
    if (target) return nextResolve(pathToFileURL(target).href, context);
  }

  return nextResolve(specifier, context);
}

register(import.meta.url, import.meta.url);
