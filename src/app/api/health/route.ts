import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * Liveness and readiness, for whatever is deciding whether to send traffic here.
 *
 * ## Why it touches the database
 *
 * A process that is up but cannot reach Postgres serves an error to every
 * request that matters. A health check that only proved the event loop was
 * turning would keep such a container in the load balancer's rotation, which is
 * the failure mode this exists to prevent. So it runs the cheapest possible
 * query and reports the result.
 *
 * ## Why it says almost nothing
 *
 * This endpoint is public — a load balancer has no session and must not need
 * one. So it returns a status and a duration and nothing else: no version, no
 * hostname, no database name, no error text. An unauthenticated endpoint that
 * described the failure would be describing the infrastructure to whoever
 * asked. The operator reads the real reason in the logs, where it belongs.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    // `SELECT 1` rather than a model query: it needs no table, so it keeps
    // working during a migration and cannot be broken by a schema change.
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    // Logged in full, reported as one word. The two audiences are different:
    // the operator needs the cause, the caller needs a number.
    console.error("[health] database unreachable", error);
    return NextResponse.json(
      { status: "unhealthy" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    { status: "ok", databaseMs: Date.now() - startedAt },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}
