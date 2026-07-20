// lib/executor/nightEventReservations.ts
//
// Contur3 EVENT-FIRST night reservation planner.
//
// Around 17:00 Minsk this builds the frozen Night Portfolio Plan: it selects
// EVENTS/MATCHES (never individual markets) within the canonical 17:00→08:00
// operational window / ~18h horizon, and persists one row per event into
// night_event_reservations under a deterministic plan_run_id.
//
// It does NOT write the execution queue — per-event market selection happens later
// in eventExecutionQueue.ts at T-60/T-30 rebalance.
//
// Read input only via buildFireModelCandidates (raw universe). No 6h hardcoded
// eligibility: horizon is governed by nightWindow.ts.

import type { FireModelCandidate } from "./buildFireModelCandidates";
import { compareCandidateQuality } from "./nightPortfolioPlanner";
import {
  createSupabaseSchedulerJobEvidencePort,
  sanitizeSchedulerErrorMessage,
  type SchedulerJobEvidencePort,
} from "./schedulerJobEvidence";
import {
  resolveNightWindow,
  buildPlanRunId,
  isWithinHorizon,
  formatMinskUtc,
  REBALANCE_MINUTES_BEFORE_START,
  PREFERRED_ENTRY_MINUTES_BEFORE,
  LATEST_ENTRY_MINUTES_BEFORE,
  type NightWindow,
} from "./nightWindow";
import type { NightEventReservationRow } from "./executorQueueTypes";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

// Planning universe is uncapped: buildFireModelCandidates paginates the full corpus
// in planningMode, and this ceiling only bounds the final slice. It must be far above
// the realistic candidate count so no physical match is dropped before reservation.
const PLAN_POOL = 100_000;

// Market-level terms that may appear in event_slug / match_family_key from Polymarket.
// A key containing any of these is a prop/market line, not an event reservation key.
const MARKET_LEVEL_KEY_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|halftime[\s-]result|\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|player\s+prop|goalscorer/i;

const HALFTIME_MARKET_RE =
  /halftime|half[\s-]time|first[\s-]half|1st[\s-]half|leading\s+at\s+halftime|draw\s+at\s+halftime|halftime[\s-]result/i;

// Anchor guards — applied at reservation selection to prevent forbidden live-market anchors.
// Only identity fields are inspected (market_slug, event_slug, match_family_key, diagnostics.marketTitle).
// Telemetry fields (price1hAgo, delta1hPp, etc.) are never checked here.
const CORNERS_ANCHOR_RE = /\bcorners?\b|total[\s_-]corners?|corners?[\s_-]total/i;

const PROP_ANCHOR_RE =
  /exact[\s_-]score|goalscorer|goal[\s_-]scorer|anytime[\s_-]scorer|first[\s_-]scorer|last[\s_-]scorer|\bplayer[\s_-]prop|\boutright\b/i;

function isHalftimeMarket(c: FireModelCandidate): boolean {
  return (
    HALFTIME_MARKET_RE.test(c.market_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.event_slug ?? "") ||
    HALFTIME_MARKET_RE.test(c.match_family_key ?? "")
  );
}

function isCornersAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    CORNERS_ANCHOR_RE.test(c.market_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.event_slug ?? "") ||
    CORNERS_ANCHOR_RE.test(c.match_family_key ?? "") ||
    CORNERS_ANCHOR_RE.test(diagTitle)
  );
}

function isPropAnchorMarket(c: FireModelCandidate): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  return (
    PROP_ANCHOR_RE.test(c.market_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.event_slug ?? "") ||
    PROP_ANCHOR_RE.test(c.match_family_key ?? "") ||
    PROP_ANCHOR_RE.test(diagTitle)
  );
}

/**
 * True when the candidate is a forbidden live-market anchor.
 * Forbidden: halftime/1H, corners, exact score, goalscorer, props, outrights.
 * Allowed: full-match winner/moneyline, spread, full-match total goals.
 */
function isForbiddenAnchorMarket(c: FireModelCandidate): boolean {
  return isHalftimeMarket(c) || isCornersAnchorMarket(c) || isPropAnchorMarket(c);
}

// Positively-allowed full-match anchor markets per live policy:
//   full-match moneyline / match winner, full-match spread / handicap,
//   full-match total goals O/U (corners excluded by isForbiddenAnchorMarket).
// Used ONLY by the Tier2/Tier3 founder slot-fill fallback ladder so the fallback
// can never anchor an UNKNOWN/non-full-match line — it must positively match.
const ALLOWED_FULLMATCH_ANCHOR_RE =
  /moneyline|match\s*winner|\bto\s*win\b|\bwinner\b|\bspread\b|\bhandicap\b|total\s*goals|over[\s/]under|\bo\/u\b|\btotal\b/i;

function isAllowedFullMatchAnchor(c: FireModelCandidate): boolean {
  if (isForbiddenAnchorMarket(c)) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const diagTitle: string = (c as any).diagnostics?.marketTitle ?? "";
  const hay = `${c.market_slug ?? ""} ${c.event_slug ?? ""} ${c.match_family_key ?? ""} ${diagTitle}`;
  return ALLOWED_FULLMATCH_ANCHOR_RE.test(hay);
}

// Founder live-slot policy: try to fill at least this many live slots when eligible
// candidates exist. Tier1 first; Tier2 then Tier3 only as explicit fallback to reach
// the target. Fallback never uses forbidden market classes.
const TARGET_LIVE_SLOTS = 15;

function eventTierOf(c: FireModelCandidate): "TIER1" | "TIER2" | "TIER3" | "REJECTED" {
  if (c.strategy === "TIER1_CORE_STRICT_72_COV50") return "TIER1";
  if (c.strategy === "TIER2_SAFE_EXPAND_60_COV50") return "TIER2";
  if (c.strategy === "TIER3_MICRO_EXPAND_50_COV25") return "TIER3";
  return "REJECTED";
}

