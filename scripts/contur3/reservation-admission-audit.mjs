#!/usr/bin/env node
/**
 * Contur3 / Blue_model — Reservation Positive Admission Audit.
 *
 * Queries generated_signal_pairs and classifies every upcoming football/WC/soccer
 * candidate through the same funnel as buildFireModelCandidates + nightEventReservations.
 *
 * Purpose: PROVE that valid markets (spread/moneyline/total) are admitted, and
 * identify exactly which stage blocks any valid candidate.
 *
 * Funnel stages:
 *   DB_ROW → SCOPE_CLASSIFIED → GAME_START_PRESENT → SCORE_TIER → NOT_FORBIDDEN_ANCHOR
 *          → EXECUTABLE_ANCHOR_CANDIDATE → RESERVATION_ADMITTED
 *
 * Outputs:
 *   - JSON: <timestamp>_reservation_admission_audit.json
 *   - MD:   <timestamp>_reservation_admission_audit.md
 *   - CSV:  <timestamp>_reservation_admission_audit.csv
 *
 * Usage: npm run contur3:reservation-admission-audit
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'modeling', 'fire_runs', 'contur3-blue-model');
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '36', 10);
const HORIZON_HOURS  = parseInt(process.env.HORIZON_HOURS  ?? '24', 10);

// ── Mirror regexes from buildFireModelCandidates.ts ──────────────────────────
const WC_EXPLICIT_RE   = /\bfifwc\b|world[\s-]?cup|wc2026|\bfifa\b/i;
const WC_COUNTRY_RE    = /\b(france|senegal|iraq|norway|argentina|algeria|austria|jordan|saudi[\s-]arabia|uruguay|iran|new[\s-]zealand|spain|cape[\s-]verde|belgium|egypt|portugal|england|croatia|ghana|panama|colombia|uzbekistan|dr[\s-]congo|germany|ecuador|netherlands|sweden|japan|tunisia|mexico|south[\s-]korea|canada|qatar|brazil|morocco|scotland|haiti|\busa\b|australia|turkey|paraguay)\b/i;
const FOOTBALL_PHRASE_RE = /\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|\bspread\b|match\s+winner|\bhalftime\b|leading\s+at\s+halftime|2nd\s+half|total\s+goals|both\s+teams\s+to\s+score|correct\s+score/i;
const SOCCER_RE        = /soccer|\bfootball\b|premier[\s-]league|serie[\s-]a|bundesliga|la[\s-]liga|\bmls\b|champions[\s-]league|europa[\s-]league|ligue|eredivisie|match[\s-]result|clean[\s-]sheet|btts|both[\s-]teams/i;
const NBA_NHL_RE       = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const ESPORTS_RE       = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const TENNIS_RE        = /\bset\s+[12]\b|\btennis\b/i;
const MLB_RE           = /\bmlb\b|\bbaseball\b|royals|yankees|red[\s-]sox|dodgers|\bcubs\b|\bmets\b|cardinals|\bbraves\b|astros|phillies|padres|mariners|brewers|pirates|\breds\b|orioles|nationals|athletics|\btigers\b|\btwins\b|white[\s-]sox|\brangers\b|\bangels\b|guardians|\brays\b|rockies|diamondbacks|marlins|blue[\s-]jays/i;
const ACTIVITY_LABEL_RE = /matched\s+activity|market\s+activity|live\s+market\s+activity/i;
const PURE_VOLUME_RE   = /^\s*\$[\d,.]+\s*[KkMmBb]?\s*$/;
const SINGLE_TEAM_SPREAD_RE = /^spread:\s*([\w][\w\s'-]*?)\s*\([+-]?\d+\.?\d*\)\s*$/i;

// ── Mirror regexes from eventExecutionQueue.ts (anchor guards) ────────────────
const HALFTIME_ANCHOR_RE = /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;
const CORNERS_ANCHOR_RE  = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;
const PROP_ANCHOR_RE     = /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]prop|\boutright\b/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isActivityLabel(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  return ACTIVITY_LABEL_RE.test(v.trim()) || PURE_VOLUME_RE.test(v.trim());
}

function buildIdentityText(row) {
  const diag = row.diagnostics ?? {};
  const rc = (diag.researchContext && typeof diag.researchContext === 'object') ? diag.researchContext : null;
  const activityLabel = isActivityLabel(row.market_slug);
  const sources = [
    rc?.eventTitle, diag.eventTitle, rc?.eventSlug,
    diag.marketTitle, rc?.marketTitle, diag.question, diag.title,
    row.event_slug, activityLabel ? null : row.market_slug,
  ];
  for (const v of sources) {
    if (typeof v === 'string' && v.trim() && !isActivityLabel(v)) return v.trim().toLowerCase();
  }
  return '';
}

function deriveSportScope(identityText) {
  if (ESPORTS_RE.test(identityText)) return 'ESPORT';
  if (NBA_NHL_RE.test(identityText)) return 'UNKNOWN';
  if (TENNIS_RE.test(identityText))  return 'UNKNOWN';
  if (WC_EXPLICIT_RE.test(identityText)) return 'WC';
  if (MLB_RE.test(identityText))     return 'MLB';
  if (SOCCER_RE.test(identityText))  return 'SOCCER';
  const hasCountry = WC_COUNTRY_RE.test(identityText);
  const hasPhrase  = FOOTBALL_PHRASE_RE.test(identityText);
  if (hasCountry && hasPhrase) return 'WC';
  if (hasCountry && /halftime/i.test(identityText)) return 'SOCCER';
  return 'UNKNOWN';
}

function resolvePlanningScope(row, baseScope) {
  if (baseScope !== 'UNKNOWN') return baseScope;
  const diag = row.diagnostics ?? {};
  const shadow = (typeof diag.shadowScope === 'string') ? diag.shadowScope.toLowerCase() : '';
  const text = [diag.marketTitle, diag.eventTitle, diag.question].filter(Boolean).join(' ').toLowerCase();
  if (/(world[\s-]?cup|wc2026|fifwc)/i.test(shadow) || /(world[\s-]?cup|wc2026|fifwc)/i.test(text)) return 'WC';
  if (/(soccer|football|premier[\s-]league|la[\s-]liga|bundesliga|serie[\s-]a|champions[\s-]league|europa[\s-]league)/i.test(shadow) ||
      /(soccer|football|premier[\s-]league|la[\s-]liga|bundesliga|serie[\s-]a|champions[\s-]league|europa[\s-]league)/i.test(text)) return 'SOCCER';
  return 'UNKNOWN';
}

function getGameStartIso(row) {
  const diag = row.diagnostics ?? {};
  // Primary: camelCase (production format)
  if (typeof diag.gameStartIso === 'string' && diag.gameStartIso !== 'null') return diag.gameStartIso;
  // Fallback: snake_case variant
  if (typeof diag.game_start_iso === 'string' && diag.game_start_iso !== 'null') return diag.game_start_iso;
  return null;
}

function computeTierLabel(score, coverage) {
  if (score >= 72 && coverage >= 50) return 'TIER1';
  if (score >= 60 && coverage >= 50) return 'TIER2';
  if (score >= 50 && coverage >= 25) return 'TIER3';
  return null;
}

function deriveMatchFamilyKey(row, identityText) {
  const rawSlug = (typeof row.event_slug === 'string' && row.event_slug.trim())
    ? row.event_slug.trim().toLowerCase() : null;
  if (rawSlug && /^fifwc-/.test(rawSlug)) return { key: rawSlug, quality: 'STRONG', canonical: rawSlug };

  const pairMatch = identityText.match(/\b([\w\s'-]+?)\s+vs\.?\s+([\w\s'-]+?)(?:\s*[:|,]|$)/i);
  if (pairMatch) {
    const t1 = pairMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    const t2 = pairMatch[2].trim().toLowerCase().replace(/\s+/g, '-');
    const diag = row.diagnostics ?? {};
    const gameStart = getGameStartIso(row);
    const dateStr = gameStart ? gameStart.slice(0, 10) : 'nodate';
    const key = `pair:${t1}-vs-${t2}:${dateStr}`;
    return { key, quality: dateStr !== 'nodate' ? 'STRONG' : 'MEDIUM', canonical: key };
  }

  // Single-team spread: try diagnostics.eventTitle for pair
  if (!identityText.match(/\bvs\.?\b/i) && SINGLE_TEAM_SPREAD_RE.test(identityText)) {
    const diag = row.diagnostics ?? {};
    const rc = (diag.researchContext && typeof diag.researchContext === 'object') ? diag.researchContext : null;
    const candidates = [
      typeof diag.eventTitle === 'string' ? diag.eventTitle : '',
      rc && typeof rc.eventTitle === 'string' ? rc.eventTitle : '',
      rc && typeof rc.eventSlug === 'string' ? rc.eventSlug : '',
    ];
    for (const et of candidates) {
      if (!et) continue;
      const m = et.toLowerCase().match(/\b([\w\s'-]+?)\s+vs\.?\s+([\w\s'-]+?)(?:\s*[:|,]|$)/i);
      if (m) {
        const t1 = m[1].trim().toLowerCase().replace(/\s+/g, '-');
        const t2 = m[2].trim().toLowerCase().replace(/\s+/g, '-');
        const gameStart = getGameStartIso(row);
        const dateStr = gameStart ? gameStart.slice(0, 10) : 'nodate';
        const key = `pair:${t1}-vs-${t2}:${dateStr}`;
        return { key, quality: dateStr !== 'nodate' ? 'STRONG' : 'MEDIUM', canonical: key };
      }
    }
    const sm = SINGLE_TEAM_SPREAD_RE.exec(identityText);
    const team = sm[1].trim().toLowerCase().replace(/\s+/g, '-');
    const gameStart = getGameStartIso(row);
    const dateStr = gameStart ? gameStart.slice(0, 10) : 'nodate';
    return { key: `WEAK_SINGLE_TEAM_SPREAD:${team}:${dateStr}`, quality: 'WEAK', canonical: null };
  }

  if (rawSlug) return { key: rawSlug, quality: 'MEDIUM', canonical: rawSlug };
  return { key: `WEAK_MARKET_LEVEL_KEY:${row.condition_id}`, quality: 'WEAK', canonical: null };
}

function classifyAnchor(identityText, marketTitle) {
  const texts = [identityText, marketTitle ?? ''].join(' ');
  if (HALFTIME_ANCHOR_RE.test(texts)) return 'FORBIDDEN_HALFTIME';
  if (CORNERS_ANCHOR_RE.test(texts))  return 'FORBIDDEN_CORNERS';
  if (PROP_ANCHOR_RE.test(texts))     return 'FORBIDDEN_PROP';
  return 'EXECUTABLE';
}

function computePlanningScore(row, scope) {
  const diag = row.diagnostics ?? {};
  const identityText = buildIdentityText(row);
  const hasEnoughIdentity =
    Boolean(identityText) &&
    Boolean(row.condition_id) &&
    Boolean(row.selected_token_id) &&
    Boolean(getGameStartIso(row) || row.expires_at);
  if (!hasEnoughIdentity) return null;
  const tier = typeof diag.tier === 'number' ? diag.tier : null;
  const entryPrice = typeof diag.entryPrice === 'number' ? diag.entryPrice
    : typeof row.entry_price_num === 'number' ? row.entry_price_num : null;
  const volumeUsd = typeof diag.volumeUsd === 'number' ? diag.volumeUsd : null;
  const base = tier === 1 ? 72 : tier === 2 ? 66 : (scope === 'WC' ? 68 : 58);
  const priceBonus = typeof entryPrice === 'number'
    ? Math.max(0, 6 - Math.round(Math.abs(entryPrice - 0.5) * 12)) : 0;
  const volumeBonus = typeof volumeUsd === 'number' && volumeUsd > 0
    ? Math.min(6, Math.floor(Math.log10(volumeUsd))) : 0;
  const scopeBonus = (scope === 'WC' || scope === 'SOCCER') ? 2 : 0;
  return Math.max(0, Math.min(79, Math.round(base + priceBonus + volumeBonus + scopeBonus)));
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function csvEscape(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function countBy(arr, fn) {
  const r = {};
  for (const item of arr) {
    const k = fn(item);
    r[k] = (r[k] ?? 0) + 1;
  }
  return r;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('MISSING_SUPABASE_ENV: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(supabaseUrl, supabaseKey);

  const now = Date.now();
  const nowIsoStr = new Date().toISOString();
  const timestamp = nowIso();
  const generatedAt = nowIsoStr;
  const horizonEnd = new Date(now + HORIZON_HOURS * 3_600_000).toISOString();
  const windowStart = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();

  fs.mkdirSync(LOG_DIR, { recursive: true });

  console.log(`\n=== CONTUR3 RESERVATION ADMISSION AUDIT ===`);
  console.log(`generated_at:   ${generatedAt}`);
  console.log(`horizon_hours:  ${HORIZON_HOURS} (now → ${horizonEnd})`);
  console.log(`lookback_hours: ${LOOKBACK_HOURS} (created_at >= ${windowStart})`);

  const PLANNING_VERSIONS = ['shadow-strategic-sports-v1', 'v2-lite-growth-safe', 'shadow-firemodel1_1_research_v0'];

  // ── 1. Fetch scored rows (signal_confidence_num >= 50) ─────────────────────
  console.log('\nQuerying generated_signal_pairs (scored, signal_confidence_num>=50)...');
  const { data: scoredRows, error: scoredErr } = await sb
    .from('generated_signal_pairs')
    .select('id,condition_id,selected_outcome,selected_token_id,entry_price_num,signal_confidence_num,smart_money_score_num,diagnostics,market_slug,event_slug,metric_formula_version,created_at,expires_at')
    .in('metric_formula_version', PLANNING_VERSIONS)
    .is('signal_result', null)
    .gt('expires_at', nowIsoStr)
    .not('selected_token_id', 'is', null)
    .not('condition_id', 'is', null)
    .not('entry_price_num', 'is', null)
    .gte('signal_confidence_num', 50)
    .order('created_at', { ascending: false })
    .limit(300);
  if (scoredErr) { console.error(`scored query error: ${scoredErr.message}`); process.exit(1); }
  console.log(`scored rows returned: ${(scoredRows ?? []).length}`);

  // ── 2. Fetch shadow planning rows (signal_confidence_num IS NULL) ───────────
  console.log('Querying generated_signal_pairs (shadow-strategic-sports-v1, null signal_confidence_num)...');
  const { data: shadowRows, error: shadowErr } = await sb
    .from('generated_signal_pairs')
    .select('id,condition_id,selected_outcome,selected_token_id,entry_price_num,signal_confidence_num,smart_money_score_num,diagnostics,market_slug,event_slug,metric_formula_version,created_at,expires_at')
    .eq('metric_formula_version', 'shadow-strategic-sports-v1')
    .is('signal_result', null)
    .gt('expires_at', nowIsoStr)
    .not('selected_token_id', 'is', null)
    .not('condition_id', 'is', null)
    .is('signal_confidence_num', null)
    .order('created_at', { ascending: false })
    .limit(300);
  if (shadowErr) { console.error(`shadow query error: ${shadowErr.message}`); process.exit(1); }
  console.log(`shadow rows returned: ${(shadowRows ?? []).length}`);

  // Merge, deduplicating by condition_id + selected_token_id
  const seen = new Set();
  const allRows = [];
  for (const row of [...(scoredRows ?? []), ...(shadowRows ?? [])]) {
    const k = `${row.condition_id}__${row.selected_token_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    allRows.push(row);
  }
  console.log(`total unique rows after dedup: ${allRows.length}`);

  // ── 3. Classify each row ───────────────────────────────────────────────────
  const rejectionHistogram = {};
  const anchorClassHistogram = {};
  const allCandidates = [];

  const isShadowFallback = (row) =>
    row.metric_formula_version === 'shadow-strategic-sports-v1' && row.signal_confidence_num == null;

  for (const row of allRows) {
    const diag = row.diagnostics ?? {};
    const identityText = buildIdentityText(row);
    const marketTitle = typeof diag.marketTitle === 'string' ? diag.marketTitle : null;

    // Derive scope
    let scope = deriveSportScope(identityText);
    if (scope === 'UNKNOWN') scope = resolvePlanningScope(row, scope);
    const isSoccer = scope === 'WC' || scope === 'SOCCER';

    // Derive score/coverage
    let score = typeof row.signal_confidence_num === 'number' ? row.signal_confidence_num : null;
    let coverage = typeof diag.dataCoverage === 'number' ? diag.dataCoverage
      : typeof diag.coverage === 'number' ? diag.coverage : null;

    if (isShadowFallback(row) && score == null) {
      if (scope === 'UNKNOWN') {
        allCandidates.push({ ...row, _reject: 'UNKNOWN_SCOPE_SHADOW', _identityText: identityText, _scope: scope, _score: null, _coverage: null, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
        rejectionHistogram.UNKNOWN_SCOPE_SHADOW = (rejectionHistogram.UNKNOWN_SCOPE_SHADOW ?? 0) + 1;
        continue;
      }
      score = computePlanningScore(row, scope);
      if (score == null) {
        allCandidates.push({ ...row, _reject: 'SHADOW_FALLBACK_INCOMPLETE', _identityText: identityText, _scope: scope, _score: null, _coverage: null, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
        rejectionHistogram.SHADOW_FALLBACK_INCOMPLETE = (rejectionHistogram.SHADOW_FALLBACK_INCOMPLETE ?? 0) + 1;
        continue;
      }
      if (coverage == null && row.selected_token_id && row.condition_id) coverage = 50;
    }

    // Scope check
    if (scope === 'UNKNOWN') {
      allCandidates.push({ ...row, _reject: 'UNKNOWN_SCOPE', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.UNKNOWN_SCOPE = (rejectionHistogram.UNKNOWN_SCOPE ?? 0) + 1;
      continue;
    }

    // Game start
    const gameStartIso = getGameStartIso(row);
    if (!gameStartIso) {
      allCandidates.push({ ...row, _reject: 'MISSING_GAME_START', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.MISSING_GAME_START = (rejectionHistogram.MISSING_GAME_START ?? 0) + 1;
      continue;
    }
    const gameStartMs = new Date(gameStartIso).getTime();
    if (isNaN(gameStartMs) || gameStartMs <= now) {
      allCandidates.push({ ...row, _reject: 'GAME_STARTED_OR_INVALID', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.GAME_STARTED_OR_INVALID = (rejectionHistogram.GAME_STARTED_OR_INVALID ?? 0) + 1;
      continue;
    }
    const hoursToStart = (gameStartMs - now) / 3_600_000;

    // Only events within planning horizon (future, <= HORIZON_HOURS)
    // (reservations cron typically runs during the day for tonight's events)
    // Don't hard-block here — just flag for report

    // Score/coverage/tier
    if (score == null || score < 50) {
      allCandidates.push({ ...row, _reject: 'LOW_SCORE', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.LOW_SCORE = (rejectionHistogram.LOW_SCORE ?? 0) + 1;
      continue;
    }
    if (coverage == null || coverage < 25) {
      allCandidates.push({ ...row, _reject: 'LOW_COVERAGE', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.LOW_COVERAGE = (rejectionHistogram.LOW_COVERAGE ?? 0) + 1;
      continue;
    }
    const entryPrice = typeof row.entry_price_num === 'number' ? row.entry_price_num : null;
    if (entryPrice !== null && coverage >= 50 && coverage <= 74 && entryPrice >= 0.44 && entryPrice <= 0.58) {
      allCandidates.push({ ...row, _reject: 'BAD_BUCKET_COV_PRICE', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.BAD_BUCKET_COV_PRICE = (rejectionHistogram.BAD_BUCKET_COV_PRICE ?? 0) + 1;
      continue;
    }
    const tier = computeTierLabel(score, coverage);
    if (!tier) {
      allCandidates.push({ ...row, _reject: 'TIER_BELOW_THRESHOLD', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: null, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.TIER_BELOW_THRESHOLD = (rejectionHistogram.TIER_BELOW_THRESHOLD ?? 0) + 1;
      continue;
    }

    // Side check — "No" on soccer is blocked
    const selectedOutcome = row.selected_outcome
      ?? diag.selectedOutcome ?? diag.outcome
      ?? ((diag.researchContext && typeof diag.researchContext === 'object') ? (diag.researchContext.selectedOutcome ?? diag.researchContext.outcome) : null)
      ?? null;
    const side = selectedOutcome ?? 'Yes';
    if (isSoccer && side.toLowerCase() === 'no') {
      allCandidates.push({ ...row, _reject: 'FOOTBALL_NO_SIDE', _identityText: identityText, _scope: scope, _score: score, _coverage: coverage, _tier: tier, _anchorClass: null, _matchFamilyKey: null, _marketTitle: marketTitle });
      rejectionHistogram.FOOTBALL_NO_SIDE = (rejectionHistogram.FOOTBALL_NO_SIDE ?? 0) + 1;
      continue;
    }

    // Match family key
    const { key: matchFamilyKey, quality, canonical } = deriveMatchFamilyKey(row, identityText);
    const isWeak = quality === 'WEAK';

    // Anchor classification (for reservation planner)
    const anchorClass = classifyAnchor(identityText, marketTitle);
    anchorClassHistogram[anchorClass] = (anchorClassHistogram[anchorClass] ?? 0) + 1;

    allCandidates.push({
      ...row,
      _reject: null,
      _identityText: identityText,
      _scope: scope,
      _score: score,
      _coverage: coverage,
      _tier: tier,
      _anchorClass: anchorClass,
      _matchFamilyKey: matchFamilyKey,
      _matchFamilyQuality: quality,
      _canonicalKey: canonical,
      _isWeak: isWeak,
      _gameStartIso: gameStartIso,
      _hoursToStart: Math.round(hoursToStart * 100) / 100,
      _side: side,
      _selectedOutcome: selectedOutcome,
      _marketTitle: marketTitle,
      _entryPrice: entryPrice,
    });
  }

  // ── 4. Group admitted candidates by match_family_key ──────────────────────
  const admitted = allCandidates.filter(c => c._reject === null);
  const forbidden = allCandidates.filter(c => c._reject !== null);

  const eventGroups = new Map();
  for (const c of admitted) {
    const key = c._matchFamilyKey;
    if (!eventGroups.has(key)) eventGroups.set(key, []);
    eventGroups.get(key).push(c);
  }

  // Compute per-group stats
  const groupStats = [];
  let futureValidExecutableCount = 0;
  let futureGroupsWithOnlyForbiddenAnchors = 0;
  let futureGroupsWeakOnly = 0;

  for (const [key, candidates] of eventGroups.entries()) {
    const executableAnchors = candidates.filter(c => c._anchorClass === 'EXECUTABLE');
    const forbiddenAnchors  = candidates.filter(c => c._anchorClass !== 'EXECUTABLE');
    const tier1Candidates   = candidates.filter(c => c._tier === 'TIER1');
    const gameStart = candidates[0]?._gameStartIso ?? null;
    const isFuture = gameStart && new Date(gameStart) > new Date();
    const isWeakKey = candidates.every(c => c._isWeak);

    const topExecAnchor = executableAnchors.sort((a, b) => (b._score ?? 0) - (a._score ?? 0))[0] ?? null;

    if (isFuture) {
      if (executableAnchors.length > 0 && !isWeakKey) {
        futureValidExecutableCount++;
      } else if (executableAnchors.length === 0) {
        futureGroupsWithOnlyForbiddenAnchors++;
      } else if (isWeakKey) {
        futureGroupsWeakOnly++;
      }
    }

    const rejectionBreakdown = countBy(forbiddenAnchors, c => c._anchorClass ?? 'ALLOWED');

    groupStats.push({
      match_family_key: key,
      candidate_count: candidates.length,
      executable_anchor_count: executableAnchors.length,
      forbidden_anchor_count: forbiddenAnchors.length,
      tier1_count: tier1Candidates.length,
      is_weak_key: isWeakKey,
      is_future: isFuture,
      game_start_iso: gameStart,
      hours_to_start: candidates[0]?._hoursToStart ?? null,
      scope: candidates[0]?._scope ?? null,
      top_executable_anchor: topExecAnchor ? {
        identity_text: topExecAnchor._identityText,
        market_title: topExecAnchor._marketTitle,
        score: topExecAnchor._score,
        coverage: topExecAnchor._coverage,
        tier: topExecAnchor._tier,
        anchor_class: topExecAnchor._anchorClass,
        side: topExecAnchor._side,
        selected_outcome: topExecAnchor._selectedOutcome,
        has_token_id: Boolean(topExecAnchor.selected_token_id),
        has_condition_id: Boolean(topExecAnchor.condition_id),
      } : null,
      sample_candidates: candidates.slice(0, 5).map(c => ({
        identity_text: c._identityText,
        market_title: c._marketTitle,
        event_slug: c.event_slug,
        market_slug: typeof c.market_slug === 'string' ? c.market_slug.slice(0, 60) : null,
        score: c._score,
        coverage: c._coverage,
        tier: c._tier,
        anchor_class: c._anchorClass,
        side: c._side,
        selected_outcome: c._selectedOutcome,
        match_family_key: c._matchFamilyKey,
        match_family_quality: c._matchFamilyQuality,
        has_token_id: Boolean(c.selected_token_id),
        has_condition_id: Boolean(c.condition_id),
        hours_to_start: c._hoursToStart,
      })),
      anchor_class_breakdown: countBy(candidates, c => c._anchorClass ?? 'UNKNOWN'),
    });
  }

  // ── 5. Root cause determination ────────────────────────────────────────────
  const footballWcAdmitted = admitted.filter(c => c._scope === 'WC' || c._scope === 'SOCCER');
  const executableAnchorsTotal = admitted.filter(c => c._anchorClass === 'EXECUTABLE');
  const futureExecAnchorCount = admitted.filter(c =>
    c._anchorClass === 'EXECUTABLE' && c._gameStartIso && new Date(c._gameStartIso) > new Date()
  ).length;

  let rootCauseStage;
  let rootCauseReason;

  if (allRows.length === 0) {
    rootCauseStage = 'SIGNALS_MISSING';
    rootCauseReason = 'No rows in generated_signal_pairs for any version (not-expired)';
  } else if (footballWcAdmitted.length === 0 && admitted.length > 0) {
    rootCauseStage = 'VALID_MARKETS_FILTERED_BEFORE_RESERVATION';
    rootCauseReason = `${admitted.length} candidates passed basic filters but none are WC/SOCCER scope — check top rejection reasons`;
  } else if (footballWcAdmitted.length === 0) {
    rootCauseStage = 'VALID_MARKETS_FILTERED_BEFORE_RESERVATION';
    rootCauseReason = `0 WC/SOCCER candidates admitted. Top rejections: ${JSON.stringify(rejectionHistogram)}`;
  } else if (executableAnchorsTotal.length === 0) {
    rootCauseStage = 'VALID_MARKETS_FILTERED_BEFORE_RESERVATION';
    rootCauseReason = `${footballWcAdmitted.length} WC/SOCCER candidates admitted but ALL have forbidden anchors (corners/halftime/props) — no executable anchor exists`;
  } else if (futureValidExecutableCount === 0) {
    rootCauseStage = 'VALID_MARKETS_FILTERED_BEFORE_RESERVATION';
    rootCauseReason = `Executable anchors exist but none are in future event groups with non-weak keys — check WEAK key resolution and game_start timestamps`;
  } else {
    rootCauseStage = 'ADMISSION_OK';
    rootCauseReason = `${futureValidExecutableCount} future event groups have valid executable anchors (spread/moneyline/total admitted)`;
  }

  console.log(`\nadmitted candidates: ${admitted.length}`);
  console.log(`football/WC admitted: ${footballWcAdmitted.length}`);
  console.log(`executable anchor candidates: ${executableAnchorsTotal.length}`);
  console.log(`future valid executable event groups: ${futureValidExecutableCount}`);
  console.log(`future groups with only forbidden anchors: ${futureGroupsWithOnlyForbiddenAnchors}`);
  console.log(`future groups weak key only: ${futureGroupsWeakOnly}`);
  console.log(`\nREJECTION HISTOGRAM:`);
  for (const [k, v] of Object.entries(rejectionHistogram).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\nANCHOR CLASS HISTOGRAM (admitted):`);
  for (const [k, v] of Object.entries(anchorClassHistogram).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\nROOT_CAUSE_STAGE: ${rootCauseStage}`);
  console.log(`ROOT_CAUSE_REASON: ${rootCauseReason}`);

  // ── 6. Write artifacts ────────────────────────────────────────────────────
  const jsonPath = path.join(LOG_DIR, `${timestamp}_reservation_admission_audit.json`);
  const mdPath   = path.join(LOG_DIR, `${timestamp}_reservation_admission_audit.md`);
  const csvPath  = path.join(LOG_DIR, `${timestamp}_reservation_admission_audit.csv`);

  const report = {
    run_id: timestamp,
    generated_at_iso: generatedAt,
    horizon_hours: HORIZON_HOURS,
    horizon_end_iso: horizonEnd,
    lookback_hours: LOOKBACK_HOURS,
    total_signal_rows: allRows.length,
    upcoming_signal_rows: allRows.filter(r => {
      const gs = getGameStartIso(r);
      return gs && new Date(gs) > new Date() && new Date(gs) < new Date(horizonEnd);
    }).length,
    football_wc_rows: footballWcAdmitted.length,
    candidate_rows_inspected: allRows.length,
    event_groups: eventGroups.size,
    allowed_candidate_count: admitted.length,
    forbidden_candidate_count: forbidden.length,
    weak_key_blocked_count: admitted.filter(c => c._isWeak).length,
    no_selected_token_count: allRows.filter(r => !r.selected_token_id).length,
    no_condition_id_count: allRows.filter(r => !r.condition_id).length,
    no_game_start_count: allRows.filter(r => !getGameStartIso(r)).length,
    no_market_title_count: allRows.filter(r => !((r.diagnostics ?? {}).marketTitle)).length,
    tier1_candidate_count: admitted.filter(c => c._tier === 'TIER1').length,
    executable_anchor_candidate_count: executableAnchorsTotal.length,
    future_valid_executable_event_count: futureValidExecutableCount,
    future_groups_only_forbidden: futureGroupsWithOnlyForbiddenAnchors,
    future_groups_weak_key_only: futureGroupsWeakOnly,
    root_cause_stage: rootCauseStage,
    root_cause_reason: rootCauseReason,
    rejection_histogram: rejectionHistogram,
    anchor_class_histogram: anchorClassHistogram,
    event_group_samples: groupStats
      .filter(g => g.is_future)
      .sort((a, b) => (a.hours_to_start ?? 999) - (b.hours_to_start ?? 999))
      .slice(0, 30),
    all_event_groups: groupStats.length,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\njson: ${jsonPath}`);

  // ── CSV flat candidate table ──────────────────────────────────────────────
  const csvHeaders = ['condition_id','event_slug','market_slug','identity_text','scope','score','coverage',
    'tier','anchor_class','match_family_key','match_family_quality','game_start_iso','hours_to_start',
    'side','selected_outcome','has_token_id','has_condition_id','reject_reason','metric_formula_version'];
  const csvLines = [csvHeaders.join(',')];
  for (const c of allCandidates) {
    csvLines.push(csvHeaders.map(h => {
      const m = {
        condition_id: c.condition_id,
        event_slug: c.event_slug,
        market_slug: typeof c.market_slug === 'string' ? c.market_slug.slice(0, 60) : '',
        identity_text: c._identityText,
        scope: c._scope,
        score: c._score,
        coverage: c._coverage,
        tier: c._tier,
        anchor_class: c._anchorClass,
        match_family_key: c._matchFamilyKey,
        match_family_quality: c._matchFamilyQuality,
        game_start_iso: c._gameStartIso,
        hours_to_start: c._hoursToStart,
        side: c._side,
        selected_outcome: c._selectedOutcome,
        has_token_id: Boolean(c.selected_token_id),
        has_condition_id: Boolean(c.condition_id),
        reject_reason: c._reject,
        metric_formula_version: c.metric_formula_version,
      };
      return csvEscape(m[h]);
    }).join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
  console.log(`csv: ${csvPath}`);

  // ── MD summary ────────────────────────────────────────────────────────────
  const rejHist = Object.entries(rejectionHistogram)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v} |`).join('\n');

  const anchorHist = Object.entries(anchorClassHistogram)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v} |`).join('\n');

  const groupSampleBlock = report.event_group_samples.slice(0, 10).map(g =>
    `### ${g.match_family_key}
- candidates: ${g.candidate_count} | executable_anchors: ${g.executable_anchor_count} | forbidden: ${g.forbidden_anchor_count} | tier1: ${g.tier1_count} | weak_key: ${g.is_weak_key}
- game_start: ${g.game_start_iso} (${g.hours_to_start?.toFixed(1)}h) | scope: ${g.scope}
- top_executable_anchor: ${g.top_executable_anchor ? `${g.top_executable_anchor.identity_text} [${g.top_executable_anchor.anchor_class}] score=${g.top_executable_anchor.score} tier=${g.top_executable_anchor.tier}` : 'NONE'}
`
  ).join('\n');

  const md = `# Contur3 Reservation Admission Audit

**Generated:** ${generatedAt}
**Horizon:** now → ${horizonEnd} (${HORIZON_HOURS}h)

## Funnel Summary

| Metric | Count |
|--------|-------|
| Total signal rows inspected | ${report.total_signal_rows} |
| Upcoming (in horizon) signal rows | ${report.upcoming_signal_rows} |
| Admitted candidates (all filters pass) | ${report.allowed_candidate_count} |
| WC/SOCCER admitted | ${report.football_wc_rows} |
| Tier1 candidates | ${report.tier1_candidate_count} |
| Executable anchor candidates | ${report.executable_anchor_candidate_count} |
| **Future valid executable event groups** | **${report.future_valid_executable_event_count}** |
| Future groups with only forbidden anchors | ${report.future_groups_only_forbidden} |
| Future groups weak key only | ${report.future_groups_weak_key_only} |

## Root Cause

**Stage:** \`${rootCauseStage}\`
**Reason:** ${rootCauseReason}

## Rejection Histogram

| Reason | Count |
|--------|-------|
${rejHist || '| (none) | 0 |'}

## Anchor Classification (admitted candidates)

| Class | Count |
|-------|-------|
${anchorHist || '| (none) | 0 |'}

## Future Event Groups (top 10)

${groupSampleBlock || '(none)'}

## Artifacts

- JSON: \`${jsonPath}\`
- CSV:  \`${csvPath}\`
- MD:   \`${mdPath}\`
`;

  fs.writeFileSync(mdPath, md, 'utf8');
  console.log(`md:  ${mdPath}`);

  // Exit 0 if admission OK, 1 if any blocking issue
  const ok = rootCauseStage === 'ADMISSION_OK';
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 1500).unref();
}

main().catch(err => {
  console.error(`RESERVATION_ADMISSION_AUDIT_FATAL: ${err}`);
  process.exit(1);
});
