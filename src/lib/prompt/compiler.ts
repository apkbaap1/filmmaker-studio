import type {
  CinematicPromptSpec,
  Maybe,
  PromptMode,
  ShotVisualizationContext,
} from "./types.ts";

const INT_EXT_LABEL: Record<string, string> = {
  INT: "Interior",
  EXT: "Exterior",
  INT_EXT: "Interior/Exterior",
};

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
  const { shot, scene, characters } = context;

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
      emotionalBeat: specified(scene?.emotionalBeat, "scene.emotionalBeat"),
    },

    environment: {
      location: specified(scene?.location, "scene.location"),
      interiorExterior: scene
        ? specified(INT_EXT_LABEL[scene.intExt] ?? scene.intExt, "scene.intExt")
        : undefined,
      timeOfDay: specified(scene?.timeOfDay, "scene.timeOfDay"),
      // No source field on the Shot model yet — see types.ts.
      movement: undefined,
    },

    cinematography: {
      shotSize: specified(shot.shotType, "shot.shotType"),
      cameraAngle: specified(shot.cameraAngle, "shot.cameraAngle"),
      cameraHeight: specified(shot.cameraHeight, "shot.cameraHeight"),
      lens: specified(shot.lens, "shot.lens"),
      focalLength: specified(shot.focalLength, "shot.focalLength"),
      composition: specified(shot.composition, "shot.composition"),
      framing: specified(shot.framing, "shot.framing"),
      depthOfField: specified(shot.depthOfField, "shot.depthOfField"),
    },

    lighting: {
      setup: specified(shot.lightingNotes, "shot.lightingNotes"),
      mood: specified(shot.mood, "shot.mood"),
    },

    motion: {
      cameraMovement: specified(shot.cameraMovement, "shot.cameraMovement"),
      speed: specified(shot.movementSpeed, "shot.movementSpeed"),
      startState: specified(shot.cameraStartPosition, "shot.cameraStartPosition"),
      endState: specified(shot.cameraEndPosition, "shot.cameraEndPosition"),
      subjectMovement: specified(shot.subjectMovement, "shot.subjectMovement"),
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

  if (spec.subject.characters.length > 0) preserve.push("Character identity and appearance");
  if (spec.environment.location) preserve.push("Location");
  if (spec.lighting.setup) preserve.push("Lighting setup");
  if (spec.cinematography.composition) preserve.push("Composition");
  if (spec.cinematography.framing) preserve.push("Framing");
  if (spec.cinematography.shotSize) preserve.push("Shot size");
  if (spec.cinematography.lens || spec.cinematography.focalLength) preserve.push("Lens character");

  if (spec.motion.cameraMovement) animate.push("Camera movement");
  if (spec.motion.subjectMovement) animate.push("Subject movement");
  if (spec.subject.action) animate.push("Character action");
  if (spec.environment.movement) animate.push("Environmental movement");

  return { preserve, animate };
}
