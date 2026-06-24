#!/usr/bin/env node
/**
 * Contur3 / Blue_model — end-to-end funnel trace audit.
 *
 * One command that answers "why did/didn't a bet happen?" without 4 SQL queries.
 * Read-only: queries Supabase only. Does NOT call execution endpoints. Does NOT place bets.
 *
 * Usage:
 *   npm run contur3:funnel-trace-audit
 *
 * Requires:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   CONTUR3_LOOKBACK_HOURS  (default 36)
 *   CONTUR3_LOOKAHEAD_HOURS (default 24)
 *   CONTUR3_EVENT_FILTER    (e.g. "scotland" or "brazil" — substring match on event_title/slug)
 *
 * Outputs:
 *   modeling/fire_runs/contur3-blue-model/<ts>_funnel_trace_audit.json
 *   modeling/fire_runs/contur3-blue-model/<ts>_funnel_trace_audit.md
 *   modeling/fire_runs/contur3-blue-model/<ts>_funnel_trace_audit.csv
 *
 * Root-cause stages:
 *   SIGNALS_MISSING | VALID_CANDIDATES_MISSING | RESERVATIONS_MISSING |
 *   RESERVATIONS_FORBIDDEN_MARKET_ANCHORS | VALID_RESERVATIONS_NOT_DUE_YET |
 *   REBALANCE_DUE_BUT_NO_QUEUE | MISSED_REBALANCE_WINDOW |
 *   QUEUE_READY_WAITING_FOR_IRELAND | QUEUE_CLAIMED_NO_ORDER |
 *   QUEUE_SENT_ORDER_MISSING | ORDER_CONFIRMED |
 *   AUDIT_PARTIAL_TABLE_READ_FAILURE
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

const LOOKBACK_HOURS  = parseInt(process.env.CONTUR3_LOOKBACK_HOURS  ?? '36', 10);
const LOOKAHEAD_HOURS = parseInt(process.env.CONTUR3_LOOKAHEAD_HOURS ?? '24', 10);
const EVENT_FILTER    = (process.env.CONTUR3_EVENT_FILTER ?? '').toLowerCase().trim();

// ── Rebalance window constants — mirrors nightWindow.ts ─────────────────────
const REBALANCE_MINUTES_BEFORE_START = 70;
const LATEST_ENTRY_MINUTES_BEFORE    = 3;

// ── Market classification regexes ────────────────────────────────────────────
// Forbidden: must match identity fields only (slug, title, key), never telemetry.
const HALFTIME_RE = /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;
const CORNERS_RE  = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;
const PROP_RE     = /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]prop|\boutright\b|\boutright[s]?\b|outright[\s_-]winner|champion[s]?/i;
// Allowed full-match markets
const FULLMATCH_RE = /\b(moneyline|match[\s_-]winner|match[\s_-]result|winner|spread|handicap|over|under|total[\s_-]goals?|both[\s_-]teams[\s_-]to[\s_-]score|btts|1x2)\b/i;

/**
 * Classify a market from identity fields only.
 * IMPORTANT: telemetry keys (price1hAgo, delta1hPp, etc.) are NOT identity fields.
 * Only event_slug, market_slug, match_family_key, event_title, market_title are checked.
 */
function classifyMarket(identityFields) {
  const text = identityFields.filter(Boolean).join(' ');
  if (HALFTIME_RE.test(text)) return 'FORBIDDEN_HALFTIME';
  if (CORNERS_RE.test(text))  return 'FORBIDDEN_CORNERS';
  if (PROP_RE.test(text))     return 'FORBIDDEN_PROP';
  if (FULLMATCH_RE.test(text)) return 'ALLOWED_FULLMATCH';
  return 'ALLOWED_CORE';
}

function isAllowedMarket(marketClass) {
  return marketClass === 'ALLOWED_FULLMATCH' || marketClass === 'ALLOWED_CORE';
}

/**
 * Compute a stable battle trace key from available fields.
 * Format: contur3:<plan_run_id>:<match_family_key_or_slug>:<condition_or_unknown>:<token_or_unknown>
 * Does NOT write to DB — used for grouping and correlation only.
 */
