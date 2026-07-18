// Read-only forward snapshot exporter (Track B, Phase 4B companion).
//
// Reads UNRESOLVED forward observations from the generated_signal_pairs
// source (via an injected read-only adapter), normalizes each row into the
// canonical ExportRow shape the Phase 4B Forward Local Shadow producer
// consumes, and writes a deterministic JSONL snapshot plus a JSON manifest to
// an operator-owned external directory. It applies ONLY the source boundary
// (unresolved + created_at <= asOf); it never applies model selection
// (score threshold, price floor, timing, T-90, ranking, grouping,
// one-per-event, post-June filtering) -- those remain in the waterfall/producer.
//
// This module performs no database WRITE of any kind. The production source
// adapter talks to the PostgREST REST endpoint with GET-only requests and
// exposes only a narrow read method; the exporter core never sees a mutable
// client. Snapshot/manifest writing is the only filesystem mutation and is
// fully staged in memory, then committed atomically (temp files + rename),
// never overwriting an existing output/manifest pair.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stable, sha } from "./canonicalModelHandoff";
import { getStrictDedupKeyForExportRow, type ExportRow } from "./generatedSignalPairsExportContract";
import {
  buildSelectParam,
  normalizeGeneratedSignalPairRow,
  type SupabaseReadConfig,
} from "../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase";

export const FORWARD_SNAPSHOT_MANIFEST_SCHEMA_VERSION = "FORWARD_SNAPSHOT_MANIFEST_V1" as const;
export const FORWARD_SNAPSHOT_SOURCE_CONTRACT_VERSION = "FORWARD_UNRESOLVED_GENERATED_SIGNAL_PAIRS_V1" as const;

const SOURCE_TABLE = "generated_signal_pairs";
const SOURCE_QUERY_SEMANTICS =
  "signal_result IS NULL AND resolved_at IS NULL AND created_at <= asOf; keyset (created_at DESC, id DESC)";
const DEFAULT_PAGE_SIZE = 1000;

// ── source adapter contract ────────────────────────────────────────────────

/** Composite keyset cursor: the (created_at, id) of the last row of a page. */
export interface ForwardSourceCursor {
  createdAt: string;
  id: string;
}

/**
 * Narrow read-only source. `fetchPage` returns one logical page of raw
 * unresolved source rows with created_at <= asOfIso, in canonical global
 * order (created_at DESC, id DESC), strictly after `cursor` when provided,
 * up to `limit` rows. It exposes no mutation capability.
 */
export interface ForwardSourceAdapter {
  fetchPage(input: { asOfIso: string; cursor: ForwardSourceCursor | null; limit: number }): Promise<unknown[]>;
}

// ── as-of + row validation ──────────────────────────────────────────────────

export function normalizeAsOfIso(asOf: string): string {
  const ms = Date.parse(asOf);
  if (typeof asOf !== "string" || asOf.trim() === "" || !Number.isFinite(ms)) {
    throw new Error("FORWARD_EXPORT_INVALID_AS_OF");
  }
  return new Date(ms).toISOString();
}

const RESOLUTION_FIELDS = ["resolved_at", "signal_result", "result", "outcome_status", "realized_return_pct", "winning_outcome"] as const;

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function validateAndNormalizeRow(raw: unknown, asOfMs: number, pageIndex: number): { row: Record<string, unknown>; identityKey: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`FORWARD_EXPORT_ROW_MALFORMED:page_row=${pageIndex}`);
  }
  const src = raw as Record<string, unknown>;
  const id = src.id;
  if (!(typeof id === "string" && id.trim() !== "") && !(typeof id === "number" && Number.isFinite(id))) {
    throw new Error(`FORWARD_EXPORT_ROW_MISSING_ID:page_row=${pageIndex}`);
  }
  const createdAt = typeof src.created_at === "string" ? src.created_at : null;
  const createdMs = createdAt !== null ? Date.parse(createdAt) : NaN;
  if (createdAt === null || !Number.isFinite(createdMs)) {
    throw new Error(`FORWARD_EXPORT_ROW_INVALID_CREATED_AT:id=${String(id)}`);
  }
  if (createdMs > asOfMs) {
    throw new Error(`FORWARD_EXPORT_ROW_CREATED_AT_AFTER_AS_OF:id=${String(id)}`);
  }
  for (const field of RESOLUTION_FIELDS) {
    if (isSet(src[field])) {
      throw new Error(`FORWARD_EXPORT_ROW_RESOLVED:id=${String(id)}:field=${field}`);
    }
  }
  const normalized = normalizeGeneratedSignalPairRow(src);
  const identityKey = getStrictDedupKeyForExportRow(normalized as ExportRow);
  if (identityKey === null) {
    throw new Error(`FORWARD_EXPORT_ROW_MISSING_IDENTITY:id=${String(id)}`);
  }
  return { row: normalized, identityKey };
}