// Canonical physical-match-key forms. A single physical game can surface under several
// key shapes; all of them must collapse to ONE reservation:
//   pair:<team-a>-vs-<team-b>:<date>          (strong)
//   fifwc-...                                  (strong)
//   WEAK_SINGLE_TEAM_SPREAD:<team>:<date>      (spread side of a game — full-match)
//   WEAK_SINGLE_TEAM_MATCH_WINNER:<team>       (moneyline side of a game — full-match)
// Weak single-team keys are NOT discarded: when the opponent pair exists they merge into
// it; otherwise they remain their own physical match so the Tier1 full-match invariant
// still produces a reservation. Pure condition-id keys with no canonical identity (and no
// clean canonical_event_key) are the only forms that cannot become a reservation.
const PAIR_KEY_RE = /^pair:([\w-]+)-vs-([\w-]+):(\d{4}-\d{2}-\d{2})$/;
const RAW_VS_KEY_RE = /^(.+?)\s+vs\.?\s+(.+?)$/i;
const WEAK_SPREAD_KEY_RE = /^WEAK_SINGLE_TEAM_SPREAD:([\w-]+):(\d{4}-\d{2}-\d{2})$/;
const WEAK_MATCH_WINNER_KEY_RE = /^WEAK_SINGLE_TEAM_MATCH_WINNER:(.+)$/;

