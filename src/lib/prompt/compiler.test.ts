import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildShotContext,
  compileSpec,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateStoryboardPrompt,
  generateVideoPrompt,
} from "./index.ts";
import type { SceneInput, ShotInput } from "./types.ts";

/** The worked example from the Phase 3 brief. */
const fullShot: ShotInput = {
  shotNumber: "12",
  shotType: "Medium Close-Up",
  cameraAngle: "Low Angle",
  cameraHeight: "Chest level",
  lens: "Prime",
  focalLength: "85mm",
  cameraMovement: "Dolly In",
  movementSpeed: "Slow",
  // Framing state over time — distinct from shotType, which is the designation.
  initialFraming: "Wide view of the platform",
  finalFraming: "Tight on Ravi's face",
  // Where the camera physically sits — distinct from what the frame shows.
  cameraStartPosition: "4m back, platform edge",
  cameraEndPosition: "1m from subject",
  subjectMovement: "Turns toward camera",
  subjectStartPosition: "Mid-platform, back to camera",
  subjectEndPosition: "Facing camera, centre frame",
  characterBlocking: "Ravi frame left",
  composition: "Character on left third",
  framing: "Tight",
  depthOfField: "Shallow",
  lightingNotes: "Warm practical + cool moonlight",
  mood: "Suspenseful",
  durationSeconds: 6,
  dialogueAudio: "Hello? Is someone there?",
  sfx: "Metal creak",
  soundDesignNotes: "Low rumble under the dialogue",
  description: "Ravi hears a sound behind him",
  directorNotes: "Hold on the eyes",
};

const fullScene: SceneInput = {
  number: "4",
  intExt: "INT",
  location: "ABANDONED RAILWAY STATION",
  timeOfDay: "NIGHT",
  action: "Ravi walks in slowly and stops",
  emotionalBeat: "Suspenseful dread",
  directorNotes: "Let the silence build",
};

/** Only the two fields the data model requires. Everything else is unspecified. */
const sparseShot: ShotInput = {
  shotNumber: "1",
  shotType: "Wide Shot",
};

const fullContext = buildShotContext(fullShot, fullScene, [{ characterName: "Ravi" }]);
const sparseContext = buildShotContext(sparseShot);

describe("specified parameters survive compilation unchanged", () => {
  it("carries every selected value into the spec verbatim", () => {
    const { spec } = generateImagePrompt(fullContext);
    assert.equal(spec.cinematography.shotSize?.value, "Medium Close-Up");
    assert.equal(spec.cinematography.cameraAngle?.value, "Low Angle");
    assert.equal(spec.cinematography.focalLength?.value, "85mm");
    assert.equal(spec.cinematography.composition?.value, "Character on left third");
    assert.equal(spec.motion.cameraMovement?.value, "Dolly In");
    assert.equal(spec.motion.durationSeconds?.value, 6);
    assert.equal(spec.lighting.setup?.value, "Warm practical + cool moonlight");
  });

  it("emits selected values verbatim in the image prompt", () => {
    const { text } = generateImagePrompt(fullContext);
    for (const value of [
      "Medium Close-Up",
      "Low Angle",
      "85mm",
      "Prime",
      "Chest level",
      "Character on left third",
      "Warm practical + cool moonlight",
      "ABANDONED RAILWAY STATION",
      "NIGHT",
      "Ravi",
    ]) {
      assert.ok(text.includes(value), `image prompt should contain "${value}" verbatim:\n${text}`);
    }
  });

  it("emits selected values verbatim in the video prompt, including temporal fields", () => {
    const { text } = generateVideoPrompt(fullContext);
    for (const value of [
      "Medium Close-Up",
      "Low Angle",
      "85mm",
      "Dolly In",
      "Turns toward camera",
      "Wide view of the platform",
      "Tight on Ravi's face",
      "4m back, platform edge",
      "1m from subject",
      "Mid-platform, back to camera",
      "Facing camera, centre frame",
      "6 seconds",
    ]) {
      assert.ok(text.includes(value), `video prompt should contain "${value}" verbatim:\n${text}`);
    }
  });

  it("never substitutes a different value for a selected one", () => {
    const { text } = generateVideoPrompt(fullContext);
    // The classic silent-rewrite failures: lens swapped, angle flattened, movement invented away.
    assert.ok(!text.includes("50mm"), "lens must not be rewritten");
    assert.ok(!/\bEye Level\b/.test(text), "camera angle must not be flattened to eye level");
    assert.ok(!/\bStatic\b/.test(text), "a moving camera must not be described as static");
  });

  it("is deterministic — identical input yields identical output", () => {
    const a = generateVideoPrompt(fullContext);
    const b = generateVideoPrompt(fullContext);
    assert.equal(a.text, b.text);
    assert.deepEqual(a.spec, b.spec);
  });
});

