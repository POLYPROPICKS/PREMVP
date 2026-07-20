// lib/executor/schedulerJobEvidence.ts
//
// Shared job_runs evidence port for the reservation and rebalance cron
// executions. Reuses the existing job_runs schema and writer
// (lib/feed/cacheGeneratedSignals.ts writeJobRun) — no new table, no
// migration. A job_runs write failure is non-fatal: it never fails the
// underlying business cron (matches the existing filesystem-diagnostics
// non-fatal pattern in nightEventReservations.ts / eventExecutionQueue.ts).
//
// source values: "night-event-reservations" / "event-rebalance" — mirrors the
// precedent already established in scripts/resolve-signals.ts, which uses
// source="resolver" + formula_version="resolver-v1" as a stable constant for
// a job that has no signal formula.

export interface SchedulerJobRunInput {
  source: string;
  formulaVersion: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "empty" | "error";
  generatedCount: number;
  rejectedCount: number;
  durationMs: number;
  errorMessage?: string;
  diagnostics?: Record<string, unknown>;
}

export interface SchedulerJobEvidencePort {
  writeJobRun(input: SchedulerJobRunInput): Promise<void>;
}

// Redacts query-string-shaped secrets (key=/token=/secret=/password=/apikey=)
// from an error message before it is persisted, and caps length. Errors
// surfaced here are thrown Error#message strings from Supabase read/write
// helpers — never raw request/response payloads.
const SECRET_PATTERN = /([?&](?:key|token|secret|password|apikey)=)[^&\s]+/gi;

export function sanitizeSchedulerErrorMessage(raw: string): string {
  return raw.replace(SECRET_PATTERN, "$1[redacted]").slice(0, 500);
}

let cachedRealPort: SchedulerJobEvidencePort | null = null;

/** Real Supabase-backed job evidence port. Lazily constructed; safe to call repeatedly. */
export function createSupabaseSchedulerJobEvidencePort(): SchedulerJobEvidencePort {
  if (cachedRealPort) return cachedRealPort;
  cachedRealPort = {
    async writeJobRun(input) {
      try {
        const { writeJobRun } = await import("../feed/cacheGeneratedSignals");
        await writeJobRun(input);
      } catch (err) {
        console.warn(
          "[schedulerJobEvidence] job_runs write failed (non-fatal):",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
  };
  return cachedRealPort;
}
