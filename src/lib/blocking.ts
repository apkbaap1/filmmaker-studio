import { z } from "zod";

/**
 * Spatial blocking for the camera-blocking workspace.
 *
 * All coordinates are normalised to a 0–100 stage so the data is independent of
 * the rendered canvas size. Angles are degrees, 0 = pointing up the stage
 * (towards negative Y / "upstage"), increasing clockwise.
 *
 * This is persisted on ShotListItem.blocking — the Shot remains the single
 * source of truth, and this is the only spatial store in the application. There
 * is no separate camera-blocking record: the diagram, the frame preview and the
 * compiler all read this one blob. Nothing here is inferred into the Shot's
 * textual fields: dragging the camera never rewrites `cameraStartPosition`, and
 * moving a subject in frame never rewrites `composition`. The filmmaker promotes
 * a spatial state into text explicitly (see describeFramePosition).
 *
 * Version 2 adds camera and subject *paths* (ordered waypoints rather than a
 * bare start/end pair), an explicitly chosen 180° axis, and an optional
 * real-world scale. Version 1 blobs are upgraded on read — see parseBlocking.
 */

const pointSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});

const cameraSchema = pointSchema.extend({
  /** Direction the lens points, in degrees. */
  rotation: z.number().min(-360).max(360),
  /** Horizontal field of view in degrees — a wider lens draws a wider cone. */
  fov: z.number().min(1).max(180),
});

const subjectPoseSchema = pointSchema.extend({
  /** Facing direction in degrees. */
  orientation: z.number().min(-360).max(360),
});

const subjectSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  start: subjectPoseSchema,
  /** Only set when the subject physically moves during the shot. */
  end: subjectPoseSchema.optional(),
  /**
   * Ordered intermediate points between start and end, for a path that is not a
   * straight line. Empty is a straight walk — never a curve invented for them.
   */
  waypoints: z.array(pointSchema).max(8).default([]),
});

const propSchema = pointSchema.extend({
  id: z.string().min(1),
  label: z.string().min(1).max(60),
  layer: z.enum(["foreground", "midground", "background"]),
});

/** Where the primary subject sits inside the 16:9 frame, and how much of it they fill. */
const frameSchema = z.object({
  subjectX: z.number().min(0).max(100),
  subjectY: z.number().min(0).max(100),
  /** Share of frame height the subject occupies, as a percentage. */
  subjectScale: z.number().min(1).max(100),
  /** Horizontal line the subject's eyes sit on, as a percentage of frame height. */
  eyelineY: z.number().min(0).max(100),
});

/**
 * How the 180° axis is established for this shot.
 *
 * `auto` keeps the version-1 behaviour (between the first two subjects, or the
 * camera-to-subject line for a single subject). The other modes are the
 * filmmaker saying outright which relationship the scene is cut across — most
 * importantly `subject-movement`, where the line runs along a character's
 * direction of travel rather than between two people.
 */
const axisSchema = z.object({
  mode: z.enum(["auto", "between-subjects", "subject-movement", "custom"]),
  /** For `between-subjects`: which two. */
  subjectIds: z.array(z.string()).max(2).optional(),
  /** For `subject-movement`: whose travel defines the line. */
  subjectId: z.string().optional(),
  /** For `custom`: the line itself. */
  custom: z.array(pointSchema).length(2).optional(),
});

/**
 * Real-world size of the stage. Optional, and absent by default: without it,
 * distances are reported in stage units and no metric figure is claimed. It is
 * a measurement the filmmaker supplies, never one derived from the diagram.
 */
const worldSchema = z.object({
  widthMetres: z.number().positive().max(1000),
  depthMetres: z.number().positive().max(1000),
});

export const blockingSchema = z.object({
  version: z.literal(2),
  cameraStart: cameraSchema,
  /** Only set when the camera physically moves during the shot. */
  cameraEnd: cameraSchema.optional(),
  /**
   * Ordered intermediate points between cameraStart and cameraEnd. A camera
   * move is a path, not a label: `cameraMovement = "Dolly In"` on the Shot says
   * what kind of move it is, and this says where it actually goes. Neither is
   * derived from the other.
   */
  cameraWaypoints: z.array(pointSchema).max(8).default([]),
  subjects: z.array(subjectSchema).max(12),
  props: z.array(propSchema).max(24),
  frame: frameSchema,
  axis: axisSchema.optional(),
  world: worldSchema.optional(),
});

