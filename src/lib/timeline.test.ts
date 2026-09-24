import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clipAtTime,
  describeTransitionEffect,
  formatDuration,
  formatTimecode,
  groupByScene,
  layOutClips,
  PLACEHOLDER_CLIP_SECONDS,
  resolveClipAsset,
  resolveSourceDuration,
  resolveStoryboardFrame,
  resolveTransition,
  splitPlacement,
  TRANSITION_TIMING,
  usedDuration,
  type ClipPlacement,
  type TransitionKind,
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

  it("stores a transition length the timing layer can act on", () => {
    assert.ok(clipTransitionSchema.safeParse({ transition: "DISSOLVE", durationSeconds: 1 }).success);
  });

  it("still accepts a transition marked before its length is decided", () => {
    // Marking a dissolve and not yet knowing how long it runs is a normal state
    // in an edit. It is stored, and the timing layer reports it as having no
    // length rather than inventing one.
    assert.ok(clipTransitionSchema.safeParse({ transition: "DISSOLVE", durationSeconds: null }).success);
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

/**
 * Phase 12.2 — transitions that affect duration.
 *
 * The rule under test: a sequence runs for the sum of its used durations minus
 * the material its transitions overlap, and only a dissolve overlaps anything.
 * The other five edit points are here too, because the interesting claim is as
 * much about what does *not* move the ruler as about what does.
 */

function withTransition(
  id: string,
  order: number,
  seconds: number,
  transition?: TransitionKind,
  length?: number | null
): TestClip {
  return clip({
    id,
    order,
    shotDurationSeconds: seconds,
    transition: transition ?? null,
    transitionDurationSeconds: length === undefined ? null : length,
  });
}

describe("what each edit point does to the ruler", () => {
  it("shortens the sequence by a dissolve's length", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 4), withTransition("c2", 1, 4, "DISSOLVE", 1)],
      facts
    );

    assert.equal(layout.straightCutSeconds, 8, "the clips still use 8 seconds between them");
    assert.equal(layout.totalSeconds, 7, "one of those seconds is played by both clips at once");
    assert.equal(layout.overlapSeconds, 1);
  });

  it("starts the incoming clip early rather than truncating either one", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 4), withTransition("c2", 1, 4, "DISSOLVE", 1)],
      facts
    );
    const [first, second] = layout.clips;

    // Both clips still play their full used length. The dissolve moves where the
    // second one sits, it does not take material away from either.
    assert.equal(first.usedSeconds, 4);
    assert.equal(second.usedSeconds, 4);
    assert.deepEqual([first.startSeconds, first.endSeconds], [0, 4]);
    assert.deepEqual([second.startSeconds, second.endSeconds], [3, 7]);
  });

  it("leaves the ruler alone for a cut and a match cut", () => {
    for (const kind of ["CUT", "MATCH_CUT"] as const) {
      const layout = layOutClips(
        [withTransition("c1", 0, 4), withTransition("c2", 1, 4, kind, 2)],
        facts
      );
      assert.equal(layout.totalSeconds, 8, `${kind} must take no time`);
      assert.equal(layout.overlapSeconds, 0);
      // The stored length is kept on the record and reported as inert rather
      // than deleted behind the filmmaker's back.
      assert.equal(layout.clips[1].transition?.statedSeconds, 2);
      assert.equal(layout.clips[1].transition?.effectiveSeconds, 0);
      assert.equal(layout.clips[1].transition?.note, "instant");
    }
  });

  it("leaves the ruler alone for a fade, which costs picture and not time", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 4), withTransition("c2", 1, 4, "FADE", 1)],
      facts
    );

    assert.equal(layout.totalSeconds, 8, "a fade runs through black over its own clip");
    assert.equal(layout.overlapSeconds, 0);
    // It still takes time — just not time off the sequence.
    assert.equal(layout.clips[1].transition?.effectiveSeconds, 1);
    assert.equal(layout.clips[1].transition?.overlapSeconds, 0);
  });

  it("leaves the picture alone for a J-cut and an L-cut, and says why", () => {
    for (const kind of ["J_CUT", "L_CUT"] as const) {
      const layout = layOutClips(
        [withTransition("c1", 0, 4), withTransition("c2", 1, 4, kind, 1.5)],
        facts
      );

      assert.equal(layout.totalSeconds, 8, `${kind} cuts the picture straight`);
      assert.equal(layout.clips[1].transition?.note, "audio-only");
      // The one thing it must never quietly become is a dissolve.
      assert.equal(layout.clips[1].transition?.overlapSeconds, 0);
      assert.match(
        describeTransitionEffect(layout.clips[1].transition!),
        /Audio tracks are not implemented yet/
      );
    }
  });

  it("covers every transition the schema accepts", () => {
    // A new edit point added to the enum without a timing decision would leave
    // this table incomplete, and the ruler would silently treat it as a cut.
    const kinds: TransitionKind[] = ["CUT", "DISSOLVE", "FADE", "MATCH_CUT", "J_CUT", "L_CUT"];
    for (const kind of kinds) {
      assert.ok(
        clipTransitionSchema.safeParse({ transition: kind, durationSeconds: null }).success,
        `${kind} must be storable`
      );
      assert.ok(TRANSITION_TIMING[kind], `${kind} must have a stated timing behaviour`);
    }
    assert.equal(Object.keys(TRANSITION_TIMING).length, kinds.length);
  });
});

