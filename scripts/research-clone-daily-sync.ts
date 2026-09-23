import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import {
  buildKeysetFilter,
  compareWatermarks,
  isMissingTableError,
  rowWatermark,
  runAppendSync,
  runReconcileSweep,
  type SyncRow,
  type Watermark,
} from "../lib/research-clone/dailySync";
import { isEmergencyQuiesceActive, buildEmergencyQuiesceResult } from "../lib/ops/emergencyQuiesce";
import {
  CLONE_EVIDENCE_CONFLICT_KEY,
  CLONE_EVIDENCE_SOURCE_KIND,
  CLONE_EVIDENCE_TABLE,
  RESEARCH_EVIDENCE_V3_MAX_ROWS,
  ZERO_UUID as EVIDENCE_ZERO_UUID,
  bootstrapItemCursor,
  buildEvidencePageV3Args,
  compareItemCursor,
  dedupeNarrowRows,
  itemCursorAdvanced,
  nextItemCursor,
  type EvidenceCursor,
  type EvidenceItemCursor,
  type NarrowEvidenceRow,
} from "../lib/research-clone/researchEvidenceExport";

const EXPECTED_PRODUCTION_REF = "nbnldzfsxffztsfrrxqy";
const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const PAGE_SIZE = 250;
// A finite ceiling keeps a damaged source from becoming an unbounded run. The
// initial 2026-08-30 catch-up is expected to need more than a routine daily
// delta, while normal daily runs finish in only a few pages.
const MAX_APPEND_PAGES = 1000;
const MAX_RECONCILIATION_PAGES = 4;
const RECENT_RECONCILIATION_MS = 72 * 60 * 60 * 1000;
// bet_execution_ledger rows keep receiving fills/settlements well after the
// row is first written, so its reconcile window is the mission-specified 30
// days rather than the 72h window used for the faster-settling tables.
const LEDGER_RECONCILIATION_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_VERSION = "research-clone-daily-sync-v1";

// This worker mirrors the source schema row-for-row. The application has no
// generated Supabase Database type, so keep the database boundary explicitly
// dynamic rather than pretending a partial type is exhaustive.
type Client = any;
type TableName =
  | "generated_signal_pairs"
  | "generated_signal_research_snapshots"
  | "night_event_reservations"
  | "event_execution_queue"
  | "executor_order_events"
  | "bet_execution_ledger";

export type TableSpec = {
  table: TableName;
  fields: readonly [string, string];
  appendOnly: boolean;
  reconciliationStart?: (targetBefore: Watermark, now: Date) => string;
  /**
   * Row identity column used for dedup/upsert. Defaults to "id" — the shape
   * every table synced before RESTORE_RESEARCH_CLONE_CURRENT_EVIDENCE_LINEAGE_V1
   * used. primary_evidence_outbox's primary key is observation_id, so this is
   * the one narrow parameterization needed to reuse the identical proven
   * append-sync path for the current post-GSP evidence source.
   */
  idField?: string;
  /**
   * True only for a table introduced after the three originally-proven synced
   * tables. A missing-table error on an optional table degrades to a safe,
   * explicitly-flagged no-op (mirrors the established
   * scripts/modeling/clone-model-ready-pipeline.ts isSchemaPendingError
   * pattern) instead of failing the whole nightly run — so landing this code
   * ahead of the one-time clone-side schema apply
   * (ops/research-clone/primary-evidence-outbox-schema.sql) cannot regress
   * the three tables that already sync successfully today.
   */
  optional?: boolean;
};

type TableEvidence = {
  SOURCE_MAX_WATERMARK: Watermark | null;
  TARGET_BEFORE: Watermark | null;
  TARGET_AFTER: Watermark | null;
  NEW_ROWS: number;
  UPDATED_ROWS: number;
  DUPLICATE_N: number;
  APPEND_PENDING: boolean;
  RECONCILIATION_PENDING: boolean;
};

export const SPECS: readonly TableSpec[] = [
  {
    table: "generated_signal_pairs",
    fields: ["created_at", "id"],
    appendOnly: false,
    reconciliationStart: (targetBefore, now) => {
      const recent = new Date(now.getTime() - RECENT_RECONCILIATION_MS).toISOString();
      return targetBefore.created_at > recent ? recent : targetBefore.created_at;
    },
  },
  {
    table: "generated_signal_research_snapshots",
    fields: ["snapshot_at", "id"],
    appendOnly: true,
  },
  {
    table: "night_event_reservations",
    fields: ["plan_date_minsk", "id"],
    appendOnly: false,
    reconciliationStart: (targetBefore, now) => {
      const recent = new Date(now.getTime() - RECENT_RECONCILIATION_MS).toISOString().slice(0, 10);
      return targetBefore.plan_date_minsk > recent ? recent : targetBefore.plan_date_minsk;
    },
  },
  {
    table: "event_execution_queue",
    fields: ["queued_at", "id"],
    appendOnly: false,
    reconciliationStart: (targetBefore, now) => {
      const recent = new Date(now.getTime() - RECENT_RECONCILIATION_MS).toISOString();
      return targetBefore.queued_at > recent ? recent : targetBefore.queued_at;
    },
  },
  {
    table: "executor_order_events",
    fields: ["created_at", "id"],
    appendOnly: true,
  },
  {
    table: "bet_execution_ledger",
    fields: ["created_at", "id"],
    appendOnly: false,
    reconciliationStart: (targetBefore, now) => {
      const recent = new Date(now.getTime() - LEDGER_RECONCILIATION_MS).toISOString();
      return targetBefore.created_at > recent ? recent : targetBefore.created_at;
    },
  },
  // primary_evidence_outbox is deliberately NOT a generic raw SYNC_SPEC: the
  // generic sourcePage() reads select("*") (full evidence_rows JSON) with no
  // bound. Current evidence is transported by syncResearchEvidencePage() below
  // through the bounded server-side research_evidence_page_v3() RPC instead.
];

