import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The stub's job store is a real directory now, so that a worker restart does
// not silently erase the provider's state. Test files run in parallel
// processes, so each one gets its own.
process.env.VIDEO_STUB_DIR = mkdtempSync(path.join(tmpdir(), "stub-jobs-"));
import { describe, it } from "node:test";

import { defaultBlocking, deriveBlockingContext, type ShotBlocking } from "../blocking.ts";
import {
  buildShotContext,
  compileSpec,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateVideoPrompt,
  getProvider,
  listProviders,
} from "./index.ts";
import type { ShotInput } from "./types.ts";
import { generationPromptSchema } from "../validation.ts";
import {
  localStubVideoProvider,
  resetStubJobs,
  stubJobRequest,
} from "../ai/video-providers/local-stub.ts";
import type { VideoGenerationProvider } from "../ai/video-providers/types.ts";

/**
 * Phase 6 — video previsualization.
 *
 * The video prompt is a projection of the same CinematicPromptSpec the image
 * prompt comes from, so these assert the *temporal* half of the spec: the half a
 * still throws away. Nothing here is "the image prompt plus motion words".
 */

const SCENE = {
  number: "4",
  intExt: "INT",
  location: "ABANDONED RAILWAY STATION",
  timeOfDay: "NIGHT",
  synopsis: "Ravi enters an abandoned railway station at midnight.",
};

/** The exact shot from the Phase 6 brief. */
const TEST_SHOT: ShotInput = {
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
  environmentalMovement: "Light fog drifting through the station.",
  lightingNotes: "Warm practical lights + cool moonlight",
  mood: "Suspenseful",
  durationSeconds: 6,
};

const BLOCKING: ShotBlocking = {
  ...defaultBlocking("Ravi"),
  subjects: [{ id: "s1", label: "Ravi", start: { x: 35, y: 45, orientation: 120 }, waypoints: [] }],
  props: [{ id: "p1", label: "Platform bench", x: 20, y: 70, layer: "foreground" }],
  frame: { subjectX: 30, subjectY: 50, subjectScale: 55, eyelineY: 33 },
};

function context(shot: ShotInput = TEST_SHOT, blocking: unknown = BLOCKING) {
  return buildShotContext(shot, SCENE, [{ characterName: "Ravi" }], deriveBlockingContext(blocking, "Ravi"));
}

/** Index of each progression label, or -1. Used to assert ordering, not just presence. */
function order(text: string) {
  return {
    start: text.indexOf("START —"),
    motion: text.indexOf("MOTION —"),
    end: text.indexOf("END —"),
    hold: text.indexOf("HOLD ("),
    duration: text.indexOf("DURATION —"),
  };
}

