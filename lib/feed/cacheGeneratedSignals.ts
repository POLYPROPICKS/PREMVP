// Cache layer for generated signal pairs
// Handles read/write operations to Supabase generated_signal_pairs and job_runs tables

import { supabaseAdmin } from "@/lib/supabase/server";
import { PremiumSignal, MarketSource, LandingCardDiagnostics } from "./types";

export interface CachedSignalPair {
  id?: string;
  premiumSignal: PremiumSignal;
  marketSource: MarketSource;
  marketSources?: MarketSource[];
  diagnostics: LandingCardDiagnostics;
  score?: number;
  createdAt?: string;
  expiresAt?: string;
}

export interface JobRunInput {
  source: string;
  formulaVersion: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "empty" | "error";
  generatedCount: number;
  rejectedCount: number;
  durationMs: number;
  errorMessage?: string;
  diagnostics?: Record<string, unknown>;
}

export interface WritePairsInput {
  pairs: Array<{
    premiumSignal: PremiumSignal;
    marketSource: MarketSource;
    marketSources?: MarketSource[];
    diagnostics: LandingCardDiagnostics;
  }>;
  source: string;
  formulaVersion: string;
  expiresAt: string;
}

/**
 * Read latest non-expired generated signal pairs from cache
 */
export async function readLatestGeneratedSignalPairs(
  limit: number
): Promise<CachedSignalPair[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select("id, premium_signal, market_source, diagnostics, score, created_at, expires_at")
    .gt("expires_at", new Date().toISOString())
    // Exclude shadow research rows (metric_formula_version LIKE 'shadow-%').
    // OR preserves legacy production rows where metric_formula_version IS NULL.
    .or("metric_formula_version.is.null,metric_formula_version.not.like.shadow-%")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read cached signal pairs: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return [];
  }

  return data.map((row) => ({
    id: row.id,
    premiumSignal: row.premium_signal as PremiumSignal,
    marketSource: row.market_source as MarketSource,
    diagnostics: row.diagnostics as LandingCardDiagnostics,
    score: row.score ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

// Parses a percent string like "+38%" or "-5.5%" to a number (38, -5.5).
// Returns null for unparseable input.
function parsePercentLikeNumber(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const match = raw.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return isNaN(n) ? null : n;
}

// Returns the numeric value of the first metric whose label contains `keyword` (case-insensitive).
function findMetricValue(
  metrics: Array<{ label: string; value: number }> | undefined | null,
  keyword: string
): number | null {
  if (!metrics) return null;
  const kw = keyword.toLowerCase();
  const found = metrics.find((m) => m.label.toLowerCase().includes(kw));
  return found != null ? found.value : null;
}

/**
 * Write generated signal pairs to cache
 */
export async function writeGeneratedSignalPairs(
  input: WritePairsInput
): Promise<number> {
  const rows = input.pairs.map((pair) => {
    const { premiumSignal: ps, diagnostics: diag } = pair;

    // --- immutable point-in-time performance snapshot ---
    const selectedTokenId = diag.selectedTokenId ?? null;
    const entryPriceNum =
      typeof diag.currentPrice === "number" ? diag.currentPrice : null;
    const signalConfidenceNum =
      typeof ps.winProbability === "number" ? ps.winProbability : null;
    const expectedReturnPctNum = parsePercentLikeNumber(ps.profit);
    const trustMetrics =
      Array.isArray(ps.metrics) && ps.metrics.length > 0 ? ps.metrics : null;
    const smartMoneyScoreNum = findMetricValue(ps.metrics, "smart money");
    const whalePublicScoreNum =
      findMetricValue(ps.metrics, "whale") ??
      findMetricValue(ps.metrics, "public");
    const preEventScoreNum = findMetricValue(ps.metrics, "pre");

    return {
      source: input.source,
      formula_version: input.formulaVersion,
      event_slug: ps.eventTitle,
      market_slug: pair.marketSource.headline,
      condition_id: diag.conditionId,
      selected_outcome: diag.selectedOutcome,
      premium_signal: ps,
      market_source: pair.marketSource,
      market_sources: pair.marketSources ?? null,
      diagnostics: diag,
      score: null, // score field doesn't exist on diagnostics
      expires_at: input.expiresAt,
      // performance snapshot columns
      selected_token_id: selectedTokenId,
      entry_price_num: entryPriceNum,
      signal_confidence_num: signalConfidenceNum,
      expected_return_pct_num: expectedReturnPctNum,
      trust_metrics: trustMetrics,
      smart_money_score_num: smartMoneyScoreNum,
      whale_public_score_num: whalePublicScoreNum,
      pre_event_score_num: preEventScoreNum,
      // result columns — unpopulated; filled by future resolver
      signal_result: null,
      resolved_at: null,
      winning_outcome: null,
      realized_return_pct: null,
      metric_formula_version: "v2-lite-growth-safe",
    };
  });

  const { error, count } = await supabaseAdmin
    .from("generated_signal_pairs")
    .insert(rows);

  if (error) {
    throw new Error(`Failed to write signal pairs: ${error.message}`);
  }

  return count ?? rows.length;
}

/**
 * Write job run record to track generation attempts
 */
export async function writeJobRun(input: JobRunInput): Promise<void> {
  const { error } = await supabaseAdmin.from("job_runs").insert({
    source: input.source,
    formula_version: input.formulaVersion,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    status: input.status,
    generated_count: input.generatedCount,
    rejected_count: input.rejectedCount,
    duration_ms: input.durationMs,
    error_message: input.errorMessage ?? null,
    diagnostics: input.diagnostics ?? null,
  });

  if (error) {
    throw new Error(`Failed to write job run: ${error.message}`);
  }
}
