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
 * TODAY (independent of the PLAN funnel above): calendar-day Reservation count, Queue and Order
 * activity for the CURRENT Minsk date, plus the latest observed executor wallet spendable balance
 * (EXECUTOR_WALLET_STATE_V1 -- never the legacy bankroll_state). Reported even when today's own
 * Reservation has not run yet, so the Founder always sees today's real activity, not just the
 * most recent plan.
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
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import "dotenv/config";
import { selectCurrentSpendableWalletState, type WalletObservationRow } from "@/lib/executor/executorWalletState";

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

type SportBucket = "football" | "tennis" | "other";
type SportMix = { football: number; tennis: number; other: number };

function emptySportMix(): SportMix {
  return { football: 0, tennis: 0, other: 0 };
}

/** football = sport SOCCER or league WC; tennis = sport TENNIS; everything else = other. */
function classifySport(sport: string | null | undefined, league: string | null | undefined): SportBucket {
  const s = `${sport ?? ""}`.toUpperCase();
  const l = `${league ?? ""}`.toUpperCase();
  if (s === "TENNIS") return "tennis";
  if (s === "SOCCER" || l === "WC") return "football";
  return "other";
}

function tallySportMix(buckets: SportBucket[]): SportMix {
  const mix = emptySportMix();
  for (const b of buckets) mix[b] += 1;
  return mix;
}

/** Latest plan_date_minsk <= the current Minsk date that actually has reservation rows -- never
 * assumes "today" has a plan. If today has no Reservation yet, this resolves to the most recent
 * prior plan date instead, so a valid previous plan is never overwritten by an empty today. */
async function resolveLatestPlanDate(db: SupabaseClient, currentMinskDate: string): Promise<{ date: string | null; status: "OK" | "NO_PLAN_FOUND" | "MEASUREMENT_MISSING"; error?: string }> {
  try {
    const { data, error } = await db
      .from("night_event_reservations")
      .select("plan_date_minsk")
      .lte("plan_date_minsk", currentMinskDate)
      .order("plan_date_minsk", { ascending: false })
      .limit(1);
    if (error) return { date: null, status: "MEASUREMENT_MISSING", error: error.code ?? error.message };
    if (!data || data.length === 0) return { date: null, status: "NO_PLAN_FOUND" };
    return { date: (data[0] as { plan_date_minsk: string }).plan_date_minsk, status: "OK" };
  } catch (e) {
    return { date: null, status: "MEASUREMENT_MISSING", error: e instanceof Error ? e.message : String(e) };
  }
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

type OrderAgg = { total: number; clobOrderN: number; acceptedOpenN: number; submittedStakeUsd: number; sportMix: SportMix | null; status: "OK" };
type OrderRow = { idempotency_key: string | null; clob_order_id: string | null; stake_usd: number | null; raw_event_json: { state?: string } | null };

/** sportBucketOf: resolves each order row's sport strictly through its Queue idempotency_key lineage
 * (never a free-text league guess on the order row itself). null when lineage is unavailable, e.g. for
 * calendarDayTelemetry, which is unfiltered and not plan-linked -- its sportMix is reported as null. */
function aggregateOrders(rows: OrderRow[], sportBucketOf: ((r: OrderRow) => SportBucket | null) | null): OrderAgg {
  return {
    total: rows.length,
    clobOrderN: rows.filter((r) => r.clob_order_id != null).length,
    acceptedOpenN: rows.filter((r) => r.raw_event_json?.state === "accepted_open").length,
    submittedStakeUsd: Math.round(rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0) * 100) / 100,
    sportMix: sportBucketOf ? tallySportMix(rows.map((r) => sportBucketOf(r) ?? "other")) : null,
    status: "OK",
  };
}

