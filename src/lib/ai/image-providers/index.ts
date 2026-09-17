import type { ImageGenerationProvider } from "./types.ts";
import { openAiImageProvider } from "./openai.ts";

/**
 * Image-provider registry. Adding another platform means adding an adapter file
 * and one entry here; the compiler, the CinematicPromptSpec and the Shot model
 * stay untouched.
 */
const providers: Record<string, ImageGenerationProvider> = {
  [openAiImageProvider.id]: openAiImageProvider,
};

export const DEFAULT_IMAGE_PROVIDER_ID = openAiImageProvider.id;

export function getImageProvider(id: string = DEFAULT_IMAGE_PROVIDER_ID): ImageGenerationProvider {
  return providers[id] ?? openAiImageProvider;
}

export function listImageProviders(): ImageGenerationProvider[] {
  return Object.values(providers);
}

export type { GeneratedImage, ImageGenerationProvider, ImageGenerationRequest } from "./types.ts";
