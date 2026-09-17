import type { VideoGenerationProvider } from "./types.ts";
import { localStubVideoProvider } from "./local-stub.ts";

/**
 * Video-provider registry.
 *
 * No real video platform is integrated yet — no provider has been chosen for
 * this project and no credentials exist, so nothing here claims to drive
 * Seedance, Veo, Higgsfield, Runway or anything else. Adding one means writing
 * an adapter against VideoGenerationProvider and registering it below; the
 * compiler, the CinematicPromptSpec and the Shot model do not change.
 *
 * Until then the only entry is the local stub, and it is opt-in: set
 * VIDEO_PROVIDER=local-stub to exercise the pipeline. With nothing set,
 * `videoGenerationAvailable()` is false and the UI says so rather than
 * pretending a clip could be produced.
 */
const providers: Record<string, VideoGenerationProvider> = {
  [localStubVideoProvider.id]: localStubVideoProvider,
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

export { localStubVideoProvider };
export type {
  VideoGenerationMode,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoJobHandle,
  VideoJobResult,
} from "./types.ts";
