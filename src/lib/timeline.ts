/**
 * Timeline timing — the pure half of the edit view.
 *
 * Like the prompt compiler, this module knows nothing about the database, React
 * or the DOM: it takes plain placement records plus the facts read off their
 * shots and assets, and returns where each clip sits on the time ruler. That
 * keeps every rule below testable without a browser or a server.
 *
 * The rule the whole phase turns on:
 *
 *   SOURCE duration  what the shot is, or what the media actually is
 *   USED   duration  how much of it this edit plays
 *
 * Trimming changes the second and never the first. Nothing here writes, derives
 * or suggests a new value for `Shot.durationSeconds`.
 *
 * A sequence's runtime is the sum of its USED durations minus the material its
 * transitions overlap. Which transitions overlap, and by how much, is the
 * subject of the `transitions` section below.
 */

/** Used for layout only when nothing states a length. Never written to a shot. */
export const PLACEHOLDER_CLIP_SECONDS = 4;

export const DEFAULT_FPS = 24;

/**
 * Where a clip's source length came from. Surfaced so the UI can say "this is a
 * placeholder" instead of presenting a made-up number as the shot's duration.
 */
export type DurationOrigin = "asset" | "shot" | "placeholder";

export interface ClipSourceFacts {
  /** `Shot.durationSeconds` — the filmmaker's intended length. */
  shotDurationSeconds?: number | null;
  /** The selected asset's measured length, if it is time-based media. */
  assetDurationSeconds?: number | null;
}

export interface ClipPlacement {
  id: string;
  shotId: string;
  order: number;
  inPointSeconds: number;
  /** Null means "run to the end of the source" — not a copy of the source length. */
  outPointSeconds?: number | null;
  /** Silences this clip's own sound — the audio inside the video it plays. */
  audioMuted?: boolean;
  /**
   * The edit at this clip's head. Absent or null is "not specified" — a plain
   * boundary, which is not the same as an explicit CUT and is never inferred
   * from the shots on either side.
   */
  transition?: TransitionKind | null;
  /** How long that edit runs. Null is "marked, but no length stated yet". */
  transitionDurationSeconds?: number | null;
}

export interface ResolvedDuration {
  seconds: number;
  from: DurationOrigin;
}

/**
 * How long the source runs.
 *
 * A measured asset wins over the shot's intended duration, because once a clip
 * exists the media is what actually plays. The shot's own value is never
 * rewritten to match — the two are allowed to disagree, and the inspector says
 * so.
 */
export function resolveSourceDuration(facts: ClipSourceFacts): ResolvedDuration {
  const asset = facts.assetDurationSeconds;
  if (typeof asset === "number" && Number.isFinite(asset) && asset > 0) {
    return { seconds: asset, from: "asset" };
  }
  const shot = facts.shotDurationSeconds;
  if (typeof shot === "number" && Number.isFinite(shot) && shot > 0) {
    return { seconds: shot, from: "shot" };
  }
  return { seconds: PLACEHOLDER_CLIP_SECONDS, from: "placeholder" };
}

/**
 * How much of the source this placement plays, after the trim.
 *
 * Both points are clamped into the source, so a trim that outlived its media —
 * an out point of 6s against a clip later measured at 4s — shortens instead of
 * running off the end. Never negative.
 */
export function usedDuration(placement: ClipPlacement, sourceSeconds: number): number {
  const source = Math.max(0, sourceSeconds);
  const start = clamp(placement.inPointSeconds, 0, source);
  const end = clamp(placement.outPointSeconds ?? source, 0, source);
  return Math.max(0, round(end - start));
}

// --- transitions -------------------------------------------------------------

/**
 * What each edit point does to the ruler.
 *
 * This is the table the whole feature rests on, and the honest answer is that
 * the six edit points a filmmaker can choose here do four different things:
 *
 *   CUT, MATCH_CUT   instant. A cut takes no time. A match cut is a cut whose
 *                    framing rhymes with the outgoing shot — an artistic
 *                    relationship between two images, not a duration.
 *
 *   DISSOLVE         an overlap. The incoming clip starts before the outgoing
 *                    one has finished and the two play together for the length
 *                    of the transition. This is the only edit point here that
 *                    makes the sequence *shorter*, because those seconds are
 *                    played once instead of twice.
 *
 *   FADE             through black. The clip fades up from (or down to) black
 *                    over its own material while it plays. Nothing overlaps, so
 *                    the runtime is unchanged — a fade costs picture, not time.
 *
 *   J_CUT, L_CUT     audio. Both are straight cuts in the picture; what moves
 *                    is the sound, leading the cut (J) or lagging it (L). This
 *                    module deliberately does nothing with them beyond saying
 *                    so: `resolveAudioBoundary` in lib/audio.ts works out where
 *                    the sound goes, against the material either side. What a
 *                    J- or L-cut must never become is a dissolve, and keeping
 *                    the two layers apart is what stops it.
 */
