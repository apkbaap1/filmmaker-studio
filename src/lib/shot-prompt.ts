import "server-only";

import { prisma } from "@/lib/prisma";
import { deriveBlockingContext } from "@/lib/blocking";
import {
  buildShotContext,
  generateImagePrompt,
  generateImageToVideoPrompt,
  generateStoryboardPrompt,
  generateVideoPrompt,
  DEFAULT_PROVIDER_ID,
} from "@/lib/prompt";
import type { CompiledPrompt, PromptMode } from "@/lib/prompt";

/**
 * The bridge between the database and the pure prompt compiler.
 *
 * The compiler itself never reads Prisma — this is the only place a stored Shot
 * is turned into a ShotVisualizationContext, so there is exactly one definition
 * of "the prompt for this shot" and the Shot record stays the single source of
 * truth for it.
 */
export interface ResolvedShotPrompt {
  compiled: CompiledPrompt;
  sceneId: string;
  projectId: string;
}

const RENDERERS = {
  image: generateImagePrompt,
  video: generateVideoPrompt,
  "image-to-video": generateImageToVideoPrompt,
  storyboard: generateStoryboardPrompt,
} as const;

/**
 * Compiles one shot into one mode's prompt. Every mode goes through the same
 * compileSpec — the video and image-to-video prompts are different projections
 * of the same CinematicPromptSpec, never an image prompt with motion words
 * appended.
 */
export async function compileShotPrompt(
  projectId: string,
  sceneId: string,
  shotId: string,
  mode: PromptMode,
  promptProviderId: string = DEFAULT_PROVIDER_ID
): Promise<ResolvedShotPrompt | undefined> {
  const shot = await prisma.shotListItem.findFirst({
    where: { id: shotId, sceneId },
    include: { scene: { include: { characters: { orderBy: { characterName: "asc" } } } } },
  });
  if (!shot || shot.scene.projectId !== projectId) return undefined;

  const subjectLabel = shot.scene.characters[0]?.characterName ?? "Subject";

  return {
    projectId,
    sceneId,
    compiled: RENDERERS[mode](
      buildShotContext(
        shot,
        shot.scene,
        shot.scene.characters,
        deriveBlockingContext(shot.blocking, subjectLabel)
      ),
      { providerId: promptProviderId }
    ),
  };
}

/** Phase 5 entry point, kept so the image path reads the same as before. */
export async function compileShotImagePrompt(
  projectId: string,
  sceneId: string,
  shotId: string,
  promptProviderId: string = DEFAULT_PROVIDER_ID
): Promise<ResolvedShotPrompt | undefined> {
  return compileShotPrompt(projectId, sceneId, shotId, "image", promptProviderId);
}
