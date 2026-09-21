/**
 * REFRESH_LIVE_MODELING_DASHBOARD_V1 — Git-owned READ-ONLY production runtime
 * refresh for the SAME Sep21 dashboard's LIVE panel. This is a LIVE-READOUT
 * mission script, not a modeling/search mission: it aggregates the current
 * production funnel (Reservation -> Queue -> Execution -> Order -> Filled ->
 * Settled) for the current Minsk PLAN date, and never infers realized P&L
 * from potential payout.
 *
 * BUSINESS-PATH AUTHORITY:
 *   - Reservation scope: night_event_reservations.plan_date_minsk (the Minsk
 *     PLAN date the reservation was made for), never game_start_iso. The
 *     dashboard question is "what happened in the Sep21 production plan",
 *     not "which games happened to start during the Sep21 wall-clock day".
 *   - Queue scope: event_execution_queue rows whose reservation_id belongs to
 *     that same plan date's reservations -- never queue.game_start_iso as the
 *     primary plan-day boundary.
 *   - Orders (ORDER_EVENT_N / CLOB_ORDER_N / ACCEPTED_OPEN_N / SUBMITTED_STAKE_USD)
 *     use their own exact authoritative fields: clob_order_id IS NOT NULL,
 *     raw_event_json->>'state' = 'accepted_open' (never success=true as a
 *     substitute), sum(stake_usd).
 *   - Settlement: bet_execution_ledger rows are NOT automatically settled.
 *     Authoritative settled_n = count(settled_at IS NOT NULL); realized P&L =
 *     sum(real_pnl) only over those settled rows. Never potential payout /
 *     gross_profit_if_win / accepted_open as realized P&L. No settled rows ->
 *     PENDING_NOT_SETTLED, realized P&L stays null.
 *
 * HARD SAFETY (same posture as scripts/contur3/lib/contur3LiveFunnelMonitor.mjs):
 *   - SELECT-only reads (count-only where a count suffices; small bounded
 *     column-limited reads only where an actual sum/join requires row values
 *     -- reservation ids for the queue join, stake_usd for the stake sum,
 *     real_pnl for the settled-P&L sum -- each scoped to one plan date's
 *     tiny operational row set, never the research corpus). Never writes a
 *     production DB row.
 *   - Fails closed (STOPPED_PRODUCTION_ENV_MISSING / REFUSING_UNKNOWN_PRODUCTION_TARGET)
 *     rather than silently falling back to any other project -- including the
 *     research clone -- when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
 *     absent, or when the resolved project ref is not EXACTLY the known
 *     production project. The expected ref is hard-pinned in source, not an
 *     optional env override.
 *
 * Tables read (production, read-only):
 *   night_event_reservations, event_execution_queue, executor_order_events
 *   Settlement (only if populated): bet_execution_ledger
 *
 * Output: modeling/evidence/modeling-dashboard-v1/LIVE_RUNTIME_DATA.js
 * (window.POLYPROPICKS_LIVE_RUNTIME_DATA), loaded by MODELING_DASHBOARD.html
 * beside MODELING_DAILY_DATA.js. Aggregate counts/sums only -- no raw event
 * rows, no research-corpus rows. A failed run (missing/wrong credentials)
 * NEVER deletes previously captured aggregate days, including a seeded
 * Architect-verified snapshot.
 *
 * Usage:
 *   npx tsx scripts/modeling/refresh-live-modeling-dashboard.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import "dotenv/config";

const DATA_FILE = "modeling/evidence/modeling-dashboard-v1/LIVE_RUNTIME_DATA.js";
// Known production project ref. Hard-pinned, not an optional env override --
// distinct from the research-clone ref (nppznoujvnyjargjkmnv) used by
// scripts/modeling/*-portfolio-test.ts and refresh-modeling-dashboard.ts.
// This script refuses any other project, including the clone.
const PRODUCTION_PROJECT_REF = "nbnldzfsxffztsfrrxqy";

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

/** Fail-closed: only ever runs against the exact known production project -- never guesses, never silently substitutes the research clone or any other project. */
async function resolveProductionDb(): Promise<{ db: SupabaseClient; ref: string } | { db: null; ref: null; stopReason: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { db: null, ref: null, stopReason: "STOPPED_PRODUCTION_ENV_MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent in this execution context." };
  }
  const ref = projectRefOf(url);
  if (ref !== PRODUCTION_PROJECT_REF) {
    return { db: null, ref: null, stopReason: `REFUSING_UNKNOWN_PRODUCTION_TARGET: expected ${PRODUCTION_PROJECT_REF}, got ${ref}` };
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

/** Small, column-limited, single-plan-date-bounded read -- never the research corpus, never unbounded. Used only where a count cannot answer the question (an id list for a FK join, or a sum). */
async function selectRows<T>(db: SupabaseClient, table: string, columns: string, build: (q: any) => any, limit = 2000): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  try {
    const query = build(db.from(table).select(columns)).limit(limit);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.code ?? error.message };
    return { ok: true, rows: (data ?? []) as T[] };
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

async function collectPlanDateAggregate(db: SupabaseClient, minskDate: string) {
  // ── Reservations: scoped by plan_date_minsk (the plan authority), not game_start_iso. ──
  const reservationRows = await selectRows<{ id: string; status: string }>(
    db, "night_event_reservations", "id,status", (q) => q.eq("plan_date_minsk", minskDate),
  );
  const reservationIds = reservationRows.ok ? reservationRows.rows.map((r) => r.id) : [];
  const reservations = reservationRows.ok
    ? {
        total: reservationRows.rows.length,
        reserved: reservationRows.rows.filter((r) => `${r.status}`.toUpperCase() === "RESERVED").length,
        queued: reservationRows.rows.filter((r) => `${r.status}`.toUpperCase() === "QUEUED").length,
        status: "OK" as const,
      }
    : { total: null, reserved: null, queued: null, status: "MEASUREMENT_MISSING" as const };

  // ── Queue: traced from reservation_id membership in this plan date's reservations, never queue.game_start_iso. ──
  let queue: { total: number | null; ready: number | null; executed: number | null; expired: number | null; other: number | null; status: "OK" | "MEASUREMENT_MISSING" | "NO_RESERVATIONS" };
  if (!reservationRows.ok) {
    queue = { total: null, ready: null, executed: null, expired: null, other: null, status: "MEASUREMENT_MISSING" };
  } else if (reservationIds.length === 0) {
    queue = { total: 0, ready: 0, executed: 0, expired: 0, other: 0, status: "NO_RESERVATIONS" };
  } else {
    const queueRows = await selectRows<{ status: string }>(db, "event_execution_queue", "status", (q) => q.in("reservation_id", reservationIds));
    if (!queueRows.ok) {
      queue = { total: null, ready: null, executed: null, expired: null, other: null, status: "MEASUREMENT_MISSING" };
    } else {
      const statuses = queueRows.rows.map((r) => `${r.status}`.toUpperCase());
      const ready = statuses.filter((s) => s === "READY").length;
      const executed = statuses.filter((s) => s === "EXECUTED").length;
      const expired = statuses.filter((s) => s === "EXPIRED").length;
      queue = { total: statuses.length, ready, executed, expired, other: statuses.length - ready - executed - expired, status: "OK" };
    }
  }

  // ── Orders: exact authoritative fields, day-scoped by created_at (order events carry no plan_date_minsk of their own). ──
  const dayStartUtc = new Date(`${minskDate}T00:00:00+03:00`).toISOString();
  const dayEndUtc = new Date(`${minskDate}T23:59:59.999+03:00`).toISOString();
  const ordersTotal = await countRows(db, "executor_order_events", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc));
  const clobOrderN = await countRows(db, "executor_order_events", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc).not("clob_order_id", "is", null));
  const acceptedOpenN = await countRows(db, "executor_order_events", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc).filter("raw_event_json->>state", "eq", "accepted_open"));
  const stakeRows = await selectRows<{ stake_usd: number | null }>(db, "executor_order_events", "stake_usd", (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc));
  const submittedStakeUsd = stakeRows.ok ? Math.round(stakeRows.rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0) * 100) / 100 : null;
  const orders = {
    total: ordersTotal.ok ? ordersTotal.count : null,
    clobOrderN: clobOrderN.ok ? clobOrderN.count : null,
    acceptedOpenN: acceptedOpenN.ok ? acceptedOpenN.count : null,
    submittedStakeUsd,
    status: ordersTotal.ok && clobOrderN.ok && acceptedOpenN.ok && stakeRows.ok ? ("OK" as const) : ("MEASUREMENT_MISSING" as const),
  };

  // ── Settlement: settled_at IS NOT NULL is the only authoritative settled evidence. ──
  // Never success=true / accepted_open / potential payout / gross_profit_if_win as realized P&L.
  const settledRows = await selectRows<{ real_pnl: number | null }>(
    db, "bet_execution_ledger", "real_pnl",
    (q) => q.not("settled_at", "is", null).gte("settled_at", dayStartUtc).lte("settled_at", dayEndUtc),
  );
  let settled: { status: "PENDING_NOT_SETTLED" | "AVAILABLE" | "MEASUREMENT_MISSING"; count: number | null; realized_pnl_usd: number | null; source: string | null; note: string };
  if (!settledRows.ok) {
    settled = { status: "MEASUREMENT_MISSING", count: null, realized_pnl_usd: null, source: null, note: `bet_execution_ledger read failed: ${settledRows.error}` };
  } else if (settledRows.rows.length > 0) {
    settled = {
      status: "AVAILABLE",
      count: settledRows.rows.length,
      realized_pnl_usd: Math.round(settledRows.rows.reduce((s, r) => s + (r.real_pnl ?? 0), 0) * 100) / 100,
      source: "bet_execution_ledger (settled_at IS NOT NULL)",
      note: "Authoritative settled rows for this plan date -- realized P&L is sum(real_pnl) over settled_at IS NOT NULL rows only.",
    };
  } else {
    settled = {
      status: "PENDING_NOT_SETTLED",
      count: 0,
      realized_pnl_usd: null,
      source: null,
      note: "No bet_execution_ledger rows with settled_at IS NOT NULL for this plan date -- never inferring realized P&L from potential payout, accepted_open, or gross_profit_if_win.",
    };
  }

  return { minskDate, reservations, queue, orders, settled, generatedAt: new Date().toISOString() };
}