export type Point = z.infer<typeof pointSchema>;
export type CameraState = z.infer<typeof cameraSchema>;
export type SubjectPose = z.infer<typeof subjectPoseSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type AxisDefinition = z.infer<typeof axisSchema>;
export type WorldScale = z.infer<typeof worldSchema>;
export type Prop = z.infer<typeof propSchema>;
export type FrameState = z.infer<typeof frameSchema>;
export type ShotBlocking = z.infer<typeof blockingSchema>;

export function defaultBlocking(subjectLabel = "Subject"): ShotBlocking {
  return {
    version: 2,
    cameraStart: { x: 50, y: 85, rotation: 0, fov: 40 },
    cameraWaypoints: [],
    subjects: [
      {
        id: "subject-1",
        label: subjectLabel,
        start: { x: 50, y: 40, orientation: 180 },
        waypoints: [],
      },
    ],
    props: [],
    frame: { subjectX: 50, subjectY: 50, subjectScale: 45, eyelineY: 33 },
  };
}

/**
 * Version-1 blocking, as written before camera/subject paths existed. Kept so
 * shots blocked in earlier phases upgrade instead of silently reverting to a
 * default — losing a filmmaker's camera placement would be the worst possible
 * way to ship a schema change.
 */
const legacyV1Schema = z.object({
  version: z.literal(1),
  cameraStart: cameraSchema,
  cameraEnd: cameraSchema.optional(),
  subjects: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1).max(60),
        start: subjectPoseSchema,
        end: subjectPoseSchema.optional(),
      })
    )
    .max(12),
  props: z.array(propSchema).max(24),
  frame: frameSchema,
});

/**
 * Upgrades a version-1 blob. Purely additive: every v1 value is carried through
 * unchanged, and the new fields start empty. No path is invented from a
 * start/end pair, and no axis mode is chosen on the filmmaker's behalf —
 * omitting `axis` leaves the v1 automatic behaviour exactly as it was.
 */
export function upgradeBlocking(legacy: z.infer<typeof legacyV1Schema>): ShotBlocking {
  return {
    version: 2,
    cameraStart: legacy.cameraStart,
    cameraEnd: legacy.cameraEnd,
    cameraWaypoints: [],
    subjects: legacy.subjects.map((s) => ({ ...s, waypoints: [] })),
    props: legacy.props,
    frame: legacy.frame,
  };
}

/**
 * Reads blocking off a shot row. Anything malformed or absent falls back to a
 * fresh default rather than throwing — a bad blob must never make a shot
 * unopenable, and the Shot's textual fields remain intact regardless. A
 * version-1 blob is upgraded rather than discarded.
 */
export function parseBlocking(value: unknown, subjectLabel?: string): ShotBlocking {
  if (value === null || value === undefined) return defaultBlocking(subjectLabel);
  const parsed = blockingSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const legacy = legacyV1Schema.safeParse(value);
  if (legacy.success) return upgradeBlocking(legacy.data);

  return defaultBlocking(subjectLabel);
}

/** Degrees → radians, with 0° pointing up the stage. */
function toRadians(degrees: number): number {
  return ((degrees - 90) * Math.PI) / 180;
}

/**
 * The two edge points of the camera's field-of-view cone, for drawing.
 * `length` is in stage units.
 */
export function fieldOfViewEdges(camera: CameraState, length = 70): [Point, Point] {
  const half = camera.fov / 2;
  const edge = (offset: number): Point => {
    const angle = toRadians(camera.rotation + offset);
    return {
      x: camera.x + Math.cos(angle) * length,
      y: camera.y + Math.sin(angle) * length,
    };
  };
  return [edge(-half), edge(half)];
}

// --- paths -------------------------------------------------------------------

/**
 * The camera's path through the shot: start, any waypoints, then the end.
 *
 * A single point means the camera does not move. The path is never derived from
 * `Shot.cameraMovement`: "Dolly In" says what kind of move it is, this says
 * where it goes, and a shot can legitimately have one without the other.
 */
export function cameraPathPoints(blocking: ShotBlocking): Point[] {
  const start = { x: blocking.cameraStart.x, y: blocking.cameraStart.y };
  if (!blocking.cameraEnd) return [start];
  return [
    start,
    ...blocking.cameraWaypoints.map((w) => ({ x: w.x, y: w.y })),
    { x: blocking.cameraEnd.x, y: blocking.cameraEnd.y },
  ];
}

/** The same, for one subject. A single point means the subject holds position. */
export function subjectPathPoints(subject: Subject): Point[] {
  const start = { x: subject.start.x, y: subject.start.y };
  if (!subject.end) return [start];
  return [
    start,
    ...subject.waypoints.map((w) => ({ x: w.x, y: w.y })),
    { x: subject.end.x, y: subject.end.y },
  ];
}

