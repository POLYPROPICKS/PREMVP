// LIQUIDITY_MODEL — pure watchlist candidate construction and dedupe.
//
// Maps raw source rows (public.generated_signal_research_snapshots, fallback
// generated_signal_pairs) into WatchlistCandidate rows, applying sport +
// market-family + market-level volume gating diagnostics. No I/O.
//
// IMPORTANT source-schema realities (generated_signal_research_snapshots):
//   - token id lives in `selected_token_id` (no `token_id` column)
//   - there is NO `sport` column — sport is derived from `league`
//   - there is NO direct volume column — volume, if present at all, is dug out
//     of the `diagnostics` jsonb. Missing volume => volume gate FAILs (hard).

import {
  computeMarketFamilyGate,
  computeMarketVolumeGate,
  DEFAULT_MIN_MARKET_VOLUME_USD,
  detectOutrightOrFuture,
  detectPropMarket,
  isVolumeGatePassed,
  marketFamilyGateToDb,
  normalizeSport,
  volumeGateToDb,
} from "./marketGates";
import { normalizeTokenId } from "./orderbookMath";
import type {
  GateStatusDb,
  MarketFamily,
  MarketFamilyGateStatus,
  NormalizedSport,
  VolumeScope,
  WatchlistCandidate,
  WatchlistRow,
} from "./types";