describe("Phase 6 — video prompt temporal progression", () => {
  it("renders START → MOTION → END → HOLD → DURATION in that order", () => {
    const { text } = generateVideoPrompt(context());
    const o = order(text);
    assert.ok(o.start >= 0 && o.motion > o.start, `MOTION must follow START:\n${text}`);
    assert.ok(o.end > o.motion, `END must follow MOTION:\n${text}`);
    assert.ok(o.hold > o.end, `HOLD must follow END:\n${text}`);
    assert.ok(o.duration > o.hold, `DURATION must come last:\n${text}`);
  });

  it("carries the brief's progression: Wide → Slow Dolly In → Ravi turns → Tight → 6 seconds", () => {
    const { text } = generateVideoPrompt(context());
    assert.ok(text.includes("START — Opening framing: Wide."));
    assert.ok(text.includes("Camera movement — Dolly In, Slow pace."));
    assert.ok(text.includes("Subject movement: Ravi walks slowly and turns toward the camera."));
    assert.ok(text.includes("END — Closing framing: Tight."));
    assert.ok(text.includes("DURATION — 6 seconds."));
  });

  it("holds the left-third composition while the framing progresses", () => {
    const { spec, text } = generateVideoPrompt(context());
    assert.equal(spec.cinematography.composition?.value, "Ravi on the left third");
    assert.equal(spec.motion.finalComposition, undefined);
    assert.ok(
      text.includes("HOLD (must not change while the above moves) — Composition stays as specified: Ravi on the left third."),
      `composition must be stated as held, not animated:\n${text}`
    );
    assert.ok(!text.includes("Closing composition"), "no composition transition was specified");
    assert.ok(!text.includes("Opening composition"), "a stable composition has no opening state");
  });

  it("keeps the shot designation out of the framing progression", () => {
    const { spec, text } = generateVideoPrompt(context());
    // Medium Close-Up is the shot's name; Wide → Tight is what the frame does.
    assert.equal(spec.cinematography.shotSize?.value, "Medium Close-Up");
    assert.equal(spec.motion.initialFraming?.value, "Wide");
    assert.equal(spec.motion.finalFraming?.value, "Tight");
    assert.ok(text.includes("Medium Close-Up of Ravi"));
    assert.ok(!text.includes("Opening framing: Medium Close-Up"));
  });

  it("carries camera and subject start/end positions when they are given", () => {
    const { text } = generateVideoPrompt(
      context({
        ...TEST_SHOT,
        cameraStartPosition: "4m back, platform edge",
        cameraEndPosition: "1m from subject",
        subjectStartPosition: "Mid-platform, back to camera",
        subjectEndPosition: "Facing camera, centre frame",
      })
    );
    assert.ok(text.includes("START — Opening framing: Wide; Camera starts at 4m back, platform edge; Subject starts at Mid-platform, back to camera."));
    assert.ok(text.includes("Camera ends at 1m from subject; Subject ends at Facing camera, centre frame."));
  });

  it("omits every axis the filmmaker left blank", () => {
    const { text } = generateVideoPrompt(
      context({ shotNumber: "1", shotType: "Wide Shot", cameraMovement: "Dolly In" }, null)
    );
    for (const absent of [
      "Opening framing",
      "Closing framing",
      "Camera starts at",
      "Camera ends at",
      "Subject starts at",
      "Subject ends at",
      "Subject movement",
      "Environmental movement",
      "DURATION",
      "HOLD (",
    ]) {
      assert.ok(!text.includes(absent), `"${absent}" was never specified:\n${text}`);
    }
  });

  it("emits no HOLD when nothing is moving for it to be held against", () => {
    const { text } = generateVideoPrompt(
      context({ shotNumber: "1", shotType: "Wide Shot", composition: "Ravi on the left third" }, null)
    );
    assert.ok(text.includes("Composition: Ravi on the left third"), "still stated as a constant");
    assert.ok(!text.includes("HOLD ("), `nothing moves, so nothing is "held":\n${text}`);
  });
});

describe("Phase 6 — camera movement semantics", () => {
  const KINDS: Array<[string, string]> = [
    ["Static", "static"],
    ["Pan", "rotation"],
    ["Tilt", "rotation"],
    ["Whip Pan", "rotation"],
    ["Dolly In", "translation"],
    ["Dolly Out", "translation"],
    ["Push In", "translation"],
    ["Pull Out", "translation"],
    ["Tracking", "translation"],
    ["Truck Left", "translation"],
    ["Truck Right", "translation"],
    ["Crane Up", "translation"],
    ["Crane Down", "translation"],
    ["Pedestal", "translation"],
    ["Orbit", "translation"],
    ["Arc", "translation"],
    ["Handheld", "support"],
    ["Steadicam", "support"],
    ["Gimbal", "support"],
    ["Drone", "support"],
    ["Rack Focus", "focus"],
  ];

  for (const [movement, kind] of KINDS) {
    it(`classifies "${movement}" as ${kind} and never reinterprets it`, () => {
      const { spec, text } = generateVideoPrompt(
        context({ shotNumber: "1", shotType: "Wide Shot", cameraMovement: movement }, null)
      );
      assert.equal(spec.motion.movementKind, kind);
      if (kind === "static") {
        assert.ok(text.includes("Camera remains static — no camera movement"));
      } else if (kind === "focus") {
        assert.ok(text.includes("Focus transition — Rack Focus; the camera itself does not move"));
        assert.ok(!text.includes("Camera movement —"), "a rack focus is not a camera move");
      } else if (kind === "support") {
        assert.ok(text.includes(`Camera support — ${movement}`));
      } else {
        assert.ok(text.includes(`Camera movement — ${movement}`));
      }
    });
  }

  it("describes an unrecognised movement exactly as typed", () => {
    const { spec, text } = generateVideoPrompt(
      context({ shotNumber: "1", shotType: "Wide Shot", cameraMovement: "Snorricam lock-off" }, null)
    );
    assert.equal(spec.motion.movementKind, "other");
    assert.ok(text.includes("Camera movement — Snorricam lock-off"));
  });

  it("holds the frame through a rack focus rather than animating it", () => {
    const { spec, text } = generateVideoPrompt(
      context(
        {
          shotNumber: "1",
          shotType: "Close-Up",
          cameraMovement: "Rack Focus",
          composition: "Ravi on the left third",
          framing: "Tight",
        },
        null
      )
    );
    assert.equal(spec.motion.movementKind, "focus");
    assert.ok(text.includes("Composition stays as specified: Ravi on the left third"));
    assert.ok(text.includes("Framing stays as specified: Tight"));
  });
});