function writeBody(path: string, body: unknown): void {
  const header = `/**
 * LIVE_RUNTIME_DATA_V1 -- production runtime aggregate for MODELING_DASHBOARD.html's
 * LIVE panel. Generated by scripts/modeling/refresh-live-modeling-dashboard.ts
 * (READ-ONLY: night_event_reservations scoped by plan_date_minsk; event_execution_queue
 * traced by reservation_id; executor_order_events read for exact clob_order_id /
 * raw_event_json->>'state' / stake_usd fields; bet_execution_ledger read only for
 * settled_at IS NOT NULL rows). Production writes = 0. Previously captured aggregate
 * days -- including any Architect-verified seeded snapshot -- are preserved verbatim;
 * a failed refresh NEVER deletes them, and a successful refresh only replaces the
 * CURRENT Minsk plan date's own snapshot.
 */
`;
  writeFileSync(path, `${header}window.POLYPROPICKS_LIVE_RUNTIME_DATA = ${JSON.stringify(body, null, 2)};\n`, "utf8");
}

async function main(): Promise<void> {
  const existing = loadExisting(DATA_FILE);
  const resolved = await resolveProductionDb();

  if (!resolved.db) {
    console.log(JSON.stringify({ STATUS: "STOPPED", REASON: resolved.stopReason }, null, 2));
    // Fail-closed is a valid, honest outcome -- never touch previously captured days
    // (including a seeded Architect-verified snapshot) on a failed run.
    if (existing) {
      writeBody(DATA_FILE, { ...existing, GENERATED_AT: existing.GENERATED_AT, status: existing.status, lastRefreshAttempt: { at: new Date().toISOString(), stopReason: resolved.stopReason } });
    } else {
      writeBody(DATA_FILE, { ARTIFACT: "LIVE_RUNTIME_DATA_V1", GENERATED_AT: new Date().toISOString(), status: "STOPPED", stopReason: resolved.stopReason, days: [] });
    }
    process.exitCode = 0;
    return;
  }

  const minskDate = minskDateNow();
  const aggregate = await collectPlanDateAggregate(resolved.db, minskDate);

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
  writeBody(DATA_FILE, body);

  console.log(JSON.stringify({ STATUS: "OK", MINSK_DATE: minskDate, AGGREGATE: aggregate }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