async function collectPlanDateAggregate(db: SupabaseClient, minskDate: string, currentMinskDate: string) {
  // ── Stage 1: Reservations scoped by plan_date_minsk (the plan authority), never game_start_iso. ──
  const reservationRows = await selectRows<{ id: string; status: string; sport: string | null; league: string | null }>(
    db, "night_event_reservations", "id,status,sport,league", (q) => q.eq("plan_date_minsk", minskDate),
  );
  const reservationIds = reservationRows.ok ? reservationRows.rows.map((r) => r.id) : [];
  // Lineage map for Queue/Orders sportMix: classified once here, at the Reservation, never re-derived
  // from Queue/Order free-text league codes.
  const reservationSportById = new Map<string, SportBucket>(
    reservationRows.ok ? reservationRows.rows.map((r) => [r.id, classifySport(r.sport, r.league)]) : [],
  );
  const reservations = reservationRows.ok
    ? {
        total: reservationRows.rows.length,
        reserved: reservationRows.rows.filter((r) => `${r.status}`.toUpperCase() === "RESERVED").length,
        queued: reservationRows.rows.filter((r) => `${r.status}`.toUpperCase() === "QUEUED").length,
        sportMix: tallySportMix(reservationRows.rows.map((r) => reservationSportById.get(r.id) ?? "other")),
        status: "OK" as const,
      }
    : { total: null, reserved: null, queued: null, sportMix: null, status: "MEASUREMENT_MISSING" as const };

  // ── Stage 2: Queue traced from reservation_id membership in this plan date's reservations, never queue.game_start_iso. ──
  let queue: { total: number | null; ready: number | null; claimed: number | null; executed: number | null; expired: number | null; other: number | null; sportMix: SportMix | null; status: "OK" | "MEASUREMENT_MISSING" | "NO_RESERVATIONS" };
  let queueIdempotencyKeys: string[] = [];
  // idempotency_key -> sportBucket, inherited through reservation_id lineage, for Order sportMix below.
  const queueSportByIdempotencyKey = new Map<string, SportBucket>();
  if (!reservationRows.ok) {
    queue = { total: null, ready: null, claimed: null, executed: null, expired: null, other: null, sportMix: null, status: "MEASUREMENT_MISSING" };
  } else if (reservationIds.length === 0) {
    queue = { total: 0, ready: 0, claimed: 0, executed: 0, expired: 0, other: 0, sportMix: emptySportMix(), status: "NO_RESERVATIONS" };
  } else {
    const queueRows = await selectRows<{ status: string; idempotency_key: string | null; reservation_id: string }>(
      db, "event_execution_queue", "status,idempotency_key,reservation_id", (q) => q.in("reservation_id", reservationIds),
    );
    if (!queueRows.ok) {
      queue = { total: null, ready: null, claimed: null, executed: null, expired: null, other: null, sportMix: null, status: "MEASUREMENT_MISSING" };
    } else {
      const statuses = queueRows.rows.map((r) => `${r.status}`.toUpperCase());
      const ready = statuses.filter((s) => s === "READY").length;
      const claimed = statuses.filter((s) => s === "CLAIMED").length;
      const executed = statuses.filter((s) => s === "EXECUTED").length;
      const expired = statuses.filter((s) => s === "EXPIRED").length;
      const queueSportBuckets = queueRows.rows.map((r) => reservationSportById.get(r.reservation_id) ?? "other");
      queue = {
        total: statuses.length, ready, claimed, executed, expired,
        other: statuses.length - ready - claimed - executed - expired,
        sportMix: tallySportMix(queueSportBuckets),
        status: "OK",
      };
      queueIdempotencyKeys = queueRows.rows.map((r) => r.idempotency_key).filter((k): k is string => !!k);
      queueRows.rows.forEach((r) => {
        if (r.idempotency_key) queueSportByIdempotencyKey.set(r.idempotency_key, reservationSportById.get(r.reservation_id) ?? "other");
      });
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
  const planOrders: OrderAgg | { total: null; clobOrderN: null; acceptedOpenN: null; submittedStakeUsd: null; sportMix: null; status: "MEASUREMENT_MISSING" } =
    orderRows.ok && queue.status !== "MEASUREMENT_MISSING"
      ? aggregateOrders(planLinkedRows, (r) => (r.idempotency_key ? queueSportByIdempotencyKey.get(r.idempotency_key) ?? "other" : null))
      : { total: null, clobOrderN: null, acceptedOpenN: null, submittedStakeUsd: null, sportMix: null, status: "MEASUREMENT_MISSING" };

  // Calendar-day telemetry: the SAME read, unfiltered -- separate card, never the plan funnel's next stage.
  // No plan lineage exists for unfiltered rows, so sportMix is intentionally null here.
  const calendarOrders: OrderAgg | { total: null; clobOrderN: null; acceptedOpenN: null; submittedStakeUsd: null; sportMix: null; status: "MEASUREMENT_MISSING" } =
    orderRows.ok ? aggregateOrders(orderRows.rows, null) : { total: null, clobOrderN: null, acceptedOpenN: null, submittedStakeUsd: null, sportMix: null, status: "MEASUREMENT_MISSING" };

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
    currentMinskDate,
    isLatestAvailablePlanForToday: minskDate === currentMinskDate,
    planFunnel: { reservations, queue, orders: planOrders, settled },
    calendarDayTelemetry: { orders: calendarOrders, label: "NOT_IDENTICAL_TO_PLAN_FUNNEL" },
    generatedAt: new Date().toISOString(),
  };
}

type SportBreakdownRow = { sport: string; orders: number; stakeUsd: number };

/** Full per-sport granularity (raw sport code, e.g. HOCKEY/MLB/NPB/TENNIS/WNBA) -- distinct from the
 * football/tennis/other sportMix used by the PLAN funnel. Computed dynamically from whatever rows are
 * passed in; nothing here is hardcoded to any particular day's sports. */
function buildSportBreakdown(rows: { sport: string | null; stakeUsd: number }[]): SportBreakdownRow[] {
  const map = new Map<string, { orders: number; stakeUsd: number }>();
  for (const r of rows) {
    const key = (r.sport ?? "UNKNOWN").toUpperCase() || "UNKNOWN";
    const cur = map.get(key) ?? { orders: 0, stakeUsd: 0 };
    cur.orders += 1;
    cur.stakeUsd += r.stakeUsd;
    map.set(key, cur);
  }
  return Array.from(map.entries())
    .map(([sport, v]) => ({ sport, orders: v.orders, stakeUsd: Math.round(v.stakeUsd * 100) / 100 }))
    .sort((a, b) => b.orders - a.orders || a.sport.localeCompare(b.sport));
}

function minskDayBoundsUtc(minskDate: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: new Date(`${minskDate}T00:00:00+03:00`).toISOString(),
    endUtc: new Date(`${minskDate}T23:59:59.999+03:00`).toISOString(),
  };
}

