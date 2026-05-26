// GET /api/signals/resolved
// Read-only. Returns deduped resolved signals for landing carousel.
// Dedupe key: condition_id + selected_outcome (earliest snapshot = representative).

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const INTERNAL_FETCH_LIMIT = 200;
const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 25;

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

  const { data: rows, error: queryError } = await supabase
    .from("generated_signal_pairs")
    .select(
      "id, created_at, resolved_at, condition_id, selected_outcome, winning_outcome, " +
      "signal_result, realized_return_pct, metric_formula_version, entry_price_num, " +
      "premium_signal, diagnostics"
    )
    .not("signal_result", "is", null)
    .order("resolved_at", { ascending: false })
    .limit(INTERNAL_FETCH_LIMIT);

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
    signalConfidence: number | null;
    trustMetrics: { smartMoney: number | null; whaleVsPublicMoney: number | null; preEventScoreAI: number | null };
    snapshotRows: number;
    firstSignalCreatedAt: string;
    lastSignalCreatedAt: string;
    resolvedAt: string;
    metricFormulaVersion: string | null;
  }

  const signals: ResolvedSignal[] = [];
  let wonCount = 0, lostCount = 0, pushCount = 0;

  for (const [, group] of groups) {
    // sort by created_at asc — first snapshot = representative
    group.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const rep = group[0];
    const lastRow = group[group.length - 1];

    // resolved_at: latest non-null across group
    const resolvedAt =
      group
        .map((r) => r.resolved_at)
        .filter(Boolean)
        .sort()
        .reverse()[0] ?? rep.resolved_at ?? rep.created_at;

    const result = rep.signal_result ?? "unknown";
    if (result === "won") wonCount++;
    else if (result === "lost") lostCount++;
    else if (result === "push") pushCount++;

    signals.push({
      id: rep.id,
      conditionId: rep.condition_id ?? "",
      eventTitle: extractEventTitle(rep),
      pick: rep.selected_outcome ?? "",
      winner: rep.winning_outcome ?? "",
      result,
      returnPct: rep.realized_return_pct ?? null,
      entryPrice: rep.entry_price_num ?? null,
      europeanOdds: europeanOdds(rep.entry_price_num ?? null),
      signalConfidence: extractConfidence(rep),
      trustMetrics: extractTrustMetrics(rep),
      snapshotRows: group.length,
      firstSignalCreatedAt: rep.created_at,
      lastSignalCreatedAt: lastRow.created_at,
      resolvedAt,
      metricFormulaVersion: rep.metric_formula_version ?? null,
    });
  }

  // Sort by resolvedAt desc, then apply limit
  signals.sort((a, b) => new Date(b.resolvedAt).getTime() - new Date(a.resolvedAt).getTime());
  const paginated = signals.slice(0, limit);

  return NextResponse.json(
    {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        uniqueResolved: signals.length,
        snapshotRows: rows.length,
        won: wonCount,
        lost: lostCount,
        push: pushCount,
        sampleSizeStatus: "early",
        showPerformanceClaim: false,
        message: "Tracking is live. Early sample, not performance guarantee.",
      },
      signals: paginated,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
