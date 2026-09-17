import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  axisLine,
  blockingSchema,
  crossesAxis,
  defaultBlocking,
  deriveBlockingContext,
  describeFramePosition,
  describePropLayers,
  describeSubjectFacing,
  fieldOfViewEdges,
  parseBlocking,
  type ShotBlocking,
} from "./blocking.ts";
import {
  buildShotContext,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateVideoPrompt,
} from "./prompt/index.ts";
import type { ShotInput } from "./prompt/types.ts";

describe("blocking persistence", () => {
  it("round-trips through the schema unchanged", () => {
    const blocking = defaultBlocking("Ravi");
    const parsed = blockingSchema.safeParse(blocking);
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data, blocking);
  });

  it("falls back to a default rather than throwing on a malformed blob", () => {
    const recovered = parseBlocking({ version: 99, nonsense: true }, "Ravi");
    assert.equal(recovered.version, 1);
    assert.equal(recovered.subjects[0]?.label, "Ravi");
  });

  it("treats an absent blocking column as a fresh default", () => {
    assert.equal(parseBlocking(null, "Ravi").version, 1);
    assert.equal(parseBlocking(undefined).subjects[0]?.label, "Subject");
  });

  it("rejects out-of-range coordinates", () => {
    const bad = { ...defaultBlocking(), cameraStart: { x: 300, y: 50, rotation: 0, fov: 40 } };
    assert.equal(blockingSchema.safeParse(bad).success, false);
  });
});

describe("spatial derivations", () => {
  it("widens the field-of-view cone as the fov grows", () => {
    const narrow = fieldOfViewEdges({ x: 50, y: 80, rotation: 0, fov: 20 });
    const wide = fieldOfViewEdges({ x: 50, y: 80, rotation: 0, fov: 90 });
    const spread = (e: ReturnType<typeof fieldOfViewEdges>) => Math.abs(e[0].x - e[1].x);
    assert.ok(spread(wide) > spread(narrow));
  });

  it("runs the 180 axis between two subjects when there are two", () => {
    const blocking: ShotBlocking = {
      ...defaultBlocking(),
      subjects: [
        { id: "a", label: "A", start: { x: 30, y: 40, orientation: 90 } },
        { id: "b", label: "B", start: { x: 70, y: 40, orientation: 270 } },
      ],
    };
    const axis = axisLine(blocking);
    assert.deepEqual(axis, [
      { x: 30, y: 40 },
      { x: 70, y: 40 },
    ]);
  });

  it("falls back to the camera-to-subject axis for a single subject", () => {
    const axis = axisLine(defaultBlocking());
    assert.ok(axis);
    assert.deepEqual(axis?.[0], { x: 50, y: 85 });
  });

  it("returns no axis when there are no subjects, rather than guessing one", () => {
    assert.equal(axisLine({ ...defaultBlocking(), subjects: [] }), undefined);
  });

  it("flags a camera move that crosses the axis", () => {
    const base: ShotBlocking = {
      ...defaultBlocking(),
      subjects: [
        { id: "a", label: "A", start: { x: 30, y: 50, orientation: 90 } },
        { id: "b", label: "B", start: { x: 70, y: 50, orientation: 270 } },
      ],
      cameraStart: { x: 50, y: 80, rotation: 0, fov: 40 },
    };
    assert.equal(crossesAxis(base), false, "no camera end means no crossing");
    assert.equal(
      crossesAxis({ ...base, cameraEnd: { x: 50, y: 20, rotation: 180, fov: 40 } }),
      true,
      "moving to the far side of the axis crosses it"
    );
    assert.equal(
      crossesAxis({ ...base, cameraEnd: { x: 60, y: 75, rotation: 0, fov: 40 } }),
      false,
      "staying on the same side does not"
    );
  });

  it("describes frame placement in composition vocabulary", () => {
    assert.match(describeFramePosition({ subjectX: 20, subjectY: 50, subjectScale: 40, eyelineY: 33 }, "Ravi"), /left third/);
    assert.match(describeFramePosition({ subjectX: 80, subjectY: 50, subjectScale: 40, eyelineY: 33 }, "Ravi"), /right third/);
    assert.match(describeFramePosition({ subjectX: 50, subjectY: 50, subjectScale: 40, eyelineY: 33 }, "Ravi"), /centred/);
  });
});

