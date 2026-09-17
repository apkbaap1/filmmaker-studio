/**
 * Prompt Compiler Engine — type layer.
 *
 * The structured Scene/Shot/Character records are the single source of truth.
 * Nothing in this module reads from or writes to the database, calls an LLM, or
 * knows about a specific AI provider.
 */

/**
 * A value the filmmaker explicitly specified, tagged with the structured field
 * it came from. `from` is what a future Prompt Inspector renders as provenance.
 */
export interface Specified<T> {
  value: T;
  from: string;
}

/**
 * `undefined` means the filmmaker did not specify this. It is never a default
 * and never a placeholder — an absent value simply does not reach the output.
 */
export type Maybe<T> = Specified<T> | undefined;

export type PromptMode = "image" | "video" | "image-to-video" | "storyboard";

/**
 * What kind of operation a camera-movement value actually describes. Classified
 * so the renderers don't have to string-match, and so semantically different
 * operations are never described as the same thing:
 *
 * - `static`      the camera does not move
 * - `translation` the camera physically travels (dolly, track, crane, orbit…)
 * - `rotation`    the camera pivots in place (pan, tilt, whip pan)
 * - `focus`       an optical change, not a camera move (rack focus)
 * - `support`     how the camera is carried (handheld, Steadicam, gimbal, drone)
 * - `other`       a custom value the filmmaker typed; described, never reinterpreted
 * - `unspecified` no movement was specified at all
 */
export type MovementKind =
  | "static"
  | "translation"
  | "rotation"
  | "focus"
  | "support"
  | "other"
  | "unspecified";

export interface CharacterRef {
  name: string;
  from: string;
}

/**
 * The provider-independent intermediate representation. This is the canonical
 * artifact of the compiler — the string renderers are a separate layer built on
 * top of it, and provider adapters consume this, never the raw shot record.
 */
export interface CinematicPromptSpec {
  mode: PromptMode;

  slate: {
    sceneNumber: Maybe<string>;
    shotNumber: Maybe<string>;
    slugline: Maybe<string>;
  };

  subject: {
    characters: CharacterRef[];
    action: Maybe<string>;
    blocking: Maybe<string>;
    emotionalBeat: Maybe<string>;
  };

  environment: {
    location: Maybe<string>;
    interiorExterior: Maybe<string>;
    timeOfDay: Maybe<string>;
    /**
     * Environmental motion (rain, steam, crowd drift…). The Shot model has no
     * field feeding this yet, so it currently always compiles to `undefined`.
     * The slot exists so adding the field later needs no IR change.
     */
    movement: Maybe<string>;
  };

  cinematography: {
    shotSize: Maybe<string>;
    cameraAngle: Maybe<string>;
    cameraHeight: Maybe<string>;
    lens: Maybe<string>;
    focalLength: Maybe<string>;
    composition: Maybe<string>;
    framing: Maybe<string>;
    depthOfField: Maybe<string>;
  };

  lighting: {
    setup: Maybe<string>;
    mood: Maybe<string>;
  };

  /**
   * Temporal specification. Populated for every mode; only rendered by the modes
   * with a time axis.
   *
   * Four independent axes are deliberately kept apart, because conflating them
   * is how a "Medium Close-Up that dollies in from a wide" gets mis-described:
   *
   * - **framing** (`initialFraming` → `finalFraming`) — what the frame shows over time.
   *   The shot's *designation* lives separately in `cinematography.shotSize`.
   * - **composition** (`cinematography.composition` → `finalComposition`) — spatial
   *   placement of the subject in frame. A dolly-in can change the framing while
   *   the subject stays on the left third, so a framing change never implies a
   *   composition change. Composition is stable unless `finalComposition` is set.
   * - **camera position** (`cameraStartPosition` → `cameraEndPosition`) — where the
   *   camera physically sits.
   * - **subject position** (`subjectStartPosition` → `subjectEndPosition`) — where the
   *   performer is, independent of both.
   */
  motion: {
    cameraMovement: Maybe<string>;
    /** Derived from `cameraMovement`; `unspecified` when no movement was given. */
    movementKind: MovementKind;
    speed: Maybe<string>;

    initialFraming: Maybe<string>;
    finalFraming: Maybe<string>;

    /** Set only when the filmmaker explicitly specified the placement changing. */
    finalComposition: Maybe<string>;

    cameraStartPosition: Maybe<string>;
    cameraEndPosition: Maybe<string>;

    subjectMovement: Maybe<string>;
    subjectStartPosition: Maybe<string>;
    subjectEndPosition: Maybe<string>;

    durationSeconds: Maybe<number>;
  };

  audio: {
    dialogue: Maybe<string>;
    sfx: Maybe<string>;
    soundDesign: Maybe<string>;
  };

  /** Populated for image-to-video only: what must not change vs. what may move. */
  continuity: {
    preserve: string[];
    animate: string[];
  };

  notes: {
    description: Maybe<string>;
    directorNotes: Maybe<string>;
  };
}

/**
 * Structural input types. These deliberately mirror the Prisma models without
 * importing them, so the compiler stays pure and testable with plain objects.
 * A Prisma `ShotListItem` / `Scene` / `CastMember` row satisfies them as-is.
 */
export interface ShotInput {
  shotNumber: string;
  shotType: string;
  description?: string | null;

  cameraAngle?: string | null;
  cameraHeight?: string | null;
  lens?: string | null;
  focalLength?: string | null;
  cameraMovement?: string | null;
  cameraStartPosition?: string | null;
  cameraEndPosition?: string | null;
  movementSpeed?: string | null;

  initialFraming?: string | null;
  finalFraming?: string | null;

  subjectMovement?: string | null;
  subjectStartPosition?: string | null;
  subjectEndPosition?: string | null;
  characterBlocking?: string | null;

  composition?: string | null;
  finalComposition?: string | null;
  framing?: string | null;
  depthOfField?: string | null;

  lightingNotes?: string | null;
  mood?: string | null;

  durationSeconds?: number | null;
  dialogueAudio?: string | null;
  sfx?: string | null;
  soundDesignNotes?: string | null;

  directorNotes?: string | null;
}

export interface SceneInput {
  number: string;
  intExt: string;
  location: string;
  timeOfDay: string;
  synopsis?: string | null;
  action?: string | null;
  emotionalBeat?: string | null;
  directorNotes?: string | null;
}

export interface CharacterInput {
  characterName: string;
}

/** A shot resolved together with the scene and characters that give it context. */
export interface ShotVisualizationContext {
  shot: ShotInput;
  scene?: SceneInput;
  characters: CharacterInput[];
}

/** What the public compiler API returns: the structured spec plus its rendered, editable text. */
export interface CompiledPrompt {
  mode: PromptMode;
  providerId: string;
  /** Canonical structured form — for inspection, diffing and versioning. */
  spec: CinematicPromptSpec;
  /** Rendered text. Always safe for the filmmaker to edit; nothing re-derives from it. */
  text: string;
}
