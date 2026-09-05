// EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1 — one shared, reversible
// fail-fast guard for recurring/high-frequency PREMVP background jobs that
// hit production Supabase (signal-cache, event-rebalance, signal-resolve,
// night-event-reservations).
//
// Activation is a single env var, off by default: setting
// EMERGENCY_QUIESCE=1 makes every guarded entrypoint return/exit
// IMMEDIATELY, before any Supabase client call, provider fetch, scoring, or
// reservation/rebalance work -- and before any retry loop can start. This is
// incident containment only: it does not change Contract A, Reservation,
// Rebalance, or model logic, and it does not touch customer-facing routes.
//
// Removing the env var (or setting it to anything else) restores normal
// behavior with zero code changes -- this file is the entire kill switch.

export const EMERGENCY_QUIESCE_RESULT = "EMERGENCY_QUIESCED" as const;

/** True only when EMERGENCY_QUIESCE is explicitly set to "1". Fail-open by
 * default (unset/any other value never quiesces) so this can never silently
 * activate. */
export function isEmergencyQuiesceActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMERGENCY_QUIESCE === "1";
}

/** Standard shape every guarded job/route reports when quiesced, so a
 * scheduler or dashboard sees one deterministic, successful outcome instead
 * of a failure it might retry. */
export function buildEmergencyQuiesceResult(source: string): {
  ok: true;
  result: typeof EMERGENCY_QUIESCE_RESULT;
  source: string;
  generated_at_iso: string;
} {
  return {
    ok: true,
    result: EMERGENCY_QUIESCE_RESULT,
    source,
    generated_at_iso: new Date().toISOString(),
  };
}
