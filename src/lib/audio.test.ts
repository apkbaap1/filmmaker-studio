import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  audioClipGainAt,
  audioClipsAtTime,
  describeAudioBoundary,
  gainToLinear,
  isAudioMimeType,
  layOutAudioTrack,
  layOutSyncAudio,
  previewCanApply,
  previewVolume,
  resolveAudioBoundary,
  sequenceRuntime,
  type AudioClipPlacement,
} from "./audio.ts";
import { layOutClips, type ClipPlacement, type TransitionKind } from "./timeline.ts";
import { audioClipSchema, audioTrackSchema } from "./validation.ts";
import { EXTENSION_BY_MIME, isSupportedMimeType, maxBytesFor } from "./storage/keys.ts";

/**
 * Phase 12.3 — sound on the ruler.
 *
 * Two things are being tested, and they are deliberately different:
 *
 *   A J- or L-cut moves a clip's *own* sound off its own picture, which is only
 *   possible where the source has material outside the trim to move into.
 *
 *   A track carries sound that belongs to no shot, placed at a stated position
 *   rather than queued behind whatever came before it.
 */

interface TestClip extends ClipPlacement {
  shotDurationSeconds?: number | null;
  assetDurationSeconds?: number | null;
  hasAudio?: boolean;
}

function pictureClip(partial: Partial<TestClip> & { id: string }): TestClip {
  return {
    shotId: `shot-${partial.id}`,
    order: 0,
    inPointSeconds: 0,
    outPointSeconds: null,
    hasAudio: true,
    ...partial,
  };
}

const pictureFacts = (c: TestClip) => ({
  shotDurationSeconds: c.shotDurationSeconds,
  assetDurationSeconds: c.assetDurationSeconds,
});

const soundFacts = (c: TestClip) => ({
  hasAudio: c.hasAudio !== false,
  sourceSeconds: c.assetDurationSeconds ?? null,
});

/** Lays out picture then sound, the way every caller does. */
function layOut(clips: TestClip[]) {
  const picture = layOutClips(clips, pictureFacts);
  return { picture, sound: layOutSyncAudio(picture, soundFacts) };
}

/** A clip whose source is longer than the piece of it the edit uses. */
function trimmed(
  id: string,
  order: number,
  opts: {
    sourceSeconds: number;
    inPointSeconds: number;
    outPointSeconds: number;
    transition?: TransitionKind;
    length?: number | null;
    audioMuted?: boolean;
    hasAudio?: boolean;
  }
): TestClip {
  return pictureClip({
    id,
    order,
    assetDurationSeconds: opts.sourceSeconds,
    inPointSeconds: opts.inPointSeconds,
    outPointSeconds: opts.outPointSeconds,
    transition: opts.transition ?? null,
    transitionDurationSeconds: opts.length === undefined ? null : opts.length,
    audioMuted: opts.audioMuted,
    hasAudio: opts.hasAudio,
  });
}

describe("gain", () => {
  it("converts decibels to a linear factor", () => {
    assert.equal(gainToLinear(0), 1);
    // -6 dB is a half in amplitude, to three places.
    assert.ok(Math.abs(gainToLinear(-6) - 0.501) < 0.001);
    assert.ok(Math.abs(gainToLinear(6) - 1.995) < 0.001);
    assert.ok(gainToLinear(-60) < 0.002);
  });

  it("treats an unstated level as unity, not as zero", () => {
    // The distinction the whole schema turns on: nobody choosing a level and
    // somebody choosing 0 dB sound the same but are not the same record.
    assert.equal(gainToLinear(null), 1);
    assert.equal(gainToLinear(undefined), 1);
    assert.equal(gainToLinear(0), 1);
  });

  it("reports the boost a preview element cannot apply", () => {
    assert.equal(previewCanApply(gainToLinear(-6)), true);
    assert.equal(previewCanApply(gainToLinear(0)), true);
    assert.equal(previewCanApply(gainToLinear(6)), false, "volume tops out at 1");
    // Clamped rather than thrown away, so the preview is quiet-correct and the
    // stored level is still what the mix asked for.
    assert.equal(previewVolume(gainToLinear(6)), 1);
    assert.equal(previewVolume(-1), 0);
  });
});

