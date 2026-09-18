import "server-only";

/**
 * Kept as the import path the older free-text "Generate with AI" button uses.
 *
 * The implementation moved to `image-providers/openai.ts` in Workstream 11.4, so
 * that everything provider-specific — endpoint, credential, request shape,
 * response validation, error classification — lives in one adapter rather than
 * being duplicated between the free-text path and the structured one.
 */
export {
  OPENAI_IMAGE_MODEL,
  generateImage,
  isImageGenerationConfigured,
} from "./image-providers/openai.ts";
export type { GenerateImageOptions } from "./image-providers/openai.ts";
