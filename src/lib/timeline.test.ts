import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipAtTime,
  formatDuration,
  formatTimecode,
  groupByScene,
  layOutClips,
  PLACEHOLDER_CLIP_SECONDS,
  resolveClipAsset,
  resolveSourceDuration,
  resolveStoryboardFrame,
  splitPlacement,
  usedDuration,
  type ClipPlacement,
} from "./timeline.ts";
import { clipTransitionSchema, clipTrimSchema } from "./validation.ts";

/**
 * Phase 7 — the edit view's timing rules.
 *
 * The one that matters most: a timeline placement is an *edit* decision and the
 * shot is a *filmmaking* decision. Trimming a clip must never move the shot.
 */

interface TestClip extends ClipPlacement {
  sceneId: string;
  shotDurationSeconds?: number | null;
  assetDurationSeconds?: number | null;
}

function clip(partial: Partial<TestClip> & { id: string }): TestClip {
  return {
    shotId: `shot-${partial.id}`,
    sceneId: "scene-1",
    order: 0,
    inPointSeconds: 0,
    outPointSeconds: null,
    ...partial,
  };
}

const facts = (c: TestClip) => ({
  shotDurationSeconds: c.shotDurationSeconds,
  assetDurationSeconds: c.assetDurationSeconds,
});

describe("source duration resolution", () => {
  it("prefers the measured asset over the shot's intended duration", () => {
    const resolved = resolveSourceDuration({ shotDurationSeconds: 6, assetDurationSeconds: 4.2 });
    assert.deepEqual(resolved, { seconds: 4.2, from: "asset" });
  });

  it("falls back to the shot's duration when no media has been measured", () => {
    assert.deepEqual(resolveSourceDuration({ shotDurationSeconds: 6 }), { seconds: 6, from: "shot" });
    assert.deepEqual(resolveSourceDuration({ shotDurationSeconds: 6, assetDurationSeconds: null }), {
      seconds: 6,
      from: "shot",
    });
  });

  it("marks a length it had to invent as a placeholder rather than passing it off as a duration", () => {
    const resolved = resolveSourceDuration({});
    assert.equal(resolved.from, "placeholder");
    assert.equal(resolved.seconds, PLACEHOLDER_CLIP_SECONDS);
  });

  it("ignores nonsense durations instead of laying out a broken ruler", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(resolveSourceDuration({ shotDurationSeconds: bad }).from, "placeholder");
    }
  });
});

describe("trim: used duration vs source duration", () => {
  it("plays the whole source when no out point is set", () => {
    assert.equal(usedDuration(clip({ id: "a" }), 6), 6);
  });

  it("uses 3.5 seconds of a 6-second shot — the brief's example", () => {
    const placement = clip({ id: "a", inPointSeconds: 0, outPointSeconds: 3.5 });
    assert.equal(usedDuration(placement, 6), 3.5);
  });

  it("subtracts the in point as well as the out point", () => {
    assert.equal(usedDuration(clip({ id: "a", inPointSeconds: 1.5, outPointSeconds: 4 }), 6), 2.5);
  });

  it("clamps a trim that outlived its media rather than running off the end", () => {
    // The shot said 6s; the clip was later measured at 4s.
    assert.equal(usedDuration(clip({ id: "a", inPointSeconds: 0, outPointSeconds: 6 }), 4), 4);
    assert.equal(usedDuration(clip({ id: "a", inPointSeconds: 5, outPointSeconds: 6 }), 4), 0);
  });

  it("never returns a negative length for an inverted trim", () => {
    assert.equal(usedDuration(clip({ id: "a", inPointSeconds: 4, outPointSeconds: 1 }), 6), 0);
  });

  it("leaves the shot's own duration completely untouched", () => {
    // The placement is the only thing a trim may alter. This asserts the shape
    // of the model: nothing in the timing layer can even name a shot field.
    const source = { shotDurationSeconds: 6 };
    const placement = clip({ id: "a", outPointSeconds: 3.5 });
    usedDuration(placement, resolveSourceDuration(source).seconds);
    assert.equal(source.shotDurationSeconds, 6);
    assert.equal(placement.outPointSeconds, 3.5);
  });
});

