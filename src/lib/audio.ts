import {
  formatDuration,
  roundSeconds as round,
  type ClipPlacement,
  type LaidOutClip,
  type TimelineLayout,
} from "./timeline.ts";

/**
 * Audio timing — sound on the sequence's ruler.
 *
 * Like the picture half in `timeline.ts`, this knows nothing about the database,
 * React or the DOM. It takes placements plus what has actually been measured
 * about the media and returns where every sound sits.
 *
 * There are two kinds of sound here, and keeping them apart is the point:
 *
 *   SYNC AUDIO   the sound inside the video a clip plays. It belongs to the
 *                shot, it is not a separate record, and it moves when the clip
 *                moves. This is what a J- or L-cut acts on.
 *
 *   TRACK AUDIO  a score, a narration pass, room tone — material placed against
 *                the picture rather than belonging to any shot. It lives on an
 *                AudioTrack, carries its own position on the ruler, and a
 *                deliberate silence between two placements is a normal thing
 *                rather than a gap to close.
 *
 * Nothing here writes a level, a length or a position that was not stated. An
 * unmeasured file has an unknown length and says so; it does not get a
 * plausible-looking default that would put the rest of the track in the wrong
 * place.
 */

// --- gain --------------------------------------------------------------------

/**
 * Decibels to a linear factor.
 *
 * Null is unity — no level was stated, which is not the same as a level of
 * 0 dB having been chosen, even though the two produce the same sound. The
 * distinction is kept for the same reason it is kept everywhere else in this
 * codebase: a value nobody set must stay distinguishable from one somebody did.
 */
export function gainToLinear(gainDb: number | null | undefined): number {
  if (gainDb === null || gainDb === undefined || !Number.isFinite(gainDb)) return 1;
  return 10 ** (gainDb / 20);
}

/**
 * What an `HTMLMediaElement.volume` can actually be set to.
 *
 * That property tops out at 1, so a boost above unity cannot be previewed
 * without the Web Audio API. Rather than pretend, the factor is clamped here and
 * `gainIsAudible` below reports when the preview is quieter than the mix asks
 * for, so the UI can say so instead of the filmmaker wondering why +6 dB sounds
 * like 0.
 */
export function previewVolume(linearGain: number): number {
  if (!Number.isFinite(linearGain) || linearGain < 0) return 0;
  return Math.min(1, linearGain);
}

/** True when the preview can reproduce this gain exactly. */
export function previewCanApply(linearGain: number): boolean {
  return Number.isFinite(linearGain) && linearGain >= 0 && linearGain <= 1;
}

// --- J- and L-cuts -----------------------------------------------------------

export type AudioCutKind = "J_CUT" | "L_CUT";

/**
 * Why the audio boundary did not move as far as it was asked to.
 *
 * `no-head-handle` and `no-tail-handle` are the two that only exist once there
 * is sound: revealing a clip's audio early means playing material from *before*
 * its in point, and a clip trimmed hard against the head of its source has none
 * to play. A picture-only timeline never had to care.
 */
export type AudioBoundaryNote =
  | "no-length-stated"
  | "no-preceding-clip"
  | "no-head-handle"
  | "no-tail-handle"
  | "limited-by-outgoing"
  | "limited-by-incoming";

export interface ResolvedAudioBoundary {
  kind: AudioCutKind;
  statedSeconds: number | null;
  /**
   * Signed seconds, applied to both sides of the boundary: negative when the
   * audio edit happens before the picture edit (a J-cut — you hear the next
   * shot first), positive when it happens after (an L-cut — the previous shot's
   * sound carries over).
   */
  offsetSeconds: number;
  note: AudioBoundaryNote | null;
}

/** What the timing layer needs to know about one side of an audio boundary. */
export interface AudioSideFacts {
  /** The clip's picture length on the ruler. */
  usedSeconds: number;
  /** Where its used range starts in the source. */
  inPointSeconds: number;
  /** Where its used range ends in the source. */
  outPointSeconds: number;
  /** The whole source's length, when it has been measured. */
  sourceSeconds: number;
  /** The head offset already applied to this clip, so two boundaries cannot
   * claim the same audio. Signed, in the same sense as `offsetSeconds`. */
  headOffsetSeconds: number;
}

