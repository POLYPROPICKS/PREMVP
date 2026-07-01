// GET /api/signals/resolved
// Read-only. Returns deduped resolved signals for landing carousel.
// mode=latest: last N days, max 7 cards, max 1 lost, no push/refund/tie.
// Also exposes weekResultsCard — global weekly proof data contract (no UI rendered here).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { WeekResultsCard, TrackRecordRow } from "@/components/signal-week-results/types";

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

// ── Projected published-signal track record (weekResultsCard v2) ─────────────
// Source: generated_signal_pairs_latest_daily_match_quality_real_odds.
// Independent of the resolved-signal carousel above: uses ALL published rows
// (no signal_result filter), latest daily batch, signalKey+matchKey deduped,
// top-6-of-10 quality filtered, real market odds only.

const STAKE_USD = 100;
const QUALITY_BLOCK_SIZE = 10;
const QUALITY_KEEP_PER_BLOCK = 6;

export type OddsSource = "diagnostics.currentPrice" | "entry_price_num" | "expected_return_pct_num";

export interface RawPairRow {
  id: string;
  created_at: string;
  event_slug: string | null;
  market_slug: string | null;
  selected_outcome: string | null;
  premium_signal: unknown;
  diagnostics: unknown;
  entry_price_num: number | null;
  expected_return_pct_num: number | null;
}

export interface ProjectedSignal {
  id: string;
  createdAt: string;
  eventTitle: string;
  marketQuestion: string;
  pick: string;
  signalKey: string;
  matchKey: string;
  projectedWinProbability: number; // 0..1
  marketPrice: number | null;
  priceSource: OddsSource | null;
  decimalOdds: number | null;
  pnlUnits: number | null;
}

export function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

export function buildSignalKey(eventTitle: string, marketQuestion: string, position: string): string {
  return `${normalizeKey(eventTitle)}|${normalizeKey(marketQuestion)}|${normalizeKey(position)}`;
}

export function buildMatchKey(
  eventTitle: string,
  eventSlug: string | null,
  marketSlug: string | null
): string {
  const primary = normalizeKey(eventTitle);
  if (primary) return primary;
  return normalizeKey(eventSlug) || normalizeKey(marketSlug);
}

/** Score priority: displaySignalConfidence, rawSignalScore, signalConfidence,
 *  confidence, winProbability, score. Normalize >1 as /100, clamp 0..1. */
export function extractProjectedScore(row: RawPairRow): number | null {
  const ps = row.premium_signal as Record<string, unknown> | null;
  const raw =
    safeNum(ps?.displaySignalConfidence) ??
    safeNum(ps?.rawSignalScore) ??
    safeNum(ps?.signalConfidence) ??
    safeNum(ps?.confidence) ??
    safeNum(ps?.winProbability) ??
    safeNum(ps?.score);
  if (raw === null) return null;
  const normalized = raw > 1 ? raw / 100 : raw;
  return Math.min(1, Math.max(0, normalized));
}

