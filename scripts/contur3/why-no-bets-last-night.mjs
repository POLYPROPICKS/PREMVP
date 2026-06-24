#!/usr/bin/env node
/**
 * Contur3 / Blue_model — "Why no bets last night?" diagnostic.
 *
 * Queries Supabase and answers in one pass:
 *   1. What time window?
 *   2. How many signals / WC+football signals existed?
 *   3. Were reservations created?
 *   4. Was the execution queue populated with READY rows?
 *   5. Were orders placed and confirmed?
 *   6. ROOT_CAUSE_STAGE: first funnel stage that was empty.
 *
 * Funnel: SIGNALS → RESERVATIONS → QUEUE_READY → ORDERS_SENT → ORDERS_CONFIRMED
 *
 * Exits 0 if root_cause_stage=ORDERS_CONFIRMED (bets were placed),
 * exits 1 otherwise with root-cause in stdout.
 *
 * Usage:
 *   npm run contur3:why-no-bets-last-night
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 * Optional: LOOKBACK_HOURS=18 (default) to widen/narrow the window.
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '18', 10);

// Regex for WC/football text — mirrors classification in battle audit.
const WC_FOOTBALL_RE = /\b(fifwc|world[\s-]?cup|wc2026|fifa|soccer|football|match[\s-]result|both[\s-]teams|match[\s-]winner|premier[\s-]league|bundesliga|la[\s-]liga|serie[\s-]a|champions[\s-]league)\b/i;
const WC_COUNTRY_RE = /\b(france|senegal|iraq|norway|argentina|algeria|austria|jordan|saudi[\s-]arabia|uruguay|iran|new[\s-]zealand|spain|cape[\s-]verde|belgium|egypt|portugal|england|croatia|ghana|panama|colombia|uzbekistan|dr[\s-]congo|germany|ecuador|netherlands|sweden|japan|tunisia|mexico|south[\s-]korea|canada|qatar|brazil|morocco|scotland|haiti|\busa\b|australia|turkey|paraguay)\b/i;

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function windowStart() {
  return new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();
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

  const since = windowStart();
  const generatedAt = new Date().toISOString();
  const timestamp = nowIso();

  console.log(`\n=== WHY NO BETS LAST NIGHT? ===`);
  console.log(`generated_at:   ${generatedAt}`);
  console.log(`lookback_hours: ${LOOKBACK_HOURS}`);
  console.log(`window_start:   ${since}`);
  console.log(`window_end:     now (${generatedAt})\n`);

  // ── 1. Signals ────────────────────────────────────────────────────────────
  const [
    { data: scoredSignals, error: scoredErr },
    { data: shadowSignals, error: shadowErr },
  ] = await Promise.all([
    supabase
      .from('generated_signal_pairs')
      .select('event_slug,market_slug,signal_confidence_num,metric_formula_version,created_at,expires_at,diagnostics')
      .in('metric_formula_version', ['v2-lite-growth-safe', 'shadow-firemodel1_1_research_v0', 'shadow-strategic-sports-v1'])
      .gte('signal_confidence_num', 50)
      .is('signal_result', null)
      .gte('created_at', since)
      .limit(200),
    supabase
      .from('generated_signal_pairs')
      .select('event_slug,market_slug,metric_formula_version,created_at,expires_at,diagnostics')
      .eq('metric_formula_version', 'shadow-strategic-sports-v1')
      .is('signal_confidence_num', null)
      .is('signal_result', null)
      .gte('created_at', since)
      .limit(200),
  ]);

  if (scoredErr) { console.error(`signals query error: ${scoredErr.message}`); process.exit(1); }
  if (shadowErr) { console.error(`shadow query error: ${shadowErr.message}`); process.exit(1); }

  const allSignals = [...(scoredSignals ?? []), ...(shadowSignals ?? [])];
  const signalCount = allSignals.length;

  function isWcFootballText(text) {
    return WC_FOOTBALL_RE.test(text) || WC_COUNTRY_RE.test(text);
  }

  const footballWcSignals = allSignals.filter(s => {
    const text = [s.event_slug, s.market_slug, s.diagnostics?.gameTitle, s.diagnostics?.eventTitle, s.diagnostics?.marketTitle].filter(Boolean).join(' ');
    return isWcFootballText(text);
  });
  const footballWcCount = footballWcSignals.length;
  const sampleEvents = [...new Set(footballWcSignals.slice(0, 10).map(s => s.event_slug ?? s.market_slug ?? 'unknown'))];

  console.log(`signals (scored>=50):        ${(scoredSignals ?? []).length}`);
  console.log(`signals (shadow-planning):   ${(shadowSignals ?? []).length}`);
  console.log(`signals (total):             ${signalCount}`);
  console.log(`WC/football signals:         ${footballWcCount}`);
  if (sampleEvents.length) console.log(`sample WC events:            ${sampleEvents.join(' | ')}`);

  // ── 2. Reservations ────────────────────────────────────────────────────────
  const { data: reservationRows, error: resErr } = await supabase
    .from('night_event_reservations')
    .select('plan_run_id,event_title,game_start_iso,status,created_at,strategic_scope')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  if (resErr) { console.error(`reservations query error: ${resErr.message}`); process.exit(1); }

  const reservationCount = (reservationRows ?? []).length;
  const futureReservations = (reservationRows ?? []).filter(r => r.game_start_iso && new Date(r.game_start_iso) > new Date());
  const wcFootballReservations = (reservationRows ?? []).filter(r => r.strategic_scope === 'WC' || r.strategic_scope === 'SOCCER');

  console.log(`\nreservations (last ${LOOKBACK_HOURS}h):      ${reservationCount}`);
  console.log(`future reservations:         ${futureReservations.length}`);
  console.log(`WC/SOCCER reservations:      ${wcFootballReservations.length}`);

  // ── 3. Execution queue ────────────────────────────────────────────────────
  const { data: queueRows, error: queueErr } = await supabase
    .from('event_execution_queue')
    .select('id,status,event_title,market_title,created_at,preferred_entry_iso')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);

  if (queueErr) { console.error(`queue query error: ${queueErr.message}`); process.exit(1); }

  const queueTotal = (queueRows ?? []).length;
  const queueReady = (queueRows ?? []).filter(r => r.status === 'READY').length;
  const queueClaimed = (queueRows ?? []).filter(r => r.status === 'CLAIMED').length;
  const queueSent = (queueRows ?? []).filter(r => r.status === 'SENT').length;
  const queueSkipped = (queueRows ?? []).filter(r => r.status === 'SKIPPED').length;

  console.log(`\nqueue rows (last ${LOOKBACK_HOURS}h):         ${queueTotal}`);
  console.log(`  READY:    ${queueReady}`);
  console.log(`  CLAIMED:  ${queueClaimed}`);
  console.log(`  SENT:     ${queueSent}`);
  console.log(`  SKIPPED:  ${queueSkipped}`);

  // ── 4. Orders ─────────────────────────────────────────────────────────────
  const { data: orderRows, error: orderErr } = await supabase
    .from('executor_order_events')
    .select('id,dry_run,live_confirm,success,order_status,market_slug,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);

  if (orderErr) { console.error(`orders query error: ${orderErr.message}`); process.exit(1); }

  const ordersTotal = (orderRows ?? []).length;
  const ordersLiveConfirmed = (orderRows ?? []).filter(r => r.dry_run === false && (r.live_confirm === true || r.success === true)).length;
  const ordersDryRun = (orderRows ?? []).filter(r => r.dry_run === true).length;

  console.log(`\norders (last ${LOOKBACK_HOURS}h):             ${ordersTotal}`);
  console.log(`  live_confirmed:  ${ordersLiveConfirmed}`);
  console.log(`  dry_run:         ${ordersDryRun}`);

  // ── 5. Root-cause determination ───────────────────────────────────────────
  let rootCauseStage;
  let rootCauseReason;

  if (ordersLiveConfirmed > 0) {
    rootCauseStage = 'ORDERS_CONFIRMED';
    rootCauseReason = `${ordersLiveConfirmed} live orders confirmed — system functioned correctly`;
  } else if (ordersTotal > 0 && ordersLiveConfirmed === 0) {
    rootCauseStage = 'ORDERS_NOT_CONFIRMED';
    rootCauseReason = `${ordersTotal} order events but 0 live_confirmed — orders were attempted but failed or dry-run only`;
  } else if (queueSent > 0 || queueClaimed > 0) {
    rootCauseStage = 'IRELAND_NOT_CONSUMING_QUEUE';
    rootCauseReason = `Queue had SENT/CLAIMED rows but 0 orders confirmed — Ireland executor may not have converted queue to orders`;
  } else if (queueReady > 0 && queueSent === 0) {
    rootCauseStage = 'IRELAND_NOT_CONSUMING_QUEUE';
    rootCauseReason = `Queue had ${queueReady} READY rows but 0 SENT/CLAIMED — Ireland did not consume the queue`;
  } else if (queueTotal > 0 && queueReady === 0 && queueSkipped === queueTotal) {
    rootCauseStage = 'MARKET_GUARD_BLOCKED';
    rootCauseReason = `All ${queueTotal} queue rows were SKIPPED — market guard blocked every candidate (corners/halftime/props?)`;
  } else if (reservationCount > 0 && queueTotal === 0) {
    rootCauseStage = 'REBALANCE_QUEUE_MISSING';
    rootCauseReason = `${reservationCount} reservations existed but event_execution_queue had 0 rows — rebalance did not run or found no due events`;
  } else if (reservationCount === 0 && footballWcCount > 0) {
    rootCauseStage = 'RESERVATIONS_MISSING';
    rootCauseReason = `${footballWcCount} WC/football signals existed but 0 reservations were created — night-reservations cron failed or forceRebuild did not fire`;
  } else if (signalCount === 0) {
    rootCauseStage = 'SIGNALS_MISSING';
    rootCauseReason = `0 signals in generated_signal_pairs (last ${LOOKBACK_HOURS}h) — data ingestion may have failed`;
  } else if (footballWcCount === 0 && signalCount > 0) {
    rootCauseStage = 'SIGNALS_MISSING';
    rootCauseReason = `${signalCount} total signals but 0 WC/football signals — sport classification may have failed or no WC matches in this window`;
  } else {
    rootCauseStage = 'REBALANCE_QUEUE_MISSING';
    rootCauseReason = `signals=${signalCount} res=${reservationCount} queue=${queueTotal} orders=${ordersTotal} — unknown gap; inspect reservation/rebalance logs`;
  }

  console.log(`\nROOT_CAUSE_STAGE:  ${rootCauseStage}`);
  console.log(`ROOT_CAUSE_REASON: ${rootCauseReason}`);

  // ── 6. Write report ───────────────────────────────────────────────────────
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const report = {
    generated_at: generatedAt,
    lookback_hours: LOOKBACK_HOURS,
    window_start: since,
    window_end: generatedAt,
    funnel: {
      signals_scored: (scoredSignals ?? []).length,
      signals_shadow: (shadowSignals ?? []).length,
      signals_total: signalCount,
      football_wc_signals: footballWcCount,
      sample_events: sampleEvents,
      reservations_created: reservationCount,
      reservations_future: futureReservations.length,
      reservations_wc_soccer: wcFootballReservations.length,
      queue_total: queueTotal,
      queue_ready: queueReady,
      queue_claimed: queueClaimed,
      queue_sent: queueSent,
      queue_skipped: queueSkipped,
      orders_total: ordersTotal,
      orders_live_confirmed: ordersLiveConfirmed,
      orders_dry_run: ordersDryRun,
    },
    root_cause_stage: rootCauseStage,
    root_cause_reason: rootCauseReason,
    sample_reservation_events: (reservationRows ?? []).slice(0, 5).map(r => ({
      event_title: r.event_title,
      game_start_iso: r.game_start_iso,
      status: r.status,
      strategic_scope: r.strategic_scope,
    })),
    sample_queue_rows: (queueRows ?? []).slice(0, 5).map(r => ({
      event_title: r.event_title,
      market_title: r.market_title,
      status: r.status,
      preferred_entry_iso: r.preferred_entry_iso,
    })),
  };

  const jsonPath = path.join(LOG_DIR, `${timestamp}_why_no_bets.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const md = `# Why No Bets Last Night?

**Generated:** ${generatedAt}
**Window:** ${since} → now (${LOOKBACK_HOURS}h)

## Funnel

| Stage | Count |
|-------|-------|
| Signals (scored>=50) | ${(scoredSignals ?? []).length} |
| Signals (shadow-planning) | ${(shadowSignals ?? []).length} |
| **Signals total** | **${signalCount}** |
| WC/football signals | ${footballWcCount} |
| Reservations created | ${reservationCount} |
| Future reservations | ${futureReservations.length} |
| Queue total | ${queueTotal} |
| Queue READY | ${queueReady} |
| Queue SENT | ${queueSent} |
| Queue SKIPPED | ${queueSkipped} |
| Orders total | ${ordersTotal} |
| Orders live_confirmed | ${ordersLiveConfirmed} |

## Root Cause

**Stage:** \`${rootCauseStage}\`

**Reason:** ${rootCauseReason}

## Sample Events

${sampleEvents.length ? sampleEvents.map(e => `- ${e}`).join('\n') : '(нет WC/football сигналов)'}

## Report

- JSON: \`${jsonPath}\`
`;

  const mdPath = path.join(LOG_DIR, `${timestamp}_why_no_bets.md`);
  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(`\njson: ${jsonPath}`);
  console.log(`md:   ${mdPath}`);

  process.exitCode = rootCauseStage === 'ORDERS_CONFIRMED' ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 1000).unref();
}

main().catch(err => {
  console.error(`WHY_NO_BETS_FATAL: ${err}`);
  process.exit(1);
});