function normTeam(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract (teamA, teamB, date) from a candidate whose key is a two-team game in any
 * shape: pair:a-vs-b:date, or a raw "a vs b"/"a vs. b" event slug (date from game_start).
 * Returns null for fifwc-*, weak single-team, and non-pair keys.
 */
function extractTeamsDate(c: FireModelCandidate): { a: string; b: string; date: string } | null {
  const k = c.match_family_key;
  if (k.startsWith("WEAK_") || k.startsWith("fifwc-")) return null;
  const pm = k.match(PAIR_KEY_RE);
  if (pm) return { a: pm[1], b: pm[2], date: pm[3] };
  const gameStart = c.diagnostics?.game_start_iso ?? "";
  const date = gameStart ? gameStart.slice(0, 10) : "nodate";
  const vs = k.match(RAW_VS_KEY_RE);
  if (vs) {
    const a = normTeam(vs[1]);
    const b = normTeam(vs[2]);
    if (a && b) return { a, b, date };
  }
  return null;
}

/** Order-independent signature for a two-team game on a date. */
function teamsSig(a: string, b: string, date: string): string {
  return [a, b].slice().sort().join("--") + ":" + date;
}

/**
 * Build the physical-match index over the FULL universe. Every two-team game (regardless
 * of key shape or team order) maps to ONE canonical representative `pair:a-vs-b:date` key,
 * so duplicates and order-variants collapse to a single reservation. Weak single-team
 * SPREAD/MATCH_WINNER keys can then merge into the representative via team(+date).
 */
function buildPhysicalMatchIndex(universe: FireModelCandidate[]): {
  repBySig: Map<string, string>;
  repByTeamDate: Map<string, string>;
  repByTeam: Map<string, Set<string>>;
} {
  const repBySig = new Map<string, string>();
  const repByTeamDate = new Map<string, string>();
  const repByTeam = new Map<string, Set<string>>();
  for (const c of universe) {
    const td = extractTeamsDate(c);
    if (!td) continue;
    const sig = teamsSig(td.a, td.b, td.date);
    if (!repBySig.has(sig)) {
      const rep = `pair:${td.a}-vs-${td.b}:${td.date}`;
      repBySig.set(sig, rep);
      repByTeamDate.set(`${td.a}:${td.date}`, rep);
      repByTeamDate.set(`${td.b}:${td.date}`, rep);
      for (const t of [td.a, td.b]) {
        const set = repByTeam.get(t) ?? new Set<string>();
        set.add(rep);
        repByTeam.set(t, set);
      }
    }
  }
  return { repBySig, repByTeamDate, repByTeam };
}

/**
 * True when the candidate's key or slug is a market-level prop line, not an event identifier.
 * These must never become reservation keys — they are deferred to the rebalance market-selection.
 */
function isMarketLevelKey(c: FireModelCandidate): boolean {
  return (
    MARKET_LEVEL_KEY_RE.test(c.match_family_key) ||
    MARKET_LEVEL_KEY_RE.test(c.event_slug ?? "") ||
    MARKET_LEVEL_KEY_RE.test(c.market_slug ?? "")
  );
}

/**
 * Derive a clean human-readable event title from the canonical reservation key.
 * For pair:* keys, builds "<team a> vs <team b>" from the slug.
 * Falls back to stripping market-level suffixes from the candidate's own slug.
 */
const MARKET_LEVEL_SUFFIX_RE =
  /\s*[-:]\s*(halftime\s+result|half[\s-]time\s+result|first[\s-]half|1st[\s-]half|o\/u[\s\d.]*|over\/under[\s\d.]*|total\s+corners|total\s+goals|\bspread\b|\bmoneyline\b|exact\s+score|goalscorer)\s*$/i;

function cleanReservationEventTitle(candidate: FireModelCandidate, canonicalKey: string): string {
  // Derive title from pair:<team-a>-vs-<team-b>:<date>
  const pairMatch = canonicalKey.match(/^pair:(.+):\d{4}-\d{2}-\d{2}$/);
  if (pairMatch) {
    const teamsPart = pairMatch[1];
    const vsIdx = teamsPart.indexOf("-vs-");
    if (vsIdx !== -1) {
      const teamA = teamsPart.slice(0, vsIdx).replace(/-/g, " ");
      const teamB = teamsPart.slice(vsIdx + 4).replace(/-/g, " ");
      return `${teamA} vs ${teamB}`;
    }
  }
  // Fallback: strip market-level suffixes from candidate slug
  const raw = candidate.event_slug ?? candidate.market_slug ?? canonicalKey;
  return raw.replace(MARKET_LEVEL_SUFFIX_RE, "").trim();
}

/**
 * Attempt to derive a canonical event group key for a market-level candidate.
 * Returns the canonical_event_key if it is clean (pair:* or fifwc-* prefix, no market-level text).
 * Returns null when no safe canonical key can be derived — caller should skip.
 */
function normalizedEventKey(c: FireModelCandidate): string | null {
  const ck = c.canonical_event_key;
  if (!ck) return null;
  if (MARKET_LEVEL_KEY_RE.test(ck)) return null;
  // Accept pair:* or fifwc-* as canonical
  if (ck.startsWith("pair:") || ck.startsWith("fifwc-")) return ck;
  return null;
}

export interface ReservationPlan {
  plan_run_id: string;
  plan_date_minsk: string;
  window: NightWindow;
  reservations: NightEventReservationRow[];
  diagnostics: {
    universe_size: number;
    event_groups: number;
    canonical_event_groups: number;
    reserved_count: number;
    by_sport: Record<string, number>;
    by_tier: Record<string, number>;
    skipped_outside_horizon: number;
    skipped_weak_key: number;
    skipped_non_tier1_event: number;
    skipped_no_executable_anchor: number;
    market_level_keys_skipped: number;
    market_level_keys_normalized: number;
    // Horizon/WC floor diagnostics exposed after build.
    horizon_end_iso: string;
    window_end_iso: string;
    reserved_wc_or_soccer_count: number;
    skipped_by_horizon_count: number;
    skipped_by_cap_count: number;
    // ── Tier1 full-match underfill invariant counters (capacity-audit aligned). ──
    tier1PhysicalMatchesSeen: number;
    tier1ReservationsPlanned: number;
    tier1AlreadyReserved: number;
    tier1ReservationGapsAfterBuild: number;
    weakKeysMerged: number;
    representativeTitleReplaced: number;
    completeCandidateUniverseUsed: boolean;
    underfillInvariantPass: boolean;
    // ── Founder slot-fill fallback ladder (Tier2/Tier3, allowed full-match only). ──
    targetLiveSlots: number;
    tier1ReservedCount: number;
    fallbackSlotFillReservedCount: number;
    fallbackTier2Reserved: number;
    fallbackTier3Reserved: number;
    fallbackEligibleGroupsSeen: number;
    fallbackSkippedNoAllowedFullmatch: number;
    slotFillTargetReached: boolean;
  };
}

/**
 * Build the frozen event reservation plan (PURE — no DB writes).
 * Reserves an event when its best candidate is a Tier1 event opportunity within horizon.
 * Market-level halftime/side filtering is deliberately deferred to rebalance.
 */
export async function buildReservationPlan(
  nowMs: number,
  deps: { fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }> } = {}
): Promise<ReservationPlan> {
  const window = resolveNightWindow(nowMs);
  const planRunId = buildPlanRunId(nowMs);
  const fetchCandidates =
    deps.fetchCandidates ??
    (async () => {
      const { buildFireModelCandidates } = await import("./buildFireModelCandidates");
      return buildFireModelCandidates(PLAN_POOL, "all", true);
    });
  const { candidates: universe } = await fetchCandidates();

  const bySport: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  let skippedOutsideHorizon = 0;
  // Weak single-team keys are no longer discarded (they canonicalize/merge below);
  // retained at 0 so the diagnostics shape is unchanged for downstream readers.
  const skippedWeakKey = 0;
  let skippedNonTier1 = 0;
  let skippedNoExecutableAnchor = 0;
  let marketLevelKeysSkipped = 0;
  let marketLevelKeysNormalized = 0;
  let weakKeysMerged = 0;
  let representativeTitleReplaced = 0;

  // ── Canonical physical-match key (independent of market title). ──────────────
  // Every key shape that refers to the same physical game collapses to ONE group:
  // pair:*/fifwc-* are used directly; market-level lines fold into their clean
  // canonical_event_key; weak single-team SPREAD/MATCH_WINNER keys merge into the
  // opponent pair when it exists, otherwise stand alone (so the Tier1 invariant still
  // reserves them). Pure condition-id keys with no canonical identity return null → skip.
  const { repBySig, repByTeamDate, repByTeam } = buildPhysicalMatchIndex(universe);
  const canonicalPhysicalMatchKey = (c: FireModelCandidate): string | null => {
    const k = c.match_family_key;

    // Any two-team game (pair:* or raw "a vs b", any order) → single representative.
    const td = extractTeamsDate(c);
    if (td) {
      const rep = repBySig.get(teamsSig(td.a, td.b, td.date));
      if (rep && rep !== k) marketLevelKeysNormalized += 1;
      return rep ?? k;
    }

    if (k.startsWith("fifwc-")) return k;

    const spread = k.match(WEAK_SPREAD_KEY_RE);
    if (spread) {
      const merged = repByTeamDate.get(`${spread[1]}:${spread[2]}`);
      if (merged) { weakKeysMerged += 1; return merged; }
      return k; // own physical match — full-match spread still earns a reservation
    }

    const mw = k.match(WEAK_MATCH_WINNER_KEY_RE);
    if (mw) {
      const team = normTeam(mw[1]);
      const set = repByTeam.get(team);
      if (set && set.size === 1) { weakKeysMerged += 1; return [...set][0]; }
      return k; // own physical match — full-match moneyline still earns a reservation
    }

    if (isMarketLevelKey(c)) {
      const ck = normalizedEventKey(c);
      if (ck) { marketLevelKeysNormalized += 1; return ck; }
      return null; // market-level line with no clean canonical identity
    }
    return k; // event_slug-derived medium key (non-pair)
  };

  const groups = new Map<string, FireModelCandidate[]>();
  for (const c of universe) {
    const key = canonicalPhysicalMatchKey(c);
    if (!key) {
      marketLevelKeysSkipped += 1;
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const reservations: NightEventReservationRow[] = [];
  const rankable: Array<{ best: FireModelCandidate; group: FireModelCandidate[]; groupKey: string }> = [];
  // Founder slot-fill ladder: physical matches whose best executable anchor is below
  // Tier1 but has a positively-allowed full-match market. Held back and only promoted
  // to fill live slots up to TARGET_LIVE_SLOTS, Tier2 before Tier3.
  const fallbackRankable: Array<{
    best: FireModelCandidate;
    group: FireModelCandidate[];
    groupKey: string;
    fallbackTier: "TIER2" | "TIER3";
  }> = [];
  let fallbackSkippedNoAllowedFullmatch = 0;

  for (const [groupKey, arr] of groups.entries()) {
    const ranked = [...arr].sort(compareCandidateQuality);
    // Filter to executable anchors only: halftime/corners/props/exact-score/goalscorer
    // are forbidden as reservation anchors. NEVER fall back to a forbidden market, and
    // never let a forbidden-anchor candidate become the representative title.
    const executableAnchorRanked = ranked.filter((c) => !isForbiddenAnchorMarket(c));
    if (executableAnchorRanked.length === 0) {
      skippedNoExecutableAnchor += 1;
      continue;
    }
    if (isForbiddenAnchorMarket(ranked[0])) representativeTitleReplaced += 1;
    const best = executableAnchorRanked[0];
    const startMs = best.diagnostics.game_start_iso
      ? new Date(best.diagnostics.game_start_iso).getTime()
      : NaN;
    if (!Number.isFinite(startMs) || !isWithinHorizon(startMs, window, nowMs)) {
      skippedOutsideHorizon += 1;
      continue;
    }
    // Event-level eligibility: best candidate must be a Tier1 event opportunity.
    if (eventTierOf(best) === "TIER1") {
      rankable.push({ best, group: ranked, groupKey });
      continue;
    }
    // Tier1 absent for this real physical match. Per founder slot policy, hold it for the
    // explicit Tier2→Tier3 fallback ladder — but ONLY if a positively-allowed full-match
    // anchor exists. Pick the best executable anchor that is a real full-match market.
    const bestAllowedFullmatch = executableAnchorRanked.find(isAllowedFullMatchAnchor);
    const fbTier = bestAllowedFullmatch ? eventTierOf(bestAllowedFullmatch) : "REJECTED";
    if (!bestAllowedFullmatch || (fbTier !== "TIER2" && fbTier !== "TIER3")) {
      // No allowed full-match anchor → genuinely non-actionable, correct skip (NOT silent
      // when a forbidden-only inventory is the cause: counted for forensic visibility).
      skippedNonTier1 += 1;
      fallbackSkippedNoAllowedFullmatch += 1;
      continue;
    }
    fallbackRankable.push({ best: bestAllowedFullmatch, group: ranked, groupKey, fallbackTier: fbTier });
  }

  // Cross-event ranking by best-candidate quality.
  rankable.sort((a, b) => compareCandidateQuality(a.best, b.best));
  // Fallback ranking: Tier2 strictly before Tier3, then by candidate quality.
  fallbackRankable.sort((a, b) => {
    if (a.fallbackTier !== b.fallbackTier) return a.fallbackTier === "TIER2" ? -1 : 1;
    return compareCandidateQuality(a.best, b.best);
  });

  // Promote fallback groups only to reach TARGET_LIVE_SLOTS (never beyond), Tier2 first.
  const tier1Count = rankable.length;
  const fallbackSlotsToFill = Math.max(0, TARGET_LIVE_SLOTS - tier1Count);
  const promotedFallback = fallbackRankable.slice(0, fallbackSlotsToFill);
  let fallbackTier2Reserved = 0;
  let fallbackTier3Reserved = 0;

  const pushReservation = (
    best: FireModelCandidate,
    group: FireModelCandidate[],
    groupKey: string,
    tier: "TIER1" | "TIER2" | "TIER3",
    isFallback: boolean,
    idx: number
  ) => {
    bySport[best.inferred_sport] = (bySport[best.inferred_sport] ?? 0) + 1;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    const reason = isFallback
      ? `FALLBACK_SLOT_FILL_${tier}: score=${best.diagnostics.score} cov=${best.diagnostics.coverage} ` +
        `allowed_fullmatch_anchor markets_in_event=${group.length}`
      : `EVENT_FIRST_TIER1_OPPORTUNITY: score=${best.diagnostics.score} cov=${best.diagnostics.coverage} markets_in_event=${group.length}`;
    reservations.push({
      plan_run_id: planRunId,
      plan_date_minsk: window.planDateMinsk,
      window_start_iso: window.startIso,
      window_end_iso: window.endIso,
      // Canonical physical-match key (merged), not the per-candidate key — so exact-key
      // reservation matching downstream aligns with the capacity audit's physical groups.
      match_family_key: groupKey,
      event_slug: best.event_slug,
      event_title: cleanReservationEventTitle(best, groupKey),
      sport: best.inferred_sport,
      league: null,
      strategic_scope: best.strategic_scope,
      game_start_iso: best.diagnostics.game_start_iso,
      event_tier: tier,
      event_score: best.diagnostics.score,
      best_snapshot_id: best.signal_id,
      reservation_rank: idx + 1,
      status: "RESERVED",
      selection_reason: reason,
      diagnostics: {
        markets_in_event: group.length,
        scope_confidence: best.sport_classification_confidence,
        timing_bucket: best.timing_bucket,
        hours_to_start: best.diagnostics.hours_to_start_now,
        battle_trace_id: `contur3:${planRunId}:${groupKey}:unknown:unknown`,
        slot_fill: isFallback ? "FALLBACK_SLOT_FILL" : "TIER1_PRIMARY",
        fallback_tier: isFallback ? tier : undefined,
      },
    });
  };

  let rank = 0;
  rankable.forEach(({ best, group, groupKey }) => {
    pushReservation(best, group, groupKey, "TIER1", false, rank);
    rank += 1;
  });
  promotedFallback.forEach(({ best, group, groupKey, fallbackTier }) => {
    pushReservation(best, group, groupKey, fallbackTier, true, rank);
    rank += 1;
    if (fallbackTier === "TIER2") fallbackTier2Reserved += 1;
    else fallbackTier3Reserved += 1;
  });

  const reservedWcOrSoccerBuild = reservations.filter(
    (r) => r.strategic_scope === "WC" || r.strategic_scope === "SOCCER"
  ).length;

  return {
    plan_run_id: planRunId,
    plan_date_minsk: window.planDateMinsk,
    window,
    reservations,
    diagnostics: {
      universe_size: universe.length,
      event_groups: groups.size,
      canonical_event_groups: groups.size,
      reserved_count: reservations.length,
      by_sport: bySport,
      by_tier: byTier,
      skipped_outside_horizon: skippedOutsideHorizon,
      skipped_weak_key: skippedWeakKey,
      skipped_non_tier1_event: skippedNonTier1,
      skipped_no_executable_anchor: skippedNoExecutableAnchor,
      market_level_keys_skipped: marketLevelKeysSkipped,
      market_level_keys_normalized: marketLevelKeysNormalized,
      horizon_end_iso: window.horizonEndIso,
      window_end_iso: window.endIso,
      reserved_wc_or_soccer_count: reservedWcOrSoccerBuild,
      skipped_by_horizon_count: skippedOutsideHorizon,
      skipped_by_cap_count: 0,
      // Each rankable group is a Tier1 full-match physical match that passed horizon +
      // executable-anchor gates; the builder reserves exactly one per group, so planned
      // equals seen and the post-build gap is 0 by construction.
      tier1PhysicalMatchesSeen: rankable.length,
      tier1ReservationsPlanned: rankable.length,
      tier1AlreadyReserved: 0,
      tier1ReservationGapsAfterBuild: 0,
      weakKeysMerged,
      representativeTitleReplaced,
      completeCandidateUniverseUsed: true,
      // Every Tier1 physical match is reserved (gap 0 by construction); the slot-fill
      // ladder only adds eligible Tier2/Tier3 allowed-full-match matches on top.
      underfillInvariantPass: true,
      targetLiveSlots: TARGET_LIVE_SLOTS,
      tier1ReservedCount: tier1Count,
      fallbackSlotFillReservedCount: promotedFallback.length,
      fallbackTier2Reserved,
      fallbackTier3Reserved,
      fallbackEligibleGroupsSeen: fallbackRankable.length,
      fallbackSkippedNoAllowedFullmatch,
      slotFillTargetReached: reservations.length >= TARGET_LIVE_SLOTS,
    },
  };
}

export interface PersistReservationsResult {
  plan_run_id: string;
  already_exists: boolean;
  written_count: number;
  reserved_count: number;
  reservations: NightEventReservationRow[];
  diagnostics: ReservationPlan["diagnostics"];
}

/**
 * Injectable persistence boundary for night_event_reservations. The real
 * implementation (createSupabaseReservationRepoPort) reproduces the exact
 * read/delete/insert calls persistReservationPlan always made; tests inject
 * an in-memory fake instead of a live Supabase connection.
 */
export interface ReservationRepoPort {
  findByPlanRunId(planRunId: string): Promise<NightEventReservationRow[]>;
  deleteByPlanRunId(planRunId: string): Promise<void>;
  insert(rows: NightEventReservationRow[]): Promise<void>;
}

export function createSupabaseReservationRepoPort(): ReservationRepoPort {
  return {
    async findByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .select("*")
        .eq("plan_run_id", planRunId)
        .order("reservation_rank", { ascending: true });
      if (error) throw new Error(`reservation read failed: ${error.message}`);
      return (data ?? []) as unknown as NightEventReservationRow[];
    },
    async deleteByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin
        .from("night_event_reservations")
        .delete()
        .eq("plan_run_id", planRunId);
      if (error) throw new Error(`reservation force-delete failed: ${error.message}`);
    },
    async insert(rows) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { error } = await supabaseAdmin.from("night_event_reservations").insert(rows);
      if (error) throw new Error(`reservation insert failed: ${error.message}`);
    },
  };
}

