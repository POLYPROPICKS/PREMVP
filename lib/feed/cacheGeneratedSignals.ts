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

/**
 * Write generated signal pairs to cache
 */
export async function writeGeneratedSignalPairs(
  input: WritePairsInput
): Promise<number> {
  const rows = input.pairs.map((pair) => ({
    source: input.source,
    formula_version: input.formulaVersion,
    event_slug: pair.premiumSignal.eventTitle,
    market_slug: pair.marketSource.headline,
    condition_id: pair.diagnostics.conditionId,
    selected_outcome: pair.diagnostics.selectedOutcome,
    premium_signal: pair.premiumSignal,
    market_source: pair.marketSource,
    diagnostics: pair.diagnostics,
    score: null, // score field doesn't exist on diagnostics
    expires_at: input.expiresAt,
  }));

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
