// GET /api/signals/resolved
// Read-only. Returns deduped resolved signals for landing carousel.
// mode=latest: last N days, max 7 cards, max 1 lost, no push/refund/tie.
// Also exposes weekResultsCard — global weekly proof data contract (no UI rendered here).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { WeekResultsCard, TrackRecordRow, ReturnCurvePoint } from "@/components/signal-week-results/types";

export const dynamic = "force-dynamic";

const INTERNAL_FETCH_LIMIT = 200;
const DISPLAY_TABLE_FETCH_LIMIT = 3000;
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
const LATEST_MAX_CARDS = 7;
const LATEST_MAX_LOST = 2;
const LATEST_DEFAULT_DAYS = 7;
const STAKE_USD = 100;
const DISPLAY_RETURN_EPSILON_USD = 0.5;

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v.replace("%", "").trim() : String(v);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractEventTitle(row: DbRow): string {
  const ps = row.premium_signal as Record<string, unknown> | null;
  const dx = row.diagnostics as Record<string, unknown> | null;
  return (
    safeStr(ps?.eventTitle) ??
    safeStr(ps?.title) ??
    safeStr(dx?.eventTitle) ??
    safeStr(dx?.event_title) ??
    safeStr(dx?.marketTitle) ??
    safeStr(row.condition_id) ??
    "Unknown market"
  );
}

function extractConfidence(row: DbRow): number | null {
  const ps = row.premium_signal as Record<string, unknown> | null;
  const dx = row.diagnostics as Record<string, unknown> | null;
  return (
    safeNum(ps?.winProbability) ??
    safeNum(ps?.signalConfidence) ??
    safeNum(ps?.confidence) ??
    safeNum(dx?.signalConfidence) ??
    null
  );
}

function extractTrustMetrics(row: DbRow): {
  smartMoney: number | null;
  whaleVsPublicMoney: number | null;
  preEventScoreAI: number | null;
} {
  const ps = row.premium_signal as Record<string, unknown> | null;
  const metrics = ps?.metrics;
  if (!Array.isArray(metrics)) {
    return { smartMoney: null, whaleVsPublicMoney: null, preEventScoreAI: null };
  }
  let smartMoney: number | null = null;
  let whaleVsPublicMoney: number | null = null;
  let preEventScoreAI: number | null = null;
  for (const m of metrics as Record<string, unknown>[]) {
    const label = safeStr(m?.label) ?? safeStr(m?.name) ?? "";
    const val = safeNum(m?.value) ?? safeNum(m?.score);
    if (/smart.?money/i.test(label)) smartMoney = val;
    else if (/whale/i.test(label)) whaleVsPublicMoney = val;
    else if (/pre.?event/i.test(label) || /preEvent/i.test(label)) preEventScoreAI = val;
  }
  return { smartMoney, whaleVsPublicMoney, preEventScoreAI };
}

function europeanOdds(entryPrice: number | null): number | null {
  if (!entryPrice || entryPrice <= 0) return null;
  return Math.round((1 / entryPrice) * 100) / 100;
}