/**
 * Persist a reservation plan idempotently. If the plan_run_id already has rows and
 * force is false, the existing frozen plan is returned untouched.
 */
export async function persistReservationPlan(
  plan: ReservationPlan,
  opts: { force?: boolean } = {},
  repo: ReservationRepoPort = createSupabaseReservationRepoPort()
): Promise<PersistReservationsResult> {
  const existing = await repo.findByPlanRunId(plan.plan_run_id);

  if (existing.length > 0 && !opts.force) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: true,
      written_count: 0,
      reserved_count: existing.length,
      reservations: existing,
      diagnostics: plan.diagnostics,
    };
  }

  if (existing.length > 0 && opts.force) {
    await repo.deleteByPlanRunId(plan.plan_run_id);
  }

  if (plan.reservations.length === 0) {
    return {
      plan_run_id: plan.plan_run_id,
      already_exists: false,
      written_count: 0,
      reserved_count: 0,
      reservations: [],
      diagnostics: plan.diagnostics,
    };
  }

  await repo.insert(plan.reservations);

  return {
    plan_run_id: plan.plan_run_id,
    already_exists: false,
    written_count: plan.reservations.length,
    reserved_count: plan.reservations.length,
    reservations: plan.reservations,
    diagnostics: plan.diagnostics,
  };
}

