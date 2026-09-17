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
  cameraMovement: "Slow Dolly In",
  movementSpeed: "Slow",
  cameraStartPosition: "Wide of the platform",
  cameraEndPosition: "Tight on Ravi's face",
  subjectMovement: "Turns toward camera",
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
    assert.equal(spec.motion.cameraMovement?.value, "Slow Dolly In");
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
      "Slow Dolly In",
      "Turns toward camera",
      "Wide of the platform",
      "Tight on Ravi's face",
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
    assert.ok(text.includes("Slow Dolly In"), "other motion fields should still render");
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
    assert.equal(spec.motion.cameraMovement?.value, "Slow Dolly In");
    assert.ok(!text.includes("Slow Dolly In"), `a still frame has no camera move:\n${text}`);
    assert.ok(!text.includes("6 seconds"), `a still frame has no duration:\n${text}`);
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
    assert.ok(text.includes("Slow Dolly In"));
  });

  it("lists nothing it was not told about", () => {
    const { spec } = generateImageToVideoPrompt(sparseContext);
    assert.deepEqual(spec.continuity.animate, []);
    assert.ok(!spec.continuity.preserve.includes("Lighting setup"));
    assert.ok(!spec.continuity.preserve.includes("Location"));
    // Environmental movement has no source field yet, so it can never be claimed.
    assert.ok(!spec.continuity.animate.includes("Environmental movement"));
  });

  it("only populates continuity for the image-to-video mode", () => {
    assert.deepEqual(compileSpec(fullContext, "image").continuity, { preserve: [], animate: [] });
    assert.deepEqual(compileSpec(fullContext, "video").continuity, { preserve: [], animate: [] });
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