// ── orchestration ───────────────────────────────────────────────────────────

function cursorsEqual(a: ForwardSourceCursor, b: ForwardSourceCursor): boolean {
  return a.createdAt === b.createdAt && a.id === b.id;
}

function extractCursor(row: Record<string, unknown>): ForwardSourceCursor | null {
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  const idRaw = row.id;
  const id = typeof idRaw === "string" && idRaw.trim() !== "" ? idRaw : typeof idRaw === "number" && Number.isFinite(idRaw) ? String(idRaw) : null;
  if (createdAt === null || id === null) return null;
  return { createdAt, id };
}

export interface CollectedForwardRows {
  rows: Record<string, unknown>[];
  identityKeys: string[];
}

/**
 * Keyset-paginates the source adapter, validates every row against the source
 * boundary, normalizes it, detects duplicate source identities, and returns
 * the deterministically sorted rows plus their identity-key set. Zero model
 * selection is applied.
 */
export async function collectForwardRows(adapter: ForwardSourceAdapter, asOfIsoInput: string, pageSize: number = DEFAULT_PAGE_SIZE): Promise<CollectedForwardRows> {
  const asOfIso = normalizeAsOfIso(asOfIsoInput);
  const asOfMs = Date.parse(asOfIso);
  const limit = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;

  const collected: { row: Record<string, unknown>; identityKey: string }[] = [];
  const seenIds = new Set<string>();
  const seenIdentities = new Set<string>();
  let cursor: ForwardSourceCursor | null = null;

  for (;;) {
    const page = await adapter.fetchPage({ asOfIso, cursor, limit });
    if (!Array.isArray(page)) throw new Error("FORWARD_EXPORT_SOURCE_PAGE_NOT_ARRAY");
    for (let i = 0; i < page.length; i += 1) {
      const { row, identityKey } = validateAndNormalizeRow(page[i], asOfMs, i);
      const id = String(row.id);
      if (seenIds.has(id)) throw new Error(`FORWARD_EXPORT_DUPLICATE_SOURCE_ID:id=${id}`);
      if (seenIdentities.has(identityKey)) throw new Error(`FORWARD_EXPORT_DUPLICATE_SOURCE_IDENTITY:id=${id}`);
      seenIds.add(id);
      seenIdentities.add(identityKey);
      collected.push({ row, identityKey });
    }
    if (page.length < limit) break;
    const last = extractCursor(collected[collected.length - 1]?.row ?? {});
    if (last === null) throw new Error("FORWARD_EXPORT_CURSOR_FIELDS_MISSING");
    if (cursor !== null && cursorsEqual(cursor, last)) throw new Error("FORWARD_EXPORT_CURSOR_DID_NOT_ADVANCE");
    cursor = last;
  }

  // Deterministic global ordering: created_at ASC, then id ASC. Independent of
  // source page order, so the snapshot is byte-identical for the same rows.
  collected.sort((a, b) => {
    const ca = String(a.row.created_at), cb = String(b.row.created_at);
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ia = String(a.row.id), ib = String(b.row.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });

  return {
    rows: collected.map((c) => c.row),
    identityKeys: collected.map((c) => c.identityKey),
  };
}

// ── serialization ─────────────────────────────────────────────────────────

/** One canonical (key-sorted) JSON object per non-empty line, trailing newline. */
export function buildSnapshotBytes(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => `${stable(row)}\n`).join("");
}

export function computeSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ForwardSnapshotManifest {
  schemaVersion: typeof FORWARD_SNAPSHOT_MANIFEST_SCHEMA_VERSION;
  sourceContractVersion: typeof FORWARD_SNAPSHOT_SOURCE_CONTRACT_VERSION;
  asOf: string;
  sourceTables: string[];
  sourceQuerySemantics: string;
  rowCount: number;
  rawSnapshotSha256: string;
  normalizedIdentitySetSha256: string;
  outputFormat: "JSONL";
  sourceCommit: string;
  readOnlySafetyVerdict: "READ_ONLY_NO_WRITES";
}

export function buildManifest(params: {
  asOfIso: string;
  rowCount: number;
  snapshotBytes: string;
  identityKeys: readonly string[];
  sourceCommit: string;
}): ForwardSnapshotManifest {
  return {
    schemaVersion: FORWARD_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    sourceContractVersion: FORWARD_SNAPSHOT_SOURCE_CONTRACT_VERSION,
    asOf: normalizeAsOfIso(params.asOfIso),
    sourceTables: [SOURCE_TABLE],
    sourceQuerySemantics: SOURCE_QUERY_SEMANTICS,
    rowCount: params.rowCount,
    rawSnapshotSha256: computeSha256(params.snapshotBytes),
    normalizedIdentitySetSha256: sha(stable([...params.identityKeys].sort())),
    outputFormat: "JSONL",
    sourceCommit: params.sourceCommit,
    readOnlySafetyVerdict: "READ_ONLY_NO_WRITES",
  };
}

