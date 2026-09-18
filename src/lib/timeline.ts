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
}

export interface TimelineLayout<T extends ClipPlacement = ClipPlacement> {
  clips: Array<LaidOutClip<T>>;
  totalSeconds: number;
}

/**
 * Lays clips end to end in `order`.
 *
 * Cut-based: every boundary butts up against the next, including the ones
 * carrying a dissolve. Overlapping a dissolve would shorten the sequence, and
 * this phase stores transition type and duration as edit metadata without
 * letting it move the ruler. Documented in the README as future work.
 */
export function layOutClips<T extends ClipPlacement>(
  clips: T[],
  factsFor: (clip: T) => ClipSourceFacts
): TimelineLayout<T> {
  const ordered = [...clips].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  let cursor = 0;
  const laidOut = ordered.map((clip) => {
    const source = resolveSourceDuration(factsFor(clip));
    const usedSeconds = usedDuration(clip, source.seconds);
    const startSeconds = round(cursor);
    cursor += usedSeconds;
    return {
      clip,
      source,
      usedSeconds,
      startSeconds,
      endSeconds: round(cursor),
      trimmed: usedSeconds < source.seconds,
    };
  });

  return { clips: laidOut, totalSeconds: round(cursor) };
}

/**
 * Which clip is playing at a point on the ruler, and how far into it.
 *
 * Half-open [start, end), so a boundary belongs to the incoming clip and never
 * to both. Undefined before zero and at or past the end — which is what the
 * player reads as "finished" rather than clamping to the last frame forever.
 */
export function clipAtTime<T extends ClipPlacement>(
  layout: TimelineLayout<T>,
  seconds: number
): { entry: LaidOutClip<T>; offsetSeconds: number } | undefined {
  if (seconds < 0 || seconds >= layout.totalSeconds) return undefined;
  const entry = layout.clips.find(
    (e) => e.usedSeconds > 0 && seconds >= e.startSeconds && seconds < e.endSeconds
  );
  return entry ? { entry, offsetSeconds: round(seconds - entry.startSeconds) } : undefined;
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

/** Keeps float drift out of accumulated ruler positions. */
function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

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
