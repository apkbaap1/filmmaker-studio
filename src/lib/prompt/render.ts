import type { CinematicPromptSpec, Maybe } from "./types.ts";

/**
 * String rendering layer. Kept separate from the canonical CinematicPromptSpec:
 * the spec is the artifact, these functions are one projection of it.
 *
 * Rule for every renderer here: filmmaker-selected values are emitted verbatim,
 * exactly as stored. Only connective language ("shot from a", "over") is
 * generated. Values are never re-cased, re-worded, abbreviated or substituted.
 */

function v<T>(m: Maybe<T>): T | undefined {
  return m?.value;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function keep(parts: Array<string | undefined | false>): string[] {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map(clean);
}

/** Joins independent clauses, terminating each one. */
function sentences(parts: Array<string | undefined | false>): string | undefined {
  const kept = keep(parts);
  if (kept.length === 0) return undefined;
  return kept.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" ");
}

/** Joins parts of a single sentence with commas, then terminates it once. */
function commaSentence(parts: Array<string | undefined | false>): string | undefined {
  return joinedSentence(parts, ", ");
}

/**
 * Joins with semicolons. Used where the parts themselves contain commas — a
 * camera position like "4m back, platform edge" would otherwise be unreadable
 * inside a comma-separated list.
 */
function semicolonSentence(parts: Array<string | undefined | false>): string | undefined {
  return joinedSentence(parts, "; ");
}