/**
 * Resolves one audio boundary against the material either side of it.
 *
 * The whole of a J- or L-cut is this one number. A J-cut at B's head means B's
 * sound starts early *and* A's sound ends early by the same amount; an L-cut
 * means both end late. So a single signed offset serves as the tail offset of
 * the clip before and the head offset of the clip after, and there is no way for
 * the two sides to disagree about where the sound changes.
 *
 * What limits it is real material, not a rule:
 *
 *   A J-cut plays B's source from before B's in point, so it needs B to have
 *   been trimmed off the head of its source. A clip starting at 0 has no handle
 *   and the cut cannot reach back through the start of the file.
 *
 *   An L-cut plays A's source past A's out point, so it needs A to have been
 *   trimmed off the tail. A clip running to the end of its source has nothing
 *   left to carry over.
 *
 * Both also stop before either clip's sound is swallowed entirely.
 */
export function resolveAudioBoundary(
  kind: AudioCutKind,
  statedSeconds: number | null,
  context: { outgoing: AudioSideFacts | null; incoming: AudioSideFacts }
): ResolvedAudioBoundary {
  const inert = { kind, statedSeconds, offsetSeconds: 0 };

  if (statedSeconds === null) return { ...inert, note: "no-length-stated" };
  if (context.outgoing === null) return { ...inert, note: "no-preceding-clip" };

  const { outgoing, incoming } = context;
  // Sound the outgoing clip still has: its picture length, plus or minus
  // whatever its own head boundary already did to it.
  const outgoingAudio = Math.max(0, outgoing.usedSeconds - outgoing.headOffsetSeconds);

  const limits: Array<{ seconds: number; note: AudioBoundaryNote }> =
    kind === "J_CUT"
      ? [
          // Material before B's in point, to reveal early.
          { seconds: Math.max(0, incoming.inPointSeconds), note: "no-head-handle" },
          // A's sound has to give up that much.
          { seconds: outgoingAudio, note: "limited-by-outgoing" },
        ]
      : [
          // Material past A's out point, to carry over.
          {
            seconds: Math.max(0, outgoing.sourceSeconds - outgoing.outPointSeconds),
            note: "no-tail-handle",
          },
          // B's sound has to start that much later and still exist.
          { seconds: Math.max(0, incoming.usedSeconds), note: "limited-by-incoming" },
        ];

  let magnitude = Math.max(0, statedSeconds);
  let note: AudioBoundaryNote | null = null;
  for (const limit of limits) {
    if (limit.seconds < magnitude) {
      magnitude = limit.seconds;
      note = limit.note;
    }
  }

  return {
    kind,
    statedSeconds,
    // Zero is written out plainly rather than negated into -0, which compares
    // unequal to 0 under Object.is and would read as a leftward offset of
    // nothing in anything that looked at it.
    offsetSeconds: magnitude === 0 ? 0 : round(kind === "J_CUT" ? -magnitude : magnitude),
    note,
  };
}

/** One sentence saying what this audio boundary does, and what stopped it. */
export function describeAudioBoundary(resolved: ResolvedAudioBoundary): string {
  const name = resolved.kind === "J_CUT" ? "J-cut" : "L-cut";
  const stated = resolved.statedSeconds === null ? null : formatDuration(resolved.statedSeconds);
  const actual = formatDuration(Math.abs(resolved.offsetSeconds));

  switch (resolved.note) {
    case "no-length-stated":
      return `Marked as a ${name} with no length, so the sound cuts with the picture. State a length to move it.`;
    case "no-preceding-clip":
      return `Nothing precedes this clip, so there is no boundary for a ${name} to move.`;
    case "no-head-handle":
      return resolved.offsetSeconds === 0
        ? `A ${name} plays this clip's sound from before its in point, and this clip starts at the very beginning of its source. Trim the head to give it something to reveal.`
        : `Runs ${actual}, not ${stated}: this clip has only ${actual} trimmed off the head of its source to reveal early.`;
    case "no-tail-handle":
      return resolved.offsetSeconds === 0
        ? `A ${name} carries the previous clip's sound past its out point, and that clip runs to the end of its source. Trim its tail to give it something to carry over.`
        : `Runs ${actual}, not ${stated}: the previous clip has only ${actual} left past its out point.`;
    case "limited-by-outgoing":
      return `Runs ${actual}, not ${stated}: the previous clip has no more sound to give up.`;
    case "limited-by-incoming":
      return `Runs ${actual}, not ${stated}: this clip is not long enough for the whole ${name}.`;
    case null:
      break;
  }

  if (resolved.offsetSeconds === 0) return `A ${formatDuration(0)} ${name} cuts with the picture.`;
  return resolved.kind === "J_CUT"
    ? `This clip's sound starts ${actual} before its picture — you hear it before you see it. The picture cut and the edit's length are unchanged.`
    : `The previous clip's sound carries ${actual} past the picture cut. The picture cut and the edit's length are unchanged.`;
}