/** Total travelled distance along a path, in stage units. */
export function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Converts a stage distance to metres, but only when the filmmaker has stated
 * the stage's real size. Without a world scale this returns undefined rather
 * than a number with an invented unit.
 *
 * The stage is not necessarily square, so the two axes can scale differently;
 * this uses their mean, which is exact for a square stage and honest for others.
 */
export function toMetres(stageUnits: number, world: WorldScale | undefined): number | undefined {
  if (!world) return undefined;
  const metresPerUnit = (world.widthMetres + world.depthMetres) / 2 / 100;
  return Math.round(stageUnits * metresPerUnit * 100) / 100;
}

/**
 * Speed along a path — only when BOTH an explicit path and an explicit duration
 * exist. Never inferred from a movement label like "Slow": that is a feel, not a
 * measurement, and the two are allowed to disagree.
 */
export function pathSpeed(
  points: Point[],
  durationSeconds: number | null | undefined,
  world: WorldScale | undefined
): { unitsPerSecond: number; metresPerSecond?: number } | undefined {
  if (points.length < 2) return undefined;
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }
  const units = pathLength(points);
  const metres = toMetres(units, world);
  return {
    unitsPerSecond: Math.round((units / durationSeconds) * 100) / 100,
    ...(metres === undefined ? {} : { metresPerSecond: Math.round((metres / durationSeconds) * 100) / 100 }),
  };
}

// --- the 180-degree axis -----------------------------------------------------

/**
 * The 180-degree axis: the line actors' relationships are read across.
 *
 * `auto` (and an absent `axis`) keeps the version-1 behaviour: between the first
 * two subjects, or along the camera-to-subject line for a single subject. The
 * explicit modes let the filmmaker say which relationship the scene is actually
 * cut across — including `subject-movement`, where the line runs along a
 * character's direction of travel.
 *
 * Returns undefined when there is nothing to draw. Never a guessed line.
 */
export function axisLine(blocking: ShotBlocking): [Point, Point] | undefined {
  const axis = blocking.axis;

  if (axis?.mode === "custom") {
    const [a, b] = axis.custom ?? [];
    return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : undefined;
  }

  if (axis?.mode === "subject-movement") {
    const subject = blocking.subjects.find((s) => s.id === axis.subjectId) ?? blocking.subjects[0];
    if (!subject) return undefined;
    const path = subjectPathPoints(subject);
    // A subject who does not move defines no direction of travel, so there is
    // no line to draw rather than a fabricated one.
    if (path.length < 2) return undefined;
    return [path[0], path[path.length - 1]];
  }

  if (axis?.mode === "between-subjects") {
    const [firstId, secondId] = axis.subjectIds ?? [];
    const first = blocking.subjects.find((s) => s.id === firstId);
    const second = blocking.subjects.find((s) => s.id === secondId);
    if (!first || !second) return undefined;
    return [
      { x: first.start.x, y: first.start.y },
      { x: second.start.x, y: second.start.y },
    ];
  }

  const [first, second] = blocking.subjects;
  if (first && second) {
    return [
      { x: first.start.x, y: first.start.y },
      { x: second.start.x, y: second.start.y },
    ];
  }
  if (first) {
    return [
      { x: blocking.cameraStart.x, y: blocking.cameraStart.y },
      { x: first.start.x, y: first.start.y },
    ];
  }
  return undefined;
}

/**
 * Which side of the axis a point sits on: -1, 0 (on the line) or 1. Sides have
 * no inherent meaning — what matters is whether two points share one.
 */
export function axisSide(point: Point, axis: [Point, Point]): -1 | 0 | 1 {
  const [a, b] = axis;
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  return Math.sign(cross) as -1 | 0 | 1;
}

/**
 * Whether the camera crosses the axis at any point along its path — waypoints
 * included, so a move that loops across the line and back is still flagged.
 *
 * This is a warning, never a prohibition. Crossing the line is a legitimate
 * choice, and the workspace's job is to make sure it is a choice rather than an
 * accident.
 */
export function crossesAxis(blocking: ShotBlocking): boolean {
  const axis = axisLine(blocking);
  if (!axis) return false;

  const path = cameraPathPoints(blocking);
  if (path.length < 2) return false;

  const sides = path.map((p) => axisSide(p, axis)).filter((s) => s !== 0);
  return sides.some((side) => side !== sides[0]);
}

