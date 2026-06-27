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
  const tokenId = normalizeTokenId(
    row.selected_token_id ?? row.token_id ?? row.tokenId ?? row.selectedTokenId,
  );
  const conditionId = firstString(row.condition_id, row.conditionId, row.market_id, row.marketId);
  if (!tokenId || !conditionId) return null;

  const minVolume = options.minVolumeUsd ?? DEFAULT_MIN_MARKET_VOLUME_USD;

  // No `sport` column in research snapshots — derive from league, with explicit
  // sport field as a fallback for other source variants.
  const rawSport = firstString(row.sport, row.league, row.category);
  const league = firstString(row.league, row.league_name);
  const normalizedSport = normalizeSport(firstString(row.sport) ?? league ?? rawSport);
  const sportSource = firstString(row.sport) ? "source_sport" : league ? "league_derived" : null;

  const rawMarketFamily = firstString(row.market_family, row.market_type, row.marketType);
  const familyGate = computeMarketFamilyGate(rawMarketFamily);
  const isOutrightOrFuture = detectOutrightOrFuture(rawMarketFamily);
  const isProp = detectPropMarket(rawMarketFamily);

  const { volumeUsd, source: volumeSource, scope: volumeScope } = extractMarketVolumeUsd(row);
  const volumeGate = computeMarketVolumeGate({ volumeUsd, volumeScope }, minVolume);

  const gameStartIso = firstString(row.game_start_iso, row.game_start, row.start_time);

  let priorityScore = volumeUsd && volumeUsd > 0 ? Math.log10(volumeUsd + 1) : 0;
  if (familyGate.status === "SUPPORTED") priorityScore += 2;
  if (normalizedSport !== "UNKNOWN") priorityScore += 1;
  if (isVolumeGatePassed(volumeGate.status)) priorityScore += 1;

  return {
    conditionId,
    tokenId,
    opposingTokenId: firstString(row.opposing_token_id, row.opposingTokenId),
    eventSlug: firstString(row.event_slug, row.eventSlug),
    marketSlug: firstString(row.market_slug, row.marketSlug),
    selectedOutcome: firstString(row.selected_outcome, row.selectedOutcome),
    rawSport,
    normalizedSport,
    sportSource,
    rawMarketFamily,
    normalizedMarketFamily: familyGate.family,
    marketFamilyGate: familyGate.status,
    marketFamilyGateReason: familyGate.status === "SUPPORTED" ? null : familyGate.status,
    isOutrightOrFuture,
    isProp,
    league,
    matchFamilyKey: firstString(row.match_family_key, row.matchFamilyKey),
    gameStartIso,
    volumeUsd,
    volumeSource,
    volumeScope: volumeGate.scope,
    volumeGate: volumeGate.status,
    volumeGateReason: isVolumeGatePassed(volumeGate.status) ? null : volumeGate.status,
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
    source_market_family: c.rawMarketFamily,
    normalized_market_family: c.normalizedMarketFamily,
    market_family_source: c.rawMarketFamily ? "source_market_family" : null,
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
    volume_gate_status: volumeGateToDb(c.volumeGate),
    volume_gate_threshold_usd: minVolumeUsd,
    volume_gate_reason: c.volumeGateReason,
    minutes_to_start_at_insert: minutesToStartAtInsert,
    tracking_priority: Math.round(c.priorityScore * 100),
    tracking_status: "active",
    reason: null,
    diagnostics: {
      sport_source: c.sportSource,
      volume_source: c.volumeSource,
      volume_scope: c.volumeScope,
      market_family_gate: c.marketFamilyGate,
      volume_gate: c.volumeGate,
    },
  };
}
