export type SyncRow = Record<string, unknown> & { id: string };
export type Watermark = Record<string, string>;

export interface AppendSyncPort<Row extends SyncRow> {
  sourceMaxWatermark(): Promise<Watermark | null>;
  targetMaxWatermark(): Promise<Watermark | null>;
  readCheckpoint(): Promise<Watermark | null>;
  fetchSourcePage(after: Watermark | null): Promise<Row[]>;
  upsertTargetRows(rows: Row[]): Promise<{ newRows: number; updatedRows: number; duplicateN: number }>;
  writeCheckpoint(watermark: Watermark): Promise<void>;
}

export interface AppendSyncResult {
  sourceMaxWatermark: Watermark | null;
  targetBefore: Watermark | null;
  targetAfter: Watermark | null;
  newRows: number;
  updatedRows: number;
  duplicateN: number;
  pages: number;
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

/**
 * Generic bounded append runner. The source port has no write operation by design;
 * clone commit happens before every durable clone-side checkpoint advance.
 */
export async function runAppendSync<Row extends SyncRow>(
  fields: readonly string[],
  maxPages: number,
  port: AppendSyncPort<Row>,
): Promise<AppendSyncResult> {
  const [sourceMaxWatermark, targetBefore, checkpoint] = await Promise.all([
    port.sourceMaxWatermark(),
    port.targetMaxWatermark(),
    port.readCheckpoint(),
  ]);
  let cursor = resolveInitialWatermark(targetBefore, checkpoint, fields);
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
    const applied = await port.upsertTargetRows(rows);
    await port.writeCheckpoint(next);
    cursor = next;
    newRows += applied.newRows;
    updatedRows += applied.updatedRows;
    duplicateN += applied.duplicateN;
    pages += 1;
  }

  if (pages === maxPages && sourceMaxWatermark && cursor && compareWatermarks(cursor, sourceMaxWatermark, fields) < 0) {
    throw new Error("RESEARCH_CLONE_PAGE_BUDGET_EXHAUSTED");
  }

  return {
    sourceMaxWatermark,
    targetBefore,
    targetAfter: await port.targetMaxWatermark(),
    newRows,
    updatedRows,
    duplicateN,
    pages,
  };
}