describe("Phase 6 — environmental movement", () => {
  it("appears under MOTION, separate from camera and subject", () => {
    const { text } = generateVideoPrompt(context());
    const motionBlock = text.split("MOTION — ")[1]?.split("\n")[0] ?? "";
    assert.ok(motionBlock.includes("Camera movement — Dolly In, Slow pace."));
    assert.ok(motionBlock.includes("Subject movement: Ravi walks slowly"));
    assert.ok(motionBlock.includes("Environmental movement: Light fog drifting through the station."));
  });

  it("is carried verbatim for any kind of environmental motion", () => {
    for (const movement of [
      "Rain lashing the windows",
      "Smoke curling from a vent",
      "Dust motes in the beam",
      "Crowd movement across the concourse",
      "Traffic passing behind",
    ]) {
      const { spec, text } = generateVideoPrompt(
        context({ shotNumber: "1", shotType: "Wide Shot", environmentalMovement: movement }, null)
      );
      assert.equal(spec.environment.movement?.value, movement);
      assert.ok(text.includes(`Environmental movement: ${movement}`));
    }
  });

  it("is absent when not specified, and is never derived from mood or weather", () => {
    const { spec, text } = generateVideoPrompt(
      context({ shotNumber: "1", shotType: "Wide Shot", mood: "Suspenseful, foggy" }, null)
    );
    assert.equal(spec.environment.movement, undefined);
    assert.ok(!text.includes("Environmental movement"));
  });
});

describe("Phase 6 — image-to-video PRESERVE / ANIMATE", () => {
  const withWardrobe = { ...TEST_SHOT, wardrobe: "Charcoal overcoat, damp shoulders" };

  it("preserves exactly the properties the brief lists, for the test shot", () => {
    const { spec } = generateImageToVideoPrompt(context(withWardrobe));
    for (const entry of [
      "Character identity and appearance",
      "Costume and wardrobe",
      "Location",
      "Props and set dressing",
      "Lighting setup",
      "Composition",
      "Lens character",
    ]) {
      assert.ok(spec.continuity.preserve.includes(entry), `PRESERVE must include ${entry}`);
    }
  });

  it("animates exactly the motion the shot actually states", () => {
    const { spec } = generateImageToVideoPrompt(context(withWardrobe));
    for (const entry of [
      "Camera movement",
      "Framing progression",
      "Subject movement",
      "Environmental movement",
    ]) {
      assert.ok(spec.continuity.animate.includes(entry), `ANIMATE must include ${entry}`);
    }
  });

  it("keeps Composition out of ANIMATE without an explicit composition transition", () => {
    const { spec, text } = generateImageToVideoPrompt(context(withWardrobe));
    assert.ok(!spec.continuity.animate.includes("Composition change"));
    assert.ok(spec.continuity.preserve.includes("Composition"));
    const preserveBlock = text.split("PRESERVE (must not change):")[1]?.split("ANIMATE")[0] ?? "";
    assert.ok(preserveBlock.includes("- Composition"));
  });

  it("moves Composition to ANIMATE only when a final composition is stated", () => {
    const { spec } = generateImageToVideoPrompt(
      context({ ...withWardrobe, finalComposition: "Ravi centred" })
    );
    assert.ok(spec.continuity.animate.includes("Composition change"));
    assert.ok(!spec.continuity.preserve.includes("Composition"));
  });

  it("puts a rack focus in ANIMATE as a focus transition, with the frame preserved", () => {
    const { spec } = generateImageToVideoPrompt(
      context(
        {
          shotNumber: "1",
          shotType: "Close-Up",
          cameraMovement: "Rack Focus",
          composition: "Ravi on the left third",
        },
        null
      )
    );
    assert.ok(spec.continuity.animate.includes("Focus transition"));
    assert.ok(!spec.continuity.animate.includes("Camera movement"));
    assert.ok(spec.continuity.preserve.includes("Camera position and framing"));
  });

  it("animates nothing for a shot that states no motion", () => {
    const { spec } = generateImageToVideoPrompt(
      context({ shotNumber: "1", shotType: "Wide Shot", composition: "Ravi on the left third" }, null)
    );
    assert.deepEqual(spec.continuity.animate, []);
  });

  it("leads with the do-not-alter instruction and lists both blocks", () => {
    const { text } = generateImageToVideoPrompt(context(withWardrobe));
    assert.ok(text.startsWith("Animate the provided frame without altering its content."));
    assert.ok(text.indexOf("PRESERVE (must not change):") < text.indexOf("ANIMATE (may move):"));
  });
});

