/**
 * Shapes passed from the timeline page to its client components.
 *
 * Note what a clip carries: a `shotId`, not a shot. Shot data is sent once in a
 * separate map and looked up, which mirrors the data model — a timeline clip
 * *references* a shot, it does not contain one. Two clips of the same shot
 * therefore read the same record, and there is nothing to keep in sync.
 */
import type { TransitionKind } from "@/lib/timeline";

/**
 * Aliased rather than re-declared: the set of edit points and what each one does
 * to the ruler are the same fact, and lib/timeline owns it.
 */
export type TransitionValue = TransitionKind;

export interface AssetRef {
  id: string;
  mimeType: string;
  caption: string | null;
  prompt: string | null;
  source: "UPLOADED" | "GENERATED";
  type: "IMAGE" | "VIDEO" | "DIAGRAM" | "AUDIO";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface ShotRef {
  id: string;
  sceneId: string;
  shotNumber: string;
  shotType: string;
  cameraAngle: string | null;
  cameraHeight: string | null;
  cameraMovement: string | null;
  movementSpeed: string | null;
  lens: string | null;
  focalLength: string | null;
  /** The shot's intended duration. The timeline reads this and never writes it. */
  durationSeconds: number | null;
  /** Free-text edit intent from the Shot Builder — a suggestion, never applied automatically. */
  transitionNote: string | null;
  editPoint: string | null;
  directorNotes: string | null;
  assets: AssetRef[];
  /** The shot's storyboard frame: its newest image, generated or uploaded. */
  storyboardAssetId: string | null;
  generations: { total: number; completed: number; processing: number; failed: number };
}

export interface SceneRef {
  id: string;
  number: string;
  slugline: string;
}

export interface ClipRef {
  id: string;
  shotId: string;
  order: number;
  inPointSeconds: number;
  outPointSeconds: number | null;
  transition: TransitionValue | null;
  transitionDurationSeconds: number | null;
  /** True when this edit plays the clip's own sound silent. */
  audioMuted: boolean;
  selectedAssetId: string | null;
  notes: string | null;
}

export type AudioRoleValue = "DIALOGUE" | "MUSIC" | "SFX" | "AMBIENCE";

/**
 * A placement of an audio asset on a track.
 *
 * Carries `startSeconds` because sound is positioned against the picture rather
 * than queued behind the previous sound. Like a picture clip it references its
 * asset rather than containing it.
 */
export interface AudioClipRef {
  id: string;
  assetId: string;
  startSeconds: number;
  inPointSeconds: number;
  outPointSeconds: number | null;
  gainDb: number | null;
  fadeInSeconds: number | null;
  fadeOutSeconds: number | null;
  notes: string | null;
}

export interface AudioTrackRef {
  id: string;
  name: string;
  role: AudioRoleValue;
  order: number;
  muted: boolean;
  /** Null is unity — no level stated, which is not the same as 0 dB chosen. */
  gainDb: number | null;
  clips: AudioClipRef[];
}

export interface SequenceRef {
  id: string;
  name: string;
  notes: string | null;
}