describe("unspecified parameters remain absent", () => {
  it("leaves unspecified spec fields undefined rather than defaulting them", () => {
    const { spec } = generateImagePrompt(sparseContext);
    assert.equal(spec.cinematography.cameraAngle, undefined);
    assert.equal(spec.cinematography.lens, undefined);
    assert.equal(spec.cinematography.focalLength, undefined);
    assert.equal(spec.cinematography.composition, undefined);
    assert.equal(spec.lighting.setup, undefined);
    assert.equal(spec.motion.cameraMovement, undefined);
    assert.equal(spec.motion.durationSeconds, undefined);
    assert.equal(spec.subject.characters.length, 0);
  });

  it("invents no camera, lens, lighting or duration language in the rendered prompt", () => {
    const { text } = generateImagePrompt(sparseContext);
    for (const invented of ["eye level", "mm", "lighting", "shallow", "seconds", "dolly", "handheld"]) {
      assert.ok(
        !text.toLowerCase().includes(invented),
        `sparse prompt must not invent "${invented}":\n${text}`
      );
    }
  });

  it("treats blank and whitespace-only strings as unspecified", () => {
    const blank = buildShotContext({ shotNumber: "2", shotType: "Insert", cameraAngle: "", lens: "   " });
    const { spec, text } = generateImagePrompt(blank);
    assert.equal(spec.cinematography.cameraAngle, undefined);
    assert.equal(spec.cinematography.lens, undefined);
    assert.ok(!text.includes("lens"), `blank lens must not render:\n${text}`);
  });

  it("omits the duration clause when no duration was set", () => {
    const noDuration = buildShotContext({ ...fullShot, durationSeconds: null });
    const { text } = generateVideoPrompt(noDuration);
    assert.ok(!text.includes("Duration"), `duration clause must be absent:\n${text}`);
    assert.ok(text.includes("Dolly In"), "other motion fields should still render");
  });
});

describe("modes", () => {
  it("records the mode in the spec", () => {
    assert.equal(generateImagePrompt(fullContext).spec.mode, "image");
    assert.equal(generateVideoPrompt(fullContext).spec.mode, "video");
    assert.equal(generateImageToVideoPrompt(fullContext).spec.mode, "image-to-video");
    assert.equal(generateStoryboardPrompt(fullContext).spec.mode, "storyboard");
  });

  it("omits temporal language from the still-image prompt while keeping it in the spec", () => {
    const { spec, text } = generateImagePrompt(fullContext);
    assert.equal(spec.motion.cameraMovement?.value, "Dolly In");
    assert.ok(!text.includes("Dolly In"), `a still frame has no camera move:\n${text}`);
    assert.ok(!text.includes("6 seconds"), `a still frame has no duration:\n${text}`);
    assert.ok(!text.includes("Wide view of the platform"), `a still frame has no framing progression:\n${text}`);
  });

  it("labels the storyboard panel and keeps the frame description", () => {
    const { text } = generateStoryboardPrompt(fullContext);
    assert.ok(text.startsWith("Black and white storyboard panel"));
    assert.ok(text.includes("Scene 4"));
    assert.ok(text.includes("Shot 12"));
    assert.ok(text.includes("Medium Close-Up"));
  });
});