describe("a J-cut", () => {
  it("starts this clip's sound before its picture", () => {
    // B is trimmed 2s off the head of its source, so there are 2s of sound to
    // reveal early.
    const { picture, sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 2,
        outPointSeconds: 6,
        transition: "J_CUT",
        length: 1,
      }),
    ]);

    // The picture is untouched: still two 4s clips, cut at 4s.
    assert.equal(picture.totalSeconds, 8);
    assert.deepEqual(
      picture.clips.map((e) => [e.startSeconds, e.endSeconds]),
      [
        [0, 4],
        [4, 8],
      ]
    );

    const [first, second] = sound.segments;
    assert.equal(second.startSeconds, 3, "B's sound starts 1s before B's picture");
    assert.equal(first.endSeconds, 3, "and A's sound ends there, not at the picture cut");
    assert.equal(second.sourceInSeconds, 1, "B plays from 1s, a second before its in point");
  });

  it("cannot reach back through the start of the file", () => {
    // B starts at the very beginning of its source: there is no earlier sound.
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 0,
        outPointSeconds: 4,
        transition: "J_CUT",
        length: 2,
      }),
    ]);

    assert.equal(sound.segments[1].startSeconds, 4, "the sound cuts with the picture");
    assert.equal(sound.segments[1].headBoundary?.note, "no-head-handle");
    assert.match(
      describeAudioBoundary(sound.segments[1].headBoundary!),
      /Trim the head/,
      "the fix is named, not just the failure"
    );
  });

  it("is shortened to the handle that exists", () => {
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 0.5,
        outPointSeconds: 4.5,
        transition: "J_CUT",
        length: 3,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, -0.5);
    assert.equal(sound.segments[1].headBoundary?.note, "no-head-handle");
    assert.equal(sound.segments[1].startSeconds, 3.5);
  });

  it("cannot take more sound than the previous clip has", () => {
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 1 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 5,
        outPointSeconds: 9,
        transition: "J_CUT",
        length: 4,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, -1, "A is only 1s long");
    assert.equal(sound.segments[1].headBoundary?.note, "limited-by-outgoing");
    assert.equal(sound.segments[0].endSeconds, 0, "A's sound is entirely under B's");
  });
});

describe("an L-cut", () => {
  it("carries the previous clip's sound past the picture cut", () => {
    // A is trimmed 6s short of the end of its source, so its sound can run on.
    const { picture, sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 0,
        outPointSeconds: 4,
        transition: "L_CUT",
        length: 1.5,
      }),
    ]);

    assert.equal(picture.totalSeconds, 8, "the picture is untouched");
    assert.equal(sound.segments[0].endSeconds, 5.5, "A's sound runs 1.5s past its picture");
    assert.equal(sound.segments[0].sourceOutSeconds, 5.5, "playing 1.5s past its out point");
    assert.equal(sound.segments[1].startSeconds, 5.5, "B's sound starts when A's stops");
  });

  it("cannot run past the end of the file", () => {
    // A runs to the very end of its source: there is no later sound.
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 4, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 0,
        outPointSeconds: 4,
        transition: "L_CUT",
        length: 2,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, 0);
    assert.equal(sound.segments[1].headBoundary?.note, "no-tail-handle");
    assert.match(describeAudioBoundary(sound.segments[1].headBoundary!), /Trim its tail/);
  });

  it("refuses to run off an unmeasured source rather than guessing where it ends", () => {
    // Nothing has decoded this file, so where its sound stops is unknown. An
    // L-cut off it would be playing material nobody has established exists.
    const picture = layOutClips(
      [
        pictureClip({ id: "a", order: 0, shotDurationSeconds: 4 }),
        pictureClip({
          id: "b",
          order: 1,
          shotDurationSeconds: 4,
          transition: "L_CUT",
          transitionDurationSeconds: 2,
        }),
      ],
      pictureFacts
    );
    const sound = layOutSyncAudio(picture, () => ({ hasAudio: true, sourceSeconds: null }));

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, 0);
    assert.equal(sound.segments[1].headBoundary?.note, "no-tail-handle");
  });

  it("pushes the sequence's sound past its last picture frame", () => {
    const { picture, sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 0,
        outPointSeconds: 4,
        transition: "L_CUT",
        length: 1,
      }),
    ]);

    assert.equal(picture.totalSeconds, 8);
    assert.equal(sound.endSeconds, 8, "the last clip has no L-cut after it");

    const runtime = sequenceRuntime(picture.totalSeconds, sound.endSeconds, []);
    assert.equal(runtime.totalSeconds, 8);
    assert.equal(sound.segments[0].endSeconds, 5, "but A's sound did run past its own picture");
  });
});

