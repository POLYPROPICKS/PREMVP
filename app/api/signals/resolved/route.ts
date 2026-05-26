// GET /api/signals/resolved
// Read-only. Returns deduped resolved signals for landing carousel.
// mode=latest: last N days, max 7 cards, max 1 lost, no push/refund/tie.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const INTERNAL_FETCH_LIMIT = 200;
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
const LATEST_MAX_CARDS = 7;
const LATEST_MAX_LOST = 1;
const LATEST_DEFAULT_DAYS = 7;

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

  // Fallback: snapshotRows
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

  // Build query — for latest mode, constrain to date window at DB level
  let query = supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, resolved_at, condition_id, selected_outcome, winning_outcome, " +
      "signal_result, realized_return_pct, metric_formula_version, entry_price_num, " +
      "premium_signal, diagnostics"
    )
    .not("signal_result", "is", null)
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
            selectionRule: "last_7d_highest_activity_max_one_loss",
          }),
        },
        signals: [],
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

  let signals = allSignals;

  if (isLatestMode) {
    // Exclude push/refund/tie/void
    signals = signals.filter((s) => !PUSH_RESULTS.has(s.result));

    // Sort by marketActivityScore desc, then resolvedAt desc
    signals.sort((a, b) => {
      const scoreDiff = (b.marketActivityScore ?? 0) - (a.marketActivityScore ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime();
    });

    // Apply founder rules: max 7 total, max 1 lost
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
          selectionRule: "last_7d_highest_activity_max_one_loss",
        }),
      },
      signals,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