describe("layout on the ruler", () => {
  const clips = [
    clip({ id: "c1", order: 0, shotDurationSeconds: 6 }),
    clip({ id: "c2", order: 1, shotDurationSeconds: 4, outPointSeconds: 2.5 }),
    clip({ id: "c3", order: 2, shotDurationSeconds: 3 }),
  ];

  it("lays clips end to end and totals the used durations", () => {
    const layout = layOutClips(clips, facts);
    assert.deepEqual(
      layout.clips.map((e) => [e.clip.id, e.startSeconds, e.endSeconds]),
      [
        ["c1", 0, 6],
        ["c2", 6, 8.5],
        ["c3", 8.5, 11.5],
      ]
    );
    assert.equal(layout.totalSeconds, 11.5);
  });

  it("flags which clips are trimmed and which play whole", () => {
    const layout = layOutClips(clips, facts);
    assert.deepEqual(layout.clips.map((e) => e.trimmed), [false, true, false]);
  });

  it("respects `order`, not array position", () => {
    const shuffled = [
      clip({ id: "c3", order: 2, shotDurationSeconds: 3 }),
      clip({ id: "c1", order: 0, shotDurationSeconds: 6 }),
      clip({ id: "c2", order: 1, shotDurationSeconds: 4 }),
    ];
    assert.deepEqual(layOutClips(shuffled, facts).clips.map((e) => e.clip.id), ["c1", "c2", "c3"]);
  });

  it("reordering changes only positions — never a shot id or a trim", () => {
    const before = layOutClips(clips, facts);
    const reordered = clips.map((c) =>
      c.id === "c1" ? { ...c, order: 2 } : c.id === "c3" ? { ...c, order: 0 } : c
    );
    const after = layOutClips(reordered, facts);

    assert.deepEqual(after.clips.map((e) => e.clip.id), ["c3", "c2", "c1"]);
    assert.equal(before.totalSeconds, after.totalSeconds);
    for (const entry of after.clips) {
      const original = clips.find((c) => c.id === entry.clip.id);
      assert.equal(entry.clip.shotId, original?.shotId, "a reorder must not touch shot identity");
      assert.equal(entry.usedSeconds, before.clips.find((e) => e.clip.id === entry.clip.id)?.usedSeconds);
    }
  });

  it("is stable and total for an empty sequence", () => {
    const layout = layOutClips([] as TestClip[], facts);
    assert.deepEqual(layout.clips, []);
    assert.equal(layout.totalSeconds, 0);
  });

  it("does not accumulate float drift across many clips", () => {
    const tenth = Array.from({ length: 10 }, (_, i) =>
      clip({ id: `c${i}`, order: i, shotDurationSeconds: 0.1 })
    );
    assert.equal(layOutClips(tenth, facts).totalSeconds, 1);
  });

  it("gives a zero-length clip no width and does not stall the ruler", () => {
    const withEmpty = [
      clip({ id: "c1", order: 0, shotDurationSeconds: 5 }),
      clip({ id: "c2", order: 1, shotDurationSeconds: 5, inPointSeconds: 2, outPointSeconds: 2 }),
      clip({ id: "c3", order: 2, shotDurationSeconds: 5 }),
    ];
    const layout = layOutClips(withEmpty, facts);
    assert.equal(layout.clips[1].usedSeconds, 0);
    assert.equal(layout.clips[2].startSeconds, 5);
    assert.equal(layout.totalSeconds, 10);
  });
});