function computeBattleTraceKey(row) {
  const planId   = row.plan_run_id   ?? 'unknown';
  const mfk      = (row.match_family_key ?? row.event_slug ?? row.market_slug ?? 'unknown')
                     .replace(/[^a-z0-9_\-:.]/gi, '_').slice(0, 60);
  const cond     = row.condition_id  ?? 'unknown';
  const token    = row.token_id ?? row.selected_token_id ?? 'unknown';
  return `contur3:${planId}:${mfk}:${cond}:${token}`;
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function classifyDueWindowState(gameStartIso, nowMs) {
  const startMs = Date.parse(gameStartIso);
  if (!Number.isFinite(startMs)) return 'INVALID_START';
  const minsToStart = (startMs - nowMs) / 60_000;
  if (minsToStart > REBALANCE_MINUTES_BEFORE_START) return 'BEFORE_WINDOW';
  if (minsToStart > LATEST_ENTRY_MINUTES_BEFORE)    return 'IN_WINDOW';
  return 'EXPIRED';
}

function dueWindowStartIso(gameStartIso) {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - REBALANCE_MINUTES_BEFORE_START * 60_000).toISOString();
}

function dueWindowEndIso(gameStartIso) {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString();
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

async function safeQuery(label, queryFn) {
  try {
    const result = await queryFn();
    if (result.error) {
      console.warn(`QUERY_WARN [${label}]: ${result.error.message}`);
      return { data: null, failed: true, error: result.error.message };
    }
    return { data: result.data, failed: false, error: null };
  } catch (err) {
    console.warn(`QUERY_WARN [${label}]: ${err}`);
    return { data: null, failed: true, error: String(err) };
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('MISSING_SUPABASE_ENV: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const nowMs        = Date.now();
  const generatedAt  = new Date(nowMs).toISOString();
  const timestamp    = nowIso();
  const sinceIso     = new Date(nowMs - LOOKBACK_HOURS * 3_600_000).toISOString();
  const untilIso     = new Date(nowMs + LOOKAHEAD_HOURS * 3_600_000).toISOString();
  const failedTables = [];
  let   partialFail  = false;

  console.log(`\n=== CONTUR3 FUNNEL TRACE AUDIT ===`);
  console.log(`generated_at:     ${generatedAt}`);
  console.log(`lookback_hours:   ${LOOKBACK_HOURS}  (since ${sinceIso})`);
  console.log(`lookahead_hours:  ${LOOKAHEAD_HOURS} (until ${untilIso})`);
  if (EVENT_FILTER) console.log(`event_filter:     "${EVENT_FILTER}"`);
  console.log(`due_window:       T-${REBALANCE_MINUTES_BEFORE_START}m to T-${LATEST_ENTRY_MINUTES_BEFORE}m\n`);

  // ── 1. Signals ─────────────────────────────────────────────────────────────
  const signalsQ = await safeQuery('generated_signal_pairs', () =>
    supabase
      .from('generated_signal_pairs')
      .select('event_slug,market_slug,signal_confidence_num,metric_formula_version,created_at,expires_at,diagnostics')
      .gte('created_at', sinceIso)
      .is('signal_result', null)
      .limit(500)
  );

  if (signalsQ.failed) { failedTables.push('generated_signal_pairs'); partialFail = true; }
  const allSignals = signalsQ.data ?? [];

  // Allowed full-match candidate signals (scored >= 50)
  const scoredSignals = allSignals.filter(s => (s.signal_confidence_num ?? 0) >= 50);
  const allowedCandidates = scoredSignals.filter(s => {
    const mc = classifyMarket([s.event_slug, s.market_slug,
      s.diagnostics?.eventTitle, s.diagnostics?.marketTitle]);
    return isAllowedMarket(mc);
  });

  const signalsFiltered = EVENT_FILTER
    ? allSignals.filter(s => [s.event_slug, s.market_slug,
        s.diagnostics?.eventTitle].filter(Boolean).some(f => f.toLowerCase().includes(EVENT_FILTER)))
    : allSignals;

  console.log(`signals_total:              ${allSignals.length}${signalsQ.failed ? ' [PARTIAL]' : ''}`);
  console.log(`signals_scored_ge50:        ${scoredSignals.length}`);
  console.log(`allowed_fullmatch_cands:    ${allowedCandidates.length}`);
  if (EVENT_FILTER) console.log(`signals_matching_filter:    ${signalsFiltered.length}`);

  // ── 2. Reservations ────────────────────────────────────────────────────────
  const reserveQ = await safeQuery('night_event_reservations', () =>
    supabase
      .from('night_event_reservations')
      .select('id,plan_run_id,match_family_key,event_slug,event_title,game_start_iso,status,selection_reason,created_at,strategic_scope,diagnostics,league,event_tier')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(200)
  );

  if (reserveQ.failed) { failedTables.push('night_event_reservations'); partialFail = true; }
  const allReservations = reserveQ.data ?? [];

  const filteredReservations = EVENT_FILTER
    ? allReservations.filter(r => [r.event_title, r.event_slug, r.match_family_key]
        .filter(Boolean).some(f => f.toLowerCase().includes(EVENT_FILTER)))
    : allReservations;

  // Future reservations (game_start_iso in lookahead window)
  const futureReservations = allReservations.filter(r =>
    r.game_start_iso && Date.parse(r.game_start_iso) > nowMs &&
    Date.parse(r.game_start_iso) < nowMs + LOOKAHEAD_HOURS * 3_600_000
  );

  // Classify each future reservation by market anchor
  const futureWithClass = futureReservations.map(r => {
    const mc = classifyMarket([r.match_family_key, r.event_slug, r.event_title]);
    const dwState = classifyDueWindowState(r.game_start_iso, nowMs);
    return {
      ...r,
      market_class: mc,
      due_window_state: dwState,
      due_window_start_iso: dueWindowStartIso(r.game_start_iso),
      due_window_end_iso:   dueWindowEndIso(r.game_start_iso),
      battle_trace_key: computeBattleTraceKey(r),
    };
  });

  const futureValidReservations     = futureWithClass.filter(r => isAllowedMarket(r.market_class));
  const futureForbiddenReservations = futureWithClass.filter(r => !isAllowedMarket(r.market_class));
  const dueNowReservations          = futureValidReservations.filter(r => r.due_window_state === 'IN_WINDOW');
  const beforeWindowReservations    = futureValidReservations.filter(r => r.due_window_state === 'BEFORE_WINDOW');
  const missedReservations          = allReservations.filter(r => r.status === 'EXPIRED');

  console.log(`\nreservations_total (last ${LOOKBACK_HOURS}h):   ${allReservations.length}${reserveQ.failed ? ' [PARTIAL]' : ''}`);
  console.log(`future_reservations:          ${futureReservations.length}`);
  console.log(`  future_valid (allowed):     ${futureValidReservations.length}`);
  console.log(`  future_forbidden:           ${futureForbiddenReservations.length}`);
  console.log(`  due_now (IN_WINDOW):        ${dueNowReservations.length}`);
  console.log(`  before_window:              ${beforeWindowReservations.length}`);
  console.log(`  missed_expired:             ${missedReservations.length}`);

  // ── 3. Execution queue ─────────────────────────────────────────────────────
  const queueQ = await safeQuery('event_execution_queue', () =>
    supabase
      .from('event_execution_queue')
      .select('id,plan_run_id,rebalance_run_id,match_family_key,event_slug,event_title,market_slug,market_title,condition_id,token_id,side,status,stake_usd,game_start_iso,preferred_entry_iso,created_at,selection_reason,diagnostics,tier')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(200)
  );

  if (queueQ.failed) { failedTables.push('event_execution_queue'); partialFail = true; }
  const allQueue = queueQ.data ?? [];

  const filteredQueue = EVENT_FILTER
    ? allQueue.filter(r => [r.event_title, r.event_slug, r.match_family_key]
        .filter(Boolean).some(f => f.toLowerCase().includes(EVENT_FILTER)))
    : allQueue;

  const queueReady   = allQueue.filter(r => r.status === 'READY');
  const queueClaimed = allQueue.filter(r => r.status === 'CLAIMED');
  const queueSent    = allQueue.filter(r => r.status === 'SENT');
  const queueFailed  = allQueue.filter(r => r.status === 'FAILED');
  const queueExpired = allQueue.filter(r => r.status === 'EXPIRED');

  // Classify queue market
  const queueWithClass = allQueue.map(r => ({
    ...r,
    market_class: classifyMarket([r.market_slug, r.market_title, r.event_slug, r.event_title]),
    battle_trace_key: computeBattleTraceKey(r),
  }));

  console.log(`\nqueue_total (last ${LOOKBACK_HOURS}h):           ${allQueue.length}${queueQ.failed ? ' [PARTIAL]' : ''}`);
  console.log(`  READY:    ${queueReady.length}`);
  console.log(`  CLAIMED:  ${queueClaimed.length}`);
  console.log(`  SENT:     ${queueSent.length}`);
  console.log(`  FAILED:   ${queueFailed.length}`);
  console.log(`  EXPIRED:  ${queueExpired.length}`);

  // ── 4. Orders ──────────────────────────────────────────────────────────────
  const ordersQ = await safeQuery('executor_order_events', () =>
    supabase
      .from('executor_order_events')
      .select('id,dry_run,live_confirm,success,order_status,market_slug,created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(200)
  );

  if (ordersQ.failed) { failedTables.push('executor_order_events'); partialFail = true; }
  const allOrders = ordersQ.data ?? [];

  const ordersReal          = allOrders.filter(o => o.dry_run !== true);
  const ordersLiveConfirmed = allOrders.filter(o => o.dry_run === false && (o.live_confirm === true || o.success === true));
  const ordersDryRun        = allOrders.filter(o => o.dry_run === true);

  console.log(`\norders_total (last ${LOOKBACK_HOURS}h):           ${allOrders.length}${ordersQ.failed ? ' [PARTIAL]' : ''}`);
  console.log(`  real (not dry_run):  ${ordersReal.length}`);
  console.log(`  live_confirmed:      ${ordersLiveConfirmed.length}`);
  console.log(`  dry_run:             ${ordersDryRun.length}`);

  // ── 5. Root-cause classification ───────────────────────────────────────────
  let rootCauseStage;
  let rootCauseReason;
  let nextOperatorAction;

  if (partialFail && allSignals.length === 0 && allReservations.length === 0 && allQueue.length === 0) {
    rootCauseStage    = 'AUDIT_PARTIAL_TABLE_READ_FAILURE';
    rootCauseReason   = `Failed to read tables: ${failedTables.join(', ')}. Cannot determine root cause.`;
    nextOperatorAction = 'Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars. Verify table access.';
  } else if (ordersLiveConfirmed.length > 0) {
    rootCauseStage    = 'ORDER_CONFIRMED';
    rootCauseReason   = `${ordersLiveConfirmed.length} live order(s) confirmed — betting chain functioned correctly.`;
    nextOperatorAction = 'No action required. Verify P&L in executor_order_events.';
  } else if (ordersReal.length > 0 && ordersLiveConfirmed.length === 0) {
    rootCauseStage    = 'QUEUE_SENT_ORDER_MISSING';
    rootCauseReason   = `${ordersReal.length} real order event(s) exist but 0 live_confirmed — orders attempted but not confirmed. Check Ireland order logs.`;
    nextOperatorAction = 'Inspect Ireland executor logs for order failure reason. Check market status on Polymarket.';
  } else if (queueSent.length > 0 || queueClaimed.length > 0) {
    rootCauseStage    = 'QUEUE_CLAIMED_NO_ORDER';
    rootCauseReason   = `Queue has ${queueSent.length} SENT + ${queueClaimed.length} CLAIMED rows but 0 executor_order_events. Ireland consumed queue but no order recorded.`;
    nextOperatorAction = 'Check Ireland executor logs immediately. Order may have been sent but not logged.';
  } else if (queueReady.length > 0) {
    rootCauseStage    = 'QUEUE_READY_WAITING_FOR_IRELAND';
    rootCauseReason   = `${queueReady.length} READY queue row(s) exist but Ireland has not consumed them (0 CLAIMED/SENT/orders).`;
    nextOperatorAction = 'Verify Ireland executor is running and polling /api/executor/queue. Check Ireland logs.';
  } else if (dueNowReservations.length > 0 && allQueue.length === 0) {
    rootCauseStage    = 'REBALANCE_DUE_BUT_NO_QUEUE';
    rootCauseReason   = `${dueNowReservations.length} valid reservation(s) are IN_WINDOW (T-${REBALANCE_MINUTES_BEFORE_START}..T-${LATEST_ENTRY_MINUTES_BEFORE}) but event_execution_queue is empty.`;
    nextOperatorAction = 'Run npm run contur3:event-rebalance now. Verify Railway contur3-event-rebalance-cron is on * * * * *.';
  } else if (missedReservations.length > 0 && allQueue.length === 0) {
    rootCauseStage    = 'MISSED_REBALANCE_WINDOW';
    rootCauseReason   = `${missedReservations.length} reservation(s) expired (EXPIRED status) with no queue row. Rebalance cron missed the T-${REBALANCE_MINUTES_BEFORE_START}..T-${LATEST_ENTRY_MINUTES_BEFORE} window.`;
    nextOperatorAction = 'Verify Railway cron: contur3-event-rebalance-cron must be * * * * * (continuous). Run npm run contur3:rebalance-window-audit.';
  } else if (futureValidReservations.length > 0 && dueNowReservations.length === 0) {
    const nextDue = beforeWindowReservations.sort((a, b) =>
      Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso))[0];
    rootCauseStage    = 'VALID_RESERVATIONS_NOT_DUE_YET';
    rootCauseReason   = `${futureValidReservations.length} valid future reservation(s) exist but all are BEFORE_WINDOW. Next due: ${nextDue?.due_window_start_iso ?? 'unknown'}.`;
    nextOperatorAction = `Wait for rebalance window (T-${REBALANCE_MINUTES_BEFORE_START}m). Next check at: ${nextDue?.due_window_start_iso ?? 'unknown'}.`;
  } else if (futureReservations.length > 0 && futureValidReservations.length === 0) {
    rootCauseStage    = 'RESERVATIONS_FORBIDDEN_MARKET_ANCHORS';
    rootCauseReason   = `${futureReservations.length} future reservation(s) exist but ALL have forbidden market anchors (corners/halftime/props). forceRebuild required after planner fix.`;
    nextOperatorAction = 'Fix planner forbidden-anchor filter. Run npm run contur3:night-reservations with forceRebuild=CEO_APPROVED after fix.';
  } else if (allowedCandidates.length > 0 && allReservations.length === 0) {
    rootCauseStage    = 'RESERVATIONS_MISSING';
    rootCauseReason   = `${allowedCandidates.length} allowed signal candidates exist but 0 reservations created. Night-reservations cron may have not run or skipped all candidates.`;
    nextOperatorAction = 'Run npm run contur3:reservation-admission-audit. Then run npm run contur3:night-reservations.';
  } else if (scoredSignals.length > 0 && allowedCandidates.length === 0) {
    rootCauseStage    = 'VALID_CANDIDATES_MISSING';
    rootCauseReason   = `${scoredSignals.length} scored signals exist but 0 pass allowed full-match market filter. All candidates may be forbidden markets (corners/halftime/props).`;
    nextOperatorAction = 'Inspect signal market slugs via npm run contur3:reservation-admission-audit.';
  } else if (allSignals.length === 0) {
    rootCauseStage    = 'SIGNALS_MISSING';
    rootCauseReason   = `0 signals in generated_signal_pairs (last ${LOOKBACK_HOURS}h). Data ingestion may have failed.`;
    nextOperatorAction = 'Check signal generation pipeline. Verify Polymarket data ingestion is running.';
  } else {
    rootCauseStage    = partialFail ? 'AUDIT_PARTIAL_TABLE_READ_FAILURE' : 'VALID_RESERVATIONS_NOT_DUE_YET';
    rootCauseReason   = `signals=${allSignals.length} reservations=${allReservations.length} queue=${allQueue.length} orders=${allOrders.length}${partialFail ? ' [partial read]' : ''}`;
    nextOperatorAction = 'Run npm run contur3:funnel-trace-audit again with wider CONTUR3_LOOKBACK_HOURS.';
  }

  // Compute suggested_next_check_iso
  let suggestedNextCheckIso = null;
  if (beforeWindowReservations.length > 0) {
    const soonest = beforeWindowReservations.sort((a, b) =>
      Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso))[0];
    suggestedNextCheckIso = soonest.due_window_start_iso;
  } else if (dueNowReservations.length > 0) {
    suggestedNextCheckIso = new Date(nowMs + 5 * 60_000).toISOString();
  }

  console.log(`\nROOT_CAUSE_STAGE:    ${rootCauseStage}`);
  console.log(`ROOT_CAUSE_REASON:   ${rootCauseReason}`);
  console.log(`NEXT_OPERATOR:       ${nextOperatorAction}`);
  if (suggestedNextCheckIso) console.log(`NEXT_CHECK_AT:       ${suggestedNextCheckIso}`);
  if (partialFail) console.log(`PARTIAL_FAIL_TABLES: ${failedTables.join(', ')}`);

  // ── 6. Build CSV flat rows ─────────────────────────────────────────────────
  const CSV_HEADERS = [
    'stage','battle_trace_key','event_title','event_slug','market_title','market_slug',
    'status','market_class','game_start_iso','due_window_state','due_window_start_iso',
    'due_window_end_iso','stake_usd','condition_id','token_id','created_at',
    'selection_reason','plan_run_id','tier',
  ];

  const csvRows = [];

  // Reservation rows
  for (const r of futureWithClass) {
    csvRows.push({
      stage: 'reservation',
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title ?? '',
      event_slug:  r.event_slug ?? '',
      market_title: '',
      market_slug: '',
      status: r.status,
      market_class: r.market_class,
      game_start_iso: r.game_start_iso,
      due_window_state: r.due_window_state,
      due_window_start_iso: r.due_window_start_iso ?? '',
      due_window_end_iso: r.due_window_end_iso ?? '',
      stake_usd: '',
      condition_id: '',
      token_id: '',
      created_at: r.created_at,
      selection_reason: r.selection_reason ?? '',
      plan_run_id: r.plan_run_id,
      tier: r.event_tier ?? '',
    });
  }

  // Queue rows
  for (const r of queueWithClass) {
    const dwState = classifyDueWindowState(r.game_start_iso, nowMs);
    csvRows.push({
      stage: 'queue',
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title ?? '',
      event_slug:  r.event_slug ?? '',
      market_title: r.market_title ?? '',
      market_slug:  r.market_slug ?? '',
      status: r.status,
      market_class: r.market_class,
      game_start_iso: r.game_start_iso,
      due_window_state: dwState,
      due_window_start_iso: dueWindowStartIso(r.game_start_iso) ?? '',
      due_window_end_iso:   dueWindowEndIso(r.game_start_iso) ?? '',
      stake_usd: r.stake_usd ?? '',
      condition_id: r.condition_id ?? '',
      token_id: r.token_id ?? '',
      created_at: r.created_at,
      selection_reason: r.selection_reason ?? '',
      plan_run_id: r.plan_run_id,
      tier: r.tier ?? '',
    });
  }

  // Order rows
  for (const o of allOrders) {
    csvRows.push({
      stage: 'order',
      battle_trace_key: computeBattleTraceKey(o),
      event_title: '',
      event_slug: '',
      market_title: '',
      market_slug: o.market_slug ?? '',
      status: o.order_status ?? (o.live_confirm ? 'CONFIRMED' : 'UNKNOWN'),
      market_class: classifyMarket([o.market_slug]),
      game_start_iso: '',
      due_window_state: '',
      due_window_start_iso: '',
      due_window_end_iso: '',
      stake_usd: '',
      condition_id: '',
      token_id: '',
      created_at: o.created_at,
      selection_reason: o.dry_run ? 'DRY_RUN' : (o.live_confirm ? 'LIVE_CONFIRMED' : ''),
      plan_run_id: '',
      tier: '',
    });
  }

  // ── 7. Summary table ───────────────────────────────────────────────────────
  const summaryTable = {
    signals_count:                   allSignals.length,
    allowed_candidates_next24h:      allowedCandidates.length,
    future_reservations_count:       futureReservations.length,
    future_valid_reservations_count: futureValidReservations.length,
    due_now_count:                   dueNowReservations.length,
    missed_window_count:             missedReservations.length,
    queue_ready_count:               queueReady.length,
    queue_claimed_count:             queueClaimed.length,
    queue_sent_count:                queueSent.length,
    orders_real_count:               ordersReal.length,
    orders_live_confirmed_count:     ordersLiveConfirmed.length,
    root_cause_stage:                rootCauseStage,
    next_action:                     nextOperatorAction,
  };

  console.log('\n── Summary ──────────────────────────────────────────────────────');
  for (const [k, v] of Object.entries(summaryTable)) {
    console.log(`  ${k.padEnd(38)} ${v}`);
  }

  // ── 8. Sample trace key examples ──────────────────────────────────────────
  const traceKeyExamples = [
    ...futureWithClass.slice(0, 3).map(r => ({
      type: 'reservation',
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title,
      game_start_iso: r.game_start_iso,
      due_window_state: r.due_window_state,
      market_class: r.market_class,
    })),
    ...queueWithClass.slice(0, 3).map(r => ({
      type: 'queue',
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title,
      status: r.status,
      market_class: r.market_class,
    })),
  ];

  // ── 9. Build JSON report ───────────────────────────────────────────────────
  const jsonReport = {
    generated_at: generatedAt,
    lookback_hours: LOOKBACK_HOURS,
    lookahead_hours: LOOKAHEAD_HOURS,
    event_filter: EVENT_FILTER || null,
    since_iso: sinceIso,
    until_iso: untilIso,
    due_window: {
      opens_at_t_minus_min: REBALANCE_MINUTES_BEFORE_START,
      closes_at_t_minus_min: LATEST_ENTRY_MINUTES_BEFORE,
    },
    summary: summaryTable,
    root_cause: {
      stage: rootCauseStage,
      reason: rootCauseReason,
      next_operator_action: nextOperatorAction,
      suggested_next_check_iso: suggestedNextCheckIso,
    },
    partial_fail: partialFail,
    failed_tables: failedTables,
    trace_id_status: 'COMPUTED_ONLY_NO_DURABLE_ID',
    trace_id_note: 'battle_trace_key is deterministic but not persisted to DB. See TRACE_ID_SCHEMA_MIGRATION_REQUIRED in docs.',
    battle_trace_key_format: 'contur3:<plan_run_id>:<match_family_key>:<condition_id_or_unknown>:<token_id_or_unknown>',
    trace_key_examples: traceKeyExamples,
    funnel: {
      signals: {
        total: allSignals.length,
        scored_ge50: scoredSignals.length,
        allowed_fullmatch: allowedCandidates.length,
        failed: signalsQ.failed,
      },
      reservations: {
        total_last_lookback: allReservations.length,
        future: futureReservations.length,
        future_valid: futureValidReservations.length,
        future_forbidden: futureForbiddenReservations.length,
        due_now: dueNowReservations.length,
        before_window: beforeWindowReservations.length,
        missed_expired: missedReservations.length,
        failed: reserveQ.failed,
      },
      queue: {
        total: allQueue.length,
        ready: queueReady.length,
        claimed: queueClaimed.length,
        sent: queueSent.length,
        failed_rows: queueFailed.length,
        expired: queueExpired.length,
        failed: queueQ.failed,
      },
      orders: {
        total: allOrders.length,
        real: ordersReal.length,
        live_confirmed: ordersLiveConfirmed.length,
        dry_run: ordersDryRun.length,
        failed: ordersQ.failed,
      },
    },
    sample_future_reservations: futureWithClass.slice(0, 5).map(r => ({
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title,
      game_start_iso: r.game_start_iso,
      status: r.status,
      market_class: r.market_class,
      due_window_state: r.due_window_state,
      due_window_start_iso: r.due_window_start_iso,
      due_window_end_iso: r.due_window_end_iso,
      selection_reason: r.selection_reason,
    })),
    sample_queue_rows: queueWithClass.slice(0, 5).map(r => ({
      battle_trace_key: r.battle_trace_key,
      event_title: r.event_title,
      market_slug: r.market_slug,
      status: r.status,
      market_class: r.market_class,
      stake_usd: r.stake_usd,
      preferred_entry_iso: r.preferred_entry_iso,
    })),
    sample_orders: allOrders.slice(0, 5).map(o => ({
      dry_run: o.dry_run,
      live_confirm: o.live_confirm,
      success: o.success,
      order_status: o.order_status,
      market_slug: o.market_slug,
      created_at: o.created_at,
    })),
  };

  // ── 10. Build Markdown report ──────────────────────────────────────────────
  const nextDueReservation = beforeWindowReservations.sort((a,b) =>
    Date.parse(a.game_start_iso) - Date.parse(b.game_start_iso))[0];

  const forbiddenSamplesBlock = futureForbiddenReservations.length > 0
    ? futureForbiddenReservations.slice(0, 5).map(r =>
        `- **[${r.market_class}]** ${r.event_title ?? r.match_family_key} | start=${r.game_start_iso} | status=${r.status}`
      ).join('\n')
    : '(none)';

  const reservationTableRows = futureWithClass.slice(0, 10).map(r =>
    `| ${r.event_title ?? r.match_family_key ?? '?'} | ${r.game_start_iso} | ${r.status} | ${r.market_class} | ${r.due_window_state} | ${r.due_window_start_iso ?? '?'} |`
  ).join('\n');

  const queueTableRows = queueWithClass.slice(0, 10).map(r =>
    `| ${r.event_title ?? '?'} | ${r.market_slug ?? '?'} | ${r.status} | ${r.market_class} | ${r.stake_usd ?? '?'} | ${r.battle_trace_key} |`
  ).join('\n');

  const traceKeyBlock = traceKeyExamples.map(e =>
    `- \`${e.battle_trace_key}\` — ${e.event_title ?? '?'} [${e.type}]`
  ).join('\n') || '(no rows in window)';

  const md = `# Contur3 Funnel Trace Audit

**Generated:** ${generatedAt}
**Lookback:** ${LOOKBACK_HOURS}h (since ${sinceIso})
**Lookahead:** ${LOOKAHEAD_HOURS}h (until ${untilIso})
**Due window:** T-${REBALANCE_MINUTES_BEFORE_START}m → T-${LATEST_ENTRY_MINUTES_BEFORE}m per event
${EVENT_FILTER ? `**Event filter:** "${EVENT_FILTER}"` : ''}
${partialFail ? `**PARTIAL_READ:** Tables failed: ${failedTables.join(', ')}` : ''}

---

## Current Verdict

**Root cause stage:** \`${rootCauseStage}\`

**Why:** ${rootCauseReason}

**Next operator action:** ${nextOperatorAction}

${suggestedNextCheckIso ? `**Suggested next check:** ${suggestedNextCheckIso}` : ''}

---

## Summary Table

| Metric | Count |
|--------|-------|
| signals_count | ${summaryTable.signals_count} |
| allowed_candidates_next24h | ${summaryTable.allowed_candidates_next24h} |
| future_reservations_count | ${summaryTable.future_reservations_count} |
| future_valid_reservations_count | ${summaryTable.future_valid_reservations_count} |
| due_now_count | ${summaryTable.due_now_count} |
| missed_window_count | ${summaryTable.missed_window_count} |
| queue_ready_count | ${summaryTable.queue_ready_count} |
| queue_claimed_count | ${summaryTable.queue_claimed_count} |
| queue_sent_count | ${summaryTable.queue_sent_count} |
| orders_real_count | ${summaryTable.orders_real_count} |
| orders_live_confirmed_count | ${summaryTable.orders_live_confirmed_count} |

---

## Exact Broken Stage

Stage \`${rootCauseStage}\` is the first stage where the funnel is blocked.

${rootCauseStage === 'RESERVATIONS_FORBIDDEN_MARKET_ANCHORS' ? `### Forbidden anchor samples:\n${forbiddenSamplesBlock}` : ''}

---

## Future Reservations (next ${LOOKAHEAD_HOURS}h)

| Event | Start | DB Status | Market Class | Due Window State | Due Window Opens |
|-------|-------|-----------|-------------|-----------------|-----------------|
${reservationTableRows || '| (none) | | | | | |'}

---

## Queue Rows (last ${LOOKBACK_HOURS}h)

| Event | Market Slug | Status | Market Class | Stake USD | Battle Trace Key |
|-------|-------------|--------|-------------|-----------|-----------------|
${queueTableRows || '| (none) | | | | | |'}

---

## Trace Key Examples

*Computed deterministic keys — NOT persisted to DB. See \`TRACE_ID_SCHEMA_MIGRATION_REQUIRED\`.*

${traceKeyBlock}

**Format:** \`contur3:<plan_run_id>:<match_family_key>:<condition_id_or_unknown>:<token_id_or_unknown>\`

---

## What Not to Patch Yet

| Do not patch | Until |
|-------------|-------|
| Ireland executor | READY queue row exists without order |
| Email/ops pipeline | Betting chain (RESERVED → ORDER_CONFIRMED) is proven |
| Rebalance cron | DUE_NOW / MISSED_WINDOW with no queue is proven |
| Reservation planner | Valid candidates exist but no future valid reservations |
| Stake policy | Never — locked at $7 TIER1 |

---

## Next Operator Action

**${nextOperatorAction}**

${nextDueReservation ? `Next due window opens: **${nextDueReservation.due_window_start_iso}**` : ''}

---

*Canonical forensic: \`npm run contur3:funnel-trace-audit\`*
`;

  // ── 11. Write artifacts ────────────────────────────────────────────────────
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const jsonPath = path.join(LOG_DIR, `${timestamp}_funnel_trace_audit.json`);
  const mdPath   = path.join(LOG_DIR, `${timestamp}_funnel_trace_audit.md`);
  const csvPath  = path.join(LOG_DIR, `${timestamp}_funnel_trace_audit.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');
  fs.writeFileSync(mdPath,   md, 'utf8');
  fs.writeFileSync(csvPath,  rowsToCsv(CSV_HEADERS, csvRows), 'utf8');

  console.log(`\njson: ${jsonPath}`);
  console.log(`md:   ${mdPath}`);
  console.log(`csv:  ${csvPath}`);
  console.log(`\nFINAL_VERDICT: ${rootCauseStage}`);

  process.exitCode = rootCauseStage === 'ORDER_CONFIRMED' ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}

main().catch(err => {
  console.error(`FUNNEL_TRACE_AUDIT_FATAL: ${err}`);
  process.exit(1);
});
