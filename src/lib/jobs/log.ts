/**
 * Structured job logging.
 *
 * Enough to diagnose a failed generation — which job, whose project, which
 * shot, which provider, which attempt, which provider job id — and deliberately
 * nothing more. The fields are an allow-list rather than a spread of the row,
 * so a column added later cannot start leaking into the logs by accident.
 *
 * Never logged: API keys, authorization headers, signed URLs, prompts (they are
 * the filmmaker's work and belong in the database, not in an operator's
 * console), or provider responses.
 */

export interface JobLogSubject {
  id: string;
  projectId: string;
  shotId: string | null;
  mode: string;
  status: string;
  providerId: string;
  attempts: number;
}

export type JobEvent =
  | "claimed"
  | "submitted"
  | "completed"
  | "failed"
  | "retry-scheduled"
  | "lease-lost"
  | "reaped"
  /**
   * The spend ledger could not be written for a call that already happened.
   * Never fatal — see `recordSpend` in runner.ts — but it means the ledger now
   * understates real spend, so it is worth finding in the logs.
   */
  | "usage-record-failed";

const REDACT = /(key|secret|token|authorization|password|signature|url)/i;

export function jobLog(
  event: JobEvent,
  subject: JobLogSubject,
  extra: Record<string, string | number | null | undefined> = {}
): void {
  const safeExtra = Object.fromEntries(
    Object.entries(extra)
      .filter(([, v]) => v !== undefined && v !== null)
      // `storageKey` is a location, not a credential, but anything else matching
      // is refused rather than reasoned about.
      .filter(([k]) => k === "storageKey" || !REDACT.test(k))
  );

  const line = {
    at: new Date().toISOString(),
    event,
    generationId: subject.id,
    projectId: subject.projectId,
    shotId: subject.shotId,
    mode: subject.mode,
    provider: subject.providerId,
    attempt: subject.attempts,
    ...safeExtra,
  };

  // One JSON object per line: greppable by hand, parseable by a log shipper.
  console.log(JSON.stringify(line));
}
