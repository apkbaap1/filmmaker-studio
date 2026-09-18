import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  axisReport,
  axisSide,
  blockingSchema,
  cameraPathPoints,
  crossesAxis,
  defaultBlocking,
  deriveBlockingContext,
  describeCameraApproach,
  describeSubjectFacing,
  parseBlocking,
  pathLength,
  pathSpeed,
  projectSubjectToFrame,
  scaleAtDistance,
  subjectPathPoints,
  toMetres,
  upgradeBlocking,
  type ShotBlocking,
  type Subject,
} from "./blocking.ts";
import { buildShotContext, generateVideoPrompt } from "./prompt/index.ts";

/**
 * Phase 8 — the camera-blocking workspace.
 *
 * Everything here reads or writes the one `ShotListItem.blocking` blob. There is
 * no second spatial store, so these are tests of the same record the Phase 4
 * canvas, the frame preview and the prompt compiler all use.
 */

function subject(partial: Partial<Subject> & { id: string; label: string }): Subject {
  return {
    start: { x: 50, y: 40, orientation: 180 },
    waypoints: [],
    ...partial,
  };
}

// --- the brief's shot --------------------------------------------------------
// Ravi enters an abandoned railway station. Camera behind and slightly left of
// him; Ravi starts foreground-left and walks toward the centre of the platform;
// camera dollies in behind him. Axis along Ravi's direction of travel.
const RAVI: Subject = {
  id: "ravi",
  label: "Ravi",
  start: { x: 30, y: 70, orientation: 34 },
  end: { x: 50, y: 40, orientation: 34 },
  waypoints: [],
};

const STATION: ShotBlocking = {
  version: 2,
  // Behind and slightly left of Ravi, dollying in behind him. The camera ends
  // 12.65 units from where Ravi ends, having started 18.97 from where he began.
  cameraStart: { x: 24, y: 88, rotation: 25, fov: 40 },
  cameraEnd: { x: 46, y: 52, rotation: 25, fov: 40 },
  cameraWaypoints: [],
  subjects: [RAVI],
  props: [{ id: "bench", label: "Platform bench", x: 18, y: 66, layer: "foreground" }],
  frame: { subjectX: 30, subjectY: 50, subjectScale: 40, eyelineY: 33 },
  axis: { mode: "subject-movement", subjectId: "ravi" },
  world: { widthMetres: 20, depthMetres: 20 },
};

describe("schema v2 — no second source of truth, no lost data", () => {
  it("round-trips the whole record unchanged", () => {
    const parsed = blockingSchema.safeParse(STATION);
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data, STATION);
  });

  it("upgrades a version-1 blob instead of discarding the filmmaker's work", () => {
    const legacy = {
      version: 1,
      cameraStart: { x: 24, y: 88, rotation: 20, fov: 40 },
      cameraEnd: { x: 34, y: 74, rotation: 20, fov: 40 },
      subjects: [
        { id: "ravi", label: "Ravi", start: { x: 30, y: 70, orientation: 0 } },
        { id: "b", label: "Guard", start: { x: 70, y: 40, orientation: 200 } },
      ],
      props: [{ id: "bench", label: "Platform bench", x: 18, y: 66, layer: "background" }],
      frame: { subjectX: 30, subjectY: 50, subjectScale: 40, eyelineY: 33 },
    };
    const upgraded = parseBlocking(legacy, "Ravi");

    assert.equal(upgraded.version, 2);
    assert.deepEqual(upgraded.cameraStart, legacy.cameraStart);
    assert.deepEqual(upgraded.cameraEnd, legacy.cameraEnd);
    assert.deepEqual(upgraded.frame, legacy.frame);
    assert.equal(upgraded.subjects.length, 2);
    assert.equal(upgraded.subjects[1].label, "Guard");
    assert.equal(upgraded.props[0].label, "Platform bench");
  });

  it("invents no path, axis or world scale while upgrading", () => {
    const upgraded = upgradeBlocking({
      version: 1,
      cameraStart: { x: 50, y: 85, rotation: 0, fov: 40 },
      cameraEnd: { x: 50, y: 60, rotation: 0, fov: 40 },
      subjects: [{ id: "a", label: "A", start: { x: 50, y: 40, orientation: 180 } }],
      props: [],
      frame: { subjectX: 50, subjectY: 50, subjectScale: 45, eyelineY: 33 },
    });
    assert.deepEqual(upgraded.cameraWaypoints, []);
    assert.deepEqual(upgraded.subjects[0].waypoints, []);
    assert.equal(upgraded.axis, undefined);
    assert.equal(upgraded.world, undefined);
  });

  it("still recovers rather than throwing on a blob that is neither version", () => {
    assert.equal(parseBlocking({ version: 99, nonsense: true }, "Ravi").version, 2);
    assert.equal(deriveBlockingContext({ version: 99 }, "Ravi"), undefined);
  });
});