/**
 * Full reservation cron orchestration: build the plan, persist it
 * idempotently, and record job_runs evidence for both success and failure.
 * This is the entry point app/api/cron/night-event-reservations/route.ts
 * calls for its standard (non-status, non-forceRebuild) write path.
 */
export async function runReservationCronWithEvidence(
  nowMs: number,
  opts: { force?: boolean } = {},
  deps: {
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    repo?: ReservationRepoPort;
    jobEvidence?: SchedulerJobEvidencePort;
  } = {}
): Promise<{ plan: ReservationPlan; persisted: PersistReservationsResult }> {
  const jobEvidence = deps.jobEvidence ?? createSupabaseSchedulerJobEvidencePort();
  const startedAt = new Date().toISOString();
  try {
    const plan = await buildReservationPlan(nowMs, { fetchCandidates: deps.fetchCandidates });
    const persisted = deps.repo
      ? await persistReservationPlan(plan, opts, deps.repo)
      : await persistReservationPlan(plan, opts);
    const finishedAt = new Date().toISOString();
    await jobEvidence.writeJobRun({
      source: "night-event-reservations",
      formulaVersion: "reservation-v1",
      startedAt,
      finishedAt,
      status: persisted.written_count > 0 || persisted.already_exists ? "success" : "empty",
      generatedCount: persisted.written_count,
      rejectedCount:
        plan.diagnostics.skipped_non_tier1_event +
        plan.diagnostics.skipped_outside_horizon +
        plan.diagnostics.skipped_no_executable_anchor,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      diagnostics: {
        plan_run_id: persisted.plan_run_id,
        already_exists: persisted.already_exists,
        reserved_count: persisted.reserved_count,
      },
    });
    return { plan, persisted };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const msg = err instanceof Error ? err.message : "Unknown error";
    await jobEvidence.writeJobRun({
      source: "night-event-reservations",
      formulaVersion: "reservation-v1",
      startedAt,
      finishedAt,
      status: "error",
      generatedCount: 0,
      rejectedCount: 0,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      errorMessage: sanitizeSchedulerErrorMessage(msg),
    });
    throw err;
  }
}

/**
 * Persist reservation plan diagnostics to filesystem under modeling/fire_runs/contur3-reservations/.
 * Failure does NOT fail the business cron; it logs a warning and continues.
 */