describe("playhead → clip", () => {
  const layout = layOutClips(
    [
      clip({ id: "c1", order: 0, shotDurationSeconds: 6 }),
      clip({ id: "c2", order: 1, shotDurationSeconds: 4 }),
    ],
    facts
  );

  it("finds the clip under the playhead and the offset into it", () => {
    assert.deepEqual(clipAtTime(layout, 0)?.entry.clip.id, "c1");
    assert.equal(clipAtTime(layout, 2.5)?.offsetSeconds, 2.5);
    assert.equal(clipAtTime(layout, 7)?.entry.clip.id, "c2");
    assert.equal(clipAtTime(layout, 7)?.offsetSeconds, 1);
  });

  it("gives a boundary to the incoming clip, never to both", () => {
    assert.equal(clipAtTime(layout, 6)?.entry.clip.id, "c2");
    assert.equal(clipAtTime(layout, 6)?.offsetSeconds, 0);
  });

  it("reports nothing before the start and at or past the end", () => {
    assert.equal(clipAtTime(layout, -1), undefined);
    assert.equal(clipAtTime(layout, 10), undefined);
    assert.equal(clipAtTime(layout, 99), undefined);
  });

  it("skips over a zero-length clip instead of getting stuck on it", () => {
    const withEmpty = layOutClips(
      [
        clip({ id: "c1", order: 0, shotDurationSeconds: 5 }),
        clip({ id: "c2", order: 1, shotDurationSeconds: 5, inPointSeconds: 1, outPointSeconds: 1 }),
        clip({ id: "c3", order: 2, shotDurationSeconds: 5 }),
      ],
      facts
    );
    assert.equal(clipAtTime(withEmpty, 5)?.entry.clip.id, "c3");
  });
});

describe("scene grouping", () => {
  it("groups consecutive clips from the same scene", () => {
    const layout = layOutClips(
      [
        clip({ id: "c1", order: 0, sceneId: "s1", shotDurationSeconds: 2 }),
        clip({ id: "c2", order: 1, sceneId: "s1", shotDurationSeconds: 2 }),
        clip({ id: "c3", order: 2, sceneId: "s2", shotDurationSeconds: 3 }),
      ],
      facts
    );
    const groups = groupByScene(layout, (c) => c.sceneId);
    assert.deepEqual(
      groups.map((g) => [g.sceneId, g.entries.length, g.startSeconds, g.endSeconds]),
      [
        ["s1", 2, 0, 4],
        ["s2", 1, 4, 7],
      ]
    );
  });

  it("opens a second band when the edit cuts back to a scene", () => {
    const layout = layOutClips(
      [
        clip({ id: "c1", order: 0, sceneId: "s1", shotDurationSeconds: 2 }),
        clip({ id: "c2", order: 1, sceneId: "s2", shotDurationSeconds: 2 }),
        clip({ id: "c3", order: 2, sceneId: "s1", shotDurationSeconds: 2 }),
      ],
      facts
    );
    const groups = groupByScene(layout, (c) => c.sceneId);
    assert.deepEqual(groups.map((g) => g.sceneId), ["s1", "s2", "s1"]);
  });
});

describe("split", () => {
  it("splits an untrimmed clip into two adjoining trims", () => {
    const result = splitPlacement(clip({ id: "c1" }), 6, 2.5);
    assert.deepEqual(result, {
      first: { inPointSeconds: 0, outPointSeconds: 2.5 },
      second: { inPointSeconds: 2.5, outPointSeconds: 6 },
    });
  });

  it("splits relative to the clip's own start, not the source's", () => {
    const result = splitPlacement(clip({ id: "c1", inPointSeconds: 1, outPointSeconds: 5 }), 6, 1);
    assert.deepEqual(result, {
      first: { inPointSeconds: 1, outPointSeconds: 2 },
      second: { inPointSeconds: 2, outPointSeconds: 5 },
    });
  });

  it("preserves total used duration across the split", () => {
    const placement = clip({ id: "c1", inPointSeconds: 1, outPointSeconds: 5 });
    const before = usedDuration(placement, 6);
    const result = splitPlacement(placement, 6, 1.75);
    assert.ok(result);
    const after =
      usedDuration({ ...placement, ...result.first }, 6) +
      usedDuration({ ...placement, ...result.second }, 6);
    assert.equal(after, before);
  });

  it("refuses a split at either edge rather than making a zero-length clip", () => {
    assert.equal(splitPlacement(clip({ id: "c1" }), 6, 0), undefined);
    assert.equal(splitPlacement(clip({ id: "c1" }), 6, 6), undefined);
    assert.equal(splitPlacement(clip({ id: "c1" }), 6, 9), undefined);
    assert.equal(splitPlacement(clip({ id: "c1" }), 6, -1), undefined);
  });
});