describe("audio boundaries in general", () => {
  it("does not invent a length for a cut marked without one", () => {
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 2, outPointSeconds: 6 }),
      trimmed("b", 1, {
        sourceSeconds: 10,
        inPointSeconds: 2,
        outPointSeconds: 6,
        transition: "J_CUT",
        length: null,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, 0);
    assert.equal(sound.segments[1].headBoundary?.note, "no-length-stated");
    assert.equal(sound.segments[1].startSeconds, 4, "sound cuts with picture");
  });

  it("has nothing to move at the head of the sequence", () => {
    const { sound } = layOut([
      trimmed("a", 0, {
        sourceSeconds: 10,
        inPointSeconds: 2,
        outPointSeconds: 6,
        transition: "J_CUT",
        length: 1,
      }),
    ]);

    assert.equal(sound.segments[0].headBoundary?.note, "no-preceding-clip");
    assert.equal(sound.segments[0].startSeconds, 0);
  });

  it("leaves sound under its own picture for every other edit point", () => {
    for (const kind of ["CUT", "DISSOLVE", "FADE", "MATCH_CUT"] as const) {
      const { picture, sound } = layOut([
        trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 2, outPointSeconds: 6 }),
        trimmed("b", 1, {
          sourceSeconds: 10,
          inPointSeconds: 2,
          outPointSeconds: 6,
          transition: kind,
          length: 1,
        }),
      ]);

      for (const [i, segment] of sound.segments.entries()) {
        assert.equal(segment.startSeconds, picture.clips[i].startSeconds, `${kind} head`);
        assert.equal(segment.endSeconds, picture.clips[i].endSeconds, `${kind} tail`);
        assert.equal(segment.offsetFromPicture, false, `${kind} must not move the sound`);
      }
    }
  });

  it("does not let two boundaries claim the same sound", () => {
    // The L-cut at B's head makes B's sound start 2s late, so only 2s of it
    // are left — and the J-cut at C's head can have no more than that,
    // whatever it asks for.
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 20, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 20,
        inPointSeconds: 8,
        outPointSeconds: 12,
        transition: "L_CUT",
        length: 2,
      }),
      trimmed("c", 2, {
        sourceSeconds: 20,
        inPointSeconds: 8,
        outPointSeconds: 12,
        transition: "J_CUT",
        length: 4,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, 2);
    assert.equal(sound.segments[2].headBoundary?.offsetSeconds, -2, "B has only 2s of sound left");
    assert.equal(sound.segments[2].headBoundary?.note, "limited-by-outgoing");
    // Every segment still runs forwards.
    for (const segment of sound.segments) {
      assert.ok(segment.endSeconds >= segment.startSeconds, "a segment cannot end before it starts");
    }
  });

  it("lets a J-cut at a clip's head give the next boundary more to work with", () => {
    // The reverse of the case above, and the one worth stating because it is
    // counter-intuitive: a J-cut at B's head reveals B's sound early, which
    // makes B's sound *longer*, not shorter. A J-cut at C's head can then take
    // more of it than B's picture length alone would allow.
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 20, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 20,
        inPointSeconds: 8,
        outPointSeconds: 12,
        transition: "J_CUT",
        length: 2,
      }),
      trimmed("c", 2, {
        sourceSeconds: 20,
        inPointSeconds: 8,
        outPointSeconds: 12,
        transition: "J_CUT",
        length: 5,
      }),
    ]);

    assert.equal(sound.segments[1].headBoundary?.offsetSeconds, -2);
    // B's picture is 4s, but its sound is 6s, so a 5s J-cut off it fits.
    assert.equal(sound.segments[2].headBoundary?.offsetSeconds, -5);
    assert.equal(sound.segments[2].headBoundary?.note, null);
    assert.equal(sound.segments[1].startSeconds, 2, "B's sound: 2s");
    assert.equal(sound.segments[1].endSeconds, 3, "to 3s, where C's takes over");
    for (const segment of sound.segments) {
      assert.ok(segment.endSeconds >= segment.startSeconds);
    }
  });

  it("measures a J-cut from where a dissolve actually left the clips", () => {
    // The dissolve pulls C back by 1s; the J-cut at C's head is measured from
    // there, not from where a straight cut would have put it.
    const { picture, sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 20, inPointSeconds: 0, outPointSeconds: 4 }),
      trimmed("b", 1, {
        sourceSeconds: 20,
        inPointSeconds: 4,
        outPointSeconds: 8,
        transition: "DISSOLVE",
        length: 1,
      }),
      trimmed("c", 2, {
        sourceSeconds: 20,
        inPointSeconds: 4,
        outPointSeconds: 8,
        transition: "J_CUT",
        length: 1,
      }),
    ]);

    assert.equal(picture.clips[2].startSeconds, 7, "A 0–4, B 3–7, C 7–11");
    assert.equal(sound.segments[2].startSeconds, 6, "one second before C's picture at 7s");
  });
});