/** A loosely-typed source row; we never assume all columns exist. */
export interface SourceResearchRow {
  [key: string]: unknown;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Dig a market-level volume figure out of known fields + diagnostics jsonb. */
export function extractMarketVolumeUsd(
  row: SourceResearchRow,
): { volumeUsd: number | null; source: string | null; scope: VolumeScope | null } {
  // 1. Direct top-level fields (present on some source variants).
  const direct = firstNumber(
    row.market_volume_usd,
    row.market_volume,
    row.volume_usd,
    row.volume_num,
    row.volume,
    row.volume_24h,
  );
  if (direct !== null) {
    return { volumeUsd: direct, source: "source_column", scope: "market_level" };
  }

  // 2. diagnostics jsonb — market-level keys preferred, event-level flagged.
  const diag = asRecord(row.diagnostics);
  if (diag) {
    const marketLevel = firstNumber(
      diag.market_volume_usd,
      diag.marketVolumeUsd,
      diag.market_volume,
      diag.condition_volume_usd,
      diag.volume_usd,
      diag.volumeUsd,
    );
    if (marketLevel !== null) {
      return { volumeUsd: marketLevel, source: "diagnostics", scope: "market_level" };
    }
    const eventLevel = firstNumber(
      diag.event_volume_usd,
      diag.eventVolumeUsd,
      diag.event_volume,
    );
    if (eventLevel !== null) {
      return {
        volumeUsd: eventLevel,
        source: "diagnostics_event_level",
        scope: "event_level_not_market_level",
      };
    }
  }

  return { volumeUsd: null, source: null, scope: null };
}

/**
 * Resolve the fine market type used for liquidity-family gating. The broad
 * `market_family` source column ('Sports'/'Esports') is intentionally NOT a
 * source here — it is a category, not a market type. Precedence:
 *   1. diagnostics.researchContext.marketType
 *   2. diagnostics.fireModel.rawFeatureHints.marketType
 *   3. diagnostics.researchContext.marketSubtype
 *   4. diagnostics.fireModel.rawFeatureHints.marketSubtype
 *   5. explicit top-level market_type/market_subtype columns (other variants)
 */
export function extractMarketType(
  row: SourceResearchRow,
): { marketType: string | null; source: string | null } {
  const diag = asRecord(row.diagnostics);
  const rc = diag ? asRecord(diag.researchContext) : null;
  const fm = diag ? asRecord(diag.fireModel) : null;
  const hints = fm ? asRecord(fm.rawFeatureHints) : null;

  const ordered: Array<[string | null, string]> = [
    [rc ? firstString(rc.marketType) : null, "researchContext.marketType"],
    [hints ? firstString(hints.marketType) : null, "fireModel.rawFeatureHints.marketType"],
    [rc ? firstString(rc.marketSubtype) : null, "researchContext.marketSubtype"],
    [hints ? firstString(hints.marketSubtype) : null, "fireModel.rawFeatureHints.marketSubtype"],
    [
      firstString(row.market_type, row.marketType, row.market_subtype, row.marketSubtype),
      "source_column",
    ],
  ];
  for (const [val, source] of ordered) {
    if (val) return { marketType: val, source };
  }
  return { marketType: null, source: null };
}

/** Primary CLOB token id from the real schema (`selected_token_id`). */
export function extractSelectedTokenId(row: SourceResearchRow): string | null {
  return normalizeTokenId(
    row.selected_token_id ?? row.selectedTokenId ?? row.token_id ?? row.tokenId,
  );
}

/** Game start time from the real schema (`game_start_iso`). */
export function extractGameStart(row: SourceResearchRow): string | null {
  return firstString(row.game_start_iso, row.gameStartIso, row.game_start, row.start_time);
}

/**
 * Derive the supported liquidity family from a nested market type. A null/empty
 * market type is an explicit `missing_market_type` rejection, never a silent
 * UNKNOWN family.
 */
export function deriveLiquidityFamily(marketType: string | null): {
  family: MarketFamily;
  status: MarketFamilyGateStatus;
  reason: string | null;
} {
  if (!marketType) {
    return { family: "UNKNOWN", status: "EXCLUDED_MISSING_MARKET_TYPE", reason: "missing_market_type" };
  }
  const gate = computeMarketFamilyGate(marketType);
  return {
    family: gate.family,
    status: gate.status,
    reason: gate.status === "SUPPORTED" ? null : familyGateReason(gate.status),
  };
}

function familyGateReason(status: MarketFamilyGateStatus): string {
  switch (status) {
    case "EXCLUDED_MISSING_MARKET_TYPE":
      return "missing_market_type";
    case "EXCLUDED_OUTRIGHT_FUTURE":
      return "outright_or_future";
    case "EXCLUDED_PROP":
      return "prop_market";
    case "EXCLUDED_EXACT_SCORE":
      return "exact_score";
    case "EXCLUDED_NOVELTY_POLITICS":
      return "novelty_or_politics";
    case "EXCLUDED_UNKNOWN_FAMILY":
      return "unsupported_market_type";
    default:
      return "unsupported_market_type";
  }
}

/** Normalized intermediate aligned to the real research-snapshot schema. */
export interface LiquiditySource {
  conditionId: string | null;
  selectedTokenId: string | null;
  opposingTokenId: string | null;
  eventSlug: string | null;
  selectedOutcome: string | null;
  league: string | null;
  normalizedSport: NormalizedSport;
  sportSource: string | null;
  rawSourceCategory: string | null;
  marketType: string | null;
  marketTypeSource: string | null;
  gameStartIso: string | null;
  selectedPrice: number | null;
}

/** Pure mapping from a raw research-snapshot row to the liquidity source shape. */
export function mapResearchSnapshotToLiquiditySource(
  row: SourceResearchRow,
): LiquiditySource {
  const league = firstString(row.league, row.league_name);
  const rawSourceCategory = firstString(row.market_family);
  // Sport is derived from league (no `sport` column); explicit sport supported
  // only as a fallback for other source variants.
  const normalizedSport = normalizeSport(firstString(row.sport) ?? league ?? rawSourceCategory);
  const sportSource = firstString(row.sport)
    ? "source_sport"
    : league
    ? "league_derived"
    : rawSourceCategory
    ? "category_derived"
    : null;
  const { marketType, source: marketTypeSource } = extractMarketType(row);

  return {
    conditionId: firstString(row.condition_id, row.conditionId, row.market_id, row.marketId),
    selectedTokenId: extractSelectedTokenId(row),
    opposingTokenId: firstString(row.opposing_token_id, row.opposingTokenId),
    eventSlug: firstString(row.event_slug, row.eventSlug),
    selectedOutcome: firstString(row.selected_outcome, row.selectedOutcome),
    league,
    normalizedSport,
    sportSource,
    rawSourceCategory,
    marketType,
    marketTypeSource,
    gameStartIso: extractGameStart(row),
    selectedPrice: firstNumber(row.selected_price_num, row.selected_price, row.selectedPrice),
  };
}

export interface BuildCandidateOptions {
  minVolumeUsd?: number;
}

/**
 * Build a WatchlistCandidate from a raw source row, running sport, market-family
 * and volume gates. Returns null only when no token id or condition id exists.
 * Failing candidates are still returned (with failing statuses) so the funnel
 * report can account for every source row. Never throws on missing fields.
 */
export function buildWatchlistCandidate(
  row: SourceResearchRow,
  options: BuildCandidateOptions = {},
): WatchlistCandidate | null {
  const src = mapResearchSnapshotToLiquiditySource(row);
  if (!src.selectedTokenId || !src.conditionId) return null;

  const minVolume = options.minVolumeUsd ?? DEFAULT_MIN_MARKET_VOLUME_USD;

  // Gate the liquidity family on the resolved nested market type, never on the
  // broad `market_family` category column.
  const familyGate = deriveLiquidityFamily(src.marketType);
  const isOutrightOrFuture = detectOutrightOrFuture(src.marketType);
  const isProp = detectPropMarket(src.marketType);

  const { volumeUsd, source: volumeSource, scope: volumeScope } = extractMarketVolumeUsd(row);
  const volumeGate = computeMarketVolumeGate({ volumeUsd, volumeScope }, minVolume);

  // DB-facing volume disposition: only concrete market-level volume passes.
  // Missing source volume and event-level-only volume are DEFERRED to live
  // capture (not a hard reject); below-threshold / stale / invalid are rejected.
  const volumeGateDb: GateStatusDb = volumeGateToDb(volumeGate.status);

  let priorityScore = volumeUsd && volumeUsd > 0 ? Math.log10(volumeUsd + 1) : 0;
  if (familyGate.status === "SUPPORTED") priorityScore += 2;
  if (src.normalizedSport !== "UNKNOWN") priorityScore += 1;
  if (isVolumeGatePassed(volumeGate.status)) priorityScore += 1;
  else if (volumeGateDb === "deferred") priorityScore += 0.5;

  return {
    conditionId: src.conditionId,
    tokenId: src.selectedTokenId,
    opposingTokenId: src.opposingTokenId,
    eventSlug: src.eventSlug,
    marketSlug: firstString(row.market_slug, row.marketSlug),
    selectedOutcome: src.selectedOutcome,
    rawSport: firstString(row.sport) ?? src.league ?? src.rawSourceCategory,
    normalizedSport: src.normalizedSport,
    sportSource: src.sportSource,
    rawSourceCategory: src.rawSourceCategory,
    marketType: src.marketType,
    marketTypeSource: src.marketTypeSource,
    rawMarketFamily: src.marketType,
    normalizedMarketFamily: familyGate.family,
    marketFamilyGate: familyGate.status,
    marketFamilyGateReason: familyGate.reason,
    isOutrightOrFuture,
    isProp,
    league: src.league,
    matchFamilyKey: firstString(row.match_family_key, row.matchFamilyKey),
    gameStartIso: src.gameStartIso,
    selectedPrice: src.selectedPrice,
    volumeUsd,
    volumeSource,
    volumeScope: volumeGate.scope,
    volumeGate: volumeGate.status,
    volumeGateReason: isVolumeGatePassed(volumeGate.status) ? null : volumeGate.status,
    volumeGateDb,
    priorityScore,
    sourceTable: firstString(row.source_table) ?? "generated_signal_research_snapshots",
    sourceRowId: firstString(row.id, row.row_id),
    sourceFormulaVersion: firstString(row.formula_version, row.metric_formula_version),
    sourceScope: firstString(row.scope),
  };
}

/**
 * Dedupe candidates by condition_id + token_id, keeping the highest-priority
 * instance. Ties broken by larger volume, then lexical token id.
 */
export function dedupeWatchlistCandidates(
  candidates: WatchlistCandidate[],
): WatchlistCandidate[] {
  const byKey = new Map<string, WatchlistCandidate>();
  for (const c of candidates) {
    const key = `${c.conditionId}::${c.tokenId}`;
    const existing = byKey.get(key);
    if (!existing || isHigherPriority(c, existing)) {
      byKey.set(key, c);
    }
  }
  return [...byKey.values()];
}

function isHigherPriority(a: WatchlistCandidate, b: WatchlistCandidate): boolean {
  if (a.priorityScore !== b.priorityScore) return a.priorityScore > b.priorityScore;
  const av = a.volumeUsd ?? -1;
  const bv = b.volumeUsd ?? -1;
  if (av !== bv) return av > bv;
  return a.tokenId.localeCompare(b.tokenId) < 0;
}

/** Convert a passing candidate into the snake_case watchlist row payload. */
export function toWatchlistRow(
  c: WatchlistCandidate,
  minutesToStartAtInsert: number | null = null,
  minVolumeUsd: number = DEFAULT_MIN_MARKET_VOLUME_USD,
): WatchlistRow {
  return {
    source_table: c.sourceTable,
    source_row_id: c.sourceRowId,
    source_formula_version: c.sourceFormulaVersion,
    source_scope: c.sourceScope,
    condition_id: c.conditionId,
    token_id: c.tokenId,
    opposing_token_id: c.opposingTokenId,
    event_slug: c.eventSlug,
    market_slug: c.marketSlug,
    selected_outcome: c.selectedOutcome,
    source_sport: c.rawSport,
    normalized_sport: c.normalizedSport,
    sport_source: c.sportSource,
    source_market_family: c.rawSourceCategory,
    normalized_market_family: c.normalizedMarketFamily,
    market_family_source: c.marketTypeSource,
    market_family_gate_status: marketFamilyGateToDb(c.marketFamilyGate),
    market_family_gate_reason: c.marketFamilyGateReason,
    is_supported_p0_market_family: c.marketFamilyGate === "SUPPORTED",
    is_outright_or_future: c.isOutrightOrFuture,
    is_prop_market: c.isProp,
    league: c.league,
    match_family_key: c.matchFamilyKey,
    game_start_iso: c.gameStartIso,
    market_volume_usd: c.volumeUsd,
    market_volume_source: c.volumeSource,
    volume_gate_status: c.volumeGateDb,
    volume_gate_threshold_usd: minVolumeUsd,
    volume_gate_reason: c.volumeGateReason,
    minutes_to_start_at_insert: minutesToStartAtInsert,
    tracking_priority: Math.round(c.priorityScore * 100),
    tracking_status: "active",
    reason: null,
    diagnostics: {
      sport_source: c.sportSource,
      source_category: c.rawSourceCategory,
      market_type: c.marketType,
      market_type_source: c.marketTypeSource,
      selected_price: c.selectedPrice,
      volume_source: c.volumeSource,
      volume_scope: c.volumeScope,
      market_family_gate: c.marketFamilyGate,
      volume_gate: c.volumeGate,
      volume_gate_db: c.volumeGateDb,
    },
  };
}