export type TransitionKind = "CUT" | "DISSOLVE" | "FADE" | "MATCH_CUT" | "J_CUT" | "L_CUT";

export type TransitionTiming = "instant" | "overlap" | "through-black" | "audio-only";

export const TRANSITION_TIMING: Record<TransitionKind, TransitionTiming> = {
  CUT: "instant",
  MATCH_CUT: "instant",
  DISSOLVE: "overlap",
  FADE: "through-black",
  J_CUT: "audio-only",
  L_CUT: "audio-only",
};

/** For prose. The UI's own labels are title-case versions of these. */
export const TRANSITION_NAME: Record<TransitionKind, string> = {
  CUT: "cut",
  DISSOLVE: "dissolve",
  FADE: "fade",
  MATCH_CUT: "match cut",
  J_CUT: "J-cut",
  L_CUT: "L-cut",
};

/**
 * Why the ruler effect is not simply the stated length.
 *
 * Every one of these is surfaced rather than silently applied. A dissolve that
 * has been quietly shortened because there was not enough material is exactly
 * the kind of thing an editor needs told, not hidden.
 */
export type TransitionNote =
  /** Marked as a dissolve or fade, but no length has been stated yet. */
  | "no-length-stated"
  /** A cut takes no time, so a length stored against one cannot apply. */
  | "instant"
  /** The picture is a straight cut; the offset belongs to audio, which does not exist yet. */
  | "audio-only"
  /** A dissolve at the head of the sequence has nothing to dissolve from. */
  | "no-preceding-clip"
  /** The outgoing clip ran out of material before the stated length. */
  | "limited-by-outgoing"
  /** The incoming clip is shorter than the stated length. */
  | "limited-by-incoming";

export interface ResolvedTransition {
  kind: TransitionKind;
  timing: TransitionTiming;
  /** What is stored on the placement. Null when a length was never stated. */
  statedSeconds: number | null;
  /** How long it actually runs. Zero for an instant or audio-only edit point. */
  effectiveSeconds: number;
  /**
   * How much the sequence shortens because of it.
   *
   * Only an overlap shortens anything. A fade has `effectiveSeconds` without
   * `overlapSeconds`, which is the distinction the whole table above exists to
   * make.
   */
  overlapSeconds: number;
  /** Null when the transition does exactly what its stated length says. */
  note: TransitionNote | null;
}

/**
 * Resolves one edit point against the material available on either side.
 *
 * A dissolve cannot be longer than the clip it is dissolving from, nor longer
 * than the clip it is dissolving to — there would be nothing left to mix. Nor
 * can two transitions claim the same seconds of one clip: a 4-second clip with
 * a 3-second dissolve at its head has only 1 second left for a dissolve at its
 * tail. `precedingRemainingSeconds` carries that residue forward, which is why
 * the layout resolves transitions left to right rather than independently.
 *
 * Every limit shortens the transition and records why. None of them is an
 * error: an edit is a work in progress, and a dissolve set before the clips
 * were trimmed to fit it is a normal state, not a mistake to reject.
 */
export function resolveTransition(
  kind: TransitionKind,
  statedSeconds: number | null,
  context: {
    /**
     * Material left in the outgoing clip after its own head transition. Null
     * when there is no outgoing clip — this is the head of the sequence.
     */
    precedingRemainingSeconds: number | null;
    /** The incoming clip's used duration. */
    incomingUsedSeconds: number;
  }
): ResolvedTransition {
  const timing = TRANSITION_TIMING[kind];
  const inert = { kind, timing, statedSeconds, effectiveSeconds: 0, overlapSeconds: 0 };

  if (timing === "instant") {
    // A stored length on a cut is a leftover from changing the type, not an
    // instruction. It is kept on the record and reported as having no effect.
    return { ...inert, note: statedSeconds !== null && statedSeconds > 0 ? "instant" : null };
  }
  if (timing === "audio-only") return { ...inert, note: "audio-only" };
  if (statedSeconds === null) return { ...inert, note: "no-length-stated" };

  if (timing === "through-black") {
    const effective = Math.min(statedSeconds, Math.max(0, context.incomingUsedSeconds));
    return {
      ...inert,
      effectiveSeconds: round(effective),
      note: effective < statedSeconds ? "limited-by-incoming" : null,
    };
  }

  // An overlap, and the only branch that moves the ruler.
  if (context.precedingRemainingSeconds === null) {
    return { ...inert, note: "no-preceding-clip" };
  }
  const fromOutgoing = Math.max(0, context.precedingRemainingSeconds);
  const fromIncoming = Math.max(0, context.incomingUsedSeconds);
  const overlap = round(Math.min(statedSeconds, fromOutgoing, fromIncoming));

  return {
    kind,
    timing,
    statedSeconds,
    effectiveSeconds: overlap,
    overlapSeconds: overlap,
    note:
      overlap >= statedSeconds
        ? null
        : fromOutgoing <= fromIncoming
          ? "limited-by-outgoing"
          : "limited-by-incoming",
  };
}