describe("blocking → deterministic description", () => {
  /** Camera downstage at (50,85); subject at (50,40). Bearing subject→camera is 180°. */
  function facing(orientation: number): string | undefined {
    const blocking: ShotBlocking = {
      ...defaultBlocking("Ravi"),
      subjects: [{ id: "a", label: "Ravi", start: { x: 50, y: 40, orientation } }],
    };
    return describeSubjectFacing(blocking, "Ravi");
  }

  it("reads the subject's facing off the geometry, in every band", () => {
    assert.equal(facing(180), "Ravi facing the camera");
    assert.equal(facing(135), "Ravi angled toward the camera");
    assert.equal(facing(90), "Ravi in profile to the camera");
    assert.equal(facing(45), "Ravi angled away from the camera");
    assert.equal(facing(0), "Ravi facing away from the camera");
  });

  it("is symmetric — the side the subject turns to does not change the band", () => {
    assert.equal(facing(90), facing(270));
    assert.equal(facing(135), facing(225));
  });

  it("groups props under their stated layer and never emits coordinates", () => {
    const described = describePropLayers({
      ...defaultBlocking(),
      props: [
        { id: "p1", label: "Bench", x: 12.5, y: 70, layer: "foreground" },
        { id: "p2", label: "Platform clock", x: 80, y: 20, layer: "background" },
        { id: "p3", label: "Suitcase", x: 40, y: 66, layer: "foreground" },
      ],
    });
    assert.equal(described, "foreground: Bench, Suitcase; background: Platform clock");
    assert.ok(!/\d/.test(described ?? ""), `no coordinates may leak: ${described}`);
  });

  it("emits nothing for props when none were placed", () => {
    assert.equal(describePropLayers(defaultBlocking()), undefined);
  });

  it("treats a shot that never saved blocking as having no blocking at all", () => {
    assert.equal(deriveBlockingContext(null, "Ravi"), undefined);
    assert.equal(deriveBlockingContext(undefined), undefined);
  });

  it("does not fall back to a default layout when the stored blob is malformed", () => {
    // parseBlocking recovers a default so the page still opens; the compiler
    // path must not, because a recovered default is not a stated decision.
    assert.equal(parseBlocking({ nonsense: true }, "Ravi").version, 1);
    assert.equal(deriveBlockingContext({ nonsense: true }, "Ravi"), undefined);
  });
});

