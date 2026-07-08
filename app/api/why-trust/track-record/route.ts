// GET /api/why-trust/track-record?days=14&limit=25
// WhyTrust-ONLY isolated endpoint (UI_recovery_plan1 Phase 3A).
// Read-only. Returns a weekResultsCard-compatible payload for WhyTrustSection.
//
// ISOLATION RULE: this route serves ONLY components/why-trust/WhyTrustSection.tsx.
// It must never be consumed by (or import from) the shared resolved-signals
// contract: Top Weekly proof, Paywall proof, Latest Resolved, the landing
// carousel, PremiumEventCard.
//
// Data flow (read-only, no DB writes, no RPC):
//   1. track_record_window_summary  → funnel counters + status for the window.
//   2. track_record_window_results  → detail rows (populated only for ready windows).
//   3. If (2) is empty but the summary shows resolved rows exist, build HONEST
//      preview rows from track_record_shown_signal_history joined (two-step)
//      to generated_signal_pairs — real resolved won/lost rows only. Status is
//      preserved as-is: preview NEVER masks insufficient_history as ready, and
//      insufficient_history always reports zero headline PnL.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type {
  WeekResultsCard,
  TrackRecordRow,
  ReturnCurvePoint,
} from "@/components/signal-week-results/types";
import { buildQualifiedCumulativeReturnCurve } from "@/lib/track-record/promotionalTrustGate";

export const dynamic = "force-dynamic";

export const WHY_TRUST_SOURCE = "why_trust_track_record" as const;
export const PREVIEW_DETAIL_SOURCE = "preview_from_shown_history" as const;
export const WINDOW_RESULTS_DETAIL_SOURCE = "window_results" as const;

const ALLOWED_DAYS = new Set([7, 14]);
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 25;
const MIN_LIMIT = 1;
const FETCH_LIMIT = 3000;
const STAKE_USD = 100;

// ── Types (local mirrors of the read-model rows — no shared-route imports) ────

export type WhyTrustStatus = "ready" | "insufficient_history";

export interface WhyTrustSummaryRow {
  window_days: number;
  status: WhyTrustStatus | string;
  raw_shown_rows: number;
  unique_matches: number;
  resolved_unique_rows: number;
  pending_unique_rows: number;
  wins_count: number;
  losses_count: number;
  net_pnl_usd: number;
  net_return_pct: number;
}

