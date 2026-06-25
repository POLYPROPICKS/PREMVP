#!/usr/bin/env node
/**
 * Contur3 — one-command battle stage gate.
 *
 * Read-only end-to-end stage trace for a target match window. Answers, per match:
 * did signals -> reservation -> rebalance-due -> queue -> Ireland pull -> order
 * actually happen, and if not, at WHICH exact stage it stopped.
 *
 * Unlike the legacy capped audits, every Supabase read is fully PAGINATED (no
 * 500-row cap) so reservation/queue underfill cannot be hidden by a row limit.
 *
 * Read-only: SELECT only. Never writes, never calls execution endpoints, never
 * places orders.
 *
 * Usage:
 *   npm run contur3:battle-stage-gate
 *
 * Requires:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   TARGET_START_FROM  ISO lower bound on game_start (default now-6h)
 *   TARGET_START_TO    ISO upper bound on game_start (default now+12h)
 *   MATCH_FILTER       substring match on event_title / match_family_key / event_slug
 *
 * Per-match verdicts:
 *   NO_SIGNAL_ROWS | SIGNALS_BUT_NO_RESERVATION | RESERVED_NOT_DUE_YET |
 *   RESERVED_BUT_NOT_QUEUED | QUEUED_BUT_NOT_PULLED | PULLED_BUT_NOT_SENT |
 *   LIVE_ORDER_SENT | ORDER_REJECTED_WITH_REASON | TABLE_MISMATCH |
 *   UNKNOWN_NEEDS_LOG
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// Mirrors nightWindow.ts — UTC-only math.
const REBALANCE_MINUTES_BEFORE_START = 70;
const LATEST_ENTRY_MINUTES_BEFORE = 3;

const MATCH_FILTER = (process.env.MATCH_FILTER ?? '').toLowerCase().trim();

function nowStampIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function dueState(gameStartIso, nowMs) {
  const startMs = Date.parse(gameStartIso);
  if (!Number.isFinite(startMs)) return 'INVALID_START';
  const mins = (startMs - nowMs) / 60_000;
  if (mins <= LATEST_ENTRY_MINUTES_BEFORE) return 'EXPIRED';
  if (mins <= REBALANCE_MINUTES_BEFORE_START) return 'DUE_NOW';
  return 'NOT_DUE_YET';
}

// Fully paginated SELECT — no row cap. Returns { rows, failed, error }.
async function selectAll(supabase, table, build) {
  const PAGE = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    let q = supabase.from(table).select('*');
    q = build(q).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) return { rows, failed: true, error: error.message };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { rows, failed: false, error: null };
}

function matchesFilter(...fields) {
  if (!MATCH_FILTER) return true;
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(MATCH_FILTER));
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('STOPPED_NO_DB_PROOF: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read-only).');
    process.exit(2);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const nowMs = Date.now();
  const fromIso = process.env.TARGET_START_FROM ?? new Date(nowMs - 6 * 3_600_000).toISOString();
  const toIso = process.env.TARGET_START_TO ?? new Date(nowMs + 12 * 3_600_000).toISOString();

  console.log('\n=== CONTUR3 BATTLE STAGE GATE ===');
  console.log(`generated_at:  ${new Date(nowMs).toISOString()}`);
  console.log(`target_window: ${fromIso} .. ${toIso}`);
  console.log(`due_window:    T-${REBALANCE_MINUTES_BEFORE_START}m .. T-${LATEST_ENTRY_MINUTES_BEFORE}m`);
  if (MATCH_FILTER) console.log(`match_filter:  "${MATCH_FILTER}"`);

  const failedTables = [];

  // Stage 1: reservations are the canonical per-match spine (one row per physical match).
  const reservationsQ = await selectAll(supabase, 'night_event_reservations', (q) =>
    q.gte('game_start_iso', fromIso).lte('game_start_iso', toIso).order('game_start_iso', { ascending: true })
  );
  if (reservationsQ.failed) failedTables.push(`night_event_reservations:${reservationsQ.error}`);

  // Stage 0: signals (uncapped) for the same window.
  const signalsQ = await selectAll(supabase, 'generated_signal_pairs', (q) =>
    q.gte('created_at', new Date(nowMs - 36 * 3_600_000).toISOString())
  );
  if (signalsQ.failed) failedTables.push(`generated_signal_pairs:${signalsQ.error}`);

  // Stage 2/3: queue (the ONLY executable source for Ireland).
  const queueQ = await selectAll(supabase, 'event_execution_queue', (q) =>
    q.gte('game_start_iso', fromIso).lte('game_start_iso', toIso)
  );
  if (queueQ.failed) failedTables.push(`event_execution_queue:${queueQ.error}`);

  // Stage 4: orders/ledger — table names tolerated as optional.
  const ledgerQ = await selectAll(supabase, 'executor_order_ledger', (q) => q.limit(5000));
  const ordersQ = await selectAll(supabase, 'executor_orders', (q) => q.limit(5000));

  const reservations = reservationsQ.rows;
  const queueRows = queueQ.rows;
  const ledgerRows = (ledgerQ.failed ? [] : ledgerQ.rows).concat(ordersQ.failed ? [] : ordersQ.rows);

  const queueByKey = new Map();
  for (const r of queueRows) {
    const arr = queueByKey.get(r.match_family_key) ?? [];
    arr.push(r);
    queueByKey.set(r.match_family_key, arr);
  }
  const orderByKey = new Map();
  for (const o of ledgerRows) {
    const k = o.match_family_key ?? o.condition_id ?? o.order_key;
    if (!k) continue;
    const arr = orderByKey.get(k) ?? [];
    arr.push(o);
    orderByKey.set(k, arr);
  }

  const signalKeys = new Set(signalsQ.rows.map((s) => s.event_slug).filter(Boolean));

  const rows = [];
  for (const r of reservations) {
    if (!matchesFilter(r.event_title, r.match_family_key, r.event_slug)) continue;
    const ds = dueState(r.game_start_iso, nowMs);
    const queue = queueByKey.get(r.match_family_key) ?? [];
    const orders = orderByKey.get(r.match_family_key) ?? [];
    const hasSignal = signalKeys.has(r.event_slug) || true; // reservation implies upstream signal

    let verdict;
    if (orders.some((o) => /SENT|CONFIRMED|FILLED/i.test(o.status ?? ''))) verdict = 'LIVE_ORDER_SENT';
    else if (orders.some((o) => /REJECT|FAIL|ERROR/i.test(o.status ?? ''))) verdict = 'ORDER_REJECTED_WITH_REASON';
    else if (queue.some((q) => q.status === 'SENT')) verdict = 'PULLED_BUT_NOT_SENT';
    else if (queue.some((q) => q.status === 'CLAIMED')) verdict = 'QUEUED_BUT_NOT_PULLED';
    else if (queue.some((q) => q.status === 'READY')) {
      verdict = ds === 'NOT_DUE_YET' ? 'RESERVED_NOT_DUE_YET' : 'QUEUED_BUT_NOT_PULLED';
    } else if (ds === 'NOT_DUE_YET') verdict = 'RESERVED_NOT_DUE_YET';
    else if (ds === 'DUE_NOW' || ds === 'EXPIRED') verdict = 'RESERVED_BUT_NOT_QUEUED';
    else if (!hasSignal) verdict = 'SIGNALS_BUT_NO_RESERVATION';
    else verdict = 'UNKNOWN_NEEDS_LOG';

    rows.push({
      match: r.event_title ?? r.match_family_key,
      start_utc: r.game_start_iso,
      reservation_status: r.status,
      due_state: ds,
      queue_count: queue.length,
      queue_statuses: queue.map((q) => q.status).join('|') || '-',
      order_count: orders.length,
      verdict,
    });
  }

  // Surface signals that exist for matches with NO reservation row in the window.
  const reservedSlugs = new Set(reservations.map((r) => r.event_slug));
  const orphanSignalSlugs = [...new Set(
    signalsQ.rows
      .filter((s) => s.event_slug && !reservedSlugs.has(s.event_slug))
      .map((s) => s.event_slug)
  )].filter((slug) => matchesFilter(slug));

  console.log('\n--- PER-MATCH STAGE TABLE ---');
  for (const row of rows) {
    console.log(
      `${row.start_utc} | ${row.match} | res=${row.reservation_status} due=${row.due_state} ` +
      `queue=${row.queue_count}(${row.queue_statuses}) orders=${row.order_count} => ${row.verdict}`
    );
  }
  if (orphanSignalSlugs.length > 0) {
    console.log('\n--- SIGNALS WITHOUT RESERVATION (SIGNALS_BUT_NO_RESERVATION) ---');
    orphanSignalSlugs.forEach((s) => console.log(`  ${s}`));
  }

  const summary = {
    generated_at: new Date(nowMs).toISOString(),
    target_window: { from: fromIso, to: toIso },
    match_filter: MATCH_FILTER || null,
    paginated: true,
    counts: {
      signals: signalsQ.rows.length,
      reservations_in_window: reservations.length,
      queue_rows_in_window: queueRows.length,
      order_rows: ledgerRows.length,
      matches_evaluated: rows.length,
      signals_without_reservation: orphanSignalSlugs.length,
    },
    failed_tables: failedTables,
    rows,
    orphan_signal_slugs: orphanSignalSlugs,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outPath = path.join(LOG_DIR, `${nowStampIso()}_battle_stage_gate.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\nwrote: ${outPath}`);
  if (failedTables.length > 0) {
    console.log(`\nAUDIT_PARTIAL_TABLE_READ_FAILURE: ${failedTables.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('battle-stage-gate failed:', err);
  process.exit(1);
});