describe("blocking in the compiled prompt", () => {
  const scene = { number: "4", intExt: "INT", location: "ABANDONED RAILWAY STATION", timeOfDay: "NIGHT" };

  const placed: ShotBlocking = {
    ...defaultBlocking("Ravi"),
    subjects: [{ id: "a", label: "Ravi", start: { x: 50, y: 40, orientation: 180 } }],
    props: [{ id: "p1", label: "Bench", x: 20, y: 70, layer: "foreground" }],
    frame: { subjectX: 20, subjectY: 50, subjectScale: 45, eyelineY: 33 },
  };

  it("lets the filmmaker's typed composition win over the canvas's frame placement", () => {
    const { spec, text } = generateImagePrompt(
      buildShotContext(
        { shotNumber: "1", shotType: "Medium Close-Up", composition: "Ravi on the left third" },
        scene,
        [{ characterName: "Ravi" }],
        deriveBlockingContext(placed, "Ravi")
      )
    );
    assert.equal(spec.cinematography.composition?.value, "Ravi on the left third");
    assert.equal(spec.cinematography.composition?.from, "shot.composition");
    assert.ok(text.includes("Ravi on the left third"));
  });

  it("falls back to the frame placement only when composition was left blank", () => {
    const { spec } = generateImagePrompt(
      buildShotContext({ shotNumber: "1", shotType: "Medium Close-Up" }, scene, [{ characterName: "Ravi" }],
        deriveBlockingContext(placed, "Ravi"))
    );
    assert.equal(spec.cinematography.composition?.value, "Ravi on the left third");
    assert.equal(spec.cinematography.composition?.from, "shot.blocking.frame");
  });

  it("carries facing and props into the prompt without any coordinates", () => {
    const { spec, text } = generateImagePrompt(
      buildShotContext({ shotNumber: "1", shotType: "Medium Close-Up" }, scene, [{ characterName: "Ravi" }],
        deriveBlockingContext(placed, "Ravi"))
    );
    assert.equal(spec.subject.facing?.value, "Ravi facing the camera");
    assert.equal(spec.environment.props?.value, "foreground: Bench");
    assert.ok(text.includes("Subject facing: Ravi facing the camera"), text);
    assert.ok(text.includes("Props — foreground: Bench"), text);
    assert.ok(!/\bx\s*[:=]|\b\d{1,3}\s*,\s*\d{1,3}\b/.test(text), `no raw coordinates:\n${text}`);
  });

  it("adds nothing at all when the shot has no saved blocking", () => {
    const { spec } = generateImagePrompt(
      buildShotContext({ shotNumber: "1", shotType: "Medium Close-Up" }, scene, [{ characterName: "Ravi" }])
    );
    assert.equal(spec.subject.facing, undefined);
    assert.equal(spec.environment.props, undefined);
    assert.equal(spec.cinematography.composition, undefined);
  });
});

describe("environmental movement", () => {
  it("compiles from its own field and is described as environmental, not camera or subject", () => {
    const { spec, text } = generateVideoPrompt(
      buildShotContext({
        shotNumber: "1",
        shotType: "Medium Close-Up",
        cameraMovement: "Dolly In",
        subjectMovement: "Ravi walks slowly and turns toward the camera",
        environmentalMovement: "Light fog drifting through the station",
      })
    );
    assert.equal(spec.environment.movement?.value, "Light fog drifting through the station");
    assert.equal(spec.environment.movement?.from, "shot.environmentalMovement");
    assert.ok(text.includes("Environmental movement: Light fog drifting through the station"), text);
    assert.ok(!text.includes("Camera movement — Light fog"));
  });

  it("stays absent when the filmmaker did not state any", () => {
    const { spec, text } = generateVideoPrompt(
      buildShotContext({ shotNumber: "1", shotType: "Wide Shot", cameraMovement: "Dolly In" })
    );
    assert.equal(spec.environment.movement, undefined);
    assert.ok(!text.includes("Environmental movement"));
  });
});

/**
 * The canvas and the Shot Builder both write the same ShotListItem row, so these
 * assert the compiler consequence of what the UI can set — not a second store.
 */
