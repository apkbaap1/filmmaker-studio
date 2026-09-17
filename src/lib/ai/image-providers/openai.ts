import "server-only";

import {
  generateImage,
  isImageGenerationConfigured,
  OPENAI_IMAGE_MODEL,
} from "../openai-image.ts";
import type { ImageGenerationProvider } from "./types.ts";

/**
 * OpenAI gpt-image-1, wrapping the free-text generator that the existing
 * "Generate with AI" button already uses. The HTTP call, and therefore
 * OPENAI_API_KEY, stays in that one module — this adapter adds the registry
 * shape around it rather than a second code path to keep in sync.
 */
export const openAiImageProvider: ImageGenerationProvider = {
  id: "openai-gpt-image-1",
  label: "OpenAI gpt-image-1",
  model: OPENAI_IMAGE_MODEL,
  isConfigured: isImageGenerationConfigured,
  async generate({ prompt, size }) {
    return { data: await generateImage(prompt, { size }), mimeType: "image/png" };
  },
};