describe("image-to-video preserve / animate", () => {
  it("derives both lists from what the filmmaker specified", () => {
    const { spec, text } = generateImageToVideoPrompt(fullContext);

    assert.ok(spec.continuity.preserve.includes("Character identity and appearance"));
    assert.ok(spec.continuity.preserve.includes("Location"));
    assert.ok(spec.continuity.preserve.includes("Lighting setup"));
    assert.ok(spec.continuity.preserve.includes("Composition"));

    assert.ok(spec.continuity.animate.includes("Camera movement"));
    assert.ok(spec.continuity.animate.includes("Subject movement"));

    assert.ok(text.includes("PRESERVE"));
    assert.ok(text.includes("ANIMATE"));
    assert.ok(text.includes("Dolly In"));
  });

  it("lists nothing it was not told about", () => {
    const { spec } = generateImageToVideoPrompt(sparseContext);
    assert.ok(!spec.continuity.preserve.includes("Lighting setup"));
    assert.ok(!spec.continuity.preserve.includes("Location"));
    // The shot states no environmental movement, so it is never claimed as one.
    assert.ok(!spec.continuity.animate.includes("Environmental movement"));
    assert.deepEqual(spec.continuity.animate, []);
  });

  it("only populates continuity for the image-to-video mode", () => {
    assert.deepEqual(compileSpec(fullContext, "image").continuity, { preserve: [], animate: [] });
    assert.deepEqual(compileSpec(fullContext, "video").continuity, { preserve: [], animate: [] });
  });
});

describe("shot designation vs. temporal camera state", () => {
  it("keeps the shot designation separate from the framing progression", () => {
    const { spec } = generateVideoPrompt(fullContext);
    // The shot IS a Medium Close-Up; it BEGINS on a wide view and ENDS tight.
    assert.equal(spec.cinematography.shotSize?.value, "Medium Close-Up");
    assert.equal(spec.motion.initialFraming?.value, "Wide view of the platform");
    assert.equal(spec.motion.finalFraming?.value, "Tight on Ravi's face");
  });

  it("keeps framing state separate from physical camera position", () => {
    const { spec } = generateVideoPrompt(fullContext);
    assert.equal(spec.motion.initialFraming?.value, "Wide view of the platform");
    assert.equal(spec.motion.cameraStartPosition?.value, "4m back, platform edge");
    assert.equal(spec.motion.finalFraming?.value, "Tight on Ravi's face");
    assert.equal(spec.motion.cameraEndPosition?.value, "1m from subject");
  });

  it("keeps subject position separate from camera position", () => {
    const { spec } = generateVideoPrompt(fullContext);
    assert.equal(spec.motion.subjectStartPosition?.value, "Mid-platform, back to camera");
    assert.equal(spec.motion.subjectEndPosition?.value, "Facing camera, centre frame");
    assert.notEqual(
      spec.motion.subjectStartPosition?.value,
      spec.motion.cameraStartPosition?.value
    );
  });

  it("renders the progression in start → operation → end order", () => {
    const { text } = generateVideoPrompt(fullContext);
    const start = text.indexOf("Wide view of the platform");
    const operation = text.indexOf("Dolly In");
    const end = text.indexOf("Tight on Ravi's face");
    assert.ok(start >= 0 && operation >= 0 && end >= 0, `all three states should render:\n${text}`);
    assert.ok(start < operation, "opening framing precedes the camera operation");
    assert.ok(operation < end, "the camera operation precedes the closing framing");
  });

  it("never invents a start or end state that was not specified", () => {
    const movingButUnstated = buildShotContext({
      shotNumber: "3",
      shotType: "Medium Shot",
      cameraMovement: "Dolly In",
      durationSeconds: 4,
    });
    const { spec, text } = generateVideoPrompt(movingButUnstated);

    assert.equal(spec.motion.initialFraming, undefined);
    assert.equal(spec.motion.finalFraming, undefined);
    assert.equal(spec.motion.cameraStartPosition, undefined);
    assert.equal(spec.motion.subjectStartPosition, undefined);

    assert.ok(!text.includes("Opening framing"), `no opening framing may be invented:\n${text}`);
    assert.ok(!text.includes("Closing framing"), `no closing framing may be invented:\n${text}`);
    assert.ok(!text.includes("camera starts at"), `no camera start may be invented:\n${text}`);
    assert.ok(text.includes("Dolly In"), "the specified movement still renders");
  });

  it("supports a framing progression on a shot with no specified camera movement", () => {
    const framingOnly = buildShotContext({
      shotNumber: "4",
      shotType: "Close-Up",
      initialFraming: "Two shot at the doorway",
      finalFraming: "Close-Up on her hands",
    });
    const { spec, text } = generateVideoPrompt(framingOnly);
    assert.equal(spec.motion.movementKind, "unspecified");
    assert.ok(text.includes("Two shot at the doorway"));
    assert.ok(text.includes("Close-Up on her hands"));
    assert.ok(!text.includes("Camera movement —"), `no movement may be asserted:\n${text}`);
  });
});

