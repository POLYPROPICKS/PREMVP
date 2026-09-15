import { createClient } from "@supabase/supabase-js";
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

const EXPECTED_PRODUCTION_REF = "nbnldzfsxffztsfrrxqy";
const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const PAGE_SIZE = 250;
// A finite ceiling keeps a damaged source from becoming an unbounded run. The
// initial 2026-08-30 catch-up is expected to need more than a routine daily
// delta, while normal daily runs finish in only a few pages.
const MAX_APPEND_PAGES = 1000;
const MAX_RECONCILIATION_PAGES = 4;
const RECENT_RECONCILIATION_MS = 72 * 60 * 60 * 1000;
const SYNC_VERSION = "research-clone-daily-sync-v1";

// This worker mirrors the source schema row-for-row. The application has no
// generated Supabase Database type, so keep the database boundary explicitly
// dynamic rather than pretending a partial type is exhaustive.
type Client = any;
type TableName =
  | "generated_signal_pairs"
  | "generated_signal_research_snapshots"
  | "night_event_reservations"
  | "primary_evidence_outbox";

type TableSpec = {
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

const SPECS: readonly TableSpec[] = [
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
    // Current authoritative production evidence source (supabase/migrations/
    // 20260908120000_make_current_money_state_gsp_independent.sql). Production
    // money publication now writes here (via publish_primary_signal_observation)
    // independently of generated_signal_pairs, whose write is a non-blocking
    // legacy probe only (gspWriteStatus DEFERRED_TO_PRIMARY_EVIDENCE_OUTBOX in
    // lib/feed/persistPrimarySignalPopulation.ts). Each row is a durable,
    // immutable publication envelope (ON CONFLICT DO NOTHING at the production
    // RPC) — append-only, no reconciliation sweep needed.
    table: "primary_evidence_outbox",
    fields: ["observed_at", "observation_id"],
    appendOnly: true,
    idField: "observation_id",
    optional: true,
  },
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

async function syncTable(target: Client, source: Client, spec: TableSpec): Promise<TableEvidence> {
  const append = await runAppendSync(spec.fields, MAX_APPEND_PAGES, {
    sourceMaxWatermark: () => maxWatermark(source, spec),
    targetMaxWatermark: () => maxWatermark(target, spec),
    readCheckpoint: () => readCheckpoint(target, spec, checkpointSource(spec)),
    fetchSourcePage: (after) => sourcePage(source, spec, after),
    upsertTargetRows: (rows) => applyRows(target, spec, rows),
    writeCheckpoint: (watermark) => writeCheckpoint(target, spec, checkpointSource(spec), watermark),
  });
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

async function main(): Promise<void> {
  const productionUrl = requiredEnv("SUPABASE_URL");
  const productionKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const cloneUrl = requiredEnv("SUPABASE_CLONE_URL");
  const cloneKey = requiredEnv("SUPABASE_CLONE_SERVICE_ROLE_KEY");
  if (projectRef(productionUrl) !== EXPECTED_PRODUCTION_REF || projectRef(cloneUrl) !== EXPECTED_CLONE_REF || productionUrl === cloneUrl) {
    throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  }

  const startedAt = Date.now();
  const source = createClient(productionUrl, productionKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const target = createClient(cloneUrl, cloneKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const tables: Record<TableName, TableEvidence> = {} as Record<TableName, TableEvidence>;
  const schemaPendingTables: TableName[] = [];
  // Each table is synced in turn. A spent page budget on an earlier table is a
  // resumable `*_PENDING` outcome, never a throw, so later tables are not starved
  // and the next scheduled run continues from the durable checkpoints/cursors.
  for (const spec of SPECS) {
    try {
      tables[spec.table] = await syncTable(target, source, spec);
    } catch (error) {
      // An optional table's clone-side schema (ops/research-clone/
      // primary-evidence-outbox-schema.sql) may not be applied yet — a missing
      // table is a safe no-op for that table only, never a cron failure, and
      // never masks a real error on a proven table or a non-schema error here.
      if (spec.optional && isMissingTableError(error)) {
        tables[spec.table] = EMPTY_TABLE_EVIDENCE;
        schemaPendingTables.push(spec.table);
        continue;
      }
      throw error;
    }
  }
  const pendingTables = (Object.keys(tables) as TableName[]).filter(
    (name) => tables[name].APPEND_PENDING || tables[name].RECONCILIATION_PENDING,
  );
  console.log(
    JSON.stringify({
      TABLES: tables,
      PENDING_TABLES: pendingTables,
      SCHEMA_PENDING_TABLES: schemaPendingTables,
      RESUME_PENDING: pendingTables.length > 0,
      DURATION_MS: Date.now() - startedAt,
      STATUS: "SUCCESS",
    }),
  );
  // Do not advance the downstream model-ready boundary until every raw table
  // reached its durable clone checkpoint. The scheduled command uses `&&`, so
  // a resumable partial sync safely suppresses model materialization.
  if (pendingTables.length > 0) process.exitCode = 75;
}

main().catch((error) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: safeError(error) }));
  process.exitCode = 1;
});
