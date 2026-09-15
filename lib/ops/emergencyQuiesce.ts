// EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1 — reversible fail-fast guard
// for recurring/high-frequency PREMVP jobs that hit production Supabase
// (signal-cache [source "generate-signals"], signal-resolve [source
// "resolve-signals"], event-rebalance [source "cron/event-rebalance"],
// night-event-reservations [source "cron/night-event-reservations"], and
// research-clone-sync [source "research-clone-sync"]).
//
// Two activation modes, in priority order:
//
//   1. EMERGENCY_QUIESCE=1 (global, unchanged from the original kill switch):
//      every guarded entrypoint quiesces, regardless of source. This is the
//      broadest, least selective option and MUST NOT be relied on for a
//      money-path-preserving quiesce -- Reservation and Rebalance are
//      guarded entrypoints too, so this mode disables them along with
//      everything else.
//
//   2. EMERGENCY_QUIESCE_SCOPES=<comma-separated source list> (selective):
//      only the guarded entrypoints whose exact source string appears in the
//      list quiesce; every other guarded entrypoint is completely
//      unaffected, including if this variable is accidentally set at a
//      Railway project/shared level. This is the STABILIZE_PRODUCTION_DB_BY_
//      SELECTIVE_QUIESCE_V1 primitive: e.g.
//      EMERGENCY_QUIESCE_SCOPES=generate-signals,research-clone-sync
//      quiesces only signal-cache-cron and research-clone-daily-sync while
//      leaving cron/event-rebalance and cron/night-event-reservations (and
//      resolve-signals) fully active.
//
// Either mode makes the guarded entrypoint return/exit IMMEDIATELY, before
// any Supabase client call, provider fetch, scoring, or reservation/
// rebalance work -- and before any retry loop can start. This is incident
// containment only: it does not change Contract A, Reservation, Rebalance,
// or model logic, and it does not touch customer-facing routes.
//
// Removing/clearing both env vars restores normal behavior with zero code
// changes -- this file is the entire kill switch.

export const EMERGENCY_QUIESCE_RESULT = "EMERGENCY_QUIESCED" as const;

/** Parses EMERGENCY_QUIESCE_SCOPES into a set of exact source strings. Empty/unset -> empty set. */
export function parseQuiesceScopes(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.EMERGENCY_QUIESCE_SCOPES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * True when this exact `source` should quiesce: either the global
 * EMERGENCY_QUIESCE=1 kill switch is set, or `source` is explicitly named in
 * EMERGENCY_QUIESCE_SCOPES. Fail-open by default (both unset/any other
 * value never quiesces anything) so this can never silently activate.
 */
export function isEmergencyQuiesceActive(source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.EMERGENCY_QUIESCE === "1") return true;
  return parseQuiesceScopes(env).has(source);
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
