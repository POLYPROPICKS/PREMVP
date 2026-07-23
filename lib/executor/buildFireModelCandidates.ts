import { createHash } from "crypto";
import {
  classifyMarketText,
  isAllowedFullMatchMarketClass,
  type MarketClass,
} from "@/lib/contur3/taxonomy";
import { sanitizeSchedulerErrorMessage } from "./schedulerJobEvidence";
import {
  produceFrozenModelV2ShadowDecisions,
  FROZEN_MODEL_V2_VERSION,
} from "@/lib/modeling/frozenModelProducerV2Shadow";
import {
  getCanonicalTokenIdForExportRow,
  getStrictDedupKeyForExportRow,
  type ExportRow,
} from "@/lib/modeling/generatedSignalPairsExportContract";
import { EXECUTABLE_STAKE_USD } from "./executorQueueTypes";

const POLICY_VERSION = "battle-sm-guard-v1-20260615";
const LIVE_POLICY_VERSION = "live-risk-guard-v1";
// P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1: cap max base stake at $7 (was $10).
// Source-proof: STAKE_5_DRAWDOWN_PROTECT ROI=14.98% MaxDD=$73.56 (P0B 2026-06-22).
const STAKE_GUARD_POLICY = "P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1";
const STAKE_GUARD_MAX_BASE_USD = 7;

// Contract A / Contur3 candidate-source selector (Integration Phase 1).
// CONTUR3_CURRENT (default) is the existing scored/shadow candidate universe
// below -- byte-identical to pre-Phase-1 behavior. CONTRACT_A_V1 instead
// consumes the FROZEN Model V2 shadow producer's own final acceptedDecisions
// (produceFrozenModelV2ShadowDecisions) verbatim and maps them into the
// FireModelCandidate shape without ever running Contur3's formula-version/
// coverage/tier/bad-bucket/scope eligibility predicates against them --
// those predicates belong to a different, non-authoritative contract and
// must never re-filter or re-rank an already-decided Contract A winner.
export type FireModelSelectorMode = "CONTUR3_CURRENT" | "CONTRACT_A_PLANNING_V1" | "CONTRACT_A_V1";
const KNOWN_SELECTOR_MODES: readonly FireModelSelectorMode[] = ["CONTUR3_CURRENT", "CONTRACT_A_PLANNING_V1", "CONTRACT_A_V1"];

export type StrategicScope = "WC" | "SOCCER" | "MLB" | "ESPORT" | "OTHER" | "UNKNOWN";
export type IdentityQuality = "STRONG" | "MEDIUM" | "WEAK" | "INVALID";
export type SportClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

// Timing buckets used for diagnostics and live policy auditing.
// TODO(timing-audit): once resolved data is available, run per-sport win_rate/net_pnl
// query grouped by timing_bucket to decide data-driven cutoffs per sport/market_family.
// Current rule: WC/soccer hard-gated to ≤1h (T_0_30M + T_30_60M only).
// Non-football: no hard gate yet — monitor timing_bucket distribution in CEO view first.
export type TimingBucket =
  | "T_0_30M"
  | "T_30_60M"
  | "T_1_2H"
  | "T_2_6H"
  | "T_6H_PLUS"
  | "STARTED_OR_MISSING";

// Raw diagnostics collected during buildFireModelCandidates when planningMode=true.
// Passed through to the night-plan route for operator visibility.
export interface RawPlanningDiagnostics {
  total_db_rows: number;
  scored_rows_count: number;
  planning_shadow_rows_count: number;
  planning_shadow_included_count: number;
  planning_shadow_rejected_count: number;
  planning_shadow_reject_reasons: Record<string, number>;
  wc_soccer_candidate_count: number;
  fallback_candidate_count: number;
  source_counts_by_formula_version: Record<string, number>;
  activity_label_rows: number;
  rows_missing_game_start: number;
  rows_using_expires_at: number;
  rows_using_created_at_fallback: number;
  rows_missing_event_slug: number;
  rows_missing_selected_token: number;
  rows_missing_selected_outcome: number;
  wc_like_rows: number;
  soccer_like_rows: number;
  wc_tier2_override_candidates: number;
  wc_tier2_override_live_enabled: number;
  wc_tier2_override_rejected_by_reason: Record<string, number>;
  sport_classification_confidence_counts: Record<string, number>;
  match_family_quality_counts: Record<string, number>;
  rejected_before_planning_by_reason: Record<string, number>;
  sample_source_rows: Array<Record<string, unknown>>;
  // Per-version drop-reason breakdown — reveals why shadow-strategic-sports-v1 rows are dropped.
  dropped_by_formula_version_and_reason: Record<string, Record<string, number>>;
  // Which versions were queried vs. which had zero DB rows returned.
  versions_queried: string[];
  versions_with_zero_db_rows: string[];
  // Contur3 full-match admission accounting (canonical taxonomy: lib/contur3/taxonomy.ts).
  // Diagnostics ONLY — admission decisions are unchanged. Invariant (INVARIANTS §7):
  // raw_allowed_fullmatch_rows === fullmatch_admitted_count + Σ fullmatch_rejected_by_reason,
  // so RAW_ALLOWED_FULLMATCH_GT0_BUILDER_FULLMATCH_EQ0 traces to exact reasons, never a silent drop.
  fullmatch_market_class_counts: Record<string, number>;
  raw_allowed_fullmatch_rows: number;
  raw_forbidden_rows: number;
  fullmatch_admitted_count: number;
  fullmatch_rejected_by_reason: Record<string, number>;
  // Compact per-row trace for allowed full-match raw rows that did NOT become a candidate.
  missing_fullmatch_fixtures: Array<{
    event_key: string;
    identity: string;
    market_class: string;
    reject_reason: string;
  }>;
}

export interface FireModelCandidate {
  signal_id: string;
  // Real generated_signal_pairs.id UUID, when available -- deliberately
  // separate from signal_id, which on the Contract A V1 path is
  // observationId (a `condition_id::token_id` strict-dedup key, NOT a row
  // UUID). Never conflate the two: only this field is safe to use as
  // event_execution_queue.diagnostics.source_signal_id.
  generated_signal_pair_id?: string | null;
  strategy: string;
  rank: number;
  market_slug: string;
  // Stable match-family key used for cross-market dedupe (spread + total + corners = same event).
  // Priority: fifwc-* event_slug → team_pair extraction → other event_slug → condition_id (WEAK).
  match_family_key: string;
  match_family_key_source: "event_slug" | "team_pair" | "condition_id_weak";
  // true when match_family_key is backed only by condition_id (market-level, not event-level).
  match_family_key_is_weak: boolean;
  event_slug: string | null;
  providerEventKey?: string | null;
  providerEventTitle?: string | null;
  providerMarketQuestion?: string | null;
  authoritativeSportFamily?: string | null;
  authoritativeGame?: string | null;
  authoritativeLeague?: string | null;
  authoritativeEventStart?: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  selected_outcome: string | null;
  inferred_sport: string;
  market_family: string;
  strategic_scope: StrategicScope;
  timing_bucket: TimingBucket;
  // CanonicalMarketIdentity v0 fields.
  identity_quality: IdentityQuality;
  identity_warning_codes: string[];
  canonical_event_key: string | null;
  canonical_market_key: string | null;
  activity_label_detected: boolean;
  sport_classification_confidence: SportClassificationConfidence;
  // Live eligibility layer (live-risk-guard-v1).
  live_eligible: boolean;
  live_rejection_reason: string | null;
  side_mapping_status: "PROVEN_BY_TOKEN_ID" | "UNKNOWN_BLOCKED" | "TITLE_OUTCOME_AMBIGUOUS_BLOCKED";
  live_block_reason: string | null;
  live_policy_version: string;
  paper_eligible: boolean;
  max_entry_price: number;
  stake_usd: number;
  max_order_usd: number;
  max_spread: number;
  one_order_only: boolean;
  executor_mode_allowed: string;
  first_live_test_allowed: boolean;
  stale_after: string;
  no_trade_after: string | null;
  idempotency_key: string;
  model_rule_id: string;
  created_at: string;
  source: string;
  diagnostics: {
    executor_action: string;
    paper_only: boolean;
    real_trade: boolean;
    score: number;
    coverage: number;
    smart_money: number | null;
    entry_price: number;
    game_start_iso: string;
    hours_to_start_now: number;
    fire_model_alias: string;
    version: string;
    pilot_tier3_fallback?: true;
    live_policy_override?: "WC_TIER2_68_COV50";
    override_reason?: "FOUNDER_APPROVED_WC_TIER2_SMALL_STAKE";
    max_stake_cap?: 5;
    wc_tier2_override_rejected_reason?: string;
    // Contract A authoritative-decision provenance (CONTRACT_A_V1 selector
    // mode only). Present iff this candidate originates from a FROZEN Model
    // V2 acceptedDecision; absent for CONTUR3_CURRENT candidates. These
    // fields are immutable -- reservation/rebalance must persist them
    // verbatim and must never substitute a different market when present.
    selector_id?: string;
    contract_a_stage?: "PLANNING" | "FINAL_AUTHORITATIVE";
    authoritative_condition_id?: string;
    authoritative_token_id?: string;
    authoritative_side?: string;
    authoritative_observation_id?: string;
    authoritative_event_key?: string;
  };
}

// Execution endpoint uses the strict version set only.
const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"];
// Planning endpoint includes shadow-strategic-sports-v1 for the full planning universe.
const PLANNING_ALLOWED_VERSIONS = [
  "shadow-strategic-sports-v1",
  "v2-lite-growth-safe",
  "shadow-firemodel1_1_research_v0",
];

// Shared select column list for the generated_signal_pairs candidate queries.
const SIGNAL_SELECT_COLS =
  "id, condition_id, selected_outcome, selected_token_id, entry_price_num, " +
  "signal_confidence_num, smart_money_score_num, diagnostics, " +
  "market_slug, event_slug, metric_formula_version, created_at, expires_at";

