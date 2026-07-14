#!/usr/bin/env -S node --import tsx
// Phase 3E.8E.3B -- read-only post-cutoff resolved-signal exporter.
//
// A separate, forward-only sibling to export-generated-signal-pairs-from-
// supabase.ts. Every run re-exports the FULL post-cutoff window (no
// incremental watermark, no historical mode): resolved_at strictly greater
// than the locked cutoff, and less-than-or-equal to an upper bound captured
// once at run start. GET requests only, no Supabase writes. Reuses the
// historical exporter's proven normalization, select-param, keyset-cursor,
// and read-config helpers verbatim -- never reimplements them. Dry-run is
// the default and writes zero files; --write-artifacts writes the rows file
// and manifest atomically, then re-reads and verifies both before reporting
// success.

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildSelectParam,
  normalizeGeneratedSignalPairRow,
  resolveSupabaseReadConfig,
  extractKeysetCursor,
  type SupabaseReadConfig,
  type KeysetCursor,
} from "./export-generated-signal-pairs-from-supabase";
import { POST_CUTOFF_RESOLVED_AT_EXCLUSIVE, parseObservationTimestamp } from "../../../lib/modeling/postCutoffObservation";
import type { ExportRow } from "../../../lib/modeling/generatedSignalPairsExportContract";

const TABLE_NAME = "generated_signal_pairs";

export const DEFAULT_POST_CUTOFF_ROWS_PATH = path.join(
  "modeling", "local_exports", "post_cutoff_observation", "post_cutoff_resolved_rows.json",
);
export const DEFAULT_POST_CUTOFF_MANIFEST_PATH = path.join(
  "modeling", "local_exports", "post_cutoff_observation", "post_cutoff_export_manifest.json",
);

const DEFAULT_PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ---- CLI args ----

export type PostCutoffExportMode = "dry-run" | "write";

export interface PostCutoffExportArgs {
  mode: PostCutoffExportMode;
  output: string;
  manifestOutput: string;
  cutoff: string;
  pageSize: number;
}

const KNOWN_FLAGS = new Set(["--output", "--manifest-output", "--cutoff", "--page-size", "--write-artifacts", "--dry-run"]);

/**
 * Parses CLI arguments. Dry-run is the default mode; --write-artifacts and
 * --dry-run together are a deterministic argument error. Unknown flags,
 * missing values, an invalid cutoff, and a non-positive/non-integer page
 * size all throw.
 */
export function parsePostCutoffExportArgs(argv: string[]): PostCutoffExportArgs {
  let output = DEFAULT_POST_CUTOFF_ROWS_PATH;
  let manifestOutput = DEFAULT_POST_CUTOFF_MANIFEST_PATH;
  let cutoff = POST_CUTOFF_RESOLVED_AT_EXCLUSIVE;
  let pageSize = DEFAULT_PAGE_SIZE;
  let sawWrite = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN_FLAGS.has(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (arg === "--write-artifacts") {
      sawWrite = true;
      continue;
    }
    if (arg === "--dry-run") {
      sawDryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`missing value for argument: ${arg}`);
    }
    i += 1;
    if (arg === "--output") output = value;
    else if (arg === "--manifest-output") manifestOutput = value;
    else if (arg === "--cutoff") {
      if (parseObservationTimestamp(value) === null) {
        throw new Error(`invalid --cutoff timestamp: ${value}`);
      }
      cutoff = value;
    } else if (arg === "--page-size") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`invalid --page-size (must be a positive integer): ${value}`);
      }
      pageSize = n;
    }
  }

  if (sawWrite && sawDryRun) {
    throw new Error("--dry-run and --write-artifacts cannot be used together");
  }

  return { mode: sawWrite ? "write" : "dry-run", output, manifestOutput, cutoff, pageSize };
}

