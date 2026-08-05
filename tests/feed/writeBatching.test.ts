import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chunkArray,
  SHADOW_DEDUP_QUERY_CHUNK,
  SHADOW_INSERT_CHUNK,
  SHADOW_DEDUP_MAX_QUERIES,
} from "../../lib/feed/writeBatching";

// ── Bounded write batching ─────────────────────────────────────────────────
// A production run proposes ~36k shadow rows over ~18k distinct condition IDs.
// Unbatched, that is a ~1.2 MB dedup query string and a ~40 MB insert body,
// both rejected outright — the whole broad write failed and zero rows landed.
// Pure module: no Supabase import, no network.

test("chunking preserves every item, in order, with nothing duplicated", () => {
  const items = Array.from({ length: 1234 }, (_, i) => i);
  const chunks = chunkArray(items, 100);
  assert.equal(chunks.length, 13);
  assert.deepEqual(chunks.flat(), items, "conservation: no item lost or reordered");
});

test("a final short chunk is emitted rather than dropped", () => {
  const chunks = chunkArray([1, 2, 3, 4, 5], 2);
  assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
});

test("an exact multiple produces no trailing empty chunk", () => {
  const chunks = chunkArray([1, 2, 3, 4], 2);
  assert.deepEqual(chunks, [[1, 2], [3, 4]]);
});

test("an empty input produces no requests", () => {
  assert.deepEqual(chunkArray([], 100), []);
});

test("a misconfigured chunk size never silently drops rows", () => {
  const items = [1, 2, 3];
  assert.deepEqual(chunkArray(items, 0), [[1, 2, 3]]);
  assert.deepEqual(chunkArray(items, -5), [[1, 2, 3]]);
  assert.deepEqual(chunkArray(items, Number.NaN), [[1, 2, 3]]);
});

test("production-scale batch stays within a sane per-request budget", () => {
  // Reproduces the measured production shape that previously failed wholesale.
  const conditionIds = Array.from({ length: 18048 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
  const dedupChunks = chunkArray(conditionIds, SHADOW_DEDUP_QUERY_CHUNK);
  assert.equal(dedupChunks.flat().length, conditionIds.length);
  for (const chunk of dedupChunks) {
    assert.ok(chunk.length <= SHADOW_DEDUP_QUERY_CHUNK);
    // Each dedup request's id list must stay far below typical URL limits.
    assert.ok(chunk.join(",").length < 32_000, "dedup query string must stay bounded");
  }

  const rows = Array.from({ length: 36096 }, (_, i) => ({ i }));
  const insertChunks = chunkArray(rows, SHADOW_INSERT_CHUNK);
  assert.equal(insertChunks.flat().length, rows.length);
  for (const chunk of insertChunks) {
    assert.ok(chunk.length <= SHADOW_INSERT_CHUNK);
  }
});

test("a full production batch fits the indexed dedup budget", () => {
  // 18,048 distinct condition IDs is the measured production shape. The
  // indexed guard leaves room for the current 84-query batch plus growth.
  const conditionIds = Array.from({ length: 18048 }, (_, i) => `cond-${i}`);
  const needed = chunkArray(conditionIds, SHADOW_DEDUP_QUERY_CHUNK).length;
  assert.ok(
    needed <= SHADOW_DEDUP_MAX_QUERIES,
    "a full broad batch must fit the indexed dedup budget",
  );
});

test("a batch beyond the indexed dedup budget still fails closed", () => {
  const conditionIds = Array.from(
    { length: SHADOW_DEDUP_QUERY_CHUNK * SHADOW_DEDUP_MAX_QUERIES + 1 },
    (_, i) => `cond-${i}`,
  );
  const needed = chunkArray(conditionIds, SHADOW_DEDUP_QUERY_CHUNK).length;
  assert.ok(needed > SHADOW_DEDUP_MAX_QUERIES);
});

test("a batch inside the dedup budget is allowed through", () => {
  const conditionIds = Array.from({ length: SHADOW_DEDUP_QUERY_CHUNK * SHADOW_DEDUP_MAX_QUERIES }, (_, i) => `cond-${i}`);
  const needed = chunkArray(conditionIds, SHADOW_DEDUP_QUERY_CHUNK).length;
  assert.ok(needed <= SHADOW_DEDUP_MAX_QUERIES);
});
