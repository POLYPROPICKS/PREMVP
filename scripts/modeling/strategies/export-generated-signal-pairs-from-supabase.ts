#!/usr/bin/env -S node --import tsx
// Automated read-only Supabase export runner for generated_signal_pairs
// (Phase 3D.2Ob, dataset-completeness hardened in Phase 3D.2P, transport
// hardened for Windows in Phase 3E.2a, count dependency removed in Phase
// 3E.2b, keyset pagination in Phase 3E.2d).
//
// Reads ALL resolved generated_signal_pairs rows directly from Supabase by
// default (paginated GET reads over the PostgREST REST API, no exact-count
// request), normalizes schema drift in code, and writes a local JSON
// export file in the same shape the existing dedup comparison CLI
// (run-readonly-comparison.ts) expects.
//
// Transport: this module talks to Supabase's PostgREST REST endpoint
// directly via the platform `fetch` (GET requests only). It deliberately
// does NOT depend on the @supabase/supabase-js client's count/head select
// path -- that path was observed to crash on Windows with a native libuv
// assertion failure. As of Phase 3E.2b it also does NOT make any request
// for an exact row total at all: that request path returned an HTTP 500 in
// a real founder run, another Windows/Supabase-side failure mode outside
// this module's control.
//
// Pagination (Phase 3E.2d, KEYSET_RESOLVED_AT_ID): a real founder run also
// failed deep in an offset/Range-based pagination sweep
// (`Export failed (page 20): HTTP 500`) -- deep OFFSET pagination is a
// known Postgres/PostgREST performance/failure mode at scale. The exporter
// no longer uses OFFSET or a Range header at all. Instead it uses
// composite keyset pagination on `resolved_at DESC, id DESC`: each page
// after the first carries a cursor built from the last row of the
// previous page, filtering to rows strictly after that row in the same
// stable order (`resolved_at < lastResolvedAt OR (resolved_at =
// lastResolvedAt AND id < lastId)`). This never re-scans skipped rows and
// has no "deep offset" degradation mode. `resolved_at` alone is never used
// as the cursor -- rows sharing a `resolved_at` value are only
// disambiguated by the `id DESC` tiebreak, so a same-timestamp group can
// never be partially skipped or duplicated across a page boundary.
//
// Completeness is proven by exhaustive pagination: the exporter fetches
// page after page until the server returns a page shorter than the
// requested page size, or an empty page -- that is the proof the dataset
// was fully consumed, not a pre-fetched total to compare against.
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
//   - log environment variable values, authorization headers, response
//     bodies, or raw row/cursor payloads
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
  text(): Promise<string>;
}>;

/**
 * Physical Supabase source schema for `generated_signal_pairs` (Phase
 * 3E.2f). This is NOT the same thing as the normalizer's compatibility
 * schema below -- it is exactly the 27 columns that exist on the live
 * table today (verified against `information_schema.columns` after a real
 * founder REST probe failed with `HTTP 400 postgrestCode=42703: column
 * generated_signal_pairs.token_id does not exist`). This list, not a
 * broader "everything a normalizer alias might read" list, is what the
 * live REST `select=` parameter must use -- selecting a column that
 * doesn't physically exist fails the whole request, it doesn't just leave
 * a field empty.
 *
 * Notably: `token_id` is NOT physical (only `selected_token_id` is);
 * `signal_score`, `coverage`, `coverage_score`, `result`,
 * `outcome_status`, `entry_price`, `real_pnl_usd`, `match_family_key`,
 * `canonical_event_key`, `parent_event_key`, `event_title`, `league`, and
 * `hours_until_start` are NOT physical either -- they are normalizer-only
 * aliases with no live column backing them today. Any of those appearing
 * in the REST `select=` would reproduce the same 42703 failure.
 */
export const GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS = [
  "id",
  "source",
  "formula_version",
  "event_slug",
  "market_slug",
  "condition_id",
  "selected_outcome",
  "premium_signal",
  "market_source",
  "diagnostics",
  "score",
  "created_at",
  "expires_at",
  "market_sources",
  "selected_token_id",
  "entry_price_num",
  "signal_confidence_num",
  "expected_return_pct_num",
  "trust_metrics",
  "smart_money_score_num",
  "whale_public_score_num",
  "pre_event_score_num",
  "signal_result",
  "resolved_at",
  "winning_outcome",
  "realized_return_pct",
  "metric_formula_version",
] as const;