// ---- Query URL construction ----

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The single canonical AND filter: not-null, exclusive lower bound, inclusive upper bound. */
export function buildForwardWindowFilter(cutoff: string, upperBound: string, olderThan?: string): string {
  const predicates = [`resolved_at.not.is.null`, `resolved_at.gt.${cutoff}`, `resolved_at.lte.${upperBound}`];
  if (olderThan !== undefined) predicates.push(`resolved_at.lt.${olderThan}`);
  return `(${predicates.join(",")})`;
}

export function buildForwardFirstPageUrl(baseUrl: string, cutoff: string, upperBound: string, limit: number): string {
  const params = new URLSearchParams();
  params.set("select", buildSelectParam());
  params.set("and", buildForwardWindowFilter(cutoff, upperBound));
  params.set("order", "resolved_at.desc,id.desc");
  params.set("limit", String(limit));
  return `${trimBase(baseUrl)}/rest/v1/${TABLE_NAME}?${params.toString()}`;
}

export function buildForwardSameTimestampUrl(baseUrl: string, cutoff: string, upperBound: string, cursor: KeysetCursor, limit: number): string {
  const params = new URLSearchParams();
  params.set("select", buildSelectParam());
  // The eq. filter already pins resolved_at to the cursor's timestamp (which
  // is guaranteed to already be inside the window, since it came from a
  // previously window-filtered page) -- the explicit bound predicates below
  // are redundant-but-required defense-in-depth so the lower/upper bound is
  // literally present on every physical request, not just implied.
  params.set("and", buildForwardWindowFilter(cutoff, upperBound));
  params.set("resolved_at", `eq.${cursor.resolvedAt}`);
  params.set("id", `lt.${cursor.id}`);
  params.set("order", "id.desc");
  params.set("limit", String(limit));
  return `${trimBase(baseUrl)}/rest/v1/${TABLE_NAME}?${params.toString()}`;
}

export function buildForwardOlderTimestampsUrl(baseUrl: string, cutoff: string, upperBound: string, cursor: KeysetCursor, limit: number): string {
  const params = new URLSearchParams();
  params.set("select", buildSelectParam());
  params.set("and", buildForwardWindowFilter(cutoff, upperBound, cursor.resolvedAt));
  params.set("order", "resolved_at.desc,id.desc");
  params.set("limit", String(limit));
  return `${trimBase(baseUrl)}/rest/v1/${TABLE_NAME}?${params.toString()}`;
}

// ---- Transport (retry + fetch) ----

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[unparseable url]";
  }
}

async function requestWithRetry(
  fetchImpl: FetchLike,
  config: SupabaseReadConfig,
  url: string,
  requestKind: "first-page" | "same-timestamp" | "older-timestamps",
  pageNumber: number,
  delayFn: (ms: number) => Promise<void>,
): Promise<unknown[]> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: "application/json" },
      });
      if (response.ok) {
        const data = await response.json();
        if (!Array.isArray(data)) {
          throw new Error(
            `post-cutoff export failed (page ${pageNumber}, ${requestKind}): response body was not a JSON array (url=${displayUrl(url)})`,
          );
        }
        for (const item of data) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new Error(
              `post-cutoff export failed (page ${pageNumber}, ${requestKind}): a returned row was not an object (url=${displayUrl(url)})`,
            );
          }
        }
        return data;
      }
      lastStatus = response.status;
      if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(
          `post-cutoff export failed (page ${pageNumber}, ${requestKind}, attempt ${attempt}/${MAX_ATTEMPTS}): HTTP ${response.status} (url=${displayUrl(url)})`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("post-cutoff export failed")) {
        throw error; // deterministic contract error -- never retried further
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `post-cutoff export failed (page ${pageNumber}, ${requestKind}, attempt ${attempt}/${MAX_ATTEMPTS}): network error (url=${displayUrl(url)})`,
        );
      }
    }
    await delayFn(RETRY_DELAY_MS * 2 ** (attempt - 1));
  }
  throw new Error(
    `post-cutoff export failed (page ${pageNumber}, ${requestKind}): exhausted ${MAX_ATTEMPTS} attempts (last status ${lastStatus}, url=${displayUrl(url)})`,
  );
}

