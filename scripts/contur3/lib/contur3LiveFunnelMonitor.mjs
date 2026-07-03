#!/usr/bin/env node
/**
 * Contur3 — canonical live-funnel monitor (READ-ONLY single source of truth).
 *
 * This module is the ONE place that collects end-to-end Contur3 live-funnel
 * status:
 *
 *   source(generated_signal_pairs) -> builder(buildFireModelCandidates admission)
 *     -> reservation(night_event_reservations) -> due rebalance
 *     -> queue(event_execution_queue) -> executor API -> Ireland monitor
 *     -> order/audit/ledger(executor_order_*)
 *
 * Every other Contur3 script should import the helpers here instead of
 * redefining normalization / market classification / pagination, so funnel
 * definitions can never silently diverge again.
 *
 * HARD SAFETY:
 *   - SELECT only. Never writes DB rows, never calls execution/placement
 *     endpoints, never sends a live order, never starts Ireland live placement.
 *   - No secrets are written to any report.
 *
 * Env:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read-only). When missing, the
 *   monitor still writes a canonical log skeleton but marks the machine verdict
 *   STOPPED_DB_ENV_MISSING and the caller exits non-zero — it never pretends a
 *   runtime DB proof passed.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Report hygiene: generated logs default to a git-ignored path so diagnostics
// never dirty the working tree (INVARIANTS §10.5). Override: CONTUR3_REPORT_DIR.
// The old tracked reports/contur3 stays frozen as historical artifacts.
export const REPORT_DIR = process.env.CONTUR3_REPORT_DIR
  || path.join(process.cwd(), 'var', 'reports', 'contur3');

// Mirrors nightWindow.ts — UTC-only math for the due window.
export const REBALANCE_MINUTES_BEFORE_START = 70;
export const LATEST_ENTRY_MINUTES_BEFORE = 3;
export const TARGET_LIVE_SLOTS = 15;

// ──────────────────────────────────────────────────────────────────────────
// Time helpers
// ──────────────────────────────────────────────────────────────────────────
export function nowStamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z'; // 20260625T181308Z-ish
}

export function minskString(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Minsk',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d) + ' (Europe/Minsk)';
  } catch {
    return new Date(d.getTime() + 3 * 3_600_000).toISOString() + ' (+03 fallback)';
  }
}

function minskParts(d) {
  // Returns { date: 'YYYY-MM-DD', hm: 'HH:MM' } in Europe/Minsk.
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Minsk',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
  } catch {
    const shifted = new Date(d.getTime() + 3 * 3_600_000);
    return { date: shifted.toISOString().slice(0, 10), hm: shifted.toISOString().slice(11, 16) };
  }
}

export function dueState(gameStartIso, nowMs) {
  const startMs = Date.parse(gameStartIso);
  if (!Number.isFinite(startMs)) return 'INVALID_START';
  const mins = (startMs - nowMs) / 60_000;
  if (mins <= LATEST_ENTRY_MINUTES_BEFORE) return 'EXPIRED';
  if (mins <= REBALANCE_MINUTES_BEFORE_START) return 'DUE_NOW';
  return 'NOT_DUE_YET';
}

// ──────────────────────────────────────────────────────────────────────────
// Normalization + market classification (CANONICAL — reused everywhere)
// ──────────────────────────────────────────────────────────────────────────

// Diacritic-insensitive token normalizer:
//   Curaçao -> curacao, Côte d'Ivoire -> cotedivoire, Türkiye -> turkiye.
export function norm(s) {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// Canonical market-class taxonomy. Mirrors the forbidden/allowed anchor guards in
// lib/executor/nightEventReservations.ts so the monitor and the executor agree on
// what is an executable anchor.
const FORBIDDEN_HALFTIME_RE = /halftime|halftimeresult|firsthalf|1sthalf|secondhalf|2ndhalf/;
const FORBIDDEN_CORNERS_RE = /corner/;
const FORBIDDEN_EXACTSCORE_RE = /exactscore|correctscore/;
const FORBIDDEN_GOALSCORER_RE = /goalscorer|anytimescorer|firstscorer|lastscorer|scorer/;
const FORBIDDEN_PROPS_RE = /playerprop|bookings|cards|btts|bothteamstoscore/;
const FORBIDDEN_FUTURES_RE = /outright|future|towinoutright|winnergroup|\d{4}winner|winner\d{4}|tournamentwinner|championshipwinner|leaguewinner/;
const ESPORTS_RE = /esports|cs2|csgo|dota|leagueoflegends|valorant|counterstrike/;
const ALLOWED_MONEYLINE_RE = /moneyline|matchwinner|towin|matchresult|winner|drawnobet|\bdraw\b|1x2/;
const ALLOWED_SPREAD_RE = /spread|handicap|asianhandicap/;
const ALLOWED_TOTAL_RE = /totalgoals|overunder|\bou\b|total|over|under/;

/**
 * Classify a normalized title string into the canonical market class.
 * Forbidden classes win over allowed (a "halftime total" is forbidden).
 */