/**
 * The normalizer's broader compatibility schema: every field name
 * `normalizeGeneratedSignalPairRow()` below understands, including
 * legacy/offline-fixture aliases (`token_id`, `signal_score`, `coverage`,
 * `result`, `outcome_status`, `entry_price`, ...) that do NOT need to
 * exist as physical Supabase columns. This exists purely for
 * documentation/testing of the compatibility layer -- it is never sent to
 * the live REST API (see GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS for that).
 */
export const NORMALIZER_COMPAT_FIELDS = [
  "id",
  "condition_id",
  "token_id",
  "selected_token_id",
  "created_at",
  "resolved_at",
  "formula_version",
  "metric_formula_version",
  "score",
  "signal_score",
  "pre_event_score_num",
  "coverage",
  "coverage_score",
  "signal_result",
  "result",
  "outcome_status",
  "winning_outcome",
  "selected_outcome",
  "entry_price_num",
  "entry_price",
  "realized_return_pct",
  "real_pnl_usd",
  "match_family_key",
  "canonical_event_key",
  "parent_event_key",
  "event_slug",
  "event_title",
  "market_slug",
  "league",
  "hours_until_start",
  "diagnostics",
] as const;

/**
 * Builds the PostgREST `select=` param value for the live REST request --
 * the physical-schema allowlist only, never the broader normalizer
 * compatibility list.
 */
export function buildSelectParam(): string {
  return GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS.join(",");
}

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
  /**
   * Optional path to write a small success-sentinel file, written only
   * after the export (and summary, if requested) have both finished
   * writing successfully. Exists because Windows CMD callers cannot fully
   * rely on `%ERRORLEVEL%` after this process exits (a native libuv
   * teardown assertion has been observed to interfere with exit-code
   * propagation on Windows). The sentinel contains no secrets and no row
   * data -- only a stable status marker and schema version.
   */
  sentinelOutputPath?: string;
  /** Transport batch size only. Does NOT cap the dataset. Default 1000. */
  pageSize?: number;
  /** Explicit debug-only cap on total rows fetched. Never a default. */
  maxRows?: number;
  env?: NodeJS.ProcessEnv;
}

export type ExportMode = "FULL_RESOLVED_BY_EXHAUSTION" | "DEBUG_CAPPED";
export type ExportCompleteness = "COMPLETE_BY_EXHAUSTION" | "INTENTIONALLY_CAPPED";

export type CompletionProof = "LAST_PAGE_SHORT" | "EMPTY_PAGE" | null;

export type PaginationMode = "KEYSET_RESOLVED_AT_ID";

export interface ExportGeneratedSignalPairsResult {
  outputPath: string;
  fetchedRows: number;
  pageSize: number;
  pagesFetched: number;
  exportMode: ExportMode;
  exportCompleteness: ExportCompleteness;
  completionProof: CompletionProof;
  exportCutoffResolvedAt: string;
  paginationMode: PaginationMode;
  missingRows: number;
  requestedMaxRows?: number;
}

/** The composite keyset cursor: the (resolved_at, id) pair of the last row of a page. */
export interface KeysetCursor {
  resolvedAt: string;
  id: string;
}

function isPlainObjectRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(new Date(value).getTime());
}

/**
 * Extracts a valid keyset cursor from the last row of a fetched page. A
 * page's last row (per `order=resolved_at.desc,id.desc`) is the row with
 * the smallest (resolved_at, id) in that page -- the correct anchor for
 * "everything strictly after this point" on the next page. Returns null if
 * the last row is missing, or its `resolved_at`/`id` fields are absent,
 * empty, or (for `resolved_at`) not a parseable timestamp -- the caller
 * treats a null result as a hard stop, never a silent skip.
 */
export function extractKeysetCursor(rows: readonly unknown[]): KeysetCursor | null {
  if (rows.length === 0) return null;
  const lastRow = rows[rows.length - 1];
  if (!isPlainObjectRow(lastRow)) return null;

  const resolvedAtRaw = lastRow.resolved_at;
  if (typeof resolvedAtRaw !== "string" || !isFiniteTimestamp(resolvedAtRaw)) return null;

  const idRaw = lastRow.id;
  let id: string | null = null;
  if (typeof idRaw === "string" && idRaw.trim() !== "") {
    id = idRaw;
  } else if (typeof idRaw === "number" && Number.isFinite(idRaw)) {
    id = String(idRaw);
  }
  if (id === null) return null;

  return { resolvedAt: resolvedAtRaw, id };
}

function keysetCursorsEqual(a: KeysetCursor, b: KeysetCursor): boolean {
  return a.resolvedAt === b.resolvedAt && a.id === b.id;
}