export interface WhyTrustWindowResultRow {
  window_days: number;
  source_row_id: string;
  score_rank: number | null;
  shown_batch_day: string | null;
  normalized_match_key: string | null;
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

export interface ShownHistoryRow {
  source_row_id: string;
  shown_batch_day: string | null;
  event_title: string;
  market_question: string | null;
  selected_outcome: string | null;
  display_score_rank: number | null;
  normalized_match_key: string | null;
}

export interface ResolvedPairLookupRow {
  id: string;
  resolved_at: string | null;
  signal_result: string | null;
  winning_outcome: string | null;
  entry_price_num: number | null;
}

/** WeekResultsCard-compatible payload with the WhyTrust-only source marker and
 *  a detailSource the existing UI can safely ignore. */
export type WhyTrustWeekResultsCard = Omit<WeekResultsCard, "source"> & {
  source: typeof WHY_TRUST_SOURCE;
  detailSource: typeof PREVIEW_DETAIL_SOURCE | typeof WINDOW_RESULTS_DETAIL_SOURCE | "none";
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function decimalToAmerican(decimalOdds: number | null): string | null {
  if (!decimalOdds || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  if (decimalOdds >= 2) return `+${Math.round((decimalOdds - 1) * 100)}`;
  return `${Math.round(-100 / (decimalOdds - 1))}`;
}

/** Flat-$100-stake real PnL. won: 100 * ((1 / entry_price_num) - 1); lost: -100. */
export function computePreviewPnlUsd(
  signalResult: "won" | "lost",
  entryPriceNum: number | null
): number {
  if (signalResult === "lost") return -100;
  if (!entryPriceNum || entryPriceNum <= 0 || entryPriceNum >= 1) return 0;
  return round(100 * (1 / entryPriceNum - 1), 2);
}

function formatReturnLabel(pnlUsd: number): string {
  const rounded = Math.round(Math.abs(pnlUsd));
  return pnlUsd >= 0 ? `+$${rounded}` : `-$${rounded}`;
}

// ── Detail-row mapping ─────────────────────────────────────────────────────────

function mapWindowResultRow(r: WhyTrustWindowResultRow): TrackRecordRow {
  return {
    id: r.source_row_id,
    eventTitle: r.event_title,
    marketQuestion: r.market_question ?? "",
    pick: r.selected_outcome ?? "",
    // Date rule: shown_batch_day ?? resolved_at (trust ledger shows shown date).
    createdAt: r.shown_batch_day ?? r.resolved_at ?? "",
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

/** Builds HONEST preview ledger rows when track_record_window_results is empty:
 *  real resolved won/lost shown rows only (two-step read of the shown-history
 *  table + generated_signal_pairs by id). Never includes pending/unresolved
 *  rows, never fabricates outcomes, deduped one row per normalized match. */
export function buildPreviewRows(
  historyRows: ShownHistoryRow[],
  pairRows: ResolvedPairLookupRow[]
): TrackRecordRow[] {
  const pairById = new Map(pairRows.map((p) => [p.id, p]));

  const byMatch = new Map<string, TrackRecordRow>();
  for (const h of historyRows) {
    const pair = pairById.get(h.source_row_id);
    if (!pair) continue;
    const result = pair.signal_result;
    // Real resolved won/lost only — everything else stays out of the preview.
    if ((result !== "won" && result !== "lost") || !pair.resolved_at) continue;

    const pnlUsd = computePreviewPnlUsd(result, pair.entry_price_num);
    const decimalOdds =
      pair.entry_price_num && pair.entry_price_num > 0
        ? round(1 / pair.entry_price_num, 3)
        : 0;
    const row: TrackRecordRow = {
      id: h.source_row_id,
      eventTitle: h.event_title,
      marketQuestion: h.market_question ?? "",
      pick: h.selected_outcome ?? "",
      // Date rule preserved from the accepted mapper: shown_batch_day ?? resolved_at.
      createdAt: h.shown_batch_day ?? pair.resolved_at,
      decimalOdds,
      americanOdds: decimalToAmerican(decimalOdds || null),
      oddsSourcePath: "generated_signal_pairs.entry_price_num",
      projectedWinProbabilityPct: 0,
      pnlUnits: round(pnlUsd / STAKE_USD, 4),
      projectedReturnUsd: pnlUsd,
      projectedRoiPctPerSignal: round((pnlUsd / STAKE_USD) * 100, 2),
      status: "Resolved",
      displayStatus: result === "won" ? "Hit" : "Miss",
      action: null,
      returnLabel: formatReturnLabel(pnlUsd),
      scoreRank: h.display_score_rank ?? 0,
      sourceModel: null,
    };

    const matchKey = h.normalized_match_key ?? h.source_row_id;
    const existing = byMatch.get(matchKey);
    // Deterministic dedupe: newest resolved date wins, then stable id.
    if (!existing || row.createdAt > existing.createdAt || (row.createdAt === existing.createdAt && row.id > existing.id)) {
      byMatch.set(matchKey, row);
    }
  }

  return Array.from(byMatch.values()).sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? 1 : -1)
  );
}

/** Cumulative real-PnL curve over the given rows, oldest first. Unchanged
 *  legacy formula — still used for the preview/insufficient_history path,
 *  which this patch does not touch. */
function computeCurve(rows: TrackRecordRow[]): ReturnCurvePoint[] {
  const ordered = [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : (a.createdAt < b.createdAt ? -1 : 1)
  );
  let cumulativeProfitUsd = 0;
  return ordered.map((r, i) => {
    cumulativeProfitUsd = round(cumulativeProfitUsd + r.projectedReturnUsd, 2);
    return {
      index: i,
      cumulativePnlUnits: round(cumulativeProfitUsd / STAKE_USD, 4),
      cumulativeRoiPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * STAKE_USD)) * 100, 2),
    };
  });
}

// ── Card builder (pure — contract-tested) ─────────────────────────────────────

export interface BuildCardInput {
  windowDays: number;
  limit: number;
  summary: WhyTrustSummaryRow | null;
  windowRows: WhyTrustWindowResultRow[];
  previewRows: TrackRecordRow[];
}