describe("the boundary resolver on its own", () => {
  const side = (over: Partial<Parameters<typeof resolveAudioBoundary>[2]["incoming"]> = {}) => ({
    usedSeconds: 4,
    inPointSeconds: 3,
    outPointSeconds: 7,
    sourceSeconds: 12,
    headOffsetSeconds: 0,
    ...over,
  });

  it("signs a J-cut negative and an L-cut positive", () => {
    // The sign is the whole contract: one number serves as the tail offset of
    // the clip before and the head offset of the clip after, so which way it
    // points has to be unambiguous.
    const j = resolveAudioBoundary("J_CUT", 1, { outgoing: side(), incoming: side() });
    const l = resolveAudioBoundary("L_CUT", 1, { outgoing: side(), incoming: side() });

    assert.equal(j.offsetSeconds, -1, "a J-cut pulls the sound earlier");
    assert.equal(l.offsetSeconds, 1, "an L-cut pushes it later");
    assert.equal(j.note, null);
    assert.equal(l.note, null);
  });

  it("refuses a negative stated length rather than reversing the cut", () => {
    const resolved = resolveAudioBoundary("J_CUT", -3, { outgoing: side(), incoming: side() });
    assert.equal(resolved.offsetSeconds, 0);
  });

  it("counts the outgoing clip's own head offset against what it has to give", () => {
    // Its sound already starts a second late, so there is a second less of it.
    const resolved = resolveAudioBoundary("J_CUT", 4, {
      outgoing: side({ usedSeconds: 4, headOffsetSeconds: 1 }),
      incoming: side({ inPointSeconds: 10 }),
    });

    assert.equal(resolved.offsetSeconds, -3);
    assert.equal(resolved.note, "limited-by-outgoing");
  });

  it("keeps the stated length on the record even when nothing could be done with it", () => {
    const resolved = resolveAudioBoundary("L_CUT", 5, {
      outgoing: side({ outPointSeconds: 12, sourceSeconds: 12 }),
      incoming: side(),
    });

    assert.equal(resolved.statedSeconds, 5, "what was asked for");
    assert.equal(resolved.offsetSeconds, 0, "what happened");
    assert.equal(resolved.note, "no-tail-handle", "and why");
  });
});

