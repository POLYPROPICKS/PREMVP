/**
 * REFRESH_LIVE_MODELING_DASHBOARD_V1 — Git-owned READ-ONLY production runtime
 * refresh for the SAME Sep21 dashboard's LIVE panel. This is a LIVE-READOUT
 * mission script, not a modeling/search mission: it aggregates the current
 * production funnel (Reservation -> Queue -> Execution -> Order -> Filled ->
 * Settled) for the current Minsk plan date, and never infers realized P&L
 * from potential payout.
 *
 * HARD SAFETY (same posture as scripts/contur3/lib/contur3LiveFunnelMonitor.mjs):
 *   - SELECT / count-only reads. Never writes a production DB row.
 *   - Fails closed (STOPPED_PRODUCTION_ENV_MISSING) rather than silently
 *     falling back to any other project when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *     are absent, or when the resolved project ref does not match the known
 *     production project.
 *   - Never counts an unsettled/pending order as realized P&L. If no
 *     authoritative settlement source is populated, the settled/realized
 *     fields are explicitly PENDING / NOT SETTLED, never a computed guess.
 *
 * Tables read (production, read-only):
 *   night_event_reservations, event_execution_queue, executor_order_events
 *   Settlement (only if populated): bet_execution_ledger
 *
 * Output: modeling/evidence/modeling-dashboard-v1/LIVE_RUNTIME_DATA.js
 * (window.POLYPROPICKS_LIVE_RUNTIME_DATA), loaded by MODELING_DASHBOARD.html
 * beside MODELING_DAILY_DATA.js. Aggregate counts only -- no raw rows.
 *
 * Usage:
 *   npx tsx scripts/modeling/refresh-live-modeling-dashboard.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import "dotenv/config";

const DATA_FILE = "modeling/evidence/modeling-dashboard-v1/LIVE_RUNTIME_DATA.js";
// Production project ref this script is allowed to target. Distinct from the
// research-clone ref (nppznoujvnyjargjkmnv) used by scripts/modeling/*-portfolio-test.ts
// and scripts/modeling/refresh-modeling-dashboard.ts -- this script never touches the clone.
const EXPECTED_PRODUCTION_PROJECT_REF = process.env.PRODUCTION_SUPABASE_PROJECT_REF ?? null;

function minskDateNow(): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Minsk", year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  }
}

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the known production project (or, absent a pinned ref, at least a resolvable non-clone project) -- never guesses, never silently substitutes the research clone. */
async function resolveProductionDb(): Promise<{ db: SupabaseClient; ref: string } | { db: null; ref: null; stopReason: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { db: null, ref: null, stopReason: "STOPPED_PRODUCTION_ENV_MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent in this execution context." };
  }
  const ref = projectRefOf(url);
  if (EXPECTED_PRODUCTION_PROJECT_REF && ref !== EXPECTED_PRODUCTION_PROJECT_REF) {
    return { db: null, ref: null, stopReason: `REFUSING_UNKNOWN_PRODUCTION_TARGET: expected ${EXPECTED_PRODUCTION_PROJECT_REF}, got ${ref}` };
  }
  return { db: createClient(url, key), ref };
}

async function countRows(db: SupabaseClient, table: string, build: (q: any) => any): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const query = build(db.from(table).select("*", { count: "exact", head: true }));
    const { count, error } = await query;
    if (error) return { ok: false, error: error.code ?? error.message };
    return { ok: true, count: count ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function loadExisting(path: string): any {
  if (!existsSync(path)) return null;
  try {
    const src = readFileSync(path, "utf8");
    const sandbox: { window: Record<string, unknown> } = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: path });
    return sandbox.window.POLYPROPICKS_LIVE_RUNTIME_DATA ?? null;
  } catch {
    return null;
  }
}

