import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const projectSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  logline: z.string().max(500).optional().or(z.literal("")),
  description: z.string().max(5000).optional().or(z.literal("")),
  genre: z.string().max(100).optional().or(z.literal("")),
  format: z.string().max(100).optional().or(z.literal("")),
  status: z.string().max(50).optional().or(z.literal("")),
});

export const sceneSchema = z.object({
  number: z.string().min(1).max(20),
  intExt: z.enum(["INT", "EXT", "INT_EXT"]),
  location: z.string().min(1).max(200),
  timeOfDay: z.enum(["DAY", "NIGHT", "DAWN", "DUSK"]),
  synopsis: z.string().max(2000).optional().or(z.literal("")),
  scriptText: z.string().max(20000).optional().or(z.literal("")),
  action: z.string().max(4000).optional().or(z.literal("")),
  emotionalBeat: z.string().max(500).optional().or(z.literal("")),
  directorNotes: z.string().max(2000).optional().or(z.literal("")),
  pageEights: z.coerce.number().min(0).max(500),
  characterIds: z.array(z.string()).optional().default([]),
});

export const shotSchema = z.object({
  shotNumber: z.string().min(1).max(20),
  shotType: z.string().min(1).max(100),
  description: z.string().max(2000).optional().or(z.literal("")),
  status: z.enum(["PLANNED", "SHOT", "CUT"]),

  // Camera
  cameraAngle: z.string().max(100).optional().or(z.literal("")),
  cameraHeight: z.string().max(100).optional().or(z.literal("")),
  lens: z.string().max(100).optional().or(z.literal("")),
  focalLength: z.string().max(50).optional().or(z.literal("")),
  cameraMovement: z.string().max(100).optional().or(z.literal("")),
  cameraStartPosition: z.string().max(200).optional().or(z.literal("")),
  cameraEndPosition: z.string().max(200).optional().or(z.literal("")),
  movementSpeed: z.string().max(100).optional().or(z.literal("")),

  // Subject / blocking
  subjectMovement: z.string().max(500).optional().or(z.literal("")),
  subjectStartPosition: z.string().max(200).optional().or(z.literal("")),
  subjectEndPosition: z.string().max(200).optional().or(z.literal("")),
  characterBlocking: z.string().max(500).optional().or(z.literal("")),

  // Movement in the environment itself, distinct from camera and subject movement
  environmentalMovement: z.string().max(500).optional().or(z.literal("")),

  // Costume/wardrobe — a continuity property, not a motion one
  wardrobe: z.string().max(500).optional().or(z.literal("")),

  // Composition (spatial placement) and shot scale — separate axes
  composition: z.string().max(500).optional().or(z.literal("")),
  finalComposition: z.string().max(500).optional().or(z.literal("")),
  framing: z.string().max(200).optional().or(z.literal("")),
  depthOfField: z.string().max(100).optional().or(z.literal("")),

  // Temporal framing state — only set when the filmmaker states a transition
  initialFraming: z.string().max(200).optional().or(z.literal("")),
  finalFraming: z.string().max(200).optional().or(z.literal("")),

  // Lighting & mood
  lightingNotes: z.string().max(1000).optional().or(z.literal("")),
  mood: z.string().max(200).optional().or(z.literal("")),

  // Audio & timing
  durationSeconds: z.coerce.number().min(0).max(3600).optional(),
  dialogueAudio: z.string().max(1000).optional().or(z.literal("")),
  sfx: z.string().max(500).optional().or(z.literal("")),
  soundDesignNotes: z.string().max(1000).optional().or(z.literal("")),

  // Edit
  transition: z.string().max(100).optional().or(z.literal("")),
  editPoint: z.string().max(200).optional().or(z.literal("")),

  // Notes
  equipmentNotes: z.string().max(500).optional().or(z.literal("")),
  directorNotes: z.string().max(2000).optional().or(z.literal("")),
});