export async function persistReservationPlanDiagnostics(
  plan: ReservationPlan,
  opts?: { context?: string }
): Promise<{ path: string | null; error: string | null }> {
  try {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runIdSafe = plan.plan_run_id.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `${runIdSafe}_${timestamp}.json`;

    const dirPath = path.join(process.cwd(), "modeling", "fire_runs", "contur3-reservations");
    await mkdir(dirPath, { recursive: true });

    const filePath = path.join(dirPath, filename);
    const payload = {
      generated_at: new Date().toISOString(),
      plan_run_id: plan.plan_run_id,
      plan_date_minsk: plan.plan_date_minsk,
      commit,
      context: opts?.context || "persistReservationPlan",
      diagnostics: plan.diagnostics,
      reservation_count: plan.reservations.length,
      reserved_events: plan.reservations.map((r) => ({
        rank: r.reservation_rank,
        event_title: r.event_title,
        match_family_key: r.match_family_key,
        sport: r.sport,
        tier: r.event_tier,
        score: r.event_score,
      })),
    };

    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
    return { path: filePath, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[persistReservationPlanDiagnostics] Diagnostic write failed (non-fatal):", msg);
    return { path: null, error: msg };
  }
}

// ── Founder email (rendered from frozen reservations, NOT stateless slots) ──────

function reservationRebalanceIso(gameStartIso: string): string {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return gameStartIso;
  return new Date(ms - REBALANCE_MINUTES_BEFORE_START * 60_000).toISOString();
}

function reservationExecWindowIso(gameStartIso: string): { from: string; to: string } {
  const ms = Date.parse(gameStartIso);
  if (!Number.isFinite(ms)) return { from: gameStartIso, to: gameStartIso };
  return {
    from: new Date(ms - PREFERRED_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
    to: new Date(ms - LATEST_ENTRY_MINUTES_BEFORE * 60_000).toISOString(),
  };
}

export function nightReservationEmail(
  planRunId: string,
  reservations: NightEventReservationRow[]
): { subject: string; text: string } {
  const L: string[] = [];
  const windowStart = reservations[0]?.window_start_iso ?? null;
  const windowEnd = reservations[0]?.window_end_iso ?? null;
  L.push(`PolyProPicks Night Portfolio Plan (frozen reservations)`);
  L.push(`plan_run_id: ${planRunId}`);
  if (windowStart && windowEnd) {
    L.push(`Window: ${formatMinskUtc(windowStart)} -> ${formatMinskUtc(windowEnd)}`);
  }
  L.push(`Reserved events: ${reservations.length}`);
  L.push("");
  L.push("CONTROL MODEL: Ireland AUTO-STARTS at 18:00 Minsk. This email is informational +");
  L.push("emergency-override only - NO approval required. Market selection per event happens");
  L.push("later at T-60/T-30 rebalance; Ireland reads only the execution queue.");
  L.push("");
  if (reservations.length === 0) {
    L.push("(no events reserved for tonight)");
  } else {
    L.push("Reserved events (event-level; one market chosen later per event):");
    reservations.forEach((r) => {
      const ew = reservationExecWindowIso(r.game_start_iso);
      L.push(
        `  #${r.reservation_rank} [${r.event_tier}] ${r.event_title} ` +
          `(${r.strategic_scope}/${r.sport ?? "?"})`
      );
      L.push(`      start:     ${formatMinskUtc(r.game_start_iso)}`);
      L.push(`      rebalance: ${formatMinskUtc(reservationRebalanceIso(r.game_start_iso))}`);
      L.push(`      exec win:  ${formatMinskUtc(ew.from)} -> ${formatMinskUtc(ew.to)}`);
    });
  }
  L.push("");
  L.push("NOTE: one reserved event = at most one live position after rebalance.");
  const subject = `PolyProPicks Night Plan — ${reservations.length} events reserved — ${planRunId}`;
  return { subject, text: L.join("\n") };
}

/**
 * Ensure a frozen plan exists for the current run, then return its reservations.
 * Used by the email path so the email always reflects persisted reservations.
 */
export async function ensureAndLoadReservations(
  nowMs: number,
  opts: { allowCreate?: boolean } = {}
): Promise<{ planRunId: string; reservations: NightEventReservationRow[]; created: boolean }> {
  const planRunId = buildPlanRunId(nowMs);
  let reservations = await loadReservations(planRunId);
  let created = false;
  if (reservations.length === 0 && opts.allowCreate) {
    const plan = await buildReservationPlan(nowMs);
    await persistReservationPlan(plan, { force: false });
    reservations = await loadReservations(planRunId);
    created = true;
  }
  return { planRunId, reservations, created };
}

/** Read frozen reservations for a plan_run_id, rank-ordered. */
export async function loadReservations(planRunId: string): Promise<NightEventReservationRow[]> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`reservation load failed: ${error.message}`);
  return (data ?? []) as NightEventReservationRow[];
}

// ── Plan health diagnostics ────────────────────────────────────────────────

// Minimum overnight battle WC/soccer event floor. If fewer are reserved than this
// threshold and the plan has rows, needs_rebuild is set to true so founders see the signal.
const BATTLE_WC_MIN_FLOOR = 2;

export interface PlanHealth {
  has_rows: boolean;
  total_count: number;
  reserved_count: number;
  queued_count: number;
  skipped_count: number;
  expired_count: number;
  bad_market_level_count: number;
  active_future_count: number;
  earliest_game_start_iso: string | null;
  latest_game_start_iso: string | null;
  is_expired_only: boolean;
  needs_rebuild: boolean;
  rebuild_allowed: boolean;
  // Horizon diagnostics — populated from resolveNightWindow at status-read time.
  window_end_iso: string;
  horizon_end_iso: string;
  // WC/soccer floor diagnostics.
  reserved_wc_or_soccer_count: number;
  // eligible_wc_or_soccer_count = reserved count when loaded from DB (no rebuild);
  // it equals the actual eligible count only during a fresh build run.
  eligible_wc_or_soccer_count: number;
  wc_floor_below_minimum: boolean;
  // skipped_by_horizon_count and skipped_by_cap_count are only available during a
  // fresh buildReservationPlan run; 0 when loaded from existing DB rows.
  skipped_by_horizon_count: number;
  skipped_by_cap_count: number;
}