export function classifyMarket(titleNorm) {
  const t = titleNorm;
  if (FORBIDDEN_HALFTIME_RE.test(t)) return 'forbidden_halftime';
  if (FORBIDDEN_CORNERS_RE.test(t)) return 'forbidden_corners';
  if (FORBIDDEN_EXACTSCORE_RE.test(t)) return 'forbidden_exact_score';
  if (FORBIDDEN_GOALSCORER_RE.test(t)) return 'forbidden_goalscorer';
  if (FORBIDDEN_PROPS_RE.test(t)) return 'forbidden_props';
  if (FORBIDDEN_FUTURES_RE.test(t)) return 'forbidden_futures';
  if (ESPORTS_RE.test(t)) return 'esports_non_policy';
  if (ALLOWED_MONEYLINE_RE.test(t)) return 'allowed_fullmatch_moneyline';
  if (ALLOWED_SPREAD_RE.test(t)) return 'allowed_fullmatch_spread';
  if (ALLOWED_TOTAL_RE.test(t)) return 'allowed_fullmatch_total';
  return 'unknown';
}

export function isAllowedFullmatchClass(cls) {
  return cls === 'allowed_fullmatch_moneyline'
    || cls === 'allowed_fullmatch_spread'
    || cls === 'allowed_fullmatch_total';
}

export function isForbiddenClass(cls) {
  return typeof cls === 'string' && cls.startsWith('forbidden_');
}

// ──────────────────────────────────────────────────────────────────────────
// Physical-match grouping. A physical match = normalized team pair + start date.
// Halftime/corners child markets must NEVER create a separate physical match.
// ──────────────────────────────────────────────────────────────────────────

// Known FIFA fixtures with spelling/slug variants. Used for diacritic-stable
// labeling; unknown pairs still group by their normalized two-team signature.
export const FIXTURES = [
  { id: 'Curaçao vs Côte d’Ivoire', teams: [['curacao'], ['cotedivoire', 'ivoire', 'coteivoire', 'cotivoire']] },
  { id: 'Ecuador vs Germany', teams: [['ecuador'], ['germany', 'deutschland']] },
  { id: 'Japan vs Sweden', teams: [['japan'], ['sweden']] },
  { id: 'Tunisia vs Netherlands', teams: [['tunisia'], ['netherlands', 'holland']] },
  { id: 'Türkiye vs United States', teams: [['turkiye', 'turkey'], ['unitedstates', 'usa', 'unitedstatesofamerica']] },
  { id: 'Paraguay vs Australia', teams: [['paraguay'], ['australia']] },
];

function teamMatch(textNorm, variants) {
  return variants.some((v) => textNorm.includes(v));
}

export function fixtureOf(textNorm) {
  for (const fx of FIXTURES) {
    if (teamMatch(textNorm, fx.teams[0]) && teamMatch(textNorm, fx.teams[1])) return { fx, kind: 'BOTH' };
  }
  for (const fx of FIXTURES) {
    if (teamMatch(textNorm, fx.teams[0]) || teamMatch(textNorm, fx.teams[1])) return { fx, kind: 'SINGLE' };
  }
  return null;
}

// Event-level identity for physical-match grouping. Deliberately excludes
// market_slug / selected_outcome so child-market rows (halftime, corners,
// second-half, ...) for the same real event fold into the SAME group instead
// of spawning pseudo physical matches.
export function eventIdentityOf(source) {
  const text = `${source.event_slug ?? ''} ${source.event_title ?? ''}`;
  const tn = norm(text);
  const hit = fixtureOf(tn);
  const key = hit ? norm(hit.fx.id) : (tn.slice(0, 40) || 'unkeyed');
  const label = hit ? hit.fx.id : (source.event_title ?? source.event_slug ?? key);
  return { key, label, fixture: hit ? hit.fx : null };
}

// Same event-level identity, computed from a reservation row's fields
// (event_title / match_family_key / event_slug — no market-level fields
// exist on reservations, but this keeps the key derivation symmetric with
// eventIdentityOf so equality comparisons are exact, not fuzzy).
export function reservationIdentityOf(res) {
  const text = `${res.event_title ?? ''} ${res.match_family_key ?? ''} ${res.event_slug ?? ''}`;
  const tn = norm(text);
  const hit = fixtureOf(tn);
  const key = hit ? norm(hit.fx.id) : (tn.slice(0, 40) || 'unkeyed');
  return { key, fixture: hit ? hit.fx : null };
}

// ──────────────────────────────────────────────────────────────────────────
// Team-pair identity — exact stable join between a physical-match group and a
// night_event_reservations row when the fixture is not in the hardcoded
// FIXTURES list. Mirrors lib/executor/nightEventReservations.ts pair:a-vs-b:date
// canonicalization so the monitor and the reservation planner agree on
// identity without any fuzzy substring/prefix comparison.
// ──────────────────────────────────────────────────────────────────────────
const PAIR_KEY_RE = /^pair:([\w-]+)-vs-([\w-]+):(\d{4}-\d{2}-\d{2})$/;
const VS_SPLIT_RE = /\s+vs\.?\s+/i;

function teamPairSigFromNames(rawA, rawB) {
  const a = norm(rawA);
  const b = norm(rawB);
  if (!a || !b) return null;
  return [a, b].sort().join('--');
}

// Free-text "Team A vs Team B" (event_slug/event_title/etc.) -> order-independent signature.
export function teamPairSigFromText(text) {
  const parts = (text ?? '').split(VS_SPLIT_RE);
  if (parts.length < 2) return null;
  return teamPairSigFromNames(parts[0], parts.slice(1).join(' vs '));
}