export interface AxisReport {
  axis?: [Point, Point];
  /** How the line was established, for the diagram's label. */
  source: "unset" | "between-subjects" | "subject-movement" | "custom" | "camera-to-subject";
  /** Which side the camera starts on, and ends on if it moves. */
  startSide: -1 | 0 | 1;
  endSide?: -1 | 0 | 1;
  crosses: boolean;
}

/** Everything the diagram and the warning banner need, computed once. */
export function axisReport(blocking: ShotBlocking): AxisReport {
  const axis = axisLine(blocking);
  if (!axis) return { source: "unset", startSide: 0, crosses: false };

  const mode = blocking.axis?.mode ?? "auto";
  const source =
    mode === "custom"
      ? "custom"
      : mode === "subject-movement"
        ? "subject-movement"
        : mode === "between-subjects"
          ? "between-subjects"
          : blocking.subjects.length >= 2
            ? "between-subjects"
            : "camera-to-subject";

  const path = cameraPathPoints(blocking);
  return {
    axis,
    source,
    startSide: axisSide(path[0], axis),
    endSide: path.length > 1 ? axisSide(path[path.length - 1], axis) : undefined,
    crosses: crossesAxis(blocking),
  };
}

// --- top-down geometry -> frame ---------------------------------------------

export interface FrameProjection {
  /** Horizontal placement in frame, 0–100, when the subject is inside the FOV. */
  subjectX?: number;
  /** True when the subject falls outside the camera's field of view. */
  outOfFrame: boolean;
  /** Camera-to-subject distance in stage units. */
  distance: number;
  /** Signed angle off the lens axis, degrees. Negative is frame-left. */
  offAxisDegrees: number;
}

/**
 * Projects a subject's position onto the camera's frame.
 *
 * This is the link that stops the top-down diagram and the frame view being two
 * opinions: the horizontal placement is pure geometry from the camera's
 * position, rotation and field of view, so moving the camera moves the subject
 * in frame with no second value to keep in sync.
 *
 * Only the horizontal axis is projected. Vertical placement and subject size
 * depend on camera height and the performer's real height, which the diagram
 * does not record — so they are left to the filmmaker rather than guessed.
 */
export function projectSubjectToFrame(camera: CameraState, subject: Point): FrameProjection {
  const dx = subject.x - camera.x;
  const dy = subject.y - camera.y;
  const distance = Math.round(Math.hypot(dx, dy) * 100) / 100;

  if (distance === 0) {
    return { outOfFrame: true, distance: 0, offAxisDegrees: 0 };
  }

  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  const offAxis = normalizeAngle(bearing - camera.rotation);
  const half = camera.fov / 2;

  if (Math.abs(offAxis) > half) {
    return { outOfFrame: true, distance, offAxisDegrees: round1(offAxis) };
  }

  return {
    subjectX: round1(50 + (offAxis / half) * 50),
    outOfFrame: false,
    distance,
    offAxisDegrees: round1(offAxis),
  };
}

/**
 * How the subject's apparent size changes between two camera positions.
 *
 * Apparent size scales with 1/distance, so this needs no assumption about how
 * tall anyone is — only a starting size to scale *from*, which the filmmaker
 * already set in the frame view. Undefined when either distance is zero.
 */
