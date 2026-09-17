import "server-only";

import { prisma } from "@/lib/prisma";
import { deriveBlockingContext } from "@/lib/blocking";
import { buildShotContext, generateImagePrompt, DEFAULT_PROVIDER_ID } from "@/lib/prompt";
import type { CompiledPrompt } from "@/lib/prompt";

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

export async function compileShotImagePrompt(
  projectId: string,
  sceneId: string,
  shotId: string,
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
    compiled: generateImagePrompt(
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