/**
 * Builds the composite `or=(...)` PostgREST filter for "strictly after"
 * `cursor` in `resolved_at DESC, id DESC` order:
 *   resolved_at < cursor.resolvedAt
 *   OR (resolved_at = cursor.resolvedAt AND id < cursor.id)
 * This is what makes same-`resolved_at` groups traverse safely via the
 * `id DESC` tiebreak instead of ever using `resolved_at` alone as a cursor.
 */
export function buildKeysetCursorFilter(cursor: KeysetCursor): string {
  return `(resolved_at.lt.${cursor.resolvedAt},and(resolved_at.eq.${cursor.resolvedAt},id.lt.${cursor.id}))`;
}

/**
 * Builds the single canonical `and=(resolved_at.not.is.null,resolved_at.lte.<cutoff>)`
 * filter that replaces the previous duplicate `resolved_at` query keys.
 * Both conditions are ANDed together explicitly instead of relying on
 * repeated-key AND semantics.
 */
function buildCutoffFilter(cutoffResolvedAt: string): string {
  return `(resolved_at.not.is.null,resolved_at.lte.${cutoffResolvedAt})`;
}

function buildRestUrl(
  baseUrl: string,
  cutoffResolvedAt: string,
  cursor: KeysetCursor | null,
  limit: number,
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("select", buildSelectParam());
  params.set("and", buildCutoffFilter(cutoffResolvedAt));
  params.set("order", "resolved_at.desc,id.desc");
  params.set("limit", String(limit));
  if (cursor) {
    params.set("or", buildKeysetCursorFilter(cursor));
  }
  return `${trimmedBase}/rest/v1/${TABLE_NAME}?${params.toString()}`;
}

const MAX_DIAGNOSTIC_LENGTH = 800;

function truncateSafe(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Redacts anything that looks like a secret/credential from error
 * diagnostic text: JWT-shaped strings (three dot-separated base64url
 * segments), "Bearer <token>" sequences, "apikey=<value>"-style pairs, and
 * bare URLs (which could embed a host or path we don't want to surface).
 */
function redactSensitive(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/apikey[=:]\s*\S+/gi, "apikey=[REDACTED]")
    .replace(/authorization[=:]\s*\S+/gi, "authorization=[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
}

function isPlainErrorBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() !== "" ? field : undefined;
}

/**
 * Builds a bounded, redacted diagnostic string for a non-OK PostgREST
 * response: HTTP status, plus (if the body is valid JSON with PostgREST's
 * standard shape) `code`/`message`/`details`/`hint` fields. Falls back to a
 * short redacted text fragment if the body is not JSON. Never includes the
 * full raw response body, request URL, or credential values, and is
 * capped at MAX_DIAGNOSTIC_LENGTH characters total.
 */
async function buildSafePostgrestErrorDetail(response: { status: number; text(): Promise<string> }): Promise<string> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const redactedBody = redactSensitive(bodyText);

  let parsed: unknown = null;
  try {
    parsed = redactedBody.trim() === "" ? null : JSON.parse(redactedBody);
  } catch {
    parsed = null;
  }

  if (isPlainErrorBody(parsed)) {
    const parts = [`HTTP ${response.status}`];
    const code = pickStringField(parsed, "code");
    const message = pickStringField(parsed, "message");
    const details = pickStringField(parsed, "details");
    const hint = pickStringField(parsed, "hint");
    if (code) parts.push(`postgrestCode=${code}`);
    if (message) parts.push(`message=${message}`);
    if (details) parts.push(`details=${details}`);
    if (hint) parts.push(`hint=${hint}`);
    return truncateSafe(parts.join("; "), MAX_DIAGNOSTIC_LENGTH);
  }

  const fragment = truncateSafe(redactedBody, 200);
  const withFragment = fragment ? `HTTP ${response.status}; body=${fragment}` : `HTTP ${response.status}`;
  return truncateSafe(withFragment, MAX_DIAGNOSTIC_LENGTH);
}

/**
 * Fetches one page of resolved rows (resolved_at not null, resolved_at <=
 * the export cutoff, ordered by resolved_at DESC, id DESC, limited to
 * `limit`, and -- for every page after the first -- filtered to strictly
 * after `cursor`) via a read-only GET against the PostgREST REST endpoint.
 * No OFFSET, no Range header: this is pure keyset/seek pagination, which
 * never re-scans skipped rows and has no deep-offset degradation mode.
 * Throws a safe, bounded, redacted Error if the request fails or the body
 * is not a JSON array -- never the raw response body, URL, or credentials.
 */