export function scaleAtDistance(
  startScale: number,
  startDistance: number,
  endDistance: number
): number | undefined {
  if (startDistance <= 0 || endDistance <= 0) return undefined;
  return Math.min(100, Math.max(1, round1((startScale * startDistance) / endDistance)));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Describes where the subject sits in frame, in the vocabulary a filmmaker
 * would type into the composition field.
 *
 * This is offered as a suggestion the filmmaker applies explicitly — it is
 * never written into the Shot automatically, because a derived description is
 * not the same as a stated compositional intent.
 */
export function describeFramePosition(frame: FrameState, subjectLabel = "Subject"): string {
  const horizontal =
    frame.subjectX < 40 ? "on the left third" : frame.subjectX > 60 ? "on the right third" : "centred";
  const vertical = frame.subjectY < 35 ? ", high in frame" : frame.subjectY > 65 ? ", low in frame" : "";
  return `${subjectLabel} ${horizontal}${vertical}`;
}

/**
 * Normalises an angle to the half-open range [-180, 180).
 */
function normalizeAngle(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * Does the camera end nearer to or further from the subject than it started?
 *
 * Pure geometry: two distances compared. It says the camera closed in, not that
 * it "dollied in" — the kind of move is the filmmaker's word on the Shot, and
 * this is only what the diagram actually shows. Undefined when the camera does
 * not move, or when the change is too small to be a decision (under 5% of the
 * starting distance).
 */
export function describeCameraApproach(
  blocking: ShotBlocking,
  subjectLabel?: string
): string | undefined {
  const subject = blocking.subjects[0];
  if (!subject || !blocking.cameraEnd) return undefined;

  const target = subject.end ?? subject.start;
  const startDistance = Math.hypot(
    subject.start.x - blocking.cameraStart.x,
    subject.start.y - blocking.cameraStart.y
  );
  const endDistance = Math.hypot(target.x - blocking.cameraEnd.x, target.y - blocking.cameraEnd.y);
  if (startDistance === 0) return undefined;

  const change = (endDistance - startDistance) / startDistance;
  if (Math.abs(change) < 0.05) return undefined;

  const label = subject.label || subjectLabel || "the subject";
  return change < 0
    ? `Camera ends closer to ${label} than it began`
    : `Camera ends further from ${label} than it began`;
}

/**
 * Which way the subject is turned relative to the camera, as a clause.
 *
 * Pure geometry: the bearing from the subject to the camera is compared with
 * the subject's own facing, and the difference is bucketed into the five
 * orientations a director would name. Nothing else about the layout is read,
 * and no handedness ("turned to frame left") is claimed — that would depend on
 * conventions the canvas does not actually encode.
 */
export function describeSubjectFacing(
  blocking: ShotBlocking,
  subjectLabel = "Subject",
  subjectIndex = 0
): string | undefined {
  const subject = blocking.subjects[subjectIndex];
  if (!subject) return undefined;

  const camera = blocking.cameraStart;
  const dx = camera.x - subject.start.x;
  const dy = camera.y - subject.start.y;
  if (dx === 0 && dy === 0) return undefined;

  // Inverse of toRadians: back to the 0 = up-the-stage, clockwise convention.
  const bearingToCamera = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  const offset = Math.abs(normalizeAngle(subject.start.orientation - bearingToCamera));

  const orientation =
    offset < 22.5
      ? "facing the camera"
      : offset < 67.5
        ? "angled toward the camera"
        : offset < 112.5
          ? "in profile to the camera"
          : offset < 157.5
            ? "angled away from the camera"
            : "facing away from the camera";

  return `${subject.label || subjectLabel} ${orientation}`;
}

const PROP_LAYER_ORDER = ["foreground", "midground", "background"] as const;

/**
 * Props grouped under the depth layer the filmmaker explicitly assigned them.
 * Only the label and the stated layer are used — a prop's X/Y never becomes a
 * spatial relationship in prose, because the canvas does not record which
 * relationships the filmmaker considered meaningful.
 */
export function describePropLayers(blocking: ShotBlocking): string | undefined {
  const groups = PROP_LAYER_ORDER.map((layer) => {
    const labels = blocking.props.filter((p) => p.layer === layer).map((p) => p.label);
    return labels.length > 0 ? `${layer}: ${labels.join(", ")}` : undefined;
  }).filter((g): g is string => Boolean(g));

  return groups.length > 0 ? groups.join("; ") : undefined;
}

/**
 * Deterministic, already-textual facts derived from a shot's blocking, for the
 * prompt compiler to consume. Returns `undefined` when the shot has no saved
 * blocking at all: an untouched canvas is a default, not a compositional
 * decision, and defaults must never reach a prompt.
 */
export interface DerivedBlocking {
  /** Frame placement in composition vocabulary; only a fallback for an unstated composition. */
  framePlacement?: string;
  /** The primary subject's facing, kept for the single-character case. */
  subjectFacing?: string;
  /** Every subject's facing, so a two-hander is not described as a solo. */
  subjectFacings?: string;
  /** Whether the camera closes in or pulls back, from the two distances alone. */
  cameraApproach?: string;
  propLayers?: string;
}

export function deriveBlockingContext(
  value: unknown,
  subjectLabel?: string
): DerivedBlocking | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = blockingSchema.safeParse(value);
  if (!parsed.success) return undefined;

  const facings = parsed.data.subjects
    .map((_, index) => describeSubjectFacing(parsed.data, subjectLabel, index))
    .filter((f): f is string => Boolean(f));

  return {
    framePlacement: describeFramePosition(parsed.data.frame, subjectLabel),
    subjectFacing: facings[0],
    // Only stated when there is more than one, so a single-character shot reads
    // exactly as it did before.
    subjectFacings: facings.length > 1 ? facings.join("; ") : undefined,
    cameraApproach: describeCameraApproach(parsed.data, subjectLabel),
    propLayers: describePropLayers(parsed.data),
  };
}
