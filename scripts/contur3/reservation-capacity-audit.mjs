#!/usr/bin/env node
/**
 * Contur3 — six-fixture reservation capacity audit (READ-ONLY).
 *
 * Purpose: prove, per PHYSICAL match, whether allowed full-match signals exist
 * in generated_signal_pairs and whether they join to a night_event_reservations
 * row. Built to diagnose reservation underfill when several matches share a
 * kickoff time (e.g. two 23:00 Minsk games) and when team names carry accents /
 * variants (Curaçao/Curacao, Côte d'Ivoire/Cote d'Ivoire) or market-title
 * suffixes (O/U, spread, halftime, corners).
 *
 * READ-ONLY: SELECT only. Never writes, never calls execution endpoints, never
 * places orders. Safe to run any time, including before a rebalance window.
 *
 * Requires (production /app has these): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   TARGET_START_FROM / TARGET_START_TO   ISO window for reservations/queue join
 *   SIGNAL_LOOKBACK_HOURS                 default 36
 *
 * NOTE ON TIER: score/coverage/Tier1 are COMPUTED by buildFireModelCandidates,
 * not stored on generated_signal_pairs. This script reports the RAW signal layer
 * (allowed full-match vs blocked market mix + key join). For the COMPUTED tier
 * per fixture, run the companion command printed at the end.
 *
 * Usage:
 *   npm run contur3:reservation-capacity-audit
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');
const SIGNAL_LOOKBACK_HOURS = Number(process.env.SIGNAL_LOOKBACK_HOURS ?? 36);

// Diacritic-insensitive token normalizer: Curaçao -> curacao, Côte d'Ivoire -> cotedivoire.
function norm(s) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents (ç->c, ô->o)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Six real FIFA fixtures. Each team carries every spelling/slug variant we may meet.
const FIXTURES = [
  { id: 'Curaçao vs Côte d’Ivoire', teams: [['curacao'], ['cotedivoire', 'ivoire', 'cotivoire', 'coteivoire']] },
  { id: 'Ecuador vs Germany',       teams: [['ecuador'], ['germany', 'deutschland']] },
  { id: 'Japan vs Sweden',          teams: [['japan'], ['sweden']] },
  { id: 'Tunisia vs Netherlands',   teams: [['tunisia'], ['netherlands', 'holland']] },
  { id: 'Türkiye vs United States', teams: [['turkiye', 'turkey'], ['unitedstates', 'usa', 'unitedstatesofamerica']] },
  { id: 'Paraguay vs Australia',    teams: [['paraguay'], ['australia']] },
];

// Market classification on normalized title text.
const BLOCKED_RE = /halftime|halftimeresult|firsthalf|1sthalf|secondhalf|2ndhalf|corner|exactscore|correctscore|goalscorer|scorer|playerprop|outright|future|bttsbothteams|bothteamstoscore|btts/;
const ALLOWED_FULLMATCH_RE = /moneyline|matchwinner|towin|winner|spread|handicap|totalgoals|overunder|ou|total/;

function classifyMarket(titleNorm) {
  if (BLOCKED_RE.test(titleNorm)) return 'BLOCKED';
  if (titleNorm.includes('corner')) return 'BLOCKED';
  if (ALLOWED_FULLMATCH_RE.test(titleNorm)) return 'ALLOWED_FULLMATCH';
  return 'UNKNOWN';
}

function teamMatch(textNorm, teamVariants) {
  return teamVariants.some((v) => textNorm.includes(v));
}

// A row belongs to a fixture if BOTH team groups appear, OR (single-team market)
// exactly one team group appears and the other does not belong to a different
// listed fixture — recorded separately as single-team for transparency.
function fixtureOf(textNorm) {
  for (const fx of FIXTURES) {
    const aHit = teamMatch(textNorm, fx.teams[0]);
    const bHit = teamMatch(textNorm, fx.teams[1]);
    if (aHit && bHit) return { fx, kind: 'BOTH' };
  }
  for (const fx of FIXTURES) {
    const aHit = teamMatch(textNorm, fx.teams[0]);
    const bHit = teamMatch(textNorm, fx.teams[1]);
    if (aHit || bHit) return { fx, kind: 'SINGLE' };
  }
  return null;
}

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

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('CAPACITY_AUDIT_NO_DB: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read-only). Run on Railway /app.');
    process.exit(2);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const nowMs = Date.now();
  const fromIso = process.env.TARGET_START_FROM ?? new Date(nowMs - 6 * 3_600_000).toISOString();
  const toIso = process.env.TARGET_START_TO ?? new Date(nowMs + 12 * 3_600_000).toISOString();
  const signalSinceIso = new Date(nowMs - SIGNAL_LOOKBACK_HOURS * 3_600_000).toISOString();

  console.log('\n=== CONTUR3 RESERVATION CAPACITY AUDIT (read-only) ===');
  console.log(`generated_at:   ${new Date(nowMs).toISOString()}`);
  console.log(`signal_lookback:${SIGNAL_LOOKBACK_HOURS}h since ${signalSinceIso}`);
  console.log(`res/queue win:  ${fromIso} .. ${toIso}`);

  const failed = [];
  const signalsQ = await selectAll(supabase, 'generated_signal_pairs', (q) => q.gte('created_at', signalSinceIso));
  if (signalsQ.failed) failed.push(`generated_signal_pairs:${signalsQ.error}`);
  const resQ = await selectAll(supabase, 'night_event_reservations', (q) =>
    q.gte('game_start_iso', fromIso).lte('game_start_iso', toIso));
  if (resQ.failed) failed.push(`night_event_reservations:${resQ.error}`);
  const queueQ = await selectAll(supabase, 'event_execution_queue', (q) =>
    q.gte('game_start_iso', fromIso).lte('game_start_iso', toIso));
  if (queueQ.failed) failed.push(`event_execution_queue:${queueQ.error}`);

  // Per-fixture aggregation over raw signal rows.
  const agg = new Map(FIXTURES.map((fx) => [fx.id, {
    raw: 0, both: 0, single: 0, allowed_fullmatch: 0, blocked: 0, unknown: 0,
    best_market: null, sample_slugs: new Set(),
  }]));

  for (const s of signalsQ.rows) {
    const text = `${s.event_slug ?? ''} ${s.market_slug ?? ''} ${s.selected_outcome ?? ''}`;
    const tn = norm(text);
    const hit = fixtureOf(tn);
    if (!hit) continue;
    const a = agg.get(hit.fx.id);
    a.raw += 1;
    if (hit.kind === 'BOTH') a.both += 1; else a.single += 1;
    const cls = classifyMarket(tn);
    if (cls === 'ALLOWED_FULLMATCH') { a.allowed_fullmatch += 1; if (!a.best_market) a.best_market = s.market_slug ?? s.event_slug; }
    else if (cls === 'BLOCKED') a.blocked += 1;
    else a.unknown += 1;
    if (a.sample_slugs.size < 4) a.sample_slugs.add(s.market_slug ?? s.event_slug ?? '');
  }

  // Reservation / queue join by normalized team membership.
  function reservationFor(fx) {
    return resQ.rows.find((r) => {
      const tn = norm(`${r.event_title ?? ''} ${r.match_family_key ?? ''} ${r.event_slug ?? ''}`);
      return teamMatch(tn, fx.teams[0]) && teamMatch(tn, fx.teams[1]);
    });
  }
  function queueFor(fx) {
    return queueQ.rows.filter((r) => {
      const tn = norm(`${r.event_title ?? ''} ${r.match_family_key ?? ''} ${r.event_slug ?? ''}`);
      return teamMatch(tn, fx.teams[0]) && teamMatch(tn, fx.teams[1]);
    });
  }

  console.log('\n--- SIX-FIXTURE COVERAGE (raw signal layer) ---');
  console.log('fixture | raw | both | single | allowed_fullmatch | blocked | unknown | reserved | res_status | queue | verdict');
  const report = [];
  for (const fx of FIXTURES) {
    const a = agg.get(fx.id);
    const res = reservationFor(fx);
    const queue = queueFor(fx);
    let verdict;
    if (res) verdict = queue.length ? 'RESERVED_AND_QUEUED' : 'RESERVED_OK';
    else if (a.allowed_fullmatch > 0) verdict = 'TRUE_MISSING_RESERVATION_HAS_ALLOWED_FULLMATCH';
    else if (a.blocked > 0 && a.allowed_fullmatch === 0) verdict = 'ONLY_BLOCKED_MARKETS_NO_ANCHOR';
    else if (a.raw === 0) verdict = 'NO_SIGNAL_ROWS_FOUND';
    else verdict = 'SIGNALS_PRESENT_MARKET_CLASS_UNKNOWN';
    const line = `${fx.id} | ${a.raw} | ${a.both} | ${a.single} | ${a.allowed_fullmatch} | ${a.blocked} | ${a.unknown} | ${res ? 'YES' : 'NO'} | ${res?.status ?? '-'} | ${queue.length} | ${verdict}`;
    console.log(line);
    report.push({
      fixture: fx.id, ...a, sample_slugs: [...a.sample_slugs],
      reserved: !!res, reservation_status: res?.status ?? null,
      reservation_key: res?.match_family_key ?? null,
      reservation_start: res?.game_start_iso ?? null,
      queue_rows: queue.length, verdict,
    });
  }

  const expected = FIXTURES.length;
  const reservedCount = report.filter((r) => r.reserved).length;
  const trueMissing = report.filter((r) => r.verdict === 'TRUE_MISSING_RESERVATION_HAS_ALLOWED_FULLMATCH');

  console.log('\n--- SUMMARY ---');
  console.log(`expected_physical_matches:        ${expected}`);
  console.log(`reserved_physical_matches:        ${reservedCount}`);
  console.log(`true_missing_with_allowed_anchor: ${trueMissing.length}  [${trueMissing.map((r) => r.fixture).join(', ') || '-'}]`);
  console.log(`reservations_in_window(total):    ${resQ.rows.length}`);
  console.log(`signals_scanned:                  ${signalsQ.rows.length}`);
  if (failed.length) console.log(`PARTIAL_TABLE_READ_FAILURE: ${failed.join(', ')}`);

  let machineVerdict;
  if (failed.length) machineVerdict = 'AUDIT_PARTIAL_DB_FAILURE';
  else if (trueMissing.length > 0) machineVerdict = 'TRUE_RESERVATION_UNDERFILL';
  else if (reservedCount >= expected) machineVerdict = 'FULL_COVERAGE';
  else machineVerdict = 'UNDERFILL_BUT_NO_ALLOWED_ANCHOR_MISSING';
  console.log(`MACHINE_VERDICT: ${machineVerdict}`);

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outPath = path.join(LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}Z_capacity_audit.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date(nowMs).toISOString(),
    window: { from: fromIso, to: toIso }, signal_lookback_hours: SIGNAL_LOOKBACK_HOURS,
    expected, reserved: reservedCount, true_missing: trueMissing.map((r) => r.fixture),
    machine_verdict: machineVerdict, failed_tables: failed, fixtures: report,
  }, null, 2), 'utf-8');
  console.log(`\nwrote: ${outPath}`);

  console.log('\n--- COMPANION: COMPUTED-TIER PROOF (run separately for score/coverage/tier) ---');
  console.log('  The RAW layer above cannot show computed Tier1 (score>=72 & cov>=50 live in code,');
  console.log('  not in the DB). To prove the builder tier per fixture, run on /app:');
  console.log('  npm run contur3:reservation-tier-probe');
}

main().catch((err) => {
  console.error('reservation-capacity-audit failed:', err);
  process.exit(1);
});