describe("Phase 6 — the three modes are distinct projections of one spec", () => {
  it("compiles the same underlying values for every mode", () => {
    const image = compileSpec(context(), "image");
    const video = compileSpec(context(), "video");
    assert.deepEqual(
      { ...image, mode: null, continuity: null },
      { ...video, mode: null, continuity: null }
    );
  });

  it("gives the still no time axis and the clip no PRESERVE contract", () => {
    const still = generateImagePrompt(context()).text;
    const clip = generateVideoPrompt(context()).text;
    const animated = generateImageToVideoPrompt(context()).text;

    assert.ok(!still.includes("MOTION —") && !still.includes("DURATION —"));
    assert.ok(!still.includes("Dolly In"));
    assert.ok(clip.includes("MOTION —") && !clip.includes("PRESERVE (must not change):"));
    assert.ok(animated.includes("PRESERVE (must not change):") && animated.includes("MOTION —"));
  });

  it("populates continuity only for image-to-video", () => {
    assert.deepEqual(compileSpec(context(), "image").continuity, { preserve: [], animate: [] });
    assert.deepEqual(compileSpec(context(), "video").continuity, { preserve: [], animate: [] });
    assert.ok(compileSpec(context(), "image-to-video").continuity.preserve.length > 0);
  });

  it("keeps every prompt adapter able to format the video modes", () => {
    const spec = compileSpec(context(), "video");
    for (const provider of listProviders()) {
      assert.equal(typeof provider.formatVideoPrompt(spec), "string");
      assert.equal(typeof provider.formatImageToVideoPrompt(spec), "string");
    }
    assert.equal(generateVideoPrompt(context()).text, getProvider("generic").formatVideoPrompt(spec));
  });
});