const EMPTY_TABLE_EVIDENCE: TableEvidence = {
  SOURCE_MAX_WATERMARK: null,
  TARGET_BEFORE: null,
  TARGET_AFTER: null,
  NEW_ROWS: 0,
  UPDATED_ROWS: 0,
  DUPLICATE_N: 0,
  APPEND_PENDING: false,
  RECONCILIATION_PENDING: false,
};

function projectRef(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name.startsWith("SUPABASE_CLONE_") ? "REQUIRED_CLONE_WRITE_AUTHORIZATION_UNAVAILABLE" : `MISSING_${name}`);
  return value;
}

function safeError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof Error) return error.message.replace(/([?&](?:key|token|secret|password|apikey)=)[^&\s]+/gi, "$1[redacted]").slice(0, 300);
  return "UNKNOWN_ERROR";
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function checkpointSource(spec: TableSpec): string {
  return `${SYNC_VERSION}:checkpoint:${spec.table}`;
}

/** Durable resume point for an interrupted reconciliation sweep. Kept separate
 * from the append checkpoint so neither can move the other backwards. */
function reconcileCursorSource(spec: TableSpec): string {
  return `${SYNC_VERSION}:reconcile-cursor:${spec.table}`;
}

function checkpointFromDiagnostics(value: unknown, fields: readonly string[]): Watermark | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>).watermark;
  if (!raw || typeof raw !== "object") return null;
  const watermark: Watermark = {};
  for (const field of fields) {
    const candidate = (raw as Record<string, unknown>)[field];
    if (typeof candidate !== "string" || candidate.length === 0) return null;
    watermark[field] = candidate;
  }
  return watermark;
}

async function maxWatermark(client: Client, spec: TableSpec): Promise<Watermark | null> {
  const { data, error } = await client
    .from(spec.table)
    .select(spec.fields.join(","))
    .order(spec.fields[0], { ascending: false })
    .order(spec.fields[1], { ascending: false })
    .limit(1);
  if (error) throw new Error(`RESEARCH_CLONE_MAX_WATERMARK_${spec.table}:${safeError(error)}`);
  const row = data?.[0] as SyncRow | undefined;
  return row ? rowWatermark(row, spec.fields) : null;
}

async function sourcePage(client: Client, spec: TableSpec, after: Watermark | null): Promise<SyncRow[]> {
  if (!after) throw new Error(`RESEARCH_CLONE_INITIAL_WATERMARK_REQUIRED_${spec.table}`);

  // PostgreSQL times out on PostgREST's composite `or=(ts.gt...,and(ts.eq...,id.gt...))`
  // form against production GSP. Preserve the same (timestamp,id) keyset safely
  // in two indexed bounded reads: drain the equal-timestamp tie, then advance by
  // strictly greater timestamp. No unbounded offset or full-table scan is used.
  const tie = await client
    .from(spec.table)
    .select("*")
    .eq(spec.fields[0], after[spec.fields[0]])
    .gt(spec.fields[1], after[spec.fields[1]])
    .order(spec.fields[1], { ascending: true })
    .limit(PAGE_SIZE);
  if (tie.error) throw new Error(`RESEARCH_CLONE_SOURCE_READ_${spec.table}:${safeError(tie.error)}`);
  if ((tie.data ?? []).length > 0) return tie.data as SyncRow[];

  const { data, error } = await client
    .from(spec.table)
    .select("*")
    .gt(spec.fields[0], after[spec.fields[0]])
    .order(spec.fields[0], { ascending: true })
    .order(spec.fields[1], { ascending: true })
    .limit(PAGE_SIZE);
  if (error) throw new Error(`RESEARCH_CLONE_SOURCE_READ_${spec.table}:${safeError(error)}`);
  return (data ?? []) as SyncRow[];
}

async function readCheckpoint(target: Client, spec: TableSpec, source: string): Promise<Watermark | null> {
  const { data, error } = await target
    .from("job_runs")
    .select("diagnostics")
    .eq("source", source)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`RESEARCH_CLONE_CHECKPOINT_READ_${spec.table}:${safeError(error)}`);
  const latest = (data?.[0] ?? {}) as { diagnostics?: unknown };
  return checkpointFromDiagnostics(latest.diagnostics, spec.fields);
}

async function writeCheckpoint(target: Client, spec: TableSpec, source: string, watermark: Watermark): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await target.from("job_runs").insert({
    source,
    formula_version: SYNC_VERSION,
    started_at: now,
    finished_at: now,
    status: "success",
    generated_count: 0,
    rejected_count: 0,
    duration_ms: 0,
    diagnostics: { table: spec.table, watermark },
  });
  if (error) throw new Error(`RESEARCH_CLONE_CHECKPOINT_WRITE_${spec.table}:${safeError(error)}`);
}

function idFieldOf(spec: TableSpec): string {
  return spec.idField ?? "id";
}