// Live executor row cap (recency-bounded). Planning mode is NEVER capped here.
const LIVE_ROW_LIMIT = 150;
const PLANNING_PAGE_SIZE = 1000;
const PLANNING_FETCH_CEILING = 200_000; // hard safety ceiling, far above realistic corpus
// created_at lookback that bounds the planning corpus. Mirrors the reservation capacity
// audit's LOOKBACK_HOURS so the builder universe == the audit universe, and so the
// paginated scan stays bounded (an unbounded full-history scan hits a statement timeout).
const PLANNING_LOOKBACK_HOURS = parseInt(process.env.PLANNING_LOOKBACK_HOURS ?? "72", 10);

// Bounded per-page retry policy for fetchAllPlanningRows. A page read is a pure
// Supabase SELECT -- safe to retry (unlike an insert, which is never blindly
// retried anywhere in this codebase's Contur3 reservation path). Each retry
// attempt also carries its own abort timeout via the Supabase query builder's
// .abortSignal(), the same pattern already used in
// scripts/contur3/run-overnight-battle-audit.mjs for generated_signal_pairs reads.
export interface PlanningPageFetchError extends Error {
  stage: string;
  page: number;
  attempts: number;
}

export interface PaginatedFetchRetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  pageTimeoutMs: number;
}

const DEFAULT_PLANNING_PAGE_RETRY_POLICY: PaginatedFetchRetryPolicy = {
  maxAttempts: 3,
  backoffMs: (attempt) => Math.min(200 * attempt, 1000),
  pageTimeoutMs: 15000,
};

// Fetch the COMPLETE matching corpus via Supabase .range() pagination (no row cap).
// Used by planningMode only so the reservation producer sees every Tier1 candidate.
// Exported so tests can exercise pagination/retry/timeout behavior directly
// against an injected query builder, without a live Supabase connection.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchAllPlanningRows(
  buildQuery: () => any,
  opts: {
    stage?: string;
    retryPolicy?: PaginatedFetchRetryPolicy;
    sleep?: (ms: number) => Promise<void>;
  } = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const stage = opts.stage ?? "planning_paginated_fetch";
  const retryPolicy = opts.retryPolicy ?? DEFAULT_PLANNING_PAGE_RETRY_POLICY;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let from = 0;
  let page = 0;
  for (;;) {
    page += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let batch: any[] | null = null;
    let lastMessage = "unknown error";
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), retryPolicy.pageTimeoutMs);
      try {
        const { data, error } = await buildQuery()
          .range(from, from + PLANNING_PAGE_SIZE - 1)
          .abortSignal(controller.signal);
        clearTimeout(timeoutHandle);
        if (!error) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          batch = (data ?? []) as any[];
          break;
        }
        lastMessage = error.message;
      } catch (err) {
        clearTimeout(timeoutHandle);
        lastMessage = err instanceof Error ? err.message : String(err);
      }
      if (attempt < retryPolicy.maxAttempts) {
        await sleep(retryPolicy.backoffMs(attempt));
      }
    }
    if (batch === null) {
      const planningError = new Error(
        `${stage} failed: page=${page} attempts=${retryPolicy.maxAttempts} cause=${sanitizeSchedulerErrorMessage(lastMessage)}`
      ) as PlanningPageFetchError;
      planningError.stage = stage;
      planningError.page = page;
      planningError.attempts = retryPolicy.maxAttempts;
      throw planningError;
    }
    all.push(...batch);
    if (batch.length < PLANNING_PAGE_SIZE) break;
    from += PLANNING_PAGE_SIZE;
    if (from > PLANNING_FETCH_CEILING) break;
  }
  return all;
}

const TIER_ORDER: Record<string, number> = {
  TIER1_CORE_STRICT_72_COV50: 1,
  TIER2_SAFE_EXPAND_60_COV50: 2,
  TIER3_MICRO_EXPAND_50_COV25: 3,
};

const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
const TENNIS_RE = /\bset\s+[12]\b|\btennis\b/i;
// \bfifwc\b catches Polymarket FIFA World Cup event slugs (e.g. fifwc-fra-sen-2026-06-16).
const WC_EXPLICIT_RE = /\bfifwc\b|world[\s-]?cup|wc2026|\bfifa\b/i;
// WC 2026 participating countries for title-fallback classification.
const WC_COUNTRY_RE =
  /\b(france|senegal|iraq|norway|argentina|algeria|austria|jordan|saudi[\s-]arabia|uruguay|iran|new[\s-]zealand|spain|cape[\s-]verde|belgium|egypt|portugal|england|croatia|ghana|panama|colombia|uzbekistan|dr[\s-]congo|germany|ecuador|netherlands|sweden|japan|tunisia|mexico|south[\s-]korea|canada|qatar|brazil|morocco|scotland|haiti|\busa\b|australia|turkey|paraguay)\b/i;
// Football market phrase patterns (O/U, corners, halftime, etc.).
const FOOTBALL_PHRASE_RE =
  /\bo\/u\b|over[\s/]under|total\s+corners|\bcorners\b|\bspread\b|match\s+winner|\bhalftime\b|leading\s+at\s+halftime|2nd\s+half|total\s+goals|both\s+teams\s+to\s+score|correct\s+score/i;
const SOCCER_RE =
  /soccer|\bfootball\b|premier[\s-]league|serie[\s-]a|bundesliga|la[\s-]liga|\bmls\b|champions[\s-]league|europa[\s-]league|ligue|eredivisie|match[\s-]result|clean[\s-]sheet|btts|both[\s-]teams/i;
const MLB_RE =
  /\bmlb\b|\bbaseball\b|royals|yankees|red[\s-]sox|dodgers|\bcubs\b|\bmets\b|cardinals|\bbraves\b|astros|phillies|padres|mariners|brewers|pirates|\breds\b|orioles|nationals|athletics|\btigers\b|\btwins\b|white[\s-]sox|\brangers\b|\bangels\b|guardians|\brays\b|rockies|diamondbacks|marlins|blue[\s-]jays/i;
