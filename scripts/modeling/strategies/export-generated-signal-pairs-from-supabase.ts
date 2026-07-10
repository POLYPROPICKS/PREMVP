#!/usr/bin/env -S node --import tsx
// Automated read-only Supabase export runner for generated_signal_pairs
// (Phase 3D.2Ob, dataset-completeness hardened in Phase 3D.2P).
//
// Reads ALL resolved generated_signal_pairs rows directly from Supabase by
// default (read-only count + paginated select), normalizes schema drift in
// code, and writes a local JSON export file in the same shape the existing
// dedup comparison CLI (run-readonly-comparison.ts) expects.
//
// There is no default dataset cap. `pageSize` is a transport batch size
// only (default 1000) -- it does not limit the total number of rows
// fetched. `maxRows` is an optional, explicit debug-only cap; using it
// marks the export `exportMode: "DEBUG_CAPPED"` /
// `exportCompleteness: "INTENTIONALLY_CAPPED"` so it can never be mistaken
// for a full dataset in a downstream ROI/model-review gate.
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

const DEFAULT_PAGE_SIZE = 1000;

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
  /** Transport batch size only. Does NOT cap the dataset. Default 1000. */
  pageSize?: number;
  /** Explicit debug-only cap on total rows fetched. Never a default. */
  maxRows?: number;
  env?: NodeJS.ProcessEnv;
}

export type ExportMode = "FULL_RESOLVED" | "DEBUG_CAPPED";
export type ExportCompleteness = "COMPLETE" | "INTENTIONALLY_CAPPED" | "INCOMPLETE";

export interface ExportGeneratedSignalPairsResult {
  outputPath: string;
  availableResolvedRows: number;
  fetchedRows: number;
  targetRows: number;
  pageSize: number;
  pagesFetched: number;
  exportMode: ExportMode;
  exportCompleteness: ExportCompleteness;
  missingRows: number;
  requestedMaxRows?: number;
}

function extractErrorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "unknown Supabase read error";
}

/**
 * Fetches ALL resolved generated_signal_pairs rows by default (read-only
 * exact count, then paginated `.range()` reads, resolved_at not null,
 * ordered by resolved_at descending), normalizes each row, and writes the
 * result as a JSON array to `outputPath`. Never writes to the database.
 *
 * With no `maxRows`, `targetRows` is the exact available resolved-row
 * count and the export is reported COMPLETE only if every row was fetched.
 * With `maxRows`, the export is explicitly marked DEBUG_CAPPED /
 * INTENTIONALLY_CAPPED and must not be treated as a full dataset.
 */
export async function exportGeneratedSignalPairsFromSupabase(
  options: ExportGeneratedSignalPairsOptions = {},
): Promise<ExportGeneratedSignalPairsResult> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRows;

  const client =
    options.client ??
    (() => {
      const config = resolveSupabaseReadConfig(options.env ?? process.env);
      return createClient(config.url, config.key, { auth: { persistSession: false } });
    })();

  const countResult = await client
    .from(TABLE_NAME)
    .select("*", { count: "exact", head: true })
    .not("resolved_at", "is", null);

  if (countResult.error) {
    throw new Error(`Supabase read failed (count): ${extractErrorMessage(countResult.error)}`);
  }

  const availableResolvedRows = countResult.count ?? 0;
  const targetRows =
    maxRows !== undefined ? Math.min(maxRows, availableResolvedRows) : availableResolvedRows;

  const normalizedRows: Record<string, unknown>[] = [];
  let pagesFetched = 0;

  while (normalizedRows.length < targetRows) {
    const from = normalizedRows.length;
    const remaining = targetRows - from;
    const to = from + Math.min(pageSize, remaining) - 1;

    const { data, error } = await client
      .from(TABLE_NAME)
      .select("*")
      .not("resolved_at", "is", null)
      .order("resolved_at", { ascending: false })
      .range(from, to);

    if (error) {
      throw new Error(`Supabase read failed (page ${pagesFetched + 1}): ${extractErrorMessage(error)}`);
    }

    pagesFetched += 1;
    const pageRows = Array.isArray(data) ? data : [];
    for (const row of pageRows) {
      normalizedRows.push(normalizeGeneratedSignalPairRow(row as Record<string, unknown>));
    }

    if (pageRows.length === 0) {
      // Server returned no more rows -- stop even if targetRows was not
      // reached, so the loop cannot spin forever on a stalled stream.
      break;
    }
  }

  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outputPath, `${JSON.stringify(normalizedRows, null, 2)}\n`, "utf8");

  const fetchedRows = normalizedRows.length;
  const exportMode: ExportMode = maxRows !== undefined ? "DEBUG_CAPPED" : "FULL_RESOLVED";

  let exportCompleteness: ExportCompleteness;
  if (maxRows !== undefined) {
    exportCompleteness = "INTENTIONALLY_CAPPED";
  } else if (fetchedRows >= availableResolvedRows) {
    exportCompleteness = "COMPLETE";
  } else {
    exportCompleteness = "INCOMPLETE";
  }

  const missingRows =
    exportMode === "DEBUG_CAPPED" ? 0 : Math.max(0, availableResolvedRows - fetchedRows);

  return {
    outputPath,
    availableResolvedRows,
    fetchedRows,
    targetRows,
    pageSize,
    pagesFetched,
    exportMode,
    exportCompleteness,
    missingRows,
    ...(maxRows !== undefined ? { requestedMaxRows: maxRows } : {}),
  };
}

interface ParsedArgs {
  output: string;
  pageSize: number;
  maxRows?: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { output: DEFAULT_OUTPUT_PATH, pageSize: DEFAULT_PAGE_SIZE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      args.output = argv[i + 1] ?? DEFAULT_OUTPUT_PATH;
      i += 1;
    } else if (arg === "--page-size") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.pageSize = value;
      }
      i += 1;
    } else if (arg === "--max-rows") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.maxRows = value;
      }
      i += 1;
    } else if (arg === "--limit") {
      // Deprecated alias for --max-rows, kept for backward compatibility.
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.maxRows = value;
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
      pageSize: args.pageSize,
      maxRows: args.maxRows,
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