/**
 * Read existing plan rows from DB and compute health diagnostics.
 * Pure read — no writes. Returns zero-counts when the plan does not exist yet.
 */
export async function loadPlanStatus(planRunId: string, nowMs: number): Promise<PlanHealth> {
  const { supabaseAdmin } = await import("@/lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("night_event_reservations")
    .select("*")
    .eq("plan_run_id", planRunId)
    .order("reservation_rank", { ascending: true });
  if (error) throw new Error(`loadPlanStatus: ${error.message}`);

  const rows = (data ?? []) as NightEventReservationRow[];
  const total = rows.length;

  const statusBuckets: Record<string, number> = {};
  for (const r of rows) statusBuckets[r.status] = (statusBuckets[r.status] ?? 0) + 1;

  const reservedCount = statusBuckets["RESERVED"] ?? 0;
  const rebalancePendingCount = statusBuckets["REBALANCE_PENDING"] ?? 0;
  const queuedCount = statusBuckets["QUEUED"] ?? 0;
  const skippedCount = (statusBuckets["SKIPPED"] ?? 0) + (statusBuckets["CANCELLED"] ?? 0);
  const expiredCount = statusBuckets["EXPIRED"] ?? 0;

  const ACTIVE_STATUSES = new Set(["RESERVED", "REBALANCE_PENDING", "QUEUED"]);
  const activeFutureRows = rows.filter(
    (r) => ACTIVE_STATUSES.has(r.status) && !!r.game_start_iso && Date.parse(r.game_start_iso) > nowMs
  );
  const activeFutureCount = activeFutureRows.length;

  // Post-hoc check: rows whose match_family_key looks like a market-level prop line.
  const badMarketLevelCount = rows.filter((r) => MARKET_LEVEL_KEY_RE.test(r.match_family_key)).length;

  const gameStartTimes = rows
    .map((r) => r.game_start_iso)
    .filter((s): s is string => !!s)
    .sort();

  const isExpiredOnly = total > 0 && activeFutureCount === 0;

  // WC/soccer floor: count active reservations with WC or SOCCER strategic_scope.
  const reservedWcOrSoccer = rows.filter(
    (r) =>
      ACTIVE_STATUSES.has(r.status) &&
      (r.strategic_scope === "WC" || r.strategic_scope === "SOCCER")
  ).length;
  const wcFloorBelowMinimum = total > 0 && reservedWcOrSoccer < BATTLE_WC_MIN_FLOOR;

  // needs_rebuild: expired-only, bad market keys, or WC floor below minimum battle threshold.
  const needsRebuild = isExpiredOnly || badMarketLevelCount > 0 || wcFloorBelowMinimum;

  // Horizon bounds computed from current window (read-time, not build-time).
  const nightWindow = resolveNightWindow(nowMs);

  return {
    has_rows: total > 0,
    total_count: total,
    reserved_count: reservedCount + rebalancePendingCount,
    queued_count: queuedCount,
    skipped_count: skippedCount,
    expired_count: expiredCount,
    bad_market_level_count: badMarketLevelCount,
    active_future_count: activeFutureCount,
    earliest_game_start_iso: gameStartTimes[0] ?? null,
    latest_game_start_iso: gameStartTimes[gameStartTimes.length - 1] ?? null,
    is_expired_only: isExpiredOnly,
    needs_rebuild: needsRebuild,
    rebuild_allowed: true,
    window_end_iso: nightWindow.endIso,
    horizon_end_iso: nightWindow.horizonEndIso,
    reserved_wc_or_soccer_count: reservedWcOrSoccer,
    eligible_wc_or_soccer_count: reservedWcOrSoccer,
    wc_floor_below_minimum: wcFloorBelowMinimum,
    skipped_by_horizon_count: 0,
    skipped_by_cap_count: 0,
  };
}

export interface ForceRebuildResult {
  plan_run_id: string;
  deleted_queue_count: number;
  deleted_reservation_count: number;
  plan: ReservationPlan;
  persist: PersistReservationsResult;
  plan_health: PlanHealth;
}

// ── bounded retry (reads and idempotent deletes ONLY -- never inserts) ─────
export interface BoundedRetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
}

export interface StageRetryError extends Error {
  stage: string;
  attempts: number;
}

const DEFAULT_SAFE_RETRY_POLICY: BoundedRetryPolicy = {
  maxAttempts: 3,
  backoffMs: (attempt) => Math.min(200 * attempt, 1000),
};

/**
 * Retries a read or idempotent-delete operation up to `policy.maxAttempts`
 * times with bounded backoff. Never used for inserts -- an insert failure is
 * handled by persistReservationPlanWithReconciliation instead, which reads
 * back canonical identities rather than blindly repeating the write.
 */
async function withBoundedRetry<T>(
  stage: string,
  op: () => Promise<T>,
  policy: BoundedRetryPolicy = DEFAULT_SAFE_RETRY_POLICY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  let lastMessage = "unknown error";
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (attempt < policy.maxAttempts) {
        await sleep(policy.backoffMs(attempt));
      }
    }
  }
  const retryError = new Error(
    `${stage} failed after ${policy.maxAttempts} attempts: ${sanitizeSchedulerErrorMessage(lastMessage)}`
  ) as StageRetryError;
  retryError.stage = stage;
  retryError.attempts = policy.maxAttempts;
  throw retryError;
}

// ── force-rebuild delete boundary (idempotent -- safe to retry) ────────────
export interface ForceRebuildRepoPort {
  deleteQueueByPlanRunId(planRunId: string): Promise<{ deletedCount: number }>;
  deleteReservationsByPlanRunId(planRunId: string): Promise<{ deletedCount: number }>;
}

export function createSupabaseForceRebuildRepoPort(): ForceRebuildRepoPort {
  return {
    async deleteQueueByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("event_execution_queue")
        .delete()
        .eq("plan_run_id", planRunId)
        .select("id");
      if (error) throw new Error(`forceRebuild queue delete: ${error.message}`);
      return { deletedCount: data?.length ?? 0 };
    },
    async deleteReservationsByPlanRunId(planRunId) {
      const { supabaseAdmin } = await import("@/lib/supabase/server");
      const { data, error } = await supabaseAdmin
        .from("night_event_reservations")
        .delete()
        .eq("plan_run_id", planRunId)
        .select("id");
      if (error) throw new Error(`forceRebuild reservation delete: ${error.message}`);
      return { deletedCount: data?.length ?? 0 };
    },
  };
}

