/**
 * REFRESH_LIVE_MODELING_DASHBOARD_V1 — Git-owned READ-ONLY production runtime
 * refresh for the SAME Sep21 dashboard's LIVE panel. This is a LIVE-READOUT
 * mission script, not a modeling/search mission: it aggregates the actual
 * Sep21 PLAN path (Reservation -> Queue -> Executor Order -> CLOB Order ->
 * Settlement) for the current Minsk PLAN date, and never infers realized P&L
 * from potential payout.
 *
 * PLAN LINEAGE (the funnel's own authority chain -- every stage below joins
 * on the PREVIOUS stage's own key, never a wall-clock day guess):
 *   1. night_event_reservations.plan_date_minsk = the Minsk PLAN date.
 *   2. event_execution_queue.reservation_id IN (that plan date's reservation ids).
 *   3. executor_order_events.idempotency_key = event_execution_queue.idempotency_key
 *      (only queue rows from step 2) -- this is PLAN_LINKED order evidence,
 *      not "orders created sometime that calendar day".
 *   4. bet_execution_ledger.exchange_order_id = executor_order_events.clob_order_id
 *      (only the plan-linked orders from step 3) -- settlement is attributed to
 *      the PLAN, never to whichever wall-clock day settled_at happens to fall
 *      on (a Sep21 order settling Sep22 stays attributed to the Sep21 plan).
 *      settled_n = count(settled_at IS NOT NULL) over those matched rows only;
 *      realized P&L = sum(real_pnl) over the same matched+settled rows only.
 *
 * SEPARATE TELEMETRY: the same day-scoped executor_order_events read (bounded
 * by created_at within the Minsk calendar day, since order events carry no
 * plan_date_minsk of their own) is also reported, UNFILTERED, as
 * calendarDayTelemetry -- explicitly labelled NOT_IDENTICAL_TO_PLAN_FUNNEL.
 * It must never substitute for the plan-linked (idempotency_key-joined)
 * figures above; one calendar-day executor event does not necessarily map to
 * this plan's own queue path.
 *
 * HARD SAFETY (same posture as scripts/contur3/lib/contur3LiveFunnelMonitor.mjs):
 *   - SELECT-only reads (count-only where a count suffices; small bounded
 *     column-limited reads only where an actual sum/join requires row values
 *     -- reservation ids for the queue join, queue idempotency keys for the
 *     order join, order idempotency_key/clob_order_id/stake_usd/raw_event_json
 *     for the plan-link + stake sum, plan-linked clob_order_id values for the
 *     ledger join, real_pnl for the settled-P&L sum -- each scoped to one
 *     plan date's tiny operational row set, never the research corpus).
 *     Never writes a production DB row.
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

/** Small, column-limited, single-plan-date-bounded read -- never the research corpus, never unbounded. Used only where a count cannot answer the question (an id/key list for a FK join, or a sum). */
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

type OrderAgg = { total: number; clobOrderN: number; acceptedOpenN: number; submittedStakeUsd: number; status: "OK" };
type OrderRow = { idempotency_key: string | null; clob_order_id: string | null; stake_usd: number | null; raw_event_json: { state?: string } | null };

function aggregateOrders(rows: OrderRow[]): OrderAgg {
  return {
    total: rows.length,
    clobOrderN: rows.filter((r) => r.clob_order_id != null).length,
    acceptedOpenN: rows.filter((r) => r.raw_event_json?.state === "accepted_open").length,
    submittedStakeUsd: Math.round(rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0) * 100) / 100,
    status: "OK",
  };
}

