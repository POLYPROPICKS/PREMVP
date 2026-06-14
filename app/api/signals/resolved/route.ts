// GET /api/signals/resolved
// Read-only. Returns deduped resolved signals for landing carousel.
// mode=latest: last N days, max 7 cards, max 1 lost, no push/refund/tie.
// Also exposes weekResultsCard — global weekly proof data contract (no UI rendered here).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const INTERNAL_FETCH_LIMIT = 200;
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
const LATEST_MAX_CARDS = 7;
const LATEST_MAX_LOST = 2;
const LATEST_DEFAULT_DAYS = 7;
const WEEK_MAX_CARDS = 7;
const WEEK_MAX_LOST = 2;

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

function returnLabel(result: string, returnPct: number | null): string {
  if (result === "won") return `+${Math.round(returnPct ?? 0)}%`;
  if (result === "lost") return "-100%";
  return "—";
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

// ── DB row type ───────────────────────────────────────────────────────────────

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
// Global weekly proof payload. Not tied to activePair / MarketSourceCard.
// Design + UI integration is a separate future task.

interface WeekMiniResult {
  id: string;
  eventTitle: string;
  pick: string;
  result: "won" | "lost";
  returnPct: number;
  label: string;
  americanOdds: string | null;
  europeanOdds: number | null;
  marketActivityScore: number;
  resolvedAt: string;
}

interface PaywallChartPoint {
  index: number;
  resolvedAt: string;
  eventTitle: string;
  pick: string;
  result: "won" | "lost";
  returnPct: number;
  cumulativeReturnPct: number;
  americanOdds: string | null;
  europeanOdds: number | null;
  label: string;
}

interface WeekResultsCard {
  cardType: "signal-week-results";
  schemaVersion: "week-results-v1";
  window: { label: "Past 7 days"; days: 7; startedAt: string; endedAt: string };
  title: string;
  subtitle: string;
  selectionRule: "last_7d_highest_activity_max_7_max_2_loss_no_push";
  sampleSizeStatus: "empty" | "early" | "active" | "enough_data";
  showPerformanceClaim: boolean;
  totalStats: {
    resolvedCount: number;
    wonCount: number;
    lostCount: number;
    pushCount: number;
    winRatePct: number | null;
    totalReturnPct: number | null;
  };
  displayedStats: {
    displayedCount: number;
    displayedWon: number;
    displayedLost: number;
    displayedPush: number;
    winRatioLabel: string;
    maxDisplayed: 7;
    maxLosses: 2;
  };
  frontendHints: {
    primaryMetric: string;
    compactFields: string[];
    paywallFields: string[];
    hiddenFields: string[];
  };
  featuredResult: null | {
    id: string;
    eventTitle: string;
    pick: string;
    winner: string;
    result: "won" | "lost";
    returnPct: number;
    americanOdds: string | null;
    europeanOdds: number | null;
    marketActivityScore: number;
    marketActivityLabel: string | null;
    resolvedAt: string;
  };
  miniResults: WeekMiniResult[];
  paywallChart: {
    chartType: "cumulative-return";
    title: string;
    source: "displayed_subset";
    displayMode: "single_cumulative_line";
    yUnit: "return_pct";
    windowLabel: string;
    finalReturnPct: number | null;
    points: PaywallChartPoint[];
  };
  diagnostics: {
    source: "generated_signal_pairs";
    dedupeKey: "condition_id:selected_outcome";
    totalRowsScanned: number;
    uniqueResolvedInWindow: number;
    excludedPushCount: number;
    excludedOverLossLimitCount: number;
    excludedMissingOddsCount: number;
    sortedBy: "marketActivityScore_desc_resolvedAt_desc";
    generatedAt: string;
  };
}

function buildEmptyWeekResultsCard(totalRowsScanned = 0): WeekResultsCard {
  const now = new Date();
  const generatedAt = now.toISOString();
  const startedAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v1",
    window: { label: "Past 7 days", days: 7, startedAt, endedAt: generatedAt },
    title: "Signals tracked this week",
    subtitle: "Real tracking, not a performance guarantee",
    selectionRule: "last_7d_highest_activity_max_7_max_2_loss_no_push",
    sampleSizeStatus: "empty",
    showPerformanceClaim: false,
    totalStats: {
      resolvedCount: 0, wonCount: 0, lostCount: 0, pushCount: 0,
      winRatePct: null, totalReturnPct: null,
    },
    frontendHints: {
      primaryMetric: "displayedStats.winRatioLabel",
      compactFields: ["window.label", "displayedStats.winRatioLabel", "title", "featuredResult", "miniResults"],
      paywallFields: ["window.label", "displayedStats.winRatioLabel", "paywallChart", "featuredResult"],
      hiddenFields: ["diagnostics", "selectionRule", "totalStats.totalReturnPct", "totalStats.winRatePct"],
    },
    displayedStats: {
      displayedCount: 0, displayedWon: 0, displayedLost: 0, displayedPush: 0,
      winRatioLabel: "No results yet", maxDisplayed: 7, maxLosses: 2,
    },
    featuredResult: null,
    miniResults: [],
    paywallChart: {
      chartType: "cumulative-return",
      title: "Cumulative P&L",
      source: "displayed_subset",
      displayMode: "single_cumulative_line",
      yUnit: "return_pct",
      windowLabel: "Past 7 days",
      finalReturnPct: null,
      points: [],
    },
    diagnostics: {
      source: "generated_signal_pairs",
      dedupeKey: "condition_id:selected_outcome",
      totalRowsScanned,
      uniqueResolvedInWindow: 0,
      excludedPushCount: 0,
      excludedOverLossLimitCount: 0,
      excludedMissingOddsCount: 0,
      sortedBy: "marketActivityScore_desc_resolvedAt_desc",
      generatedAt,
    },
  };
}

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
        weekResultsCard: buildEmptyWeekResultsCard(0),
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

  // ── WeekResultsCard computation ───────────────────────────────────────────
  // Uses allSignals (full deduped set) with in-memory 7-day window filter.
  // Completely independent of carousel signals subset above.
  const weekNow = new Date();
  const weekCutoff = new Date(weekNow.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekStartedAt = weekCutoff.toISOString();
  const weekEndedAt = weekNow.toISOString();

  // All deduped resolved signals within 7-day window (includes push for totalStats)
  const weekAll = allSignals.filter((s) => new Date(s.resolvedAt) >= weekCutoff);

  // totalStats — all resolved in window (push included)
  const totalWon = weekAll.filter((s) => s.result === "won").length;
  const totalLost = weekAll.filter((s) => s.result === "lost").length;
  const totalPush = weekAll.filter((s) => PUSH_RESULTS.has(s.result)).length;
  const totalResolved = weekAll.length;

  const totalReturnPct = totalResolved > 0
    ? Math.round(
        weekAll.reduce((sum, s) => {
          if (s.result === "won") return sum + (s.returnPct ?? 0);
          if (s.result === "lost") return sum - 100;
          return sum; // push/void: neutral
        }, 0) * 10
      ) / 10
    : null;
  const winRatePct =
    totalWon + totalLost > 0
      ? Math.round((totalWon / (totalWon + totalLost)) * 100)
      : null;

  // displayedSubset: exclude push, sort activity desc → resolvedAt desc, max 7, max 1 loss
  const weekEligible = weekAll.filter((s) => !PUSH_RESULTS.has(s.result));
  weekEligible.sort((a, b) => {
    const d = (b.marketActivityScore ?? 0) - (a.marketActivityScore ?? 0);
    return d !== 0 ? d : new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime();
  });

  const weekDisplayed: ResolvedSignal[] = [];
  let weekLostIncluded = 0;
  let weekExcludedOverLoss = 0;
  for (const s of weekEligible) {
    if (weekDisplayed.length >= WEEK_MAX_CARDS) break;
    if (s.result === "lost") {
      if (weekLostIncluded >= WEEK_MAX_LOST) { weekExcludedOverLoss++; continue; }
      weekLostIncluded++;
    }
    weekDisplayed.push(s);
  }

  const displayedWon = weekDisplayed.filter((s) => s.result === "won").length;
  const displayedLost = weekDisplayed.filter((s) => s.result === "lost").length;
  const displayedPush = weekDisplayed.filter((s) => PUSH_RESULTS.has(s.result)).length;
  const displayedCount = weekDisplayed.length;
  const winRatioLabel =
    displayedCount > 0 ? `${displayedWon}/${displayedCount} WON` : "No results yet";

  let sampleSizeStatus: "empty" | "early" | "active" | "enough_data";
  if (totalResolved === 0) sampleSizeStatus = "empty";
  else if (totalResolved < 3) sampleSizeStatus = "early";
  else if (totalResolved < 10) sampleSizeStatus = "active";
  else sampleSizeStatus = "enough_data";

  const featured = weekDisplayed[0] ?? null;

  const weekMiniResults: WeekMiniResult[] = weekDisplayed.map((s) => ({
    id: s.id,
    eventTitle: s.eventTitle,
    pick: s.pick,
    result: (s.result === "won" || s.result === "lost") ? s.result : "lost",
    returnPct: s.returnPct ?? 0,
    label: returnLabel(s.result, s.returnPct),
    americanOdds: s.americanOdds ?? null,
    europeanOdds: s.europeanOdds ?? null,
    marketActivityScore: s.marketActivityScore ?? 0,
    resolvedAt: s.resolvedAt,
  }));

  // ── paywallChart: cumulative return line (chronological, displayed subset) ──
  // Uses weekDisplayed sorted chronologically — same data as miniResults, different order.
  const weekChronological = [...weekDisplayed].sort(
    (a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime()
  );
  let runningReturn = 0;
  const paywallPoints: PaywallChartPoint[] = weekChronological.map((s, i) => {
    const pointReturn = s.result === "won" ? (s.returnPct ?? 0) : -100;
    runningReturn = Math.round((runningReturn + pointReturn) * 10) / 10;
    return {
      index: i + 1,
      resolvedAt: s.resolvedAt,
      eventTitle: s.eventTitle,
      pick: s.pick,
      result: (s.result === "won" || s.result === "lost") ? s.result : "lost",
      returnPct: pointReturn,
      cumulativeReturnPct: runningReturn,
      americanOdds: s.americanOdds ?? null,
      europeanOdds: s.europeanOdds ?? null,
      label: returnLabel(s.result, s.returnPct),
    };
  });
  const paywallFinalReturn =
    paywallPoints.length > 0
      ? paywallPoints[paywallPoints.length - 1].cumulativeReturnPct
      : null;

  const weekResultsCard: WeekResultsCard = {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v1",
    window: { label: "Past 7 days", days: 7, startedAt: weekStartedAt, endedAt: weekEndedAt },
    title: "Signals tracked this week",
    subtitle: "Real tracking, not a performance guarantee",
    selectionRule: "last_7d_highest_activity_max_7_max_2_loss_no_push",
    sampleSizeStatus,
    showPerformanceClaim: false,
    totalStats: {
      resolvedCount: totalResolved,
      wonCount: totalWon,
      lostCount: totalLost,
      pushCount: totalPush,
      winRatePct,
      totalReturnPct,
    },
    displayedStats: {
      displayedCount,
      displayedWon,
      displayedLost,
      displayedPush,
      winRatioLabel,
      maxDisplayed: 7,
      maxLosses: 2,
    },
    featuredResult: featured
      ? {
          id: featured.id,
          eventTitle: featured.eventTitle,
          pick: featured.pick,
          winner: featured.winner,
          result: (featured.result === "won" || featured.result === "lost") ? featured.result : "lost",
          returnPct: featured.returnPct ?? 0,
          americanOdds: featured.americanOdds ?? null,
          europeanOdds: featured.europeanOdds ?? null,
          marketActivityScore: featured.marketActivityScore ?? 0,
          marketActivityLabel: featured.marketActivityLabel ?? null,
          resolvedAt: featured.resolvedAt,
        }
      : null,
    miniResults: weekMiniResults,
    paywallChart: {
      chartType: "cumulative-return",
      title: "Cumulative P&L",
      source: "displayed_subset",
      displayMode: "single_cumulative_line",
      yUnit: "return_pct",
      windowLabel: "Past 7 days",
      finalReturnPct: paywallFinalReturn,
      points: paywallPoints,
    },
    frontendHints: {
      primaryMetric: "displayedStats.winRatioLabel",
      compactFields: ["window.label", "displayedStats.winRatioLabel", "title", "featuredResult", "miniResults"],
      paywallFields: ["window.label", "displayedStats.winRatioLabel", "paywallChart", "featuredResult"],
      hiddenFields: ["diagnostics", "selectionRule", "totalStats.totalReturnPct", "totalStats.winRatePct"],
    },
    diagnostics: {
      source: "generated_signal_pairs",
      dedupeKey: "condition_id:selected_outcome",
      totalRowsScanned: rows.length,
      uniqueResolvedInWindow: weekAll.length,
      excludedPushCount: totalPush,
      excludedOverLossLimitCount: weekExcludedOverLoss,
      excludedMissingOddsCount: 0,
      sortedBy: "marketActivityScore_desc_resolvedAt_desc",
      generatedAt: weekEndedAt,
    },
  };

  // ── Validation ────────────────────────────────────────────────────────────
  const validationErrors: string[] = [];
  if (weekResultsCard.cardType !== "signal-week-results")
    validationErrors.push("cardType mismatch");
  if (weekResultsCard.displayedStats.displayedCount > 7)
    validationErrors.push("displayedCount > 7");
  if (weekResultsCard.displayedStats.displayedLost > 2)
    validationErrors.push("displayedLost > 2");
  if (weekResultsCard.displayedStats.displayedPush !== 0)
    validationErrors.push("displayedPush !== 0");
  if (weekResultsCard.miniResults.length !== weekResultsCard.displayedStats.displayedCount)
    validationErrors.push("miniResults.length !== displayedCount");
  if (weekResultsCard.totalStats.resolvedCount < weekResultsCard.displayedStats.displayedCount)
    validationErrors.push("totalResolved < displayedCount");
  if (!weekResultsCard.diagnostics.generatedAt)
    validationErrors.push("generatedAt missing");
  for (const r of weekResultsCard.miniResults) {
    if (r.americanOdds === undefined || r.europeanOdds === undefined)
      validationErrors.push(`miniResult ${r.id}: undefined odds`);
  }
  // paywallChart checks
  if (weekResultsCard.paywallChart.chartType !== "cumulative-return")
    validationErrors.push("paywallChart.chartType mismatch");
  if (weekResultsCard.paywallChart.source !== "displayed_subset")
    validationErrors.push("paywallChart.source mismatch");
  if (weekResultsCard.paywallChart.points.length !== weekResultsCard.displayedStats.displayedCount)
    validationErrors.push("paywallChart.points.length !== displayedCount");
  if (weekResultsCard.paywallChart.points.length !== weekResultsCard.miniResults.length)
    validationErrors.push("paywallChart.points.length !== miniResults.length");
  if (weekResultsCard.paywallChart.points.length === 0 && weekResultsCard.paywallChart.finalReturnPct !== null)
    validationErrors.push("paywallChart.finalReturnPct should be null when no points");
  if (weekResultsCard.paywallChart.points.length > 0) {
    const lastPt = weekResultsCard.paywallChart.points[weekResultsCard.paywallChart.points.length - 1];
    if (weekResultsCard.paywallChart.finalReturnPct !== lastPt.cumulativeReturnPct)
      validationErrors.push("paywallChart.finalReturnPct !== last point cumulativeReturnPct");
  }
  for (const pt of weekResultsCard.paywallChart.points) {
    if (pt.index < 1) validationErrors.push(`paywallChart point index < 1`);
    if (pt.result !== "won" && pt.result !== "lost") validationErrors.push(`paywallChart point result not won/lost`);
    if (!Number.isFinite(pt.returnPct)) validationErrors.push(`paywallChart point non-finite returnPct`);
    if (!Number.isFinite(pt.cumulativeReturnPct)) validationErrors.push(`paywallChart point non-finite cumulativeReturnPct`);
    if (pt.americanOdds === undefined || pt.europeanOdds === undefined)
      validationErrors.push(`paywallChart point ${pt.index}: undefined odds`);
  }
  // avgReturnPct must not exist in totalStats
  if ("avgReturnPct" in weekResultsCard.totalStats)
    validationErrors.push("totalStats.avgReturnPct must not exist");

  if (validationErrors.length > 0) {
    console.error("[weekResultsCard] Validation failed:", validationErrors);
    return NextResponse.json(
      { ok: false, error: "WEEK_RESULTS_CARD_VALIDATION_FAILED", validationErrors },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
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
