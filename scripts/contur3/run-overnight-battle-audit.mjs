#!/usr/bin/env node
/**
 * Contur3 / Blue_model — overnight battle audit.
 *
 * One command that tells the operator exactly what is happening:
 *   - Queue status (endpoint + Supabase)
 *   - Active forbidden rows (NO_GO if any READY/CLAIMED/SENT forbidden)
 *   - executor_order_events last 24h (real order ledger)
 *   - night_event_reservations last 12h
 *   - Upcoming candidate readiness if Supabase env available
 *
 * Writes: JSON + CSV + MD report + appends to daily JSONL battle log.
 * Exit 0 for GO_READY / ARMED_WAITING. Non-zero for NO_GO or failure.
 *
 * Battle log: modeling/fire_runs/contur3-blue-model/contur3_battle_YYYY-MM-DD.jsonl
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const BASE_URL = 'https://polypropicks.com';
const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');

// ── Market guard mirrors (keep in sync with eventExecutionQueue.ts) ──
const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;
const CORNERS_MARKET_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;
const PROP_MARKET_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]shot|\bplayer[\s_-]assist|\boutright\b/i;

function classifyMarketTitle(title) {
  if (!title) return 'UNKNOWN_REVIEW';
  if (HALFTIME_MARKET_RE.test(title)) return 'FORBIDDEN_HALFTIME';
  if (CORNERS_MARKET_RE.test(title)) return 'FORBIDDEN_CORNERS';
  if (PROP_MARKET_RE.test(title)) return 'FORBIDDEN_PROP';
  return 'ALLOWED_CORE';
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function battleLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `contur3_battle_${date}.jsonl`);
}

function appendBattleLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(battleLogPath(), JSON.stringify(entry) + '\n', 'utf8');
    console.log(`CONTUR3_BATTLE_LOG_WRITTEN path=${battleLogPath()}`);
  } catch (err) {
    console.warn(`CONTUR3_BATTLE_LOG_WARN: append failed: ${err}`);
  }
}

function getGitCommit() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getOriginCommit() {
  try {
    return execSync('git rev-parse origin/main', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function fetchJson(url, options) {
  try {
    const res = await fetch(url, options);
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: String(err) };
  }
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
    lines.push(headers.map(h => csvEscape(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

async function main() {
  const timestamp = nowIso();
  const jsonPath  = path.join(LOG_DIR, `${timestamp}_overnight_battle_audit.json`);
  const csvPath   = path.join(LOG_DIR, `${timestamp}_overnight_battle_audit.csv`);
  const mdPath    = path.join(LOG_DIR, `${timestamp}_overnight_battle_audit.md`);

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // ── A. Version/build info ──
  const gitCommit    = getGitCommit();
  const originCommit = getOriginCommit();
  const generatedAt  = new Date().toISOString();

  console.log(`\n=== CONTUR3 OVERNIGHT BATTLE AUDIT ===`);
  console.log(`generated_at: ${generatedAt}`);
  console.log(`git_commit:   ${gitCommit.slice(0, 10)}`);
  console.log(`origin/main:  ${originCommit.slice(0, 10)}`);
  console.log(`base_url:     ${BASE_URL}`);

  // ── B. Supabase setup ──
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasSupabase = Boolean(supabaseUrl && supabaseKey);

  let supabase = null;
  if (hasSupabase) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      supabase = createClient(supabaseUrl, supabaseKey);
      console.log(`supabase:     CONNECTED`);
    } catch (err) {
      console.warn(`supabase:     IMPORT_FAILED: ${err}`);
    }
  } else {
    console.log(`supabase:     NO_ENV_MISSING_URL_OR_KEY`);
  }

  // ── C. Endpoint calls (requires executor secret) ──
  const secret =
    process.env.EXECUTOR_CANDIDATES_SECRET ||
    process.env.EXECUTOR_SECRET ||
    process.env.PPP_SECRET;

  let queueResult  = null;
  let rebalanceResult = null;
  const endpointPending = !secret;

  if (secret) {
    const headers = { 'Content-Type': 'application/json', 'x-executor-secret': secret };
    console.log(`\nFetching queue endpoint...`);
    [queueResult, rebalanceResult] = await Promise.all([
      fetchJson(`${BASE_URL}/api/executor/queue?includeUpcoming=1`, { headers }),
      fetchJson(`${BASE_URL}/api/cron/event-rebalance`, {
        method: 'POST', headers, body: JSON.stringify({ dryRun: true }),
      }),
    ]);
    console.log(`queue http_status:    ${queueResult.status}`);
    console.log(`rebalance http_status: ${rebalanceResult.status}`);
  } else {
    console.log(`\nENDPOINT_AUDIT_PENDING: no executor secret in env`);
  }

  const queueBody     = queueResult?.body ?? {};
  const rebalanceBody = rebalanceResult?.body ?? {};

  const candidates = queueBody.candidates ?? queueBody.queue ?? [];
  const candidateCount = Array.isArray(candidates) ? candidates.length : (queueBody.candidate_count ?? 0);
  const queueSource  = queueBody.source ?? queueBody.queue_source ?? null;
  const nextDueIso   = queueBody.next_due_iso ?? queueBody.nextDueIso ?? rebalanceBody.next_due_iso ?? null;
  const irelandContract = queueBody.ireland_contract ?? null;

  // ── D. Supabase: event_execution_queue last 12h ──
  const since12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let queueRows = [];
  let queueDbError = null;
  let forbiddenActiveRows = [];

  if (supabase) {
    console.log(`\nQuerying event_execution_queue last 12h...`);
    const { data, error } = await supabase
      .from('event_execution_queue')
      .select('*')
      .gte('created_at', since12h)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      queueDbError = error.message;
      console.warn(`event_execution_queue query error: ${error.message}`);
    } else {
      queueRows = data ?? [];
      console.log(`event_execution_queue rows (last 12h): ${queueRows.length}`);
    }

    // ── E. Forbidden active rows check ──
    const activeStatuses = ['READY', 'CLAIMED', 'SENT'];
    forbiddenActiveRows = queueRows.filter(r =>
      activeStatuses.includes(r.status) &&
      classifyMarketTitle(r.market_title) !== 'ALLOWED_CORE'
    );
    if (forbiddenActiveRows.length > 0) {
      console.error(`\nFORBIDDEN_ACTIVE_QUEUE_ROWS: ${forbiddenActiveRows.length}`);
      for (const r of forbiddenActiveRows) {
        console.error(`  status=${r.status} market_title=${r.market_title} id=${r.id}`);
      }
    } else {
      console.log(`forbidden active READY/CLAIMED/SENT: 0 ✓`);
    }
  }

  // ── F. executor_order_events last 24h ──
  let orderEvents = [];
  let orderEventsError = null;

  if (supabase) {
    console.log(`\nQuerying executor_order_events last 24h...`);
    const { data, error } = await supabase
      .from('executor_order_events')
      .select('*')
      .gte('created_at', since24h)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      orderEventsError = error.message;
      console.warn(`executor_order_events error: ${error.message}`);
    } else {
      orderEvents = data ?? [];
      console.log(`executor_order_events (last 24h): ${orderEvents.length}`);
    }
  }

  const liveOrders     = orderEvents.filter(e => e.dry_run === false && (e.live_confirm === true || e.success === true));
  const dryRunOrders   = orderEvents.filter(e => e.dry_run === true);
  const failedOrders   = orderEvents.filter(e => e.dry_run === false && !e.live_confirm && !e.success && e.order_status === 'FAILED');

  // ── G. night_event_reservations last 12h ──
  let reservationRows = [];
  let reservationsError = null;

  if (supabase) {
    console.log(`\nQuerying night_event_reservations last 12h...`);
    const { data, error } = await supabase
      .from('night_event_reservations')
      .select('*')
      .gte('created_at', since12h)
      .order('game_start_iso', { ascending: true })
      .limit(100);
    if (error) {
      reservationsError = error.message;
      console.warn(`night_event_reservations error: ${error.message}`);
    } else {
      reservationRows = data ?? [];
      console.log(`night_event_reservations (last 12h): ${reservationRows.length}`);
    }
  }

  // Also get ALL active reservations (for upcoming events)
  let activeReservations = [];
  if (supabase) {
    const { data } = await supabase
      .from('night_event_reservations')
      .select('*')
      .in('status', ['RESERVED', 'REBALANCE_PENDING'])
      .order('game_start_iso', { ascending: true })
      .limit(20);
    activeReservations = data ?? [];
    console.log(`active reservations (RESERVED/REBALANCE_PENDING): ${activeReservations.length}`);
  }

  // Flag: no future reservations at all
  // (will be populated by futureReservations block below, but computed here for verdict)
  const noFutureReservationsFlag = Boolean(supabase) && activeReservations.length === 0;

  // ── H. Future reservations (all statuses, game_start > now) ──
  let futureReservations = [];
  let futureResError = null;

  if (supabase) {
    console.log(`\nQuerying future night_event_reservations (game_start > now)...`);
    const { data, error } = await supabase
      .from('night_event_reservations')
      .select('*')
      .gt('game_start_iso', new Date().toISOString())
      .order('game_start_iso', { ascending: true })
      .limit(20);
    if (error) {
      futureResError = error.message;
      console.warn(`future reservations error: ${error.message}`);
    } else {
      futureReservations = data ?? [];
      console.log(`future reservations (game_start > now): ${futureReservations.length}`);
      if (futureReservations.length === 0) {
        console.warn(`WARNING: NO_FUTURE_RESERVATIONS — night-reservations cron may need to run before upcoming match windows`);
      }
    }
  }

  // ── I. Upcoming candidates from generated_signal_pairs (score-filtered, expires_at future) ──
  let upcomingCandidates = [];
  let upcomingError = null;
  const next12hIso = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

  if (supabase) {
    console.log(`Querying generated_signal_pairs (score>=72, not expired, limit=50)...`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const { data, error } = await supabase
        .from('generated_signal_pairs')
        .select('event_slug,market_slug,score,expires_at,diagnostics,signal_confidence_num')
        .gte('score', 72)
        .gte('expires_at', new Date().toISOString())
        .order('score', { ascending: false })
        .limit(50)
        .abortSignal(controller.signal);
      clearTimeout(timeout);
      if (error) {
        upcomingError = error.message;
        console.warn(`generated_signal_pairs error: ${error.message}`);
      } else {
        upcomingCandidates = data ?? [];
        console.log(`upcoming high-score signal pairs (score>=72, not expired): ${upcomingCandidates.length}`);
      }
    } catch (err) {
      upcomingError = `TIMEOUT_OR_ABORT: ${err}`;
      console.warn(`generated_signal_pairs timeout: ${err}`);
    }
  }

  // ── I. Final verdict ──
  let verdict;
  const errors = [];

  if (queueDbError) errors.push(`queue_db_error: ${queueDbError}`);
  if (orderEventsError) errors.push(`order_events_error: ${orderEventsError}`);
  if (reservationsError) errors.push(`reservations_error: ${reservationsError}`);

  if (forbiddenActiveRows.length > 0) {
    verdict = 'BLUE_MODEL_NO_GO_FORBIDDEN_ACTIVE_QUEUE';
  } else if (endpointPending && !supabase) {
    verdict = 'BLUE_MODEL_RUNTIME_PENDING';
  } else if (queueResult && !queueResult.ok) {
    verdict = 'BLUE_MODEL_NO_GO_DB_OR_ENDPOINT_FAILURE';
  } else if (queueSource && queueSource !== 'event_execution_queue') {
    verdict = 'BLUE_MODEL_NO_GO_QUEUE_CONTRACT_BROKEN';
    errors.push(`queue_source=${queueSource} expected=event_execution_queue`);
  } else if (irelandContract && irelandContract.do_not_rank === false) {
    verdict = 'BLUE_MODEL_NO_GO_QUEUE_CONTRACT_BROKEN';
    errors.push('ireland_contract.do_not_rank=false');
  } else if (endpointPending) {
    // Supabase-only assessment
    if (activeReservations.length > 0 || upcomingCandidates.length > 0) {
      verdict = 'BLUE_MODEL_ARMED_WAITING';
    } else {
      verdict = 'BLUE_MODEL_RUNTIME_PENDING';
    }
  } else if (candidateCount >= 1) {
    // Check if all endpoint candidates are allowed core
    const forbiddenFromEndpoint = candidates.filter(c => {
      const t = c.market_title ?? c.market_slug ?? '';
      return classifyMarketTitle(t) !== 'ALLOWED_CORE';
    });
    if (forbiddenFromEndpoint.length > 0) {
      verdict = 'BLUE_MODEL_NO_GO_FORBIDDEN_ACTIVE_QUEUE';
    } else {
      verdict = 'BLUE_MODEL_GO_READY';
    }
  } else if (candidateCount === 0 && nextDueIso) {
    verdict = 'BLUE_MODEL_ARMED_WAITING';
  } else if (candidateCount === 0 && activeReservations.length > 0) {
    verdict = 'BLUE_MODEL_ARMED_WAITING';
  } else {
    verdict = 'BLUE_MODEL_ARMED_WAITING';
  }

  console.log(`\nVERDICT: ${verdict}`);
  if (errors.length) {
    for (const e of errors) console.warn(`  ERROR: ${e}`);
  }

  // ── J. Queue rows annotated ──
  const annotatedQueue = queueRows.map(r => ({
    ...r,
    market_classification: classifyMarketTitle(r.market_title),
  }));

  // ── K. Build report ──
  const report = {
    generated_at: generatedAt,
    verdict,
    git_commit: gitCommit,
    origin_commit: originCommit,
    base_url: BASE_URL,
    supabase_connected: Boolean(supabase),
    endpoint_pending: endpointPending,
    queue: {
      endpoint_ok: queueResult?.ok ?? null,
      http_status: queueResult?.status ?? null,
      candidate_count: candidateCount,
      source: queueSource,
      next_due_iso: nextDueIso,
      ireland_contract: irelandContract,
    },
    rebalance_dry_run: {
      endpoint_ok: rebalanceResult?.ok ?? null,
      http_status: rebalanceResult?.status ?? null,
      due_count: rebalanceBody.due_count ?? null,
      queued_count: rebalanceBody.queued_count ?? null,
      skipped_count: rebalanceBody.skipped_count ?? null,
    },
    event_execution_queue_last12h: {
      total_rows: queueRows.length,
      by_status: countBy(queueRows, 'status'),
      by_classification: countBy(annotatedQueue, 'market_classification'),
      forbidden_active_count: forbiddenActiveRows.length,
      forbidden_active_rows: forbiddenActiveRows.map(r => ({
        id: r.id,
        status: r.status,
        market_title: r.market_title,
        event_title: r.event_title,
        created_at: r.created_at,
        classification: classifyMarketTitle(r.market_title),
      })),
      rows: annotatedQueue.map(r => ({
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        event_title: r.event_title,
        market_title: r.market_title,
        selected_outcome: r.selected_outcome ?? r.side,
        stake_usd: r.stake_usd,
        preferred_entry_iso: r.preferred_entry_iso,
        latest_entry_iso: r.latest_entry_iso,
        condition_id: r.condition_id ? r.condition_id.slice(0, 12) + '...' : null,
        token_id: r.token_id ? r.token_id.slice(0, 12) + '...' : null,
        selection_reason: r.selection_reason,
        market_classification: r.market_classification,
      })),
    },
    order_ledger_last24h: {
      total: orderEvents.length,
      live_confirmed: liveOrders.length,
      dry_run: dryRunOrders.length,
      failed: failedOrders.length,
      error: orderEventsError,
      events: orderEvents.map(e => ({
        created_at: e.created_at,
        dry_run: e.dry_run,
        live_confirm: e.live_confirm,
        success: e.success,
        order_status: e.order_status,
        market_slug: e.market_slug,
        token_id: e.token_id ? String(e.token_id).slice(0, 12) + '...' : null,
        side: e.side ?? e.selected_side,
        clob_order_id: e.clob_order_id,
        verdict: (e.dry_run === false && (e.live_confirm || e.success))
          ? 'LIVE_ORDER_CONFIRMED'
          : (e.dry_run === true ? 'DRY_RUN' : 'PENDING_OR_FAILED'),
      })),
    },
    reservations_last12h: {
      total: reservationRows.length,
      active_count: activeReservations.length,
      error: reservationsError,
      active: activeReservations.map(r => ({
        match_family_key: r.match_family_key,
        event_title: r.event_title,
        game_start_iso: r.game_start_iso,
        status: r.status,
        plan_run_id: r.plan_run_id,
        selection_reason: r.selection_reason,
      })),
      rows: reservationRows.map(r => ({
        created_at: r.created_at,
        match_family_key: r.match_family_key,
        event_title: r.event_title,
        game_start_iso: r.game_start_iso,
        status: r.status,
        selection_reason: r.selection_reason,
      })),
    },
    future_reservations: {
      total: futureReservations.length,
      error: futureResError,
      no_future_reservations_warning: noFutureReservationsFlag && futureReservations.length === 0,
      rows: (futureReservations ?? []).map(r => ({
        match_family_key: r.match_family_key,
        event_title: r.event_title,
        game_start_iso: r.game_start_iso,
        status: r.status,
        created_at: r.created_at,
        selection_reason: r.selection_reason,
      })),
    },
    upcoming_signal_pairs_score72: {
      total: upcomingCandidates.length,
      error: upcomingError,
      candidates: upcomingCandidates.slice(0, 20).map(c => ({
        event_slug: c.event_slug,
        market_slug: c.market_slug,
        score: c.score,
        expires_at: c.expires_at,
        game_start_iso: c.diagnostics?.game_start_iso ?? null,
        market_classification: classifyMarketTitle(c.market_slug),
      })),
    },
    errors,
    diagnostic_report_path: jsonPath,
  };

  // ── L. Write JSON ──
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\njson:         ${jsonPath}`);

  // ── M. Write CSV (queue rows) ──
  const csvHeaders = [
    'created_at', 'status', 'event_title', 'market_title', 'selected_outcome',
    'stake_usd', 'preferred_entry_iso', 'latest_entry_iso',
    'condition_id', 'token_id', 'selection_reason', 'market_classification',
  ];
  const csvContent = rowsToCsv(csvHeaders, report.event_execution_queue_last12h.rows);
  fs.writeFileSync(csvPath, csvContent, 'utf8');
  console.log(`csv:          ${csvPath}`);

  // ── N. Write MD summary ──
  const liveOrderBlock = liveOrders.length > 0
    ? liveOrders.map(e => `  - ${e.created_at} | ${e.market_slug} | side=${e.side ?? e.selected_side} | clob=${e.clob_order_id ?? 'n/a'}`).join('\n')
    : '  (нет подтверждённых живых ордеров за последние 24ч)';

  const forbiddenBlock = forbiddenActiveRows.length > 0
    ? forbiddenActiveRows.map(r => `  - **${r.status}** | ${r.market_title} | id=${r.id}`).join('\n')
    : '  ✅ Нет запрещённых активных рядов';

  const reservationBlock = activeReservations.length > 0
    ? activeReservations.map(r => `  - ${r.event_title ?? r.match_family_key} | старт: ${r.game_start_iso} | статус: ${r.status}`).join('\n')
    : '  (нет активных резерваций)';

  const upcomingBlock = upcomingCandidates.length > 0
    ? upcomingCandidates.slice(0, 10).map(c => `  - ${c.event_slug ?? c.market_slug} | expires: ${c.expires_at} | score=${c.score} | class=${classifyMarketTitle(c.market_slug)}`).join('\n')
    : '  (нет кандидатов score>=72 не истёкших)';

  const futureResBlock = (futureReservations ?? []).length > 0
    ? futureReservations.map(r => `  - ${r.event_title ?? r.match_family_key} | старт: ${r.game_start_iso} | статус: ${r.status}`).join('\n')
    : noFutureReservationsFlag
      ? '  ⚠️ **NO_FUTURE_RESERVATIONS** — нет резерваций для будущих матчей!\n  Необходимо запустить `npm run contur3:night-reservations` или Railway "Run Now" на night-reservations-cron.'
      : '  (Supabase недоступен — требуется ручная проверка)';

  const md = `# Contur3 / Blue_model — Overnight Battle Audit

**Сгенерировано:** ${generatedAt}
**Вердикт:** \`${verdict}\`
**git commit:** \`${gitCommit.slice(0, 10)}\`
**origin/main:** \`${originCommit.slice(0, 10)}\`

---

## A. Статус очереди

| Поле | Значение |
|------|---------|
| Количество кандидатов (endpoint) | ${candidateCount ?? 'PENDING'} |
| Источник очереди | ${queueSource ?? 'PENDING'} |
| next_due_iso | ${nextDueIso ?? 'N/A'} |
| Ireland contract present | ${irelandContract ? 'YES' : 'PENDING'} |
| do_not_rank | ${irelandContract?.do_not_rank ?? 'PENDING'} |
| do_not_pull_broad_candidates | ${irelandContract?.do_not_pull_broad_candidates ?? 'PENDING'} |

## B. Запрещённые активные ряды (READY/CLAIMED/SENT)

**Количество:** ${forbiddenActiveRows.length}

${forbiddenBlock}

## C. event_execution_queue (последние 12ч)

| Статус | Кол-во |
|--------|--------|
${Object.entries(countBy(queueRows, 'status')).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

| Классификация | Кол-во |
|---------------|--------|
${Object.entries(countBy(annotatedQueue, 'market_classification')).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## D. Реальные ордера (executor_order_events, 24ч)

- **Всего:** ${orderEvents.length}
- **Подтверждённые живые:** ${liveOrders.length}
- **Dry-run:** ${dryRunOrders.length}
- **Ошибки:** ${failedOrders.length}

${liveOrderBlock}

## E. Активные резервации

${reservationBlock}

## F. Будущие резервации

${futureResBlock}

## G. Ближайшие кандидаты (score>=72, не истёкшие)

${upcomingBlock}

## H. Итоговый вердикт

\`\`\`
${verdict}
\`\`\`

${forbiddenActiveRows.length > 0
    ? '⛔ DO NOT UNLOCK LIVE — есть запрещённые активные ряды'
    : verdict === 'BLUE_MODEL_GO_READY'
      ? '✅ GO_READY — Ireland watcher может выполнять ордера'
      : verdict === 'BLUE_MODEL_ARMED_WAITING'
        ? '⏳ ARMED_WAITING — ждём окна входа или кандидатов'
        : '⚠️ ТРЕБУЕТСЯ ПРОВЕРКА'
}

## I. Артефакты

- JSON: \`${jsonPath}\`
- CSV: \`${csvPath}\`
- MD: \`${mdPath}\`
- Battle log: \`${battleLogPath()}\`

---

*Supabase подключён: ${Boolean(supabase)}. Endpoint pending: ${endpointPending}.*
`;

  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`md:           ${mdPath}`);

  // ── O. Battle log ──
  appendBattleLog({
    timestamp_iso: generatedAt,
    runner: 'run-overnight-battle-audit',
    git_commit: gitCommit.slice(0, 10),
    endpoint: endpointPending ? 'PENDING_NO_SECRET' : BASE_URL,
    http_status: queueResult?.status ?? null,
    ok: verdict === 'BLUE_MODEL_GO_READY' || verdict === 'BLUE_MODEL_ARMED_WAITING',
    candidate_count: candidateCount,
    active_reservations: activeReservations.length,
    future_reservations: (futureReservations ?? []).length,
    no_future_reservations_warning: noFutureReservationsFlag && (futureReservations ?? []).length === 0,
    upcoming_signal_pairs_score72: upcomingCandidates.length,
    live_orders_24h: liveOrders.length,
    forbidden_active_count: forbiddenActiveRows.length,
    next_due_iso: nextDueIso,
    diagnostic_report_path: jsonPath,
    verdict,
    errors,
  });

  // ── P. Exit ──
  const exitOk = verdict === 'BLUE_MODEL_GO_READY' || verdict === 'BLUE_MODEL_ARMED_WAITING';
  process.exitCode = exitOk ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 2000).unref();
}

function countBy(arr, key) {
  const result = {};
  for (const item of arr) {
    const v = String(item[key] ?? 'null');
    result[v] = (result[v] ?? 0) + 1;
  }
  return result;
}

main().catch(err => {
  console.error(`OVERNIGHT_BATTLE_AUDIT_FATAL: ${err}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 500).unref();
});