export interface FetchPostCutoffOptions {
  fetchImpl: FetchLike;
  config: SupabaseReadConfig;
  cutoff: string;
  upperBound: string;
  pageSize?: number;
  delayFn?: (ms: number) => Promise<void>;
}

export interface FetchPostCutoffResult {
  rows: unknown[];
  pageCount: number;
  requestCount: number;
}

/**
 * Fetches all rows in the exclusive-lower/inclusive-upper post-cutoff
 * window, split-keyset paginated exactly as the historical exporter's proven
 * two-request-per-page pattern (same-timestamp tail, then older timestamps).
 * Never uses OFFSET/Range. Throws if a full page's last row yields no valid
 * cursor, or if the cursor fails to advance.
 */
export async function fetchPostCutoffResolvedRows(options: FetchPostCutoffOptions): Promise<FetchPostCutoffResult> {
  const { fetchImpl, config, cutoff, upperBound } = options;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const delayFn = options.delayFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const rows: unknown[] = [];
  let pageCount = 0;
  let requestCount = 0;
  let cursor: KeysetCursor | null = null;

  while (true) {
    pageCount += 1;
    let pageRows: unknown[];

    if (cursor === null) {
      const url = buildForwardFirstPageUrl(config.url, cutoff, upperBound, pageSize);
      requestCount += 1;
      pageRows = await requestWithRetry(fetchImpl, config, url, "first-page", pageCount, delayFn);
    } else {
      const sameUrl = buildForwardSameTimestampUrl(config.url, cutoff, upperBound, cursor, pageSize);
      requestCount += 1;
      const sameTimestampRows = await requestWithRetry(fetchImpl, config, sameUrl, "same-timestamp", pageCount, delayFn);
      if (sameTimestampRows.length >= pageSize) {
        pageRows = sameTimestampRows;
      } else {
        const remaining = pageSize - sameTimestampRows.length;
        const olderUrl = buildForwardOlderTimestampsUrl(config.url, cutoff, upperBound, cursor, remaining);
        requestCount += 1;
        const olderRows = await requestWithRetry(fetchImpl, config, olderUrl, "older-timestamps", pageCount, delayFn);
        pageRows = [...sameTimestampRows, ...olderRows];
      }
    }

    for (const row of pageRows) rows.push(row);

    if (pageRows.length === 0) break;
    const isShortPage = pageRows.length < pageSize;
    if (isShortPage) break;

    const nextCursor = extractKeysetCursor(pageRows);
    if (!nextCursor) {
      throw new Error(`post-cutoff export failed (page ${pageCount}): KEYSET_CURSOR_FIELDS_MISSING`);
    }
    if (cursor && cursor.resolvedAt === nextCursor.resolvedAt && cursor.id === nextCursor.id) {
      throw new Error(`post-cutoff export failed (page ${pageCount}): CURSOR_DID_NOT_ADVANCE`);
    }
    cursor = nextCursor;
  }

  return { rows, pageCount, requestCount };
}

// ---- Physical-duplicate-safe artifact assembly ----

export interface PostCutoffExportManifest {
  schemaVersion: 1;
  cutoffResolvedAtExclusive: string;
  runUpperBoundInclusive: string;
  rowCount: number;
  firstResolvedAt: string | null;
  lastResolvedAt: string | null;
  contentHash: string;
  queryContract: {
    table: "generated_signal_pairs";
    lowerBoundOperator: "gt";
    upperBoundOperator: "lte";
    order: "resolved_at.desc,id.desc";
    pagination: "KEYSET_RESOLVED_AT_ID";
    refreshMode: "FULL_POST_CUTOFF";
  };
  pageCount: number;
  requestCount: number;
  emptyWindow: boolean;
}