describe("a transition with no length stated", () => {
  it("does not invent one", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 4), withTransition("c2", 1, 4, "DISSOLVE", null)],
      facts
    );

    assert.equal(layout.totalSeconds, 8, "an unstated length is not a default length");
    assert.equal(layout.clips[1].transition?.note, "no-length-stated");
    assert.match(describeTransitionEffect(layout.clips[1].transition!), /State a length/);
  });

  it("is a different thing from a zero-length one", () => {
    const unstated = resolveTransition("DISSOLVE", null, {
      precedingRemainingSeconds: 4,
      incomingUsedSeconds: 4,
    });
    const zero = resolveTransition("DISSOLVE", 0, {
      precedingRemainingSeconds: 4,
      incomingUsedSeconds: 4,
    });

    assert.equal(unstated.statedSeconds, null);
    assert.equal(zero.statedSeconds, 0);
    assert.equal(unstated.note, "no-length-stated");
    assert.equal(zero.note, null, "zero is an answer, so nothing limited it");
    // Both happen to move the ruler by nothing, which is exactly why the two
    // have to be distinguishable by something other than their effect.
    assert.equal(unstated.overlapSeconds, 0);
    assert.equal(zero.overlapSeconds, 0);
  });
});

describe("a dissolve limited by the material either side of it", () => {
  it("cannot be longer than the clip it dissolves from", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 2), withTransition("c2", 1, 10, "DISSOLVE", 4)],
      facts
    );

    assert.equal(layout.clips[1].overlapSeconds, 2, "the outgoing clip is only 2s long");
    assert.equal(layout.totalSeconds, 10);
    assert.equal(layout.clips[1].transition?.note, "limited-by-outgoing");
    assert.equal(layout.clips[1].startSeconds, 0, "it cannot start before the clip it mixes with");
  });

  it("cannot be longer than the clip it dissolves to", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 10), withTransition("c2", 1, 2, "DISSOLVE", 4)],
      facts
    );

    assert.equal(layout.clips[1].overlapSeconds, 2);
    assert.equal(layout.totalSeconds, 10);
    assert.equal(layout.clips[1].transition?.note, "limited-by-incoming");
  });

  it("says so in words, with the length it actually plays", () => {
    const layout = layOutClips(
      [withTransition("c1", 0, 10), withTransition("c2", 1, 2, "DISSOLVE", 4)],
      facts
    );
    const sentence = describeTransitionEffect(layout.clips[1].transition!);

    assert.match(sentence, /2s/, "the length it actually plays");
    assert.match(sentence, /4s/, "the length that was asked for");
  });

  it("has nothing to dissolve from at the head of the sequence", () => {
    const layout = layOutClips([withTransition("c1", 0, 4, "DISSOLVE", 2)], facts);

    assert.equal(layout.totalSeconds, 4);
    assert.equal(layout.clips[0].startSeconds, 0, "the edit cannot start before zero");
    assert.equal(layout.clips[0].transition?.note, "no-preceding-clip");
  });

  it("does not let two transitions claim the same seconds of one clip", () => {
    // B is 4s with a 3s dissolve at its head. Only 1s of it is left for the
    // dissolve at its tail, however long that one asks to be.
    const layout = layOutClips(
      [
        withTransition("c1", 0, 10),
        withTransition("c2", 1, 4, "DISSOLVE", 3),
        withTransition("c3", 2, 10, "DISSOLVE", 3),
      ],
      facts
    );

    assert.equal(layout.clips[1].overlapSeconds, 3);
    assert.equal(layout.clips[2].overlapSeconds, 1, "B has only 1s left to dissolve from");
    assert.equal(layout.clips[2].transition?.note, "limited-by-outgoing");
    assert.equal(layout.totalSeconds, 24 - 4);
  });

  it("counts a fade at the head against the material left for the tail", () => {
    // A fade does not overlap anything, but it still occupies the clip's head,
    // so a dissolve at the tail cannot reach back through it.
    const layout = layOutClips(
      [
        withTransition("c1", 0, 10),
        withTransition("c2", 1, 4, "FADE", 3),
        withTransition("c3", 2, 10, "DISSOLVE", 3),
      ],
      facts
    );

    assert.equal(layout.clips[1].overlapSeconds, 0, "the fade itself shortens nothing");
    assert.equal(layout.clips[2].overlapSeconds, 1);
  });

  it("gives up entirely when the previous clip has nothing left", () => {
    const layout = layOutClips(
      [
        withTransition("c1", 0, 10),
        withTransition("c2", 1, 3, "DISSOLVE", 3),
        withTransition("c3", 2, 10, "DISSOLVE", 2),
      ],
      facts
    );

    assert.equal(layout.clips[2].overlapSeconds, 0, "all of B is already under the first dissolve");
    assert.equal(layout.clips[2].transition?.note, "limited-by-outgoing");
    assert.equal(layout.totalSeconds, 23 - 3);
  });
});