function rowId(spec: TableSpec, row: SyncRow): unknown {
  return row[idFieldOf(spec)];
}

async function existingById(target: Client, spec: TableSpec, rows: SyncRow[]): Promise<Map<unknown, SyncRow>> {
  const idField = idFieldOf(spec);
  const ids = rows.map((row) => rowId(spec, row));
  if (new Set(ids).size !== ids.length) throw new Error(`RESEARCH_CLONE_DUPLICATE_SOURCE_ID_${spec.table}`);
  const { data, error } = await target.from(spec.table).select("*").in(idField, ids);
  if (error) throw new Error(`RESEARCH_CLONE_TARGET_READ_${spec.table}:${safeError(error)}`);
  return new Map(((data ?? []) as SyncRow[]).map((row) => [rowId(spec, row), row]));
}

async function applyRows(target: Client, spec: TableSpec, rows: SyncRow[]) {
  const existing = await existingById(target, spec, rows);
  const newRows = rows.filter((row) => !existing.has(rowId(spec, row)));
  const changedRows = rows.filter((row) => {
    const current = existing.get(rowId(spec, row));
    return current !== undefined && stableJson(current) !== stableJson(row);
  });
  if (spec.appendOnly && changedRows.length > 0) {
    throw new Error(`RESEARCH_CLONE_APPEND_ONLY_CONFLICT_${spec.table}`);
  }
  const writeRows = [...newRows, ...changedRows];
  if (writeRows.length > 0) {
    const { error } = await target.from(spec.table).upsert(writeRows, { onConflict: idFieldOf(spec) });
    if (error) throw new Error(`RESEARCH_CLONE_TARGET_WRITE_${spec.table}:${safeError(error)}`);
  }
  return { newRows: newRows.length, updatedRows: changedRows.length, duplicateN: 0 };
}

async function reconcileRecent(
  target: Client,
  source: Client,
  spec: TableSpec,
  targetBefore: Watermark | null,
): Promise<{ updatedRows: number; pending: boolean }> {
  if (!spec.reconciliationStart || !targetBefore) return { updatedRows: 0, pending: false };
  const windowStart: Watermark = {
    [spec.fields[0]]: spec.reconciliationStart(targetBefore, new Date()),
    [spec.fields[1]]: "00000000-0000-0000-0000-000000000000",
  };
  const sweep = await runReconcileSweep(spec.fields, windowStart, PAGE_SIZE, MAX_RECONCILIATION_PAGES, {
    readCursor: () => readCheckpoint(target, spec, reconcileCursorSource(spec)),
    fetchSourcePage: (after) => sourcePage(source, spec, after),
    applyRows: async (rows) => ({ updatedRows: (await applyRows(target, spec, rows)).updatedRows }),
    writeCursor: (watermark) => writeCheckpoint(target, spec, reconcileCursorSource(spec), watermark),
  });
  return { updatedRows: sweep.updatedRows, pending: sweep.pending };
}

/**
 * PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 — explicit bootstrap start authority.
 *
 * `--since <ISO instant>` (or `--day YYYY-MM-DD`, resolved to that Minsk day's
 * 21:00Z-prior boundary) is the ONLY way a table with an empty clone and no
 * durable checkpoint may start. Absent it the previous fail-closed behaviour is
 * unchanged. The bound is always caller-supplied and finite — this never
 * degrades into an unbounded historical scan.
 */