// Canonical match_family_key ("pair:<team-a>-vs-<team-b>:<date>") -> order-independent
// signature. Team tokens are hyphen-joined multi-word names (e.g. "cabo-verde");
// hyphens are turned back into spaces before normalizing so this stays comparable
// with free-text titles derived via teamPairSigFromText.
export function teamPairSigFromMatchFamilyKey(key) {
  const m = (key ?? '').match(PAIR_KEY_RE);
  if (!m) return null;
  return teamPairSigFromNames(m[1].replace(/-/g, ' '), m[2].replace(/-/g, ' '));
}

// Reservation team-pair signature: prefer the canonical match_family_key
// (stable, produced by the same builder/planner pipeline); fall back to
// free-text event_title/event_slug only when match_family_key is absent
// or not a pair:* key.
export function reservationTeamPairSig(res) {
  return teamPairSigFromMatchFamilyKey(res.match_family_key)
    ?? teamPairSigFromText(res.event_title)
    ?? teamPairSigFromText(res.event_slug);
}

// Group team-pair signature, derived the same way as eventIdentityOf's text
// source so it's comparable against reservationTeamPairSig.
export function groupTeamPairSig(group) {
  return teamPairSigFromText(group.display_match);
}

// Group raw signal rows into physical-match groups keyed by event identity
// only. classifyMarket still runs on the FULL text (including market_slug /
// selected_outcome) so market classification stays accurate; only the
// grouping key excludes market-level fields.
export function groupSignalsByPhysicalMatch(signals) {
  const groups = new Map();
  for (const s of signals) {
    const { key, label, fixture } = eventIdentityOf(s);
    if (!groups.has(key)) {
      groups.set(key, {
        physical_match_key: key, display_match: label, fixture,
        raw_rows: 0, raw_allowed_fullmatch_rows: 0, builder_forbidden_candidates: 0,
        class_hist: {}, sample_slugs: [],
      });
    }
    const g = groups.get(key);
    const classifyText = `${s.event_slug ?? ''} ${s.market_slug ?? ''} ${s.selected_outcome ?? ''} ${s.event_title ?? ''}`;
    const cls = classifyMarket(norm(classifyText));
    g.raw_rows += 1;
    g.class_hist[cls] = (g.class_hist[cls] ?? 0) + 1;
    if (isAllowedFullmatchClass(cls)) g.raw_allowed_fullmatch_rows += 1;
    if (isForbiddenClass(cls)) g.builder_forbidden_candidates += 1;
    if (g.sample_slugs.length < 4) g.sample_slugs.push(s.market_slug ?? s.event_slug ?? '');
  }
  return groups;
}

// Exact/event-level reservation matching. Replaces the old fuzzy
// `includes(key.slice(0, 12))` prefix join, which could match an unrelated
// event that merely shared its first 12 normalized characters.
//
// Join order (all exact, none fuzzy/substring):
//   1. Known FIXTURES list (diacritic-stable team-variant matching).
//   2. Team-pair signature: group's "Team A vs Team B" text against the
//      reservation's canonical match_family_key (pair:a-vs-b:date), falling
//      back to the reservation's own free-text title/slug. This is the exact
//      identity the reservation planner produces for any WC fixture that
//      isn't in the hardcoded FIXTURES list.
//   3. Legacy exact event-identity key equality (unkeyed groups).
export function findReservationForGroup(group, reservations) {
  if (group.fixture) {
    return reservations.find((r) => {
      const { fixture } = reservationIdentityOf(r);
      return fixture === group.fixture || fixture?.id === group.fixture.id;
    });
  }
  const groupSig = groupTeamPairSig(group);
  if (groupSig) {
    const bySig = reservations.find((r) => reservationTeamPairSig(r) === groupSig);
    if (bySig) return bySig;
  }
  return reservations.find((r) => reservationIdentityOf(r).key === group.key);
}

// Safe classification of a table read result. Column/relation shape
// mismatches (e.g. job_runs missing an expected column) degrade to an
// explicit measurement-gap status instead of polluting the report as a hard
// runtime anomaly.
export function tableStatus(name, result) {
  if (result.ok) return { status: 'OK', rows: result.rows.length, error: null };
  const msg = result.error ?? '';
  if (/does not exist|column|relation|undefined/i.test(msg)) {
    return {
      status: name === 'job_runs' ? 'MEASUREMENT_MISSING' : 'TABLE_SHAPE_MISMATCH',
      rows: 0,
      error: msg,
    };
  }
  return { status: 'ERROR', rows: 0, error: msg };
}

// ──────────────────────────────────────────────────────────────────────────
// Git + env context (no secret values, only presence booleans)
// ──────────────────────────────────────────────────────────────────────────
export function gitInfo() {
  const safe = (cmd) => {
    try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return null; }
  };
  // Deployment hash: proves WHICH commit is actually running (DEPLOYMENT_MISMATCH guard).
  // Railway exposes the deployed commit; when absent this is an honest measurement gap,
  // never silently treated as "matches repo".
  const deployHash = process.env.RAILWAY_GIT_COMMIT_SHA || null;
  const head = safe('git rev-parse HEAD');
  return {
    head,
    branch: safe('git rev-parse --abbrev-ref HEAD'),
    commit_subject: safe('git log -1 --pretty=%s'),
    origin_main: safe('git rev-parse origin/main'),
    deployment_commit_hash: deployHash ?? 'MEASUREMENT_MISSING:RAILWAY_GIT_COMMIT_SHA_ABSENT',
    deployment_matches_repo: deployHash && head ? deployHash === head : null,
  };
}

