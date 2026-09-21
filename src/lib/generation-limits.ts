import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Cost protection for paid generation.
 *
 * Workstream 11.4 is the first time this application can spend real money, and a
 * generation endpoint with no ceiling is an unbounded bill waiting for the first
 * enthusiastic user or the first loop in a script. These are **hard limits**,
 * checked server-side before a job is queued.
 *
 * This is deliberately not billing, and not quota accounting — 11.7 owns that.
 * It is a blunt stop so that nothing between here and there can run away. The
 * limits count *attempts*, not successes: a failed generation still cost a
 * provider call, and counting only successes would let a pathological retry loop
 * spend freely.
 *
 * Every limit is configurable, and every one has a finite default. There is no
 * "unlimited" setting on purpose: an operator who wants one can set a very large
 * number, and will have had to think about it.
 */

export interface GenerationLimits {
  /** Paid generations one user may start in the rolling window, across all projects. */
  perUserPerWindow: number;
  /** Paid generations one project may accumulate in the rolling window. */
  perProjectPerWindow: number;
  /** Paid generations one project may hold in flight at once. */
  concurrentPerProject: number;
  /** Images a single request may ask for. */
  perRequest: number;
  windowHours: number;
}

const DEFAULTS: GenerationLimits = {
  perUserPerWindow: 50,
  perProjectPerWindow: 200,
  concurrentPerProject: 5,
  perRequest: 1,
  windowHours: 24,
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function generationLimits(): GenerationLimits {
  return {
    perUserPerWindow: positiveInt(process.env.GENERATION_LIMIT_PER_USER, DEFAULTS.perUserPerWindow),
    perProjectPerWindow: positiveInt(
      process.env.GENERATION_LIMIT_PER_PROJECT,
      DEFAULTS.perProjectPerWindow
    ),
    concurrentPerProject: positiveInt(
      process.env.GENERATION_LIMIT_CONCURRENT,
      DEFAULTS.concurrentPerProject
    ),
    perRequest: positiveInt(process.env.GENERATION_LIMIT_PER_REQUEST, DEFAULTS.perRequest),
    windowHours: positiveInt(process.env.GENERATION_LIMIT_WINDOW_HOURS, DEFAULTS.windowHours),
  };
}

export type LimitCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether one more paid generation may be started.
 *
 * `providerKind` is what makes this proportionate: a local stub costs nothing,
 * so throttling it would only get in the filmmaker's way during development.
 * Only `real` generations are counted and capped.
 */
export async function checkGenerationAllowed(options: {
  projectId: string;
  userId: string;
  providerKind: "real" | "stub";
  count?: number;
  now?: Date;
}): Promise<LimitCheck> {
  if (options.providerKind === "stub") return { ok: true };

  const limits = generationLimits();
  const count = options.count ?? 1;
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - limits.windowHours * 3_600_000);

  if (count > limits.perRequest) {
    return {
      ok: false,
      reason: `One request may start at most ${limits.perRequest} generation${limits.perRequest === 1 ? "" : "s"}.`,
    };
  }

  // In flight first: it is the cheapest query and the most urgent condition —
  // it is what stops a double-click or a retry loop from fanning out.
  const inFlight = await prisma.generation.count({
    where: {
      projectId: options.projectId,
      status: { in: ["QUEUED", "PROCESSING", "AWAITING_PROVIDER"] },
    },
  });
  if (inFlight + count > limits.concurrentPerProject) {
    return {
      ok: false,
      reason: `This project already has ${inFlight} generation${inFlight === 1 ? "" : "s"} in progress; the limit is ${limits.concurrentPerProject} at once. Wait for one to finish.`,
    };
  }

  const projectWindow = await prisma.generation.count({
    where: { projectId: options.projectId, createdAt: { gte: since } },
  });
  if (projectWindow + count > limits.perProjectPerWindow) {
    return {
      ok: false,
      reason: `This project has started ${projectWindow} generations in the last ${limits.windowHours}h; the limit is ${limits.perProjectPerWindow}.`,
    };
  }

  // Per user, across every project — otherwise the project cap is trivially
  // sidestepped by making more projects.
  //
  // Counted by who actually started each generation. This used to be
  // approximated by counting every generation in every project the user could
  // reach, which charged a collaborator's work against their ceiling: on a
  // shared project, one busy editor could lock everyone else out without any of
  // them having generated anything. Generation.createdById, added in 11.7 for
  // spend attribution, makes the real count available.
  //
  // Rows from before that column existed have a null creator and so fall out of
  // this count. That is the right way round: the alternative is charging an
  // unknown person's spend to a known one, and the window is rolling, so those
  // rows age out on their own.
  const userWindow = await prisma.generation.count({
    where: { createdAt: { gte: since }, createdById: options.userId },
  });
  if (userWindow + count > limits.perUserPerWindow) {
    return {
      ok: false,
      reason: `You have started ${userWindow} generations in the last ${limits.windowHours}h; the limit is ${limits.perUserPerWindow}.`,
    };
  }

  return { ok: true };
}