describe("a clip's sound can be switched off", () => {
  it("plays silent without touching anything else", () => {
    const { picture, sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4, audioMuted: true }),
      trimmed("b", 1, { sourceSeconds: 10, inPointSeconds: 0, outPointSeconds: 4 }),
    ]);

    assert.equal(sound.segments[0].silent, true);
    assert.equal(sound.segments[0].silentReason, "muted");
    assert.equal(sound.segments[1].silent, false);
    // The picture, the trim and the sound's position are all unchanged: a mute
    // is a decision about the mix, not about the edit.
    assert.equal(picture.totalSeconds, 8);
    assert.deepEqual(
      [sound.segments[0].startSeconds, sound.segments[0].endSeconds],
      [0, 4]
    );
  });

  it("says when a clip has no sound to play rather than calling it muted", () => {
    const { sound } = layOut([
      trimmed("a", 0, { sourceSeconds: 4, inPointSeconds: 0, outPointSeconds: 4, hasAudio: false }),
    ]);

    assert.equal(sound.segments[0].silent, true);
    assert.equal(sound.segments[0].silentReason, "no-audio");
  });
});

// --- tracks ------------------------------------------------------------------

function audioClip(partial: Partial<AudioClipPlacement> & { id: string }): AudioClipPlacement {
  return {
    assetId: `asset-${partial.id}`,
    startSeconds: 0,
    inPointSeconds: 0,
    outPointSeconds: null,
    ...partial,
  };
}

describe("an audio track", () => {
  const measured = (seconds: number | null) => () => seconds;

  it("places sound where it was put, not after the previous sound", () => {
    // The gap is the point: silence between two cues is a decision.
    const track = layOutAudioTrack(
      [audioClip({ id: "c1", startSeconds: 0 }), audioClip({ id: "c2", startSeconds: 10 })],
      measured(4)
    );

    assert.deepEqual(
      track.clips.map((c) => [c.startSeconds, c.endSeconds]),
      [
        [0, 4],
        [10, 14],
      ]
    );
    assert.equal(track.endSeconds, 14);
  });

  it("orders by position rather than by an order column", () => {
    const track = layOutAudioTrack(
      [audioClip({ id: "late", startSeconds: 9 }), audioClip({ id: "early", startSeconds: 1 })],
      measured(2)
    );
    assert.deepEqual(track.clips.map((c) => c.clip.id), ["early", "late"]);
  });

  it("reports an unmeasured file as having no length instead of guessing one", () => {
    const track = layOutAudioTrack([audioClip({ id: "c1", startSeconds: 2 })], measured(null));

    assert.equal(track.clips[0].measured, false);
    assert.equal(track.clips[0].endSeconds, null);
    assert.equal(track.clips[0].usedSeconds, null);
    assert.equal(track.endSeconds, null, "a track of unknown lengths has no known end");
  });

  it("uses a stated out point even when the file has never been decoded", () => {
    const track = layOutAudioTrack(
      [audioClip({ id: "c1", startSeconds: 2, outPointSeconds: 5 })],
      measured(null)
    );
    assert.equal(track.clips[0].endSeconds, 7);
    assert.equal(track.clips[0].measured, false, "stated is not the same as measured");
  });

  it("clamps a trim that outlived its media", () => {
    const track = layOutAudioTrack(
      [audioClip({ id: "c1", startSeconds: 0, outPointSeconds: 30 })],
      measured(8)
    );
    assert.equal(track.clips[0].endSeconds, 8);
  });

  it("flags two placements playing at once rather than moving one", () => {
    // Two sounds at once is a mix, not a mistake, and it is not this layer's
    // place to decide which one should have moved.
    const track = layOutAudioTrack(
      [audioClip({ id: "c1", startSeconds: 0 }), audioClip({ id: "c2", startSeconds: 2 })],
      measured(4)
    );

    assert.equal(track.clips[0].overlapsPrevious, false);
    assert.equal(track.clips[1].overlapsPrevious, true);
    assert.equal(track.clips[0].endSeconds, 4, "neither is shortened");
    assert.equal(track.clips[1].endSeconds, 6);
  });

  it("clamps a fade to the sound it ramps", () => {
    const track = layOutAudioTrack(
      [audioClip({ id: "c1", startSeconds: 0, fadeInSeconds: 10, fadeOutSeconds: 1 })],
      measured(4)
    );
    assert.equal(track.clips[0].fadeInSeconds, 4);
    assert.equal(track.clips[0].fadeOutSeconds, 1);
  });

  it("keeps 'no fade asked for' distinct from a fade of zero", () => {
    const none = layOutAudioTrack([audioClip({ id: "c1" })], measured(4));
    const zero = layOutAudioTrack([audioClip({ id: "c1", fadeInSeconds: 0 })], measured(4));

    assert.equal(none.clips[0].fadeInSeconds, null);
    assert.equal(zero.clips[0].fadeInSeconds, 0);
  });
});

