export type SyncRow = Record<string, unknown> & { id: string };
export type Watermark = Record<string, string>;

/**
 * True for a PostgREST/Postgres "table does not exist" error. Used to let an
 * optional synced table (one introduced after its clone-side schema exists,
 * e.g. a table pending ops/research-clone/*-schema.sql being applied)
 * degrade to a safe no-op instead of failing the whole sync run.
 */
export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PGRST205|42P01|relation .* does not exist/i.test(message);
}

export interface AppendSyncPort<Row extends SyncRow> {
  sourceMaxWatermark(): Promise<Watermark | null>;
  targetMaxWatermark(): Promise<Watermark | null>;
  readCheckpoint(): Promise<Watermark | null>;
  fetchSourcePage(after: Watermark | null): Promise<Row[]>;
  beforeUpsertTargetRows?(rows: Row[]): Promise<void>;
  upsertTargetRows(rows: Row[]): Promise<{ newRows: number; updatedRows: number; duplicateN: number }>;
  writeCheckpoint(watermark: Watermark): Promise<void>;
}

export interface QueueParentRepairPort<Parent extends SyncRow> {
  readExistingReservationIds(ids: readonly string[]): Promise<readonly string[]>;
  fetchSourceReservations(ids: readonly string[]): Promise<Parent[]>;
  upsertTargetReservations(parents: readonly Parent[]): Promise<void>;
}

const QUEUE_PARENT_REPAIR_BATCH_SIZE = 200;

/** Repair only absent queue reservation parents, in bounded batches, before child writes. */
export async function repairQueueParentsBeforeChildren<
  Row extends SyncRow,
  Parent extends SyncRow,
>(rows: readonly Row[], port: QueueParentRepairPort<Parent>): Promise<void> {
  const reservationIds = new Set<string>();
  for (const row of rows) {
    const reservationId = row.reservation_id;
    if (reservationId === null || reservationId === undefined) continue;
    if (typeof reservationId !== "string" || reservationId.length === 0) {
      throw new Error("RESEARCH_CLONE_QUEUE_PARENT_ID_INVALID");
    }
    reservationIds.add(reservationId);
  }
  if (reservationIds.size === 0) return;

  const ids = [...reservationIds];
  const existingIds = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += QUEUE_PARENT_REPAIR_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + QUEUE_PARENT_REPAIR_BATCH_SIZE);
    for (const existingId of await port.readExistingReservationIds(batch)) existingIds.add(existingId);
  }

  const missingIds = ids.filter((id) => !existingIds.has(id));
  if (missingIds.length === 0) return;

  const parentsById = new Map<string, Parent>();
  for (let offset = 0; offset < missingIds.length; offset += QUEUE_PARENT_REPAIR_BATCH_SIZE) {
    const batch = missingIds.slice(offset, offset + QUEUE_PARENT_REPAIR_BATCH_SIZE);
    for (const parent of await port.fetchSourceReservations(batch)) {
      if (batch.includes(parent.id)) parentsById.set(parent.id, parent);
    }
  }
  for (const id of missingIds) {
    if (!parentsById.has(id)) throw new Error(`RESEARCH_CLONE_QUEUE_PARENT_MISSING_FROM_SOURCE:${id}`);
  }

  const parents = missingIds.map((id) => parentsById.get(id)!);
  for (let offset = 0; offset < parents.length; offset += QUEUE_PARENT_REPAIR_BATCH_SIZE) {
    await port.upsertTargetReservations(parents.slice(offset, offset + QUEUE_PARENT_REPAIR_BATCH_SIZE));
  }
}

export interface AppendSyncResult {
  sourceMaxWatermark: Watermark | null;
  targetBefore: Watermark | null;
  targetAfter: Watermark | null;
  newRows: number;
  updatedRows: number;
  duplicateN: number;
  pages: number;
  /**
   * True when the finite page budget was spent before the durable checkpoint
   * caught up to the source. The already-written rows and the per-page
   * checkpoint are durable, so this is a resumable "more to do" signal, not a
   * failure — the next scheduled run continues from the persisted checkpoint.
   */
  pending: boolean;
}