describe("a fade is clamped to its own clip", () => {
  it("cannot run longer than the clip it fades up over", () => {
    const layout = layOutClips([withTransition("c1", 0, 2, "FADE", 5)], facts);

    assert.equal(layout.clips[0].transition?.effectiveSeconds, 2);
    assert.equal(layout.clips[0].transition?.note, "limited-by-incoming");
    assert.equal(layout.totalSeconds, 2, "clamping a fade still does not move the ruler");
  });

  it("works at the head of a sequence, where a dissolve would not", () => {
    // A fade up from black needs nothing before it; a dissolve does.
    const fade = layOutClips([withTransition("c1", 0, 4, "FADE", 1)], facts);
    const dissolve = layOutClips([withTransition("c1", 0, 4, "DISSOLVE", 1)], facts);

    assert.equal(fade.clips[0].transition?.note, null);
    assert.equal(dissolve.clips[0].transition?.note, "no-preceding-clip");
  });
});

describe("the playhead during a dissolve", () => {
  const layout = layOutClips(
    [withTransition("c1", 0, 4), withTransition("c2", 1, 4, "DISSOLVE", 2)],
    facts
  );
  // c1: 0–4. c2: 2–6. The mix runs 2–4.

  it("reports both clips, and how far through the mix it is", () => {
    const at3 = clipAtTime(layout, 3);
    assert.equal(at3?.entry.clip.id, "c1", "the outgoing clip is the base layer");
    assert.equal(at3?.incoming?.entry.clip.id, "c2");
    assert.equal(at3?.incoming?.progress, 0.5, "halfway through a 2s mix");
    assert.equal(at3?.offsetSeconds, 3, "3s into the outgoing clip");
    assert.equal(at3?.incoming?.offsetSeconds, 1, "1s into the incoming one");
  });

  it("runs the mix from 0 to 1 across the transition", () => {
    assert.equal(clipAtTime(layout, 2)?.incoming?.progress, 0);
    assert.equal(clipAtTime(layout, 3.9)?.incoming?.progress, 0.95);
  });

  it("reports one clip either side of the mix", () => {
    assert.equal(clipAtTime(layout, 1)?.incoming, undefined);
    assert.equal(clipAtTime(layout, 1)?.entry.clip.id, "c1");
    assert.equal(clipAtTime(layout, 5)?.incoming, undefined);
    assert.equal(clipAtTime(layout, 5)?.entry.clip.id, "c2");
  });

  it("ends when the shortened sequence ends, not when a straight cut would", () => {
    assert.equal(layout.totalSeconds, 6);
    assert.ok(clipAtTime(layout, 5.99));
    assert.equal(clipAtTime(layout, 6), undefined);
    assert.equal(clipAtTime(layout, 7), undefined, "the old 8s ruler is gone");
  });

  it("never has three clips under it at once", () => {
    // Guaranteed by the rule that two transitions cannot claim the same
    // material — so the player never has to composite more than two layers.
    const chained = layOutClips(
      [
        withTransition("c1", 0, 4),
        withTransition("c2", 1, 4, "DISSOLVE", 2),
        withTransition("c3", 2, 4, "DISSOLVE", 2),
        withTransition("c4", 3, 4, "DISSOLVE", 2),
      ],
      facts
    );

    for (let t = 0; t < chained.totalSeconds; t += 0.05) {
      const active = chained.clips.filter(
        (e) => e.usedSeconds > 0 && t >= e.startSeconds && t < e.endSeconds
      );
      assert.ok(active.length <= 2, `${active.length} clips at ${t.toFixed(2)}s`);
    }
  });
});