export interface AmbiguousInsertError extends Error {
  stage: string;
  ambiguous: true;
}

/**
 * Persists a reservation plan, but never blindly retries the insert itself.
 * If persistReservationPlan throws (e.g. a network-shaped error where the
 * database may have accepted the write despite the client seeing a failure),
 * this reconciles by reading back the plan_run_id's existing rows and
 * checking whether every planned reservation identity
 * (match_family_key + reservation_rank -- the same pair the DB's own
 * night_event_reservations_plan_event_uniq / *_reservation_rank_uniq
 * constraints key on) is already present. Only then is the run reported as
 * successful; otherwise it fails closed with sanitized stage context, and no
 * second insert is ever attempted.
 */
async function persistReservationPlanWithReconciliation(
  plan: ReservationPlan,
  repo: ReservationRepoPort
): Promise<PersistReservationsResult> {
  try {
    return await persistReservationPlan(plan, { force: false }, repo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const existing = await repo.findByPlanRunId(plan.plan_run_id);
    const reservationIdentity = (r: NightEventReservationRow) => `${r.match_family_key}::${r.reservation_rank}`;
    const expectedKeys = new Set(plan.reservations.map(reservationIdentity));
    const presentKeys = new Set(existing.map(reservationIdentity));
    const allPresent = plan.reservations.length > 0 && [...expectedKeys].every((k) => presentKeys.has(k));
    if (allPresent) {
      return {
        plan_run_id: plan.plan_run_id,
        already_exists: false,
        written_count: plan.reservations.length,
        reserved_count: existing.length,
        reservations: existing,
        diagnostics: plan.diagnostics,
      };
    }
    const reconciliationError = new Error(
      `force_rebuild_insert_reconciliation failed: ${sanitizeSchedulerErrorMessage(msg)}`
    ) as AmbiguousInsertError;
    reconciliationError.stage = "force_rebuild_insert_reconciliation";
    reconciliationError.ambiguous = true;
    throw reconciliationError;
  }
}

/**
 * CEO-approved force rebuild for the current plan_run_id.
 * Deletes event_execution_queue rows AND night_event_reservations rows for this plan,
 * then rebuilds fresh from the current universe.
 * Only touches the two Contur3 tables for the current plan_run_id.
 *
 * This is the exact function the production night-reservation cron invokes
 * (the runner always calls the route with ?forceRebuild=CEO_APPROVED). Reads
 * and the two idempotent deletes are bounded-retried; the reservation insert
 * is never blindly retried (see persistReservationPlanWithReconciliation);
 * job_runs evidence is recorded for both success and terminal failure.
 */
export async function executeForceRebuild(
  nowMs: number,
  deps: {
    fetchCandidates?: () => Promise<{ candidates: FireModelCandidate[] }>;
    repo?: ReservationRepoPort;
    forceRebuildRepo?: ForceRebuildRepoPort;
    jobEvidence?: SchedulerJobEvidencePort;
    loadPlanStatus?: (planRunId: string, nowMs: number) => Promise<PlanHealth>;
  } = {}
): Promise<ForceRebuildResult> {
  const repo = deps.repo ?? createSupabaseReservationRepoPort();
  const forceRebuildRepo = deps.forceRebuildRepo ?? createSupabaseForceRebuildRepoPort();
  const jobEvidence = deps.jobEvidence ?? createSupabaseSchedulerJobEvidencePort();
  const loadPlanStatusFn = deps.loadPlanStatus ?? loadPlanStatus;
  const planRunId = buildPlanRunId(nowMs);
  const startedAt = new Date().toISOString();

  try {
    // 1. Delete event_execution_queue rows for this plan_run_id (idempotent, retry-safe).
    const { deletedCount: deletedQueueCount } = await withBoundedRetry("force_rebuild_queue_delete", () =>
      forceRebuildRepo.deleteQueueByPlanRunId(planRunId)
    );

    // 2. Delete night_event_reservations rows for this plan_run_id (idempotent, retry-safe).
    const { deletedCount: deletedResCount } = await withBoundedRetry("force_rebuild_reservation_delete", () =>
      forceRebuildRepo.deleteReservationsByPlanRunId(planRunId)
    );

    // 3. Rebuild from current universe. Candidate-page reads already retry
    //    internally (fetchAllPlanningRows' own bounded per-page retry+timeout).
    const plan = await buildReservationPlan(nowMs, { fetchCandidates: deps.fetchCandidates });

    // 4. Persist -- insert is never blindly retried; an ambiguous failure is
    //    reconciled by reading back canonical identities, never re-inserted.
    const persist = await persistReservationPlanWithReconciliation(plan, repo);

    // 5. Read back health of the new plan (read, retry-safe).
    const planHealth = await withBoundedRetry("force_rebuild_plan_health_read", () =>
      loadPlanStatusFn(planRunId, nowMs)
    );

    const finishedAt = new Date().toISOString();
    await jobEvidence.writeJobRun({
      source: "night-event-reservations-force-rebuild",
      formulaVersion: "force-rebuild-v1",
      startedAt,
      finishedAt,
      status: "success",
      generatedCount: persist.written_count,
      rejectedCount:
        plan.diagnostics.skipped_non_tier1_event +
        plan.diagnostics.skipped_outside_horizon +
        plan.diagnostics.skipped_no_executable_anchor,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      diagnostics: {
        plan_run_id: planRunId,
        deleted_queue_count: deletedQueueCount,
        deleted_reservation_count: deletedResCount,
        reserved_count: persist.reserved_count,
      },
    });

    return {
      plan_run_id: planRunId,
      deleted_queue_count: deletedQueueCount,
      deleted_reservation_count: deletedResCount,
      plan,
      persist,
      plan_health: planHealth,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    const msg = err instanceof Error ? err.message : "Unknown error";
    await jobEvidence.writeJobRun({
      source: "night-event-reservations-force-rebuild",
      formulaVersion: "force-rebuild-v1",
      startedAt,
      finishedAt,
      status: "error",
      generatedCount: 0,
      rejectedCount: 0,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      errorMessage: sanitizeSchedulerErrorMessage(msg),
    });
    throw err;
  }
}