describe("levels over time", () => {
  const track = layOutAudioTrack(
    [audioClip({ id: "c1", startSeconds: 0, fadeInSeconds: 2, fadeOutSeconds: 2 })],
    () => 10
  );

  it("ramps a fade in linearly and reaches unity", () => {
    assert.equal(audioClipGainAt(track.clips[0], 0, null), 0);
    assert.equal(audioClipGainAt(track.clips[0], 1, null), 0.5);
    assert.equal(audioClipGainAt(track.clips[0], 2, null), 1);
    assert.equal(audioClipGainAt(track.clips[0], 5, null), 1);
  });

  it("ramps a fade out down to the last moment", () => {
    assert.equal(audioClipGainAt(track.clips[0], 8, null), 1);
    assert.equal(audioClipGainAt(track.clips[0], 9, null), 0.5);
  });

  it("is silent outside the placement", () => {
    assert.equal(audioClipGainAt(track.clips[0], -1, null), 0);
    assert.equal(audioClipGainAt(track.clips[0], 10, null), 0, "half-open at the end");
  });

  it("multiplies the clip's level by the track's", () => {
    const flat = layOutAudioTrack([audioClip({ id: "c1", gainDb: -6 })], () => 10);
    const clipOnly = audioClipGainAt(flat.clips[0], 5, null);
    const both = audioClipGainAt(flat.clips[0], 5, -6);

    assert.ok(Math.abs(clipOnly - gainToLinear(-6)) < 1e-9);
    assert.ok(Math.abs(both - gainToLinear(-12)) < 1e-9, "-6 dB on -6 dB is -12 dB");
  });

  it("reports what is sounding at a moment, and where in the file", () => {
    const two = layOutAudioTrack(
      [
        audioClip({ id: "c1", startSeconds: 0, inPointSeconds: 3 }),
        audioClip({ id: "c2", startSeconds: 1 }),
      ],
      () => 10
    );
    const active = audioClipsAtTime(two, 2, null);

    assert.deepEqual(active.map((a) => a.laidOut.clip.id), ["c1", "c2"]);
    assert.equal(active[0].sourceSeconds, 5, "2s in, from an in point of 3s");
    assert.equal(active[1].sourceSeconds, 1);
  });

  it("plays nothing from a placement of unknown length", () => {
    const unmeasured = layOutAudioTrack([audioClip({ id: "c1" })], () => null);
    assert.deepEqual(audioClipsAtTime(unmeasured, 1, null), []);
  });
});

