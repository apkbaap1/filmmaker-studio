/**
 * The production export package.
 *
 * A faithful record of the filmmaking decisions, not a bag of flattened
 * prompts: another system reading this JSON should be able to reconstruct what
 * the filmmaker actually chose, which is why structured data, blocking, prompts,
 * generations, continuity and the edit are all present as themselves.
 *
 * Nothing in here is a secret. Provider *identifiers* (which adapter ran) are
 * included because they are part of the record; credentials are not, and never
 * pass through this module — they live only inside the server-only adapters.
 */
export interface ExportPackage {
  formatVersion: 1;
  generatedAt: string;
  /**
   * Honest statement of what produced the media in this package. See
   * `ProviderTransparency` — a stub is never presented as a real provider.
   */
  providerTransparency: ProviderTransparency;
  project: ExportProject;
  scenes: ExportScene[];
  timeline?: ExportTimeline;
  continuity: ExportContinuityFinding[];
}

export interface ProviderTransparency {
  imageProvider: { id: string; label: string; model: string; configured: boolean };
  videoProvider: { id: string; label: string; model: string; isStub: boolean } | null;
  /** Plain-language note carried into every export and shown in the UI. */
  note: string;
}

export interface ExportProject {
  id: string;
  title: string;
  logline: string | null;
  genre: string | null;
  format: string | null;
  status: string;
}

export interface ExportScene {
  id: string;
  number: string;
  slugline: string;
  intExt: string;
  location: string;
  timeOfDay: string;
  synopsis: string | null;
  characters: string[];
  shots: ExportShot[];
}

export interface ExportShot {
  id: string;
  shotNumber: string;
  /** Layer 1 — the filmmaker's structured choices, exactly as stored. */
  structuredData: Record<string, string | number | null>;
  /** Layer 1 — spatial staging, as stored. Null when the shot was never blocked. */
  blocking: unknown;
  /** Layers 2 and 3 — the spec and its renderings, recompiled at export time. */
  prompts: ExportPrompts;
  promptVersions: ExportPromptVersion[];
  generations: ExportGeneration[];
  storyboardAssetId: string | null;
  assets: ExportAsset[];
}

export interface ExportPrompts {
  /** Layer 2: the provider-independent specification. */
  spec: unknown;
  /** Layer 3: one rendering per mode, per available prompt adapter. */
  image: Record<string, string>;
  video: Record<string, string>;
  imageToVideo: Record<string, string>;
}

export interface ExportPromptVersion {
  version: number;
  mode: string;
  source: "COMPILED" | "EDITED";
  text: string;
  promptProviderId: string | null;
  sourceAssetId: string | null;
  label: string | null;
  createdAt: string;
}

export interface ExportGeneration {
  id: string;
  mode: string;
  source: string;
  status: string;
  /** The exact text sent to the provider. Historical: never rewritten. */
  promptUsed: string;
  promptEdited: boolean;
  providerId: string;
  promptProviderId: string | null;
  durationSeconds: number | null;
  error: string | null;
  assetId: string | null;
  sourceAssetId: string | null;
  createdAt: string;
}

export interface ExportAsset {
  id: string;
  type: string;
  source: string;
  mimeType: string;
  fileSize: number;
  caption: string | null;
  prompt: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** Which backend holds the object — local disk in development, S3 in production. */
  storageProvider: string;
  /**
   * The object's storage key. An opaque application-generated identifier, not a
   * URL and not a credential: it names the object for an operator reconciling
   * this bundle against a bucket, and confers no access on its own.
   */
  storageKey: string;
}

export interface ExportTimeline {
  sequenceName: string;
  /** The real runtime, with overlapping transitions removed. */
  totalSeconds: number;
  /** What the same clips would run with every boundary a straight cut. */
  straightCutSeconds: number;
  /** The difference: seconds played once instead of twice. */
  overlapSeconds: number;
  /**
   * How long the sequence runs once sound is counted. A music bed outlasting
   * the last shot, or an L-cut carrying sound past the final frame, makes the
   * mix longer than the cut — two separate facts, both reported.
   */
  runtime: {
    pictureSeconds: number;
    audioSeconds: number;
    totalSeconds: number;
  };
  audioTracks: ExportAudioTrack[];
  clips: Array<{
    shotId: string;
    shotNumber: string;
    order: number;
    inPointSeconds: number;
    outPointSeconds: number | null;
    usedSeconds: number;
    startSeconds: number;
    endSeconds: number;
    /** Null means no edit was specified — a plain boundary, not a cut chosen. */
    transition: string | null;
    /** The stated length. What it actually did is the two fields below. */
    transitionDurationSeconds: number | null;
    /** How long it ran, after the material on either side limited it. */
    transitionEffectiveSeconds: number | null;
    /** How much it shortened the edit. Non-zero only for a dissolve. */
    overlapSeconds: number;
    /** True when this edit silences the clip's own sound. */
    audioMuted: boolean;
    /**
     * Where the clip's own sound plays. A J- or L-cut moves this off the
     * picture range above; otherwise the two match.
     */
    audio: {
      startSeconds: number;
      endSeconds: number;
      offsetFromPicture: boolean;
      silent: boolean;
      silentReason: "muted" | "no-audio" | null;
    } | null;
    selectedAssetId: string | null;
  }>;
}

/**
 * A lane of sound under the edit: score, narration, effects, room tone.
 *
 * Sound that belongs to a shot is not here — it is in the clip's own `audio`
 * above, because it lives inside the video the shot plays.
 */
export interface ExportAudioTrack {
  id: string;
  name: string;
  role: string;
  muted: boolean;
  /** Null is unity: no level was stated. */
  gainDb: number | null;
  /** Null when nothing on the track has a known length. */
  endSeconds: number | null;
  clips: Array<{
    id: string;
    assetId: string;
    caption: string | null;
    startSeconds: number;
    /** Null when the file has never been decoded and no out point was stated. */
    endSeconds: number | null;
    usedSeconds: number | null;
    inPointSeconds: number;
    outPointSeconds: number | null;
    gainDb: number | null;
    fadeInSeconds: number | null;
    fadeOutSeconds: number | null;
    /** False when the length above is unknown rather than measured. */
    lengthMeasured: boolean;
    notes: string | null;
  }>;
}

export interface ExportContinuityFinding {
  key: string;
  category: string;
  severity: string;
  relation: string;
  shotA: string;
  shotB: string;
  subject: string | null;
  whatChanged: string;
  whyItMayMatter: string;
  decision: string | null;
}