// Activity label patterns that must never be used as sport classifier or event key input.
const ACTIVITY_LABEL_RE = /matched\s+activity|market\s+activity|live\s+market\s+activity/i;
const PURE_VOLUME_RE = /^\s*\$[\d,.]+\s*[KkMmBb]?\s*$/;
// Single-team spread title without an opponent: "spread: norway (-1.5)", "spread: argentina (+0.5)".
// These MUST NOT become independent STRONG/MEDIUM event families — mark WEAK pending resolution.
const SINGLE_TEAM_SPREAD_RE = /^spread:\s*([\w][\w\s'-]*?)\s*\([+-]?\d+\.?\d*\)\s*$/i;

// Returns true for strings like "$25K matched activity", "Live market activity",
// or bare volume labels like "$25K". These are UI activity labels, not market titles.
export function isActivityLabelText(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  const t = value.trim();
  return ACTIVITY_LABEL_RE.test(t) || PURE_VOLUME_RE.test(t);
}

// Build the canonical identity text for a row, quarantining activity-label market_slugs.
// Priority: event_slug → diagnostics.marketTitle/eventTitle/question/title → market_slug
// (market_slug used only when it is not an activity label).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildIdentityText(
  row: any,
  planningMode = false
): { text: string; activityLabelDetected: boolean } {
  const diag: Record<string, unknown> = row.diagnostics ?? {};
  const activityLabelDetected = isActivityLabelText(row.market_slug);
  const researchContext =
    diag.researchContext && typeof diag.researchContext === "object"
      ? (diag.researchContext as Record<string, unknown>)
      : null;
  const providerContext = providerContextOf(diag);
  const planningSources: unknown[] = [
    providerContext?.eventTitle,
    providerContext?.marketQuestion,
    researchContext?.eventTitle,
    diag.eventTitle,
    researchContext?.eventSlug,
    diag.marketTitle,
    researchContext?.marketTitle,
    diag.question,
    diag.title,
    row.event_slug,
    activityLabelDetected ? null : row.market_slug,
  ];
  const liveSources: unknown[] = [
    row.event_slug,
    diag.marketTitle,
    diag.eventTitle,
    diag.question,
    diag.title,
    activityLabelDetected ? null : row.market_slug,
  ];
  const sources = planningMode ? planningSources : liveSources;
  for (const v of sources) {
    if (typeof v === "string" && v.trim() && !isActivityLabelText(v)) {
      return { text: v.trim().toLowerCase(), activityLabelDetected };
    }
  }
  return { text: "", activityLabelDetected };
}

function providerContextOf(diag: Record<string, unknown>): Record<string, string> | null {
  const raw = diag.providerEventContext;
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (c.v !== "v1" || c.provider !== "polymarket") return null;
  const out: Record<string, string> = {};
  for (const key of ["eventId", "eventSlug", "eventTitle", "marketQuestion", "sportFamily", "game", "league", "eventStartIso"]) {
    if (typeof c[key] === "string" && c[key].trim()) out[key] = c[key].trim();
  }
  return out;
}

function providerEventKeyOf(context: Record<string, string> | null, gameStartIso: string): string | null {
  const identity = context?.eventSlug ?? context?.eventId;
  const start = context?.eventStartIso ?? gameStartIso;
  if (!identity || !/^[-a-z0-9_]+$/i.test(identity) || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return null;
  return `polymarket:${identity.toLowerCase()}:${start.slice(0, 10)}`;
}

function authoritativeScope(context: Record<string, string> | null): StrategicScope | null {
  if (!context) return null;
  const text = `${context.sportFamily ?? ""} ${context.game ?? ""} ${context.league ?? ""}`.toLowerCase();
  return /esport|\blol\b|valorant|dota|cs2|counter-strike/.test(text) ? "ESPORT" : null;
}

function safeLower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function resolvePlanningScope(
  row: any,
  identityText: string,
  derivedScope: StrategicScope
): { scope: StrategicScope; confidence: SportClassificationConfidence } {
  if (derivedScope !== "UNKNOWN") return { scope: derivedScope, confidence: "HIGH" };
  const diag: Record<string, unknown> = row.diagnostics ?? {};
  const shadowScope = safeLower(diag.shadowScope);
  const text = `${identityText} ${safeLower(diag.marketTitle)} ${safeLower(diag.eventTitle)} ${safeLower(diag.question)}`;
  if (/(world[\s-]?cup|wc2026|fifwc)/i.test(shadowScope) || /(world[\s-]?cup|wc2026|fifwc)/i.test(text)) {
    return { scope: "WC", confidence: "MEDIUM" };
  }
  if (/(soccer|football|premier[\s-]league|la[\s-]liga|bundesliga|serie[\s-]a|champions[\s-]league|europa[\s-]league)/i.test(shadowScope) ||
      /(soccer|football|premier[\s-]league|la[\s-]liga|bundesliga|serie[\s-]a|champions[\s-]league|europa[\s-]league)/i.test(text)) {
    return { scope: "SOCCER", confidence: "MEDIUM" };
  }
  return { scope: derivedScope, confidence: "NONE" };
}

function computePlanningFallbackScore(
  row: any,
  scope: StrategicScope,
  identityText: string
): { score: number | null; coverage: number | null; source: string } {
  const diag: Record<string, unknown> = row.diagnostics ?? {};
  const tier = typeof diag.tier === "number" ? diag.tier : null;
  const entryPrice =
    typeof diag.entryPrice === "number"
      ? diag.entryPrice
      : typeof row.entry_price_num === "number"
        ? row.entry_price_num
        : null;
  const volumeUsd = typeof diag.volumeUsd === "number" ? diag.volumeUsd : null;
  const hasEnoughIdentity =
    Boolean(identityText) &&
    Boolean(row.condition_id) &&
    Boolean(row.selected_token_id) &&
    (typeof diag.gameStartIso === "string" || Boolean(row.expires_at));
  if (!hasEnoughIdentity) {
    return { score: null, coverage: null, source: "shadow_sports_fallback_incomplete" };
  }

  const base = tier === 1 ? 72 : tier === 2 ? 66 : (scope === "WC" ? 68 : 58);
  const priceBonus =
    typeof entryPrice === "number"
      ? Math.max(0, 6 - Math.round(Math.abs(entryPrice - 0.5) * 12))
      : 0;
  const volumeBonus =
    typeof volumeUsd === "number" && volumeUsd > 0
      ? Math.min(6, Math.floor(Math.log10(volumeUsd)))
      : 0;
  const scopeBonus = scope === "WC" || scope === "SOCCER" ? 2 : 0;
  const score = Math.max(0, Math.min(79, Math.round(base + priceBonus + volumeBonus + scopeBonus)));

  let coverage: number | null = null;
  if (typeof diag.dataCoverage === "number") coverage = diag.dataCoverage;
  else if (typeof diag.coverage === "number") coverage = diag.coverage;
  else if (row.selected_token_id && row.condition_id && entryPrice != null && scope !== "UNKNOWN") coverage = 50;

  return { score, coverage, source: "shadow_sports_fallback" };
}

// Classify sport scope from identity text.
// Priority: negative guards → explicit WC tokens → MLB → soccer leagues →
//   WC country-pair + football phrase fallback.
function deriveSportScope(identityText: string): {
  scope: StrategicScope;
  confidence: SportClassificationConfidence;
} {
  if (ESPORTS_RE.test(identityText)) return { scope: "ESPORT", confidence: "HIGH" };
  if (NBA_NHL_RE.test(identityText)) return { scope: "UNKNOWN", confidence: "HIGH" };
  if (TENNIS_RE.test(identityText)) return { scope: "UNKNOWN", confidence: "HIGH" };
  if (WC_EXPLICIT_RE.test(identityText)) return { scope: "WC", confidence: "HIGH" };
  if (MLB_RE.test(identityText)) return { scope: "MLB", confidence: "HIGH" };
  if (SOCCER_RE.test(identityText)) return { scope: "SOCCER", confidence: "HIGH" };
  // Football/WC title fallback: recognized country pair + football market phrase.
  const hasCountry = WC_COUNTRY_RE.test(identityText);
  const hasFootballPhrase = FOOTBALL_PHRASE_RE.test(identityText);
  if (hasCountry && hasFootballPhrase) return { scope: "WC", confidence: "MEDIUM" };
  if (hasCountry && /halftime/i.test(identityText)) return { scope: "SOCCER", confidence: "MEDIUM" };
  return { scope: "UNKNOWN", confidence: "NONE" };
}

// Derive the stable match_family_key and identity quality for a row.
// Priority: fifwc-* event_slug → team-pair extraction from identity text →
//   other event_slug → condition_id (WEAK).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveMatchFamilyKey(row: any, identityText: string): {
  key: string;
  source: "event_slug" | "team_pair" | "condition_id_weak";
  quality: IdentityQuality;
  canonicalEventKey: string | null;
} {
  const rawEventSlug =
    typeof row.event_slug === "string" && row.event_slug.trim()
      ? row.event_slug.trim().toLowerCase()
      : null;

  // Priority 1: fifwc-* slug is the strongest canonical event identity.
  if (rawEventSlug && /^fifwc-/.test(rawEventSlug)) {
    return { key: rawEventSlug, source: "event_slug", quality: "STRONG", canonicalEventKey: rawEventSlug };
  }

  // Priority 2: team pair extracted from identity text.
  // Matches "France vs. Senegal: O/U 2.5" → pair:france-vs-senegal:<date>
  const pairMatch = identityText.match(
    /\b([\w\s'-]+?)\s+vs\.?\s+([\w\s'-]+?)(?:\s*[:|,]|$)/i
  );
  if (pairMatch) {
    const team1 = pairMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
    const team2 = pairMatch[2].trim().toLowerCase().replace(/\s+/g, "-");
    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const gameStartIso =
      typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;
    const dateStr = gameStartIso ? gameStartIso.slice(0, 10) : "nodate";
    const key = `pair:${team1}-vs-${team2}:${dateStr}`;
    const quality: IdentityQuality = dateStr !== "nodate" ? "STRONG" : "MEDIUM";
    return { key, source: "team_pair", quality, canonicalEventKey: key };
  }

  // Priority 2b: single-team spread title (no opponent) e.g. "Spread: England (-1.5)".
  // Before marking WEAK, check if diagnostics.eventTitle or researchContext.eventTitle
  // has a "vs" pair — if so, use that pair as the match_family_key (MEDIUM quality).
  // This ensures full-match spread markets are grouped with their parent event reservation,
  // not isolated as WEAK standalone keys that can never be live-eligible.
  if (!identityText.match(/\bvs\.?\b/i) && SINGLE_TEAM_SPREAD_RE.test(identityText)) {
    const diagObj: Record<string, unknown> = row.diagnostics ?? {};
    const resCtx =
      diagObj.researchContext && typeof diagObj.researchContext === "object"
        ? (diagObj.researchContext as Record<string, unknown>)
        : null;
    const eventTitleCandidates = [
      typeof diagObj.eventTitle === "string" ? diagObj.eventTitle : "",
      resCtx && typeof resCtx.eventTitle === "string" ? resCtx.eventTitle : "",
      resCtx && typeof resCtx.eventSlug === "string" ? resCtx.eventSlug : "",
    ];
    for (const et of eventTitleCandidates) {
      if (!et) continue;
      const etLower = et.trim().toLowerCase();
      const evPairMatch = etLower.match(/\b([\w\s'-]+?)\s+vs\.?\s+([\w\s'-]+?)(?:\s*[:|,]|$)/i);
      if (evPairMatch) {
        const team1 = evPairMatch[1].trim().toLowerCase().replace(/\s+/g, "-");
        const team2 = evPairMatch[2].trim().toLowerCase().replace(/\s+/g, "-");
        const gameStartIso = typeof diagObj.gameStartIso === "string" ? diagObj.gameStartIso : null;
        const dateStr = gameStartIso ? gameStartIso.slice(0, 10) : "nodate";
        const key = `pair:${team1}-vs-${team2}:${dateStr}`;
        return {
          key,
          source: "team_pair",
          quality: dateStr !== "nodate" ? "STRONG" : "MEDIUM",
          canonicalEventKey: key,
        };
      }
    }
    // No event-title pair found: fall back to WEAK single-team spread key.
    const sm = SINGLE_TEAM_SPREAD_RE.exec(identityText)!;
    const team = sm[1].trim().toLowerCase().replace(/\s+/g, "-");
    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const gameStartIso = typeof diag.gameStartIso === "string" ? diag.gameStartIso : null;
    const dateStr = gameStartIso ? gameStartIso.slice(0, 10) : "nodate";
    return {
      key: `WEAK_SINGLE_TEAM_SPREAD:${team}:${dateStr}`,
      source: "condition_id_weak",
      quality: "WEAK",
      canonicalEventKey: null,
    };
  }

  if (!identityText.match(/\bvs\.?\b/i) && /\bmatch\s+winner\b/i.test(identityText)) {
    const team = identityText
      .replace(/\bmatch\s+winner\b/i, "")
      .replace(/[—–-]+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-");
    return {
      key: `WEAK_SINGLE_TEAM_MATCH_WINNER:${team || "unknown"}`,
      source: "condition_id_weak",
      quality: "WEAK",
      canonicalEventKey: null,
    };
  }

  // Priority 3: any other event slug (non-fifwc).
  if (rawEventSlug) {
    return { key: rawEventSlug, source: "event_slug", quality: "MEDIUM", canonicalEventKey: rawEventSlug };
  }

  // Fallback: condition_id — market-level only, not event-level (WEAK).
  const weakKey = `WEAK_MARKET_LEVEL_KEY:${row.condition_id}`;
  return { key: weakKey, source: "condition_id_weak", quality: "WEAK", canonicalEventKey: null };
}

/**
 * Extract selected_outcome from multiple sources in priority order.
 * 1. Top-level row.selected_outcome column.
 * 2. row.diagnostics.selectedOutcome / .outcome.
 * 3. row.diagnostics.researchContext.selectedOutcome / .outcome.
 * 4. Token-ID → outcome array mapping via row.diagnostics.clobTokenIds + .outcomes.
 * Returns null only when no safe derivation is possible (caller must not default to Yes for live).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSelectedOutcome(row: any, diag: Record<string, unknown>): string | null {
  if (typeof row.selected_outcome === "string") return row.selected_outcome;
  if (typeof diag.selectedOutcome === "string") return diag.selectedOutcome;
  if (typeof diag.outcome === "string") return diag.outcome;
  const rc =
    diag.researchContext && typeof diag.researchContext === "object"
      ? (diag.researchContext as Record<string, unknown>)
      : null;
  if (rc) {
    if (typeof rc.selectedOutcome === "string") return rc.selectedOutcome;
    if (typeof rc.outcome === "string") return rc.outcome;
  }
  // Token-ID → outcome mapping: Polymarket binary markets store clobTokenIds + outcomes arrays.
  const clobIds = Array.isArray(diag.clobTokenIds) ? (diag.clobTokenIds as unknown[]) : null;
  const outArr = Array.isArray(diag.outcomes) ? (diag.outcomes as unknown[]) : null;
  if (clobIds && outArr && row.selected_token_id) {
    const idx = clobIds.findIndex((id) => id === row.selected_token_id);
    if (idx !== -1 && typeof outArr[idx] === "string") return outArr[idx] as string;
  }
  return null;
}

function inferSportAndFamily(scope: StrategicScope): { sport: string; family: string } {
  switch (scope) {
    case "WC":     return { sport: "soccer",   family: "world_cup" };
    case "SOCCER": return { sport: "soccer",   family: "soccer"    };
    case "MLB":    return { sport: "baseball", family: "mlb"       };
    case "ESPORT": return { sport: "esport",   family: "esport"    };
    default:       return { sport: "unknown",  family: "other"     };
  }
}

function computeTier(score: number, coverage: number): string | null {
  if (score >= 72 && coverage >= 50) return "TIER1_CORE_STRICT_72_COV50";
  if (score >= 60 && coverage >= 50) return "TIER2_SAFE_EXPAND_60_COV50";
  if (score >= 50 && coverage >= 25) return "TIER3_MICRO_EXPAND_50_COV25";
  return null;
}

function computeBaseStake(score: number, coverage: number): number {
  if (score >= 72 && coverage >= 75) return STAKE_GUARD_MAX_BASE_USD; // P0C: was 10
  if (score >= 72 && coverage >= 50) return 7;
  if (score >= 60 && coverage >= 50) return 7;
  if (score >= 50 && coverage >= 25) return 3;
  return 0;
}

function computeStake(base: number, smartMoney: number | null, esports: boolean): number {
  let stake = smartMoney != null && smartMoney >= 75 ? Math.floor(base / 2) : base;
  if (esports) stake = Math.min(stake, 5);
  return Math.min(stake, 10);
}

function computeExecutorAction(score: number, coverage: number, hoursToStart: number, tier: string): string {
  if (hoursToStart < 0) return "SKIP_STARTED";
  if (hoursToStart <= 2 && (tier === "TIER1_CORE_STRICT_72_COV50" || tier === "TIER2_SAFE_EXPAND_60_COV50")) {
    return "BET_OR_PAPER_GO";
  }
  if (score >= 75 && coverage >= 75 && hoursToStart <= 6) return "QUEUE_TOP_TIER_ONLY";
  if (hoursToStart > 6) return "QUEUE_LATER";
  return "QUEUE_WAIT_T_MINUS_60";
}

function makeIdempotencyKey(signalId: string, tokenId: string): string {
  return createHash("sha256")
    .update(`${signalId}__${tokenId}__${POLICY_VERSION}`)
    .digest("hex")
    .slice(0, 32);
}

function computeTimingBucket(hoursToStart: number): TimingBucket {
  if (hoursToStart < 0) return "STARTED_OR_MISSING";
  if (hoursToStart <= 0.5) return "T_0_30M";
  if (hoursToStart <= 1.0) return "T_30_60M";
  if (hoursToStart <= 2.0) return "T_1_2H";
  if (hoursToStart <= 6.0) return "T_2_6H";
  return "T_6H_PLUS";
}

/**
 * Centralised live eligibility decision. Called after hard-rejects (UNKNOWN,
 * football-too-early, football-No-side) have already been applied via `continue`.
 *
 * Returns soft-reject codes for candidates that are paper-safe but not directly
 * Tier1-live. The night planner can promote Tier2/Tier3 through the
 * founder-approved quota fallback ladder.
 *   BELOW_LIVE_FALLBACK_POOL        — eligible only if planner needs fallback quota.
 *   WEAK_IDENTITY_LIVE_BLOCKED      — identity quality WEAK or INVALID.
 *   WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED — event key is market-level only.
 *   QUEUE_LATER_NOT_LIVE_ELIGIBLE   — game >6h away.
 */
function computeLiveEligibility(
  tier: string,
  matchFamilyKeySource: "event_slug" | "team_pair" | "condition_id_weak",
  matchFamilyKey: string,
  hoursToStart: number,
  identityQuality: IdentityQuality
): { liveEligible: boolean; liveRejectionReason: string | null } {
  if (tier !== "TIER1_CORE_STRICT_72_COV50") {
    return {
      liveEligible: false,
      liveRejectionReason: "BELOW_LIVE_FALLBACK_POOL",
    };
  }
  if (identityQuality === "WEAK" || identityQuality === "INVALID") {
    return { liveEligible: false, liveRejectionReason: "WEAK_IDENTITY_LIVE_BLOCKED" };
  }
  const isWeakKey =
    matchFamilyKeySource === "condition_id_weak" ||
    matchFamilyKey.startsWith("WEAK_MARKET_LEVEL_KEY:");
  if (isWeakKey) {
    return { liveEligible: false, liveRejectionReason: "WEAK_MATCH_FAMILY_KEY_LIVE_BLOCKED" };
  }
  if (hoursToStart > 6.0) {
    return { liveEligible: false, liveRejectionReason: "QUEUE_LATER_NOT_LIVE_ELIGIBLE" };
  }
  return { liveEligible: true, liveRejectionReason: null };
}

function isWcTier2LiveOverrideCandidate(args: {
  tier: string;
  strategicScope: StrategicScope;
  sport: string;
  identityText: string;
  eventSlug: string | null;
  score: number;
  coverage: number;
  tokenId: unknown;
  conditionId: unknown;
  side: string;
  selectedOutcome: string | null;
  hoursToStart: number;
  identityQuality: IdentityQuality;
  matchFamilyKeyIsWeak: boolean;
  matchFamilyKey: string;
  liveRejectionReason: string | null;
}): { allowed: boolean; reason: string } {
  if (args.liveRejectionReason !== "BELOW_LIVE_FALLBACK_POOL") return { allowed: false, reason: "NOT_FALLBACK_POOL" };
  if (args.tier !== "TIER2_SAFE_EXPAND_60_COV50") return { allowed: false, reason: "NOT_TIER2" };
  const wcText = `${args.identityText} ${args.eventSlug ?? ""} ${args.sport}`.toLowerCase();
  const isExplicitWc = args.strategicScope === "WC" || (args.sport === "soccer" && WC_EXPLICIT_RE.test(wcText));
  if (!isExplicitWc) return { allowed: false, reason: "NOT_WC_SCOPE" };
  if (args.score < 68) return { allowed: false, reason: "LOW_SCORE" };
  if (args.coverage < 50) return { allowed: false, reason: "LOW_COVERAGE" };
  if (!args.tokenId) return { allowed: false, reason: "MISSING_TOKEN" };
  if (!args.conditionId) return { allowed: false, reason: "MISSING_CONDITION" };
  if (!args.selectedOutcome || !args.side) return { allowed: false, reason: "MISSING_SIDE" };
  if (args.side.toLowerCase() === "no") return { allowed: false, reason: "UNSAFE_NO_SIDE" };
  if (args.identityQuality === "WEAK" || args.identityQuality === "INVALID") return { allowed: false, reason: "WEAK_IDENTITY" };
  if (args.matchFamilyKeyIsWeak || args.matchFamilyKey.startsWith("WEAK_MARKET_LEVEL_KEY:")) {
    return { allowed: false, reason: "WEAK_MATCH_FAMILY_KEY" };
  }
  if (args.hoursToStart < 0) return { allowed: false, reason: "GAME_STARTED_OR_INVALID" };
  if (args.hoursToStart > 1.0) return { allowed: false, reason: "OUTSIDE_WC_TIER2_LIVE_WINDOW" };
  return { allowed: true, reason: "WC_TIER2_OVERRIDE_ALLOWED" };
}

// planningMode is OFF by default. When true (night-plan universe only):
//   1) includes shadow-strategic-sports-v1 in the version filter.
//   2) relaxes the soccer/WC ≤1h live timing gate so future matches appear as
//      future planning slots.
// Every other guard (UNKNOWN, No-side, weak key, TIER3, started, bad-bucket)
// is unchanged, and the live /candidates route NEVER sets this flag.
// Optional injected-row seam (Integration Milestone 2B.1): when supplied, the
// two internal generated_signal_pairs queries below are replaced by
// client-side filtering of this single pre-fetched row set, using the exact
// same in-scope predicate constants (versions, PLANNING_LOOKBACK_HOURS, the
// scored/shadow WHERE-clause-equivalent conditions) -- not a re-derived or
// duplicated copy of the eligibility logic. This lets a caller (e.g. the
// frozen-model/Contur3 compatibility bridge) guarantee both producers observe
// one identical bounded snapshot with zero additional Supabase reads. The
// default call path (injectedRows omitted) is completely unchanged: this
// parameter does not alter query construction, filters, ordering, or any
// downstream candidate-construction/ranking/stake/price logic.
function contractARowIdentity(row: ExportRow): { conditionId: string | null; tokenId: string | null } {
  const rawConditionId = row.condition_id ?? row.conditionId;
  const conditionId =
    typeof rawConditionId === "string" && rawConditionId.trim() !== ""
      ? rawConditionId.trim()
      : typeof rawConditionId === "number" && Number.isFinite(rawConditionId)
        ? String(rawConditionId)
        : null;
  return { conditionId, tokenId: getCanonicalTokenIdForExportRow(row) };
}

function contractATimingBucket(minutesUntilStart: number): TimingBucket {
  if (minutesUntilStart < 0) return "STARTED_OR_MISSING";
  if (minutesUntilStart <= 30) return "T_0_30M";
  if (minutesUntilStart <= 60) return "T_30_60M";
  if (minutesUntilStart <= 120) return "T_1_2H";
  if (minutesUntilStart <= 360) return "T_2_6H";
  return "T_6H_PLUS";
}

/**
 * Maps the FROZEN Model V2 shadow producer's own final acceptedDecisions into
 * the FireModelCandidate shape, preserving condition_id/token_id/side/
 * observation identity exactly as the producer emitted them. Runs NONE of
 * Contur3's formula-version/coverage/tier/bad-bucket/scope predicates --
 * Contract A's own eligibility gates (score/price/timing/eSports/T-90/
 * identity/binary market type) already ran inside
 * produceFrozenModelV2ShadowDecisions. injectedRows is the existing approved
 * bounded-source-row seam (Integration Milestone 2B.1); CONTRACT_A_V1
 * requires it explicitly (fails closed rather than silently re-deriving a
 * different row set via a fresh, undocumented query).
 */
async function buildContractAV1Candidates(
  limit: number,
  injectedRows?: readonly Record<string, unknown>[]
): Promise<{ candidates: FireModelCandidate[]; rawDiagnostics: RawPlanningDiagnostics | null }> {
  let sourceRows: readonly ExportRow[];
  if (injectedRows !== undefined) {
    sourceRows = injectedRows as readonly ExportRow[];
  } else {
    const { supabaseAdmin } = await import("@/lib/supabase/server");
    const lookbackIso = new Date(Date.now() - PLANNING_LOOKBACK_HOURS * 3_600_000).toISOString();
    sourceRows = await fetchAllPlanningRows(
      () => supabaseAdmin.from("generated_signal_pairs").select("*").gte("created_at", lookbackIso).order("created_at", { ascending: false }),
      { stage: "contract_a_final_rows_fetch" }
    ) as ExportRow[];
  }
  const asOfIso = new Date().toISOString();
  const result = produceFrozenModelV2ShadowDecisions(sourceRows, asOfIso);

  const byObservationId = new Map<string, ExportRow>();
  for (const row of sourceRows) {
    const key = getStrictDedupKeyForExportRow(row);
    if (key !== null && !byObservationId.has(key)) byObservationId.set(key, row);
  }

  const candidates: Array<Omit<FireModelCandidate, "rank">> = [];
  for (const decision of result.acceptedDecisions) {
    const sourceRow = byObservationId.get(decision.observationId);
    if (sourceRow === undefined) continue; // defensive: should not happen for an accepted decision

    const { conditionId, tokenId } = contractARowIdentity(sourceRow);
    const side = decision.selectedOutcome;
    const identityComplete = conditionId !== null && tokenId !== null && side.trim() !== "";
    const sideMappingStatus: FireModelCandidate["side_mapping_status"] = identityComplete
      ? "PROVEN_BY_TOKEN_ID"
      : "UNKNOWN_BLOCKED";
    const liveRejectionReason = identityComplete
      ? null
      : conditionId === null
        ? "MISSING_CONDITION_ID"
        : tokenId === null
          ? "MISSING_TOKEN_ID"
          : "MISSING_SIDE";

    const createdMs = Date.parse(decision.createdAtIso);
    const gameStartIso = Number.isFinite(createdMs)
      ? new Date(createdMs + decision.minutesUntilStart * 60_000).toISOString()
      : decision.createdAtIso;
    const hoursToStartNow = decision.minutesUntilStart / 60;
    const eventSlug = typeof sourceRow.event_slug === "string" ? sourceRow.event_slug : null;
    const marketSlug = typeof sourceRow.market_slug === "string" ? sourceRow.market_slug : decision.eventKey;
    const staleAfter = typeof sourceRow.expires_at === "string" ? sourceRow.expires_at : gameStartIso;

    const contractASourceRowId = typeof sourceRow.id === "string" && sourceRow.id.trim() !== "" ? sourceRow.id : null;

    candidates.push({
      signal_id: decision.observationId,
      generated_signal_pair_id: contractASourceRowId,
      strategy: "TIER1_CORE_STRICT_72_COV50",
      market_slug: marketSlug,
      match_family_key: decision.eventKey,
      match_family_key_source: "event_slug",
      match_family_key_is_weak: false,
      event_slug: eventSlug,
      condition_id: conditionId ?? "",
      token_id: tokenId ?? "",
      side,
      selected_outcome: side,
      inferred_sport: "unknown",
      market_family: "contract_a_authoritative",
      strategic_scope: "OTHER",
      timing_bucket: contractATimingBucket(decision.minutesUntilStart),
      identity_quality: identityComplete ? "STRONG" : "INVALID",
      identity_warning_codes: [],
      canonical_event_key: decision.eventKey,
      canonical_market_key: conditionId,
      activity_label_detected: false,
      sport_classification_confidence: "HIGH",
      live_eligible: identityComplete,
      live_rejection_reason: liveRejectionReason,
      side_mapping_status: sideMappingStatus,
      live_block_reason: liveRejectionReason,
      live_policy_version: LIVE_POLICY_VERSION,
      paper_eligible: true,
      max_entry_price: decision.entryPrice,
      stake_usd: EXECUTABLE_STAKE_USD,
      max_order_usd: EXECUTABLE_STAKE_USD,
      max_spread: 0.03,
      one_order_only: true,
      executor_mode_allowed: "dry_run_only",
      first_live_test_allowed: true,
      stale_after: staleAfter,
      no_trade_after: gameStartIso,
      idempotency_key: makeIdempotencyKey(decision.observationId, tokenId ?? ""),
      model_rule_id: FROZEN_MODEL_V2_VERSION,
      created_at: decision.createdAtIso,
      source: `ContractA_${FROZEN_MODEL_V2_VERSION}`,
      diagnostics: {
        executor_action: identityComplete ? "BET_OR_PAPER_GO" : "SKIP_STARTED",
        paper_only: !identityComplete,
        real_trade: false,
        score: decision.score,
        coverage: 100,
        smart_money: null,
        entry_price: decision.entryPrice,
        game_start_iso: gameStartIso,
        hours_to_start_now: hoursToStartNow,
        fire_model_alias: "ContractA",
        version: FROZEN_MODEL_V2_VERSION,
        selector_id: FROZEN_MODEL_V2_VERSION,
        contract_a_stage: "FINAL_AUTHORITATIVE",
        authoritative_condition_id: conditionId ?? undefined,
        authoritative_token_id: tokenId ?? undefined,
        authoritative_side: side,
        authoritative_observation_id: decision.observationId,
        authoritative_event_key: decision.eventKey,
      },
    });
  }

  return {
    candidates: candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 })),
    rawDiagnostics: null,
  };
}

