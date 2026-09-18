import type { ImageGenerationProvider } from "./types.ts";
import { openAiImageProvider } from "./openai.ts";
import { localStubImageProvider } from "./local-stub.ts";

/**
 * Image-provider registry. Adding another platform means adding an adapter file
 * and one entry here; the compiler, the CinematicPromptSpec and the Shot model
 * stay untouched.
 *
 * The local stub is registered but never the default: it is selected only by an
 * explicit IMAGE_PROVIDER=local-stub, so nothing can silently substitute a
 * placeholder for a real render and report it as generation.
 */
const providers: Record<string, ImageGenerationProvider> = {
  [openAiImageProvider.id]: openAiImageProvider,
  [localStubImageProvider.id]: localStubImageProvider,
};

export const DEFAULT_IMAGE_PROVIDER_ID = openAiImageProvider.id;

/**
 * Which adapter new image generations are queued against.
 *
 * Falls back to OpenAI, so an unset environment behaves exactly as it did
 * before the stub existed.
 */
export function configuredImageProviderId(): string {
  const requested = process.env.IMAGE_PROVIDER?.trim();
  if (requested && providers[requested]) return requested;
  return DEFAULT_IMAGE_PROVIDER_ID;
}

export function getImageProvider(id: string = DEFAULT_IMAGE_PROVIDER_ID): ImageGenerationProvider {
  return providers[id] ?? openAiImageProvider;
}

export function listImageProviders(): ImageGenerationProvider[] {
  return Object.values(providers);
}

export { localStubImageProvider } from "./local-stub.ts";
export type { GeneratedImage, ImageGenerationProvider, ImageGenerationRequest } from "./types.ts";
