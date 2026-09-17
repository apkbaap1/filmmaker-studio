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
  const kept = keep(parts);
  if (kept.length === 0) return undefined;
  const text = kept.join(", ");
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
  if (!location && !time) return undefined;

  const place = location && intExt ? `${location} (${intExt})` : location;
  return commaSentence([place && `Setting — ${place}`, time && (place ? time : `Time of day — ${time}`)]);
}

function actionSentence(spec: CinematicPromptSpec): string | undefined {
  const blocking = v(spec.subject.blocking);
  return sentences([v(spec.subject.action), blocking && `Blocking: ${blocking}`]);
}

function compositionSentence(spec: CinematicPromptSpec): string | undefined {
  const composition = v(spec.cinematography.composition);
  const framing = v(spec.cinematography.framing);
  const depthOfField = v(spec.cinematography.depthOfField);
  return commaSentence([
    composition && `Composition: ${composition}`,
    framing && `framing: ${framing}`,
    depthOfField && `depth of field: ${depthOfField}`,
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

/** The temporal block: start state → movement → subject motion → end state → duration. */
function temporalParagraph(spec: CinematicPromptSpec): string | undefined {
  const start = v(spec.motion.startState);
  const movement = v(spec.motion.cameraMovement);
  const speed = v(spec.motion.speed);
  const subject = v(spec.motion.subjectMovement);
  const end = v(spec.motion.endState);
  const envMotion = v(spec.environment.movement);
  const duration = v(spec.motion.durationSeconds);

  const cameraPhrase = movement
    ? speed
      ? `Camera movement — ${movement}, ${speed} pace`
      : `Camera movement — ${movement}`
    : undefined;

  return sentences([
    start && `Starting state: ${start}`,
    cameraPhrase,
    subject && `Subject movement: ${subject}`,
    envMotion && `Environmental movement: ${envMotion}`,
    end && `Ending state: ${end}`,
    duration !== undefined && `Duration: ${duration} seconds`,
  ]);
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