describe("display formatting", () => {
  it("formats a timecode as HH:MM:SS:FF", () => {
    assert.equal(formatTimecode(0), "00:00:00:00");
    assert.equal(formatTimecode(3.5), "00:00:03:12");
    assert.equal(formatTimecode(61.25), "00:01:01:06");
    assert.equal(formatTimecode(3661), "01:01:01:00");
  });

  it("never renders a negative timecode", () => {
    assert.equal(formatTimecode(-5), "00:00:00:00");
  });

  it("formats durations the way a shot list reads them", () => {
    assert.equal(formatDuration(6), "6s");
    assert.equal(formatDuration(3.5), "3.5s");
    assert.equal(formatDuration(90), "1m 30s");
    assert.equal(formatDuration(120), "2m");
  });
});

describe("shot ↔ clip ↔ storyboard ↔ assets are one structure", () => {
  const assets = [
    { id: "a-video-new", mimeType: "video/webm" },
    { id: "a-video-old", mimeType: "video/webm" },
    { id: "a-image", mimeType: "image/png" },
  ];

  it("stands a shot's newest video in when no choice has been made", () => {
    assert.equal(resolveClipAsset(assets, null)?.id, "a-video-new");
  });

  it("honours an explicit choice over the default", () => {
    assert.equal(resolveClipAsset(assets, "a-video-old")?.id, "a-video-old");
    assert.equal(resolveClipAsset(assets, "a-image")?.id, "a-image");
  });

  it("falls back rather than blanking the clip when the chosen asset is gone", () => {
    assert.equal(resolveClipAsset(assets, "deleted-asset")?.id, "a-video-new");
  });

  it("uses the storyboard frame for a shot with no video, so it still plays as a beat", () => {
    assert.equal(resolveClipAsset([{ id: "a-image", mimeType: "image/png" }], null)?.id, "a-image");
  });

  it("resolves to nothing for a shot with nothing generated — a slate, not an error", () => {
    assert.equal(resolveClipAsset([], null), undefined);
  });

  it("picks the same frame the storyboard panel shows", () => {
    // One rule, so a panel and a clip can never disagree about a shot's frame.
    assert.equal(resolveStoryboardFrame(assets)?.id, "a-image");
    assert.equal(resolveClipAsset(assets.filter((a) => a.mimeType.startsWith("image/")), null)?.id,
      resolveStoryboardFrame(assets)?.id);
  });

  it("keeps every generation available after one is selected", () => {
    // Selecting is a pointer, not a filter: the other takes are untouched.
    const selected = resolveClipAsset(assets, "a-video-old");
    assert.equal(selected?.id, "a-video-old");
    assert.equal(assets.length, 3);
    assert.deepEqual(assets.map((a) => a.id), ["a-video-new", "a-video-old", "a-image"]);
  });

  it("lets two clips of the same shot choose different takes", () => {
    const first = resolveClipAsset(assets, "a-video-new");
    const second = resolveClipAsset(assets, "a-video-old");
    assert.notEqual(first?.id, second?.id);
  });

  it("reads a shot's assets through the shot, never through a copy on the clip", () => {
    // The clip holds an id; the assets come from the shot. Changing the shot's
    // asset list is immediately visible to every clip that references it.
    const clipA = { shotId: "shot-1", selectedAssetId: null };
    const clipB = { shotId: "shot-1", selectedAssetId: null };
    const shotAssets = [...assets];
    assert.equal(
      resolveClipAsset(shotAssets, clipA.selectedAssetId)?.id,
      resolveClipAsset(shotAssets, clipB.selectedAssetId)?.id
    );
    shotAssets.unshift({ id: "a-video-newest", mimeType: "video/webm" });
    assert.equal(resolveClipAsset(shotAssets, clipA.selectedAssetId)?.id, "a-video-newest");
    assert.equal(resolveClipAsset(shotAssets, clipB.selectedAssetId)?.id, "a-video-newest");
  });
});

