// LIQUIDITY_MODEL — pure watchlist candidate construction and dedupe.
//
// Builds WatchlistCandidate rows from raw source research snapshot/pair rows,
// applying sport + market-family + volume gating diagnostics. No I/O here;
// the script layer handles Supabase reads/writes.

import {
  computeMarketFamilyGate,
  computeMarketVolumeGate,
  DEFAULT_MIN_MARKET_VOLUME_USD,
  isVolumeGatePassed,
  normalizeSport,
} from "./marketGates";
import { normalizeTokenId } from "./orderbookMath";
import type {
  VolumeScope,
  WatchlistCandidate,
  WatchlistRow,
} from "./types";

/** A loosely-typed source row from generated_signal_research_snapshots/pairs. */
export interface SourceResearchRow {
  token_id?: unknown;
  tokenId?: unknown;
  market_id?: unknown;
  marketId?: unknown;
  event_id?: unknown;
  eventId?: unknown;
  question?: unknown;
  sport?: unknown;
  league?: unknown;
  category?: unknown;
  market_family?: unknown;
  market_type?: unknown;
  marketType?: unknown;
  volume_usd?: unknown;
  volume?: unknown;
  volume_24h?: unknown;
  volume_scope?: unknown;
  volume_age_minutes?: unknown;
  game_start?: unknown;
  game_start_iso?: unknown;
  start_time?: unknown;
  source_table?: unknown;
  id?: unknown;
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

export interface BuildCandidateOptions {
  minVolumeUsd?: number;
}

/**
 * Build a single WatchlistCandidate from a raw source row, running sport,
 * market-family and volume gates. Returns null only when no token id exists.
 * Candidates that fail gates are still returned (with failing statuses) so the
 * funnel report can account for every source row.
 */
export function buildWatchlistCandidate(
  row: SourceResearchRow,
  options: BuildCandidateOptions = {},
): WatchlistCandidate | null {
  const tokenId = normalizeTokenId(row.token_id ?? row.tokenId);
  if (!tokenId) return null;

  const minVolume = options.minVolumeUsd ?? DEFAULT_MIN_MARKET_VOLUME_USD;
  const rawSport = firstString(row.sport, row.league, row.category);
  const normalizedSport = normalizeSport(rawSport);

  const rawMarketFamily = firstString(row.market_family, row.market_type, row.marketType);
  const familyGate = computeMarketFamilyGate(rawMarketFamily);

  const volumeUsd = firstNumber(row.volume_usd, row.volume, row.volume_24h);
  const volumeScope = (firstString(row.volume_scope) as VolumeScope | null) ?? null;
  const volumeAgeMinutes = firstNumber(row.volume_age_minutes);
  const volumeGate = computeMarketVolumeGate(
    { volumeUsd, volumeScope, volumeAgeMinutes },
    minVolume,
  );

  const gameStartIso = firstString(row.game_start_iso, row.game_start, row.start_time);

  // Priority: volume-weighted, lightly boosted for supported family + known sport.
  let priorityScore = volumeUsd && volumeUsd > 0 ? Math.log10(volumeUsd + 1) : 0;
  if (familyGate.status === "SUPPORTED") priorityScore += 2;
  if (normalizedSport !== "UNKNOWN") priorityScore += 1;
  if (isVolumeGatePassed(volumeGate.status)) priorityScore += 1;

  return {
    tokenId,
    marketId: firstString(row.market_id, row.marketId),
    eventId: firstString(row.event_id, row.eventId),
    question: firstString(row.question),
    normalizedSport,
    rawSport,
    normalizedMarketFamily: familyGate.family,
    rawMarketFamily,
    marketFamilyGate: familyGate.status,
    volumeUsd,
    volumeScope: volumeGate.scope,
    volumeGate: volumeGate.status,
    gameStartIso,
    priorityScore,
    sourceTable: firstString(row.source_table),
    sourceRowId: firstString(row.id),
  };
}

/**
 * Dedupe candidates by token id, keeping the highest-priority instance.
 * Ties broken by larger volume, then lexical token id for determinism.
 */
export function dedupeWatchlistCandidates(
  candidates: WatchlistCandidate[],
): WatchlistCandidate[] {
  const byToken = new Map<string, WatchlistCandidate>();
  for (const c of candidates) {
    const existing = byToken.get(c.tokenId);
    if (!existing || isHigherPriority(c, existing)) {
      byToken.set(c.tokenId, c);
    }
  }
  return [...byToken.values()];
}

function isHigherPriority(a: WatchlistCandidate, b: WatchlistCandidate): boolean {
  if (a.priorityScore !== b.priorityScore) return a.priorityScore > b.priorityScore;
  const av = a.volumeUsd ?? -1;
  const bv = b.volumeUsd ?? -1;
  if (av !== bv) return av > bv;
  return a.tokenId.localeCompare(b.tokenId) < 0;
}

/** Convert a passing candidate into the snake_case watchlist row payload. */
export function toWatchlistRow(c: WatchlistCandidate): WatchlistRow {
  return {
    token_id: c.tokenId,
    market_id: c.marketId,
    event_id: c.eventId,
    question: c.question,
    normalized_sport: c.normalizedSport,
    normalized_market_family: c.normalizedMarketFamily,
    market_family_gate: c.marketFamilyGate,
    volume_usd: c.volumeUsd,
    volume_scope: c.volumeScope,
    volume_gate: c.volumeGate,
    game_start_iso: c.gameStartIso,
    priority_score: c.priorityScore,
    source_table: c.sourceTable,
    source_row_id: c.sourceRowId,
  };
}