describe("canvas → shot → context → spec → prompt", () => {
  const scene = {
    number: "4",
    intExt: "INT",
    location: "ABANDONED RAILWAY STATION",
    timeOfDay: "NIGHT",
  };

  function compile(shot: ShotInput) {
    return buildShotContext(shot, scene, [{ characterName: "Ravi" }]);
  }

  it("example 1 — composition preserved, framing changes", () => {
    const { spec } = generateImageToVideoPrompt(
      compile({
        shotNumber: "1",
        shotType: "Medium Close-Up",
        composition: "Ravi on left third",
        cameraMovement: "Dolly In",
        finalFraming: "Tight",
      })
    );
    assert.ok(spec.continuity.preserve.includes("Composition"));
    assert.ok(spec.continuity.animate.includes("Framing progression"));
    assert.ok(!spec.continuity.animate.includes("Composition change"));
  });

  it("example 2 — composition changes over time", () => {
    const { spec } = generateImageToVideoPrompt(
      compile({
        shotNumber: "2",
        shotType: "Two Shot",
        composition: "Ravi on left third",
        finalComposition: "Ravi centered",
        cameraMovement: "Pan Right",
      })
    );
    assert.ok(spec.continuity.animate.includes("Composition change"));
    assert.ok(!spec.continuity.preserve.includes("Composition"));
  });

  it("example 3 — static camera, no temporal composition or framing change", () => {
    const { spec } = generateImageToVideoPrompt(
      compile({
        shotNumber: "3",
        shotType: "Wide Shot",
        cameraMovement: "Static",
        composition: "Ravi on left third",
        framing: "Loose",
      })
    );
    assert.ok(spec.continuity.preserve.includes("Composition"));
    assert.ok(spec.continuity.preserve.includes("Framing"));
    assert.ok(!spec.continuity.animate.includes("Framing progression"));
    assert.ok(!spec.continuity.animate.includes("Composition change"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
  });

  it("example 4 — rack focus changes focus, camera stays static, composition holds", () => {
    const { spec, text } = generateImageToVideoPrompt(
      compile({
        shotNumber: "4",
        shotType: "Close-Up",
        cameraMovement: "Rack Focus",
        composition: "Ravi on left third",
      })
    );
    assert.equal(spec.motion.movementKind, "focus");
    assert.ok(spec.continuity.animate.includes("Focus transition"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
    assert.ok(spec.continuity.preserve.includes("Composition"));
    assert.ok(text.includes("the camera itself does not move"));
  });

  it("carries every field the shot-design page can set through to the prompt", () => {
    // Exactly the fields the Phase 4 temporal panel writes.
    const { spec, text } = generateVideoPrompt(
      compile({
        shotNumber: "12",
        shotType: "Medium Close-Up",
        composition: "Ravi on the left third",
        framing: "Tight",
        initialFraming: "Wide",
        finalFraming: "Tight",
        cameraMovement: "Dolly In",
        movementSpeed: "Slow",
        cameraStartPosition: "4m back, platform edge",
        cameraEndPosition: "1m from subject",
        subjectMovement: "Turns toward camera",
        subjectStartPosition: "Mid-platform, back to camera",
        subjectEndPosition: "Facing camera, centre frame",
        durationSeconds: 6,
      })
    );

    assert.equal(spec.cinematography.composition?.value, "Ravi on the left third");
    assert.equal(spec.motion.initialFraming?.value, "Wide");
    assert.equal(spec.motion.finalFraming?.value, "Tight");
    assert.equal(spec.motion.cameraStartPosition?.value, "4m back, platform edge");
    assert.equal(spec.motion.subjectEndPosition?.value, "Facing camera, centre frame");
    assert.equal(spec.motion.durationSeconds?.value, 6);

    for (const value of [
      "Wide",
      "Tight",
      "Dolly In",
      "4m back, platform edge",
      "1m from subject",
      "Mid-platform, back to camera",
      "Facing camera, centre frame",
      "6 seconds",
    ]) {
      assert.ok(text.includes(value), `"${value}" should survive to the prompt:\n${text}`);
    }
  });

  it("a shot with blocking but no stated transitions produces no transition language", () => {
    // Positioning things on the canvas must not manufacture a temporal change.
    const { spec, text } = generateVideoPrompt(
      compile({ shotNumber: "5", shotType: "Wide Shot", composition: "Ravi on left third" })
    );
    assert.equal(spec.motion.finalFraming, undefined);
    assert.equal(spec.motion.finalComposition, undefined);
    assert.equal(spec.motion.movementKind, "unspecified");
    assert.ok(!text.includes("Closing framing"));
    assert.ok(!text.includes("Camera movement —"));
  });

  it("the still-image prompt keeps composition but drops the framing progression", () => {
    const { text } = generateImagePrompt(
      compile({
        shotNumber: "6",
        shotType: "Medium Close-Up",
        composition: "Ravi on the left third",
        initialFraming: "Wide",
        finalFraming: "Tight",
        cameraMovement: "Dolly In",
      })
    );
    assert.ok(text.includes("Ravi on the left third"));
    assert.ok(!text.includes("Closing framing"), `a still has no progression:\n${text}`);
    assert.ok(!text.includes("Dolly In"));
  });
});