export function buildManifestBytes(manifest: ForwardSnapshotManifest): string {
  return `${stable(manifest)}\n`;
}

// ── path safety ───────────────────────────────────────────────────────────

function isEqualOrNested(target: string, protectedRoot: string): boolean {
  const relative = path.relative(protectedRoot, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalExistingAncestor(target: string): string {
  let candidate = target;
  for (;;) {
    try {
      return realpathSync(candidate);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("FORWARD_EXPORT_PATH_CANONICALIZATION_FAILED");
      candidate = parent;
    }
  }
}

function assertNoSymlinkPath(target: string, label: string): void {
  let candidate = target;
  for (;;) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) throw new Error(`FORWARD_EXPORT_${label}_SYMLINK_REJECTED`);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("SYMLINK_REJECTED")) throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

/**
 * Validates that `target` is an absolute path in an operator-owned external
 * directory, never inside the repository or any frozen/canonical root, never
 * a relative or symlinked path, and (when it already exists) never an existing
 * directory. Returns the resolved absolute path. Pure validation; no writes.
 */
export function assertSafeExternalOutputPath(target: string, repositoryRoot: string, label: string): string {
  if (typeof target !== "string" || target.trim() === "") throw new Error(`FORWARD_EXPORT_${label}_REQUIRED`);
  if (!path.isAbsolute(target)) throw new Error(`FORWARD_EXPORT_${label}_MUST_BE_ABSOLUTE`);
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (parent === resolved) throw new Error(`FORWARD_EXPORT_${label}_INVALID_PATH`);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) throw new Error(`FORWARD_EXPORT_${label}_IS_DIRECTORY`);
  assertNoSymlinkPath(resolved, label);
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const existingAncestor = canonicalExistingAncestor(parent);
  const canonicalTarget = path.join(existingAncestor, path.relative(canonicalExistingAncestor(parent), resolved));
  const protectedRoots = [
    canonicalRepositoryRoot,
    path.join(canonicalRepositoryRoot, "modeling/canonical/datasets"),
    path.join(canonicalRepositoryRoot, "modeling/canonical/model-handoff-v1"),
    path.join(canonicalRepositoryRoot, "modeling/evidence"),
    path.join(canonicalRepositoryRoot, "source_hash_inventory.json"),
  ];
  if (protectedRoots.some((r) => isEqualOrNested(resolved, r) || isEqualOrNested(canonicalTarget, r))) {
    throw new Error(`FORWARD_EXPORT_${label}_PROTECTED_ROOT_REJECTED`);
  }
  return resolved;
}

// ── atomic export ───────────────────────────────────────────────────────────

export interface ExportForwardSnapshotParams {
  adapter: ForwardSourceAdapter;
  asOfIso: string;
  outputPath: string;
  manifestPath: string;
  repositoryRoot: string;
  sourceCommit: string;
  pageSize?: number;
}

export interface ExportForwardSnapshotResult {
  outputPath: string;
  manifestPath: string;
  rowCount: number;
  rawSnapshotSha256: string;
  normalizedIdentitySetSha256: string;
  asOf: string;
}

/**
 * Full read-only pipeline: fetch + validate + normalize + sort in memory,
 * construct complete snapshot + manifest bytes, then commit atomically via
 * temp-file + rename (snapshot first, manifest last as the completed marker).
 * Never overwrites an existing output/manifest file; on any error no
 * successful-looking pair is left behind.
 */