// --- sync audio --------------------------------------------------------------

/** What a picture clip contributes in sound. */
export interface SyncAudioFacts {
  /** False for a storyboard frame, or a video with no audio stream. */
  hasAudio: boolean;
  /** The source's measured length, when a player has decoded it. */
  sourceSeconds: number | null;
}

export interface SyncAudioSegment<T extends ClipPlacement = ClipPlacement> {
  clip: T;
  /** Where this clip's sound plays on the ruler. */
  startSeconds: number;
  endSeconds: number;
  /** The range of the source it plays. */
  sourceInSeconds: number;
  sourceOutSeconds: number;
  /** The boundary at this clip's head, when one moved the sound. */
  headBoundary?: ResolvedAudioBoundary;
  /** The boundary at the next clip's head, when one moved this clip's tail. */
  tailBoundary?: ResolvedAudioBoundary;
  /** True when the sound is offset from its own picture at either end. */
  offsetFromPicture: boolean;
  /** No sound will come out: nothing to play, or the clip is muted. */
  silent: boolean;
  /** Why it is silent. Null when it is not. */
  silentReason: "muted" | "no-audio" | null;
}

export interface SyncAudioLayout<T extends ClipPlacement = ClipPlacement> {
  segments: Array<SyncAudioSegment<T>>;
  /** Where the sound ends, which an L-cut can push past the last picture frame. */
  endSeconds: number;
}

/**
 * Where every picture clip's own sound plays.
 *
 * Runs over the picture layout rather than the raw placements, because a J-cut's
 * reach depends on where the clips actually ended up — which dissolves have
 * already decided.
 */
export function layOutSyncAudio<T extends ClipPlacement>(
  layout: TimelineLayout<T>,
  factsFor: (clip: T) => SyncAudioFacts
): SyncAudioLayout<T> {
  const entries = layout.clips;

  const sideFor = (entry: LaidOutClip<T>, headOffsetSeconds: number): AudioSideFacts => {
    const facts = factsFor(entry.clip);
    const inPoint = Math.max(0, entry.clip.inPointSeconds);
    return {
      usedSeconds: entry.usedSeconds,
      inPointSeconds: inPoint,
      outPointSeconds: round(inPoint + entry.usedSeconds),
      // An unmeasured source has no known tail, so an L-cut off it is refused
      // rather than allowed to run past an edge nobody has found yet.
      sourceSeconds: facts.sourceSeconds ?? round(inPoint + entry.usedSeconds),
      headOffsetSeconds,
    };
  };

  // Resolved left to right: each boundary's reach depends on what the previous
  // one already took out of the clip they share.
  const boundaries: Array<ResolvedAudioBoundary | undefined> = [];
  let headOffset = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const kind = entries[i].clip.transition;
    if (kind !== "J_CUT" && kind !== "L_CUT") {
      boundaries.push(undefined);
      headOffset = 0;
      continue;
    }
    const previous = i === 0 ? null : sideFor(entries[i - 1], headOffset);
    const resolved = resolveAudioBoundary(
      kind,
      entries[i].clip.transitionDurationSeconds ?? null,
      { outgoing: previous, incoming: sideFor(entries[i], 0) }
    );
    boundaries.push(resolved);
    headOffset = resolved.offsetSeconds;
  }

  let endSeconds = 0;
  const segments = entries.map((entry, i) => {
    const facts = factsFor(entry.clip);
    const head = boundaries[i];
    const tail = boundaries[i + 1];
    const headOffsetSeconds = head?.offsetSeconds ?? 0;
    const tailOffsetSeconds = tail?.offsetSeconds ?? 0;

    const startSeconds = round(Math.max(0, entry.startSeconds + headOffsetSeconds));
    const endOfSegment = round(Math.max(startSeconds, entry.endSeconds + tailOffsetSeconds));
    const inPoint = Math.max(0, entry.clip.inPointSeconds);

    endSeconds = Math.max(endSeconds, endOfSegment);
    const muted = entry.clip.audioMuted === true;

    return {
      clip: entry.clip,
      startSeconds,
      endSeconds: endOfSegment,
      sourceInSeconds: round(Math.max(0, inPoint + headOffsetSeconds)),
      sourceOutSeconds: round(inPoint + entry.usedSeconds + tailOffsetSeconds),
      headBoundary: head,
      tailBoundary: tail,
      offsetFromPicture: headOffsetSeconds !== 0 || tailOffsetSeconds !== 0,
      silent: muted || !facts.hasAudio,
      silentReason: muted ? ("muted" as const) : facts.hasAudio ? null : ("no-audio" as const),
    };
  });

  return { segments, endSeconds: round(endSeconds) };
}