function joinedSentence(parts: Array<string | undefined | false>, separator: string): string | undefined {
  const kept = keep(parts);
  if (kept.length === 0) return undefined;
  const text = kept.join(separator);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function paragraph(parts: Array<string | undefined>): string {
  return parts.filter((s): s is string => Boolean(s)).join(" ");
}

function nameList(names: string[]): string | undefined {
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "85mm Prime lens" / "85mm lens" / "Prime lens" — both values verbatim. */
function lensPhrase(spec: CinematicPromptSpec): string | undefined {
  const focal = v(spec.cinematography.focalLength);
  const lens = v(spec.cinematography.lens);
  if (focal && lens) return `${focal} ${lens} lens`;
  if (focal) return `${focal} lens`;
  if (lens) return `${lens} lens`;
  return undefined;
}

function framingSentence(spec: CinematicPromptSpec): string | undefined {
  const size = v(spec.cinematography.shotSize);
  const subject = nameList(spec.subject.characters.map((c) => c.name));
  const angle = v(spec.cinematography.cameraAngle);
  const height = v(spec.cinematography.cameraHeight);
  const lens = lensPhrase(spec);

  const head = size && subject ? `${size} of ${subject}` : (size ?? (subject && `Shot of ${subject}`));

  return commaSentence([
    head,
    angle && `from a ${angle}`,
    height && `at ${height}`,
    lens && `shot on ${lens}`,
  ]);
}

function environmentSentence(spec: CinematicPromptSpec): string | undefined {
  const location = v(spec.environment.location);
  const intExt = v(spec.environment.interiorExterior);
  const time = v(spec.environment.timeOfDay);
  const props = v(spec.environment.props);

  const place = location && intExt ? `${location} (${intExt})` : location;
  const setting =
    location || time
      ? commaSentence([place && `Setting — ${place}`, time && (place ? time : `Time of day — ${time}`)])
      : undefined;

  // Props carry their own semicolons (foreground: …; background: …), so they
  // are their own sentence rather than another clause in the setting.
  return sentences([setting, props && `Props — ${props}`]);
}

function actionSentence(spec: CinematicPromptSpec): string | undefined {
  const blocking = v(spec.subject.blocking);
  const facing = v(spec.subject.facing);
  const wardrobe = v(spec.subject.wardrobe);
  return sentences([
    v(spec.subject.action),
    wardrobe && `Wardrobe: ${wardrobe}`,
    blocking && `Blocking: ${blocking}`,
    facing && `Subject facing: ${facing}`,
  ]);
}

function compositionSentence(spec: CinematicPromptSpec): string | undefined {
  const composition = v(spec.cinematography.composition);
  const framing = v(spec.cinematography.framing);
  const depthOfField = v(spec.cinematography.depthOfField);
  // Labels stay capitalised so the sentence reads correctly whichever of these
  // the filmmaker happened to specify.
  return semicolonSentence([
    composition && `Composition: ${composition}`,
    framing && `Framing: ${framing}`,
    depthOfField && `Depth of field: ${depthOfField}`,
  ]);
}

function lightingSentence(spec: CinematicPromptSpec): string | undefined {
  const setup = v(spec.lighting.setup);
  const mood = v(spec.lighting.mood);
  const beat = v(spec.subject.emotionalBeat);
  return sentences([
    setup && `Lighting: ${setup}`,
    mood && `Mood: ${mood}`,
    beat && `Emotional beat: ${beat}`,
  ]);
}

function notesSentence(spec: CinematicPromptSpec): string | undefined {
  const directorNotes = v(spec.notes.directorNotes);
  return sentences([v(spec.notes.description), directorNotes && `Director's note: ${directorNotes}`]);
}

/**
 * Describes the camera operation according to what it actually is. A rack focus
 * is an optical change and is never phrased as the camera moving; a static
 * camera asserts the absence of movement; anything else is described as written.
 */
function operationPhrase(spec: CinematicPromptSpec): string | undefined {
  const movement = v(spec.motion.cameraMovement);
  const speed = v(spec.motion.speed);
  if (!movement) return undefined;

  const paced = (label: string) => (speed ? `${label}, ${speed} pace` : label);

  switch (spec.motion.movementKind) {
    case "static":
      return "Camera remains static — no camera movement";
    case "focus":
      return paced(`Focus transition — ${movement}; the camera itself does not move`);
    case "support":
      return paced(`Camera support — ${movement}`);
    default:
      return paced(`Camera movement — ${movement}`);
  }
}

/**
 * The temporal block, rendered as an explicit progression rather than a list of
 * facts, because a video model reads order:
 *
 *   START      the frame at the head of the shot
 *   MOTION     what actually operates over the shot's duration
 *   END        the frame at the tail
 *   HOLD       the axes that deliberately do not change while the rest does
 *   DURATION   how long all of that takes
 *
 * Every line is omitted unless the filmmaker specified it, and a start or end
 * state is never inferred from the movement type. HOLD is not an exception: it
 * only ever restates a value they entered, and only when something else is
 * moving for it to be held against.
 */
function temporalParagraph(spec: CinematicPromptSpec): string | undefined {
  const m = spec.motion;

  const framingProgresses = Boolean(v(m.finalFraming));
  const compositionTransitions = Boolean(v(m.finalComposition));

  // Semicolons, not commas: values like "4m back, platform edge" contain commas
  // of their own and would be unreadable in a comma-separated list.
  // Labels stay capitalised so each group reads correctly whichever of its parts
  // the filmmaker happened to specify first.
  const start = semicolonSentence([
    v(m.initialFraming) && `Opening framing: ${v(m.initialFraming)}`,
    // A stable composition is stated once under HOLD instead; calling it the
    // "opening" composition would imply it is about to change.
    compositionTransitions &&
      v(spec.cinematography.composition) &&
      `Opening composition: ${v(spec.cinematography.composition)}`,
    v(m.cameraStartPosition) && `Camera starts at ${v(m.cameraStartPosition)}`,
    v(m.subjectStartPosition) && `Subject starts at ${v(m.subjectStartPosition)}`,
  ]);

  const motion = sentences([
    operationPhrase(spec),
    v(m.cameraApproach),
    v(m.subjectMovement) && `Subject movement: ${v(m.subjectMovement)}`,
    v(spec.environment.movement) && `Environmental movement: ${v(spec.environment.movement)}`,
  ]);

  const end = semicolonSentence([
    v(m.finalFraming) && `Closing framing: ${v(m.finalFraming)}`,
    v(m.finalComposition) && `Closing composition: ${v(m.finalComposition)}`,
    v(m.cameraEndPosition) && `Camera ends at ${v(m.cameraEndPosition)}`,
    v(m.subjectEndPosition) && `Subject ends at ${v(m.subjectEndPosition)}`,
  ]);

  // Something has to be moving for "holds" to mean anything. Note that a rack
  // focus counts: the frame holding while focus travels is the whole point.
  const somethingMoves = Boolean(
    motion || framingProgresses || compositionTransitions || v(m.subjectMovement)
  );

  const hold = somethingMoves
    ? semicolonSentence([
        !compositionTransitions &&
          v(spec.cinematography.composition) &&
          `Composition stays as specified: ${v(spec.cinematography.composition)}`,
        !framingProgresses &&
          v(spec.cinematography.framing) &&
          `Framing stays as specified: ${v(spec.cinematography.framing)}`,
      ])
    : undefined;

  const duration = v(m.durationSeconds);

  return [
    start && `START — ${start}`,
    motion && `MOTION — ${motion}`,
    end && `END — ${end}`,
    hold && `HOLD (must not change while the above moves) — ${hold}`,
    duration !== undefined && `DURATION — ${duration} seconds.`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n") || undefined;
}

function audioParagraph(spec: CinematicPromptSpec): string | undefined {
  const dialogue = v(spec.audio.dialogue);
  const sfx = v(spec.audio.sfx);
  const soundDesign = v(spec.audio.soundDesign);
  return sentences([
    dialogue && `Dialogue/audio: ${dialogue}`,
    sfx && `SFX: ${sfx}`,
    soundDesign && `Sound design: ${soundDesign}`,
  ]);
}

/**
 * Still-frame prompt. Temporal fields are intentionally not rendered — a still
 * has no time axis — but they remain present in the spec for inspection.
 */
export function renderImagePrompt(spec: CinematicPromptSpec): string {
  return paragraph([
    framingSentence(spec),
    environmentSentence(spec),
    actionSentence(spec),
    compositionSentence(spec),
    lightingSentence(spec),
    notesSentence(spec),
  ]);
}

/** Storyboard panel prompt: the still-frame content, declared as a storyboard panel. */
export function renderStoryboardPrompt(spec: CinematicPromptSpec): string {
  const sceneNumber = v(spec.slate.sceneNumber);
  const shotNumber = v(spec.slate.shotNumber);
  const slate = keep([sceneNumber && `Scene ${sceneNumber}`, shotNumber && `Shot ${shotNumber}`]).join(", ");

  return paragraph([
    `Black and white storyboard panel${slate ? ` — ${slate}` : ""}.`,
    renderImagePrompt(spec) || undefined,
  ]);
}

/** Text-to-video prompt: what is in frame, then what happens over time. */
export function renderVideoPrompt(spec: CinematicPromptSpec): string {
  const staticBlock = paragraph([
    framingSentence(spec),
    environmentSentence(spec),
    compositionSentence(spec),
    lightingSentence(spec),
  ]);

  return [
    staticBlock,
    actionSentence(spec),
    temporalParagraph(spec),
    audioParagraph(spec),
    notesSentence(spec),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Image-to-video prompt: an explicit preserve/animate contract plus the temporal plan. */
export function renderImageToVideoPrompt(spec: CinematicPromptSpec): string {
  const blocks: Array<string | undefined> = [
    "Animate the provided frame without altering its content.",
    spec.continuity.preserve.length > 0
      ? `PRESERVE (must not change):\n${spec.continuity.preserve.map((p) => `- ${p}`).join("\n")}`
      : undefined,
    spec.continuity.animate.length > 0
      ? `ANIMATE (may move):\n${spec.continuity.animate.map((a) => `- ${a}`).join("\n")}`
      : undefined,
    temporalParagraph(spec),
    audioParagraph(spec),
    notesSentence(spec),
  ];

  return blocks.filter(Boolean).join("\n\n");
}