/** Railway evaluates schedules in UTC. Europe/Minsk is fixed UTC+3. */
export function toMinskDailyRailwayCron(): "0 2 * * *" {
  return "0 2 * * *";
}

export function compareWatermarks(
  left: Watermark | null,
  right: Watermark | null,
  fields: readonly string[],
): -1 | 0 | 1 {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  for (const field of fields) {
    const cmp = left[field].localeCompare(right[field]);
    if (cmp < 0) return -1;
    if (cmp > 0) return 1;
  }
  return 0;
}

/** PostgREST composite keyset continuation; callers use it only with indexed, ordered fields. */
export function buildKeysetFilter(watermark: Watermark, fields: readonly string[]): string {
  const clauses: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const equalPrefix = fields.slice(0, index).map((field) => `${field}.eq.${watermark[field]}`);
    clauses.push([...equalPrefix, `${fields[index]}.gt.${watermark[fields[index]]}`].join(","));
  }
  return clauses.map((clause, index) => (index === 0 ? clause : `and(${clause})`)).join(",");
}

export function rowWatermark(row: SyncRow, fields: readonly string[]): Watermark {
  const watermark: Watermark = {};
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`RESEARCH_CLONE_INVALID_WATERMARK:${field}`);
    }
    watermark[field] = value;
  }
  return watermark;
}

/** Never moves a clone checkpoint backwards, even if a legacy target watermark is ahead. */
export function resolveInitialWatermark(
  targetWatermark: Watermark | null,
  checkpoint: Watermark | null,
  fields: readonly string[],
): Watermark | null {
  return compareWatermarks(targetWatermark, checkpoint, fields) >= 0 ? targetWatermark : checkpoint;
}

/** Lowest UUID — the bootstrap tie-breaker for a keyset with no prior position. */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * PREPARE_SAFE_RESEARCH_EXPORT_REPAIR_V1 — empty-clone bootstrap.
 *
 * A clone table with zero rows and no durable checkpoint previously produced a
 * null cursor, and the caller's sourcePage() rejected it with
 * RESEARCH_CLONE_INITIAL_WATERMARK_REQUIRED_*. That made the very state the
 * sync exists to repair — an empty clone table — unrecoverable, and it is why
 * primary_evidence_outbox never received a single row.
 *
 * A null cursor is now only fatal when the caller supplied no explicit start
 * authority. Given an explicit `--since` (or an explicit requested day), the
 * cursor bootstraps one millisecond before that instant so the first
 * strictly-greater read includes a row sitting exactly on the boundary. The
 * bound is explicit and caller-supplied: this never degrades to "scan all
 * history".
 */
export function resolveBootstrapWatermark(
  targetWatermark: Watermark | null,
  checkpoint: Watermark | null,
  fields: readonly string[],
  bootstrapSince: string | null,
): Watermark | null {
  const resolved = resolveInitialWatermark(targetWatermark, checkpoint, fields);
  if (resolved !== null) return resolved;
  if (!bootstrapSince) return null;
  const ms = Date.parse(bootstrapSince);
  if (!Number.isFinite(ms)) throw new Error("RESEARCH_CLONE_BOOTSTRAP_SINCE_INVALID");
  return { [fields[0]]: new Date(ms - 1).toISOString(), [fields[1]]: ZERO_UUID };
}

/**
 * Generic bounded append runner. The source port has no write operation by design;
 * clone commit happens before every durable clone-side checkpoint advance.
 */