export async function buildFireModelCandidates(
  limit: number,
  scope = "all",
  planningMode = false,
  injectedRows?: readonly Record<string, unknown>[],
  selectorMode: FireModelSelectorMode = "CONTUR3_CURRENT"
): Promise<{ candidates: FireModelCandidate[]; rawDiagnostics: RawPlanningDiagnostics | null }> {
  if (!KNOWN_SELECTOR_MODES.includes(selectorMode)) {
    throw new Error(`UNKNOWN_SELECTOR_MODE: ${String(selectorMode)}`);
  }
  if (selectorMode === "CONTRACT_A_V1") {
    return await buildContractAV1Candidates(limit, injectedRows);
  }
  const versions = planningMode ? PLANNING_ALLOWED_VERSIONS : ALLOWED_VERSIONS;
  if (!planningMode) {
    console.log("[ireland-executor] TIER1_ONLY guard active");
  }

  const planningLookbackIso = new Date(
    Date.now() - PLANNING_LOOKBACK_HOURS * 3_600_000
  ).toISOString();

  let scoredRows: any[];
  let planningShadowRows: any[] = [];

  if (injectedRows !== undefined) {
    // Supplied-row mode: zero Supabase reads. Derive the same two logical
    // subsets the SQL queries below would have produced, applying the
    // identical predicates in-memory to the one supplied snapshot.
    const nowIso = new Date().toISOString();
    scoredRows = injectedRows.filter(
      (row) =>
        versions.includes(row.metric_formula_version as string) &&
        row.signal_result == null &&
        typeof row.expires_at === "string" &&
        row.expires_at > nowIso &&
        row.selected_token_id != null &&
        row.condition_id != null &&
        row.entry_price_num != null &&
        typeof row.signal_confidence_num === "number" &&
        row.signal_confidence_num >= 50 &&
        (!planningMode || (typeof row.created_at === "string" && row.created_at >= planningLookbackIso))
    ) as any[];
    if (planningMode) {
      planningShadowRows = injectedRows.filter(
        (row) =>
          row.metric_formula_version === "shadow-strategic-sports-v1" &&
          row.signal_result == null &&
          typeof row.expires_at === "string" &&
          row.expires_at > nowIso &&
          row.selected_token_id != null &&
          row.condition_id != null &&
          row.signal_confidence_num == null &&
          typeof row.created_at === "string" &&
          row.created_at >= planningLookbackIso
      ) as any[];
    }
    if (!planningMode) {
      scoredRows = scoredRows
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, LIVE_ROW_LIMIT);
    }
  } else {
    // Dynamic import (not a static top-level import) so this module can be
    // imported -- e.g. to unit-test fetchAllPlanningRows in isolation -- without
    // eagerly requiring a live/fake SUPABASE_URL at module-load time. Mirrors
    // the same fix already applied to nightEventReservations.ts/eventExecutionQueue.ts.
    const { supabaseAdmin } = await import("@/lib/supabase/server");

    // Scored candidate query — same filters in both modes. The ONLY difference is row
    // coverage: the live executor stays recency-bounded (.limit), but planningMode must
    // see the COMPLETE candidate universe via full .range() pagination. A row cap here
    // was the dominant cause of Contur3 reservation underfill — physical matches whose
    // Tier1 full-match candidate fell outside the most-recent slice were never reserved.
    const buildScoredQuery = () =>
      supabaseAdmin
        .from("generated_signal_pairs")
        .select(SIGNAL_SELECT_COLS)
        .in("metric_formula_version", versions)
        .is("signal_result", null)
        .gt("expires_at", new Date().toISOString())
        .not("selected_token_id", "is", null)
        .not("condition_id", "is", null)
        .not("entry_price_num", "is", null)
        .gte("signal_confidence_num", 50)
        .order("created_at", { ascending: false });

    if (planningMode) {
      scoredRows = await fetchAllPlanningRows(
        () => buildScoredQuery().gte("created_at", planningLookbackIso),
        { stage: "planning_scored_rows_fetch" }
      );
    } else {
      const { data, error } = await buildScoredQuery().limit(LIVE_ROW_LIMIT);
      if (error) throw new Error(`DB query failed: ${error.message}`);
      scoredRows = (data ?? []) as any[];
    }

    // NOTE: this shadow-rows query is NOT a duplicate of buildScoredQuery() above --
    // it is deliberately disjoint: scored rows require signal_confidence_num >= 50,
    // shadow rows require signal_confidence_num IS NULL (not yet scored). Both
    // paginated fetches are therefore preserved as separate calls; there is no
    // single snapshot that could serve both without changing candidate eligibility.
    if (planningMode) {
      const buildShadowQuery = () =>
        supabaseAdmin
          .from("generated_signal_pairs")
          .select(SIGNAL_SELECT_COLS)
          .eq("metric_formula_version", "shadow-strategic-sports-v1")
          .is("signal_result", null)
          .gt("expires_at", new Date().toISOString())
          .not("selected_token_id", "is", null)
          .not("condition_id", "is", null)
          .is("signal_confidence_num", null)
          .order("created_at", { ascending: false });
      planningShadowRows = await fetchAllPlanningRows(
        () => buildShadowQuery().gte("created_at", planningLookbackIso),
        { stage: "planning_shadow_rows_fetch" }
      );
    }
  }

  const mergedRows: any[] = [];
  const seenRowKeys = new Set<string>();
  for (const row of (scoredRows ?? []) as any[]) {
    const key = `${row.condition_id}__${row.selected_token_id}`;
    if (seenRowKeys.has(key)) continue;
    seenRowKeys.add(key);
    mergedRows.push({ ...row, __planning_source: "scored" });
  }
  for (const row of planningShadowRows) {
    const key = `${row.condition_id}__${row.selected_token_id}`;
    if (seenRowKeys.has(key)) continue;
    seenRowKeys.add(key);
    mergedRows.push({ ...row, __planning_source: "shadow_fallback" });
  }

  const now = Date.now();
  const candidates: Array<Omit<FireModelCandidate, "rank">> = [];

  const rawDiag: RawPlanningDiagnostics | null = planningMode
    ? {
        total_db_rows: mergedRows.length,
        scored_rows_count: (scoredRows ?? []).length,
        planning_shadow_rows_count: planningShadowRows.length,
        planning_shadow_included_count: 0,
        planning_shadow_rejected_count: 0,
        planning_shadow_reject_reasons: {},
        wc_soccer_candidate_count: 0,
        fallback_candidate_count: 0,
        source_counts_by_formula_version: {},
        activity_label_rows: 0,
        rows_missing_game_start: 0,
        rows_using_expires_at: 0,
        rows_using_created_at_fallback: 0,
        rows_missing_event_slug: 0,
        rows_missing_selected_token: 0,
        rows_missing_selected_outcome: 0,
        wc_like_rows: 0,
        soccer_like_rows: 0,
        wc_tier2_override_candidates: 0,
        wc_tier2_override_live_enabled: 0,
        wc_tier2_override_rejected_by_reason: {},
        sport_classification_confidence_counts: {},
        match_family_quality_counts: {},
        rejected_before_planning_by_reason: {},
        sample_source_rows: [],
        dropped_by_formula_version_and_reason: {},
        versions_queried: [...versions],
        versions_with_zero_db_rows: [],
        fullmatch_market_class_counts: {},
        raw_allowed_fullmatch_rows: 0,
        raw_forbidden_rows: 0,
        fullmatch_admitted_count: 0,
        fullmatch_rejected_by_reason: {},
        missing_fullmatch_fixtures: [],
      }
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of mergedRows) {
    if (rawDiag) {
      const ver = (row.metric_formula_version as string) ?? "unknown";
      rawDiag.source_counts_by_formula_version[ver] =
        (rawDiag.source_counts_by_formula_version[ver] ?? 0) + 1;
      if (!row.selected_token_id) rawDiag.rows_missing_selected_token += 1;
      if (!row.selected_outcome)  rawDiag.rows_missing_selected_outcome += 1;
      if (!row.event_slug)        rawDiag.rows_missing_event_slug += 1;
    }

    const diag: Record<string, unknown> = row.diagnostics ?? {};
    const providerContext = providerContextOf(diag);
    // Canonical market class of this raw row (assigned once identityText is derived
    // below). Every live-allowed full-match raw row is then accounted as admitted
    // (on candidate push) or rejected with the exact reason captured here.
    let fmMarketClass: MarketClass = "unknown";
    let fmIsAllowedFullmatch = false;
    let fmIdentityForTrace = "";
    const rejectReason = (r: string) => {
      if (rawDiag) {
        rawDiag.rejected_before_planning_by_reason[r] =
          (rawDiag.rejected_before_planning_by_reason[r] ?? 0) + 1;
        const ver = (row.metric_formula_version as string) ?? "unknown";
        if (!rawDiag.dropped_by_formula_version_and_reason[ver]) {
          rawDiag.dropped_by_formula_version_and_reason[ver] = {};
        }
        rawDiag.dropped_by_formula_version_and_reason[ver][r] =
          (rawDiag.dropped_by_formula_version_and_reason[ver][r] ?? 0) + 1;
        // Exact-reason accounting for live-allowed full-match raw rows that drop out.
        if (fmIsAllowedFullmatch) {
          rawDiag.fullmatch_rejected_by_reason[r] =
            (rawDiag.fullmatch_rejected_by_reason[r] ?? 0) + 1;
          if (rawDiag.missing_fullmatch_fixtures.length < 25) {
            rawDiag.missing_fullmatch_fixtures.push({
              event_key:
                (typeof row.event_slug === "string" && row.event_slug.trim()) ||
                (typeof row.condition_id === "string" ? row.condition_id : "no_event"),
              identity: fmIdentityForTrace.slice(0, 120),
              market_class: fmMarketClass,
              reject_reason: r,
            });
          }
        }
      }
    };
    const planningFallbackRow =
      planningMode &&
      row.__planning_source === "shadow_fallback" &&
      row.metric_formula_version === "shadow-strategic-sports-v1" &&
      row.signal_confidence_num == null;
    const baseCoverage =
      typeof diag.dataCoverage === "number"
        ? diag.dataCoverage
        : typeof diag.coverage === "number"
          ? diag.coverage
          : null;
    const gameStartIso =
      typeof diag.gameStartIso === "string" && diag.gameStartIso !== "null"
        ? diag.gameStartIso
        : null;
    const { text: identityText, activityLabelDetected } = buildIdentityText(row, planningMode);
    // Classify the raw market once with the canonical taxonomy so the builder,
    // queue and monitor agree, and so each live-allowed full-match raw row is
    // accounted as admitted / rejected (diagnostics only, no decision change).
    fmMarketClass = classifyMarketText(identityText);
    fmIsAllowedFullmatch = isAllowedFullMatchMarketClass(fmMarketClass);
    fmIdentityForTrace = identityText;
    if (rawDiag) {
      rawDiag.fullmatch_market_class_counts[fmMarketClass] =
        (rawDiag.fullmatch_market_class_counts[fmMarketClass] ?? 0) + 1;
      if (fmIsAllowedFullmatch) rawDiag.raw_allowed_fullmatch_rows += 1;
      if (fmMarketClass.startsWith("forbidden_")) rawDiag.raw_forbidden_rows += 1;
    }
    let score = typeof row.signal_confidence_num === "number" ? row.signal_confidence_num : null;
    let coverage = baseCoverage;
    const entryPrice = typeof row.entry_price_num === "number" ? row.entry_price_num : null;
    let planningFallbackUsed = false;
    let planningScoreSource: string | null = null;

    if (planningFallbackRow) {
      const derivedScopeProbe = deriveSportScope(identityText);
      const planningScope = resolvePlanningScope(row, identityText, derivedScopeProbe.scope);
      if (planningScope.scope === "UNKNOWN") {
        if (rawDiag) {
          rawDiag.planning_shadow_rejected_count += 1;
          rawDiag.planning_shadow_reject_reasons.WEAK_EVENT_IDENTITY =
            (rawDiag.planning_shadow_reject_reasons.WEAK_EVENT_IDENTITY ?? 0) + 1;
        }
        rejectReason("WEAK_EVENT_IDENTITY");
        continue;
      }
      const fallback = computePlanningFallbackScore(row, planningScope.scope, identityText);
      if (fallback.score == null) {
        if (rawDiag) {
          rawDiag.planning_shadow_rejected_count += 1;
          rawDiag.planning_shadow_reject_reasons.UNKNOWN_REJECT_NEEDS_CODE_TRACE =
            (rawDiag.planning_shadow_reject_reasons.UNKNOWN_REJECT_NEEDS_CODE_TRACE ?? 0) + 1;
        }
        rejectReason("UNKNOWN_REJECT_NEEDS_CODE_TRACE");
        continue;
      }
      score = fallback.score;
      coverage = fallback.coverage ?? coverage;
      planningFallbackUsed = true;
      planningScoreSource = fallback.source;
    }

    if (coverage == null || coverage < 25) { rejectReason("LOW_COVERAGE"); continue; }
    if (score == null || score < 50)       { rejectReason("LOW_SCORE"); continue; }
    if (entryPrice == null)                { rejectReason("MISSING_ENTRY_PRICE"); continue; }
    if (!gameStartIso) {
      if (rawDiag) rawDiag.rows_missing_game_start += 1;
      rejectReason("MISSING_GAME_START");
      continue;
    }

    const gameStartMs = new Date(gameStartIso).getTime();
    if (isNaN(gameStartMs) || gameStartMs <= now) {
      rejectReason("GAME_STARTED_OR_INVALID");
      continue;
    }

    const hoursToStart = Math.round(((gameStartMs - now) / 3_600_000) * 100) / 100;

    if (rawDiag && activityLabelDetected) rawDiag.activity_label_rows += 1;

    // Bad bucket: coverage 50–74 AND entry_price 0.44–0.58
    if (coverage >= 50 && coverage <= 74 && entryPrice >= 0.44 && entryPrice <= 0.58) {
      rejectReason("BAD_BUCKET_COV_PRICE");
      continue;
    }

    const authoritative = authoritativeScope(providerContext);
    const derivedScope = authoritative
      ? { scope: authoritative, confidence: "HIGH" as const }
      : deriveSportScope(identityText);
    const { scope: strategicScope, confidence: scopeConfidence } =
      planningMode && derivedScope.scope === "UNKNOWN"
        ? resolvePlanningScope(row, identityText, derivedScope.scope)
        : derivedScope;

    if (rawDiag) {
      rawDiag.sport_classification_confidence_counts[scopeConfidence] =
        (rawDiag.sport_classification_confidence_counts[scopeConfidence] ?? 0) + 1;
      if (strategicScope === "WC")                                  rawDiag.wc_like_rows += 1;
      if (strategicScope === "WC" || strategicScope === "SOCCER")   rawDiag.soccer_like_rows += 1;
    }

    // Guard F: UNKNOWN is never live-eligible. Classifier must positively identify scope.
    if (strategicScope === "UNKNOWN") { rejectReason("UNKNOWN_SCOPE"); continue; }

    const isSoccerFamily = strategicScope === "WC" || strategicScope === "SOCCER";

    // Guard E: Football/WC candidates must be within 1 hour of kickoff for live eligibility.
    // planningMode keeps future soccer matches in the universe as future planning slots only.
    if (!planningMode && isSoccerFamily && hoursToStart > 1.0) {
      rejectReason("FOOTBALL_TOO_EARLY_LIVE");
      continue;
    }

    // scope filter — default "all" passes everything
    if (scope !== "all") {
      const want = scope.toUpperCase();
      if (want === "WC"     && strategicScope !== "WC")                                    { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "SOCCER" && strategicScope !== "WC" && strategicScope !== "SOCCER")     { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "MLB"    && strategicScope !== "MLB")                                   { rejectReason("SCOPE_FILTER"); continue; }
      if (want === "ESPORT" && strategicScope !== "ESPORT")                                { rejectReason("SCOPE_FILTER"); continue; }
    }

    const tier = computeTier(score, coverage);
    if (!tier) { rejectReason("TIER_BELOW_THRESHOLD"); continue; }

    const isEsport = ESPORTS_RE.test(identityText);
    const smartMoney = typeof row.smart_money_score_num === "number" ? row.smart_money_score_num : null;
    const baseStake = computeBaseStake(score, coverage);
    let stakeUsd = computeStake(baseStake, smartMoney, isEsport);
    if (stakeUsd <= 0) { rejectReason("ZERO_STAKE"); continue; }

    const maxEntryPrice = Math.min(Math.round((entryPrice + 0.04) * 1000) / 1000, 0.99);
    const executorAction = computeExecutorAction(score, coverage, hoursToStart, tier);

    const { sport, family } = inferSportAndFamily(strategicScope);
    const staleAfter = typeof row.expires_at === "string" ? row.expires_at : gameStartIso;
    const selectedOutcome = extractSelectedOutcome(row, diag);
    const side = selectedOutcome ?? "Yes";

    // Guard G: "No" side on football/WC match-winner markets has undefined semantics.
    if (isSoccerFamily && side.toLowerCase() === "no") {
      rejectReason("FOOTBALL_NO_SIDE");
      continue;
    }

    // Derive match_family_key with identity quality.
    const {
      key: matchFamilyKey,
      source: matchFamilyKeySource,
      quality: identityQuality,
      canonicalEventKey,
    } = deriveMatchFamilyKey(row, identityText);
    const matchFamilyKeyIsWeak = matchFamilyKeySource === "condition_id_weak";

    if (rawDiag) {
      rawDiag.match_family_quality_counts[identityQuality] =
        (rawDiag.match_family_quality_counts[identityQuality] ?? 0) + 1;
      if (rawDiag.sample_source_rows.length < 10) {
        rawDiag.sample_source_rows.push({
          identity_text: identityText,
          activity_label_detected: activityLabelDetected,
          event_slug: row.event_slug,
          strategic_scope: strategicScope,
          scope_confidence: scopeConfidence,
          match_family_key: matchFamilyKey,
          identity_quality: identityQuality,
          metric_formula_version: row.metric_formula_version,
          planning_fallback_used: planningFallbackUsed || undefined,
          planning_score_source: planningScoreSource || undefined,
        });
      }
    }

    const warningCodes: string[] = [];
    if (activityLabelDetected)          warningCodes.push("ACTIVITY_LABEL_IN_MARKET_SLUG");
    if (!row.event_slug)                warningCodes.push("MISSING_EVENT_SLUG");
    if (matchFamilyKeyIsWeak)           warningCodes.push("WEAK_MATCH_FAMILY_KEY");
    if (scopeConfidence === "MEDIUM")   warningCodes.push("SCOPE_CLASSIFIED_BY_FALLBACK");

    const timingBucket = computeTimingBucket(hoursToStart);
    let { liveEligible, liveRejectionReason } = computeLiveEligibility(
      tier,
      matchFamilyKeySource,
      matchFamilyKey,
      hoursToStart,
      identityQuality
    );

    let wcTier2OverrideApplied = false;
    let wcTier2OverrideReason: string | null = null;
    if (liveRejectionReason === "BELOW_LIVE_FALLBACK_POOL") {
      if (rawDiag) rawDiag.wc_tier2_override_candidates += 1;
      const override = isWcTier2LiveOverrideCandidate({
        tier,
        strategicScope,
        sport,
        identityText,
        eventSlug: typeof row.event_slug === "string" ? row.event_slug : null,
        score,
        coverage,
        tokenId: row.selected_token_id,
        conditionId: row.condition_id,
        side,
        selectedOutcome,
        hoursToStart,
        identityQuality,
        matchFamilyKeyIsWeak,
        matchFamilyKey,
        liveRejectionReason,
      });
      wcTier2OverrideReason = override.reason;
      if (override.allowed) {
        liveEligible = true;
        liveRejectionReason = null;
        wcTier2OverrideApplied = true;
        stakeUsd = Math.min(stakeUsd, 5);
        if (rawDiag) rawDiag.wc_tier2_override_live_enabled += 1;
      } else if (rawDiag) {
        rawDiag.wc_tier2_override_rejected_by_reason[override.reason] =
          (rawDiag.wc_tier2_override_rejected_by_reason[override.reason] ?? 0) + 1;
      }
    }
    if (!planningMode && liveRejectionReason === "BELOW_LIVE_FALLBACK_POOL") {
      console.log("[ireland-executor] rejected non-tier1 candidate", {
        signal_id: row.id,
        strategy: tier,
      });
    }

    // Pilot scope allowlist: PILOT_ALLOWED_SCOPES=MLB,ESPORT,ESPORTS
    // When set, live eligibility is restricted to the listed strategic scopes only.
    const pilotScopesRaw = process.env.PILOT_ALLOWED_SCOPES ?? "";
    if (liveEligible && pilotScopesRaw.trim()) {
      const pilotAllowed = new Set(
        pilotScopesRaw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
      );
      // Normalise ESPORTS → ESPORT so callers can use either spelling.
      const scopeKey = strategicScope === "ESPORT" ? "ESPORT" : strategicScope;
      const inAllowlist = pilotAllowed.has(scopeKey) || pilotAllowed.has("ESPORTS") && scopeKey === "ESPORT";
      if (!inAllowlist) {
        liveEligible = false;
        liveRejectionReason = "PILOT_SCOPE_NOT_ALLOWED";
      }
    }

    // Pilot Tier3 fallback: env-gated smoke-test override. Promotes a Tier3 candidate
    // to live-eligible only when ALL of: PILOT_ALLOW_TIER3_FALLBACK=true, scope in
    // PILOT_ALLOWED_SCOPES, not WC/SOCCER, strong identity, within timing window.
    let pilotTier3FallbackApplied = false;
    if (!liveEligible && liveRejectionReason === "BELOW_LIVE_FALLBACK_POOL" &&
        tier === "TIER3_MICRO_EXPAND_50_COV25" &&
        process.env.PILOT_ALLOW_TIER3_FALLBACK === "true") {
      const maxHours = parseFloat(process.env.PILOT_TIER3_MAX_HOURS_TO_START ?? "1.25");
      const pilotScopesRaw2 = process.env.PILOT_ALLOWED_SCOPES ?? "";
      const pilotAllowed2 = pilotScopesRaw2.trim()
        ? new Set(pilotScopesRaw2.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))
        : null;
      const scopeKey2 = strategicScope === "ESPORT" ? "ESPORT" : strategicScope;
      const scopeOk = pilotAllowed2 !== null &&
        (pilotAllowed2.has(scopeKey2) || (pilotAllowed2.has("ESPORTS") && scopeKey2 === "ESPORT"));
      const isSoccerOrWC2 = strategicScope === "WC" || strategicScope === "SOCCER";
      const identityOk = identityQuality !== "WEAK" && identityQuality !== "INVALID";
      if (
        scopeOk &&
        !isSoccerOrWC2 &&
        !matchFamilyKeyIsWeak &&
        identityOk &&
        hoursToStart > 0 &&
        hoursToStart <= (isNaN(maxHours) ? 1.25 : maxHours)
      ) {
        liveEligible = true;
        liveRejectionReason = null;
        pilotTier3FallbackApplied = true;
        // Cap stake for Tier3 pilot fallback.
        const maxStake = parseFloat(process.env.PILOT_TIER3_MAX_STAKE_USD ?? "2");
        if (!isNaN(maxStake) && maxStake > 0) {
          stakeUsd = Math.min(stakeUsd, maxStake);
        }
      }
    }

    const sideMappingStatus =
      liveRejectionReason === "WEAK_IDENTITY_LIVE_BLOCKED" && /spread|match\s+winner/i.test(identityText)
        ? "TITLE_OUTCOME_AMBIGUOUS_BLOCKED"
        : liveEligible && row.selected_token_id && selectedOutcome
        ? "PROVEN_BY_TOKEN_ID"
        : liveEligible
        ? "UNKNOWN_BLOCKED"
        : "UNKNOWN_BLOCKED";
    if (sideMappingStatus === "UNKNOWN_BLOCKED" && liveEligible && tier !== "TIER1_CORE_STRICT_72_COV50") {
      liveEligible = false;
      liveRejectionReason = "SIDE_MAPPING_UNKNOWN_BLOCKED";
    }

    const rawEventSlugForCandidate =
      typeof row.event_slug === "string" && row.event_slug.trim()
        ? row.event_slug.trim().toLowerCase()
        : null;

    candidates.push({
      signal_id: row.id,
      generated_signal_pair_id: typeof row.id === "string" && row.id.trim() !== "" ? row.id : null,
      strategy: tier,
      market_slug: (activityLabelDetected ? null : row.market_slug) || row.event_slug || row.condition_id,
      match_family_key: matchFamilyKey,
      match_family_key_source: matchFamilyKeySource,
      match_family_key_is_weak: matchFamilyKeyIsWeak,
      event_slug: rawEventSlugForCandidate,
      providerEventKey: providerEventKeyOf(providerContext, gameStartIso),
      providerEventTitle: providerContext?.eventTitle ?? null,
      providerMarketQuestion: providerContext?.marketQuestion ?? null,
      authoritativeSportFamily: providerContext?.sportFamily ?? null,
      authoritativeGame: providerContext?.game ?? null,
      authoritativeLeague: providerContext?.league ?? null,
      authoritativeEventStart: providerContext?.eventStartIso ?? null,
      condition_id: row.condition_id,
      token_id: row.selected_token_id,
      side,
      selected_outcome: selectedOutcome,
      inferred_sport: sport,
      market_family: family,
      strategic_scope: strategicScope,
      timing_bucket: timingBucket,
      identity_quality: identityQuality,
      identity_warning_codes: warningCodes,
      canonical_event_key: canonicalEventKey,
      canonical_market_key: (row.condition_id as string) ?? null,
      activity_label_detected: activityLabelDetected,
      sport_classification_confidence: scopeConfidence,
      live_eligible: liveEligible,
      live_rejection_reason: liveRejectionReason,
      side_mapping_status: sideMappingStatus,
      live_block_reason: liveRejectionReason,
      live_policy_version: LIVE_POLICY_VERSION,
      paper_eligible: true,
      max_entry_price: maxEntryPrice,
      stake_usd: stakeUsd,
      max_order_usd: 5,
      max_spread: 0.03,
      one_order_only: true,
      executor_mode_allowed: "dry_run_only",
      first_live_test_allowed: true,
      stale_after: staleAfter,
      no_trade_after: gameStartIso,
      idempotency_key: makeIdempotencyKey(row.id, row.selected_token_id),
      model_rule_id: `${POLICY_VERSION}:${STAKE_GUARD_POLICY}`,
      created_at: row.created_at,
      source: "FireModel1_private_executor_2026_06_15",
      diagnostics: {
        executor_action: executorAction,
        paper_only: !liveEligible,
        real_trade: false,
        score,
        coverage,
        smart_money: smartMoney,
        entry_price: entryPrice,
        game_start_iso: gameStartIso,
        hours_to_start_now: hoursToStart,
        fire_model_alias: "FireModel1",
        version: row.metric_formula_version,
        ...(wcTier2OverrideApplied
          ? {
              live_policy_override: "WC_TIER2_68_COV50" as const,
              override_reason: "FOUNDER_APPROVED_WC_TIER2_SMALL_STAKE" as const,
              max_stake_cap: 5 as const,
            }
          : wcTier2OverrideReason
            ? { wc_tier2_override_rejected_reason: wcTier2OverrideReason }
            : {}),
        ...(pilotTier3FallbackApplied ? { pilot_tier3_fallback: true as const } : {}),
        ...(planningFallbackUsed
          ? {
              planning_score_source: planningScoreSource,
              planning_fallback_used: true as const,
              formula_version_source: row.metric_formula_version,
            }
          : {}),
      },
    });

    if (rawDiag && fmIsAllowedFullmatch) {
      rawDiag.fullmatch_admitted_count += 1;
    }
    if (rawDiag && (strategicScope === "WC" || strategicScope === "SOCCER")) {
      rawDiag.wc_soccer_candidate_count += 1;
    }
    if (rawDiag && planningFallbackUsed) {
      rawDiag.planning_shadow_included_count += 1;
      rawDiag.fallback_candidate_count += 1;
    }
  }

  // Populate versions_with_zero_db_rows now that source_counts is complete.
  if (rawDiag) {
    rawDiag.versions_with_zero_db_rows = versions.filter(
      v => !rawDiag!.source_counts_by_formula_version[v]
    );
  }

  candidates.sort((a, b) => {
    const tierDiff = (TIER_ORDER[a.strategy] ?? 9) - (TIER_ORDER[b.strategy] ?? 9);
    if (tierDiff !== 0) return tierDiff;
    const scoreDiff = b.diagnostics.score - a.diagnostics.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.diagnostics.hours_to_start_now - b.diagnostics.hours_to_start_now;
  });

  if (selectorMode === "CONTRACT_A_PLANNING_V1") {
    for (const candidate of candidates) {
      candidate.diagnostics = {
        ...candidate.diagnostics,
        selector_id: "CONTRACT_A_PLANNING_V1",
        contract_a_stage: "PLANNING",
      };
    }
  }

  // Post-processing: resolve WEAK_SINGLE_TEAM_SPREAD keys into their parent pair groups.
  // Example: "WEAK_SINGLE_TEAM_SPREAD:norway:2026-06-16" → "pair:iraq-vs-norway:2026-06-16"
  // Merges the spread into the same event group so it does not create a duplicate planned slot.
  // Identity stays WEAK (live-blocked) whether resolved or not.
  if (candidates.some(c => c.match_family_key.startsWith("WEAK_SINGLE_TEAM_SPREAD:"))) {
    const pairKeyByTeamDate = new Map<string, string>();
    for (const c of candidates) {
      const pm = c.match_family_key.match(/^pair:([\w-]+)-vs-([\w-]+):(\d{4}-\d{2}-\d{2})$/);
      if (pm) {
        pairKeyByTeamDate.set(`${pm[1]}:${pm[3]}`, c.match_family_key);
        pairKeyByTeamDate.set(`${pm[2]}:${pm[3]}`, c.match_family_key);
      }
    }
    for (const c of candidates) {
      const sm = c.match_family_key.match(/^WEAK_SINGLE_TEAM_SPREAD:([\w-]+):(\d{4}-\d{2}-\d{2})$/);
      if (!sm) continue;
      const resolved = pairKeyByTeamDate.get(`${sm[1]}:${sm[2]}`);
      if (resolved) {
        c.match_family_key = resolved;
        c.identity_warning_codes = [
          ...c.identity_warning_codes.filter(w => w !== "TEAM_PAIR_INCOMPLETE"),
          "TEAM_PAIR_RESOLVED_FROM_CONTEXT",
        ];
      }
      // Unresolved spreads keep WEAK_SINGLE_TEAM_SPREAD: key; WEAK quality blocks live.
    }
  }

  return {
    candidates: candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 })),
    rawDiagnostics: rawDiag,
  };
}