export interface BuildPostCutoffExportArtifactsOptions {
  rawRows: readonly unknown[];
  cutoff: string;
  upperBound: string;
  pageCount: number;
  requestCount: number;
}

export interface PostCutoffExportArtifacts {
  rows: ExportRow[];
  rowsJson: string;
  manifest: PostCutoffExportManifest;
}

/** Deterministic pretty JSON with exactly one trailing newline. */
export function serializePostCutoffRows(rows: readonly ExportRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

function getId(row: Record<string, unknown>): string | null {
  const v = row["id"];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Normalizes raw rows, collapses exact-duplicate physical `id`s (identical
 * normalized content -> one row, no throw), throws deterministically on a
 * conflicting duplicate `id` (differing content for the same id), sorts by
 * resolved_at then id ascending, and assembles the rows JSON + manifest.
 * Performs NO observation-level (condition_id/token_id/resolved_at) dedup --
 * that is a modeling-layer concern, not this exporter's.
 */
export function buildPostCutoffExportArtifacts(options: BuildPostCutoffExportArtifactsOptions): PostCutoffExportArtifacts {
  const { rawRows, cutoff, upperBound, pageCount, requestCount } = options;

  const byId = new Map<string, ExportRow>();
  const unkeyed: ExportRow[] = [];

  for (const raw of rawRows) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("post-cutoff export: encountered a non-object row during artifact assembly");
    }
    const normalized = normalizeGeneratedSignalPairRow(raw as Record<string, unknown>);
    const id = getId(raw as Record<string, unknown>);
    if (id === null) {
      unkeyed.push(normalized);
      continue;
    }
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, normalized);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`post-cutoff export: conflicting duplicate physical id (differing content for the same row id)`);
    }
    // identical duplicate -- collapse silently, no throw
  }

  const rows = [...byId.values(), ...unkeyed].sort((a, b) => {
    const ra = typeof a["resolved_at"] === "string" ? (a["resolved_at"] as string) : "";
    const rb = typeof b["resolved_at"] === "string" ? (b["resolved_at"] as string) : "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    const ia = getId(a) ?? "";
    const ib = getId(b) ?? "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  const rowsJson = serializePostCutoffRows(rows);
  const contentHash = createHash("sha256").update(rowsJson).digest("hex");

  const firstResolvedAt = rows.length > 0 && typeof rows[0]["resolved_at"] === "string" ? (rows[0]["resolved_at"] as string) : null;
  const lastResolvedAt =
    rows.length > 0 && typeof rows[rows.length - 1]["resolved_at"] === "string" ? (rows[rows.length - 1]["resolved_at"] as string) : null;

  const manifest: PostCutoffExportManifest = {
    schemaVersion: 1,
    cutoffResolvedAtExclusive: cutoff,
    runUpperBoundInclusive: upperBound,
    rowCount: rows.length,
    firstResolvedAt,
    lastResolvedAt,
    contentHash,
    queryContract: {
      table: "generated_signal_pairs",
      lowerBoundOperator: "gt",
      upperBoundOperator: "lte",
      order: "resolved_at.desc,id.desc",
      pagination: "KEYSET_RESOLVED_AT_ID",
      refreshMode: "FULL_POST_CUTOFF",
    },
    pageCount,
    requestCount,
    emptyWindow: rows.length === 0,
  };

  return { rows, rowsJson, manifest };
}

// ---- Atomic write ----

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

// ---- Orchestration ----

export interface PostCutoffExportSummary {
  mode: PostCutoffExportMode;
  cutoffResolvedAtExclusive: string;
  runUpperBoundInclusive: string;
  rowCount: number;
  firstResolvedAt: string | null;
  lastResolvedAt: string | null;
  contentHash: string;
  emptyWindow: boolean;
  pageCount: number;
  requestCount: number;
}

export interface PostCutoffExportResult {
  exitCode: number;
  summary?: PostCutoffExportSummary;
  error?: string;
}

export interface RunPostCutoffResolvedExportOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Injectable upper-bound override for tests; defaults to a fresh new Date().toISOString(). */
  upperBound?: string;
}