function parsePercentLikeNumber(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = raw.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Market price priority: diagnostics.currentPrice, entry_price_num, then a
 *  persisted profit / expected_return_pct_num conversion. Never premium_signal.price. */
export function extractMarketPriceInfo(
  row: RawPairRow
): { price: number; source: OddsSource } | null {
  const dx = row.diagnostics as Record<string, unknown> | null;
  const dxPrice = safeNum(dx?.currentPrice);
  if (dxPrice !== null && dxPrice > 0 && dxPrice < 1) {
    return { price: dxPrice, source: "diagnostics.currentPrice" };
  }

  const entryPrice = row.entry_price_num;
  if (typeof entryPrice === "number" && Number.isFinite(entryPrice) && entryPrice > 0 && entryPrice < 1) {
    return { price: entryPrice, source: "entry_price_num" };
  }

  const ps = row.premium_signal as Record<string, unknown> | null;
  const expectedReturnPct = row.expected_return_pct_num ?? parsePercentLikeNumber(ps?.profit);
  if (expectedReturnPct !== null && Number.isFinite(expectedReturnPct) && expectedReturnPct > 0) {
    const price = 100 / (expectedReturnPct + 100);
    if (price > 0 && price < 1) {
      return { price, source: "expected_return_pct_num" };
    }
  }

  return null;
}

export function computeDecimalOdds(marketPrice: number): number {
  return 1 / marketPrice;
}

/** pnlUnits = p * (decimalOdds - 1) - (1 - p), flat $100 stake model. */
export function computePnlUnits(winProbability: number, decimalOdds: number): number {
  return winProbability * (decimalOdds - 1) - (1 - winProbability);
}

export function utcDayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** latest_batch_at = max(created_at) per UTC calendar day; keep only rows
 *  whose created_at equals that day's max. */
export function filterLatestBatchPerDay<T extends { createdAt: string }>(rows: T[]): T[] {
  const maxByDay = new Map<string, string>();
  for (const r of rows) {
    const day = utcDayKey(r.createdAt);
    const cur = maxByDay.get(day);
    if (!cur || r.createdAt > cur) maxByDay.set(day, r.createdAt);
  }
  return rows.filter((r) => r.createdAt === maxByDay.get(utcDayKey(r.createdAt)));
}

/** Deduplicate by signalKey within each UTC day; latest createdAt wins ties. */
export function dedupeBySignalKeyPerDay<T extends { signalKey: string; createdAt: string }>(
  rows: T[]
): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    const key = `${utcDayKey(r.createdAt)}::${r.signalKey}`;
    const existing = seen.get(key);
    if (!existing || r.createdAt > existing.createdAt) seen.set(key, r);
  }
  return [...seen.values()];
}

/** Select one best signal per matchKey within each UTC day: highest
 *  projectedWinProbability, then latest createdAt, then stable signalKey tiebreak. */
export function dedupeByMatchKeyPerDay<
  T extends { matchKey: string; signalKey: string; createdAt: string; projectedWinProbability: number }
