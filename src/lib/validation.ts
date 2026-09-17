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
  pageEights: z.coerce.number().min(0).max(500),
});

export const shotSchema = z.object({
  shotNumber: z.string().min(1).max(20),
  shotType: z.string().min(1).max(100),
  description: z.string().max(2000).optional().or(z.literal("")),
  cameraMovement: z.string().max(100).optional().or(z.literal("")),
  lens: z.string().max(100).optional().or(z.literal("")),
  equipmentNotes: z.string().max(500).optional().or(z.literal("")),
  status: z.enum(["PLANNED", "SHOT", "CUT"]),
  cameraAngle: z
    .enum(["EYE_LEVEL", "LOW_ANGLE", "HIGH_ANGLE", "DUTCH_ANGLE", "BIRDS_EYE", "WORMS_EYE", "OVER_THE_SHOULDER", "POV"])
    .optional()
    .or(z.literal("")),
  lightingNotes: z.string().max(1000).optional().or(z.literal("")),
  soundDesignNotes: z.string().max(1000).optional().or(z.literal("")),
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

export const assetUploadSchema = z.object({
  caption: z.string().max(300).optional().or(z.literal("")),
  type: z.enum(["IMAGE", "VIDEO", "DIAGRAM"]),
});

export const generateImageSchema = z.object({
  prompt: z.string().min(3, "Describe what you want to generate").max(1000),
  caption: z.string().max(300).optional().or(z.literal("")),
});
