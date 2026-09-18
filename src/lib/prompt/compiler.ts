import type {
  CinematicPromptSpec,
  Maybe,
  MovementKind,
  PromptMode,
  ShotVisualizationContext,
} from "./types.ts";

const INT_EXT_LABEL: Record<string, string> = {
  INT: "Interior",
  EXT: "Exterior",
  INT_EXT: "Interior/Exterior",
};

/**
 * Maps the camera-movement vocabulary to what each value physically is. Rack
 * focus is the important one: it is an optical change, so it must never be
 * described as the camera moving. Static is the other: it asserts the absence
 * of movement rather than a kind of movement.
 */
const MOVEMENT_KINDS: Record<string, MovementKind> = {
  "static": "static",

  "dolly in": "translation",
  "dolly out": "translation",
  "push in": "translation",
  "pull out": "translation",
  "tracking": "translation",
  "truck left": "translation",
  "truck right": "translation",
  "crane": "translation",
  "crane up": "translation",
  "crane down": "translation",
  "pedestal": "translation",
  "orbit": "translation",
  "arc": "translation",

  "pan": "rotation",
  "tilt": "rotation",
  "whip pan": "rotation",

  "rack focus": "focus",

  "handheld": "support",
  "steadicam": "support",
  "gimbal": "support",
  "drone": "support",
};

/**
 * Classifies a movement value. Unrecognised values — the field accepts free
 * text — are `other`: they get described exactly as written, never reinterpreted.
 */
export function classifyMovement(movement: string | null | undefined): MovementKind {
  if (!movement || movement.trim() === "") return "unspecified";
  return MOVEMENT_KINDS[movement.trim().toLowerCase()] ?? "other";
}

/**
 * The single gate every value passes through. A null, undefined or blank value
 * produces `undefined`, which means the field cannot reach the rendered prompt.
 * This is what makes "never invent an unspecified parameter" structural rather
 * than a convention the renderers have to remember.
 */
function specified<T>(value: T | null | undefined, from: string): Maybe<T> {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return { value, from };
}

/**
 * Compiles structured filmmaking data into the provider-independent
 * CinematicPromptSpec. Deterministic: the same context always yields the same
 * spec, and every value is carried through byte-for-byte as the filmmaker
 * entered it. No LLM, no I/O, no provider knowledge.
 */
export function compileSpec(
  context: ShotVisualizationContext,
  mode: PromptMode
): CinematicPromptSpec {
  const { shot, scene, characters, blocking } = context;

  const spec: CinematicPromptSpec = {
    mode,

    slate: {
      sceneNumber: specified(scene?.number, "scene.number"),
      shotNumber: specified(shot.shotNumber, "shot.shotNumber"),
      slugline: scene
        ? specified(
            `${INT_EXT_LABEL[scene.intExt] ?? scene.intExt}. ${scene.location} — ${scene.timeOfDay}`,
            "scene.intExt + scene.location + scene.timeOfDay"
          )
        : undefined,
    },

    subject: {
      characters: characters.map((c) => ({
        name: c.characterName,
        from: "scene.characters",
      })),
      action: specified(scene?.action, "scene.action"),
      blocking: specified(shot.characterBlocking, "shot.characterBlocking"),
      facing: specified(
        blocking?.subjectFacings ?? blocking?.subjectFacing,
        "shot.blocking.subjects"
      ),
      wardrobe: specified(shot.wardrobe, "shot.wardrobe"),
      emotionalBeat: specified(scene?.emotionalBeat, "scene.emotionalBeat"),
    },

    environment: {
      location: specified(scene?.location, "scene.location"),
      interiorExterior: scene
        ? specified(INT_EXT_LABEL[scene.intExt] ?? scene.intExt, "scene.intExt")
        : undefined,
      timeOfDay: specified(scene?.timeOfDay, "scene.timeOfDay"),
      movement: specified(shot.environmentalMovement, "shot.environmentalMovement"),
      props: specified(blocking?.propLayers, "shot.blocking.props"),
    },

    cinematography: {
      shotSize: specified(shot.shotType, "shot.shotType"),
      cameraAngle: specified(shot.cameraAngle, "shot.cameraAngle"),
      cameraHeight: specified(shot.cameraHeight, "shot.cameraHeight"),
      lens: specified(shot.lens, "shot.lens"),
      focalLength: specified(shot.focalLength, "shot.focalLength"),
      // Typed composition always wins. The canvas's frame placement is only a
      // fallback for a composition the filmmaker left blank — it never
      // overwrites, reworders or competes with what they actually wrote.
      composition:
        specified(shot.composition, "shot.composition") ??
        specified(blocking?.framePlacement, "shot.blocking.frame"),
      framing: specified(shot.framing, "shot.framing"),
      depthOfField: specified(shot.depthOfField, "shot.depthOfField"),
    },

    lighting: {
      setup: specified(shot.lightingNotes, "shot.lightingNotes"),
      mood: specified(shot.mood, "shot.mood"),
    },

    motion: {
      cameraMovement: specified(shot.cameraMovement, "shot.cameraMovement"),
      movementKind: classifyMovement(shot.cameraMovement),
      speed: specified(shot.movementSpeed, "shot.movementSpeed"),

      initialFraming: specified(shot.initialFraming, "shot.initialFraming"),
      finalFraming: specified(shot.finalFraming, "shot.finalFraming"),
      finalComposition: specified(shot.finalComposition, "shot.finalComposition"),

      cameraStartPosition: specified(shot.cameraStartPosition, "shot.cameraStartPosition"),
      cameraEndPosition: specified(shot.cameraEndPosition, "shot.cameraEndPosition"),
      cameraApproach: specified(blocking?.cameraApproach, "shot.blocking.cameraPath"),

      subjectMovement: specified(shot.subjectMovement, "shot.subjectMovement"),
      subjectStartPosition: specified(shot.subjectStartPosition, "shot.subjectStartPosition"),
      subjectEndPosition: specified(shot.subjectEndPosition, "shot.subjectEndPosition"),

      durationSeconds: specified(shot.durationSeconds, "shot.durationSeconds"),
    },

    audio: {
      dialogue: specified(shot.dialogueAudio, "shot.dialogueAudio"),
      sfx: specified(shot.sfx, "shot.sfx"),
      soundDesign: specified(shot.soundDesignNotes, "shot.soundDesignNotes"),
    },

    continuity: { preserve: [], animate: [] },

    notes: {
      description: specified(shot.description, "shot.description"),
      directorNotes: specified(shot.directorNotes, "shot.directorNotes"),
    },
  };

  if (mode === "image-to-video") {
    spec.continuity = deriveContinuity(spec);
  }

  return spec;
}

