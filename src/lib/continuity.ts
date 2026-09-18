/**
 * Continuity analysis.
 *
 * A read-only layer over the structured filmmaking data. Nothing in this module
 * writes a Shot, a Scene, a Character, blocking, the timeline or a prompt — it
 * reads them and describes differences. The filmmaker decides what to change.
 *
 * Findings are *derived*, never stored. They are recomputed from the shots every
 * time the panel loads, which means a difference the filmmaker actually fixed
 * stops being reported on its own, with no stale rows to clean up. Only the
 * filmmaker's decision about a difference is persisted, attached by the
 * deterministic `key` each finding carries.
 *
 * Two rules run through everything here:
 *
 *   1. UNSPECIFIED IS NOT ABSENT. A blank field means the filmmaker has not said
 *      yet — never that the thing is gone. No rule may produce a finding from a
 *      value that was never stated. This is the difference between a useful
 *      continuity tool and a wall of noise.
 *
 *   2. A DIFFERENCE IS NOT AN ERROR. Shots are supposed to differ; that is what
 *      coverage is. Findings say what changed and why it might matter, at a
 *      severity that reflects how likely it is to be a mistake.
 */

import {
  axisLine,
  axisSide,
  parseBlocking,
  projectSubjectToFrame,
  type ShotBlocking,
} from "./blocking.ts";

export type Severity = "INFO" | "REVIEW" | "POTENTIAL_ISSUE";

export type FindingCategory =
  | "WARDROBE"
  | "HAIR_MAKEUP"
  | "CHARACTER_PROPS"
  | "CHARACTER_PRESENCE"
  | "LOCATION"
  | "TIME_OF_DAY"
  | "LIGHTING"
  | "PROP"
  | "AXIS"
  | "SCREEN_DIRECTION"
  | "EYELINE"
  | "CAMERA";

/**
 * How two shots are related. Rules apply per relation, because what counts as a
 * continuity problem depends entirely on this: a location change between two
 * shots inside one scene is strange, and between two scenes is just the film
 * moving on.
 */
export type Relation = "consecutive-in-scene" | "adjacent-in-edit";

export type DecisionStatus = "REVIEWED" | "INTENTIONAL" | "DISMISSED";

export interface ContinuityFinding {
  /**
   * Stable identity for this difference: same two shots, same category, same
   * subject produces the same key every time, so a decision made months ago
   * still attaches after re-analysis.
   */
  key: string;
  category: FindingCategory;
  severity: Severity;
  relation: Relation;
  shotAId: string;
  shotBId: string;
  /** The character, prop or camera property the finding is about. */
  subject?: string;
  whatChanged: string;
  whyItMayMatter: string;
  /** Set from stored decisions by `applyDecisions`; undefined means open. */
  status?: DecisionStatus;
}

export interface ContinuityShot {
  id: string;
  sceneId: string;
  shotNumber: string;
  shotType: string;
  order: number;
  wardrobe?: string | null;
  hairMakeup?: string | null;
  characterProps?: string | null;
  lightingNotes?: string | null;
  cameraAngle?: string | null;
  cameraHeight?: string | null;
  lens?: string | null;
  focalLength?: string | null;
  cameraMovement?: string | null;
  composition?: string | null;
  framing?: string | null;
  /** Raw `ShotListItem.blocking`. Parsed here; never written back. */
  blocking?: unknown;
}

export interface ContinuityScene {
  id: string;
  number: string;
  location: string;
  timeOfDay: string;
  intExt: string;
}

export interface AnalysisInput {
  shots: ContinuityShot[];
  scenes: Record<string, ContinuityScene>;
  /**
   * Ordered shot ids from an edit, if one exists. Adjacent entries are treated
   * as explicitly related shots — the filmmaker put them next to each other.
   */
  editOrder?: string[];
}

// --- value helpers -----------------------------------------------------------