// --- audio tracks ------------------------------------------------------------

export interface AudioClipPlacement {
  id: string;
  assetId: string;
  /** Where on the ruler this placement starts. Stated, never queued. */
  startSeconds: number;
  inPointSeconds: number;
  /** Null means "run to the end of the source". */
  outPointSeconds?: number | null;
  gainDb?: number | null;
  fadeInSeconds?: number | null;
  fadeOutSeconds?: number | null;
}

export interface LaidOutAudioClip<T extends AudioClipPlacement = AudioClipPlacement> {
  clip: T;
  startSeconds: number;
  /**
   * Null when the length is genuinely unknown — the file has never been
   * decoded and no out point was stated. A guess here would put a bar of the
   * wrong width on the ruler and a wrong runtime on the sequence.
   */
  endSeconds: number | null;
  usedSeconds: number | null;
  sourceInSeconds: number;
  sourceOutSeconds: number | null;
  /** True once a player has reported the file's real length. */
  measured: boolean;
  /** Ramps, clamped to the placement's own length. Null when none was asked for. */
  fadeInSeconds: number | null;
  fadeOutSeconds: number | null;
  /** True when this placement plays over the one before it on the same track. */
  overlapsPrevious: boolean;
}

export interface AudioTrackLayout<T extends AudioClipPlacement = AudioClipPlacement> {
  clips: Array<LaidOutAudioClip<T>>;
  /** Where the track's last known sound ends. Null when nothing has a length. */
  endSeconds: number | null;
}

/**
 * Lays out one track's placements.
 *
 * Sorted by position rather than by an order column, because a track is a time
 * axis: what comes first is whatever starts first. Overlaps are allowed and
 * flagged rather than resolved — two sounds at once is a mix, not an error, and
 * it is not this layer's place to decide which one should have moved.
 */
export function layOutAudioTrack<T extends AudioClipPlacement>(
  clips: T[],
  measuredSecondsFor: (clip: T) => number | null
): AudioTrackLayout<T> {
  const ordered = [...clips].sort(
    (a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id)
  );

  let endSeconds: number | null = null;
  let previousEnd: number | null = null;

  const laidOut = ordered.map((clip) => {
    const measuredSeconds = measuredSecondsFor(clip);
    const measured = typeof measuredSeconds === "number" && measuredSeconds > 0;
    const inPoint = Math.max(0, clip.inPointSeconds);

    // The out point is whichever is known: a stated one, otherwise the measured
    // end of the file, otherwise nothing at all.
    const statedOut = clip.outPointSeconds ?? null;
    const sourceOutSeconds =
      statedOut !== null
        ? round(measured ? Math.min(statedOut, measuredSeconds) : statedOut)
        : measured
          ? round(measuredSeconds)
          : null;

    const usedSeconds =
      sourceOutSeconds === null ? null : round(Math.max(0, sourceOutSeconds - inPoint));
    const startSeconds = round(Math.max(0, clip.startSeconds));
    const endOfClip = usedSeconds === null ? null : round(startSeconds + usedSeconds);

    if (endOfClip !== null) endSeconds = endSeconds === null ? endOfClip : Math.max(endSeconds, endOfClip);
    const overlapsPrevious = previousEnd !== null && startSeconds < previousEnd;
    if (endOfClip !== null) previousEnd = Math.max(previousEnd ?? 0, endOfClip);

    return {
      clip,
      startSeconds,
      endSeconds: endOfClip,
      usedSeconds,
      sourceInSeconds: round(inPoint),
      sourceOutSeconds,
      measured,
      fadeInSeconds: clampFade(clip.fadeInSeconds, usedSeconds),
      fadeOutSeconds: clampFade(clip.fadeOutSeconds, usedSeconds),
      overlapsPrevious,
    };
  });

  return { clips: laidOut, endSeconds };
}

