import { createClient } from "@supabase/supabase-js";
import {
  buildKeysetFilter,
  compareWatermarks,
  rowWatermark,
  runAppendSync,
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
type TableName = "generated_signal_pairs" | "generated_signal_research_snapshots" | "night_event_reservations";

type TableSpec = {
  table: TableName;
  fields: readonly [string, string];
  appendOnly: boolean;
  reconciliationStart?: (targetBefore: Watermark, now: Date) => string;
};

type TableEvidence = {
  SOURCE_MAX_WATERMARK: Watermark | null;
  TARGET_BEFORE: Watermark | null;
  TARGET_AFTER: Watermark | null;
  NEW_ROWS: number;
  UPDATED_ROWS: number;
  DUPLICATE_N: number;
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
];

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

async function readCheckpoint(target: Client, spec: TableSpec): Promise<Watermark | null> {
  const { data, error } = await target
    .from("job_runs")
    .select("diagnostics")
    .eq("source", checkpointSource(spec))
    .eq("status", "success")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`RESEARCH_CLONE_CHECKPOINT_READ_${spec.table}:${safeError(error)}`);
  const latest = (data?.[0] ?? {}) as { diagnostics?: unknown };
  return checkpointFromDiagnostics(latest.diagnostics, spec.fields);
}

async function writeCheckpoint(target: Client, spec: TableSpec, watermark: Watermark): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await target.from("job_runs").insert({
    source: checkpointSource(spec),
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

async function existingById(target: Client, spec: TableSpec, rows: SyncRow[]): Promise<Map<string, SyncRow>> {
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) throw new Error(`RESEARCH_CLONE_DUPLICATE_SOURCE_ID_${spec.table}`);
  const { data, error } = await target.from(spec.table).select("*").in("id", ids);
  if (error) throw new Error(`RESEARCH_CLONE_TARGET_READ_${spec.table}:${safeError(error)}`);
  return new Map(((data ?? []) as SyncRow[]).map((row) => [row.id, row]));
}

async function applyRows(target: Client, spec: TableSpec, rows: SyncRow[]) {
  const existing = await existingById(target, spec, rows);
  const newRows = rows.filter((row) => !existing.has(row.id));
  const changedRows = rows.filter((row) => {
    const current = existing.get(row.id);
    return current !== undefined && stableJson(current) !== stableJson(row);
  });
  if (spec.appendOnly && changedRows.length > 0) {
    throw new Error(`RESEARCH_CLONE_APPEND_ONLY_CONFLICT_${spec.table}`);
  }
  const writeRows = [...newRows, ...changedRows];
  if (writeRows.length > 0) {
    const { error } = await target.from(spec.table).upsert(writeRows, { onConflict: "id" });
    if (error) throw new Error(`RESEARCH_CLONE_TARGET_WRITE_${spec.table}:${safeError(error)}`);
  }
  return { newRows: newRows.length, updatedRows: changedRows.length, duplicateN: 0 };
}

async function reconcileRecent(target: Client, source: Client, spec: TableSpec, targetBefore: Watermark | null): Promise<number> {
  if (!spec.reconciliationStart || !targetBefore) return 0;
  const lowerBound = spec.reconciliationStart(targetBefore, new Date());
  let after: Watermark | null = { [spec.fields[0]]: lowerBound, [spec.fields[1]]: "00000000-0000-0000-0000-000000000000" };
  let updatedRows = 0;
  for (let page = 0; page < MAX_RECONCILIATION_PAGES; page += 1) {
    const rows = await sourcePage(source, spec, after);
    if (rows.length === 0) return updatedRows;
    const applied = await applyRows(target, spec, rows);
    updatedRows += applied.updatedRows;
    after = rowWatermark(rows[rows.length - 1], spec.fields);
  }
  throw new Error(`RESEARCH_CLONE_RECONCILIATION_PAGE_BUDGET_EXHAUSTED_${spec.table}`);
}

async function syncTable(target: Client, source: Client, spec: TableSpec): Promise<TableEvidence> {
  const append = await runAppendSync(spec.fields, MAX_APPEND_PAGES, {
    sourceMaxWatermark: () => maxWatermark(source, spec),
    targetMaxWatermark: () => maxWatermark(target, spec),
    readCheckpoint: () => readCheckpoint(target, spec),
    fetchSourcePage: (after) => sourcePage(source, spec, after),
    upsertTargetRows: (rows) => applyRows(target, spec, rows),
    writeCheckpoint: (watermark) => writeCheckpoint(target, spec, watermark),
  });
  const reconciliationUpdates = await reconcileRecent(target, source, spec, append.targetBefore);
  return {
    SOURCE_MAX_WATERMARK: append.sourceMaxWatermark,
    TARGET_BEFORE: append.targetBefore,
    TARGET_AFTER: await maxWatermark(target, spec),
    NEW_ROWS: append.newRows,
    UPDATED_ROWS: append.updatedRows + reconciliationUpdates,
    DUPLICATE_N: append.duplicateN,
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
  for (const spec of SPECS) tables[spec.table] = await syncTable(target, source, spec);
  console.log(JSON.stringify({ TABLES: tables, DURATION_MS: Date.now() - startedAt, STATUS: "SUCCESS" }));
}

main().catch((error) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: safeError(error) }));
  process.exitCode = 1;
});