describe("camera movement classification", () => {
  const cases: Array<[string, string]> = [
    ["Dolly In", "translation"],
    ["Dolly Out", "translation"],
    ["Push In", "translation"],
    ["Pull Out", "translation"],
    ["Crane Up", "translation"],
    ["Crane Down", "translation"],
    ["Tracking", "translation"],
    ["Orbit", "translation"],
    ["Arc", "translation"],
    ["Pan", "rotation"],
    ["Tilt", "rotation"],
    ["Whip Pan", "rotation"],
    ["Rack Focus", "focus"],
    ["Static", "static"],
    ["Handheld", "support"],
    ["Drone", "support"],
  ];

  for (const [movement, expected] of cases) {
    it(`classifies "${movement}" as ${expected}`, () => {
      const { spec } = generateVideoPrompt(
        buildShotContext({ shotNumber: "1", shotType: "Medium Shot", cameraMovement: movement })
      );
      assert.equal(spec.motion.movementKind, expected);
      assert.equal(spec.motion.cameraMovement?.value, movement, "the value itself is never rewritten");
    });
  }

  it("classifies an unrecognised custom movement as other and describes it as written", () => {
    const { spec, text } = generateVideoPrompt(
      buildShotContext({ shotNumber: "1", shotType: "Medium Shot", cameraMovement: "Snorricam rig spin" })
    );
    assert.equal(spec.motion.movementKind, "other");
    assert.ok(text.includes("Snorricam rig spin"));
  });

  it("describes a rack focus as a focus transition, not camera movement", () => {
    const { text } = generateVideoPrompt(
      buildShotContext({
        shotNumber: "7",
        shotType: "Close-Up",
        cameraMovement: "Rack Focus",
        durationSeconds: 3,
      })
    );
    assert.ok(text.includes("Focus transition — Rack Focus"), `rack focus must read as a focus change:\n${text}`);
    assert.ok(
      !text.includes("Camera movement — Rack Focus"),
      `rack focus must not be described as camera movement:\n${text}`
    );
    assert.ok(text.includes("the camera itself does not move"));
  });

  it("holds camera position and framing when the operation is a rack focus", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({ shotNumber: "7", shotType: "Close-Up", cameraMovement: "Rack Focus" })
    );
    assert.ok(spec.continuity.preserve.includes("Camera position and framing"));
    assert.ok(spec.continuity.animate.includes("Focus transition"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
  });

  it("asserts the absence of movement for a static camera", () => {
    const { text } = generateVideoPrompt(
      buildShotContext({
        shotNumber: "2",
        shotType: "Wide Shot",
        cameraMovement: "Static",
        subjectMovement: "Ravi crosses left to right",
        durationSeconds: 5,
      })
    );
    assert.ok(text.includes("Camera remains static"), `static must be explicit:\n${text}`);
    assert.ok(text.includes("Ravi crosses left to right"), "subject movement is independent of camera movement");
  });

  it("does not animate the camera for a static shot in image-to-video", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "2",
        shotType: "Wide Shot",
        cameraMovement: "Static",
        subjectMovement: "Ravi crosses left to right",
      })
    );
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
    assert.ok(spec.continuity.animate.includes("Subject movement"));
  });

  it("moves framing out of preserve when the framing progresses", () => {
    const { spec } = generateImageToVideoPrompt(fullContext);
    assert.ok(
      !spec.continuity.preserve.includes("Framing"),
      "framing that changes over the shot cannot also be preserved"
    );
    assert.ok(!spec.continuity.preserve.includes("Shot size"));
    assert.ok(spec.continuity.animate.includes("Framing progression"));
    // Compositional placement is a rule that survives the move, unlike shot size.
    assert.ok(
      spec.continuity.preserve.includes("Composition"),
      "composition holds through a framing change"
    );
  });

  it("preserves framing for a static shot with no framing progression", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "2",
        shotType: "Wide Shot",
        cameraMovement: "Static",
        framing: "Loose",
        composition: "Centred",
      })
    );
    assert.ok(spec.continuity.preserve.includes("Framing"));
    assert.ok(spec.continuity.preserve.includes("Shot size"));
    assert.ok(spec.continuity.preserve.includes("Composition"));
  });
});