/** TODAY's calendar-day activity -- independent of whether today's Reservation has run yet.
 * Queue/Orders here are bounded by created_at within the Minsk calendar day, exactly like
 * calendarDayTelemetry above, and are explicitly NOT the PLAN funnel (which is keyed by the
 * latest plan_date_minsk that actually has Reservation rows, which may be a prior day). */
async function collectTodayCalendarActivity(db: SupabaseClient, todayMinskDate: string) {
  const reservationRows = await selectRows<{ id: string }>(
    db, "night_event_reservations", "id", (q) => q.eq("plan_date_minsk", todayMinskDate),
  );
  const reservations = reservationRows.ok
    ? { total: reservationRows.rows.length, status: "OK" as const }
    : { total: null, status: "MEASUREMENT_MISSING" as const };

  const { startUtc, endUtc } = minskDayBoundsUtc(todayMinskDate);

  const queueRows = await selectRows<{ status: string; idempotency_key: string | null; sport: string | null; league: string | null; stake_usd: number | null }>(
    db, "event_execution_queue", "status,idempotency_key,sport,league,stake_usd", (q) => q.gte("created_at", startUtc).lte("created_at", endUtc),
  );
  let queue: { total: number | null; ready: number | null; claimed: number | null; executed: number | null; expired: number | null; other: number | null; submittedStakeUsd: number | null; status: "OK" | "MEASUREMENT_MISSING" };
  if (!queueRows.ok) {
    queue = { total: null, ready: null, claimed: null, executed: null, expired: null, other: null, submittedStakeUsd: null, status: "MEASUREMENT_MISSING" };
  } else {
    const statuses = queueRows.rows.map((r) => `${r.status}`.toUpperCase());
    const ready = statuses.filter((s) => s === "READY").length;
    const claimed = statuses.filter((s) => s === "CLAIMED").length;
    const executed = statuses.filter((s) => s === "EXECUTED").length;
    const expired = statuses.filter((s) => s === "EXPIRED").length;
    queue = {
      total: statuses.length, ready, claimed, executed, expired,
      other: statuses.length - ready - claimed - executed - expired,
      submittedStakeUsd: Math.round(queueRows.rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0) * 100) / 100,
      status: "OK",
    };
  }

  const orderRows = await selectRows<OrderRow>(
    db, "executor_order_events", "idempotency_key,clob_order_id,stake_usd,raw_event_json",
    (q) => q.gte("created_at", startUtc).lte("created_at", endUtc),
  );
  let orders: { total: number | null; submittedStakeUsd: number | null; bySport: SportBreakdownRow[] | null; status: "OK" | "MEASUREMENT_MISSING" };
  if (!orderRows.ok) {
    orders = { total: null, submittedStakeUsd: null, bySport: null, status: "MEASUREMENT_MISSING" };
  } else {
    // Sport lineage for today's orders comes from event_execution_queue.sport/league via
    // idempotency_key -- NOT bounded by today's calendar window, since a queue row can be written
    // the prior evening for an order that executes after midnight. Never a free-text guess on the
    // order row itself (executor_order_events carries no sport/league column of its own).
    const orderKeys = orderRows.rows.map((r) => r.idempotency_key).filter((k): k is string => !!k);
    const sportByKey = new Map<string, string | null>();
    if (orderKeys.length > 0) {
      const lineageRows = await selectRows<{ idempotency_key: string; sport: string | null; league: string | null }>(
        db, "event_execution_queue", "idempotency_key,sport,league", (q) => q.in("idempotency_key", orderKeys),
      );
      if (lineageRows.ok) {
        lineageRows.rows.forEach((r) => sportByKey.set(r.idempotency_key, r.sport));
      }
    }
    orders = {
      total: orderRows.rows.length,
      submittedStakeUsd: Math.round(orderRows.rows.reduce((s, r) => s + (r.stake_usd ?? 0), 0) * 100) / 100,
      bySport: buildSportBreakdown(orderRows.rows.map((r) => ({ sport: r.idempotency_key ? sportByKey.get(r.idempotency_key) ?? null : null, stakeUsd: r.stake_usd ?? 0 }))),
      status: "OK",
    };
  }

  return { minskDate: todayMinskDate, reservations, queue, orders, generatedAt: new Date().toISOString() };
}

