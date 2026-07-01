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
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, MIN_LIMIT), isLatestMode ? LATEST_MAX_CARDS : MAX_LIMIT)
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

  // ── weekResultsCard: published-signal track record from the accepted display table ──
  const trackWindowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: displayRows, error: displayQueryError } = await supabase
    .from("track_record_display_signals")
    .select(
      "window_days, source_model, score_rank, event_title, market_question, position, " +
      "american_odds, decimal_odds, odds_source_path, projected_win_rate_pct, " +
      "projected_pnl_units, projected_return_usd, projected_roi_pct_per_signal, " +
      "status, action, return_label, batch_day"
    )
    .eq("window_days", windowDays)
    .order("score_rank", { ascending: true })
    .limit(DISPLAY_TABLE_FETCH_LIMIT);

  if (displayQueryError) {
    return NextResponse.json(
      { ok: false, error: "DB_QUERY_ERROR", detail: displayQueryError.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const allDisplayRows = ((displayRows ?? []) as unknown) as DisplaySignalRow[];
  const summary = computeDisplaySignalsSummary(allDisplayRows);
  const returnCurve = computeReturnCurve(allDisplayRows);

  // Ledger rows displayed in the UI are capped by the request `limit`; the
  // summary above is always computed from the full per-window row set.
  const trackRecordRows: TrackRecordRow[] = allDisplayRows
    .slice(0, limit)
    .map(mapDisplaySignalRowToTrackRecordRow);

  let trackSampleSizeStatus: "empty" | "early" | "active" | "enough_data";
  if (summary.selectedSignals === 0) trackSampleSizeStatus = "empty";
  else if (summary.selectedSignals < 3) trackSampleSizeStatus = "early";
  else if (summary.selectedSignals < 10) trackSampleSizeStatus = "active";
  else trackSampleSizeStatus = "enough_data";

  console.log("[weekResultsCard]", {
    windowDays,
    source: "track_record_display_signals",
    selectedSignals: summary.selectedSignals,
    oddsCoveragePct: summary.oddsCoveragePct,
    oddsSourceBreakdown: summary.oddsSourceBreakdown,
    projectedRoiPct: summary.projectedRoiPct,
  });

  const weekResultsCard: WeekResultsCard = {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v2-projected",
    source: "track_record_display_signals",
    window: {
      label: `Past ${windowDays} days`,
      days: windowDays,
      startedAt: trackWindowStart,
      endedAt: new Date().toISOString(),
    },
    title: "Signals published this window",
    subtitle: "Flat $100 stake model",
    sampleSizeStatus: trackSampleSizeStatus,
    selectedSignals: summary.selectedSignals,
    oddsCoveragePct: summary.oddsCoveragePct,
    oddsSourceBreakdown: summary.oddsSourceBreakdown,
    projectedWinRatePct: summary.projectedWinRatePct,
    avgDecimalOdds: summary.avgDecimalOdds,
    projectedPnlUnits: summary.projectedPnlUnits,
    projectedReturnUsd: summary.projectedReturnUsd,
    projectedRoiPct: summary.projectedRoiPct,
    stakeUsd: summary.stakeUsd,
    totalStakeUsd: summary.totalStakeUsd,
    netProfitUsd: summary.netProfitUsd,
    netReturnPct: summary.projectedRoiPct,
    signalsTracked: summary.selectedSignals,
    resolvedCount: summary.resolvedCount,
    pendingCount: summary.pendingCount,
    winsCount: summary.winsCount,
    lossesCount: summary.lossesCount,
    returnCurve,
    trackRecordDisplayTable: { windowDays, rows: trackRecordRows },
  };

  let query = supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, resolved_at, condition_id, selected_outcome, winning_outcome, " +
      "signal_result, realized_return_pct, metric_formula_version, entry_price_num, " +
      "premium_signal, diagnostics"
    )
    .not("signal_result", "is", null)
    // Exclude shadow research rows; preserve legacy rows where metric_formula_version IS NULL.
    .or("metric_formula_version.is.null,metric_formula_version.not.like.shadow-%")
    .order("resolved_at", { ascending: false })
    .limit(INTERNAL_FETCH_LIMIT);

  if (isLatestMode) {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("resolved_at", cutoff);
  }

  const { data: rows, error: queryError } = await query;

  if (queryError) {
    return NextResponse.json(
      { ok: false, error: "DB_QUERY_ERROR", detail: queryError.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        summary: {
          uniqueResolved: 0, snapshotRows: 0,
          won: 0, lost: 0, push: 0,
          sampleSizeStatus: "early",
          showPerformanceClaim: false,
          message: "Tracking is live. Early sample, not performance guarantee.",
          ...(isLatestMode && {
            latestMode: true,
            windowDays,
            maxCards: LATEST_MAX_CARDS,
            maxLost: LATEST_MAX_LOST,
            excludePush: true,
            selectionRule: "last_7d_highest_activity_max_two_loss",
          }),
        },
        signals: [],
        weekResultsCard,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // ── Dedupe by condition_id + selected_outcome ─────────────────────────────
  const groups = new Map<string, DbRow[]>();
  for (const raw of (rows as unknown) as DbRow[]) {
    const key = `${raw.condition_id ?? ""}::${raw.selected_outcome ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(raw);
  }

  // ── Build deduplicated signal list ─────────────────────────────────────────
  interface ResolvedSignal {
    id: string;
    conditionId: string;
    eventTitle: string;
    pick: string;
    winner: string;
    result: string;
    returnPct: number | null;
    entryPrice: number | null;
    europeanOdds: number | null;
    americanOdds: string | null;
    signalConfidence: number | null;
    trustMetrics: { smartMoney: number | null; whaleVsPublicMoney: number | null; preEventScoreAI: number | null };
    snapshotRows: number;
    marketActivityScore: number | null;
    marketActivityLabel: string | null;
    firstSignalCreatedAt: string;
    lastSignalCreatedAt: string;
    resolvedAt: string;
    metricFormulaVersion: string | null;
  }

  const allSignals: ResolvedSignal[] = [];
  let wonCount = 0, lostCount = 0, pushCount = 0;

  for (const [, group] of groups) {
    group.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const rep = group[0];
    const lastRow = group[group.length - 1];

    const resolvedAt =
      group.map((r) => r.resolved_at).filter(Boolean).sort().reverse()[0] ??
      rep.resolved_at ?? rep.created_at;

    const result = rep.signal_result ?? "unknown";
    if (result === "won") wonCount++;
    else if (result === "lost") lostCount++;
    else pushCount++;

    const decOdds = europeanOdds(rep.entry_price_num ?? null);
    const { score: actScore, label: actLabel } = extractActivityScore(rep, group.length);

    allSignals.push({
      id: rep.id,
      conditionId: rep.condition_id ?? "",
      eventTitle: extractEventTitle(rep),
      pick: rep.selected_outcome ?? "",
      winner: rep.winning_outcome ?? "",
      result,
      returnPct: rep.realized_return_pct ?? null,
      entryPrice: rep.entry_price_num ?? null,
      europeanOdds: decOdds,
      americanOdds: decimalToAmerican(decOdds),
      signalConfidence: extractConfidence(rep),
      trustMetrics: extractTrustMetrics(rep),
      snapshotRows: group.length,
      marketActivityScore: actScore,
      marketActivityLabel: actLabel,
      firstSignalCreatedAt: rep.created_at,
      lastSignalCreatedAt: lastRow.created_at,
      resolvedAt,
      metricFormulaVersion: rep.metric_formula_version ?? null,
    });
  }

  // ── Latest-mode carousel subset ───────────────────────────────────────────
  let signals = allSignals;

  if (isLatestMode) {
    signals = signals.filter((s) => !PUSH_RESULTS.has(s.result));
    signals.sort((a, b) => {
      const scoreDiff = (b.marketActivityScore ?? 0) - (a.marketActivityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime();
    });

    const selected: ResolvedSignal[] = [];
    let lostIncluded = 0;
    for (const s of signals) {
      if (selected.length >= LATEST_MAX_CARDS) break;
      if (s.result === "lost") {
        if (lostIncluded >= LATEST_MAX_LOST) continue;
        lostIncluded++;
      }
      selected.push(s);
    }
    signals = selected;
  } else {
    signals.sort((a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime());
    signals = signals.slice(0, limit);
  }

  // ── Response ──────────────────────────────────────────────────────────────
  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        uniqueResolved: allSignals.length,
        snapshotRows: rows.length,
        won: wonCount,
        lost: lostCount,
        push: pushCount,
        sampleSizeStatus: "early",
        showPerformanceClaim: false,
        message: "Tracking is live. Early sample, not performance guarantee.",
        ...(isLatestMode && {
          latestMode: true,
          windowDays,
          maxCards: LATEST_MAX_CARDS,
          maxLost: LATEST_MAX_LOST,
          excludePush: true,
          selectionRule: "last_7d_highest_activity_max_two_loss",
        }),
      },
      signals,
      weekResultsCard,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