describe("composition vs. framing vs. temporal framing transition", () => {
  // Spatial placement, shot scale and the framing transition are three separate
  // things. A camera move must never be read as evidence that placement changed.

  it("case 1 — dolly-in with the subject held on the left third preserves composition", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "1",
        shotType: "Medium Close-Up",
        cameraMovement: "Dolly In",
        composition: "Subject on left third",
      })
    );
    assert.ok(
      spec.continuity.preserve.includes("Composition"),
      "a camera move is not evidence the placement changed"
    );
    assert.ok(!spec.continuity.animate.includes("Composition change"));
    assert.ok(spec.continuity.animate.includes("Camera movement"));
  });

  it("case 2 — dolly-in with an explicit Wide → Tight framing animates framing but holds composition", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "2",
        shotType: "Medium Close-Up",
        cameraMovement: "Dolly In",
        composition: "Subject on left third",
        framing: "Tight",
        initialFraming: "Wide",
        finalFraming: "Tight",
      })
    );
    assert.ok(spec.continuity.animate.includes("Framing progression"), "framing was told to change");
    assert.ok(!spec.continuity.preserve.includes("Framing"), "shot scale is released");
    assert.ok(!spec.continuity.preserve.includes("Shot size"));
    assert.ok(
      spec.continuity.preserve.includes("Composition"),
      "placement still holds across the framing change"
    );
    assert.ok(!spec.continuity.animate.includes("Composition change"));
  });

  it("case 3 — static camera with a left-third composition preserves both composition and framing", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "3",
        shotType: "Wide Shot",
        cameraMovement: "Static",
        composition: "Subject on left third",
        framing: "Loose",
      })
    );
    assert.ok(spec.continuity.preserve.includes("Composition"));
    assert.ok(spec.continuity.preserve.includes("Framing"));
    assert.ok(spec.continuity.preserve.includes("Shot size"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
    assert.ok(!spec.continuity.animate.includes("Composition change"));
  });

  it("case 4 — camera movement with no specified composition claims nothing either way", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({ shotNumber: "4", shotType: "Medium Shot", cameraMovement: "Tracking" })
    );
    assert.equal(spec.cinematography.composition, undefined);
    assert.ok(
      !spec.continuity.preserve.includes("Composition"),
      "an unspecified composition cannot be preserved"
    );
    assert.ok(
      !spec.continuity.animate.includes("Composition change"),
      "nor may a change be invented for it"
    );
    assert.ok(spec.continuity.animate.includes("Camera movement"));
  });

  it("case 5 — an explicitly specified composition change animates instead of preserving", () => {
    const { spec, text } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "5",
        shotType: "Two Shot",
        cameraMovement: "Pan",
        composition: "Subject on left third",
        finalComposition: "Subject centred",
      })
    );
    assert.equal(spec.motion.finalComposition?.value, "Subject centred");
    assert.ok(spec.continuity.animate.includes("Composition change"));
    assert.ok(
      !spec.continuity.preserve.includes("Composition"),
      "a composition that was told to change cannot also be preserved"
    );
    assert.ok(text.includes("Subject on left third"), "the opening placement renders");
    assert.ok(text.includes("Subject centred"), "the closing placement renders");
  });

  it("case 6 — rack focus with a stable composition preserves composition and the frame", () => {
    const { spec } = generateImageToVideoPrompt(
      buildShotContext({
        shotNumber: "6",
        shotType: "Close-Up",
        cameraMovement: "Rack Focus",
        composition: "Subject on left third",
        framing: "Tight",
      })
    );
    assert.ok(spec.continuity.preserve.includes("Composition"));
    assert.ok(spec.continuity.preserve.includes("Camera position and framing"));
    assert.ok(spec.continuity.animate.includes("Focus transition"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
    assert.ok(!spec.continuity.animate.includes("Composition change"));
  });

  it("keeps the three axes as separate spec fields", () => {
    const { spec } = generateVideoPrompt(
      buildShotContext({
        shotNumber: "7",
        shotType: "Medium Close-Up",
        composition: "Subject on left third",
        framing: "Tight",
        initialFraming: "Wide",
        finalFraming: "Tight",
      })
    );
    assert.equal(spec.cinematography.composition?.value, "Subject on left third"); // placement
    assert.equal(spec.cinematography.framing?.value, "Tight"); // scale
    assert.equal(spec.motion.initialFraming?.value, "Wide"); // transition, head
    assert.equal(spec.motion.finalFraming?.value, "Tight"); // transition, tail
  });

  it("does not repeat a stable composition as an opening state", () => {
    const { text } = generateVideoPrompt(
      buildShotContext({
        shotNumber: "8",
        shotType: "Medium Shot",
        cameraMovement: "Dolly In",
        composition: "Subject on left third",
        initialFraming: "Wide",
        finalFraming: "Tight",
      })
    );
    assert.ok(
      !text.toLowerCase().includes("opening composition"),
      `a stable composition must not be framed as about to change:\n${text}`
    );
    assert.ok(text.includes("Composition: Subject on left third"), "it renders once, as a constant");
  });
});

