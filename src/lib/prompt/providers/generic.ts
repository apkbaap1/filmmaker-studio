import type { PromptProvider } from "./types.ts";
import {
  renderImagePrompt,
  renderImageToVideoPrompt,
  renderStoryboardPrompt,
  renderVideoPrompt,
} from "../render.ts";

/**
 * Default adapter: emits the compiler's neutral rendering unchanged. Any
 * platform that accepts free-form cinematic prose works with this.
 */
export const genericProvider: PromptProvider = {
  id: "generic",
  label: "Generic image/video AI",
  constraints: { supportsImageToVideo: true },
  formatImagePrompt: renderImagePrompt,
  formatVideoPrompt: renderVideoPrompt,
  formatImageToVideoPrompt: renderImageToVideoPrompt,
  formatStoryboardPrompt: renderStoryboardPrompt,
};