/**
 * One sentence saying what this edit point does to the edit.
 *
 * Lives here rather than in a component so the wording is covered by the same
 * tests as the arithmetic it describes — the number and the sentence about the
 * number should never be able to disagree.
 */
export function describeTransitionEffect(resolved: ResolvedTransition): string {
  const name = TRANSITION_NAME[resolved.kind];
  const stated = resolved.statedSeconds === null ? null : formatDuration(resolved.statedSeconds);

  switch (resolved.note) {
    case "instant":
      return `A ${name} takes no time. The stored length of ${stated} has no effect on the edit.`;
    case "audio-only":
      // Where the sound actually goes is resolved in lib/audio.ts against the
      // material either side of the boundary. This layer is picture, and its
      // honest answer is that a J- or L-cut does not touch it.
      return `A ${name} moves the sound, not the picture: the picture cuts straight and the edit's length is unchanged. ${
        stated ? `The ${stated} offset applies to the sound alone.` : "No offset has been stated."
      }`;
    case "no-length-stated":
      return `Marked as a ${name} with no length, so it plays as a plain boundary. State a length to give it an effect.`;
    case "no-preceding-clip":
      return `Nothing precedes this clip, so there is nothing to ${name} from. The edit point is recorded; it does not change the edit's length.`;
    case "limited-by-outgoing":
      return `Plays as ${formatDuration(resolved.effectiveSeconds)}, not ${stated}: the previous clip has no more material to ${name} from.`;
    case "limited-by-incoming":
      return resolved.timing === "through-black"
        ? `Runs over this clip's whole ${formatDuration(resolved.effectiveSeconds)} — a ${stated} ${name} is longer than the clip.`
        : `Plays as ${formatDuration(resolved.effectiveSeconds)}, not ${stated}: this clip is not long enough for the whole ${name}.`;
    case null:
      break;
  }

  if (resolved.timing === "instant") return `A ${name} takes no time; the edit's length is unchanged.`;
  if (resolved.timing === "through-black") {
    return `Runs through black over this clip's first ${formatDuration(resolved.effectiveSeconds)}. The edit's length is unchanged.`;
  }
  if (resolved.overlapSeconds === 0) {
    return `A ${formatDuration(0)} ${name} has the same effect as a cut.`;
  }
  return `Overlaps the previous clip by ${formatDuration(resolved.overlapSeconds)}, so the edit is ${formatDuration(
    resolved.overlapSeconds
  )} shorter than it would be on a straight cut.`;
}

export interface LaidOutClip<T extends ClipPlacement = ClipPlacement> {
  clip: T;
  source: ResolvedDuration;
  /** Seconds of the source actually played, after the trim. */
  usedSeconds: number;
  /** Position on the sequence's time ruler. */
  startSeconds: number;
  endSeconds: number;
  /** True when in/out cover less than the whole source. */
  trimmed: boolean;
  /** The edit at this clip's head, resolved. Undefined when none is specified. */
  transition?: ResolvedTransition;
  /**
   * Seconds this clip plays on top of the previous one. Non-zero only for a
   * dissolve, and always equal to `transition.overlapSeconds`; mirrored here so
   * a renderer laying out bands does not have to reach through a maybe-absent
   * object.
   */
  overlapSeconds: number;
}

export interface TimelineLayout<T extends ClipPlacement = ClipPlacement> {
  clips: Array<LaidOutClip<T>>;
  /** What the sequence actually runs, with overlapping transitions removed. */
  totalSeconds: number;
  /** What it would run if every boundary were a straight cut. */
  straightCutSeconds: number;
  /** The difference between the two — seconds played once instead of twice. */
  overlapSeconds: number;
}