/**
 * Derives the preserve/animate split for image-to-video. Both lists are a pure
 * function of which fields the filmmaker actually specified — restating their
 * choices, never adding new ones. A field they left blank appears in neither list.
 */
function deriveContinuity(spec: CinematicPromptSpec): { preserve: string[]; animate: string[] } {
  const preserve: string[] = [];
  const animate: string[] = [];

  const kind = spec.motion.movementKind;

  // Both transitions are driven purely by an explicit end state. Camera movement
  // is never used to infer either one: a dolly-in does not by itself mean the
  // filmmaker wants the framing redefined, and it certainly does not mean the
  // subject leaves the left third.
  const framingProgresses = Boolean(spec.motion.finalFraming);
  const compositionChanges = Boolean(spec.motion.finalComposition);

  if (spec.subject.characters.length > 0) preserve.push("Character identity and appearance");
  if (spec.subject.wardrobe) preserve.push("Costume and wardrobe");
  if (spec.environment.location) preserve.push("Location");
  if (spec.environment.props) preserve.push("Props and set dressing");
  if (spec.lighting.setup) preserve.push("Lighting setup");

  // Spatial placement is independent of shot scale. It survives a framing change
  // — a dolly-in can tighten the frame while holding the subject on the left
  // third — and is only released when a composition change is stated outright.
  if (spec.cinematography.composition && !compositionChanges) preserve.push("Composition");

  // Shot scale, by contrast, is released as soon as a framing transition is specified.
  if (spec.cinematography.framing && !framingProgresses && kind !== "focus") {
    preserve.push("Framing");
  }
  if (spec.cinematography.shotSize && !framingProgresses) preserve.push("Shot size");
  if (spec.cinematography.lens || spec.cinematography.focalLength) preserve.push("Lens character");

  // A rack focus changes focus, not position — so the frame itself holds.
  if (kind === "focus") preserve.push("Camera position and framing");

  if (spec.motion.cameraMovement && kind !== "static" && kind !== "focus") {
    animate.push("Camera movement");
  }
  if (kind === "focus") animate.push("Focus transition");
  if (framingProgresses) animate.push("Framing progression");
  if (compositionChanges) animate.push("Composition change");
  if (spec.motion.subjectMovement) animate.push("Subject movement");
  if (spec.subject.action) animate.push("Character action");
  if (spec.environment.movement) animate.push("Environmental movement");

  return { preserve, animate };
}