async function collectDayAggregate(db: SupabaseClient, minskDate: string) {
  // Minsk plan date -> UTC day bounds for game_start_iso / created_at range reads.
  const dayStartUtc = new Date(`${minskDate}T00:00:00+03:00`).toISOString();
  const dayEndUtc = new Date(`${minskDate}T23:59:59.999+03:00`).toISOString();

  const reservationsTotal = await countRows(db, "night_event_reservations", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc));
  const reservationsQueued = await countRows(db, "night_event_reservations", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc).eq("status", "QUEUED"));
  const reservationsReservedWaiting = await countRows(db, "night_event_reservations", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc).eq("status", "RESERVED"));

  const queueTotal = await countRows(db, "event_execution_queue", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc));
  const queueExecuted = await countRows(db, "event_execution_queue", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc).eq("status", "EXECUTED"));
  const queueReady = await countRows(db, "event_execution_queue", (q) => q.gte("game_start_iso", dayStartUtc).lte("game_start_iso", dayEndUtc).eq("status", "READY"));

  const ordersTotal = await countRows(db, "executor_order_events", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc));
  const ordersAccepted = await countRows(db, "executor_order_events", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc).eq("success", true));

  // Settlement: only trust an authoritative existing source when populated. Never
  // infer realized P&L from potential payout / accepted_open orders.
  let settled: { status: "PENDING_NOT_SETTLED" | "AVAILABLE"; count: number | null; realized_pnl_u: number | null; source: string | null; note: string };
  const ledgerCount = await countRows(db, "bet_execution_ledger", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc));
  if (ledgerCount.ok && ledgerCount.count > 0) {
    settled = {
      status: "AVAILABLE",
      count: ledgerCount.count,
      realized_pnl_u: null, // aggregate realized P&L requires a dedicated sum() read against the ledger's own settled-amount column; not read here to stay count-only/aggregate-first. A populated ledger flips this script's next iteration to read that sum, never inferred.
      source: "bet_execution_ledger",
      note: "bet_execution_ledger has rows for this Minsk date -- settled count is authoritative; realized_pnl_u needs a dedicated authoritative sum read (not yet wired) rather than an inferred figure.",
    };
  } else {
    settled = {
      status: "PENDING_NOT_SETTLED",
      count: 0,
      realized_pnl_u: null,
      source: null,
      note: "No authoritative settlement evidence (bet_execution_ledger empty or unreadable for this Minsk date) -- never inferring realized P&L from potential payout.",
    };
  }

  return {
    minskDate,
    reservations: {
      total: reservationsTotal.ok ? reservationsTotal.count : null,
      queued: reservationsQueued.ok ? reservationsQueued.count : null,
      reservedWaiting: reservationsReservedWaiting.ok ? reservationsReservedWaiting.count : null,
      status: reservationsTotal.ok ? "OK" : "MEASUREMENT_MISSING",
    },
    queue: {
      total: queueTotal.ok ? queueTotal.count : null,
      executed: queueExecuted.ok ? queueExecuted.count : null,
      ready: queueReady.ok ? queueReady.count : null,
      status: queueTotal.ok ? "OK" : "MEASUREMENT_MISSING",
    },
    orders: {
      total: ordersTotal.ok ? ordersTotal.count : null,
      accepted: ordersAccepted.ok ? ordersAccepted.count : null,
      status: ordersTotal.ok ? "OK" : "MEASUREMENT_MISSING",
    },
    settled,
    generatedAt: new Date().toISOString(),
  };
}

function writeSkeleton(path: string, reason: string, existing: any): void {
  const days = existing?.days ?? [];
  const body = {
    ARTIFACT: "LIVE_RUNTIME_DATA_V1",
    GENERATED_AT: new Date().toISOString(),
    status: "STOPPED",
    stopReason: reason,
    days,
  };
  const header = `/**
 * LIVE_RUNTIME_DATA_V1 -- production runtime aggregate for MODELING_DASHBOARD.html's
 * LIVE panel. Generated by scripts/modeling/refresh-live-modeling-dashboard.ts
 * (READ-ONLY: SELECT/count-only reads against night_event_reservations /
 * event_execution_queue / executor_order_events / bet_execution_ledger).
 * Production writes = 0. This run could not reach production (see stopReason
 * below) -- previously captured aggregate days are preserved verbatim; no
 * historical day is silently rewritten.
 */
`;
  writeFileSync(path, `${header}window.POLYPROPICKS_LIVE_RUNTIME_DATA = ${JSON.stringify(body, null, 2)};\n`, "utf8");
}

async function main(): Promise<void> {
  const existing = loadExisting(DATA_FILE);
  const resolved = await resolveProductionDb();

  if (!resolved.db) {
    console.log(JSON.stringify({ STATUS: "STOPPED", REASON: resolved.stopReason }, null, 2));
    writeSkeleton(DATA_FILE, resolved.stopReason, existing);
    process.exitCode = 0; // fail-closed is a valid, honest outcome -- not a script error
    return;
  }

  const minskDate = minskDateNow();
  const aggregate = await collectDayAggregate(resolved.db, minskDate);

  const priorDays: any[] = (existing?.days ?? []).filter((d: { minskDate: string }) => d.minskDate !== minskDate);
  const days = [...priorDays, aggregate].sort((a, b) => a.minskDate.localeCompare(b.minskDate));

  const body = {
    ARTIFACT: "LIVE_RUNTIME_DATA_V1",
    GENERATED_AT: new Date().toISOString(),
    status: "OK",
    productionProjectRef: resolved.ref,
    latestMinskDate: minskDate,
    days,
  };
  const header = `/**
 * LIVE_RUNTIME_DATA_V1 -- production runtime aggregate for MODELING_DASHBOARD.html's
 * LIVE panel. Generated by scripts/modeling/refresh-live-modeling-dashboard.ts
 * (READ-ONLY: SELECT/count-only reads against night_event_reservations /
 * event_execution_queue / executor_order_events / bet_execution_ledger).
 * Production writes = 0. Previously captured aggregate days are preserved
 * verbatim; each refresh only replaces the CURRENT Minsk plan date's snapshot.
 */
`;
  writeFileSync(DATA_FILE, `${header}window.POLYPROPICKS_LIVE_RUNTIME_DATA = ${JSON.stringify(body, null, 2)};\n`, "utf8");

  console.log(JSON.stringify({ STATUS: "OK", MINSK_DATE: minskDate, AGGREGATE: aggregate }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