const WALLET_STALE_AFTER_MINUTES = 30;

/** Latest valid spendable_balance_usd by wallet_observed_at, via the canonical
 * EXECUTOR_WALLET_STATE_V1 selection logic -- never the legacy bankroll_state. */
async function fetchWalletState(db: SupabaseClient) {
  const rows = await selectRows<Record<string, unknown>>(
    db, "executor_order_events",
    "id,idempotency_key,clob_order_id,created_at,spendable_balance_usd,collateral_balance_usd,allowance_usd,wallet_observed_at,wallet_observation_lifecycle_point",
    (q) => q.not("wallet_observed_at", "is", null).not("spendable_balance_usd", "is", null).order("wallet_observed_at", { ascending: false }),
    200,
  );
  if (!rows.ok) {
    return { status: "MEASUREMENT_MISSING" as const, spendableUsd: null, collateralUsd: null, allowanceUsd: null, observedAt: null, lifecyclePoint: null, ageMinutes: null, stale: null, error: rows.error };
  }
  const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null));
  const strOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const walletRows: WalletObservationRow[] = rows.rows.map((r) => ({
    id: String(r.id),
    idempotency_key: strOf(r.idempotency_key),
    clob_order_id: strOf(r.clob_order_id),
    created_at: strOf(r.created_at),
    spendable_balance_usd: numOf(r.spendable_balance_usd),
    collateral_balance_usd: numOf(r.collateral_balance_usd),
    allowance_usd: numOf(r.allowance_usd),
    wallet_observed_at: strOf(r.wallet_observed_at),
    wallet_observation_lifecycle_point: (strOf(r.wallet_observation_lifecycle_point) as WalletObservationRow["wallet_observation_lifecycle_point"]) ?? null,
  }));
  const state = selectCurrentSpendableWalletState(walletRows);
  if (!state) {
    return { status: "NO_OBSERVATION" as const, spendableUsd: null, collateralUsd: null, allowanceUsd: null, observedAt: null, lifecyclePoint: null, ageMinutes: null, stale: null };
  }
  const ageMinutes = Math.round((Date.now() - Date.parse(state.wallet_observed_at)) / 60_000);
  return {
    status: "OK" as const,
    spendableUsd: state.current_spendable_balance_usd,
    collateralUsd: state.collateral_balance_usd,
    allowanceUsd: state.allowance_usd,
    observedAt: state.wallet_observed_at,
    lifecyclePoint: state.wallet_observation_lifecycle_point,
    ageMinutes,
    stale: ageMinutes > WALLET_STALE_AFTER_MINUTES,
  };
}