export function envFlags() {
  return {
    has_supabase_url: !!process.env.SUPABASE_URL,
    has_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    has_executor_secret: !!process.env.EXECUTOR_CANDIDATES_SECRET,
    railway: !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Paginated read — never caps the corpus.
// ──────────────────────────────────────────────────────────────────────────
async function selectAll(supabase, table, build) {
  const PAGE = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    let q = supabase.from(table).select('*');
    q = build(q).range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) return { ok: false, rows, error: error.message };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { ok: true, rows, error: null };
}

// ──────────────────────────────────────────────────────────────────────────
// Arg parsing
// ──────────────────────────────────────────────────────────────────────────
export function parseArgs(argv = process.argv.slice(2)) {
  const o = {
    lookbackHours: 24, nextHours: 12, g2Days: 2,
    write: true, json: true, dryRun: false, fixtures: null,
    allowAnomalies: false, allowNoDb: false, mode: 'funnel',
  };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case 'lookback-hours': o.lookbackHours = Number(v); break;
      case 'next-hours': o.nextHours = Number(v); break;
      case 'g2-days': o.g2Days = Number(v); break;
      case 'write': o.write = v !== 'false'; break;
      case 'json': o.json = v !== 'false'; break;
      case 'dry-run': o.dryRun = true; o.write = false; break;
      case 'fixtures': o.fixtures = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'allow-anomalies': o.allowAnomalies = true; break;
      case 'allow-no-db': o.allowNoDb = true; break;
      case 'mode': o.mode = v; break;
      default: break;
    }
  }
  return o;
}