async function fetchResolvedRowPage(
  fetchImpl: FetchLike,
  config: SupabaseReadConfig,
  cutoffResolvedAt: string,
  cursor: KeysetCursor | null,
  limit: number,
): Promise<unknown[]> {
  const response = await fetchImpl(buildRestUrl(config.url, cutoffResolvedAt, cursor, limit), {
    method: "GET",
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const detail = await buildSafePostgrestErrorDetail(response);
    throw new Error(detail);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("response body was not a JSON array");
  }

  return data;
}

/**
 * Fetches ALL resolved generated_signal_pairs rows by default (no
 * exact-count request -- keyset-paginated GET reads over the REST API,
 * `resolved_at DESC, id DESC`, resolved_at not null and resolved_at <= a
 * cutoff captured at export start), normalizes each row, and writes the
 * result as a JSON array to `outputPath`. Never writes to the database.
 *
 * With no `maxRows`, the exporter pages until it receives a page shorter
 * than `pageSize` or an empty page -- that is the proof of exhaustive
 * completeness (`completionProof`), since there is no pre-fetched total to
 * compare against. With `maxRows`, the export is explicitly marked
 * DEBUG_CAPPED / INTENTIONALLY_CAPPED and must not be treated as a full
 * dataset.
 *
 * Pagination never uses OFFSET/Range: each page after the first carries a
 * composite `(resolved_at, id)` cursor built from the previous page's last
 * row. If a full page's last row is missing valid cursor fields, or if the
 * next cursor fails to advance past the current one (which would loop
 * forever re-fetching the same rows), the export fails safely instead of
 * silently mis-reporting completeness.
 */
export async function exportGeneratedSignalPairsFromSupabase(
  options: ExportGeneratedSignalPairsOptions = {},
): Promise<ExportGeneratedSignalPairsResult> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const summaryOutputPath = options.summaryOutputPath;
  const sentinelOutputPath = options.sentinelOutputPath;
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
  let cursor: KeysetCursor | null = null;

  while (maxRows === undefined || normalizedRows.length < maxRows) {
    const limit = maxRows !== undefined ? Math.min(pageSize, maxRows - normalizedRows.length) : pageSize;
    const isFirstPage = cursor === null;
    const pageNumber = pagesFetched + 1;

    let pageRows: unknown[];
    try {
      pageRows = await fetchResolvedRowPage(fetchImpl, config, exportCutoffResolvedAt, cursor, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Export failed (page ${pageNumber}, ${isFirstPage ? "first-page" : "cursor-page"}, paginationMode=KEYSET_RESOLVED_AT_ID): ${message}`,
      );
    }

    pagesFetched += 1;
    for (const row of pageRows) {
      normalizedRows.push(normalizeGeneratedSignalPairRow(row as Record<string, unknown>));
    }

    if (pageRows.length === 0) {
      if (maxRows === undefined) completionProof = "EMPTY_PAGE";
      break;
    }

    const isShortPage = pageRows.length < limit;

    if (maxRows !== undefined) {
      if (normalizedRows.length >= maxRows) break;
      if (isShortPage) break; // ran out of data before the cap -- capped mode never claims exhaustion proof.
    } else if (isShortPage) {
      completionProof = "LAST_PAGE_SHORT";
      break;
    }

    // We are about to fetch another page -- the current page's last row
    // must yield a valid, advancing keyset cursor, or pagination cannot
    // safely continue.
    const nextCursor = extractKeysetCursor(pageRows);
    if (!nextCursor) {
      throw new Error(
        `Export failed (page ${pageNumber}, paginationMode=KEYSET_RESOLVED_AT_ID): KEYSET_CURSOR_FIELDS_MISSING`,
      );
    }
    if (cursor && keysetCursorsEqual(cursor, nextCursor)) {
      throw new Error(
        `Export failed (page ${pageNumber}, paginationMode=KEYSET_RESOLVED_AT_ID): CURSOR_DID_NOT_ADVANCE`,
      );
    }
    cursor = nextCursor;
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
    paginationMode: "KEYSET_RESOLVED_AT_ID",
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

  if (sentinelOutputPath) {
    try {
      const sentinelDir = path.dirname(sentinelOutputPath);
      if (!existsSync(sentinelDir)) {
        mkdirSync(sentinelDir, { recursive: true });
      }
      // Written only after the export (and summary, if requested) have
      // both finished writing above -- reaching this line is itself proof
      // of success. Contains only a stable status marker and schema
      // version, never row data or secrets.
      const sentinel = { schemaVersion: 1, status: "SUCCESS" as const };
      writeFileSync(sentinelOutputPath, `${JSON.stringify(sentinel, null, 2)}\n`, "utf8");
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
  sentinelOutput?: string;
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
    } else if (arg === "--sentinel-output") {
      args.sentinelOutput = argv[i + 1];
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
      sentinelOutputPath: args.sentinelOutput,
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
