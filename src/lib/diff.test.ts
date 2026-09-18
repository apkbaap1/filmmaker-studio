import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffLines, diffWords, promptsDiffer, summariseDiff } from "./diff.ts";

describe("deterministic prompt comparison", () => {
  it("reports no change for identical text", () => {
    const parts = diffWords("Medium Close-Up of Ravi.", "Medium Close-Up of Ravi.");
    assert.deepEqual(parts.map((p) => p.op), ["equal"]);
    assert.equal(summariseDiff("a b c", "a b c").changed, false);
  });

  it("finds an inserted phrase and leaves the rest equal", () => {
    const parts = diffWords(
      "Medium Close-Up of Ravi. Mood: Suspenseful.",
      "Medium Close-Up of Ravi. Shot on 85mm. Mood: Suspenseful."
    );
    const added = parts.filter((p) => p.op === "added").map((p) => p.value.trim());
    assert.deepEqual(parts.filter((p) => p.op === "removed"), []);
    assert.ok(added.join(" ").includes("85mm"));
  });

  it("finds a removed phrase", () => {
    // "lights" becomes "lights." when the full stop moves onto it, so that one
    // token is genuinely a replacement rather than an untouched word.
    const summary = summariseDiff("Warm practical lights and cool moonlight.", "Warm practical lights.");
    assert.equal(summary.changed, true);
    assert.ok(summary.removedWords > summary.addedWords, "the net effect is a deletion");

    const parts = diffWords("Warm practical lights and cool moonlight.", "Warm practical lights.");
    assert.ok(parts.some((p) => p.op === "removed" && p.value.includes("cool moonlight")));
  });

  it("leaves untouched words alone when only a trailing clause goes", () => {
    const summary = summariseDiff("Warm practical lights and cool moonlight", "Warm practical lights");
    assert.equal(summary.addedWords, 0, "nothing was added");
    assert.equal(summary.removedWords, 3);
  });

  it("rebuilds both sides exactly from the parts — nothing is lost", () => {
    const before = "START — Opening framing: Wide.\nMOTION — Dolly In.";
    const after = "START — Opening framing: Tight.\nMOTION — Dolly In, slow.";
    const parts = diffWords(before, after);
    const rebuiltBefore = parts.filter((p) => p.op !== "added").map((p) => p.value).join("");
    const rebuiltAfter = parts.filter((p) => p.op !== "removed").map((p) => p.value).join("");
    assert.equal(rebuiltBefore, before);
    assert.equal(rebuiltAfter, after);
  });

  it("is deterministic — the same inputs always give the same output", () => {
    const a = "Medium Close-Up of Ravi, from a Low Angle, shot on 85mm Prime lens.";
    const b = "Medium Close-Up of Ravi, from a High Angle, shot on 50mm Prime lens.";
    assert.deepEqual(diffWords(a, b), diffWords(a, b));
    assert.deepEqual(summariseDiff(a, b), summariseDiff(a, b));
  });

  it("diffs by line where structure is what changed", () => {
    const parts = diffLines("one\ntwo\nthree", "one\ntwo and a half\nthree");
    assert.ok(parts.some((p) => p.op === "removed" && p.value.includes("two")));
    assert.ok(parts.some((p) => p.op === "added" && p.value.includes("two and a half")));
    assert.ok(parts.some((p) => p.op === "equal" && p.value.includes("three")));
  });

  it("does not call CRLF an edit", () => {
    const compiled = "line one\nline two\nline three";
    assert.equal(promptsDiffer(compiled, compiled.replace(/\n/g, "\r\n")), false);
    assert.equal(promptsDiffer(compiled, `${compiled}\nline four`), true);
  });

  it("handles empty inputs without losing the other side", () => {
    assert.deepEqual(diffWords("", "").filter((p) => p.value !== ""), []);
    assert.equal(summariseDiff("", "new prompt").addedWords, 2);
    assert.equal(summariseDiff("old prompt", "").removedWords, 2);
  });

  it("uses no model, network or clock — it is a pure function", () => {
    // Guards the rule: comparison must never depend on anything outside itself.
    const source = diffWords.toString() + summariseDiff.toString();
    for (const forbidden of ["fetch", "Date", "Math.random", "process.env"]) {
      assert.ok(!source.includes(forbidden), `diff must not use ${forbidden}`);
    }
  });
});