/**
 * Lays clips out in `order`, honouring the transitions between them.
 *
 * Boundaries butt up against each other except where a dissolve overlaps them:
 * the incoming clip starts early by the length of the dissolve, and those
 * seconds play once rather than twice. The pass runs left to right because a
 * transition's available material depends on what the previous one already
 * consumed — the residue carried in `remaining` below.
 *
 * `totalSeconds` is therefore the real runtime, and `straightCutSeconds` is what
 * the same clips would run with every boundary a cut. Both are reported, because
 * the difference between them is the thing a filmmaker wants to see.
 */
export function layOutClips<T extends ClipPlacement>(
  clips: T[],
  factsFor: (clip: T) => ClipSourceFacts
): TimelineLayout<T> {
  const ordered = [...clips].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  let cursor = 0;
  // Material in the previous clip that no transition has claimed. Null before
  // the first clip: there is nothing to dissolve from at the head of a sequence.
  let remaining: number | null = null;

  const laidOut = ordered.map((clip) => {
    const source = resolveSourceDuration(factsFor(clip));
    const usedSeconds = usedDuration(clip, source.seconds);

    const kind = clip.transition ?? null;
    const transition = kind
      ? resolveTransition(kind, clip.transitionDurationSeconds ?? null, {
          precedingRemainingSeconds: remaining,
          incomingUsedSeconds: usedSeconds,
        })
      : undefined;

    const overlapSeconds = transition?.overlapSeconds ?? 0;
    const startSeconds = round(Math.max(0, cursor - overlapSeconds));
    cursor = round(startSeconds + usedSeconds);

    // Both a dissolve and a fade occupy the head of this clip, so neither leaves
    // those seconds available to a transition at its tail.
    remaining = Math.max(0, round(usedSeconds - (transition?.effectiveSeconds ?? 0)));

    return {
      clip,
      source,
      usedSeconds,
      startSeconds,
      endSeconds: cursor,
      trimmed: usedSeconds < source.seconds,
      transition,
      overlapSeconds,
    };
  });

  const straightCutSeconds = round(laidOut.reduce((sum, e) => sum + e.usedSeconds, 0));
  const overlapSeconds = round(laidOut.reduce((sum, e) => sum + e.overlapSeconds, 0));

  return { clips: laidOut, totalSeconds: round(cursor), straightCutSeconds, overlapSeconds };
}

export interface PlayheadState<T extends ClipPlacement = ClipPlacement> {
  /** The earlier of the clips under the playhead — the outgoing one in a mix. */
  entry: LaidOutClip<T>;
  offsetSeconds: number;
  /**
   * Present only inside a dissolve: the clip mixing in over `entry`, and how far
   * through the mix the playhead is (0 at its first frame, 1 at its last).
   *
   * A caller that ignores this sees the outgoing clip for the whole transition,
   * which is a cut at the far edge of the dissolve rather than a wrong frame.
   */
  incoming?: { entry: LaidOutClip<T>; offsetSeconds: number; progress: number };
}

/**
 * Which clip is playing at a point on the ruler, and how far into it.
 *
 * Half-open [start, end), so a plain boundary belongs to the incoming clip and
 * never to both. Undefined before zero and at or past the end — which is what
 * the player reads as "finished" rather than clamping to the last frame forever.
 *
 * A dissolve is the one case where two clips are genuinely playing at once, and
 * both are returned. There are never three: `resolveTransition` refuses to let
 * two transitions claim the same seconds of a clip, so a clip's head mix and its
 * tail mix cannot meet in the middle.
 */
export function clipAtTime<T extends ClipPlacement>(
  layout: TimelineLayout<T>,
  seconds: number
): PlayheadState<T> | undefined {
  if (seconds < 0 || seconds >= layout.totalSeconds) return undefined;
  const active = layout.clips.filter(
    (e) => e.usedSeconds > 0 && seconds >= e.startSeconds && seconds < e.endSeconds
  );
  const entry = active[0];
  if (!entry) return undefined;

  const next = active[1];
  const state: PlayheadState<T> = { entry, offsetSeconds: round(seconds - entry.startSeconds) };
  if (!next || next.overlapSeconds <= 0) return state;

  return {
    ...state,
    incoming: {
      entry: next,
      offsetSeconds: round(seconds - next.startSeconds),
      progress: round(clamp((seconds - next.startSeconds) / next.overlapSeconds, 0, 1)),
    },
  };
}