export const scheduleDaySchema = z.object({
  dayNumber: z.coerce.number().int().min(1),
  date: z.string().min(1),
  callTime: z.string().max(20).optional().or(z.literal("")),
  wrapTime: z.string().max(20).optional().or(z.literal("")),
  location: z.string().max(200).optional().or(z.literal("")),
  weather: z.string().max(200).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const scheduleItemSchema = z.object({
  sceneId: z.string().optional().or(z.literal("")),
  startTime: z.string().max(20).optional().or(z.literal("")),
  endTime: z.string().max(20).optional().or(z.literal("")),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

export const castMemberSchema = z.object({
  characterName: z.string().min(1).max(200),
  actorName: z.string().max(200).optional().or(z.literal("")),
  contactEmail: z.string().max(200).optional().or(z.literal("")),
  contactPhone: z.string().max(50).optional().or(z.literal("")),
  status: z.enum(["CONSIDERING", "OFFERED", "CONFIRMED", "DECLINED"]),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const crewMemberSchema = z.object({
  name: z.string().min(1).max(200),
  department: z.string().min(1).max(100),
  position: z.string().min(1).max(100),
  contactEmail: z.string().max(200).optional().or(z.literal("")),
  contactPhone: z.string().max(50).optional().or(z.literal("")),
  dayRate: z.coerce.number().min(0).optional(),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const locationSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional().or(z.literal("")),
  contactName: z.string().max(200).optional().or(z.literal("")),
  contactPhone: z.string().max(50).optional().or(z.literal("")),
  permitStatus: z.string().max(100).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const equipmentSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  quantity: z.coerce.number().int().min(1),
  source: z.enum(["OWNED", "RENTED", "BORROWED"]),
  dailyCost: z.coerce.number().min(0).optional(),
  vendor: z.string().max(200).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const budgetCategorySchema = z.object({
  name: z.string().min(1).max(200),
});

export const budgetLineItemSchema = z.object({
  description: z.string().min(1).max(300),
  estimated: z.coerce.number().min(0),
  actual: z.coerce.number().min(0),
  notes: z.string().max(1000).optional().or(z.literal("")),
});

// Compact field set for the Storyboard panel's inline quick-edit. Deliberately
// smaller than shotSchema — it's a partial update (see updateShotStoryboardFieldsAction)
// so fields not listed here are left untouched on the underlying shot record.
export const storyboardShotSchema = z.object({
  shotNumber: z.string().min(1).max(20),
  shotType: z.string().min(1).max(100),
  cameraAngle: z.string().max(100).optional().or(z.literal("")),
  cameraMovement: z.string().max(100).optional().or(z.literal("")),
  lens: z.string().max(100).optional().or(z.literal("")),
  durationSeconds: z.coerce.number().min(0).max(3600).optional(),
  dialogueAudio: z.string().max(1000).optional().or(z.literal("")),
  soundDesignNotes: z.string().max(1000).optional().or(z.literal("")),
  transition: z.string().max(100).optional().or(z.literal("")),
  directorNotes: z.string().max(2000).optional().or(z.literal("")),
});

/**
 * The temporal/compositional field set edited from the shot-design page. Like
 * storyboardShotSchema this drives a *partial* update, so fields absent here are
 * left untouched on the shot rather than being cleared.
 */
export const temporalShotSchema = z.object({
  composition: z.string().max(500).optional().or(z.literal("")),
  finalComposition: z.string().max(500).optional().or(z.literal("")),
  framing: z.string().max(200).optional().or(z.literal("")),
  initialFraming: z.string().max(200).optional().or(z.literal("")),
  finalFraming: z.string().max(200).optional().or(z.literal("")),
  cameraMovement: z.string().max(100).optional().or(z.literal("")),
  movementSpeed: z.string().max(100).optional().or(z.literal("")),
  cameraStartPosition: z.string().max(200).optional().or(z.literal("")),
  cameraEndPosition: z.string().max(200).optional().or(z.literal("")),
  subjectMovement: z.string().max(500).optional().or(z.literal("")),
  subjectStartPosition: z.string().max(200).optional().or(z.literal("")),
  subjectEndPosition: z.string().max(200).optional().or(z.literal("")),
  environmentalMovement: z.string().max(500).optional().or(z.literal("")),
  durationSeconds: z.coerce.number().min(0).max(3600).optional(),
});

export const assetUploadSchema = z.object({
  caption: z.string().max(300).optional().or(z.literal("")),
  type: z.enum(["IMAGE", "VIDEO", "DIAGRAM"]),
});

export const generateImageSchema = z.object({
  prompt: z.string().min(3, "Describe what you want to generate").max(1000),
  caption: z.string().max(300).optional().or(z.literal("")),
});

/**
 * The prompt actually submitted for a structured generation. Longer than
 * generateImageSchema's free-text limit because a compiled cinematic prompt
 * carries every field the filmmaker specified.
 *
 * Line endings are normalised to \n first. A multipart form body encodes every
 * newline as CRLF, so without this a multi-line prompt that nobody touched comes
 * back differing from the compiled text on all eight of its line breaks — which
 * would flag every video generation as hand-edited and record a prompt whose
 * bytes never matched what the compiler produced. CRLF is a transport artifact,
 * not a filmmaker's edit; normalising it here means the stored prompt, the
 * comparison and what the provider receives are all the same string.
 */
export const generationPromptSchema = z.object({
  prompt: z
    .string()
    .min(3, "The prompt is empty — fill in some shot details first")
    .max(6000)
    .transform((text) => text.replace(/\r\n/g, "\n")),
});

// --- Timeline / edit view ---------------------------------------------------
// These validate *placement* data only. There is deliberately no schema here
// that can write a ShotListItem field: the timeline never edits the shot.

export const sequenceSchema = z.object({
  name: z.string().min(1, "Name the edit").max(120),
  notes: z.string().max(2000).optional().or(z.literal("")),
});

export const clipTrimSchema = z
  .object({
    inPointSeconds: z.coerce.number().min(0).max(36000),
    outPointSeconds: z.coerce.number().min(0).max(36000).nullable(),
  })
  .refine(
    (t) => t.outPointSeconds === null || t.outPointSeconds > t.inPointSeconds,
    { message: "The out point must come after the in point", path: ["outPointSeconds"] }
  );

export const clipTransitionSchema = z.object({
  // null is "not specified" — a plain boundary. CUT is an explicit choice.
  transition: z
    .enum(["CUT", "DISSOLVE", "FADE", "MATCH_CUT", "J_CUT", "L_CUT"])
    .nullable(),
  durationSeconds: z.coerce.number().min(0).max(30).nullable(),
});

export const assetMediaInfoSchema = z.object({
  durationSeconds: z.coerce.number().positive().max(36000).optional(),
  width: z.coerce.number().int().positive().max(16384).optional(),
  height: z.coerce.number().int().positive().max(16384).optional(),
});