/** Request-time, production-read-only counterpart of the committed snapshot
 * writer. Shared by the Founder API route; it hard-refuses the research clone. */
export async function readLiveModelingRuntime(): Promise<Record<string, unknown>> {
  const resolved = await resolveProductionDb();
  if (!resolved.db) return { ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: resolved.stopReason, days: [] };
  const currentMinskDate = minskDateNow();
  const plan = await resolveLatestPlanDate(resolved.db, currentMinskDate);
  if (plan.status !== "OK" || !plan.date) {
    return { ARTIFACT: "LIVE_RUNTIME_DATA_V1", status: "STOPPED", stopReason: plan.status === "NO_PLAN_FOUND" ? `NO_PLAN_FOUND: no night_event_reservations row with plan_date_minsk <= ${currentMinskDate}.` : `MEASUREMENT_MISSING: failed to resolve latest plan date${plan.error ? ` (${plan.error})` : ""}.`, days: [] };
  }
  const aggregate = await collectPlanDateAggregate(resolved.db, plan.date, currentMinskDate);
  const today = await collectTodayCalendarActivity(resolved.db, currentMinskDate);
  const wallet = await fetchWalletState(resolved.db);
  return { ARTIFACT: "LIVE_RUNTIME_DATA_V1", GENERATED_AT: new Date().toISOString(), status: "OK", productionProjectRef: resolved.ref, currentMinskDate, latestMinskDate: plan.date, today: { ...today, wallet }, days: [aggregate] };
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

  const currentMinskDate = minskDateNow();
  // Never assume "today Minsk" has a plan -- resolve the latest plan_date_minsk <= today that
  // actually has Reservation rows. If today has no Reservation yet, this naturally falls back to
  // the latest prior plan date instead of publishing an empty today's plan over a valid previous one.
  const resolvedPlanDate = await resolveLatestPlanDate(resolved.db, currentMinskDate);
  if (resolvedPlanDate.status !== "OK" || !resolvedPlanDate.date) {
    const stopReason = resolvedPlanDate.status === "NO_PLAN_FOUND"
      ? `NO_PLAN_FOUND: no night_event_reservations row with plan_date_minsk <= ${currentMinskDate}.`
      : `MEASUREMENT_MISSING: failed to resolve latest plan date${resolvedPlanDate.error ? ` (${resolvedPlanDate.error})` : ""}.`;
    console.log(JSON.stringify({ STATUS: "STOPPED", REASON: stopReason }, null, 2));
    // Fail-closed: never overwrite a previously captured valid plan snapshot on a failed resolve.
    if (existing) {
      writeBody(DATA_FILE, { ...existing, lastRefreshAttempt: { at: new Date().toISOString(), stopReason } });
    } else {
      writeBody(DATA_FILE, { ARTIFACT: "LIVE_RUNTIME_DATA_V1", GENERATED_AT: new Date().toISOString(), status: "STOPPED", stopReason, days: [] });
    }
    process.exitCode = 0;
    return;
  }

  const minskDate = resolvedPlanDate.date;
  const aggregate = await collectPlanDateAggregate(resolved.db, minskDate, currentMinskDate);
  // TODAY is independent of the PLAN funnel above -- it is today's calendar-day activity even
  // when today's own Reservation has not run yet (minskDate here may be a prior day).
  const today = await collectTodayCalendarActivity(resolved.db, currentMinskDate);
  const wallet = await fetchWalletState(resolved.db);

  const priorDays: any[] = (existing?.days ?? []).filter((d: { minskDate: string }) => d.minskDate !== minskDate);
  const days = [...priorDays, aggregate].sort((a, b) => a.minskDate.localeCompare(b.minskDate));

  const body = {
    ARTIFACT: "LIVE_RUNTIME_DATA_V1",
    GENERATED_AT: new Date().toISOString(),
    status: "OK",
    productionProjectRef: resolved.ref,
    currentMinskDate,
    latestMinskDate: minskDate,
    today: { ...today, wallet },
    days,
  };
  writeBody(DATA_FILE, body);

  console.log(JSON.stringify({ STATUS: "OK", CURRENT_MINSK_DATE: currentMinskDate, LATEST_PLAN_MINSK_DATE: minskDate, TODAY: today, WALLET: wallet, AGGREGATE: aggregate }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  });
}
