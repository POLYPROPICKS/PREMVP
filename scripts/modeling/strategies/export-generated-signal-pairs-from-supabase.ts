#!/usr/bin/env -S node --import tsx
// Automated read-only Supabase export runner for generated_signal_pairs
// (Phase 3D.2Ob, dataset-completeness hardened in Phase 3D.2P, transport
// hardened for Windows in Phase 3E.2a, count dependency removed in Phase
// 3E.2b).
//
// Reads ALL resolved generated_signal_pairs rows directly from Supabase by
// default (paginated GET reads over the PostgREST REST API, no exact-count
// request), normalizes schema drift in code, and writes a local JSON
// export file in the same shape the existing dedup comparison CLI
// (run-readonly-comparison.ts) expects.
//
// Transport: this module talks to Supabase's PostgREST REST endpoint
// directly via the platform `fetch` (GET requests only, with a Range
// header for pagination). It deliberately does NOT depend on the
// @supabase/supabase-js client's count/head select path -- that path was
// observed to crash on Windows with a native libuv assertion failure. As
// of Phase 3E.2b it also does NOT make any request for an exact row total
// at all: that request path returned an HTTP 500 in a real founder run,
// another Windows/Supabase-side failure mode outside this module's
// control. Completeness is instead proven by exhaustive pagination: the
// exporter fetches page after page until the server returns a page shorter
// than the requested page size, or an empty page -- that is the proof the
// dataset was fully consumed, not a pre-fetched total to compare against.
//
// To keep the row set stable across the whole paginated fetch (rows can
// resolve mid-export), the exporter captures `exportCutoffResolvedAt` (the
// current time) once at the start and filters every page to
// `resolved_at <= exportCutoffResolvedAt`, so a row resolving after the
// export started never appears mid-stream and shifts pagination.
//
// There is no default dataset cap. `pageSize` is a transport batch size
// only (default 1000) -- it does not limit the total number of rows
// fetched. `maxRows` is an optional, explicit debug-only cap; using it
// marks the export `exportMode: "DEBUG_CAPPED"` /
// `exportCompleteness: "INTENTIONALLY_CAPPED"` so it can never be mistaken
// for a full dataset in a downstream ROI/model-review gate.
//
// This module does NOT:
//   - write to the database (no insert/update/delete/upsert/rpc; GET only)
//   - log environment variable values or raw row payloads
//   - compute ROI/PnL/profit
//   - install any package (uses the platform `fetch` and the existing
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env convention from
//     lib/supabase/server.ts)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

const TABLE_NAME = "generated_signal_pairs";

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

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
  /** Injectable fetch implementation, for tests. Defaults to the platform fetch. */
  fetchImpl?: FetchLike;
  outputPath?: string;
  /**
   * Optional path to write a compact summary sidecar (the same object this
   * function returns, minus nothing sensitive -- it contains only counts and
   * mode strings, never row payloads). Used by the gated ROI comparison
   * (Phase 3E.2) to prove export completeness without re-querying.
   */
  summaryOutputPath?: string;
  /** Transport batch size only. Does NOT cap the dataset. Default 1000. */
  pageSize?: number;
  /** Explicit debug-only cap on total rows fetched. Never a default. */
  maxRows?: number;
  env?: NodeJS.ProcessEnv;
}

export type ExportMode = "FULL_RESOLVED_BY_EXHAUSTION" | "DEBUG_CAPPED";
export type ExportCompleteness = "COMPLETE_BY_EXHAUSTION" | "INTENTIONALLY_CAPPED";

export type CompletionProof = "LAST_PAGE_SHORT" | "EMPTY_PAGE" | null;

export interface ExportGeneratedSignalPairsResult {
  outputPath: string;
  fetchedRows: number;
  pageSize: number;
  pagesFetched: number;
  exportMode: ExportMode;
  exportCompleteness: ExportCompleteness;
  completionProof: CompletionProof;
  exportCutoffResolvedAt: string;
  missingRows: number;
  requestedMaxRows?: number;
}

function buildRestUrl(baseUrl: string, cutoffResolvedAt: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("select", "*");
  params.append("resolved_at", "not.is.null");
  params.append("resolved_at", `lte.${cutoffResolvedAt}`);
  params.set("order", "resolved_at.desc");
  return `${trimmedBase}/rest/v1/${TABLE_NAME}?${params.toString()}`;
}

/**
 * Fetches one page of resolved rows (resolved_at not null, resolved_at <=
 * the export cutoff, ordered by resolved_at descending) via a read-only
 * GET against the PostgREST REST endpoint (Range: from-to). Throws a safe
 * Error (status code only, no response body) if the request fails or the
 * body is not a JSON array.
 */
