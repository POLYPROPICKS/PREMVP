#!/usr/bin/env -S node --import tsx
// Automated read-only Supabase export runner for generated_signal_pairs
// (Phase 3D.2Ob).
//
// Reads the latest resolved generated_signal_pairs rows directly from
// Supabase (read-only select), normalizes schema drift in code, and writes
// a local JSON export file in the same shape the existing dedup comparison
// CLI (run-readonly-comparison.ts) expects.
//
// This module does NOT:
//   - write to the database (no insert/update/delete/upsert/rpc)
//   - log environment variable values or raw row payloads
//   - compute ROI/PnL/profit
//   - install any package (uses the repo's existing @supabase/supabase-js
//     dependency and the existing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//     env convention from lib/supabase/server.ts)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const TABLE_NAME = "generated_signal_pairs";

const DEFAULT_OUTPUT_PATH = path.join(
  "modeling",
  "local_exports",
  "generated_signal_pairs_export.json",
);

const DEFAULT_LIMIT = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstDefined<T>(...values: T[]): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Normalizes a single raw generated_signal_pairs row (as returned by
 * `select("*")`) into the export shape run-readonly-comparison.ts expects.
 * Does not mutate the input row. Does not compute or add any ROI/PnL field
 * -- fields like real_pnl_usd/realized_return_pct are passed through only
 * if already present on the source row.
 */
export function normalizeGeneratedSignalPairRow(row: Record<string, unknown>): Record<string, unknown> {
  const diagnostics = isPlainObject(row.diagnostics) ? row.diagnostics : undefined;

  const tokenId = firstDefined(
    row.token_id,
    row.selected_token_id,
    diagnostics ? (diagnostics as Record<string, unknown>).selectedTokenId : undefined,
  );

  const entryPriceNum = firstDefined(
    row.entry_price_num,
    row.entry_price,
    diagnostics ? (diagnostics as Record<string, unknown>).entryPrice : undefined,
  );

  const score = firstDefined(row.score, row.signal_score, row.pre_event_score_num);

  const coverage = firstDefined(row.coverage, row.coverage_score);

  const normalized: Record<string, unknown> = {
    id: row.id,
    condition_id: row.condition_id,
    token_id: tokenId,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    formula_version: row.formula_version,
    metric_formula_version: row.metric_formula_version,
    score,
    signal_score: row.signal_score,
    pre_event_score_num: row.pre_event_score_num,
    coverage,
    coverage_score: row.coverage_score,
    signal_result: row.signal_result,
    result: row.result,
    outcome_status: row.outcome_status,
    winning_outcome: row.winning_outcome,
    selected_outcome: row.selected_outcome,
    entry_price_num: entryPriceNum,
    realized_return_pct: row.realized_return_pct,
    real_pnl_usd: row.real_pnl_usd,
    match_family_key: row.match_family_key,
    canonical_event_key: row.canonical_event_key,
    parent_event_key: row.parent_event_key,
    event_slug: row.event_slug,
    event_title: row.event_title,
    market_slug: row.market_slug,
    league: row.league,
    hours_until_start: row.hours_until_start,
    diagnostics,
  };

  for (const key of Object.keys(normalized)) {
    if (normalized[key] === undefined) {
      delete normalized[key];
    }
  }

  return normalized;
}

export interface SupabaseReadConfig {
  url: string;
  key: string;
}

/**
 * Resolves the repo's existing read-only Supabase env convention
 * (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, see lib/supabase/server.ts).
 * Throws a safe Error naming any missing variable names -- never their
 * values -- when config is missing.
 */
export function resolveSupabaseReadConfig(env: NodeJS.ProcessEnv = process.env): SupabaseReadConfig {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing Supabase read config: ${missing.join(", ")}`);
  }

  return { url: url as string, key: key as string };
}

export interface ExportGeneratedSignalPairsOptions {
  client?: SupabaseClient;
  outputPath?: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExportGeneratedSignalPairsResult {
  outputPath: string;
  rows: number;
  limit: number;
}

/**
 * Fetches the latest resolved generated_signal_pairs rows (read-only
 * select, resolved_at not null, ordered by resolved_at descending, limited
 * to `limit`), normalizes each row, and writes the result as a JSON array
 * to `outputPath`. Never writes to the database.
 */
export async function exportGeneratedSignalPairsFromSupabase(
  options: ExportGeneratedSignalPairsOptions = {},
): Promise<ExportGeneratedSignalPairsResult> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const client =
    options.client ??
    (() => {
      const config = resolveSupabaseReadConfig(options.env ?? process.env);
      return createClient(config.url, config.key, { auth: { persistSession: false } });
    })();

  const { data, error } = await client
    .from(TABLE_NAME)
    .select("*")
    .not("resolved_at", "is", null)
    .order("resolved_at", { ascending: false })
    .limit(limit);

  if (error) {
    const message = typeof error === "object" && error !== null && "message" in error ? String((error as { message: unknown }).message) : "unknown Supabase read error";
    throw new Error(`Supabase read failed: ${message}`);
  }

  const rawRows = Array.isArray(data) ? data : [];
  const normalizedRows = rawRows.map((row) => normalizeGeneratedSignalPairRow(row as Record<string, unknown>));

  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, `${JSON.stringify(normalizedRows, null, 2)}\n`, "utf8");

  return { outputPath, rows: normalizedRows.length, limit };
}

interface ParsedArgs {
  output: string;
  limit: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { output: DEFAULT_OUTPUT_PATH, limit: DEFAULT_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    } else if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.limit = value;
      }
      i += 1;
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const args = parseArgs(process.argv.slice(2));

  try {
    const result = await exportGeneratedSignalPairsFromSupabase({
      outputPath: args.output,
      limit: args.limit,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    fail(message);
  }
}

if (require.main === module) {
  main();
}