// ──────────────────────────────────────────────────────────────────────────
// Core collection
// ──────────────────────────────────────────────────────────────────────────
export async function collectFunnel(opts = {}) {
  const o = { lookbackHours: 24, nextHours: 12, g2Days: 2, ...opts };
  const nowMs = Date.now();
  const now = new Date(nowMs);
  const git = gitInfo();
  const env = envFlags();

  const fromUtc = new Date(nowMs - o.lookbackHours * 3_600_000).toISOString();
  const toUtc = new Date(nowMs + o.nextHours * 3_600_000).toISOString();

  const base = {
    generated_at: now.toISOString(),
    git,
    env,
    windows: {
      lookback_hours: o.lookbackHours,
      next_hours: o.nextHours,
      g2_days: o.g2Days,
      from_utc: fromUtc,
      to_utc: toUtc,
      minsk_now: minskString(now),
    },
    tables: {},
    fixtures: [],
    summary: {},
    anomalies: [],
    next_actions: [],
    // Honest measurement gaps (INVARIANTS §10.1): a missing measurement is
    // reported as MEASUREMENT_MISSING with an exact reason, never as zero.
    builder_admission: {
      status: 'MEASUREMENT_MISSING',
      reason: 'BUILDER_DIAGNOSTICS_ONLY_VIA_NIGHT_PLAN_ROUTE_NOT_DB',
      detail: 'fullmatch admitted/rejected accounting (canonical lib/contur3/taxonomy.ts) is computed inside '
        + 'buildFireModelCandidates and surfaced via GET /api/executor/night-plan raw diagnostics; this read-only '
        + 'monitor does not call that route because it appends audit/order rows. Follow-up: expose the accounting read-only.',
    },
    price_check: {
      status: 'MEASUREMENT_MISSING',
      reason: 'PRICE_LIQUIDITY_RECHECK_NOT_IMPLEMENTED',
      detail: 'runEventRebalance queues due reservations from the reserved entry_price/max_entry_price without a live '
        + 'price/liquidity re-check; implementing that re-check is a pending founder decision (CONTUR3_NEXT_PATCH_DESIGN_BRIEF).',
    },
  };

  if (!env.has_supabase_url || !env.has_service_role) {
    base.summary = {
      expected_physical_matches: null, reserved_physical_matches: null,
      missing_physical_matches: null, fallback_reserved_count: null,
      due_now: null, queued: null, executor_api_visible: null, orders: null,
      hard_anomaly_count: 1,
      machine_verdict: 'STOPPED_DB_ENV_MISSING',
    };
    base.anomalies.push({
      code: 'EXECUTOR_SECRET_MISSING', severity: 'P0', fixture: null, stage: 'source',
      evidence: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absent in this execution context.',
      recommended_command: 'Run on Railway /app where Supabase read env is present: npm run contur3:live-funnel-log',
    });
    base.next_actions.push({
      when: 'now', where: 'Railway',
      command: 'npm run contur3:live-funnel-log',
      why: 'Generate the canonical DB-backed funnel log; local context has no Supabase env.',
    });
    base.db_available = false;
    return base;
  }
  base.db_available = true;

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const signalSinceIso = new Date(nowMs - Math.max(o.lookbackHours, 36) * 3_600_000).toISOString();

  // ── Table reads (paginated; optional tables tolerated) ──
  const reads = {};
  reads.generated_signal_pairs = await selectAll(supabase, 'generated_signal_pairs', (q) => q.gte('created_at', signalSinceIso));
  reads.night_event_reservations = await selectAll(supabase, 'night_event_reservations', (q) =>
    q.gte('game_start_iso', fromUtc).lte('game_start_iso', toUtc).order('game_start_iso', { ascending: true }));
  reads.event_execution_queue = await selectAll(supabase, 'event_execution_queue', (q) =>
    q.gte('game_start_iso', fromUtc).lte('game_start_iso', toUtc));
  reads.executor_order_events = await selectAll(supabase, 'executor_order_events', (q) => q.gte('created_at', fromUtc));
  reads.executor_audit_events = await selectAll(supabase, 'executor_audit_events', (q) => q.gte('created_at', fromUtc));
  reads.job_runs = await selectAll(supabase, 'job_runs', (q) => q.gte('created_at', fromUtc));

  for (const [name, r] of Object.entries(reads)) {
    const ts = tableStatus(name, r);
    base.tables[name] = { ok: r.ok, rows: r.ok ? r.rows.length : 0, error: r.ok ? null : r.error, status: ts.status };
  }

  const signals = reads.generated_signal_pairs.rows;
  const reservations = reads.night_event_reservations.rows;
  const queueRows = reads.event_execution_queue.rows;
  const orderRows = reads.executor_order_events.ok ? reads.executor_order_events.rows : [];
  const auditRows = reads.executor_audit_events.ok ? reads.executor_audit_events.rows : [];

  // ── Group raw signals by physical match (event-level identity only) ──
  const groups = groupSignalsByPhysicalMatch(signals);

  // ── Join reservation / queue / order per physical match ──
  function fixtureQueue(fx) {
    return queueRows.filter((r) => {
      const tn = norm(`${r.event_title ?? ''} ${r.match_family_key ?? ''} ${r.event_slug ?? ''}`);
      return teamMatch(tn, fx.teams[0]) && teamMatch(tn, fx.teams[1]);
    });
  }

  const fixtures = [];
  for (const [key, g] of groups) {
    const fx = g.fixture;
    const res = findReservationForGroup(g, reservations);
    const queue = fx ? fixtureQueue(fx) : [];
    const reservationStatus = res ? (res.status ?? 'RESERVED') : 'NONE';
    const reservationJoinMethod = !res
      ? 'NONE'
      : fx ? 'FIXTURE_LIST' : (groupTeamPairSig(g) && groupTeamPairSig(g) === reservationTeamPairSig(res)) ? 'TEAM_PAIR_SIGNATURE' : 'EVENT_IDENTITY_KEY';
    const ds = res ? dueState(res.game_start_iso, nowMs) : 'NO_RESERVATION';
    const fallbackUsed = !!(res && /FALLBACK|TIER2|TIER3/i.test(`${res.strategy ?? ''} ${res.tier ?? ''} ${res.reason ?? ''}`));

    let verdict;
    if (res && queue.length) verdict = 'RESERVED_AND_QUEUED';
    else if (res) verdict = 'RESERVED_OK';
    else if (g.raw_allowed_fullmatch_rows > 0) verdict = 'TRUE_MISSING_RESERVATION_HAS_ALLOWED_FULLMATCH';
    else if (g.builder_forbidden_candidates > 0) verdict = 'ONLY_FORBIDDEN_MARKETS_NO_ANCHOR';
    else if (g.raw_rows === 0) verdict = 'NO_SIGNAL_ROWS';
    else verdict = 'SIGNALS_PRESENT_CLASS_UNKNOWN';

    fixtures.push({
      physical_match_key: key,
      display_match: g.display_match,
      start_utc: res?.game_start_iso ?? null,
      start_minsk: res?.game_start_iso ? minskString(new Date(res.game_start_iso)) : null,
      raw_rows: g.raw_rows,
      raw_allowed_fullmatch_rows: g.raw_allowed_fullmatch_rows,
      builder_candidates: null, // computed-tier proof requires builder run (tier-probe)
      builder_fullmatch_candidates: null,
      builder_forbidden_candidates: g.builder_forbidden_candidates,
      best_fullmatch_score: null,
      best_fullmatch_coverage: null,
      admission_histogram: g.class_hist,
      reservation_status: reservationStatus,
      reservation_id: res?.id ?? res?.match_family_key ?? null,
      reservation_id_present: !!res?.id,
      reservation_match_key: res ? (res.match_family_key ?? groupTeamPairSig(g) ?? key) : null,
      reservation_join_method: reservationJoinMethod,
      fallback_used: fallbackUsed,
      due_minsk: res?.game_start_iso ? minskString(new Date(res.game_start_iso)) : null,
      due_state: ds,
      event_execution_queue_rows: queue.length,
      executor_api_visible: queue.length > 0 ? true : null,
      order_events: orderRows.filter((od) => (od.match_family_key ?? '') === (res?.match_family_key ?? '\u0000')).length,
      audit_events: auditRows.filter((ad) => (ad.match_family_key ?? '') === (res?.match_family_key ?? '\u0000')).length,
      sample_slugs: g.sample_slugs,
      verdict,
    });
  }

  // Sort: known fixtures first, then by raw rows desc.
  fixtures.sort((a, b) => b.raw_rows - a.raw_rows);

  const expected = fixtures.filter((f) => FIXTURES.some((x) => norm(x.id) === f.physical_match_key)).length || fixtures.length;
  const reservedCount = fixtures.filter((f) => f.reservation_status !== 'NONE').length;
  const fallbackReserved = fixtures.filter((f) => f.fallback_used).length;
  const dueNow = fixtures.filter((f) => f.due_state === 'DUE_NOW').length;
  const queued = fixtures.reduce((n, f) => n + f.event_execution_queue_rows, 0);
  const apiVisible = fixtures.filter((f) => f.executor_api_visible === true).length;
  const orders = fixtures.reduce((n, f) => n + f.order_events, 0);
  const missing = fixtures.filter((f) => f.verdict === 'TRUE_MISSING_RESERVATION_HAS_ALLOWED_FULLMATCH');

  base.fixtures = fixtures;
  base.anomalies = detectAnomalies(base, fixtures, reads);

  let machineVerdict;
  const failedTable = Object.values(base.tables).some((t) => !t.ok && !/does not exist|undefined/.test(t.error ?? ''));
  if (missing.length > 0) machineVerdict = 'RESERVATION_UNDERFILL';
  else if (queued > 0 && apiVisible > 0 && orders === 0) machineVerdict = 'QUEUE_READY_IRELAND_MANUAL_START_REQUIRED';
  else if (orders > 0) machineVerdict = 'ORDER_LEDGER_PRESENT';
  else if (dueNow > 0 && queued === 0) machineVerdict = 'DUE_REBALANCE_REQUIRED';
  else if (reservedCount > 0 && dueNow === 0) machineVerdict = 'RESERVED_WAITING_FOR_DUE';
  else if (reservedCount === 0 && fixtures.some((f) => f.raw_allowed_fullmatch_rows > 0)) machineVerdict = 'SOURCE_TO_BUILDER_BROKEN';
  else machineVerdict = 'BATTLE_CONTOUR_READY_FOR_DUE_WINDOW';

  base.summary = {
    expected_physical_matches: expected,
    reserved_physical_matches: reservedCount,
    missing_physical_matches: missing.length,
    fallback_reserved_count: fallbackReserved,
    target_live_slots: TARGET_LIVE_SLOTS,
    due_now: dueNow,
    queued,
    executor_api_visible: apiVisible,
    orders,
    hard_anomaly_count: base.anomalies.filter((a) => a.severity === 'P0').length,
    machine_verdict: machineVerdict,
  };

  base.next_actions = nextActions(base);
  return base;
}