async function fetchResolvedRowPage(
  fetchImpl: FetchLike,
  config: SupabaseReadConfig,
  cutoffResolvedAt: string,
  from: number,
  to: number,
): Promise<unknown[]> {
  const response = await fetchImpl(buildRestUrl(config.url, cutoffResolvedAt), {
    method: "GET",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Accept: "application/json",
      "Range-Unit": "items",
      Range: `${from}-${to}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("response body was not a JSON array");
  }

  return data;
}

/**
 * Fetches ALL resolved generated_signal_pairs rows by default (no
 * exact-count request -- paginated GET reads over the REST API,
 * resolved_at not null and resolved_at <= a cutoff captured at export
 * start, ordered by resolved_at descending), normalizes each row, and
 * writes the result as a JSON array to `outputPath`. Never writes to the
 * database.
 *
 * With no `maxRows`, the exporter pages until it receives a page shorter
 * than `pageSize` or an empty page -- that is the proof of exhaustive
 * completeness (`completionProof`), since there is no pre-fetched total to
 * compare against. With `maxRows`, the export is explicitly marked
 * DEBUG_CAPPED / INTENTIONALLY_CAPPED and must not be treated as a full
 * dataset.
 */
export async function exportGeneratedSignalPairsFromSupabase(
  options: ExportGeneratedSignalPairsOptions = {},
): Promise<ExportGeneratedSignalPairsResult> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const summaryOutputPath = options.summaryOutputPath;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRows;
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);

  let config: SupabaseReadConfig;
  try {
    config = resolveSupabaseReadConfig(options.env ?? process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Export failed (config): ${message}`);
  }

  // Captured once, at export start, so a row resolving mid-export never
  // shifts the paginated result set out from under this run.
  const exportCutoffResolvedAt = new Date().toISOString();

  const normalizedRows: Record<string, unknown>[] = [];
  let pagesFetched = 0;
  let completionProof: CompletionProof = null;

  while (maxRows === undefined || normalizedRows.length < maxRows) {
    const from = normalizedRows.length;
    const to = maxRows !== undefined ? Math.min(from + pageSize, maxRows) - 1 : from + pageSize - 1;

    let pageRows: unknown[];
    try {
      pageRows = await fetchResolvedRowPage(fetchImpl, config, exportCutoffResolvedAt, from, to);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Export failed (page ${pagesFetched + 1}): ${message}`);
    }

    pagesFetched += 1;
    for (const row of pageRows) {
      normalizedRows.push(normalizeGeneratedSignalPairRow(row as Record<string, unknown>));
    }

    if (maxRows !== undefined) {
      // Debug-capped mode stops purely by size cap -- it never claims
      // exhaustion proof.
      continue;
    }

    if (pageRows.length === 0) {
      completionProof = "EMPTY_PAGE";
      break;
    }
    if (pageRows.length < pageSize) {
      completionProof = "LAST_PAGE_SHORT";
      break;
    }
  }

  try {
    const dir = path.dirname(outputPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(outputPath, `${JSON.stringify(normalizedRows, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Export failed (write): ${message}`);
  }

  const fetchedRows = normalizedRows.length;
  const exportMode: ExportMode = maxRows !== undefined ? "DEBUG_CAPPED" : "FULL_RESOLVED_BY_EXHAUSTION";
  const exportCompleteness: ExportCompleteness =
    maxRows !== undefined ? "INTENTIONALLY_CAPPED" : "COMPLETE_BY_EXHAUSTION";

  const summary: ExportGeneratedSignalPairsResult = {
    outputPath,
    fetchedRows,
    pageSize,
    pagesFetched,
    exportMode,
    exportCompleteness,
    completionProof: maxRows !== undefined ? null : completionProof,
    exportCutoffResolvedAt,
    missingRows: 0,
    ...(maxRows !== undefined ? { requestedMaxRows: maxRows } : {}),
  };

  if (summaryOutputPath) {
    try {
      const summaryDir = path.dirname(summaryOutputPath);
      if (!existsSync(summaryDir)) {
        mkdirSync(summaryDir, { recursive: true });
      }
      // The summary object contains only counts and mode strings -- no row
      // payloads -- so this sidecar never leaks row data.
      writeFileSync(summaryOutputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Export failed (write): ${message}`);
    }
  }

  return summary;
}

interface ParsedArgs {
  output: string;
  summaryOutput?: string;
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
    } else if (arg === "--summary-output") {
      args.summaryOutput = argv[i + 1];
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
      summaryOutputPath: args.summaryOutput,
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
