// R4 production planner source-read regression: a stable keyset must read a
// fixed >6,432-row snapshot completely without offset scans, skips or repeats.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchAllPlanningRowsByKeyset } from "../../lib/executor/buildFireModelCandidates";

type Row = { id: string; created_at: string; sport: string };
type Cursor = { createdAt: string; id: string } | null;

function compareDesc(a: Row, b: Row) {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

function makeSnapshot(total: number): Row[] {
  return Array.from({ length: total }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    // Deliberately share timestamps across rows: id must be the stable tie-break.
    created_at: new Date(Date.parse("2026-08-06T13:00:00.000Z") + Math.floor(i / 37) * 1000).toISOString(),
    sport: i % 4 === 0 ? "soccer" : i % 4 === 1 ? "esports" : i % 4 === 2 ? "baseball" : "cricket",
  })).sort(compareDesc);
}

function after(cursor: Cursor, row: Row) {
  return !cursor || row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.id < cursor.id);
}

function countBySport(rows: Row[]) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.sport] = (counts[row.sport] ?? 0) + 1;
    return counts;
  }, {});
}

function makeKeysetBuilder(rows: Row[], failFirstCursor: Cursor = null) {
  const cursors: Cursor[] = [];
  const attempts = new Map<string, number>();
  return {
    cursors,
    attempts,
    builder(cursor: Cursor) {
      return {
        limit(pageSize: number) {
          return {
            async abortSignal(_signal: AbortSignal) {
              cursors.push(cursor);
              const key = cursor ? `${cursor.createdAt}|${cursor.id}` : "first";
              const attempt = (attempts.get(key) ?? 0) + 1;
              attempts.set(key, attempt);
              if ((cursor === null && failFirstCursor === null) || (cursor !== null && cursor.createdAt === failFirstCursor?.createdAt && cursor.id === failFirstCursor.id)) {
                if (attempt === 1) return { data: null, error: { message: "canceling statement due to statement timeout" } };
              }
              return { data: rows.filter((row) => after(cursor, row)).slice(0, pageSize), error: null };
            },
          };
        },
      };
    },
  };
}

test("R4: keyset source read conserves a 7,001-row multi-sport snapshot through retries without duplicate or skipped pages", async () => {
  const snapshot = makeSnapshot(7_001);
  const fake = makeKeysetBuilder(snapshot);
  const sleeps: number[] = [];
  const result = await fetchAllPlanningRowsByKeyset(fake.builder, {
    stage: "planning_shadow_rows_fetch",
    pageSize: 250,
    retryPolicy: { maxAttempts: 3, backoffMs: (attempt) => attempt, pageTimeoutMs: 1000 },
    sleep: async (ms) => { sleeps.push(ms); },
  }) as Row[];

  assert.deepEqual(result.map((row) => row.id), snapshot.map((row) => row.id), "exact frozen row-ID set and order are conserved");
  assert.equal(new Set(result.map((row) => row.id)).size, snapshot.length, "no duplicated rows");
  assert.equal(fake.attempts.get("first"), 2, "the timed-out first page retries the identical null cursor once");
  assert.equal(sleeps.length, 1, "one bounded retry backoff");
  assert.equal(fake.cursors.filter((cursor) => cursor === null).length, 2, "retry must not advance the first cursor");

  assert.deepEqual(countBySport(result), countBySport(snapshot), "sport attribution denominator is unchanged");
  assert.equal(fake.cursors.filter((cursor) => cursor !== null).length, 28, "7,001 rows at 250/page use 29 successful pages plus one retry");
});