export function resolveBootstrapSinceArg(argv: readonly string[]): string | null {
  const read = (name: string): string | undefined => {
    const eq = argv.find((v) => v.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = read("--since");
  if (since) {
    if (!Number.isFinite(Date.parse(since))) throw new Error("RESEARCH_CLONE_BOOTSTRAP_SINCE_INVALID");
    return new Date(Date.parse(since)).toISOString();
  }
  const day = read("--day");
  if (day) {
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(ms)) throw new Error("RESEARCH_CLONE_BOOTSTRAP_SINCE_INVALID");
    // Europe/Minsk is fixed UTC+3, so a Minsk calendar day starts at 21:00Z the day before.
    return new Date(ms - 3 * 3_600_000).toISOString();
  }
  return null;
}

// ── Bounded narrow research-evidence transport (v3, item-level cursor) ───────
// production primary_evidence_outbox -> research_evidence_page_v4() RPC (max 500
// FLATTENED rows/call, 5s statement timeout, explicit p_until, item-level
// (observed_at, observation_id, item_observation_id) cursor, never returns
// evidence_rows) -> clone research_evidence_page_rows.
//
// The v3 cursor advances to the exact last ITEM returned, so a page that ends
// inside an envelope resumes inside that envelope (an envelope-level cursor over
// flattened rows silently skipped the remainder of such envelopes).

// Separate from the legacy v2 envelope-level checkpoint, which is NOT item-complete.
const EVIDENCE_CHECKPOINT_SOURCE = `${SYNC_VERSION}:checkpoint:${CLONE_EVIDENCE_TABLE}:v3`;
// Explicit repair mode owns its own resumable cursor; it never touches the normal one.
const EVIDENCE_REPAIR_CHECKPOINT_SOURCE = `${SYNC_VERSION}:repair-cursor:${CLONE_EVIDENCE_TABLE}:v3`;
const MAX_EVIDENCE_PAGES = 200; // finite: 200 x 500 rows per normal run
const MAX_REPAIR_EVIDENCE_PAGES = 500; // finite: 500 x 500 rows covers the measured ~194k-row window
const EVIDENCE_UPSERT_CHUNK = 500;

export interface EvidenceRepairOptions {
  sinceIso: string;
  untilIso: string | null;
}

/**
 * `--repair-since <ISO>` [`--repair-until <ISO>`]: explicit, finitely bounded
 * historical repair. Returns null when repair mode is not requested.
 */
export function resolveRepairArgs(argv: readonly string[]): EvidenceRepairOptions | null {
  const read = (name: string): string | undefined => {
    const eq = argv.find((v) => v.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = read("--repair-since");
  const until = read("--repair-until");
  if (!since) {
    if (until) throw new Error("RESEARCH_CLONE_REPAIR_UNTIL_REQUIRES_SINCE");
    return null;
  }
  if (!Number.isFinite(Date.parse(since))) throw new Error("RESEARCH_CLONE_REPAIR_ARG_INVALID");
  if (until !== undefined && !Number.isFinite(Date.parse(until))) throw new Error("RESEARCH_CLONE_REPAIR_ARG_INVALID");
  if (until !== undefined && Date.parse(until) <= Date.parse(since)) throw new Error("RESEARCH_CLONE_REPAIR_ARG_INVALID");
  return {
    sinceIso: new Date(Date.parse(since)).toISOString(),
    untilIso: until !== undefined ? new Date(Date.parse(until)).toISOString() : null,
  };
}

type EvidenceSyncEvidence = {
  MODE: "DAILY" | "REPAIR";
  P_UNTIL: string;
  CURSOR_BEFORE: EvidenceItemCursor | null;
  CURSOR_AFTER: EvidenceItemCursor | null;
  PAGES: number;
  ROWS_WRITTEN: number;
  SKIPPED_NO_ITEM_ID: number;
  APPEND_PENDING: boolean;
  RECONCILIATION_PENDING: false;
};

type EvidenceCheckpoint = {
  cursor: EvidenceItemCursor;
  since: string | null;
  until: string | null;
  complete: boolean;
};

async function readEvidenceCheckpoint(target: Client, source: string): Promise<EvidenceCheckpoint | null> {
  const { data, error } = await target
    .from("job_runs")
    .select("diagnostics")
    .eq("source", source)
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`RESEARCH_CLONE_CHECKPOINT_READ_${CLONE_EVIDENCE_TABLE}:${safeError(error)}`);
  const d = ((data?.[0] ?? {}) as { diagnostics?: Record<string, any> }).diagnostics;
  const wm = d?.watermark;
  if (
    typeof wm?.observed_at === "string" &&
    typeof wm?.observation_id === "string" &&
    typeof wm?.item_observation_id === "string"
  ) {
    return {
      cursor: { observedAt: wm.observed_at, observationId: wm.observation_id, itemObservationId: wm.item_observation_id },
      since: typeof d?.since === "string" ? d.since : null,
      until: typeof d?.until === "string" ? d.until : null,
      complete: d?.complete === true,
    };
  }
  return null;
}

/**
 * Greatest clone envelope position that is strictly BEFORE the clone's newest
 * envelope. The newest envelope may have been only partially written, so it is
 * deliberately re-read (idempotent upsert) rather than trusted as complete.
 */
async function cloneEvidenceStepBackCursor(target: Client): Promise<EvidenceCursor | null> {
  const newest = await target
    .from(CLONE_EVIDENCE_TABLE)
    .select("observed_at,observation_id")
    .order("observed_at", { ascending: false })
    .order("observation_id", { ascending: false })
    .limit(1);
  if (newest.error) throw new Error(`RESEARCH_CLONE_MAX_WATERMARK_${CLONE_EVIDENCE_TABLE}:${safeError(newest.error)}`);
  const top = newest.data?.[0] as { observed_at: string; observation_id: string } | undefined;
  if (!top) return null;
  const prev = await target
    .from(CLONE_EVIDENCE_TABLE)
    .select("observed_at,observation_id")
    .or(`observed_at.lt.${top.observed_at},and(observed_at.eq.${top.observed_at},observation_id.lt.${top.observation_id})`)
    .order("observed_at", { ascending: false })
    .order("observation_id", { ascending: false })
    .limit(1);
  if (prev.error) throw new Error(`RESEARCH_CLONE_MAX_WATERMARK_${CLONE_EVIDENCE_TABLE}:${safeError(prev.error)}`);
  const p = prev.data?.[0] as { observed_at: string; observation_id: string } | undefined;
  return p ? { observedAt: p.observed_at, observationId: p.observation_id } : null;
}

async function writeEvidenceCheckpoint(
  target: Client,
  source: string,
  cursor: EvidenceItemCursor,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await target.from("job_runs").insert({
    source,
    formula_version: SYNC_VERSION,
    started_at: now,
    finished_at: now,
    status: "success",
    generated_count: 0,
    rejected_count: 0,
    duration_ms: 0,
    diagnostics: {
      table: CLONE_EVIDENCE_TABLE,
      watermark: {
        observed_at: cursor.observedAt,
        observation_id: cursor.observationId,
        item_observation_id: cursor.itemObservationId,
      },
      ...extra,
    },
  });
  if (error) throw new Error(`RESEARCH_CLONE_CHECKPOINT_WRITE_${CLONE_EVIDENCE_TABLE}:${safeError(error)}`);
}

export async function syncResearchEvidencePage(
  target: Client,
  source: Client,
  bootstrapSince: string | null,
  repair: EvidenceRepairOptions | null = null,
): Promise<EvidenceSyncEvidence> {
  // ONE fixed run-start instant; every page in a run shares the same upper bound.
  const pUntil = new Date().toISOString();
  let start: EvidenceItemCursor;
  let until = pUntil;
  let maxPages = MAX_EVIDENCE_PAGES;
  let checkpointSource = EVIDENCE_CHECKPOINT_SOURCE;
  let extra: Record<string, unknown> = {};

  if (repair) {
    // Explicit repair: the NORMAL forward checkpoint is never read, moved or reset.
    // Only its own repair cursor (same since, unfinished, compatible until) resumes.
    maxPages = MAX_REPAIR_EVIDENCE_PAGES;
    checkpointSource = EVIDENCE_REPAIR_CHECKPOINT_SOURCE;
    const cp = await readEvidenceCheckpoint(target, EVIDENCE_REPAIR_CHECKPOINT_SOURCE);
    const resume =
      cp !== null &&
      cp.since === repair.sinceIso &&
      !cp.complete &&
      cp.until !== null &&
      (repair.untilIso === null || cp.until === repair.untilIso);
    if (resume && cp) {
      start = cp.cursor;
      until = cp.until as string;
    } else {
      start = bootstrapItemCursor(repair.sinceIso);
      until = repair.untilIso ?? pUntil;
    }
    extra = { since: repair.sinceIso, until };
  } else {
    const checkpoint = await readEvidenceCheckpoint(target, EVIDENCE_CHECKPOINT_SOURCE);
    const cloneBack = await cloneEvidenceStepBackCursor(target);
    const candidates: EvidenceItemCursor[] = [];
    if (checkpoint) candidates.push(checkpoint.cursor);
    // Envelope-level clone position: re-read that envelope from its first item.
    if (cloneBack) candidates.push({ ...cloneBack, itemObservationId: EVIDENCE_ZERO_UUID });
    const chosen = candidates.length
      ? candidates.reduce((a, b) => (compareItemCursor(a, b) >= 0 ? a : b))
      : bootstrapSince
        ? bootstrapItemCursor(bootstrapSince)
        : null;
    if (!chosen) throw new Error("RESEARCH_CLONE_EVIDENCE_CURSOR_UNAVAILABLE_NO_START_AUTHORITY");
    start = chosen;
  }
  let cursor: EvidenceItemCursor = start;

  let pages = 0;
  let rowsWritten = 0;
  let skipped = 0;
  let drained = false;
  while (pages < maxPages) {
    const args = buildEvidencePageV3Args(cursor, until, RESEARCH_EVIDENCE_V3_MAX_ROWS);
    const { data, error } = await source.rpc("research_evidence_page_v4", args);
    if (error) throw new Error(`RESEARCH_CLONE_SOURCE_READ_research_evidence_page_v4:${safeError(error)}`);
    const rows = (data ?? []) as NarrowEvidenceRow[];
    pages++;
    if (rows.length === 0) {
      drained = true;
      break;
    }
    const keyed = rows.filter((r) => !!r.item_observation_id);
    skipped += rows.length - keyed.length;
    const ingestedAt = new Date().toISOString();
    const records = dedupeNarrowRows(keyed).map((r) => ({
      ...r,
      ingested_at: ingestedAt,
      source_kind: CLONE_EVIDENCE_SOURCE_KIND,
    }));
    for (let i = 0; i < records.length; i += EVIDENCE_UPSERT_CHUNK) {
      const { error: writeError } = await target
        .from(CLONE_EVIDENCE_TABLE)
        .upsert(records.slice(i, i + EVIDENCE_UPSERT_CHUNK), { onConflict: CLONE_EVIDENCE_CONFLICT_KEY });
      if (writeError) throw new Error(`RESEARCH_CLONE_APPLY_${CLONE_EVIDENCE_TABLE}:${safeError(writeError)}`);
    }
    rowsWritten += records.length;
    // Advance the cursor and checkpoint ONLY after the page write succeeded.
    const advanced = nextItemCursor(rows, cursor);
    if (!itemCursorAdvanced(cursor, advanced)) throw new Error("RESEARCH_CLONE_EVIDENCE_CURSOR_STALLED");
    cursor = advanced;
    await writeEvidenceCheckpoint(target, checkpointSource, cursor, repair ? { ...extra, complete: false } : extra);
  }
  if (repair && drained) {
    await writeEvidenceCheckpoint(target, checkpointSource, cursor, { ...extra, complete: true });
  }
  return {
    MODE: repair ? "REPAIR" : "DAILY",
    P_UNTIL: until,
    CURSOR_BEFORE: start,
    CURSOR_AFTER: cursor,
    PAGES: pages,
    ROWS_WRITTEN: rowsWritten,
    SKIPPED_NO_ITEM_ID: skipped,
    APPEND_PENDING: !drained,
    RECONCILIATION_PENDING: false,
  };
}

async function syncTable(
  target: Client,
  source: Client,
  spec: TableSpec,
  bootstrapSince: string | null = null,
): Promise<TableEvidence> {
  const append = await runAppendSync(spec.fields, MAX_APPEND_PAGES, {
    sourceMaxWatermark: () => maxWatermark(source, spec),
    targetMaxWatermark: () => maxWatermark(target, spec),
    readCheckpoint: () => readCheckpoint(target, spec, checkpointSource(spec)),
    fetchSourcePage: (after) => sourcePage(source, spec, after),
    upsertTargetRows: (rows) => applyRows(target, spec, rows),
    writeCheckpoint: (watermark) => writeCheckpoint(target, spec, checkpointSource(spec), watermark),
  }, bootstrapSince);
  const reconciliation = await reconcileRecent(target, source, spec, append.targetBefore);
  return {
    SOURCE_MAX_WATERMARK: append.sourceMaxWatermark,
    TARGET_BEFORE: append.targetBefore,
    TARGET_AFTER: await maxWatermark(target, spec),
    NEW_ROWS: append.newRows,
    UPDATED_ROWS: append.updatedRows + reconciliation.updatedRows,
    DUPLICATE_N: append.duplicateN,
    APPEND_PENDING: append.pending,
    RECONCILIATION_PENDING: reconciliation.pending,
  };
}

// MAKE_RESEARCH_CLONE_SYNC_SELF_DIAGNOSTIC_V1 — structured, secret-free causal
// evidence emitted through this script's own console output on every natural
// execution. Never logs URLs, JWTs, service-role keys, headers, or
// evidence_rows payloads -- only table names, counts, timestamps, and the
// existing redacted safeError() codes/messages already used above.

/** The union of stages this run can report. "COMPLETE" means the full sync
 * finished with no unclassified failure (individual tables may still be
 * APPEND_PENDING/RECONCILIATION_PENDING -- that is normal resumable state,
 * not a failure). */
export type SyncStage =
  | "SOURCE_UNREACHABLE"
  | "CLONE_UNREACHABLE"
  | "CLONE_OUTBOX_MISSING"
  | "CLONE_OUTBOX_REACHABLE"
  | "SYNC_READ_FAILURE"
  | "SYNC_WRITE_FAILURE"
  | "CONFIG_FAILURE"
  | "OTHER_FAILURE"
  | "COMPLETE";

/**
 * Classifies an already-redacted safeError() code (never the raw error) into
 * a causal stage, using the exact error-code prefixes this file already
 * throws (RESEARCH_CLONE_SOURCE_READ_*, RESEARCH_CLONE_TARGET_WRITE_*, etc.).
 * Pure and dependency-free so it is directly unit-testable without any live
 * credentials.
 */
export function classifyCausalErrorClass(errorCode: string): SyncStage {
  if (
    errorCode.includes("RUNTIME_TARGET_MISMATCH") ||
    errorCode.startsWith("MISSING_") ||
    errorCode === "REQUIRED_CLONE_WRITE_AUTHORIZATION_UNAVAILABLE"
  ) {
    return "CONFIG_FAILURE";
  }
  if (/_TARGET_WRITE_|_CHECKPOINT_WRITE_/.test(errorCode)) return "SYNC_WRITE_FAILURE";
  if (
    /_SOURCE_READ_|_MAX_WATERMARK_|_TARGET_READ_|_CHECKPOINT_READ_|_DUPLICATE_SOURCE_ID_|_APPEND_ONLY_CONFLICT_|_INITIAL_WATERMARK_REQUIRED_/.test(
      errorCode,
    )
  ) {
    return "SYNC_READ_FAILURE";
  }
  return "OTHER_FAILURE";
}

export interface ReachabilityProbeResult {
  reachable: boolean;
  errorMessageSafe: string | null;
}

/** Cheapest bounded read that proves production is answering requests at all
 * -- reuses generated_signal_pairs, a table this sync already depends on, so
 * no new table dependency is introduced. */
export async function probeSourceReachable(source: Client): Promise<ReachabilityProbeResult> {
  try {
    const { error } = await source.from("generated_signal_pairs").select("id").limit(1);
    if (error) throw new Error(`RESEARCH_CLONE_SOURCE_PROBE:${safeError(error)}`);
    return { reachable: true, errorMessageSafe: null };
  } catch (error) {
    return { reachable: false, errorMessageSafe: safeError(error) };
  }
}

/** Cheapest bounded read that proves the clone is answering requests --
 * reuses job_runs, which this sync's checkpoint read/write already requires
 * unconditionally for every table, so no new table dependency is introduced. */
export async function probeCloneReachable(target: Client): Promise<ReachabilityProbeResult> {
  try {
    const { error } = await target.from("job_runs").select("source").limit(1);
    if (error) throw new Error(`RESEARCH_CLONE_TARGET_PROBE:${safeError(error)}`);
    return { reachable: true, errorMessageSafe: null };
  } catch (error) {
    return { reachable: false, errorMessageSafe: safeError(error) };
  }
}

export interface CloneOutboxDiagnostics {
  tableExists: boolean;
  rowN: number | null;
  latestObservedAt: string | null;
  stage: SyncStage;
  errorMessageSafe: string | null;
}

/**
 * Bounded, dedicated diagnostic read of the clone's primary_evidence_outbox
 * table: an exact head-count (no rows returned) plus a single-row read of
 * the latest observed_at. Never reads evidence_rows. Makes the previously
 * ambiguous "optional table missing -> silent no-op" condition explicitly
 * observable, independent of whether the per-table sync attempt below also
 * hits the same missing-table condition.
 */
export async function probeCloneOutbox(target: Client): Promise<CloneOutboxDiagnostics> {
  try {
    const countRes = await target
      .from("primary_evidence_outbox")
      .select("observation_id", { count: "exact", head: true });
    if (countRes.error) throw new Error(`RESEARCH_CLONE_OUTBOX_PROBE:${safeError(countRes.error)}`);
    const latestRes = await target
      .from("primary_evidence_outbox")
      .select("observed_at")
      .order("observed_at", { ascending: false })
      .limit(1);
    if (latestRes.error) throw new Error(`RESEARCH_CLONE_OUTBOX_PROBE:${safeError(latestRes.error)}`);
    const latest = (latestRes.data?.[0] as { observed_at?: string } | undefined)?.observed_at ?? null;
    return {
      tableExists: true,
      rowN: countRes.count ?? 0,
      latestObservedAt: latest,
      stage: "CLONE_OUTBOX_REACHABLE",
      errorMessageSafe: null,
    };
  } catch (error) {
    if (isMissingTableError(error)) {
      return {
        tableExists: false,
        rowN: null,
        latestObservedAt: null,
        stage: "CLONE_OUTBOX_MISSING",
        errorMessageSafe: null,
      };
    }
    const code = safeError(error);
    return {
      tableExists: false,
      rowN: null,
      latestObservedAt: null,
      stage: classifyCausalErrorClass(code),
      errorMessageSafe: code,
    };
  }
}

interface SelfDiagnostics {
  SYNC_STAGE: SyncStage;
  SOURCE_REACHABLE: boolean;
  CLONE_REACHABLE: boolean;
  CLONE_OUTBOX_TABLE_EXISTS: boolean;
  CLONE_OUTBOX_ROW_N: number | null;
  CLONE_OUTBOX_LATEST_OBSERVED_AT: string | null;
  CAUSAL_ERROR_CLASS: SyncStage | null;
  CAUSAL_ERROR_MESSAGE_SAFE: string | null;
  SCHEMA_PENDING_TABLES: TableName[];
}

function initialDiagnostics(): SelfDiagnostics {
  return {
    SYNC_STAGE: "SOURCE_UNREACHABLE",
    SOURCE_REACHABLE: false,
    CLONE_REACHABLE: false,
    CLONE_OUTBOX_TABLE_EXISTS: false,
    CLONE_OUTBOX_ROW_N: null,
    CLONE_OUTBOX_LATEST_OBSERVED_AT: null,
    CAUSAL_ERROR_CLASS: null,
    CAUSAL_ERROR_MESSAGE_SAFE: null,
    SCHEMA_PENDING_TABLES: [],
  };
}

export async function main(): Promise<void> {
  // EMERGENCY_QUIESCE_PROD_DB_BACKGROUND_LOAD_V1: first thing this entrypoint
  // does, before any env resolution or Supabase client creation. This is the
  // ONLY step of the research-clone-daily-sync Railway startCommand that
  // reads production (nbnldzfsxffztsfrrxqy) -- the model-ready steps that
  // follow it read only the research clone. Selective quiesce via
  // EMERGENCY_QUIESCE_SCOPES=research-clone-sync (or the global
  // EMERGENCY_QUIESCE=1) stops this production read without touching
  // Reservation/Rebalance, which are separate guarded entrypoints.
  if (isEmergencyQuiesceActive("research-clone-sync")) {
    console.log(`[research-clone-daily-sync] ${JSON.stringify(buildEmergencyQuiesceResult("research-clone-sync"))}`);
    return;
  }
  const diagnostics = initialDiagnostics();
  const startedAt = Date.now();
  try {
    const productionUrl = requiredEnv("SUPABASE_URL");
    const productionKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const cloneUrl = requiredEnv("SUPABASE_CLONE_URL");
    const cloneKey = requiredEnv("SUPABASE_CLONE_SERVICE_ROLE_KEY");
    if (projectRef(productionUrl) !== EXPECTED_PRODUCTION_REF || projectRef(cloneUrl) !== EXPECTED_CLONE_REF || productionUrl === cloneUrl) {
      throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
    }

    const source = createClient(productionUrl, productionKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const target = createClient(cloneUrl, cloneKey, { auth: { autoRefreshToken: false, persistSession: false } });

    // Explicit preflight diagnostics, in causal order: production
    // reachability, then clone reachability, then the specific
    // primary_evidence_outbox existence/count/watermark check that was
    // previously an ambiguous silent no-op. Each stops the run early with a
    // precise SYNC_STAGE rather than letting an unreachable dependency
    // surface as a confusing mid-loop stack trace.
    const sourceProbe = await probeSourceReachable(source);
    diagnostics.SOURCE_REACHABLE = sourceProbe.reachable;
    if (!sourceProbe.reachable) {
      diagnostics.SYNC_STAGE = "SOURCE_UNREACHABLE";
      diagnostics.CAUSAL_ERROR_CLASS = "SOURCE_UNREACHABLE";
      diagnostics.CAUSAL_ERROR_MESSAGE_SAFE = sourceProbe.errorMessageSafe;
      console.error(JSON.stringify({ STATUS: "FAILED", DURATION_MS: Date.now() - startedAt, ...diagnostics }));
      process.exitCode = 1;
      return;
    }

    const cloneProbe = await probeCloneReachable(target);
    diagnostics.CLONE_REACHABLE = cloneProbe.reachable;
    if (!cloneProbe.reachable) {
      diagnostics.SYNC_STAGE = "CLONE_UNREACHABLE";
      diagnostics.CAUSAL_ERROR_CLASS = "CLONE_UNREACHABLE";
      diagnostics.CAUSAL_ERROR_MESSAGE_SAFE = cloneProbe.errorMessageSafe;
      console.error(JSON.stringify({ STATUS: "FAILED", DURATION_MS: Date.now() - startedAt, ...diagnostics }));
      process.exitCode = 1;
      return;
    }

    const outboxProbe = await probeCloneOutbox(target);
    diagnostics.CLONE_OUTBOX_TABLE_EXISTS = outboxProbe.tableExists;
    diagnostics.CLONE_OUTBOX_ROW_N = outboxProbe.rowN;
    diagnostics.CLONE_OUTBOX_LATEST_OBSERVED_AT = outboxProbe.latestObservedAt;
    diagnostics.SYNC_STAGE = outboxProbe.stage;
    if (outboxProbe.stage !== "CLONE_OUTBOX_REACHABLE" && outboxProbe.stage !== "CLONE_OUTBOX_MISSING") {
      diagnostics.CAUSAL_ERROR_CLASS = outboxProbe.stage;
      diagnostics.CAUSAL_ERROR_MESSAGE_SAFE = outboxProbe.errorMessageSafe;
      console.error(JSON.stringify({ STATUS: "FAILED", DURATION_MS: Date.now() - startedAt, ...diagnostics }));
      process.exitCode = 1;
      return;
    }

    const tables: Record<TableName, TableEvidence> = {} as Record<TableName, TableEvidence>;
    const schemaPendingTables: TableName[] = [];
    const bootstrapSince = resolveBootstrapSinceArg(process.argv);
    const repair = resolveRepairArgs(process.argv);
    if (repair) {
      // Explicit bounded historical repair: narrow evidence only, own repair cursor.
      const repaired = await syncResearchEvidencePage(target, source, bootstrapSince, repair);
      console.log(
        JSON.stringify({
          RESEARCH_EVIDENCE_PAGE: repaired,
          PENDING_TABLES: repaired.APPEND_PENDING ? [CLONE_EVIDENCE_TABLE] : [],
          RESUME_PENDING: repaired.APPEND_PENDING,
          DURATION_MS: Date.now() - startedAt,
          STATUS: "SUCCESS",
          ...diagnostics,
          SYNC_STAGE: "COMPLETE",
        }),
      );
      if (repaired.APPEND_PENDING) process.exitCode = 75;
      return;
    }
    // Each table is synced in turn. A spent page budget on an earlier table is a
    // resumable `*_PENDING` outcome, never a throw, so later tables are not starved
    // and the next scheduled run continues from the durable checkpoints/cursors.
    for (const spec of SPECS) {
      try {
        tables[spec.table] = await syncTable(target, source, spec, bootstrapSince);
      } catch (error) {
        // An optional table's clone-side schema (ops/research-clone/
        // primary-evidence-outbox-schema.sql) may not be applied yet — a missing
        // table is a safe no-op for that table only, never a cron failure, and
        // never masks a real error on a proven table or a non-schema error here.
        // (The dedicated outboxProbe above already made this condition
        // explicitly observable via SYNC_STAGE/CLONE_OUTBOX_TABLE_EXISTS; this
        // still degrades gracefully so partial-schema deploys never crash.)
        if (spec.optional && isMissingTableError(error)) {
          tables[spec.table] = EMPTY_TABLE_EVIDENCE;
          schemaPendingTables.push(spec.table);
          continue;
        }
        throw error;
      }
    }
    diagnostics.SCHEMA_PENDING_TABLES = schemaPendingTables;
    const researchEvidence = await syncResearchEvidencePage(target, source, bootstrapSince);
    const pendingTables: string[] = (Object.keys(tables) as TableName[]).filter(
      (name) => tables[name].APPEND_PENDING || tables[name].RECONCILIATION_PENDING,
    );
    if (researchEvidence.APPEND_PENDING) pendingTables.push(CLONE_EVIDENCE_TABLE);
    console.log(
      JSON.stringify({
        TABLES: tables,
        RESEARCH_EVIDENCE_PAGE: researchEvidence,
        PENDING_TABLES: pendingTables,
        RESUME_PENDING: pendingTables.length > 0,
        DURATION_MS: Date.now() - startedAt,
        STATUS: "SUCCESS",
        ...diagnostics,
        SYNC_STAGE: "COMPLETE",
      }),
    );
    // Do not advance the downstream model-ready boundary until every raw table
    // reached its durable clone checkpoint. The scheduled command uses `&&`, so
    // a resumable partial sync safely suppresses model materialization.
    if (pendingTables.length > 0) process.exitCode = 75;
  } catch (error) {
    const code = safeError(error);
    diagnostics.CAUSAL_ERROR_CLASS = classifyCausalErrorClass(code);
    diagnostics.CAUSAL_ERROR_MESSAGE_SAFE = code;
    diagnostics.SYNC_STAGE = diagnostics.CAUSAL_ERROR_CLASS;
    console.error(JSON.stringify({ STATUS: "FAILED", DURATION_MS: Date.now() - startedAt, ...diagnostics }));
    process.exitCode = 1;
  }
}

// CLI entry-point guard: run only when this file is the invoked script, not
// when imported (e.g. by regression tests exercising the pure diagnostic
// classifier/probes above without live credentials).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Defensive last-resort net; main() already catches and reports internally.
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: safeError(error) }));
    process.exitCode = 1;
  });
}