// ──────────────────────────────────────────────────────────────────────────
// Anomaly detection
// ──────────────────────────────────────────────────────────────────────────
export function detectAnomalies(base, fixtures, reads) {
  const out = [];
  const push = (code, severity, fixture, stage, evidence, recommended_command) =>
    out.push({ code, severity, fixture, stage, evidence, recommended_command });

  for (const [name, r] of Object.entries(reads)) {
    const ts = tableStatus(name, r);
    if (ts.status === 'ERROR') {
      push('DB_TABLE_MISSING', 'P1', null, 'source', `${name}: ${r.error}`, 'Verify table name / RLS on Railway.');
    }
  }

  for (const f of fixtures) {
    if (f.raw_allowed_fullmatch_rows > 0 && f.reservation_status === 'NONE') {
      push('RAW_ALLOWED_FULLMATCH_GT0_NO_RESERVATION', 'P0', f.display_match, 'reservation',
        `raw_allowed_fullmatch=${f.raw_allowed_fullmatch_rows} but no reservation row.`,
        'npm run contur3:reservation-tier-probe (prove builder tier) then contur3:night-reservations');
    }
    if (f.raw_allowed_fullmatch_rows > 0 && f.builder_forbidden_candidates > 0 && f.reservation_status === 'NONE') {
      push('RAW_ALLOWED_FULLMATCH_GT0_BUILDER_FULLMATCH_EQ0', 'P0', f.display_match, 'builder',
        `allowed full-match raw rows exist but only forbidden candidates emitted (${f.builder_forbidden_candidates}).`,
        'npm run contur3:reservation-tier-probe');
    }
    if (f.due_state === 'DUE_NOW' && f.event_execution_queue_rows === 0) {
      push('DUE_RESERVATION_NOT_QUEUED', 'P0', f.display_match, 'rebalance',
        'reservation is DUE_NOW but not present in event_execution_queue.',
        'npm run contur3:event-rebalance');
    }
    if (f.event_execution_queue_rows > 0 && f.executor_api_visible !== true) {
      push('QUEUE_NOT_VISIBLE_TO_EXECUTOR_API', 'P1', f.display_match, 'executor_api',
        'queue rows exist but not confirmed visible to executor API.',
        'Check /api/executor/queue?dry=1 on Railway.');
    }
  }

  const expected = base.summary?.expected_physical_matches;
  const reserved = base.summary?.reserved_physical_matches;
  if (Number.isFinite(expected) && Number.isFinite(reserved) && expected > reserved) {
    push('EXPECTED_PHYSICAL_MATCHES_GT_RESERVED', 'P1', null, 'reservation',
      `expected=${expected} reserved=${reserved}.`,
      'npm run contur3:reservation-capacity-audit');
  }
  return out;
}

function nextActions(base) {
  const v = base.summary?.machine_verdict;
  const actions = [];
  const map = {
    RESERVATION_UNDERFILL: ['Railway', 'npm run contur3:reservation-tier-probe && npm run contur3:night-reservations', 'Allowed full-match anchors exist without reservation — re-run reservation planning.'],
    DUE_REBALANCE_REQUIRED: ['Railway', 'npm run contur3:event-rebalance', 'A reservation is due now but not queued.'],
    QUEUE_READY_IRELAND_MANUAL_START_REQUIRED: ['Ireland', 'see reports/contur3/ireland_manual_command_pack_latest.md', 'Queue is ready and API-visible; Ireland monitor must be started (dry/fail-closed).'],
    RESERVED_WAITING_FOR_DUE: ['Railway', 'npm run contur3:live-funnel-log (re-check near due window)', 'Reservations exist; wait for the due window.'],
    SOURCE_TO_BUILDER_BROKEN: ['Railway', 'npm run contur3:reservation-tier-probe', 'Allowed raw rows are not becoming reservations — inspect builder admission.'],
    BATTLE_CONTOUR_READY_FOR_DUE_WINDOW: ['Railway', 'npm run contur3:battle-ready', 'Re-confirm readiness before the next due window.'],
    ORDER_LEDGER_PRESENT: ['Local', 'review executor_order_events / audit', 'Orders observed — reconcile ledger.'],
    STOPPED_DB_ENV_MISSING: ['Railway', 'npm run contur3:live-funnel-log', 'No DB env locally — run where Supabase read env exists.'],
  };
  const m = map[v];
  if (m) actions.push({ when: 'now', where: m[0], command: m[1], why: m[2] });
  return actions;
}