describe("transitions and the rest of the timing rules", () => {
  it("overlaps the trimmed length, not the shot's stated length", () => {
    // A 10s shot trimmed to 2s can only give a dissolve 2 seconds, however long
    // the shot itself is. The shot is not consulted and is not changed.
    const clips = [
      clip({ id: "c1", order: 0, shotDurationSeconds: 10, inPointSeconds: 0, outPointSeconds: 2 }),
      clip({
        id: "c2",
        order: 1,
        shotDurationSeconds: 10,
        transition: "DISSOLVE",
        transitionDurationSeconds: 5,
      }),
    ];
    const layout = layOutClips(clips, facts);

    assert.equal(layout.clips[1].overlapSeconds, 2);
    assert.equal(clips[0].shotDurationSeconds, 10, "the shot is untouched");
  });

  it("keeps the scene bands consistent with the shortened ruler", () => {
    const layout = layOutClips(
      [
        clip({ id: "c1", order: 0, sceneId: "s1", shotDurationSeconds: 4 }),
        clip({
          id: "c2",
          order: 1,
          sceneId: "s2",
          shotDurationSeconds: 4,
          transition: "DISSOLVE",
          transitionDurationSeconds: 1,
        }),
      ],
      facts
    );
    const groups = groupByScene(layout, (c) => c.sceneId);

    assert.equal(groups.length, 2);
    assert.equal(groups[1].startSeconds, 3, "the second scene starts where its first clip does");
    assert.equal(groups[groups.length - 1].endSeconds, layout.totalSeconds);
  });

  it("ignores a transition on a clip trimmed to nothing", () => {
    const layout = layOutClips(
      [
        clip({ id: "c1", order: 0, shotDurationSeconds: 4 }),
        clip({
          id: "c2",
          order: 1,
          shotDurationSeconds: 4,
          inPointSeconds: 2,
          outPointSeconds: 2,
          transition: "DISSOLVE",
          transitionDurationSeconds: 2,
        }),
        clip({ id: "c3", order: 2, shotDurationSeconds: 4 }),
      ],
      facts
    );

    assert.equal(layout.clips[1].usedSeconds, 0);
    assert.equal(layout.clips[1].overlapSeconds, 0, "nothing to mix into");
    assert.equal(layout.totalSeconds, 8);
  });

  it("reports the straight-cut runtime alongside the real one", () => {
    const layout = layOutClips(
      [
        withTransition("c1", 0, 4),
        withTransition("c2", 1, 4, "DISSOLVE", 1),
        withTransition("c3", 2, 4, "DISSOLVE", 0.5),
      ],
      facts
    );

    assert.equal(layout.straightCutSeconds, 12);
    assert.equal(layout.overlapSeconds, 1.5);
    assert.equal(layout.totalSeconds, 10.5);
    assert.equal(
      layout.totalSeconds,
      layout.straightCutSeconds - layout.overlapSeconds,
      "the three figures must always agree"
    );
  });

  it("leaves an untouched sequence exactly as long as it was", () => {
    // The regression guard for every edit that specifies no transition at all:
    // this phase must not have moved anything that was already correct.
    const layout = layOutClips(
      [withTransition("c1", 0, 6), withTransition("c2", 1, 4), withTransition("c3", 2, 2)],
      facts
    );

    assert.equal(layout.totalSeconds, 12);
    assert.equal(layout.overlapSeconds, 0);
    assert.equal(layout.straightCutSeconds, layout.totalSeconds);
    assert.deepEqual(
      layout.clips.map((e) => [e.startSeconds, e.endSeconds]),
      [
        [0, 6],
        [6, 10],
        [10, 12],
      ]
    );
  });
});
