/**
 * Prompt Compiler Engine — public API.
 *
 *   Structured Scene/Shot/Character data   (single source of truth)
 *            ↓  buildShotContext
 *   ShotVisualizationContext
 *            ↓  compileSpec
 *   CinematicPromptSpec                    (provider-independent IR)
 *            ↓  provider adapter
 *   Prompt text                            (editable; nothing re-derives from it)
 *
 * Deterministic and dependency-free: no database access, no network, no LLM.
 * Values the filmmaker selected are carried through verbatim; values they left
 * blank never appear.
 */
import { compileSpec } from "./compiler.ts";
import { buildShotContext } from "./context.ts";
import { DEFAULT_PROVIDER_ID, getProvider } from "./providers/index.ts";
import type {
  CompiledPrompt,
  PromptMode,
  ShotVisualizationContext,
} from "./types.ts";

export interface CompileOptions {
  /** Which provider adapter formats the output. Defaults to the generic adapter. */
  providerId?: string;
}

function compile(
  context: ShotVisualizationContext,
  mode: PromptMode,
  options: CompileOptions = {}
): CompiledPrompt {
  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
  const provider = getProvider(providerId);
  const spec = compileSpec(context, mode);

  const text =
    mode === "image"
      ? provider.formatImagePrompt(spec)
      : mode === "video"
        ? provider.formatVideoPrompt(spec)
        : mode === "image-to-video"
          ? provider.formatImageToVideoPrompt(spec)
          : provider.formatStoryboardPrompt(spec);

  return { mode, providerId: provider.id, spec, text };
}

export function generateImagePrompt(
  context: ShotVisualizationContext,
  options?: CompileOptions
): CompiledPrompt {
  return compile(context, "image", options);
}

export function generateVideoPrompt(
  context: ShotVisualizationContext,
  options?: CompileOptions
): CompiledPrompt {
  return compile(context, "video", options);
}

export function generateImageToVideoPrompt(
  context: ShotVisualizationContext,
  options?: CompileOptions
): CompiledPrompt {
  return compile(context, "image-to-video", options);
}

export function generateStoryboardPrompt(
  context: ShotVisualizationContext,
  options?: CompileOptions
): CompiledPrompt {
  return compile(context, "storyboard", options);
}

export { buildShotContext, compileSpec };
export { DEFAULT_PROVIDER_ID, getProvider, listProviders } from "./providers/index.ts";
export type {
  BlockingContext,
  CharacterInput,
  CinematicPromptSpec,
  CompiledPrompt,
  Maybe,
  PromptMode,
  SceneInput,
  ShotInput,
  ShotVisualizationContext,
  Specified,
} from "./types.ts";
export type { PromptProvider } from "./providers/types.ts";