describe("the sequence's runtime once sound is counted", () => {
  it("runs to the longer of the cut and the mix", () => {
    const runtime = sequenceRuntime(42, 42, [60, 12, null]);

    assert.equal(runtime.pictureSeconds, 42);
    assert.equal(runtime.audioSeconds, 60, "a music bed outlasting the last shot");
    assert.equal(runtime.totalSeconds, 60);
  });

  it("keeps the two figures apart when the picture is the longer one", () => {
    const runtime = sequenceRuntime(42, 40, [null]);
    assert.equal(runtime.audioSeconds, 40);
    assert.equal(runtime.totalSeconds, 42);
  });

  it("ignores tracks whose length is not known", () => {
    const runtime = sequenceRuntime(10, 10, [null, null]);
    assert.equal(runtime.totalSeconds, 10);
  });
});

// --- the write boundary ------------------------------------------------------

describe("audio validation", () => {
  it("accepts every role a track can carry", () => {
    for (const role of ["DIALOGUE", "MUSIC", "SFX", "AMBIENCE"]) {
      assert.ok(audioTrackSchema.safeParse({ name: "T", role, gainDb: null, muted: false }).success);
    }
  });

  it("rejects an invented role", () => {
    assert.equal(
      audioTrackSchema.safeParse({ name: "T", role: "FOLEY", gainDb: null, muted: false }).success,
      false
    );
  });

  it("keeps an unstated level reachable", () => {
    const unstated = audioTrackSchema.parse({ name: "T", role: "MUSIC", gainDb: null, muted: false });
    const unity = audioTrackSchema.parse({ name: "T", role: "MUSIC", gainDb: 0, muted: false });
    assert.equal(unstated.gainDb, null);
    assert.equal(unity.gainDb, 0);
  });

  it("refuses a level outside what a preview mix should ask for", () => {
    assert.equal(audioTrackSchema.safeParse({ name: "T", role: "MUSIC", gainDb: 40, muted: false }).success, false);
    assert.equal(audioTrackSchema.safeParse({ name: "T", role: "MUSIC", gainDb: -200, muted: false }).success, false);
  });

  const placement = {
    startSeconds: 4,
    inPointSeconds: 0,
    outPointSeconds: null,
    gainDb: null,
    fadeInSeconds: null,
    fadeOutSeconds: null,
  };

  it("accepts a placement with nothing but a position", () => {
    assert.ok(audioClipSchema.safeParse(placement).success);
  });

  it("refuses an out point before the in point", () => {
    assert.equal(
      audioClipSchema.safeParse({ ...placement, inPointSeconds: 5, outPointSeconds: 2 }).success,
      false
    );
  });

  it("refuses a negative position", () => {
    assert.equal(audioClipSchema.safeParse({ ...placement, startSeconds: -1 }).success, false);
  });
});

describe("audio as stored media", () => {
  it("accepts the formats a browser will actually play", () => {
    for (const mime of ["audio/mpeg", "audio/wav", "audio/ogg", "audio/aac", "audio/flac"]) {
      assert.ok(isSupportedMimeType(mime), `${mime} must be storable`);
      assert.ok(EXTENSION_BY_MIME[mime], `${mime} must have an extension`);
      assert.ok(isAudioMimeType(mime));
    }
  });

  it("still refuses a format nothing here can open", () => {
    assert.equal(isSupportedMimeType("audio/x-aiff"), false);
    assert.equal(isSupportedMimeType("application/octet-stream"), false);
  });

  it("gives audio its own size ceiling, between an image and a video", () => {
    const image = maxBytesFor("image/png");
    const audio = maxBytesFor("audio/wav");
    const video = maxBytesFor("video/mp4");
    assert.ok(audio > image && audio < video, `${image} < ${audio} < ${video}`);
  });

  it("does not mistake other media for audio", () => {
    assert.equal(isAudioMimeType("video/mp4"), false);
    assert.equal(isAudioMimeType("image/png"), false);
  });
});
