import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { scopedTo } from "./authz.ts";

/**
 * Phase 11.1 — every project-scoped write carries its scope.
 *
 * This is a static audit rather than a unit test, because the vulnerability it
 * guards against is a *shape*: proving access to a project and then writing a
 * row by an id that was never checked against it. A runtime test would only
 * cover the call sites someone remembered to write a test for; this covers all
 * of them, including ones added later.
 */

const ACTIONS = path.resolve(import.meta.dirname, "actions");

/** Models whose rows belong to a project and must therefore be scoped. */
const PROJECT_SCOPED_MODELS = [
  "scene",
  "shotListItem",
  "scheduleDay",
  "scheduleItem",
  "budgetCategory",
  "budgetLineItem",
  "equipment",
  "location",
  "castMember",
  "crewMember",
  "asset",
  "generation",
  "sequence",
  "timelineClip",
  "promptVersion",
  "continuityDecision",
] as const;

/** `prisma.<model>.<op>(` with the argument object that follows it. */
function writeCalls(source: string) {
  const calls: Array<{ model: string; op: string; args: string; line: number }> = [];
  const pattern = /prisma\.(\w+)\.(update|updateMany|delete|deleteMany|upsert)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push({
      model: match[1],
      op: match[2],
      args: source.slice(start, end + 1),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return calls;
}

const files = readdirSync(ACTIONS)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ name: f, source: readFileSync(path.join(ACTIONS, f), "utf8") }));

describe("project-scoped writes", () => {
  it("has action files to audit", () => {
    assert.ok(files.length >= 10, `expected the action modules, found ${files.length}`);
    assert.ok(files.some((f) => f.name === "shots.ts"));
  });

  it("never writes a project-owned row without joining the scope to the write", () => {
    const offenders: string[] = [];

    for (const { name, source } of files) {
      for (const call of writeCalls(source)) {
        if (!(PROJECT_SCOPED_MODELS as readonly string[]).includes(call.model)) continue;

        // Scoped either by spreading a scopedTo filter, or by naming the
        // owning relation directly in the same where clause.
        const scoped =
          /scopedTo\.\w+\(/.test(call.args) ||
          /\bprojectId\b/.test(call.args) ||
          /scene:\s*\{[^}]*projectId/.test(call.args) ||
          /sequence:\s*\{[^}]*projectId/.test(call.args) ||
          /scheduleDay:\s*\{[^}]*projectId/.test(call.args) ||
          /category:\s*\{[^}]*projectId/.test(call.args) ||
          /shot:\s*\{[^}]*projectId/.test(call.args);

        // A write inside a loop over rows that were themselves fetched with a
        // scoped query is safe; those are marked so the audit can see it.
        const preAuthorised = /authz-safe/.test(call.args);

        if (!scoped && !preAuthorised) {
          offenders.push(`${name}:${call.line} prisma.${call.model}.${call.op}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these writes trust a client-supplied id without checking it belongs to the project:\n${offenders.join("\n")}`
    );
  });

  it("uses updateMany/deleteMany for scoped writes, since update/delete cannot carry a filter", () => {
    const wrong: string[] = [];
    for (const { name, source } of files) {
      for (const call of writeCalls(source)) {
        if (!(PROJECT_SCOPED_MODELS as readonly string[]).includes(call.model)) continue;
        if (call.op !== "update" && call.op !== "delete") continue;
        if (/authz-safe/.test(call.args)) continue;
        wrong.push(`${name}:${call.line} prisma.${call.model}.${call.op}`);
      }
    }
    assert.deepEqual(wrong, [], `these must use updateMany/deleteMany to carry their scope:\n${wrong.join("\n")}`);
  });

  it("scopes each model through a relation that actually reaches the project", () => {
    assert.deepEqual(scopedTo.shot("p"), { scene: { projectId: "p" } });
    assert.deepEqual(scopedTo.scheduleItem("p"), { scheduleDay: { projectId: "p" } });
    assert.deepEqual(scopedTo.budgetLineItem("p"), { category: { projectId: "p" } });
    assert.deepEqual(scopedTo.timelineClip("p"), { sequence: { projectId: "p" } });
    assert.deepEqual(scopedTo.promptVersion("p"), { shot: { scene: { projectId: "p" } } });
    assert.deepEqual(scopedTo.scene("p"), { projectId: "p" });
  });

  it("every action module checks project access before writing at all", () => {
    for (const { name, source } of files) {
      if (writeCalls(source).length === 0) continue;
      assert.ok(
        source.includes("requireProjectAccess") || name === "auth.ts",
        `${name} writes without requiring project access`
      );
    }
  });
});