>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    const key = `${utcDayKey(r.createdAt)}::${r.matchKey}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, r);
      continue;
    }
    if (r.projectedWinProbability > existing.projectedWinProbability) {
      seen.set(key, r);
    } else if (r.projectedWinProbability === existing.projectedWinProbability) {
      if (r.createdAt > existing.createdAt) {
        seen.set(key, r);
      } else if (r.createdAt === existing.createdAt && r.signalKey < existing.signalKey) {
        seen.set(key, r);
      }
    }
  }
  return [...seen.values()];
}

/** Rank all rows by projectedWinProbability desc; keep the top 6 of every
 *  block of 10 ranked signals (slotIn10 <= 6). */
export function applyTopSixOfTenFilter<T extends { projectedWinProbability: number }>(rows: T[]): T[] {
  const ranked = [...rows].sort((a, b) => b.projectedWinProbability - a.projectedWinProbability);
  return ranked.filter((_, i) => (i % QUALITY_BLOCK_SIZE) + 1 <= QUALITY_KEEP_PER_BLOCK);
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export interface ProjectedTrackRecordResult {
  ok: true;
  selectedSignals: number;
  oddsCoveragePct: number;
  oddsSourceBreakdown: Record<string, number>;
  projectedWinRatePct: number;
  avgDecimalOdds: number;
  projectedPnlUnits: number;
  projectedReturnUsd: number;
  projectedRoiPct: number;
  rows: ProjectedSignal[];
  latestBatchRows: number;
  signalDedupedCount: number;
  matchDedupedCount: number;
}

export interface ProjectedTrackRecordMissingOdds {
  ok: false;
  reason: "MISSING_MARKET_PRICE";
  row: { id: string; eventTitle: string; marketQuestion: string; pick: string; createdAt: string };
}

/** Full pipeline: latest-batch-per-day -> signalKey dedupe -> matchKey dedupe
 *  -> top-6-of-10 quality filter -> real odds + PnL. STOPs if any selected
 *  row is missing a resolvable market price. */
export function computeProjectedTrackRecord(
  rawRows: RawPairRow[]
): ProjectedTrackRecordResult | ProjectedTrackRecordMissingOdds {
  const withCreatedAt = rawRows.map((row) => {
    const ps = row.premium_signal as Record<string, unknown> | null;
    const dx = row.diagnostics as Record<string, unknown> | null;
    const eventTitle =
      safeStr(ps?.eventTitle) ?? safeStr(row.event_slug) ?? safeStr(dx?.eventTitle) ?? "Unknown market";
    const marketQuestion = safeStr(dx?.marketQuestion) ?? safeStr(row.market_slug) ?? "";
    const pick =
      safeStr(ps?.positionDisplay) ?? safeStr(ps?.position) ?? safeStr(row.selected_outcome) ?? "";

    const priceInfo = extractMarketPriceInfo(row);
    const score = extractProjectedScore(row) ?? 0;
    const decimalOdds = priceInfo ? computeDecimalOdds(priceInfo.price) : null;
    const pnlUnits = decimalOdds !== null ? computePnlUnits(score, decimalOdds) : null;

    const projected: ProjectedSignal = {
      id: row.id,
      createdAt: row.created_at,
      eventTitle,
      marketQuestion,
      pick,
      signalKey: buildSignalKey(eventTitle, marketQuestion, pick),
      matchKey: buildMatchKey(eventTitle, row.event_slug, row.market_slug),
      projectedWinProbability: score,
      marketPrice: priceInfo?.price ?? null,
      priceSource: priceInfo?.source ?? null,
      decimalOdds,
      pnlUnits,
    };
    return projected;
  });

  const latestBatchRows = filterLatestBatchPerDay(withCreatedAt);
  const signalDeduped = dedupeBySignalKeyPerDay(latestBatchRows);
  const matchDeduped = dedupeByMatchKeyPerDay(signalDeduped);
  const selected = applyTopSixOfTenFilter(matchDeduped);

  const missing = selected.find((s) => s.marketPrice === null || s.decimalOdds === null);
  if (missing) {
    return {
      ok: false,
      reason: "MISSING_MARKET_PRICE",
      row: {
        id: missing.id,
        eventTitle: missing.eventTitle,
        marketQuestion: missing.marketQuestion,
        pick: missing.pick,
        createdAt: missing.createdAt,
      },
    };
  }

  const selectedSignals = selected.length;
  const oddsSourceBreakdown: Record<string, number> = {};
  for (const s of selected) {
    const key = s.priceSource as string;
    oddsSourceBreakdown[key] = (oddsSourceBreakdown[key] ?? 0) + 1;
  }

  const withPrice = selected.filter((s) => s.marketPrice !== null).length;
  const oddsCoveragePct = selectedSignals > 0 ? round((withPrice / selectedSignals) * 100, 2) : 0;

  const sumPnlUnits = selected.reduce((sum, s) => sum + (s.pnlUnits ?? 0), 0);
  const avgDecimalOdds =
    selectedSignals > 0
      ? round(selected.reduce((sum, s) => sum + (s.decimalOdds ?? 0), 0) / selectedSignals, 3)
      : 0;
  const projectedWinRatePct =
    selectedSignals > 0
      ? round((selected.reduce((sum, s) => sum + s.projectedWinProbability, 0) / selectedSignals) * 100, 2)
      : 0;
  const projectedPnlUnits = round(sumPnlUnits, 4);
  const projectedReturnUsd = round(projectedPnlUnits * STAKE_USD, 2);
  const projectedRoiPct = selectedSignals > 0 ? round((projectedPnlUnits / selectedSignals) * 100, 2) : 0;

  return {
    ok: true,
    selectedSignals,
    oddsCoveragePct,
    oddsSourceBreakdown,
    projectedWinRatePct,
    avgDecimalOdds,
    projectedPnlUnits,
    projectedReturnUsd,
    projectedRoiPct,
    rows: selected,
    latestBatchRows: latestBatchRows.length,
    signalDedupedCount: signalDeduped.length,
    matchDedupedCount: matchDeduped.length,
  };
}

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
// Projected published-signal track record. Not tied to activePair / MarketSourceCard.
// Contract lives in components/signal-week-results/types.ts (shared with the UI).

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

  // ── weekResultsCard: published-signal projected track record ────────────────
  // Independent of the resolved-signal carousel below. Uses ALL published rows
  // (no signal_result filter) in the window, regardless of resolution status.
  const trackWindowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: trackRawRows, error: trackQueryError } = await supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, event_slug, market_slug, selected_outcome, " +
      "premium_signal, diagnostics, entry_price_num, expected_return_pct_num"
    )
    .gte("created_at", trackWindowStart)
    // Exclude shadow research rows; preserve legacy rows where metric_formula_version IS NULL.
    .or("metric_formula_version.is.null,metric_formula_version.not.like.shadow-%")
    .order("created_at", { ascending: false })
    .limit(INTERNAL_FETCH_LIMIT);

  if (trackQueryError) {
    return NextResponse.json(
      { ok: false, error: "DB_QUERY_ERROR", detail: trackQueryError.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const rawTrackRows = ((trackRawRows ?? []) as unknown) as RawPairRow[];
  const trackResult = computeProjectedTrackRecord(rawTrackRows);

  console.log("[weekResultsCard]", {
    windowDays,
    rawRows: rawTrackRows.length,
    ...(trackResult.ok
      ? {
          latestBatchRows: trackResult.latestBatchRows,
          signalDedupedCount: trackResult.signalDedupedCount,
          matchDedupedCount: trackResult.matchDedupedCount,
          selectedSignals: trackResult.selectedSignals,
          oddsCoveragePct: trackResult.oddsCoveragePct,
          oddsSourceBreakdown: trackResult.oddsSourceBreakdown,
          projectedRoiPct: trackResult.projectedRoiPct,
        }
      : { reason: trackResult.reason, row: trackResult.row }),
  });

  if (!trackResult.ok) {
    return NextResponse.json(
      { ok: false, error: "MISSING_MARKET_PRICE", row: trackResult.row },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  const trackRecordRows: TrackRecordRow[] = trackResult.rows
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((s) => ({
      id: s.id,
      eventTitle: s.eventTitle,
      marketQuestion: s.marketQuestion,
      pick: s.pick,
      createdAt: s.createdAt,
      marketPrice: s.marketPrice as number,
      priceSource: s.priceSource as TrackRecordRow["priceSource"],
      decimalOdds: s.decimalOdds as number,
      projectedWinProbabilityPct: round(s.projectedWinProbability * 100, 2),
      pnlUnits: round(s.pnlUnits ?? 0, 2),
      projectedReturnUsd: round((s.pnlUnits ?? 0) * STAKE_USD, 2),
      status: "Published",
    }));

  let trackSampleSizeStatus: "empty" | "early" | "active" | "enough_data";
  if (trackResult.selectedSignals === 0) trackSampleSizeStatus = "empty";
  else if (trackResult.selectedSignals < 3) trackSampleSizeStatus = "early";
  else if (trackResult.selectedSignals < 10) trackSampleSizeStatus = "active";
  else trackSampleSizeStatus = "enough_data";

  const weekResultsCard: WeekResultsCard = {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v2-projected",
    source: "generated_signal_pairs_latest_daily_match_quality_real_odds",
    window: {
      label: `Past ${windowDays} days`,
      days: windowDays,
      startedAt: trackWindowStart,
      endedAt: new Date().toISOString(),
    },
    title: "Signals published this window",
    subtitle: "Flat $100 stake model",
    sampleSizeStatus: trackSampleSizeStatus,
    selectedSignals: trackResult.selectedSignals,
    oddsCoveragePct: trackResult.oddsCoveragePct,
    oddsSourceBreakdown: trackResult.oddsSourceBreakdown,
    projectedWinRatePct: trackResult.projectedWinRatePct,
    avgDecimalOdds: trackResult.avgDecimalOdds,
    projectedPnlUnits: trackResult.projectedPnlUnits,
    projectedReturnUsd: trackResult.projectedReturnUsd,
    projectedRoiPct: trackResult.projectedRoiPct,
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