export async function runAppendSync<Row extends SyncRow>(
  fields: readonly string[],
  maxPages: number,
  port: AppendSyncPort<Row>,
  bootstrapSince: string | null = null,
): Promise<AppendSyncResult> {
  const [sourceMaxWatermark, targetBefore, checkpoint] = await Promise.all([
    port.sourceMaxWatermark(),
    port.targetMaxWatermark(),
    port.readCheckpoint(),
  ]);
  let cursor = resolveBootstrapWatermark(targetBefore, checkpoint, fields, bootstrapSince);
  let newRows = 0;
  let updatedRows = 0;
  let duplicateN = 0;
  let pages = 0;

  while (pages < maxPages) {
    const rows = await port.fetchSourcePage(cursor);
    if (rows.length === 0) break;
    const next = rowWatermark(rows[rows.length - 1], fields);
    if (cursor && compareWatermarks(next, cursor, fields) <= 0) {
      throw new Error("RESEARCH_CLONE_NON_ADVANCING_KEYSET_PAGE");
    }
    await port.beforeUpsertTargetRows?.(rows);
    const applied = await port.upsertTargetRows(rows);
    await port.writeCheckpoint(next);
    cursor = next;
    newRows += applied.newRows;
    updatedRows += applied.updatedRows;
    duplicateN += applied.duplicateN;
    pages += 1;
  }

  const pending =
    pages === maxPages &&
    sourceMaxWatermark !== null &&
    cursor !== null &&
    compareWatermarks(cursor, sourceMaxWatermark, fields) < 0;

  return {
    sourceMaxWatermark,
    targetBefore,
    targetAfter: await port.targetMaxWatermark(),
    newRows,
    updatedRows,
    duplicateN,
    pages,
    pending,
  };
}

export interface ReconcileSweepPort<Row extends SyncRow> {
  /** Durable resume point of an interrupted sweep, or null to start fresh. */
  readCursor(): Promise<Watermark | null>;
  fetchSourcePage(after: Watermark): Promise<Row[]>;
  beforeApplyRows?(rows: Row[]): Promise<void>;
  applyRows(rows: Row[]): Promise<{ updatedRows: number }>;
  writeCursor(watermark: Watermark): Promise<void>;
}

export interface ReconcileSweepResult {
  updatedRows: number;
  pages: number;
  /** Budget spent with more recent rows still unverified — resume next run. */
  pending: boolean;
  cursor: Watermark | null;
}

/**
 * Bounded reconciliation sweep over the recent window. Re-checks already-cloned
 * rows for source-side updates. A finite page budget is always kept; spending it
 * is a normal resumable outcome (`pending: true`) rather than a fatal error, so
 * one heavy table cannot starve the tables that run after it. The durable cursor
 * only ever moves forward: an interrupted sweep resumes from it, and once the
 * rolling window advances past it the sweep restarts from the window start.
 */
export async function runReconcileSweep<Row extends SyncRow>(
  fields: readonly string[],
  windowStart: Watermark,
  pageSize: number,
  maxPages: number,
  port: ReconcileSweepPort<Row>,
): Promise<ReconcileSweepResult> {
  const savedCursor = await port.readCursor();
  let after: Watermark =
    savedCursor !== null && compareWatermarks(savedCursor, windowStart, fields) > 0 ? savedCursor : windowStart;

  let updatedRows = 0;
  let pages = 0;
  while (pages < maxPages) {
    const rows = await port.fetchSourcePage(after);
    if (rows.length === 0) return { updatedRows, pages, pending: false, cursor: after };
    await port.beforeApplyRows?.(rows);
    const applied = await port.applyRows(rows);
    updatedRows += applied.updatedRows;
    const next = rowWatermark(rows[rows.length - 1], fields);
    if (compareWatermarks(next, after, fields) <= 0) {
      throw new Error("RESEARCH_CLONE_RECONCILE_NON_ADVANCING_PAGE");
    }
    after = next;
    await port.writeCursor(after);
    pages += 1;
    if (rows.length < pageSize) return { updatedRows, pages, pending: false, cursor: after };
  }
  return { updatedRows, pages, pending: true, cursor: after };
}
