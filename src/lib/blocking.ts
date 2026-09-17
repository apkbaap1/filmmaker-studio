import { z } from "zod";

/**
 * Spatial blocking for the composition canvas.
 *
 * All coordinates are normalised to a 0–100 stage so the data is independent of
 * the rendered canvas size. Angles are degrees, 0 = pointing up the stage
 * (towards negative Y / "upstage"), increasing clockwise.
 *
 * This is persisted on ShotListItem.blocking — the Shot remains the single
 * source of truth. Nothing here is inferred into the Shot's textual fields:
 * dragging the camera never rewrites `cameraStartPosition`, and moving a subject
 * in frame never rewrites `composition`. The filmmaker promotes a spatial state
 * into text explicitly (see describeFramePosition).
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

export const blockingSchema = z.object({
  version: z.literal(1),
  cameraStart: cameraSchema,
  /** Only set when the camera physically moves during the shot. */
  cameraEnd: cameraSchema.optional(),
  subjects: z.array(subjectSchema).max(12),
  props: z.array(propSchema).max(24),
  frame: frameSchema,
});

export type Point = z.infer<typeof pointSchema>;
export type CameraState = z.infer<typeof cameraSchema>;
export type SubjectPose = z.infer<typeof subjectPoseSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type Prop = z.infer<typeof propSchema>;
export type FrameState = z.infer<typeof frameSchema>;
export type ShotBlocking = z.infer<typeof blockingSchema>;

export function defaultBlocking(subjectLabel = "Subject"): ShotBlocking {
  return {
    version: 1,
    cameraStart: { x: 50, y: 85, rotation: 0, fov: 40 },
    subjects: [
      {
        id: "subject-1",
        label: subjectLabel,
        start: { x: 50, y: 40, orientation: 180 },
      },
    ],
    props: [],
    frame: { subjectX: 50, subjectY: 50, subjectScale: 45, eyelineY: 33 },
  };
}

/**
 * Reads blocking off a shot row. Anything malformed or absent falls back to a
 * fresh default rather than throwing — a bad blob must never make a shot
 * unopenable, and the Shot's textual fields remain intact regardless.
 */
export function parseBlocking(value: unknown, subjectLabel?: string): ShotBlocking {
  if (value === null || value === undefined) return defaultBlocking(subjectLabel);
  const parsed = blockingSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultBlocking(subjectLabel);
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

/**
 * The 180-degree axis: the line actors' relationships are read across.
 *
 * With two or more subjects it runs between the first two. With a single
 * subject it runs along the camera-to-subject axis. Returns undefined when
 * there is nothing to draw — never a guessed line.
 */
export function axisLine(blocking: ShotBlocking): [Point, Point] | undefined {
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

/** Whether the camera has crossed the axis between its start and end positions. */
export function crossesAxis(blocking: ShotBlocking): boolean {
  const axis = axisLine(blocking);
  const end = blocking.cameraEnd;
  if (!axis || !end) return false;

  const [a, b] = axis;
  const side = (p: Point) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  const startSide = side(blocking.cameraStart);
  const endSide = side(end);
  return startSide !== 0 && endSide !== 0 && startSide !== endSide;
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
