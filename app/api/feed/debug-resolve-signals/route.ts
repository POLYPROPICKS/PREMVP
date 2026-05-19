import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

type ResolverState =
  | "active_unresolved"
  | "closed_unknown"
  | "resolved_candidate"
  | "lookup_failed"
  | "invalid_snapshot";

interface DryRunItem {
  id: string;
  created_at: string | null;
  event_slug: string | null;
  condition_id: string;
  selected_outcome: string | null;
  selected_token_id: string | null;
  entry_price_num: number | null;
  gamma_question: string | null;
  gamma_slug: string | null;
  active: boolean | null;
  closed: boolean | null;
  archived: boolean | null;
  outcomes: string[] | null;
  outcomePrices: number[] | null;
  clobTokenIds: string[] | null;
  selectedOutcomeIndexByToken: number | null;
  candidateWinningOutcome: string | null;
  candidateWinningTokenId: string | null;
  resolverState: ResolverState;
  wouldSignalResult: "won" | "lost" | null;
  wouldRealizedReturnPct: number | null;
  skipReason: string | null;
}

function safeParseJsonArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function safeParseNumberArray(value: unknown): number[] | null {
  const arr = safeParseJsonArray(value);
  if (!arr) return null;
  const nums = arr.map((v) => parseFloat(String(v)));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

async function fetchGammaMarket(conditionId: string): Promise<Record<string, unknown> | null> {
  try {
    const url = `${GAMMA_API_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const arr = Array.isArray(data) ? data : Array.isArray(data?.markets) ? data.markets : null;
    return arr && arr.length > 0 ? (arr[0] as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveDryRun(
  conditionId: string,
  selectedOutcome: string | null,
  selectedTokenId: string | null,
  entryPriceNum: number | null,
  market: Record<string, unknown> | null,
): Omit<DryRunItem,
  | "id" | "created_at" | "event_slug" | "condition_id"
  | "selected_outcome" | "selected_token_id" | "entry_price_num"
> {
  if (!market) {
    return {
      gamma_question: null, gamma_slug: null,
      active: null, closed: null, archived: null,
      outcomes: null, outcomePrices: null, clobTokenIds: null,
      selectedOutcomeIndexByToken: null,
      candidateWinningOutcome: null, candidateWinningTokenId: null,
      resolverState: "lookup_failed",
      wouldSignalResult: null, wouldRealizedReturnPct: null,
      skipReason: `Gamma returned no market for conditionId=${conditionId}`,
    };
  }

  const closed = market.closed === true;
  const active = market.active === true;
  const archived = market.archived === true || false;
  const gamma_question = typeof market.question === "string" ? market.question : null;
  const gamma_slug = typeof market.slug === "string" ? market.slug : null;

  const outcomes = safeParseJsonArray(market.outcomes);
  const outcomePrices = safeParseNumberArray(market.outcomePrices);
  const clobTokenIds = safeParseJsonArray(market.clobTokenIds);

  // Compute token index from clobTokenIds regardless of resolverState
  const normalizedSelectedToken = selectedTokenId ? String(selectedTokenId).trim() : null;
  let selectedOutcomeIndexByToken: number | null = null;
  if (normalizedSelectedToken && clobTokenIds) {
    const idx = clobTokenIds.map(String).findIndex((t) => t.trim() === normalizedSelectedToken);
    if (idx !== -1) selectedOutcomeIndexByToken = idx;
  }

  if (!closed) {
    return {
      gamma_question, gamma_slug, active, closed, archived,
      outcomes, outcomePrices, clobTokenIds,
      selectedOutcomeIndexByToken,
      candidateWinningOutcome: null, candidateWinningTokenId: null,
      resolverState: "active_unresolved",
      wouldSignalResult: null, wouldRealizedReturnPct: null,
      skipReason: "Market is still open — not resolved yet",
    };
  }

  // Market is closed — attempt to identify winning outcome by price >= 0.99
  let winnerIndex: number | null = null;
  if (outcomePrices) {
    const highIdx = outcomePrices.findIndex((p) => p >= 0.99);
    const highCount = outcomePrices.filter((p) => p >= 0.99).length;
    if (highCount === 1) winnerIndex = highIdx;
  }

  if (winnerIndex === null) {
    return {
      gamma_question, gamma_slug, active, closed, archived,
      outcomes, outcomePrices, clobTokenIds,
      selectedOutcomeIndexByToken,
      candidateWinningOutcome: null, candidateWinningTokenId: null,
      resolverState: "closed_unknown",
      wouldSignalResult: null, wouldRealizedReturnPct: null,
      skipReason: "Market closed but no single outcome price >= 0.99 found",
    };
  }

  const candidateWinningOutcome = outcomes ? (outcomes[winnerIndex] ?? null) : null;
  const candidateWinningTokenId = clobTokenIds ? (clobTokenIds[winnerIndex] ?? null) : null;

  if (!selectedTokenId || !entryPriceNum || entryPriceNum <= 0 || entryPriceNum >= 1) {
    return {
      gamma_question, gamma_slug, active, closed, archived,
      outcomes, outcomePrices, clobTokenIds,
      selectedOutcomeIndexByToken,
      candidateWinningOutcome, candidateWinningTokenId,
      resolverState: "invalid_snapshot",
      wouldSignalResult: null, wouldRealizedReturnPct: null,
      skipReason: "Row missing selected_token_id or valid entry_price_num (0 < price < 1)",
    };
  }

  const won = selectedTokenId === candidateWinningTokenId;
  const wouldSignalResult: "won" | "lost" = won ? "won" : "lost";
  const wouldRealizedReturnPct = won
    ? Math.round(((1 - entryPriceNum) / entryPriceNum) * 10000) / 100
    : -100;

  return {
    gamma_question, gamma_slug, active, closed, archived,
    outcomes, outcomePrices, clobTokenIds,
    selectedOutcomeIndexByToken,
    candidateWinningOutcome, candidateWinningTokenId,
    resolverState: "resolved_candidate",
    wouldSignalResult, wouldRealizedReturnPct,
    skipReason: null,
  };
}

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = request.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? "10", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 25) : 10;

  // Read-only: select only, no writes
  const { data: rows, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id, created_at, event_slug, condition_id, selected_outcome, selected_token_id, entry_price_num")
    .is("signal_result", null)
    .not("condition_id", "is", null)
    .not("selected_token_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const items: DryRunItem[] = [];

  for (const row of rows ?? []) {
    const market = await fetchGammaMarket(row.condition_id as string);
    const resolved = resolveDryRun(
      row.condition_id as string,
      row.selected_outcome as string | null,
      row.selected_token_id as string | null,
      row.entry_price_num as number | null,
      market,
    );
    items.push({
      id: row.id as string,
      created_at: row.created_at as string | null,
      event_slug: row.event_slug as string | null,
      condition_id: row.condition_id as string,
      selected_outcome: row.selected_outcome as string | null,
      selected_token_id: row.selected_token_id as string | null,
      entry_price_num: row.entry_price_num as number | null,
      ...resolved,
    });
  }

  const stateCounts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.resolverState] = (acc[item.resolverState] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    mode: "dry-run",
    limit,
    count: items.length,
    summary: stateCounts,
    items,
  });
}
