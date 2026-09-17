import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveBlockingContext, defaultBlocking, type ShotBlocking } from "../blocking.ts";
import {
  buildShotContext,
  compileSpec,
  generateImagePrompt,
  generateVideoPrompt,
  getProvider,
  listProviders,
} from "./index.ts";
import { generationPromptSchema } from "../validation.ts";
import type { ImageGenerationProvider } from "../ai/image-providers/types.ts";

/**
 * Phase 5 — the structured generation path, end to end up to the provider:
 *
 *   Shot + Blocking → ShotVisualizationContext → CinematicPromptSpec
 *     → image renderer → provider adapter → image provider request
 *
 * Everything here is the real pipeline; only the image provider itself is a
 * stand-in, because the point is what it is handed, not what it returns.
 */

const SCENE = {
  number: "4",
  intExt: "INT",
  location: "ABANDONED RAILWAY STATION",
  timeOfDay: "NIGHT",
  synopsis: "Ravi enters an abandoned railway station at midnight.",
};

/** The exact shot from the Phase 5 brief. */
const TEST_SHOT = {
  shotNumber: "12",
  shotType: "Medium Close-Up",
  cameraAngle: "Low Angle",
  cameraHeight: "Chest Level",
  lens: "Prime",
  focalLength: "85mm",
  composition: "Ravi on the left third",
  initialFraming: "Wide",
  finalFraming: "Tight",
  cameraMovement: "Dolly In",
  movementSpeed: "Slow",
  subjectMovement: "Ravi walks slowly and turns toward the camera.",
  lightingNotes: "Warm practical lights + cool moonlight",
  mood: "Suspenseful",
  durationSeconds: 6,
  environmentalMovement: "Light fog drifting through the station.",
};

const BLOCKING: ShotBlocking = {
  ...defaultBlocking("Ravi"),
  subjects: [{ id: "s1", label: "Ravi", start: { x: 35, y: 45, orientation: 120 } }],
  props: [{ id: "p1", label: "Platform bench", x: 20, y: 70, layer: "foreground" }],
  frame: { subjectX: 30, subjectY: 50, subjectScale: 55, eyelineY: 33 },
};

function context(shot = TEST_SHOT, blocking: unknown = BLOCKING) {
  return buildShotContext(shot, SCENE, [{ characterName: "Ravi" }], deriveBlockingContext(blocking, "Ravi"));
}

/** Captures exactly what the image provider is handed. */
function recordingProvider() {
  const calls: Array<{ prompt: string; size?: string }> = [];
  const provider: ImageGenerationProvider = {
    id: "test-recorder",
    label: "Recorder",
    model: "test",
    isConfigured: () => true,
    async generate(request) {
      calls.push(request);
      return { data: Buffer.from("png"), mimeType: "image/png" };
    },
  };
  return { provider, calls };
}