async function collectPlanDateAggregate(db: SupabaseClient, minskDate: string) {
  // ── Stage 1: Reservations scoped by plan_date_minsk (the plan authority), never game_start_iso. ──
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

  // ── Stage 2: Queue traced from reservation_id membership in this plan date's reservations, never queue.game_start_iso. ──
  let queue: { total: number | null; ready: number | null; executed: number | null; expired: number | null; other: number | null; status: "OK" | "MEASUREMENT_MISSING" | "NO_RESERVATIONS" };
  let queueIdempotencyKeys: string[] = [];
  if (!reservationRows.ok) {
    queue = { total: null, ready: null, executed: null, expired: null, other: null, status: "MEASUREMENT_MISSING" };
  } else if (reservationIds.length === 0) {
    queue = { total: 0, ready: 0, executed: 0, expired: 0, other: 0, status: "NO_RESERVATIONS" };
  } else {
    const queueRows = await selectRows<{ status: string; idempotency_key: string | null }>(
      db, "event_execution_queue", "status,idempotency_key", (q) => q.in("reservation_id", reservationIds),
    );
    if (!queueRows.ok) {
      queue = { total: null, ready: null, executed: null, expired: null, other: null, status: "MEASUREMENT_MISSING" };
    } else {
      const statuses = queueRows.rows.map((r) => `${r.status}`.toUpperCase());
      const ready = statuses.filter((s) => s === "READY").length;
      const executed = statuses.filter((s) => s === "EXECUTED").length;
      const expired = statuses.filter((s) => s === "EXPIRED").length;
      queue = { total: statuses.length, ready, executed, expired, other: statuses.length - ready - executed - expired, status: "OK" };
      queueIdempotencyKeys = queueRows.rows.map((r) => r.idempotency_key).filter((k): k is string => !!k);
    }
  }

  // ── Candidate executor order rows: bounded by created_at within the Minsk calendar day (order
  // events carry no plan_date_minsk of their own). This SAME read backs both aggregates below --
  // it is split by idempotency_key membership, never re-fetched with different date logic. ──
  const dayStartUtc = new Date(`${minskDate}T00:00:00+03:00`).toISOString();
  const dayEndUtc = new Date(`${minskDate}T23:59:59.999+03:00`).toISOString();
  const orderRows = await selectRows<OrderRow>(
    db, "executor_order_events", "idempotency_key,clob_order_id,stake_usd,raw_event_json",
    (q) => q.gte("created_at", dayStartUtc).lte("created_at", dayEndUtc),
  );

  // ── Stage 3: PLAN_LINKED orders = candidate rows whose idempotency_key matches THIS plan's queue rows. ──
  const planLinkedRows = orderRows.ok ? orderRows.rows.filter((r) => r.idempotency_key != null && queueIdempotencyKeys.includes(r.idempotency_key)) : [];
  const planOrders: OrderAgg | { total: null; clobOrderN: null; acceptedOpenN: null; submittedStakeUsd: null; status: "MEASUREMENT_MISSING" } =
    orderRows.ok && queue.status !== "MEASUREMENT_MISSING" ? aggregateOrders(planLinkedRows) : { total: null, clobOrderN: null, acceptedOpenN: null, submittedStakeUsd: null, status: "MEASUREMENT_MISSING" };

  // Calendar-day telemetry: the SAME read, unfiltered -- separate card, never the plan funnel's next stage.
  const calendarOrders: OrderAgg | { total: null; clobOrderN: null; acceptedOpenN: null; submittedStakeUsd: null; status: "MEASUREMENT_MISSING" } =
    orderRows.ok ? aggregateOrders(orderRows.rows) : { total: null, clobOrderN: null, acceptedOpenN: null, submittedStakeUsd: null, status: "MEASUREMENT_MISSING" };

  // ── Stage 4: Settlement traced from PLAN-LINKED clob_order_id -> ledger.exchange_order_id.
  // Never scoped by settled_at wall-clock day -- a Sep21 order settling Sep22 stays this plan's. ──
  const planLinkedClobIds = planLinkedRows.map((r) => r.clob_order_id).filter((id): id is string => !!id);
  let settled: { status: "PENDING_NOT_SETTLED" | "AVAILABLE" | "MEASUREMENT_MISSING" | "NO_PLAN_LINKED_CLOB_ORDERS"; count: number | null; realized_pnl_usd: number | null; source: string | null; note: string };
  if (!orderRows.ok || queue.status === "MEASUREMENT_MISSING") {
    settled = { status: "MEASUREMENT_MISSING", count: null, realized_pnl_usd: null, source: null, note: "Plan-linked order evidence unavailable -- cannot trace settlement." };
  } else if (planLinkedClobIds.length === 0) {
    settled = { status: "NO_PLAN_LINKED_CLOB_ORDERS", count: 0, realized_pnl_usd: null, source: null, note: "No plan-linked CLOB order ids to join against bet_execution_ledger.exchange_order_id." };
  } else {
    const ledgerRows = await selectRows<{ exchange_order_id: string; settled_at: string | null; real_pnl: number | null }>(
      db, "bet_execution_ledger", "exchange_order_id,settled_at,real_pnl", (q) => q.in("exchange_order_id", planLinkedClobIds),
    );
    if (!ledgerRows.ok) {
      settled = { status: "MEASUREMENT_MISSING", count: null, realized_pnl_usd: null, source: null, note: `bet_execution_ledger read failed: ${ledgerRows.error}` };
    } else {
      const settledMatched = ledgerRows.rows.filter((r) => r.settled_at != null);
      if (settledMatched.length > 0) {
        settled = {
          status: "AVAILABLE",
          count: settledMatched.length,
          realized_pnl_usd: Math.round(settledMatched.reduce((s, r) => s + (r.real_pnl ?? 0), 0) * 100) / 100,
          source: "bet_execution_ledger (exchange_order_id = plan-linked clob_order_id, settled_at IS NOT NULL)",
          note: "Authoritative settled rows joined from this plan's own CLOB order ids -- never scoped by settlement wall-clock day.",
        };
      } else {
        settled = {
          status: "PENDING_NOT_SETTLED",
          count: 0,
          realized_pnl_usd: null,
          source: null,
          note: "0 bet_execution_ledger rows with settled_at IS NOT NULL among this plan's linked CLOB order ids -- never inferring realized P&L from potential payout, accepted_open, or gross_profit_if_win.",
        };
      }
    }
  }

  return {
    minskDate,
    planFunnel: { reservations, queue, orders: planOrders, settled },
    calendarDayTelemetry: { orders: calendarOrders, label: "NOT_IDENTICAL_TO_PLAN_FUNNEL" },
    generatedAt: new Date().toISOString(),
  };
}

function writeBody(path: string, body: unknown): void {
  const header = `/**
 * LIVE_RUNTIME_DATA_V1 -- production runtime aggregate for MODELING_DASHBOARD.html's
 * LIVE panel. Generated by scripts/modeling/refresh-live-modeling-dashboard.ts
 * (READ-ONLY: night_event_reservations scoped by plan_date_minsk; event_execution_queue
 * traced by reservation_id; executor_order_events plan-linked via
 * queue.idempotency_key = order.idempotency_key; settlement traced from plan-linked
 * clob_order_id -> bet_execution_ledger.exchange_order_id, settled_at IS NOT NULL only,
 * never a wall-clock settlement day). Production writes = 0. Previously captured
 * aggregate days -- including any Architect-verified seeded snapshot -- are preserved
 * verbatim; a failed refresh NEVER deletes them, and a successful refresh only replaces
 * the CURRENT Minsk plan date's own snapshot. planFunnel and calendarDayTelemetry are
 * always kept separate -- the latter is informational only and is never the plan
 * funnel's next stage.
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
