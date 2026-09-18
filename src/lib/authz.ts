/**
 * Project-scoped write filters.
 *
 * `requireProjectAccess(projectId)` proves the caller may act on *that project*.
 * It says nothing about the id of the row they then asked to change. A write of
 * the shape
 *
 *     await requireProjectAccess(projectId, { write: true });
 *     await prisma.shotListItem.update({ where: { id: shotId }, data });
 *
 * therefore lets anyone with a project of their own edit a shot in someone
 * else's, because `shotId` is attacker-supplied and never checked against
 * `projectId`. The two halves of the authorization are simply never joined up.
 *
 * These filters join them, in the database, in the same statement:
 *
 *     await prisma.shotListItem.updateMany({
 *       where: { id: shotId, ...scopedTo.shot(projectId) },
 *       data,
 *     });
 *
 * A row belonging to another project matches nothing and the write affects
 * zero rows — there is no window between the check and the write, and no way to
 * get the pairing wrong by forgetting a second query.
 *
 * `updateMany` / `deleteMany` rather than `update` / `delete` is deliberate:
 * those take a full filter, not just a unique key, which is what lets the scope
 * travel with the write.
 */
export const scopedTo = {
  /** Owned directly by the project. */
  scene: (projectId: string) => ({ projectId }),
  scheduleDay: (projectId: string) => ({ projectId }),
  budgetCategory: (projectId: string) => ({ projectId }),
  equipment: (projectId: string) => ({ projectId }),
  location: (projectId: string) => ({ projectId }),
  castMember: (projectId: string) => ({ projectId }),
  crewMember: (projectId: string) => ({ projectId }),
  asset: (projectId: string) => ({ projectId }),
  generation: (projectId: string) => ({ projectId }),
  sequence: (projectId: string) => ({ projectId }),
  continuityDecision: (projectId: string) => ({ projectId }),

  /** Reached through a parent. */
  shot: (projectId: string) => ({ scene: { projectId } }),
  scheduleItem: (projectId: string) => ({ scheduleDay: { projectId } }),
  budgetLineItem: (projectId: string) => ({ category: { projectId } }),
  timelineClip: (projectId: string) => ({ sequence: { projectId } }),
  promptVersion: (projectId: string) => ({ shot: { scene: { projectId } } }),
} as const;

/**
 * What a scoped write returns when the row was not in this project.
 *
 * Deliberately the same message as a genuinely missing row: telling an attacker
 * "that exists, but not for you" confirms the id.
 */
export const NOT_FOUND = { error: "Not found" } as const;

/** True when a scoped write matched nothing — either missing or not theirs. */
export function missed(result: { count: number }): boolean {
  return result.count === 0;
}
