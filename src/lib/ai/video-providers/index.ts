import type { VideoGenerationProvider } from "./types.ts";
import { localStubVideoProvider } from "./local-stub.ts";
import { googleVeoVideoProvider } from "./google-veo.ts";

/**
 * Video-provider registry.
 *
 * Two entries, and the difference between them is the one that matters:
 *
 *   local-stub   produces a labelled placeholder clip locally. Never evidence
 *                of AI generation, and never billed.
 *   google-veo   calls Google's Veo 3.1 and is billed per render.
 *
 * Both are opt-in through VIDEO_PROVIDER, and neither is a fallback for the
 * other: `getVideoProvider` throws on an unknown id rather than substituting,
 * because a silent substitution would misattribute output. With nothing set,
 * `videoGenerationAvailable()` is false and the UI says so rather than
 * pretending a clip could be produced.
 *
 * Adding a provider means writing an adapter against VideoGenerationProvider
 * and registering it below; the compiler, the CinematicPromptSpec and the Shot
 * model do not change.
 */
const providers: Record<string, VideoGenerationProvider> = {
  [localStubVideoProvider.id]: localStubVideoProvider,
  [googleVeoVideoProvider.id]: googleVeoVideoProvider,
};

export function configuredVideoProviderId(): string | undefined {
  const requested = process.env.VIDEO_PROVIDER?.trim();
  if (!requested) return undefined;
  const provider = providers[requested];
  return provider?.isConfigured() ? provider.id : undefined;
}

export function videoGenerationAvailable(): boolean {
  return configuredVideoProviderId() !== undefined;
}

/** Throws rather than falling back: a silent substitution would misattribute output. */
export function getVideoProvider(id: string): VideoGenerationProvider {
  const provider = providers[id];
  if (!provider) throw new Error(`No video provider registered with id "${id}"`);
  return provider;
}

export function listVideoProviders(): VideoGenerationProvider[] {
  return Object.values(providers);
}

/** The video counterpart of `describeImageProvider`. Same cautious default. */
export function describeVideoProvider(providerId: string): {
  label: string;
  kind: "real" | "stub";
  model: string | null;
} {
  const provider = providers[providerId];
  if (!provider) return { label: providerId, kind: "real", model: null };
  return { label: provider.label, kind: provider.capabilities.kind, model: provider.model };
}

export { localStubVideoProvider, googleVeoVideoProvider };
export type {
  VideoGenerationMode,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
} from "./types.ts";