describe("edit points", () => {
  it("accepts every transition the brief lists", () => {
    for (const transition of ["CUT", "DISSOLVE", "FADE", "MATCH_CUT", "J_CUT", "L_CUT"]) {
      const parsed = clipTransitionSchema.safeParse({ transition, durationSeconds: null });
      assert.ok(parsed.success, `${transition} must be a valid edit point`);
    }
  });

  it("treats 'not specified' and an explicit CUT as different things", () => {
    const unspecified = clipTransitionSchema.parse({ transition: null, durationSeconds: null });
    const explicitCut = clipTransitionSchema.parse({ transition: "CUT", durationSeconds: null });
    assert.equal(unspecified.transition, null);
    assert.equal(explicitCut.transition, "CUT");
    assert.notEqual(unspecified.transition, explicitCut.transition);
  });

  it("rejects an invented transition type", () => {
    assert.equal(
      clipTransitionSchema.safeParse({ transition: "SMASH_ZOOM", durationSeconds: null }).success,
      false
    );
  });

  it("carries a transition duration without letting it move the ruler", () => {
    // Transition length is edit metadata in this phase. Timing stays cut-based,
    // so a 1s dissolve does not shorten the sequence by a second.
    const clips = [
      clip({ id: "c1", order: 0, shotDurationSeconds: 4 }),
      clip({ id: "c2", order: 1, shotDurationSeconds: 4 }),
    ];
    assert.equal(layOutClips(clips, facts).totalSeconds, 8);
    assert.ok(clipTransitionSchema.safeParse({ transition: "DISSOLVE", durationSeconds: 1 }).success);
    assert.equal(layOutClips(clips, facts).totalSeconds, 8);
  });
});

describe("trim validation at the write boundary", () => {
  it("accepts a 0 → 3.5 trim of a 6-second shot", () => {
    assert.ok(clipTrimSchema.safeParse({ inPointSeconds: 0, outPointSeconds: 3.5 }).success);
  });

  it("accepts a null out point as 'run to the end'", () => {
    const parsed = clipTrimSchema.parse({ inPointSeconds: 0, outPointSeconds: null });
    assert.equal(parsed.outPointSeconds, null);
  });

  it("refuses an out point at or before the in point", () => {
    assert.equal(clipTrimSchema.safeParse({ inPointSeconds: 4, outPointSeconds: 4 }).success, false);
    assert.equal(clipTrimSchema.safeParse({ inPointSeconds: 4, outPointSeconds: 1 }).success, false);
  });

  it("refuses a negative in point", () => {
    assert.equal(clipTrimSchema.safeParse({ inPointSeconds: -1, outPointSeconds: 3 }).success, false);
  });

  it("has no field that could write a shot's duration", () => {
    // The schema is the write boundary: if it cannot name a shot field, no
    // timeline edit can reach one.
    const parsed = clipTrimSchema.parse({ inPointSeconds: 0, outPointSeconds: 3.5 });
    assert.deepEqual(Object.keys(parsed).sort(), ["inPointSeconds", "outPointSeconds"]);
  });
});

describe("removing a placement", () => {
  it("leaves the shot in the project, and its other placements alone", () => {
    // Removing a clip is a list operation on placements; the shot id it pointed
    // at is unaffected and can be placed again.
    const placements = [
      clip({ id: "c1", order: 0, shotId: "shot-a", shotDurationSeconds: 3 }),
      clip({ id: "c2", order: 1, shotId: "shot-b", shotDurationSeconds: 3 }),
      clip({ id: "c3", order: 2, shotId: "shot-a", shotDurationSeconds: 3 }),
    ];
    const remaining = placements.filter((c) => c.id !== "c1");
    const layout = layOutClips(remaining, facts);

    assert.deepEqual(layout.clips.map((e) => e.clip.shotId), ["shot-b", "shot-a"]);
    assert.ok(
      remaining.some((c) => c.shotId === "shot-a"),
      "the shot's other placement survives"
    );
    // Reinserting is just adding a placement back.
    const reinserted = layOutClips(
      [...remaining, clip({ id: "c4", order: 3, shotId: "shot-a", shotDurationSeconds: 3 })],
      facts
    );
    assert.equal(reinserted.clips.length, 3);
    assert.equal(reinserted.totalSeconds, 9);
  });
});