export function buildWhyTrustWeekResultsCard(input: BuildCardInput): WhyTrustWeekResultsCard {
  const { windowDays, limit, summary, windowRows, previewRows } = input;

  // Status comes from the summary table only — never upgraded by detail rows.
  const status: WhyTrustStatus = summary?.status === "ready" ? "ready" : "insufficient_history";

  const detailFromResults = windowRows.length > 0;
  // Full resolved ordered pool (unsliced by `limit`) — used only to build the
  // WhyTrust Cumulative Return graph for the ready/window-results path. The
  // ledger below stays limit-sliced; the preview/insufficient_history path is
  // untouched by this pool and keeps its existing curve behavior.
  const fullResolvedOrderedRowsForCurve: TrackRecordRow[] = detailFromResults
    ? windowRows
        .filter((r) => r.is_resolved)
        .slice()
        .sort((a, b) => (a.score_rank ?? Number.MAX_SAFE_INTEGER) - (b.score_rank ?? Number.MAX_SAFE_INTEGER))
        .map(mapWindowResultRow)
    : [];
  const ledgerRows: TrackRecordRow[] = detailFromResults
    ? windowRows
        .slice()
        .sort((a, b) => (a.score_rank ?? Number.MAX_SAFE_INTEGER) - (b.score_rank ?? Number.MAX_SAFE_INTEGER))
        .slice(0, limit)
        .map(mapWindowResultRow)
    : previewRows.slice(0, limit);
  const detailSource = detailFromResults
    ? WINDOW_RESULTS_DETAIL_SOURCE
    : ledgerRows.length > 0
      ? PREVIEW_DETAIL_SOURCE
      : "none";

  const rawShownRows = summary?.raw_shown_rows ?? 0;
  const uniqueMatches = summary?.unique_matches ?? 0;
  const resolvedCount = summary?.resolved_unique_rows ?? 0;
  const pendingCount = summary?.pending_unique_rows ?? 0;
  const signalsTracked = uniqueMatches;

  // Headline PnL is real only for ready windows; insufficient_history reports
  // zero — a preview ledger never fabricates a positive Net Return headline.
  const netProfitUsd = status === "ready" ? round(summary?.net_pnl_usd ?? 0, 2) : 0;
  const netReturnPct = status === "ready" ? round(summary?.net_return_pct ?? 0, 2) : 0;
  const winsCount = status === "ready" ? summary?.wins_count ?? 0 : 0;
  const lossesCount = status === "ready" ? summary?.losses_count ?? 0 : 0;
  const totalStakeUsd = status === "ready" ? resolvedCount * STAKE_USD : 0;

  // Ready/window-results path: curve is built from a qualified 6-winner :
  // up-to-4-non-winner mixed subset of the FULL resolved pool (not the
  // limit-sliced ledger) so a long non-winner run cannot drag it negative.
  // Preview/insufficient_history path keeps the unchanged legacy curve over
  // the same rows shown in the ledger. Neither path touches status, headline
  // PnL, or any other summary/card field.
  const returnCurve: ReturnCurvePoint[] = detailFromResults
    ? buildQualifiedCumulativeReturnCurve(
        fullResolvedOrderedRowsForCurve.map((r) => ({
          id: r.id,
          isWinner: r.displayStatus === "Hit",
          returnUsd: r.projectedReturnUsd,
          createdAt: r.createdAt,
          sourceOrder: r.scoreRank,
        }))
      )
    : computeCurve(ledgerRows);

  let sampleSizeStatus: WeekResultsCard["sampleSizeStatus"];
  if (signalsTracked === 0) sampleSizeStatus = "empty";
  else if (signalsTracked < 3) sampleSizeStatus = "early";
  else if (signalsTracked < 10) sampleSizeStatus = "active";
  else sampleSizeStatus = "enough_data";

  return {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v3-resolved",
    source: WHY_TRUST_SOURCE,
    detailSource,
    status,
    rawShownRows,
    uniqueMatches,
    window: {
      label: `Past ${windowDays} days`,
      days: windowDays,
      startedAt: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString(),
      endedAt: new Date().toISOString(),
    },
    title: "Resolved signals this window",
    subtitle: "Flat $100 stake model",
    sampleSizeStatus,
    selectedSignals: signalsTracked,
    oddsCoveragePct: ledgerRows.length > 0 ? 100 : 0,
    oddsSourceBreakdown:
      ledgerRows.length > 0
        ? { [ledgerRows[0].oddsSourcePath ?? "unknown"]: ledgerRows.length }
        : {},
    projectedWinRatePct:
      status === "ready" && resolvedCount > 0 ? round((winsCount / resolvedCount) * 100, 2) : 0,
    avgDecimalOdds:
      ledgerRows.length > 0
        ? round(ledgerRows.reduce((s, r) => s + r.decimalOdds, 0) / ledgerRows.length, 3)
        : 0,
    projectedPnlUnits: round(netProfitUsd / STAKE_USD, 4),
    projectedReturnUsd: netProfitUsd,
    projectedRoiPct: netReturnPct,
    stakeUsd: STAKE_USD,
    totalStakeUsd,
    netProfitUsd,
    netReturnPct,
    signalsTracked,
    resolvedCount,
    pendingCount,
    winsCount,
    lossesCount,
    returnCurve,
    trackRecordDisplayTable: { windowDays, rows: ledgerRows },
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const rawDays = parseInt(searchParams.get("days") ?? String(DEFAULT_DAYS), 10);
  const windowDays = ALLOWED_DAYS.has(rawDays) ? rawDays : DEFAULT_DAYS;

  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
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

  const [summaryRes, resultsRes] = await Promise.all([
    supabase
      .from("track_record_window_summary")
      .select(
        "window_days, status, raw_shown_rows, unique_matches, resolved_unique_rows, " +
        "pending_unique_rows, wins_count, losses_count, net_pnl_usd, net_return_pct"
      )
      .eq("window_days", windowDays)
      .maybeSingle(),
    supabase
      .from("track_record_window_results")
      .select(
        "window_days, source_row_id, score_rank, shown_batch_day, normalized_match_key, " +
        "match_key, signal_key, event_title, market_question, selected_outcome, " +
        "signal_result, display_status, is_resolved, resolved_at, winning_outcome, " +
        "entry_price_num, decimal_odds, real_pnl_usd, return_label"
      )
      .eq("window_days", windowDays)
      .order("score_rank", { ascending: true })
      .limit(FETCH_LIMIT),
  ]);

  if (resultsRes.error) {
    return NextResponse.json(
      { ok: false, error: "DB_QUERY_ERROR", detail: resultsRes.error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const summary = (summaryRes.data as WhyTrustSummaryRow | null) ?? null;
  const windowRows = ((resultsRes.data ?? []) as unknown) as WhyTrustWindowResultRow[];

  // Honest preview path: results table empty but the summary says resolved
  // shown rows exist → read the real resolved shown rows (read-only, two-step).
  let previewRows: TrackRecordRow[] = [];
  if (windowRows.length === 0 && (summary?.resolved_unique_rows ?? 0) > 0) {
    const windowStartDay = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const historyRes = await supabase
      .from("track_record_shown_signal_history")
      .select(
        "source_row_id, shown_batch_day, event_title, market_question, " +
        "selected_outcome, display_score_rank, normalized_match_key"
      )
      .gte("shown_batch_day", windowStartDay)
      .limit(FETCH_LIMIT);

    if (!historyRes.error && (historyRes.data ?? []).length > 0) {
      const historyRows = ((historyRes.data ?? []) as unknown) as ShownHistoryRow[];
      const ids = historyRows.map((h) => h.source_row_id);
      const pairsRes = await supabase
        .from("generated_signal_pairs")
        .select("id, resolved_at, signal_result, winning_outcome, entry_price_num")
        .in("id", ids)
        .in("signal_result", ["won", "lost"])
        .not("resolved_at", "is", null)
        .limit(FETCH_LIMIT);

      if (!pairsRes.error) {
        previewRows = buildPreviewRows(
          historyRows,
          ((pairsRes.data ?? []) as unknown) as ResolvedPairLookupRow[]
        );
      }
    }
  }

  const weekResultsCard = buildWhyTrustWeekResultsCard({
    windowDays,
    limit,
    summary,
    windowRows,
    previewRows,
  });

  // Safe structured log — counts only, never raw rows/env/secrets.
  console.log("[whyTrustTrackRecord]", {
    source: WHY_TRUST_SOURCE,
    status: weekResultsCard.status,
    detailSource: weekResultsCard.detailSource,
    windowDays,
    resultRows: windowRows.length,
    previewRows: previewRows.length,
    ledgerRows: weekResultsCard.trackRecordDisplayTable.rows.length,
    rawShownRows: weekResultsCard.rawShownRows,
    resolvedCount: weekResultsCard.resolvedCount,
    pendingCount: weekResultsCard.pendingCount,
  });

  return NextResponse.json(
    { ok: true, generatedAt: new Date().toISOString(), weekResultsCard },
    { headers: { "Cache-Control": "no-store" } }
  );
}