describe("provenance and provider independence", () => {
  it("tags each value with the field it came from", () => {
    const { spec } = generateImagePrompt(fullContext);
    assert.equal(spec.cinematography.lens?.from, "shot.lens");
    assert.equal(spec.cinematography.cameraAngle?.from, "shot.cameraAngle");
    assert.equal(spec.motion.durationSeconds?.from, "shot.durationSeconds");
    assert.equal(spec.environment.location?.from, "scene.location");
  });

  it("produces the same spec regardless of which provider renders it", () => {
    const viaDefault = generateVideoPrompt(fullContext);
    const viaExplicit = generateVideoPrompt(fullContext, { providerId: "generic" });
    const viaUnknown = generateVideoPrompt(fullContext, { providerId: "not-registered-yet" });

    assert.deepEqual(viaDefault.spec, viaExplicit.spec);
    assert.deepEqual(viaDefault.spec, viaUnknown.spec);
    assert.equal(viaUnknown.providerId, "generic", "unknown providers fall back to generic");
  });
});

describe("shots compiled without scene context", () => {
  it("compiles a bare shot without inventing scene data", () => {
    const { spec, text } = generateImagePrompt(buildShotContext(fullShot));
    assert.equal(spec.environment.location, undefined);
    assert.equal(spec.slate.slugline, undefined);
    assert.ok(text.includes("Medium Close-Up"), "shot-level data still compiles");
    assert.ok(!text.includes("RAILWAY"), "no scene data should appear");
  });
});