/**
 * Runs the full forward exporter: parses args, resolves read config,
 * captures the upper bound once, fetches the full post-cutoff window,
 * assembles deterministic artifacts, and (mode === "write") writes both
 * files atomically, then re-reads and verifies every invariant before
 * reporting success. Never throws to the caller.
 */
export async function runPostCutoffResolvedExport(
  argv: string[],
  options: RunPostCutoffResolvedExportOptions = {},
): Promise<PostCutoffExportResult> {
  try {
    const args = parsePostCutoffExportArgs(argv);
    const config = resolveSupabaseReadConfig(options.env ?? process.env);
    const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
    // The only permitted current-time call: captured once, used as the
    // query's inclusive upper bound for every page of this run.
    const upperBound = options.upperBound ?? new Date().toISOString();

    const { rows: rawRows, pageCount, requestCount } = await fetchPostCutoffResolvedRows({
      fetchImpl,
      config,
      cutoff: args.cutoff,
      upperBound,
      pageSize: args.pageSize,
    });

    const artifacts = buildPostCutoffExportArtifacts({
      rawRows,
      cutoff: args.cutoff,
      upperBound,
      pageCount,
      requestCount,
    });

    const summary: PostCutoffExportSummary = {
      mode: args.mode,
      cutoffResolvedAtExclusive: args.cutoff,
      runUpperBoundInclusive: upperBound,
      rowCount: artifacts.manifest.rowCount,
      firstResolvedAt: artifacts.manifest.firstResolvedAt,
      lastResolvedAt: artifacts.manifest.lastResolvedAt,
      contentHash: artifacts.manifest.contentHash,
      emptyWindow: artifacts.manifest.emptyWindow,
      pageCount: artifacts.manifest.pageCount,
      requestCount: artifacts.manifest.requestCount,
    };

    if (args.mode === "dry-run") {
      return { exitCode: 0, summary };
    }

    // Rows file first; manifest only after the rows file is written and
    // verified -- a failure here must never leave a falsely valid manifest.
    atomicWrite(args.output, artifacts.rowsJson);

    const rereadBytes = readFileSync(args.output, "utf8");
    const rereadHash = createHash("sha256").update(rereadBytes).digest("hex");
    if (rereadHash !== artifacts.manifest.contentHash) {
      throw new Error("post-cutoff export: rows file verification failed (contentHash mismatch after write)");
    }
    let rereadRows: unknown;
    try {
      rereadRows = JSON.parse(rereadBytes);
    } catch {
      throw new Error("post-cutoff export: rows file verification failed (re-read file is not valid JSON)");
    }
    if (!Array.isArray(rereadRows) || rereadRows.length !== artifacts.manifest.rowCount) {
      throw new Error("post-cutoff export: rows file verification failed (row count mismatch after write)");
    }

    const manifestJson = `${JSON.stringify(artifacts.manifest, null, 2)}\n`;
    atomicWrite(args.manifestOutput, manifestJson);

    const rereadManifest = JSON.parse(readFileSync(args.manifestOutput, "utf8")) as PostCutoffExportManifest;
    if (rereadManifest.contentHash !== artifacts.manifest.contentHash || rereadManifest.rowCount !== artifacts.manifest.rowCount) {
      throw new Error("post-cutoff export: manifest verification failed after write");
    }

    return { exitCode: 0, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return { exitCode: 1, error: message };
  }
}

function main(): void {
  runPostCutoffResolvedExport(process.argv.slice(2)).then((result) => {
    if (result.exitCode !== 0) {
      process.stderr.write(`Error: ${result.error}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
    }
    process.exit(result.exitCode);
  });
}

if (require.main === module) {
  main();
}
