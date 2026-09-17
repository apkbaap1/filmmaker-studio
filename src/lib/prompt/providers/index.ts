import type { PromptProvider } from "./types.ts";
import { genericProvider } from "./generic.ts";

/**
 * Provider registry. Adding Seedance / Veo / Higgsfield / Runway later means
 * adding an adapter file and one entry here — the compiler, the IR and the
 * filmmaking data model stay untouched.
 */
const providers: Record<string, PromptProvider> = {
  [genericProvider.id]: genericProvider,
};

export const DEFAULT_PROVIDER_ID = genericProvider.id;

export function getProvider(id: string = DEFAULT_PROVIDER_ID): PromptProvider {
  return providers[id] ?? genericProvider;
}

export function listProviders(): PromptProvider[] {
  return Object.values(providers);
}

export type { PromptProvider };