/** A ramp cannot be longer than the sound it ramps. Unknown length, no clamp. */
function clampFade(stated: number | null | undefined, usedSeconds: number | null): number | null {
  if (stated === null || stated === undefined || !Number.isFinite(stated)) return null;
  const value = Math.max(0, stated);
  if (usedSeconds === null) return round(value);
  return round(Math.min(value, usedSeconds));
}

/**
 * The level of one placement at a moment, as a linear factor.
 *
 * Fades are linear ramps in time rather than in decibels. A constant-power or
 * equal-loudness curve would sound better and is what a real mixer does, but it
 * is also a claim about perception that this preview cannot check, so the simple
 * one is used and documented rather than the flattering one.
 */
export function audioClipGainAt<T extends AudioClipPlacement>(
  laidOut: LaidOutAudioClip<T>,
  seconds: number,
  trackGainDb: number | null | undefined
): number {
  if (laidOut.endSeconds === null) return 0;
  if (seconds < laidOut.startSeconds || seconds >= laidOut.endSeconds) return 0;

  const intoClip = seconds - laidOut.startSeconds;
  const toEnd = laidOut.endSeconds - seconds;

  let ramp = 1;
  if (laidOut.fadeInSeconds && laidOut.fadeInSeconds > 0) {
    ramp = Math.min(ramp, intoClip / laidOut.fadeInSeconds);
  }
  if (laidOut.fadeOutSeconds && laidOut.fadeOutSeconds > 0) {
    ramp = Math.min(ramp, toEnd / laidOut.fadeOutSeconds);
  }

  const level =
    Math.max(0, Math.min(1, ramp)) *
    gainToLinear(laidOut.clip.gainDb) *
    gainToLinear(trackGainDb);
  return Number.isFinite(level) ? Math.max(0, level) : 0;
}

/** Which placements on a track are sounding at a moment, and at what level. */
export function audioClipsAtTime<T extends AudioClipPlacement>(
  track: AudioTrackLayout<T>,
  seconds: number,
  trackGainDb: number | null | undefined
): Array<{ laidOut: LaidOutAudioClip<T>; sourceSeconds: number; gain: number }> {
  return track.clips
    .filter((c) => c.endSeconds !== null && seconds >= c.startSeconds && seconds < c.endSeconds)
    .map((laidOut) => ({
      laidOut,
      sourceSeconds: round(laidOut.sourceInSeconds + (seconds - laidOut.startSeconds)),
      gain: audioClipGainAt(laidOut, seconds, trackGainDb),
    }));
}

// --- the whole sequence ------------------------------------------------------

/**
 * How long the sequence runs once sound is counted.
 *
 * A music bed that outlasts the last shot, or an L-cut carrying sound past the
 * final frame, makes the sequence longer than its picture. The picture runtime
 * is still reported separately, because "the cut is 42 seconds and the mix runs
 * to 48" is two facts and a filmmaker needs both.
 */
export interface SequenceRuntime {
  pictureSeconds: number;
  audioSeconds: number;
  totalSeconds: number;
}

export function sequenceRuntime(
  pictureSeconds: number,
  syncAudioEndSeconds: number,
  trackEndSeconds: Array<number | null>
): SequenceRuntime {
  const audioSeconds = round(
    trackEndSeconds.reduce<number>(
      (longest, end) => (end === null ? longest : Math.max(longest, end)),
      syncAudioEndSeconds
    )
  );
  return {
    pictureSeconds: round(pictureSeconds),
    audioSeconds,
    totalSeconds: round(Math.max(pictureSeconds, audioSeconds)),
  };
}

/** Audio mime types get a speaker rather than a thumbnail; asked often enough to name. */
export function isAudioMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("audio/");
}