describe("Phase 6 — video provider abstraction", () => {
  it("holds no provider-specific field in the IR", () => {
    const serialised = JSON.stringify(compileSpec(context(), "video"));
    for (const name of ["seedance", "veo", "higgsfield", "runway", "luma", "pika", "apiKey", "job"]) {
      assert.ok(!serialised.toLowerCase().includes(name), `the IR mentions ${name}`);
    }
  });

  it("submits the compiled prompt to the adapter byte-for-byte", async () => {
    resetStubJobs();
    const compiled = generateVideoPrompt(context());
    const { providerJobId } = await localStubVideoProvider.submit({
      prompt: compiled.text,
      mode: "text-to-video",
      durationSeconds: 6,
    });
    const received = stubJobRequest(providerJobId);
    assert.equal(received?.prompt, compiled.text);
    assert.equal(received?.durationSeconds, 6);
    assert.equal(received?.mode, "text-to-video");
  });

  it("submits an edited prompt unchanged rather than recompiling", async () => {
    resetStubJobs();
    const compiled = generateVideoPrompt(context());
    const edited = `${compiled.text}\nHandheld micro-jitter throughout.`;
    const { providerJobId } = await localStubVideoProvider.submit({ prompt: edited, mode: "text-to-video" });
    const received = stubJobRequest(providerJobId);
    assert.equal(received?.prompt, edited);
    assert.notEqual(received?.prompt, compiled.text);
  });

  it("moves a job through processing to completed, and returns a real clip", async () => {
    resetStubJobs();
    process.env.VIDEO_STUB_DELAY_MS = "0";
    const { providerJobId } = await localStubVideoProvider.submit({
      prompt: generateVideoPrompt(context()).text,
      mode: "text-to-video",
    });
    const result = await localStubVideoProvider.poll(providerJobId);
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.video.mimeType, "video/webm");
    // EBML magic — a real container, not a placeholder buffer.
    assert.deepEqual([...result.video.data.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  });

  it("reports processing while the job is still running", async () => {
    resetStubJobs();
    process.env.VIDEO_STUB_DELAY_MS = "10000";
    const { providerJobId } = await localStubVideoProvider.submit({
      prompt: "anything",
      mode: "text-to-video",
    });
    assert.equal((await localStubVideoProvider.poll(providerJobId)).status, "processing");
    process.env.VIDEO_STUB_DELAY_MS = "0";
  });

  it("fails rather than silently degrading when image-to-video has no source frame", async () => {
    resetStubJobs();
    process.env.VIDEO_STUB_DELAY_MS = "0";
    const { providerJobId } = await localStubVideoProvider.submit({
      prompt: "anything",
      mode: "image-to-video",
    });
    const result = await localStubVideoProvider.poll(providerJobId);
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.match(result.error, /source frame/i);
  });

  it("fails an unknown job rather than inventing a result", async () => {
    resetStubJobs();
    const result = await localStubVideoProvider.poll("stub-job-does-not-exist");
    assert.equal(result.status, "failed");
  });

  it("passes the source frame's bytes through for image-to-video", async () => {
    resetStubJobs();
    process.env.VIDEO_STUB_DELAY_MS = "0";
    const frame = { data: Buffer.from("fake-png-bytes"), mimeType: "image/png" };
    const { providerJobId } = await localStubVideoProvider.submit({
      prompt: generateImageToVideoPrompt(context()).text,
      mode: "image-to-video",
      sourceImage: frame,
    });
    assert.deepEqual(stubJobRequest(providerJobId)?.sourceImage, frame);
    assert.equal((await localStubVideoProvider.poll(providerJobId)).status, "completed");
  });

  it("lets a second provider be added without touching the spec", async () => {
    // A bare object satisfying the interface is all an adapter has to be.
    const calls: string[] = [];
    const another: VideoGenerationProvider = {
      id: "another",
      label: "Another",
      model: "m",
      capabilities: { kind: "stub", imageToVideo: false, allowedDurationsSeconds: [4, 8] },
      // Required rather than optional: an adapter has to state whether it can
      // deduplicate a resubmission, because the worker's crash-recovery path
      // depends on the answer.
      supportsIdempotencyKey: false,
      isConfigured: () => true,
      async submit(request) {
        calls.push(request.prompt);
        return { providerJobId: "x" };
      },
      async poll() {
        return { status: "completed", video: { data: Buffer.alloc(0), mimeType: "video/mp4" } };
      },
    };
    const compiled = generateVideoPrompt(context());
    await another.submit({ prompt: compiled.text, mode: "text-to-video" });
    assert.deepEqual(calls, [compiled.text]);
    assert.equal(another.capabilities.imageToVideo, false);
  });
});

describe("Phase 6 — what counts as an edit", () => {
  it("does not call a multi-line prompt edited just because the form sent CRLF", () => {
    // A multipart form body encodes every newline as CRLF. The video prompt has
    // eight of them, so without normalisation every untouched video generation
    // would be recorded as hand-edited.
    const compiled = generateVideoPrompt(context()).text;
    assert.ok(compiled.includes("\n"), "the video prompt is multi-line");

    const asSubmittedByAForm = compiled.replace(/\n/g, "\r\n");
    const parsed = generationPromptSchema.safeParse({ prompt: asSubmittedByAForm });
    assert.ok(parsed.success);
    assert.equal(parsed.data.prompt, compiled);
    assert.equal(parsed.data.prompt.trim() !== compiled.trim(), false);
  });

  it("still detects a real edit through the same path", () => {
    const compiled = generateVideoPrompt(context()).text;
    const edited = `${compiled}\nKeep the fog soft and slow.`;
    const parsed = generationPromptSchema.safeParse({ prompt: edited.replace(/\n/g, "\r\n") });
    assert.ok(parsed.success);
    assert.notEqual(parsed.data.prompt.trim(), compiled.trim());
    assert.ok(parsed.data.prompt.endsWith("Keep the fog soft and slow."));
    assert.ok(!parsed.data.prompt.includes("\r"), "the stored prompt carries no CR");
  });

  it("rejects an empty prompt rather than submitting one", () => {
    assert.equal(generationPromptSchema.safeParse({ prompt: "" }).success, false);
    const bare = generateVideoPrompt(buildShotContext({ shotNumber: "1", shotType: "" })).text;
    assert.equal(generationPromptSchema.safeParse({ prompt: bare }).success, false);
  });
});