describe("camera position, orientation and path", () => {
  it("reports a single point when the camera does not move", () => {
    const still: ShotBlocking = { ...STATION, cameraEnd: undefined };
    assert.deepEqual(cameraPathPoints(still), [{ x: 24, y: 88 }]);
    assert.equal(pathLength(cameraPathPoints(still)), 0);
  });

  it("runs the path from start through waypoints to end", () => {
    const withWaypoints: ShotBlocking = {
      ...STATION,
      cameraWaypoints: [{ x: 30, y: 78 }, { x: 38, y: 64 }],
    };
    assert.deepEqual(cameraPathPoints(withWaypoints), [
      { x: 24, y: 88 },
      { x: 30, y: 78 },
      { x: 38, y: 64 },
      { x: 46, y: 52 },
    ]);
  });

  it("measures the path through its waypoints, not start-to-end", () => {
    const direct = pathLength([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    const detour = pathLength([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    assert.equal(direct, 10);
    assert.ok(detour > direct, "a dog-leg is longer than a straight line");
  });

  it("keeps orientation independent of position", () => {
    // A camera can pan without moving, and move without panning.
    const panned: ShotBlocking = {
      ...STATION,
      cameraEnd: { ...STATION.cameraStart, rotation: 75 },
    };
    assert.equal(pathLength(cameraPathPoints(panned)), 0);
    assert.equal(panned.cameraEnd?.rotation, 75);
    assert.equal(panned.cameraStart.rotation, 25);
  });

  it("does not derive a path from the shot's movement wording", () => {
    // A shot may say "Dolly In" and have no path drawn yet. That stays empty.
    const unblocked = defaultBlocking("Ravi");
    assert.equal(unblocked.cameraEnd, undefined);
    assert.deepEqual(cameraPathPoints(unblocked), [{ x: 50, y: 85 }]);
  });
});

describe("subject positions, facing and paths", () => {
  it("gives every subject an independent position, facing and path", () => {
    const twoHander: ShotBlocking = {
      ...STATION,
      subjects: [
        RAVI,
        subject({
          id: "guard",
          label: "Guard",
          start: { x: 72, y: 38, orientation: 250 },
          end: { x: 62, y: 44, orientation: 230 },
        }),
      ],
    };

    assert.deepEqual(subjectPathPoints(twoHander.subjects[0]), [
      { x: 30, y: 70 },
      { x: 50, y: 40 },
    ]);
    assert.deepEqual(subjectPathPoints(twoHander.subjects[1]), [
      { x: 72, y: 38 },
      { x: 62, y: 44 },
    ]);
    assert.notEqual(
      twoHander.subjects[0].start.orientation,
      twoHander.subjects[1].start.orientation
    );
  });

  it("describes each subject's facing, not only the first", () => {
    const twoHander: ShotBlocking = {
      ...STATION,
      subjects: [
        subject({ id: "a", label: "Ravi", start: { x: 40, y: 40, orientation: 180 } }),
        subject({ id: "b", label: "Guard", start: { x: 60, y: 40, orientation: 0 } }),
      ],
    };
    const first = describeSubjectFacing(twoHander, "Ravi", 0);
    const second = describeSubjectFacing(twoHander, "Ravi", 1);
    assert.ok(first?.startsWith("Ravi "));
    assert.ok(second?.startsWith("Guard "));
    assert.notEqual(first, second);
  });

  it("carries both subjects' facing into the compiled prompt", () => {
    const twoHander: ShotBlocking = {
      ...STATION,
      subjects: [
        subject({ id: "a", label: "Ravi", start: { x: 40, y: 60, orientation: 180 } }),
        subject({ id: "b", label: "Guard", start: { x: 60, y: 60, orientation: 0 } }),
      ],
    };
    const derived = deriveBlockingContext(twoHander, "Ravi");
    assert.ok(derived?.subjectFacings?.includes("Ravi"));
    assert.ok(derived?.subjectFacings?.includes("Guard"));

    const { spec } = generateVideoPrompt(
      buildShotContext({ shotNumber: "1", shotType: "Two Shot" }, undefined, [], derived)
    );
    assert.ok(spec.subject.facing?.value.includes("Ravi"));
    assert.ok(spec.subject.facing?.value.includes("Guard"));
  });

  it("says nothing about a second subject when there is only one", () => {
    const derived = deriveBlockingContext(STATION, "Ravi");
    assert.equal(derived?.subjectFacings, undefined);
    assert.ok(derived?.subjectFacing?.startsWith("Ravi "));
  });

  it("holds position when no end is set — no drift invented", () => {
    const still = subject({ id: "a", label: "A" });
    assert.deepEqual(subjectPathPoints(still), [{ x: 50, y: 40 }]);
  });
});

describe("the 180-degree axis", () => {
  it("runs along the subject's direction of travel when that is what was chosen", () => {
    const report = axisReport(STATION);
    assert.equal(report.source, "subject-movement");
    assert.deepEqual(report.axis, [
      { x: 30, y: 70 },
      { x: 50, y: 40 },
    ]);
  });

  it("draws no line when the nominated character does not move", () => {
    const stationary: ShotBlocking = {
      ...STATION,
      subjects: [subject({ id: "ravi", label: "Ravi" })],
    };
    assert.equal(axisReport(stationary).axis, undefined);
    assert.equal(axisReport(stationary).source, "unset");
  });

  it("runs between two named characters in between-subjects mode", () => {
    const twoHander: ShotBlocking = {
      ...STATION,
      subjects: [
        subject({ id: "a", label: "A", start: { x: 30, y: 40, orientation: 90 } }),
        subject({ id: "b", label: "B", start: { x: 70, y: 40, orientation: 270 } }),
      ],
      axis: { mode: "between-subjects", subjectIds: ["a", "b"] },
    };
    assert.deepEqual(axisReport(twoHander).axis, [
      { x: 30, y: 40 },
      { x: 70, y: 40 },
    ]);
  });

  it("keeps the version-1 automatic behaviour when no mode is chosen", () => {
    const auto: ShotBlocking = { ...STATION, axis: undefined };
    // One subject, so the camera-to-subject line, exactly as in Phase 4.
    assert.deepEqual(axisReport(auto).axis, [
      { x: 24, y: 88 },
      { x: 30, y: 70 },
    ]);
    assert.equal(axisReport(auto).source, "camera-to-subject");
  });

  it("reports which side the camera starts and ends on", () => {
    const report = axisReport(STATION);
    assert.notEqual(report.startSide, undefined);
    assert.equal(report.startSide, report.endSide, "the dolly stays on one side");
    assert.equal(report.crosses, false);
  });

  it("warns when the camera crosses, and still allows it", () => {
    const axis: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 30, y: 70 },
      { x: 50, y: 40 },
    ];
    const crossing: ShotBlocking = {
      ...STATION,
      cameraEnd: { x: 12, y: 44, rotation: 200, fov: 40 },
    };
    assert.equal(crossesAxis(crossing), true);
    // A warning, not a veto: the record still saves and still parses.
    assert.ok(blockingSchema.safeParse(crossing).success);
    assert.notEqual(axisSide(crossing.cameraStart, axis), axisSide(crossing.cameraEnd!, axis));
  });

  it("catches a crossing that happens only at a waypoint", () => {
    // Out across the line and back again: the endpoints alone would miss it.
    const loop: ShotBlocking = {
      ...STATION,
      cameraWaypoints: [{ x: 10, y: 50 }],
    };
    assert.equal(crossesAxis(loop), true, "a detour across the line is still a crossing");
    assert.equal(crossesAxis({ ...loop, cameraWaypoints: [] }), false);
  });

  it("flags nothing when the camera does not move", () => {
    assert.equal(crossesAxis({ ...STATION, cameraEnd: undefined }), false);
  });
});

describe("frame preview projected from the diagram", () => {
  it("puts a subject on the lens axis in the centre of frame", () => {
    const projection = projectSubjectToFrame(
      { x: 50, y: 80, rotation: 0, fov: 40 },
      { x: 50, y: 40 }
    );
    assert.equal(projection.subjectX, 50);
    assert.equal(projection.offAxisDegrees, 0);
    assert.equal(projection.outOfFrame, false);
  });

  it("puts a subject to the camera's right on the right of frame, and vice versa", () => {
    const camera = { x: 50, y: 80, rotation: 0, fov: 60 };
    const right = projectSubjectToFrame(camera, { x: 62, y: 40 });
    const left = projectSubjectToFrame(camera, { x: 38, y: 40 });
    assert.ok(right.subjectX! > 50, `expected right of centre, got ${right.subjectX}`);
    assert.ok(left.subjectX! < 50, `expected left of centre, got ${left.subjectX}`);
    assert.ok(
      Math.abs(right.subjectX! - 50 - (50 - left.subjectX!)) < 0.05,
      "symmetric about the axis"
    );
  });

  it("moves the subject in frame when the camera turns — one value, not two", () => {
    const subjectAt = { x: 50, y: 40 };
    const centred = projectSubjectToFrame({ x: 50, y: 80, rotation: 0, fov: 60 }, subjectAt);
    const panned = projectSubjectToFrame({ x: 50, y: 80, rotation: 15, fov: 60 }, subjectAt);
    assert.equal(centred.subjectX, 50);
    assert.ok(panned.subjectX! < 50, "panning right moves the subject left in frame");
  });

  it("reports a subject outside the field of view instead of clamping them to an edge", () => {
    const projection = projectSubjectToFrame(
      { x: 50, y: 80, rotation: 0, fov: 20 },
      { x: 90, y: 60 }
    );
    assert.equal(projection.outOfFrame, true);
    assert.equal(projection.subjectX, undefined);
  });

  it("puts Ravi on the left third from the diagram's geometry alone", () => {
    const projection = projectSubjectToFrame(STATION.cameraStart, RAVI.start);
    assert.equal(projection.outOfFrame, false);
    assert.ok(
      projection.subjectX! < 40,
      `the brief's camera should frame Ravi left of centre, got ${projection.subjectX}`
    );
  });

  it("grows the subject as the camera closes in, from the stated start size only", () => {
    const start = projectSubjectToFrame(STATION.cameraStart, RAVI.start);
    const end = projectSubjectToFrame(STATION.cameraEnd!, RAVI.end!);
    const scaled = scaleAtDistance(STATION.frame.subjectScale, start.distance, end.distance);
    assert.ok(scaled !== undefined);
    assert.ok(scaled! > STATION.frame.subjectScale, "closer camera, bigger subject");
  });

  it("refuses to scale from a zero distance rather than dividing by it", () => {
    assert.equal(scaleAtDistance(40, 0, 10), undefined);
    assert.equal(scaleAtDistance(40, 10, 0), undefined);
  });
});

describe("geometry stays separate from duration", () => {
  it("measures the path in stage units, and in metres only with a stated scale", () => {
    const units = pathLength(cameraPathPoints(STATION));
    assert.ok(units > 0);
    assert.equal(toMetres(units, STATION.world), Math.round(units * 0.2 * 100) / 100);
    assert.equal(toMetres(units, undefined), undefined, "no scale, no metric claim");
  });

  it("computes speed only from an explicit path and an explicit duration", () => {
    const path = cameraPathPoints(STATION);
    const speed = pathSpeed(path, 6, STATION.world);
    assert.ok(speed);
    assert.equal(speed!.unitsPerSecond, Math.round((pathLength(path) / 6) * 100) / 100);
  });

  it("refuses to invent a speed when either half is missing", () => {
    const path = cameraPathPoints(STATION);
    assert.equal(pathSpeed(path, null, STATION.world), undefined, "no duration");
    assert.equal(pathSpeed(path, 0, STATION.world), undefined, "zero duration");
    assert.equal(pathSpeed([{ x: 0, y: 0 }], 6, STATION.world), undefined, "no path");
  });

  it("keeps duration out of the geometry entirely", () => {
    // The same 5-unit path is the same path whether the shot runs 2s or 20s.
    const path = cameraPathPoints(STATION);
    const length = pathLength(path);
    assert.equal(pathLength(cameraPathPoints(STATION)), length);
    assert.notEqual(pathSpeed(path, 2, undefined)?.unitsPerSecond, pathSpeed(path, 20, undefined)?.unitsPerSecond);
    assert.equal(pathLength(cameraPathPoints(STATION)), length, "duration changed nothing spatial");
  });
});

describe("what the diagram tells the compiler", () => {
  it("says the camera closes in, from the two distances alone", () => {
    const approach = describeCameraApproach(STATION, "Ravi");
    assert.equal(approach, "Camera ends closer to Ravi than it began");
  });

  it("says nothing when the camera does not move", () => {
    assert.equal(describeCameraApproach({ ...STATION, cameraEnd: undefined }, "Ravi"), undefined);
  });

  it("says nothing when the distance barely changes", () => {
    // A stationary subject and a camera that shuffles a few tenths of a unit:
    // real, but not a decision worth putting in a prompt.
    const nudged: ShotBlocking = {
      ...STATION,
      subjects: [subject({ id: "ravi", label: "Ravi", start: { x: 30, y: 70, orientation: 34 } })],
      cameraEnd: { x: 24.3, y: 87.6, rotation: 25, fov: 40 },
    };
    assert.equal(describeCameraApproach(nudged, "Ravi"), undefined);
  });

  it("emits no raw coordinate anywhere in the compiled prompt", () => {
    const derived = deriveBlockingContext(STATION, "Ravi");
    const { text } = generateVideoPrompt(
      buildShotContext(
        { shotNumber: "12", shotType: "Medium Close-Up", cameraMovement: "Dolly In" },
        { number: "4", intExt: "INT", location: "ABANDONED RAILWAY STATION", timeOfDay: "NIGHT" },
        [{ characterName: "Ravi" }],
        derived
      )
    );
    for (const coordinate of ["24", "88", "46", "52", "x:", "y:", "rotation"]) {
      assert.ok(!text.includes(coordinate), `raw value "${coordinate}" leaked:\n${text}`);
    }
    assert.ok(text.includes("Camera ends closer to Ravi than it began"));
  });

  it("reports nothing at all for a shot that was never blocked", () => {
    assert.equal(deriveBlockingContext(null, "Ravi"), undefined);
    const { spec } = generateVideoPrompt(
      buildShotContext({ shotNumber: "1", shotType: "Wide Shot" }, undefined, [], undefined)
    );
    assert.equal(spec.subject.facing, undefined);
    assert.equal(spec.motion.cameraApproach, undefined);
    assert.equal(spec.environment.props, undefined);
  });
});

describe("one spatial record, shared by every view", () => {
  it("feeds the diagram, the frame preview and the compiler from the same blob", () => {
    const parsed = parseBlocking(STATION, "Ravi");

    // Diagram
    assert.deepEqual(cameraPathPoints(parsed), cameraPathPoints(STATION));
    // Frame preview
    assert.deepEqual(
      projectSubjectToFrame(parsed.cameraStart, parsed.subjects[0].start),
      projectSubjectToFrame(STATION.cameraStart, RAVI.start)
    );
    // Compiler
    assert.deepEqual(deriveBlockingContext(parsed, "Ravi"), deriveBlockingContext(STATION, "Ravi"));
  });

  it("moves all three together when the camera moves — nothing to keep in sync", () => {
    const moved: ShotBlocking = {
      ...STATION,
      cameraStart: { ...STATION.cameraStart, x: 40, rotation: 0 },
    };
    const before = projectSubjectToFrame(STATION.cameraStart, RAVI.start);
    const after = projectSubjectToFrame(moved.cameraStart, RAVI.start);
    assert.notEqual(before.subjectX, after.subjectX);
    assert.notEqual(cameraPathPoints(STATION)[0].x, cameraPathPoints(moved)[0].x);
  });

  it("leaves the shot's own textual fields entirely alone", () => {
    // The blocking record has no field that could hold a Shot's wording.
    const keys = Object.keys(STATION).sort();
    assert.deepEqual(keys, [
      "axis",
      "cameraEnd",
      "cameraStart",
      "cameraWaypoints",
      "frame",
      "props",
      "subjects",
      "version",
      "world",
    ]);
    for (const forbidden of ["composition", "cameraMovement", "durationSeconds", "cameraHeight"]) {
      assert.ok(!keys.includes(forbidden), `blocking must not own ${forbidden}`);
    }
  });

  it("supports a different camera setup per shot with no shared scene camera", () => {
    // Two shots in one scene, each with its own blocking record.
    const shotA = parseBlocking(STATION, "Ravi");
    const shotB = parseBlocking(
      { ...STATION, cameraStart: { x: 80, y: 30, rotation: 200, fov: 25 }, cameraEnd: undefined },
      "Ravi"
    );
    assert.notDeepEqual(shotA.cameraStart, shotB.cameraStart);
    assert.equal(shotA.cameraEnd !== undefined, true);
    assert.equal(shotB.cameraEnd, undefined);
    // Changing one cannot reach the other: they are separate records.
    assert.deepEqual(parseBlocking(STATION, "Ravi").cameraStart, STATION.cameraStart);
  });
});