describe("Phase 5 — the test shot survives the whole pipeline", () => {
  it("carries every specified parameter into the image prompt verbatim", () => {
    const { text } = generateImagePrompt(context());
    for (const value of [
      "Medium Close-Up",
      "Low Angle",
      "Chest Level",
      "85mm Prime lens",
      "Ravi on the left third",
      "Warm practical lights + cool moonlight",
      "Suspenseful",
      "ABANDONED RAILWAY STATION",
      "NIGHT",
    ]) {
      assert.ok(text.includes(value), `"${value}" must reach the image prompt:\n${text}`);
    }
  });

  it("substitutes nothing — no re-cased, rounded or re-worded parameters", () => {
    const { text } = generateImagePrompt(context());
    assert.ok(!text.includes("85 mm"), "focal length must not be re-spaced");
    assert.ok(!text.includes("low angle"), "camera angle must not be re-cased");
    assert.ok(!text.includes("medium close up"), "shot size must not be re-punctuated");
    assert.ok(!/\b(?:80|90|100)mm\b/.test(text), "focal length must not be normalised");
  });

  it("leaves temporal values out of a still image prompt", () => {
    const { text } = generateImagePrompt(context());
    for (const temporal of ["Dolly In", "Closing framing", "Duration", "6 seconds"]) {
      assert.ok(!text.includes(temporal), `a still has no "${temporal}":\n${text}`);
    }
    // But they are still in the spec, ready for the video phase.
    const { spec } = generateImagePrompt(context());
    assert.equal(spec.motion.cameraMovement?.value, "Dolly In");
    assert.equal(spec.motion.durationSeconds?.value, 6);
  });

  it("keeps environmental movement out of the camera and subject channels", () => {
    const { spec, text } = generateVideoPrompt(context());
    assert.equal(spec.environment.movement?.value, "Light fog drifting through the station.");
    assert.equal(spec.motion.cameraMovement?.value, "Dolly In");
    assert.equal(spec.motion.subjectMovement?.value, "Ravi walks slowly and turns toward the camera.");
    assert.ok(text.includes("Environmental movement: Light fog drifting through the station."));
  });

  it("invents nothing for the fields the shot leaves blank", () => {
    const { spec, text } = generateImagePrompt(context());
    assert.equal(spec.cinematography.depthOfField, undefined);
    assert.equal(spec.audio.dialogue, undefined);
    assert.equal(spec.notes.directorNotes, undefined);
    assert.equal(spec.motion.cameraStartPosition, undefined);
    for (const absent of ["Depth of field", "Dialogue/audio", "Director's note", "Camera starts at"]) {
      assert.ok(!text.includes(absent), `"${absent}" was never specified:\n${text}`);
    }
  });

  it("turns blocking into description, never coordinates", () => {
    const { spec, text } = generateImagePrompt(context());
    assert.equal(spec.subject.facing?.value, "Ravi angled toward the camera");
    assert.equal(spec.environment.props?.value, "foreground: Platform bench");
    // The filmmaker typed a composition, so the canvas's frame placement loses.
    assert.equal(spec.cinematography.composition?.from, "shot.composition");
    for (const coordinate of ["35", "45", "70", "x:", "y:"]) {
      assert.ok(!text.includes(coordinate), `raw coordinate "${coordinate}" leaked:\n${text}`);
    }
  });
});

describe("Phase 5 — the spec stays provider-independent", () => {
  it("compiles the same spec whichever adapter formats it", () => {
    const first = generateImagePrompt(context(), { providerId: "generic" });
    const second = generateImagePrompt(context(), { providerId: "no-such-provider-yet" });
    assert.deepEqual(first.spec, second.spec);
  });

  it("holds no provider-specific field anywhere in the IR", () => {
    const serialised = JSON.stringify(compileSpec(context(), "image"));
    for (const name of ["openai", "gpt-image", "seedance", "veo", "higgsfield", "runway", "apiKey"]) {
      assert.ok(!serialised.toLowerCase().includes(name), `the IR mentions ${name}`);
    }
  });

  it("every registered prompt adapter can format every mode", () => {
    const spec = compileSpec(context(), "image");
    for (const provider of listProviders()) {
      for (const format of [
        provider.formatImagePrompt,
        provider.formatVideoPrompt,
        provider.formatImageToVideoPrompt,
        provider.formatStoryboardPrompt,
      ]) {
        assert.equal(typeof format(spec), "string");
      }
    }
  });
});

describe("Phase 5 — what reaches the image provider", () => {
  it("hands the adapter the compiled text byte-for-byte", async () => {
    const compiled = generateImagePrompt(context());
    const { provider, calls } = recordingProvider();

    await provider.generate({ prompt: compiled.text });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, compiled.text);
    assert.equal(calls[0].prompt, getProvider("generic").formatImagePrompt(compiled.spec));
  });

  it("hands the adapter an edited prompt unchanged, never a recompiled one", async () => {
    const compiled = generateImagePrompt(context());
    const edited = `${compiled.text} Shot on 35mm film stock, heavy grain.`;
    const { provider, calls } = recordingProvider();

    await provider.generate({ prompt: edited });

    assert.equal(calls[0].prompt, edited);
    assert.notEqual(calls[0].prompt, compiled.text);
    assert.ok(calls[0].prompt.includes("heavy grain"), "the filmmaker's edit must survive");
  });

  it("accepts a full compiled prompt at the length the compiler actually produces", () => {
    const compiled = generateImagePrompt(context());
    assert.ok(generationPromptSchema.safeParse({ prompt: compiled.text }).success);
    // A prompt for a shot with nothing filled in is rejected rather than sent.
    const empty = generateImagePrompt(buildShotContext({ shotNumber: "1", shotType: "" }));
    assert.equal(generationPromptSchema.safeParse({ prompt: empty.text }).success, false);
  });
});