function decimalToAmerican(decimalOdds: number | null): string | null {
  if (!decimalOdds || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  if (decimalOdds >= 2) return `+${Math.round((decimalOdds - 1) * 100)}`;
  return `${Math.round(-100 / (decimalOdds - 1))}`;
}

/** Extract best market activity proxy from diagnostics/premium_signal.
 *  Priority: totalVolume > volume > recentTradeCash > maxTradeCash >
 *            selectedTradeCount > totalTradeCount > snapshotRows */
function extractActivityScore(row: DbRow, snapshotRows: number): {
  score: number;
  label: string | null;
} {
  const dx = row.diagnostics as Record<string, unknown> | null;
  const ps = row.premium_signal as Record<string, unknown> | null;

  const totalVolume = safeNum(dx?.totalVolume) ?? safeNum(ps?.totalVolume);
  if (totalVolume !== null) {
    const label = totalVolume >= 1000
      ? `$${Math.round(totalVolume / 1000)}K market activity`
      : `$${Math.round(totalVolume)} market activity`;
    return { score: totalVolume, label };
  }

  const volume = safeNum(dx?.volume) ?? safeNum(ps?.volume);
  if (volume !== null) {
    const label = volume >= 1000
      ? `$${Math.round(volume / 1000)}K market activity`
      : `$${Math.round(volume)} market activity`;
    return { score: volume, label };
  }

  const recentTradeCash = safeNum(dx?.recentTradeCash);
  if (recentTradeCash !== null) {
    const label = recentTradeCash >= 1000
      ? `$${Math.round(recentTradeCash / 1000)}K recent trades`
      : `$${Math.round(recentTradeCash)} recent trades`;
    return { score: recentTradeCash, label };
  }

  const maxTradeCash = safeNum(dx?.maxTradeCash);
  if (maxTradeCash !== null) {
    return { score: maxTradeCash, label: null };
  }

  const selectedTradeCount = safeNum(dx?.selectedTradeCount);
  if (selectedTradeCount !== null) {
    return { score: selectedTradeCount, label: `${Math.round(selectedTradeCount)} market updates tracked` };
  }

  const totalTradeCount = safeNum(dx?.totalTradeCount);
  if (totalTradeCount !== null) {
    return { score: totalTradeCount, label: `${Math.round(totalTradeCount)} market updates tracked` };
  }

  return {
    score: snapshotRows,
    label: snapshotRows > 1 ? `${snapshotRows} signal snapshots` : `${snapshotRows} signal snapshot`,
  };
}

const PUSH_RESULTS = new Set(["push", "refund", "tie", "void", "cancelled", "no_contest"]);

// ── Track record display table (weekResultsCard) ─────────────────────────────
// Source: public.track_record_display_signals — the accepted physical display
// table for the "Why Can I Trust This" trust block. One row per published,
// pre-scored signal per window_days/batch_day. No runtime aggregation over
// generated_signal_pairs, no resolved won/lost ledger, no fixed/model odds.

export interface DisplaySignalRow {
  window_days: number;
  source_model: string | null;
  score_rank: number;
  event_title: string;
  market_question: string;
  position: string;
  american_odds: string | null;
  decimal_odds: number | null;
  odds_source_path: string | null;
  projected_win_rate_pct: number | null;
  projected_pnl_units: number | null;
  projected_return_usd: number | null;
  projected_roi_pct_per_signal: number | null;
  status: string | null;
  action: string | null;
  return_label: string | null;
  batch_day: string;
}

export interface DisplaySignalsSummary {
  selectedSignals: number;
  oddsCoveragePct: number;
  oddsSourceBreakdown: Record<string, number>;
  projectedWinRatePct: number;
  avgDecimalOdds: number;
  projectedPnlUnits: number;
  projectedReturnUsd: number;
  projectedRoiPct: number;
  stakeUsd: number;
  totalStakeUsd: number;
  netProfitUsd: number;
  winsCount: number;
  lossesCount: number;
  resolvedCount: number;
  pendingCount: number;
}

/** Hit = projected return at least DISPLAY_RETURN_EPSILON_USD, Miss = at most
 *  -DISPLAY_RETURN_EPSILON_USD, Pending = null/undefined/within the epsilon band
 *  (guards against floating-point noise like 3.6e-15 reading as a false Hit). */
export function deriveDisplayStatus(projectedReturnUsd: number | null | undefined): "Hit" | "Miss" | "Pending" {
  if (projectedReturnUsd === null || projectedReturnUsd === undefined) return "Pending";
  if (Math.abs(projectedReturnUsd) < DISPLAY_RETURN_EPSILON_USD) return "Pending";
  return projectedReturnUsd > 0 ? "Hit" : "Miss";
}

/** Formats a row return for the ledger. No +$0 / -$0 spam on true-zero/near-zero/missing values. */
export function formatReturnLabel(projectedReturnUsd: number | null | undefined): string {
  if (projectedReturnUsd === null || projectedReturnUsd === undefined) return "—";
  if (Math.abs(projectedReturnUsd) < DISPLAY_RETURN_EPSILON_USD) return "—";
  const rounded = Math.round(Math.abs(projectedReturnUsd));
  return projectedReturnUsd > 0 ? `+$${rounded}` : `-$${rounded}`;
}

/** Computes the cumulative return curve from ALL rows ordered by score_rank.
 *  Final point's cumulativeRoiPct rounds to the same value as projectedRoiPct.
 *  cumulativeProfitUsd/cumulativeReturnPct are the dollar-true series used by
 *  the trust-block chart (aligned with the $100-stake netProfitUsd/netReturnPct
 *  headline, not the odds-scaled pnlUnits series). */
export function computeReturnCurve(rows: DisplaySignalRow[]): ReturnCurvePoint[] {
  const ordered = [...rows].sort((a, b) => a.score_rank - b.score_rank);
  const totalRows = ordered.length;
  if (totalRows === 0) return [];
  let cumulativePnlUnits = 0;
  let cumulativeProfitUsd = 0;
  return ordered.map((r, i) => {
    cumulativePnlUnits = round(cumulativePnlUnits + (r.projected_pnl_units ?? 0), 4);
    cumulativeProfitUsd = round(cumulativeProfitUsd + (r.projected_return_usd ?? 0), 2);
    return {
      index: i,
      cumulativePnlUnits,
      cumulativeRoiPct: round((cumulativePnlUnits / totalRows) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
    };
  });
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function avg(vals: number[]): number {
  return vals.length > 0 ? vals.reduce((sum, v) => sum + v, 0) / vals.length : 0;
}

function sum(vals: number[]): number {
  return vals.reduce((total, v) => total + v, 0);
}

/** Aggregates summary metrics from ALL display-table rows for the requested
 *  window_days. Must be computed over the full row set — never truncated by
 *  the request's ledger `limit`.
 *
 *  netProfitUsd/totalStakeUsd/netReturnPct implement the flat-$100-stake
 *  business formula: totalStakeUsd = selectedSignals * stakeUsd,
 *  netProfitUsd = sum(projected_return_usd), netReturnPct = netProfitUsd /
 *  totalStakeUsd * 100. projectedReturnUsd/projectedRoiPct are kept equal to
 *  netProfitUsd/netReturnPct for backward compatibility with existing
 *  consumers of this summary. */
export function computeDisplaySignalsSummary(rows: DisplaySignalRow[]): DisplaySignalsSummary {
  const selectedSignals = rows.length;
  if (selectedSignals === 0) {
    return {
      selectedSignals: 0,
      oddsCoveragePct: 0,
      oddsSourceBreakdown: {},
      projectedWinRatePct: 0,
      avgDecimalOdds: 0,
      projectedPnlUnits: 0,
      projectedReturnUsd: 0,
      projectedRoiPct: 0,
      stakeUsd: STAKE_USD,
      totalStakeUsd: 0,
      netProfitUsd: 0,
      winsCount: 0,
      lossesCount: 0,
      resolvedCount: 0,
      pendingCount: 0,
    };
  }

  const winsCount = rows.filter((r) => deriveDisplayStatus(r.projected_return_usd) === "Hit").length;
  const lossesCount = rows.filter((r) => deriveDisplayStatus(r.projected_return_usd) === "Miss").length;
  const resolvedCount = winsCount + lossesCount;
  const pendingCount = selectedSignals - resolvedCount;

  const withOdds = rows.filter((r) => r.decimal_odds !== null && r.odds_source_path !== null);
  const oddsCoveragePct = round((withOdds.length / selectedSignals) * 100, 2);

  const oddsSourceBreakdown: Record<string, number> = {};
  for (const r of rows) {
    const key = r.odds_source_path ?? "unknown";
    oddsSourceBreakdown[key] = (oddsSourceBreakdown[key] ?? 0) + 1;
  }

  const totalStakeUsd = selectedSignals * STAKE_USD;
  const netProfitUsd = round(sum(rows.map((r) => r.projected_return_usd ?? 0)), 2);
  const netReturnPct = round((netProfitUsd / totalStakeUsd) * 100, 2);

  return {
    selectedSignals,
    oddsCoveragePct,
    oddsSourceBreakdown,
    projectedWinRatePct: round(avg(rows.map((r) => r.projected_win_rate_pct ?? 0)), 2),
    avgDecimalOdds: round(avg(rows.map((r) => r.decimal_odds ?? 0)), 3),
    projectedPnlUnits: round(sum(rows.map((r) => r.projected_pnl_units ?? 0)), 4),
    projectedReturnUsd: netProfitUsd,
    projectedRoiPct: netReturnPct,
    stakeUsd: STAKE_USD,
    totalStakeUsd,
    netProfitUsd,
    winsCount,
    lossesCount,
    resolvedCount,
    pendingCount,
  };
}

/** Maps a raw display-table row to the UI-facing TrackRecordRow shape. */
export function mapDisplaySignalRowToTrackRecordRow(r: DisplaySignalRow): TrackRecordRow {
  return {
    id: `${r.batch_day}-${r.score_rank}`,
    eventTitle: r.event_title,
    marketQuestion: r.market_question,
    pick: r.position,
    createdAt: r.batch_day,
    decimalOdds: r.decimal_odds ?? 0,
    americanOdds: r.american_odds,
    oddsSourcePath: r.odds_source_path,
    projectedWinProbabilityPct: r.projected_win_rate_pct ?? 0,
    pnlUnits: r.projected_pnl_units ?? 0,
    projectedReturnUsd: r.projected_return_usd ?? 0,
    projectedRoiPctPerSignal: r.projected_roi_pct_per_signal ?? 0,
    status: "Published",
    displayStatus: deriveDisplayStatus(r.projected_return_usd),
    action: r.action,
    returnLabel: formatReturnLabel(r.projected_return_usd),
    scoreRank: r.score_rank,
    sourceModel: r.source_model,
  };
}

// ── Real resolved track record (generated_signal_pairs) ──────────────────────
// Source of truth for the WhyTrust trust-block PnL: public.generated_signal_pairs.
// Only rows with resolved_at set, signal_result in ('won','lost'), and a valid
// entry_price_num (0,1) are eligible. NEVER derive Hit/Miss/PnL from
// public.track_record_display_signals (unresolved "Published" projections) or
// from any projected EV formula — see docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md.

export const RESOLVED_RESULTS_SOURCE = "generated_signal_pairs_resolved_results" as const;

export interface ResolvedPairRow {
  id: string;
  resolved_at: string;
  created_at: string;
  signal_result: "won" | "lost";
  winning_outcome: string | null;
  selected_outcome: string | null;
  entry_price_num: number;
  premium_signal: unknown;
  market_slug: string | null;
  event_slug: string | null;
  score?: number | null;
}

export interface RealResolvedRow {
  sourceRowId: string;
  resolvedAt: string;
  createdAt: string;
  eventTitle: string;
  marketQuestion: string;
  selectedOutcome: string;
  winningOutcome: string;
  signalResult: "won" | "lost";
  displayStatus: "Hit" | "Miss";
  entryPrice: number;
  decimalOdds: number;
  realPnlUsd: number;
  returnLabel: string;
  score: number | null;
  signalKey: string;
  matchKey: string;
}

/** Flat-$100-stake real PnL. won: 100 * ((1 / entry_price_num) - 1); lost: -100. */
export function computeRealPnlUsd(signalResult: "won" | "lost", entryPriceNum: number): number {
  if (signalResult === "won") return 100 * (1 / entryPriceNum - 1);
  return -100;
}

export function formatRealReturnLabel(realPnlUsd: number): string {
  const rounded = Math.round(Math.abs(realPnlUsd));
  return realPnlUsd >= 0 ? `+$${rounded}` : `-$${rounded}`;
}

function realEventTitle(r: ResolvedPairRow): string {
  const ps = r.premium_signal as Record<string, unknown> | null;
  return safeStr(ps?.eventTitle) ?? safeStr(r.event_slug) ?? safeStr(r.market_slug) ?? "Unknown market";
}

function realMarketQuestion(r: ResolvedPairRow): string {
  const ps = r.premium_signal as Record<string, unknown> | null;
  return safeStr(ps?.marketQuestion) ?? safeStr(r.market_slug) ?? "Unknown market";
}

/** Stable dedupe key: market/question + selected outcome, falling back to row id. */
export function buildSignalKey(r: ResolvedPairRow): string {
  const ps = r.premium_signal as Record<string, unknown> | null;
  const marketPart = safeStr(r.market_slug) ?? safeStr(ps?.marketQuestion);
  const outcomePart = safeStr(r.selected_outcome);
  if (!marketPart && !outcomePart) return `id:${r.id}`;
  return `${marketPart ?? ""}::${outcomePart ?? ""}`;
}

/** Stable match key grouping the same real-world event across rows. */
export function buildMatchKey(r: ResolvedPairRow): string {
  return safeStr(r.event_slug) ?? realEventTitle(r);
}

/** Maps one raw resolved-pair row to the UI/API-facing real-resolved row shape. */
export function mapResolvedPairRow(r: ResolvedPairRow): RealResolvedRow {
  const realPnlUsd = round(computeRealPnlUsd(r.signal_result, r.entry_price_num), 2);
  return {
    sourceRowId: r.id,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    eventTitle: realEventTitle(r),
    marketQuestion: realMarketQuestion(r),
    selectedOutcome: r.selected_outcome ?? "",
    winningOutcome: r.winning_outcome ?? "",
    signalResult: r.signal_result,
    displayStatus: r.signal_result === "won" ? "Hit" : "Miss",
    entryPrice: r.entry_price_num,
    decimalOdds: round(1 / r.entry_price_num, 3),
    realPnlUsd,
    returnLabel: formatRealReturnLabel(realPnlUsd),
    score: r.score ?? null,
    signalKey: buildSignalKey(r),
    matchKey: buildMatchKey(r),
  };
}

/** Deterministic one-row-per-match selection: prefer higher score, then newer
 *  resolved_at, then newer created_at, then stable id. Does not truncate — the
 *  request `limit` only applies to ledger rows downstream, never to selection. */
export function selectResolvedRows(rows: RealResolvedRow[]): RealResolvedRow[] {
  const byMatch = new Map<string, RealResolvedRow>();
  for (const row of rows) {
    const existing = byMatch.get(row.matchKey);
    if (!existing) {
      byMatch.set(row.matchKey, row);
      continue;
    }
    if (isBetterResolvedRow(row, existing)) byMatch.set(row.matchKey, row);
  }
  return Array.from(byMatch.values());
}

function isBetterResolvedRow(a: RealResolvedRow, b: RealResolvedRow): boolean {
  const scoreA = a.score ?? -Infinity;
  const scoreB = b.score ?? -Infinity;
  if (scoreA !== scoreB) return scoreA > scoreB;
  const resolvedA = new Date(a.resolvedAt).getTime();
  const resolvedB = new Date(b.resolvedAt).getTime();
  if (resolvedA !== resolvedB) return resolvedA > resolvedB;
  const createdA = new Date(a.createdAt).getTime();
  const createdB = new Date(b.createdAt).getTime();
  if (createdA !== createdB) return createdA > createdB;
  return a.sourceRowId > b.sourceRowId;
}

export interface RealResolvedSummary {
  signalsTracked: number;
  selectedSignals: number;
  resolvedCount: number;
  pendingCount: number;
  winsCount: number;
  lossesCount: number;
  netProfitUsd: number;
  totalStakeUsd: number;
  netReturnPct: number;
}

export function computeRealResolvedSummary(rows: RealResolvedRow[]): RealResolvedSummary {
  const winsCount = rows.filter((r) => r.signalResult === "won").length;
  const lossesCount = rows.filter((r) => r.signalResult === "lost").length;
  const resolvedCount = winsCount + lossesCount;
  const netProfitUsd = round(sum(rows.map((r) => r.realPnlUsd)), 2);
  const totalStakeUsd = resolvedCount * STAKE_USD;
  const netReturnPct = totalStakeUsd > 0 ? round((netProfitUsd / totalStakeUsd) * 100, 2) : 0;
  return {
    signalsTracked: rows.length,
    selectedSignals: rows.length,
    resolvedCount,
    pendingCount: 0,
    winsCount,
    lossesCount,
    netProfitUsd,
    totalStakeUsd,
    netReturnPct,
  };
}

/** Cumulative real-PnL curve, ordered by resolved_at ascending. */
export function computeRealReturnCurve(rows: RealResolvedRow[]): ReturnCurvePoint[] {
  const ordered = [...rows].sort((a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime());
  let cumulativeProfitUsd = 0;
  return ordered.map((r, i) => {
    cumulativeProfitUsd = round(cumulativeProfitUsd + r.realPnlUsd, 2);
    return {
      index: i,
      cumulativePnlUnits: round(cumulativeProfitUsd / STAKE_USD, 4),
      cumulativeRoiPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
    };
  });
}

// ── track_record_window_results (lagged read-model) ───────────────────────────
// Source of truth for the WhyTrust trust-block API response: the materialized
// read-model public.track_record_window_results (see supabase/migrations/
// 20260702_track_record_window_results.sql). Rows are pre-selected/lagged and
// pre-joined to generated_signal_pairs at refresh time — the API only reads
// and aggregates, it never re-derives selection or PnL from generated_signal_pairs
// or track_record_display_signals directly.

export const WINDOW_RESULTS_SOURCE = "track_record_window_results" as const;

export type TrackRecordStatus = "ready" | "insufficient_history";

/** TS mirror of SQL public.track_record_normalize_match_key: lowercased team
 *  matchup with sport prefix and series/market suffix removed. Keeps team
 *  names — never collapses Dota/Valorant titles into a bare sport label. */
export function normalizeMatchKey(rawTitle: string | null | undefined): string {
  let s = (rawTitle ?? "").trim().toLowerCase();
  if (/^[^:]{1,40}:\s+.*\svs\.?\s/.test(s)) s = s.replace(/^[^:]{1,40}:\s+/, "");
  s = s.replace(/\s+-\s+.*$/, "");
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  return s.trim();
}

export interface WindowSummaryRow {
  window_days: number;
  status: TrackRecordStatus;
  raw_shown_rows: number;
  unique_matches: number;
  resolved_unique_rows: number;
  pending_unique_rows: number;
  wins_count: number;
  losses_count: number;
  net_pnl_usd: number;
  net_return_pct: number;
}

export interface WindowResultRow {
  window_days: number;
  source_row_id: string;
  shown_batch_day: string | null;
  normalized_match_key: string | null;
  score_rank: number | null;
  match_key: string | null;
  signal_key: string | null;
  event_title: string;
  market_question: string | null;
  selected_outcome: string | null;
  signal_result: string | null;
  display_status: "Hit" | "Miss" | "Pending";
  is_resolved: boolean;
  resolved_at: string | null;
  winning_outcome: string | null;
  entry_price_num: number | null;
  decimal_odds: number | null;
  real_pnl_usd: number | null;
  return_label: string;
}

export interface WindowResultsSummary {
  signalsTracked: number;
  resolvedCount: number;
  pendingCount: number;
  winsCount: number;
  lossesCount: number;
  netProfitUsd: number;
  totalStakeUsd: number;
  netReturnPct: number;
}

/** Aggregates over ALL rows for the requested window_days — never truncated by
 *  the request `limit`, which only slices ledger rows downstream. */
export function computeWindowResultsSummary(rows: WindowResultRow[]): WindowResultsSummary {
  const signalsTracked = rows.length;
  const resolvedCount = rows.filter((r) => r.is_resolved).length;
  const pendingCount = signalsTracked - resolvedCount;
  const winsCount = rows.filter((r) => r.display_status === "Hit").length;
  const lossesCount = rows.filter((r) => r.display_status === "Miss").length;
  const netProfitUsd = round(sum(rows.map((r) => r.real_pnl_usd ?? 0)), 2);
  const totalStakeUsd = resolvedCount * STAKE_USD;
  const netReturnPct = totalStakeUsd > 0 ? round((netProfitUsd / totalStakeUsd) * 100, 2) : 0;
  return {
    signalsTracked,
    resolvedCount,
    pendingCount,
    winsCount,
    lossesCount,
    netProfitUsd,
    totalStakeUsd,
    netReturnPct,
  };
}

/** Cumulative real-PnL curve over resolved rows only, ordered by score_rank
 *  ascending — the strict 6/4 display sequence (falls back to resolved_at when
 *  score_rank is absent). */
export function computeWindowReturnCurve(rows: WindowResultRow[]): ReturnCurvePoint[] {
  const resolved = rows.filter((r) => r.is_resolved);
  const ordered = [...resolved].sort((a, b) => {
    const ra = a.score_rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.score_rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const ta = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
    const tb = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
    return ta - tb;
  });
  let cumulativeProfitUsd = 0;
  return ordered.map((r, i) => {
    cumulativeProfitUsd = round(cumulativeProfitUsd + (r.real_pnl_usd ?? 0), 2);
    return {
      index: i,
      cumulativePnlUnits: round(cumulativeProfitUsd / STAKE_USD, 4),
      cumulativeRoiPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
    };
  });
}

export interface WindowResultLedgerRow {
  sourceRowId: string;
  windowDays: number;
  scoreRank: number | null;
  shownBatchDay: string | null;
  normalizedMatchKey: string | null;
  resolvedAt: string | null;
  eventTitle: string;
  marketQuestion: string | null;
  selectedOutcome: string | null;
  winningOutcome: string | null;
  signalResult: string | null;
  displayStatus: "Hit" | "Miss" | "Pending";
  entryPrice: number | null;
  decimalOdds: number | null;
  realPnlUsd: number | null;
  returnLabel: string;
  matchKey: string | null;
  signalKey: string | null;
}

/** Maps one track_record_window_results row to the ledger-row proof-field shape. */
export function mapWindowResultRowToLedgerRow(r: WindowResultRow): WindowResultLedgerRow {
  return {
    sourceRowId: r.source_row_id,
    windowDays: r.window_days,
    scoreRank: r.score_rank,
    shownBatchDay: r.shown_batch_day,
    normalizedMatchKey: r.normalized_match_key,
    resolvedAt: r.resolved_at,
    eventTitle: r.event_title,
    marketQuestion: r.market_question,
    selectedOutcome: r.selected_outcome,
    winningOutcome: r.winning_outcome,
    signalResult: r.signal_result,
    displayStatus: r.display_status,
    entryPrice: r.entry_price_num,
    decimalOdds: r.decimal_odds,
    realPnlUsd: r.real_pnl_usd,
    returnLabel: r.return_label,
    matchKey: r.match_key,
    signalKey: r.signal_key,
  };
}

/** Maps one track_record_window_results row to the UI-facing TrackRecordRow shape. */
export function mapWindowResultRowToTrackRecordRow(r: WindowResultRow): TrackRecordRow {
  return {
    id: r.source_row_id,
    eventTitle: r.event_title,
    marketQuestion: r.market_question ?? "",
    pick: r.selected_outcome ?? "",
    createdAt: r.resolved_at ?? "",
    decimalOdds: r.decimal_odds ?? 0,
    americanOdds: decimalToAmerican(r.decimal_odds),
    oddsSourcePath: "track_record_window_results.decimal_odds",
    projectedWinProbabilityPct: 0,
    pnlUnits: round((r.real_pnl_usd ?? 0) / STAKE_USD, 4),
    projectedReturnUsd: r.real_pnl_usd ?? 0,
    projectedRoiPctPerSignal: round(((r.real_pnl_usd ?? 0) / STAKE_USD) * 100, 2),
    status: r.is_resolved ? "Resolved" : "Published",
    displayStatus: r.display_status,
    action: null,
    returnLabel: r.return_label,
    scoreRank: r.score_rank ?? 0,
    sourceModel: null,
  };
}

export interface CarouselResolvedSignal {
  id: string;
  eventTitle: string;
  pick: string;
  winner: string;
  result: string;
  returnPct: number | null;
  europeanOdds: number | null;
  americanOdds: string | null;
  signalConfidence: number | null;
  trustMetrics: { smartMoney: number | null; whaleVsPublicMoney: number | null; preEventScoreAI: number | null };
  marketActivityScore: number | null;
  marketActivityLabel: string | null;
  resolvedAt: string;
}

/** Maps one track_record_window_results row to the legacy carousel signal
 *  shape consumed by ResolvedSignalsCarousel / PassOfferModal / the
 *  reconstruction page (`GET /api/signals/resolved` `signals` field). Reads
 *  the SAME read-model row as weekResultsCard — never a second live query
 *  against generated_signal_pairs. signalConfidence/trustMetrics/
 *  marketActivityScore have no equivalent in the read-model and are null. */
export function mapWindowResultRowToCarouselSignal(r: WindowResultRow): CarouselResolvedSignal {
  return {
    id: r.source_row_id,
    eventTitle: r.event_title,
    pick: r.selected_outcome ?? "",
    winner: r.winning_outcome ?? "",
    result: r.signal_result ?? "",
    returnPct: r.real_pnl_usd !== null ? round((r.real_pnl_usd / STAKE_USD) * 100, 2) : null,
    europeanOdds: r.decimal_odds,
    americanOdds: decimalToAmerican(r.decimal_odds),
    signalConfidence: null,
    trustMetrics: { smartMoney: null, whaleVsPublicMoney: null, preEventScoreAI: null },
    marketActivityScore: null,
    marketActivityLabel: null,
    resolvedAt: r.resolved_at ?? "",
  };
}

export function mapRealResolvedRowToTrackRecordRow(r: RealResolvedRow): TrackRecordRow {
  return {
    id: r.sourceRowId,
    eventTitle: r.eventTitle,
    marketQuestion: r.marketQuestion,
    pick: r.selectedOutcome,
    createdAt: r.resolvedAt,
    decimalOdds: r.decimalOdds,
    americanOdds: decimalToAmerican(r.decimalOdds),
    oddsSourcePath: "generated_signal_pairs.entry_price_num",
    projectedWinProbabilityPct: 0,
    pnlUnits: round(r.realPnlUsd / STAKE_USD, 4),
    projectedReturnUsd: r.realPnlUsd,
    projectedRoiPctPerSignal: round((r.realPnlUsd / STAKE_USD) * 100, 2),
    status: "Resolved",
    displayStatus: r.displayStatus,
    action: null,
    returnLabel: r.returnLabel,
    scoreRank: 0,
    sourceModel: null,
  };
}

// ── DB row type (resolved-signal carousel) ────────────────────────────────────

interface DbRow {
  id: string;
  created_at: string;
  resolved_at: string | null;
  condition_id: string | null;
  selected_outcome: string | null;
  winning_outcome: string | null;
  signal_result: string | null;
  realized_return_pct: number | null;
  metric_formula_version: string | null;
  entry_price_num: number | null;
  premium_signal: unknown;
  diagnostics: unknown;
}

// ── WeekResultsCard data contract ─────────────────────────────────────────────
// Published-signal projected track record, sourced from the accepted physical
// display table. Not tied to activePair / MarketSourceCard. Contract lives in
// components/signal-week-results/types.ts (shared with the UI).

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("mode") ?? "";
  const isLatestMode = mode === "latest";

  const rawDays = parseInt(searchParams.get("days") ?? String(LATEST_DEFAULT_DAYS), 10);
  const windowDays = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : LATEST_DEFAULT_DAYS;

  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  // Ledger rows (weekResultsCard.trackRecordDisplayTable/resolvedLedger) are always
  // clamped against MAX_LIMIT — never against LATEST_MAX_CARDS, which only bounds
  // the separate `signals` carousel array below. A ledger request of limit=25 must
  // not be silently clamped down to the 7-card carousel cap.
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, MIN_LIMIT), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { ok: false, error: "SERVER_CONFIG_ERROR" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── weekResultsCard: read-model track_record_window_results ──────────────
  // The API reads the pre-selected, pre-joined lagged read-model only. It
  // never re-derives selection or PnL from generated_signal_pairs or
  // track_record_display_signals — see docs/ai-context/REAL_RESOLVED_TRACK_RECORD_FLOW.md.
  const trackWindowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const WINDOW_RESULTS_SELECT =
    "window_days, source_row_id, score_rank, shown_batch_day, normalized_match_key, " +
    "match_key, signal_key, event_title, " +
    "market_question, selected_outcome, signal_result, display_status, is_resolved, " +
    "resolved_at, winning_outcome, entry_price_num, decimal_odds, real_pnl_usd, return_label";

  const [windowResultsRes, windowSummaryRes] = await Promise.all([
    supabase
      .from("track_record_window_results")
      .select(WINDOW_RESULTS_SELECT)
      .eq("window_days", windowDays)
      .order("score_rank", { ascending: true })
      .limit(DISPLAY_TABLE_FETCH_LIMIT),
    supabase
      .from("track_record_window_summary")
      .select(
        "window_days, status, raw_shown_rows, unique_matches, resolved_unique_rows, " +
        "pending_unique_rows, wins_count, losses_count, net_pnl_usd, net_return_pct"
      )
      .eq("window_days", windowDays)
      .maybeSingle(),
  ]);

  if (windowResultsRes.error) {
    return NextResponse.json(
      { ok: false, error: "DB_QUERY_ERROR", detail: windowResultsRes.error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const windowSummary = (windowSummaryRes.data as WindowSummaryRow | null) ?? null;
  // Missing summary row = the shown-history refresh has not produced enough
  // resolved rows (or has never run) — always the honest fallback, never a
  // positive PnL fabricated from other sources.
  const trackStatus: TrackRecordStatus =
    windowSummary?.status === "ready" ? "ready" : "insufficient_history";

  // Result rows exist only for ready windows; ignore any stale rows otherwise.
  const windowRows =
    trackStatus === "ready"
      ? (((windowResultsRes.data ?? []) as unknown) as WindowResultRow[])
      : [];

  // 14D superset proof: only meaningful when the wider window was requested.
  let supersetMissingCount = 0;
  if (windowDays === 14) {
    const { data: sevenDayIdsRaw } = await supabase
      .from("track_record_window_results")
      .select("source_row_id")
      .eq("window_days", 7)
      .limit(DISPLAY_TABLE_FETCH_LIMIT);
    const fourteenIds = new Set(windowRows.map((r) => r.source_row_id));
    supersetMissingCount = ((sevenDayIdsRaw ?? []) as { source_row_id: string }[]).filter(
      (r) => !fourteenIds.has(r.source_row_id)
    ).length;
  }

  const rowsSummary = computeWindowResultsSummary(windowRows);
  const returnCurve = computeWindowReturnCurve(windowRows);

  // Funnel counts come from the summary table (full shown-history funnel);
  // PnL comes from the ready-window result rows only. insufficient_history
  // always reports zero PnL — never a positive Net Return.
  const rawShownRows = windowSummary?.raw_shown_rows ?? 0;
  const uniqueMatches = windowSummary?.unique_matches ?? 0;
  const summary = {
    signalsTracked: trackStatus === "ready" ? rowsSummary.signalsTracked : uniqueMatches,
    resolvedCount: windowSummary?.resolved_unique_rows ?? rowsSummary.resolvedCount,
    pendingCount: windowSummary?.pending_unique_rows ?? rowsSummary.pendingCount,
    winsCount: trackStatus === "ready" ? rowsSummary.winsCount : 0,
    lossesCount: trackStatus === "ready" ? rowsSummary.lossesCount : 0,
    netProfitUsd: trackStatus === "ready" ? rowsSummary.netProfitUsd : 0,
    totalStakeUsd: trackStatus === "ready" ? rowsSummary.totalStakeUsd : 0,
    netReturnPct: trackStatus === "ready" ? rowsSummary.netReturnPct : 0,
  };

  // Ledger rows displayed in the UI are capped by the request `limit`; the
  // summary above is always computed from the full table row set for this window.
  // Ordered by score_rank asc — the strict 6/4 display sequence, so the visible
  // first rows carry the 6 Hit / 4 Miss balance.
  const orderedForLedger = [...windowRows].sort((a, b) => {
    const ra = a.score_rank ?? Number.MAX_SAFE_INTEGER;
    const rb = b.score_rank ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const ta = a.resolved_at ? new Date(a.resolved_at).getTime() : 0;
    const tb = b.resolved_at ? new Date(b.resolved_at).getTime() : 0;
    return tb - ta;
  });
  const trackRecordRows: TrackRecordRow[] = orderedForLedger
    .slice(0, limit)
    .map(mapWindowResultRowToTrackRecordRow);
  const ledgerProofRows: WindowResultLedgerRow[] = orderedForLedger
    .slice(0, limit)
    .map(mapWindowResultRowToLedgerRow);

  let trackSampleSizeStatus: "empty" | "early" | "active" | "enough_data";
  if (summary.signalsTracked === 0) trackSampleSizeStatus = "empty";
  else if (summary.signalsTracked < 3) trackSampleSizeStatus = "early";
  else if (summary.signalsTracked < 10) trackSampleSizeStatus = "active";
  else trackSampleSizeStatus = "enough_data";

  // Safe structured log — counts and aggregates only, never raw rows/env/secrets.
  console.log("[weekResultsCard]", {
    source: WINDOW_RESULTS_SOURCE,
    status: trackStatus,
    windowDays,
    tableRows: windowRows.length,
    rawShownRows,
    uniqueMatches,
    resolvedRows: summary.resolvedCount,
    pendingRows: summary.pendingCount,
    winsCount: summary.winsCount,
    lossesCount: summary.lossesCount,
    ledgerLimit: limit,
    ledgerRows: trackRecordRows.length,
    netProfitUsd: summary.netProfitUsd,
    netReturnPct: summary.netReturnPct,
    supersetMissingCount,
  });

  const weekResultsCard: WeekResultsCard = {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v3-resolved",
    source: WINDOW_RESULTS_SOURCE,
    status: trackStatus,
    rawShownRows,
    uniqueMatches,
    window: {
      label: `Past ${windowDays} days`,
      days: windowDays,
      startedAt: trackWindowStart,
      endedAt: new Date().toISOString(),
    },
    title: "Resolved signals this window",
    subtitle: "Flat $100 stake model",
    sampleSizeStatus: trackSampleSizeStatus,
    selectedSignals: summary.signalsTracked,
    oddsCoveragePct: summary.signalsTracked > 0 ? 100 : 0,
    oddsSourceBreakdown: summary.signalsTracked > 0
      ? { "track_record_window_results.decimal_odds": summary.signalsTracked }
      : {},
    projectedWinRatePct: summary.resolvedCount > 0
      ? round((summary.winsCount / summary.resolvedCount) * 100, 2)
      : 0,
    avgDecimalOdds: windowRows.length > 0
      ? round(avg(windowRows.map((r) => r.decimal_odds ?? 0)), 3)
      : 0,
    projectedPnlUnits: round(summary.netProfitUsd / STAKE_USD, 4),
    projectedReturnUsd: summary.netProfitUsd,
    projectedRoiPct: summary.netReturnPct,
    stakeUsd: STAKE_USD,
    totalStakeUsd: summary.totalStakeUsd,
    netProfitUsd: summary.netProfitUsd,
    netReturnPct: summary.netReturnPct,
    signalsTracked: summary.signalsTracked,
    resolvedCount: summary.resolvedCount,
    pendingCount: summary.pendingCount,
    winsCount: summary.winsCount,
    lossesCount: summary.lossesCount,
    returnCurve,
    trackRecordDisplayTable: { windowDays, rows: trackRecordRows },
  };

  // ── signals: legacy carousel array (ResolvedSignalsCarousel / PassOfferModal /
  // reconstruction page) — sourced from the SAME read-model rows as
  // weekResultsCard above, never a second live query against
  // generated_signal_pairs. For insufficient_history, windowRows (and
  // therefore orderedForLedger) is already [], so signals is correctly empty
  // — no legacy fallback rows, no mixed old/global data in the response.
  const carouselSignals = orderedForLedger.map(mapWindowResultRowToCarouselSignal);

  let signals = carouselSignals;
  if (isLatestMode) {
    const selected: typeof carouselSignals = [];
    let lostIncluded = 0;
    for (const s of carouselSignals) {
      if (selected.length >= LATEST_MAX_CARDS) break;
      if (s.result === "lost") {
        if (lostIncluded >= LATEST_MAX_LOST) continue;
        lostIncluded++;
      }
      selected.push(s);
    }
    signals = selected;
  } else {
    signals = carouselSignals.slice(0, limit);
  }

  // ── Response ──────────────────────────────────────────────────────────────
  // Top-level `summary` is derived entirely from the read-model values already
  // computed above (windowSummary / summary / trackStatus / rawShownRows) —
  // never recomputed from a second live query. Field names are kept for
  // backward compatibility with existing consumers; the values are the
  // read-model's, not a legacy recompute. No `selectionRule` field: the old
  // highest-activity/max-2-loss carousel selection no longer applies — the
  // read-model rows are already the single source of truth, ordered by
  // score_rank.
  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        uniqueResolved: summary.resolvedCount,
        snapshotRows: rawShownRows,
        won: summary.winsCount,
        lost: summary.lossesCount,
        push: 0,
        sampleSizeStatus: trackSampleSizeStatus,
        showPerformanceClaim: trackStatus === "ready",
        message:
          trackStatus === "ready"
            ? "Resolved track record from actual shown signals only. No global fill, no projected PnL."
            : "Tracking is live. Shown signals are being tracked until enough results resolve.",
        ...(isLatestMode && {
          latestMode: true,
          windowDays,
          maxCards: LATEST_MAX_CARDS,
          maxLost: LATEST_MAX_LOST,
          excludePush: true,
        }),
      },
      signals,
      weekResultsCard,
      resolvedLedger: ledgerProofRows,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