/** HH:MM:SS:FF. Frames are display-only; nothing here is frame-quantised. */
export function formatTimecode(seconds: number, fps: number = DEFAULT_FPS): string {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const frames = Math.floor((safe - whole) * fps);
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, "0")).join(":") + `:${String(frames).padStart(2, "0")}`;
}

/** "6s" / "3.5s" / "1m 12s" — for labels where a full timecode is too much. */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  if (safe < 60) return `${trimZeros(safe)}s`;
  const mins = Math.floor(safe / 60);
  const rest = safe - mins * 60;
  return rest === 0 ? `${mins}m` : `${mins}m ${trimZeros(rest)}s`;
}

/**
 * Consecutive runs of clips from the same scene, for the ruler's scene bands.
 * A scene the edit returns to later produces a second group — that is a real
 * structural fact about the cut, not a grouping bug.
 */
export interface SceneGroup<T extends ClipPlacement> {
  sceneId: string;
  entries: Array<LaidOutClip<T>>;
  startSeconds: number;
  endSeconds: number;
}

export function groupByScene<T extends ClipPlacement>(
  layout: TimelineLayout<T>,
  sceneIdFor: (clip: T) => string
): Array<SceneGroup<T>> {
  const groups: Array<SceneGroup<T>> = [];
  for (const entry of layout.clips) {
    const sceneId = sceneIdFor(entry.clip);
    const current = groups[groups.length - 1];
    if (current && current.sceneId === sceneId) {
      current.entries.push(entry);
      current.endSeconds = entry.endSeconds;
    } else {
      groups.push({
        sceneId,
        entries: [entry],
        startSeconds: entry.startSeconds,
        endSeconds: entry.endSeconds,
      });
    }
  }
  return groups;
}

/**
 * Splits a placement in two at `atSeconds` measured from the start of the clip.
 * Returns the two resulting trims, or undefined when the point does not fall
 * strictly inside the used range — a split at either edge would make a
 * zero-length clip.
 */
export function splitPlacement(
  placement: ClipPlacement,
  sourceSeconds: number,
  atSeconds: number
): { first: { inPointSeconds: number; outPointSeconds: number }; second: { inPointSeconds: number; outPointSeconds: number } } | undefined {
  const source = Math.max(0, sourceSeconds);
  const start = clamp(placement.inPointSeconds, 0, source);
  const end = clamp(placement.outPointSeconds ?? source, 0, source);
  const cut = round(start + atSeconds);
  if (!(cut > start && cut < end)) return undefined;

  return {
    first: { inPointSeconds: round(start), outPointSeconds: cut },
    second: { inPointSeconds: cut, outPointSeconds: round(end) },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Keeps float drift out of accumulated ruler positions.
 *
 * Exported because the audio layer lays out against these same positions, and a
 * sound placed on a slightly different grid from the picture it belongs to is a
 * sync error nobody would think to look for.
 */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

const round = roundSeconds;

function trimZeros(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// --- which asset stands in for a shot ---------------------------------------

/**
 * The minimum an asset has to look like for the rules below. Kept structural so
 * the timing layer never imports a Prisma type or a component's props.
 */
export interface TimelineAssetRef {
  id: string;
  mimeType: string;
}

/**
 * Which of a shot's assets represents it in an edit.
 *
 * An explicit choice on the placement always wins. With no choice, the newest
 * video stands in — it is the closest thing to the finished shot — and failing
 * that the storyboard frame, which is why a shot with nothing generated still
 * plays as a rough beat instead of a gap.
 *
 * A chosen asset that no longer belongs to the shot falls back rather than
 * rendering nothing, so deleting an asset cannot blank out a clip.
 */
export function resolveClipAsset<A extends TimelineAssetRef>(
  assets: A[],
  selectedAssetId: string | null | undefined
): A | undefined {
  if (selectedAssetId) {
    const chosen = assets.find((a) => a.id === selectedAssetId);
    if (chosen) return chosen;
  }
  return (
    assets.find((a) => a.mimeType.startsWith("video/")) ??
    assets.find((a) => a.mimeType.startsWith("image/"))
  );
}

/**
 * The storyboard frame for a shot: its newest image.
 *
 * Deliberately the same rule the storyboard panel uses, so a panel, a timeline
 * clip and a shot are three views of one thing rather than three opinions.
 */
export function resolveStoryboardFrame<A extends TimelineAssetRef>(assets: A[]): A | undefined {
  return assets.find((a) => a.mimeType.startsWith("image/"));
}