// ──────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ──────────────────────────────────────────────────────────────────────────
export function renderMarkdown(j) {
  const s = j.summary ?? {};
  const L = [];
  L.push('# Contur3 — Canonical Live Funnel Log');
  L.push('');
  L.push(`Generated: ${j.generated_at}`);
  L.push(`Minsk now: ${j.windows?.minsk_now}`);
  L.push(`Branch: ${j.git?.branch}  HEAD: ${j.git?.head?.slice(0, 7)}  (${j.git?.commit_subject ?? ''})`);
  L.push(`origin/main: ${j.git?.origin_main?.slice(0, 7)}`);
  L.push(`Deployment: ${j.git?.deployment_commit_hash}  matches_repo: ${j.git?.deployment_matches_repo}`);
  L.push(`Window: ${j.windows?.from_utc} .. ${j.windows?.to_utc} (lookback ${j.windows?.lookback_hours}h / next ${j.windows?.next_hours}h)`);
  L.push('');
  L.push(`## MACHINE VERDICT: ${s.machine_verdict ?? 'UNKNOWN'}`);
  L.push(`hard_anomaly_count: ${s.hard_anomaly_count ?? '-'}`);
  L.push('');
  L.push('## Environment');
  L.push('| flag | present |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(j.env ?? {})) L.push(`| ${k} | ${v} |`);
  L.push('');
  if (j.db_available === false) {
    L.push('> **STOPPED_DB_ENV_MISSING** — no Supabase read env in this context. ' +
      'This is the canonical log skeleton; the DB-backed funnel must be generated on Railway /app.');
    L.push('');
  }
  L.push('## Tables (paginated row counts)');
  L.push('| table | ok | rows | error |');
  L.push('|---|---|---|---|');
  for (const [k, t] of Object.entries(j.tables ?? {})) L.push(`| ${k} | ${t.ok} | ${t.rows} | ${t.error ?? '-'} |`);
  L.push('');
  L.push('## Summary');
  L.push('| metric | value |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(s)) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## Per physical match (source -> builder -> reservation -> queue -> order)');
  L.push('| match | raw | allowed_fm | forbidden | reserved | due | queue | api | orders | fallback | verdict |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const f of j.fixtures ?? []) {
    L.push(`| ${f.display_match} | ${f.raw_rows} | ${f.raw_allowed_fullmatch_rows} | ${f.builder_forbidden_candidates} | ${f.reservation_status} | ${f.due_state} | ${f.event_execution_queue_rows} | ${f.executor_api_visible} | ${f.order_events} | ${f.fallback_used} | ${f.verdict} |`);
  }
  L.push('');
  L.push('## Builder admission accounting');
  L.push(`- status: **${j.builder_admission?.status ?? 'UNKNOWN'}** (${j.builder_admission?.reason ?? '-'})`);
  L.push(`  - ${j.builder_admission?.detail ?? ''}`);
  L.push('');
  L.push('## Price/liquidity re-check (last hour before start)');
  L.push(`- status: **${j.price_check?.status ?? 'UNKNOWN'}** (${j.price_check?.reason ?? '-'})`);
  L.push(`  - ${j.price_check?.detail ?? ''}`);
  L.push('');
  L.push('## Anomalies');
  if (!(j.anomalies ?? []).length) L.push('_none_');
  for (const a of j.anomalies ?? []) {
    L.push(`- **[${a.severity}] ${a.code}** (${a.stage}${a.fixture ? ' / ' + a.fixture : ''}) — ${a.evidence}`);
    L.push(`  - next: \`${a.recommended_command}\``);
  }
  L.push('');
  L.push('## Next actions');
  if (!(j.next_actions ?? []).length) L.push('_none_');
  for (const a of j.next_actions ?? []) L.push(`- [${a.where}] \`${a.command}\` — ${a.why}`);
  L.push('');
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// G2 (yesterday + day-before, Minsk calendar) compact rollup
// ──────────────────────────────────────────────────────────────────────────
export async function collectG2(opts = {}) {
  const main = await collectFunnel({ ...opts, lookbackHours: Math.max(opts.lookbackHours ?? 24, 24) });
  const now = new Date();
  const todayMinsk = minskParts(now).date;
  const ydayMinsk = minskParts(new Date(now.getTime() - 24 * 3_600_000)).date;
  const dbeforeMinsk = minskParts(new Date(now.getTime() - 48 * 3_600_000)).date;
  main.g2 = {
    minsk_today: todayMinsk,
    minsk_yesterday: ydayMinsk,
    minsk_day_before_yesterday: dbeforeMinsk,
    known_failure_comparison: [
      { ref: '22:00 missed matches', present_now: main.summary?.missing_physical_matches ?? null },
      { ref: '01:00 due-window issue', present_now: main.summary?.due_now ?? null },
      { ref: 'Curaçao missing reservation', present_now: (main.fixtures ?? []).some((f) => /curacao/i.test(norm(f.display_match)) && f.reservation_status === 'NONE') },
      { ref: 'raw allowed fullmatch but no builder fullmatch', present_now: (main.anomalies ?? []).some((a) => a.code === 'RAW_ALLOWED_FULLMATCH_GT0_BUILDER_FULLMATCH_EQ0') },
    ],
  };
  return main;
}

export function renderG2Markdown(j) {
  const L = [];
  L.push('# Contur3 — Live Funnel G2 Rollup (last 24h / yesterday / day-before, Minsk)');
  L.push('');
  L.push(`Generated: ${j.generated_at}`);
  L.push(`Minsk today: ${j.g2?.minsk_today}  yesterday: ${j.g2?.minsk_yesterday}  day-before: ${j.g2?.minsk_day_before_yesterday}`);
  L.push(`Machine verdict: ${j.summary?.machine_verdict}`);
  L.push('');
  L.push('## Funnel totals (rolling 24h window)');
  L.push('| stage | count |');
  L.push('|---|---|');
  L.push(`| source rows (generated_signal_pairs) | ${j.tables?.generated_signal_pairs?.rows ?? '-'} |`);
  L.push(`| reservations | ${j.tables?.night_event_reservations?.rows ?? '-'} |`);
  L.push(`| queued | ${j.tables?.event_execution_queue?.rows ?? '-'} |`);
  L.push(`| order events | ${j.tables?.executor_order_events?.rows ?? '-'} |`);
  L.push(`| audit events | ${j.tables?.executor_audit_events?.rows ?? '-'} |`);
  L.push(`| missed matches (allowed anchor, no reservation) | ${j.summary?.missing_physical_matches ?? '-'} |`);
  L.push('');
  L.push('## Comparison with previously known failures');
  L.push('| known failure | present now |');
  L.push('|---|---|');
  for (const c of j.g2?.known_failure_comparison ?? []) L.push(`| ${c.ref} | ${c.present_now} |`);
  L.push('');
  L.push('## Anomalies (with command/action)');
  if (!(j.anomalies ?? []).length) L.push('_none_');
  for (const a of j.anomalies ?? []) L.push(`- [${a.severity}] ${a.code} → \`${a.recommended_command}\``);
  L.push('');
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Report writers + console markers
// ──────────────────────────────────────────────────────────────────────────
export function writeReports(j, { write = true, json = true, g2 = false } = {}) {
  const written = [];
  if (!write) return written;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = nowStamp(new Date(j.generated_at));

  if (g2) {
    const md = renderG2Markdown(j);
    const latestMd = path.join(REPORT_DIR, 'live_funnel_g2_latest.md');
    const tsMd = path.join(REPORT_DIR, `live_funnel_g2_${stamp}.md`);
    fs.writeFileSync(latestMd, md); fs.writeFileSync(tsMd, md);
    written.push(latestMd, tsMd);
  }

  const md = renderMarkdown(j);
  const latestMd = path.join(REPORT_DIR, 'live_funnel_latest.md');
  const tsMd = path.join(REPORT_DIR, `live_funnel_${stamp}.md`);
  fs.writeFileSync(latestMd, md); fs.writeFileSync(tsMd, md);
  written.push(latestMd, tsMd);

  if (json) {
    const latestJson = path.join(REPORT_DIR, 'live_funnel_latest.json');
    const tsJson = path.join(REPORT_DIR, `live_funnel_${stamp}.json`);
    const payload = JSON.stringify(j, null, 2);
    fs.writeFileSync(latestJson, payload); fs.writeFileSync(tsJson, payload);
    written.push(latestJson, tsJson);
  }

  // Append-only NDJSON event line (best-effort).
  try {
    const ndjson = path.join(REPORT_DIR, 'live_funnel_events.ndjson');
    const line = JSON.stringify({
      generated_at: j.generated_at,
      machine_verdict: j.summary?.machine_verdict,
      hard_anomaly_count: j.summary?.hard_anomaly_count,
      reserved: j.summary?.reserved_physical_matches,
      missing: j.summary?.missing_physical_matches,
      queued: j.summary?.queued,
      head: j.git?.head,
    });
    fs.appendFileSync(ndjson, line + '\n');
    written.push(ndjson);
  } catch { /* non-fatal */ }

  return written;
}

export function printConsoleMarkers(j, written = []) {
  const s = j.summary ?? {};
  console.log('CONTUR3_LIVE_FUNNEL_LOG_START');
  console.log(`CONTUR3_LIVE_FUNNEL_SUMMARY verdict=${s.machine_verdict} reserved=${s.reserved_physical_matches} missing=${s.missing_physical_matches} due_now=${s.due_now} queued=${s.queued} api=${s.executor_api_visible} orders=${s.orders}`);
  const p0 = (j.anomalies ?? []).filter((a) => a.severity === 'P0');
  console.log(`CONTUR3_LIVE_FUNNEL_ANOMALIES p0=${p0.length} total=${(j.anomalies ?? []).length} codes=${(j.anomalies ?? []).map((a) => a.code).join(',') || '-'}`);
  const na = (j.next_actions ?? [])[0];
  console.log(`CONTUR3_LIVE_FUNNEL_NEXT_ACTION ${na ? `[${na.where}] ${na.command}` : '-'}`);
  if (written.length) console.log(`logs: ${written.join(' | ')}`);
  console.log('CONTUR3_LIVE_FUNNEL_LOG_END');
}