export async function exportForwardSnapshot(params: ExportForwardSnapshotParams): Promise<ExportForwardSnapshotResult> {
  const asOfIso = normalizeAsOfIso(params.asOfIso);
  const outputPath = assertSafeExternalOutputPath(params.outputPath, params.repositoryRoot, "OUTPUT");
  const manifestPath = assertSafeExternalOutputPath(params.manifestPath, params.repositoryRoot, "MANIFEST");
  if (outputPath === manifestPath) throw new Error("FORWARD_EXPORT_OUTPUT_MANIFEST_SAME_PATH");
  if (existsSync(outputPath)) throw new Error("FORWARD_EXPORT_OUTPUT_EXISTS");
  if (existsSync(manifestPath)) throw new Error("FORWARD_EXPORT_MANIFEST_EXISTS");

  const { rows, identityKeys } = await collectForwardRows(params.adapter, asOfIso, params.pageSize);
  const snapshotBytes = buildSnapshotBytes(rows);
  const manifest = buildManifest({ asOfIso, rowCount: rows.length, snapshotBytes, identityKeys, sourceCommit: params.sourceCommit });
  const manifestBytes = buildManifestBytes(manifest);

  const outputDir = path.dirname(outputPath);
  const manifestDir = path.dirname(manifestPath);
  const tmpRoot = mkdtempSync(path.join(outputDir, ".forward-export-tmp-"));
  let snapshotRenamed = false;
  try {
    const tmpSnapshot = path.join(tmpRoot, "snapshot.jsonl");
    writeFileSync(tmpSnapshot, snapshotBytes, "utf8");
    renameSync(tmpSnapshot, outputPath);
    snapshotRenamed = true;

    // manifest temp lives in the manifest's own directory so the final rename
    // is same-filesystem atomic even when output/manifest dirs differ.
    const tmpManifest = path.join(manifestDir, `.forward-manifest-${path.basename(tmpRoot)}.json`);
    try {
      writeFileSync(tmpManifest, manifestBytes, "utf8");
      renameSync(tmpManifest, manifestPath);
    } catch (error) {
      // manifest finalization failed after the snapshot landed -- remove the
      // orphan snapshot so no successful-looking partial pair remains.
      rmSync(tmpManifest, { force: true });
      rmSync(outputPath, { force: true });
      throw error;
    }
  } catch (error) {
    if (!snapshotRenamed) rmSync(outputPath, { force: true });
    throw error;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  return {
    outputPath,
    manifestPath,
    rowCount: rows.length,
    rawSnapshotSha256: manifest.rawSnapshotSha256,
    normalizedIdentitySetSha256: manifest.normalizedIdentitySetSha256,
    asOf: manifest.asOf,
  };
}

// ── production read-only adapter (GET-only PostgREST) ────────────────────────

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function buildUnresolvedCutoff(asOfIso: string, olderThanCreatedAt?: string): string {
  const predicates = [`signal_result.is.null`, `resolved_at.is.null`, `created_at.lte.${asOfIso}`];
  if (olderThanCreatedAt !== undefined) predicates.push(`created_at.lt.${olderThanCreatedAt}`);
  return `(${predicates.join(",")})`;
}

function redactSensitive(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/apikey[=:]\s*\S+/gi, "apikey=[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]");
}

/**
 * Builds the production read-only source adapter. Every request is a GET
 * against the PostgREST REST endpoint; the adapter exposes only `fetchPage`.
 * A logical page after the first is served by two index-friendly requests
 * (same-created_at tail, then older created_at), mirroring the resolved
 * exporter's split-keyset technique so no same-timestamp group can be skipped
 * or duplicated across a page boundary.
 */
export function createSupabaseForwardSourceAdapter(config: SupabaseReadConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike): ForwardSourceAdapter {
  const select = buildSelectParam();
  const base = `${trimBase(config.url)}/rest/v1/${SOURCE_TABLE}`;

  async function get(url: string): Promise<unknown[]> {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: "application/json" },
    });
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { body = ""; }
      throw new Error(`FORWARD_EXPORT_SOURCE_HTTP_${response.status}:${redactSensitive(body).slice(0, 200)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("FORWARD_EXPORT_SOURCE_NOT_ARRAY");
    return data;
  }

  return {
    async fetchPage(input) {
      const params = new URLSearchParams();
      params.set("select", select);
      if (input.cursor === null) {
        params.set("and", buildUnresolvedCutoff(input.asOfIso));
        params.set("order", "created_at.desc,id.desc");
        params.set("limit", String(input.limit));
        return get(`${base}?${params.toString()}`);
      }
      // same-created_at tail
      const tailParams = new URLSearchParams();
      tailParams.set("select", select);
      tailParams.set("and", `(signal_result.is.null,resolved_at.is.null)`);
      tailParams.set("created_at", `eq.${input.cursor.createdAt}`);
      tailParams.set("id", `lt.${input.cursor.id}`);
      tailParams.set("order", "id.desc");
      tailParams.set("limit", String(input.limit));
      const sameTs = await get(`${base}?${tailParams.toString()}`);
      if (sameTs.length >= input.limit) return sameTs;
      const olderParams = new URLSearchParams();
      olderParams.set("select", select);
      olderParams.set("and", buildUnresolvedCutoff(input.asOfIso, input.cursor.createdAt));
      olderParams.set("order", "created_at.desc,id.desc");
      olderParams.set("limit", String(input.limit - sameTs.length));
      const older = await get(`${base}?${olderParams.toString()}`);
      return [...sameTs, ...older];
    },
  };
}