/** A value the filmmaker actually stated, or undefined. Blank is never a value. */
function stated(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Compares stated values the way a person would: case and spacing don't count. */
function same(a: string, b: string): boolean {
  return a.toLowerCase().replace(/\s+/g, " ") === b.toLowerCase().replace(/\s+/g, " ");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function key(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(":");
}

/**
 * Compares one stated-or-not field across two shots.
 *
 * Returns a change only when BOTH shots state a value and the values differ.
 * One side blank produces nothing at all — that is rule 1, enforced in the one
 * place every text rule goes through.
 */
function comparedValues(
  a: string | null | undefined,
  b: string | null | undefined
): { from: string; to: string } | undefined {
  const first = stated(a);
  const second = stated(b);
  if (!first || !second) return undefined;
  if (same(first, second)) return undefined;
  return { from: first, to: second };
}

interface Pair {
  a: ContinuityShot;
  b: ContinuityShot;
  relation: Relation;
  sameScene: boolean;
}

// --- blocking-derived facts --------------------------------------------------

/** Parsed blocking, or undefined when the shot has none. Never a default. */
function blockingOf(shot: ContinuityShot): ShotBlocking | undefined {
  if (shot.blocking === null || shot.blocking === undefined) return undefined;
  const parsed = parseBlocking(shot.blocking);
  // parseBlocking falls back to a default for a malformed blob; a default is
  // not a statement about this shot, so it must not drive a finding.
  return parsed.subjects.length > 0 || parsed.props.length > 0 ? parsed : undefined;
}

/**
 * Which way a subject travels across the frame, using the Phase 8 projection.
 *
 * This is the explicit, deterministic coordinate-to-screen mapping the rules are
 * allowed to use: the subject's start and end are projected through the
 * camera's own position, rotation and field of view, and the sign of the change
 * in frame position is the screen direction. Undefined unless the subject
 * actually moves and both ends are inside the frame — there is no screen
 * direction to compare for someone standing still.
 */
export function screenDirectionOf(
  blocking: ShotBlocking,
  subjectLabel: string
): "left-to-right" | "right-to-left" | undefined {
  const subject = blocking.subjects.find((s) => same(s.label, subjectLabel));
  if (!subject?.end) return undefined;

  const start = projectSubjectToFrame(blocking.cameraStart, subject.start);
  const camera = blocking.cameraEnd ?? blocking.cameraStart;
  const end = projectSubjectToFrame(camera, subject.end);
  if (start.outOfFrame || end.outOfFrame) return undefined;
  if (start.subjectX === undefined || end.subjectX === undefined) return undefined;

  const delta = end.subjectX - start.subjectX;
  // A couple of percent of frame width is not a direction.
  if (Math.abs(delta) < 2) return undefined;
  return delta > 0 ? "left-to-right" : "right-to-left";
}

/** Where a subject sits in frame, when the geometry puts them in it at all. */
function framePositionOf(blocking: ShotBlocking, subjectLabel: string): number | undefined {
  const subject = blocking.subjects.find((s) => same(s.label, subjectLabel));
  if (!subject) return undefined;
  const projection = projectSubjectToFrame(blocking.cameraStart, subject.start);
  return projection.outOfFrame ? undefined : projection.subjectX;
}

// --- rules -------------------------------------------------------------------

type Rule = (pair: Pair, scenes: Record<string, ContinuityScene>) => ContinuityFinding[];

/** Character appearance: wardrobe, hair/makeup, and props the character carries. */
const characterRules: Rule[] = [
  ({ a, b, relation }) => {
    const change = comparedValues(a.wardrobe, b.wardrobe);
    if (!change) return [];
    return [
      {
        key: key(["WARDROBE", a.id, b.id]),
        category: "WARDROBE",
        severity: "POTENTIAL_ISSUE",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Wardrobe changes from “${change.from}” to “${change.to}”.`,
        whyItMayMatter:
          "Costume normally holds across a continuous action. If no time passes between these shots, this may read as a jump.",
      },
    ];
  },
  ({ a, b, relation }) => {
    const change = comparedValues(a.hairMakeup, b.hairMakeup);
    if (!change) return [];
    return [
      {
        key: key(["HAIR_MAKEUP", a.id, b.id]),
        category: "HAIR_MAKEUP",
        severity: "POTENTIAL_ISSUE",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Hair and makeup change from “${change.from}” to “${change.to}”.`,
        whyItMayMatter:
          "Hair and makeup are among the most-noticed continuity details in a cut.",
      },
    ];
  },
  ({ a, b, relation }) => {
    const change = comparedValues(a.characterProps, b.characterProps);
    if (!change) return [];
    return [
      {
        key: key(["CHARACTER_PROPS", a.id, b.id]),
        category: "CHARACTER_PROPS",
        severity: "REVIEW",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Props carried change from “${change.from}” to “${change.to}”.`,
        whyItMayMatter:
          "An object appearing in or vanishing from a character's hands between shots is hard to miss.",
      },
    ];
  },
  /**
   * Character presence, from the blocking stage. Only comparable when both
   * shots have blocking — a shot that was never blocked says nothing about who
   * is in it, and silence is not absence.
   */
  ({ a, b, relation }) => {
    const blockA = blockingOf(a);
    const blockB = blockingOf(b);
    if (!blockA || !blockB) return [];
    if (blockA.subjects.length === 0 || blockB.subjects.length === 0) return [];

    const inB = new Set(blockB.subjects.map((s) => s.label.toLowerCase()));
    return blockA.subjects
      .filter((s) => !inB.has(s.label.toLowerCase()))
      .map((s) => ({
        key: key(["CHARACTER_PRESENCE", a.id, b.id, slug(s.label)]),
        category: "CHARACTER_PRESENCE" as const,
        severity: "REVIEW" as const,
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: s.label,
        whatChanged: `${s.label} is blocked in the first shot but not the second.`,
        whyItMayMatter:
          "They may simply be out of frame, or they may have been left out of the blocking by accident.",
      }));
  },
];

const environmentRules: Rule[] = [
  /**
   * Location. Inside one scene the location is the same by construction, so this
   * only ever fires for shots the filmmaker placed next to each other in an
   * edit — and even then it is information, not a problem: cutting between
   * locations is what editing is.
   */
  ({ a, b, relation, sameScene }, scenes) => {
    if (sameScene) return [];
    const sceneA = scenes[a.sceneId];
    const sceneB = scenes[b.sceneId];
    if (!sceneA || !sceneB) return [];
    if (same(sceneA.location, sceneB.location)) return [];
    return [
      {
        key: key(["LOCATION", a.id, b.id]),
        category: "LOCATION",
        severity: "INFO",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Location changes from ${sceneA.location} to ${sceneB.location}.`,
        whyItMayMatter:
          "These shots sit next to each other in the edit but come from different scenes, so this is expected. Listed for completeness.",
      },
    ];
  },
  ({ a, b, relation, sameScene }, scenes) => {
    if (sameScene) return [];
    const sceneA = scenes[a.sceneId];
    const sceneB = scenes[b.sceneId];
    if (!sceneA || !sceneB) return [];
    if (sceneA.timeOfDay === sceneB.timeOfDay) return [];
    // Same location, different time of day is worth a second look; a different
    // location too is just the story moving, and the LOCATION rule covers it.
    if (!same(sceneA.location, sceneB.location)) return [];
    return [
      {
        key: key(["TIME_OF_DAY", a.id, b.id]),
        category: "TIME_OF_DAY",
        severity: "REVIEW",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Same location, but time of day changes from ${sceneA.timeOfDay} to ${sceneB.timeOfDay}.`,
        whyItMayMatter:
          "Cutting between two times of day in one place can read as a jump unless the story means it to.",
      },
    ];
  },
  ({ a, b, relation, sameScene }) => {
    const change = comparedValues(a.lightingNotes, b.lightingNotes);
    if (!change) return [];
    return [
      {
        key: key(["LIGHTING", a.id, b.id]),
        category: "LIGHTING",
        // Inside a scene a lighting change is a real continuity question;
        // between scenes it is expected.
        severity: sameScene ? "POTENTIAL_ISSUE" : "INFO",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged: `Lighting changes from “${change.from}” to “${change.to}”.`,
        whyItMayMatter: sameScene
          ? "Two shots in the same scene normally share a lighting state."
          : "These shots come from different scenes, where a lighting change is expected.",
      },
    ];
  },
];

/**
 * Set-dressing props, from the blocking stage.
 *
 * Comparable only when BOTH shots have props placed. A shot with an empty prop
 * list has not said the bench is gone — it has said nothing about props, and
 * treating that as a disappearance would be exactly the false alarm the brief
 * forbids.
 */
const propRules: Rule[] = [
  ({ a, b, relation, sameScene }) => {
    if (!sameScene) return [];
    const blockA = blockingOf(a);
    const blockB = blockingOf(b);
    if (!blockA || !blockB) return [];
    if (blockA.props.length === 0 || blockB.props.length === 0) return [];

    const inB = new Set(blockB.props.map((p) => p.label.toLowerCase()));
    return blockA.props
      .filter((p) => !inB.has(p.label.toLowerCase()))
      .map((p) => ({
        key: key(["PROP", a.id, b.id, slug(p.label)]),
        category: "PROP" as const,
        severity: "REVIEW" as const,
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: p.label,
        whatChanged: `“${p.label}” is placed in the first shot but not in the second, which does place other props.`,
        whyItMayMatter:
          "It may be out of frame rather than gone. Both shots list props, so the difference is worth a look.",
      }));
  },
];

const spatialRules: Rule[] = [
  /**
   * The 180° axis, across shots.
   *
   * The first shot's axis is the established one. If the second shot's camera
   * sits on the other side of it, screen direction reverses between the two.
   * That is a legitimate choice and this never prevents it — it says so.
   */
  ({ a, b, relation, sameScene }) => {
    if (!sameScene) return [];
    const blockA = blockingOf(a);
    const blockB = blockingOf(b);
    if (!blockA || !blockB) return [];

    const axis = axisLine(blockA);
    if (!axis) return [];

    // With a single subject and no stated axis mode, the automatic axis is the
    // camera-to-subject line — which runs *through* the camera, so "which side
    // is the camera on" has no answer. Comparing across shots needs an axis
    // established by the staging rather than by the camera looking at it.
    const cameraDerived =
      (blockA.axis?.mode ?? "auto") === "auto" && blockA.subjects.length < 2;
    if (cameraDerived) return [];

    const sideA = axisSide(blockA.cameraStart, axis);
    const sideB = axisSide(blockB.cameraStart, axis);
    if (sideA === 0 || sideB === 0 || sideA === sideB) return [];

    return [
      {
        key: key(["AXIS", a.id, b.id]),
        category: "AXIS",
        severity: "POTENTIAL_ISSUE",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        whatChanged:
          "The camera moves to the opposite side of the 180° axis established in the first shot.",
        whyItMayMatter:
          "Screen direction reverses across the cut. Deliberate axis crossings are a real technique — mark this intentional if that is what you want.",
      },
    ];
  },
  /**
   * Screen direction, from the explicit projection rather than raw coordinates.
   * Only for characters who move in both shots and stay in frame.
   */
  ({ a, b, relation, sameScene }) => {
    if (!sameScene) return [];
    const blockA = blockingOf(a);
    const blockB = blockingOf(b);
    if (!blockA || !blockB) return [];

    const findings: ContinuityFinding[] = [];
    for (const subject of blockA.subjects) {
      const dirA = screenDirectionOf(blockA, subject.label);
      const dirB = screenDirectionOf(blockB, subject.label);
      if (!dirA || !dirB || dirA === dirB) continue;

      findings.push({
        key: key(["SCREEN_DIRECTION", a.id, b.id, slug(subject.label)]),
        category: "SCREEN_DIRECTION",
        severity: "POTENTIAL_ISSUE",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: subject.label,
        whatChanged: `${subject.label} travels ${dirA.replace(/-/g, " ")} in the first shot and ${dirB.replace(/-/g, " ")} in the second.`,
        whyItMayMatter:
          "A reversal across a cut can read as the character turning back on themselves.",
      });
    }
    return findings;
  },
  /**
   * Eyeline, from where the geometry puts a character in frame. Only for a
   * character present in both shots with a computable frame position.
   */
  ({ a, b, relation, sameScene }) => {
    if (!sameScene) return [];
    const blockA = blockingOf(a);
    const blockB = blockingOf(b);
    if (!blockA || !blockB) return [];

    const findings: ContinuityFinding[] = [];
    for (const subject of blockA.subjects) {
      const posA = framePositionOf(blockA, subject.label);
      const posB = framePositionOf(blockB, subject.label);
      if (posA === undefined || posB === undefined) continue;

      const sideA = posA < 45 ? "left" : posA > 55 ? "right" : "centre";
      const sideB = posB < 45 ? "left" : posB > 55 ? "right" : "centre";
      if (sideA === sideB) continue;
      // A move through centre is ordinary reframing; only a genuine flip of
      // sides is worth raising.
      if (sideA === "centre" || sideB === "centre") continue;

      findings.push({
        key: key(["EYELINE", a.id, b.id, slug(subject.label)]),
        category: "EYELINE",
        severity: "REVIEW",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: subject.label,
        whatChanged: `${subject.label} sits frame ${sideA} in the first shot and frame ${sideB} in the second.`,
        whyItMayMatter:
          "Swapping which side of frame a character occupies changes where the audience expects them to be looking.",
      });
    }
    return findings;
  },
];

/**
 * Camera parameters.
 *
 * Deliberately quiet: coverage is *supposed* to change angle, lens and framing,
 * so an ordinary shot change must not produce a warning. Only lens and camera
 * height are reported, and only as INFO, because those are the two a crew
 * usually intends to hold within a setup.
 */
const cameraRules: Rule[] = [
  ({ a, b, relation, sameScene }) => {
    if (!sameScene) return [];
    const findings: ContinuityFinding[] = [];

    const lensA = stated(a.focalLength) ?? stated(a.lens);
    const lensB = stated(b.focalLength) ?? stated(b.lens);
    if (lensA && lensB && !same(lensA, lensB)) {
      findings.push({
        key: key(["CAMERA", a.id, b.id, "lens"]),
        category: "CAMERA",
        severity: "INFO",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: "Lens",
        whatChanged: `Lens changes from ${lensA} to ${lensB}.`,
        whyItMayMatter:
          "Usually intentional coverage. Noted because lens character — compression and depth — carries across a cut.",
      });
    }

    const heightChange = comparedValues(a.cameraHeight, b.cameraHeight);
    if (heightChange) {
      findings.push({
        key: key(["CAMERA", a.id, b.id, "height"]),
        category: "CAMERA",
        severity: "INFO",
        relation,
        shotAId: a.id,
        shotBId: b.id,
        subject: "Camera height",
        whatChanged: `Camera height changes from ${heightChange.from} to ${heightChange.to}.`,
        whyItMayMatter:
          "Usually intentional. Noted because height shifts the audience's relationship to the character.",
      });
    }

    return findings;
  },
];

const ALL_RULES: Rule[] = [
  ...characterRules,
  ...environmentRules,
  ...propRules,
  ...spatialRules,
  ...cameraRules,
];

const SEVERITY_ORDER: Record<Severity, number> = {
  POTENTIAL_ISSUE: 0,
  REVIEW: 1,
  INFO: 2,
};

/**
 * Builds the pairs of shots worth comparing.
 *
 * Consecutive shots within a scene, plus shots the filmmaker placed next to each
 * other in an edit. Never every shot against every other shot: a project is not
 * required to be internally uniform, and Scene 1 DAY next to Scene 2 NIGHT is
 * not a mistake.
 */
export function buildPairs(input: AnalysisInput): Pair[] {
  const byId = new Map(input.shots.map((s) => [s.id, s]));
  const pairs: Pair[] = [];
  const seen = new Set<string>();

  const add = (a: ContinuityShot, b: ContinuityShot, relation: Relation) => {
    const id = `${relation}:${a.id}:${b.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push({ a, b, relation, sameScene: a.sceneId === b.sceneId });
  };

  const byScene = new Map<string, ContinuityShot[]>();
  for (const shot of input.shots) {
    const list = byScene.get(shot.sceneId) ?? [];
    list.push(shot);
    byScene.set(shot.sceneId, list);
  }
  for (const shots of byScene.values()) {
    const ordered = [...shots].sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));
    for (let i = 1; i < ordered.length; i++) add(ordered[i - 1], ordered[i], "consecutive-in-scene");
  }

  for (let i = 1; i < (input.editOrder?.length ?? 0); i++) {
    const a = byId.get(input.editOrder![i - 1]);
    const b = byId.get(input.editOrder![i]);
    // Adjacency already covered as consecutive-in-scene adds nothing.
    if (a && b && !seen.has(`consecutive-in-scene:${a.id}:${b.id}`)) {
      add(a, b, "adjacent-in-edit");
    }
  }

  return pairs;
}

/** Runs every rule over every pair. Pure: reads the input, writes nothing. */
export function analyseContinuity(input: AnalysisInput): ContinuityFinding[] {
  const findings: ContinuityFinding[] = [];
  for (const pair of buildPairs(input)) {
    for (const rule of ALL_RULES) findings.push(...rule(pair, input.scenes));
  }
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.key.localeCompare(b.key)
  );
}

/**
 * Attaches stored decisions to freshly derived findings.
 *
 * A decision annotates a difference; it never removes one. A dismissed finding
 * is still a finding — it is simply marked, and the panel can still show it.
 */
export function applyDecisions(
  findings: ContinuityFinding[],
  decisions: Record<string, DecisionStatus>
): ContinuityFinding[] {
  return findings.map((finding) => ({ ...finding, status: decisions[finding.key] }));
}

/** Findings with no decision yet — what the filmmaker still has to look at. */
export function openFindings(findings: ContinuityFinding[]): ContinuityFinding[] {
  return findings.filter((f) => f.status === undefined);
}

// --- timelines ---------------------------------------------------------------

/** What is known about a character in one shot. `undefined` means not stated. */
export interface CharacterTimelineEntry {
  shotId: string;
  shotNumber: string;
  sceneNumber: string;
  present: "blocked" | "unspecified";
  wardrobe?: string;
  hairMakeup?: string;
  carriedProps?: string;
  location?: string;
  framePosition?: string;
}

/**
 * A character's progression through the shots, so the filmmaker can read the
 * wardrobe/location/position sequence themselves rather than only being told
 * about differences.
 */
export function characterTimeline(
  input: AnalysisInput,
  characterLabel: string
): CharacterTimelineEntry[] {
  return orderedShots(input).map((shot) => {
    const blocking = blockingOf(shot);
    const inBlocking = blocking?.subjects.some((s) => same(s.label, characterLabel)) ?? false;
    const position = blocking && inBlocking ? framePositionOf(blocking, characterLabel) : undefined;

    return {
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      sceneNumber: input.scenes[shot.sceneId]?.number ?? "—",
      present: inBlocking ? "blocked" : "unspecified",
      wardrobe: stated(shot.wardrobe),
      hairMakeup: stated(shot.hairMakeup),
      carriedProps: stated(shot.characterProps),
      location: input.scenes[shot.sceneId]?.location,
      framePosition:
        position === undefined
          ? undefined
          : position < 40
            ? "left third"
            : position > 60
              ? "right third"
              : "centre",
    };
  });
}

/**
 * A prop's presence across the shots.
 *
 * Three states, and the third is the point: PRESENT, ABSENT (this shot places
 * props, and not this one) and UNSPECIFIED (this shot places no props at all).
 * Unspecified is never rendered as absent.
 */
export type PropPresence = "present" | "absent" | "unspecified";

export interface PropTimelineEntry {
  shotId: string;
  shotNumber: string;
  sceneNumber: string;
  presence: PropPresence;
}

export function propTimeline(input: AnalysisInput, propLabel: string): PropTimelineEntry[] {
  return orderedShots(input).map((shot) => {
    const blocking = blockingOf(shot);
    const presence: PropPresence = !blocking
      ? "unspecified"
      : blocking.props.length === 0
        ? "unspecified"
        : blocking.props.some((p) => same(p.label, propLabel))
          ? "present"
          : "absent";

    return {
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      sceneNumber: input.scenes[shot.sceneId]?.number ?? "—",
      presence,
    };
  });
}

/** Every character label that appears on any blocking stage. */
export function trackedCharacters(input: AnalysisInput): string[] {
  return uniqueLabels(input, (b) => b.subjects.map((s) => s.label));
}

/** Every prop label placed on any blocking stage. */
export function trackedProps(input: AnalysisInput): string[] {
  return uniqueLabels(input, (b) => b.props.map((p) => p.label));
}

function uniqueLabels(input: AnalysisInput, pick: (b: ShotBlocking) => string[]): string[] {
  const seen = new Map<string, string>();
  for (const shot of input.shots) {
    const blocking = blockingOf(shot);
    if (!blocking) continue;
    for (const label of pick(blocking)) {
      const normalised = label.toLowerCase();
      if (!seen.has(normalised)) seen.set(normalised, label);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Shots in the edit's order if there is one, otherwise scene then shot order. */
function orderedShots(input: AnalysisInput): ContinuityShot[] {
  if (input.editOrder?.length) {
    const byId = new Map(input.shots.map((s) => [s.id, s]));
    const ordered = input.editOrder.map((id) => byId.get(id)).filter((s): s is ContinuityShot => Boolean(s));
    if (ordered.length > 0) return ordered;
  }
  return [...input.shots].sort((a, b) => {
    const sceneA = input.scenes[a.sceneId]?.number ?? "";
    const sceneB = input.scenes[b.sceneId]?.number ?? "";
    return sceneA.localeCompare(sceneB, undefined, { numeric: true }) || a.order - b.order;
  });
}
