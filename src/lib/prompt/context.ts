import type {
  CharacterInput,
  SceneInput,
  ShotInput,
  ShotVisualizationContext,
} from "./types.ts";

/**
 * Resolves a shot together with the scene and characters that give it meaning.
 * This is the "visualization state" layer: everything the compiler is allowed
 * to see, and nothing more.
 */
export function buildShotContext(
  shot: ShotInput,
  scene?: SceneInput,
  characters: CharacterInput[] = []
): ShotVisualizationContext {
  return { shot, scene, characters };
}
