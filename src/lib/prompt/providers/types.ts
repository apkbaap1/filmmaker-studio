import type { CinematicPromptSpec } from "../types.ts";

/**
 * A provider adapter turns the provider-independent CinematicPromptSpec into
 * the prompt format one generation platform expects.
 *
 * Adapters consume the spec, never the raw shot record — so the filmmaking data
 * model stays free of any provider coupling, and adding Seedance/Veo/Higgsfield
 * later means adding a file here and nothing else.
 */
export interface PromptProvider {
  id: string;
  label: string;
  /** Surfaced to callers (and, later, the Prompt Studio) so they can warn before submitting. */
  constraints?: {
    maxChars?: number;
    supportsImageToVideo?: boolean;
  };
  formatImagePrompt(spec: CinematicPromptSpec): string;
  formatVideoPrompt(spec: CinematicPromptSpec): string;
  formatImageToVideoPrompt(spec: CinematicPromptSpec): string;
  formatStoryboardPrompt(spec: CinematicPromptSpec): string;
}
