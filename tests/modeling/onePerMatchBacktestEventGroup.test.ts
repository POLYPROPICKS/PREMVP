import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runOnePerMatchBacktestFromRows,
  type BacktestRawRow,
} from "../../lib/modeling/onePerMatchBacktest";
import { buildEventGroupKey, groupRowsByEventGroup } from "../../lib/modeling/eventGroupSelection";

// Regression test for Phase 3D.2C: proves runOnePerMatchBacktestFromRows
// still selects exactly one row per computed event group, and that its
// internal grouping is equivalent to the standalone pure helper, both
// before and after wiring lib/modeling/onePerMatchBacktest.ts to use
// buildEventGroupKey internally. No DB access -- this only exercises the
// local-file-writing runOnePerMatchBacktestFromRows path, never
// persistOnePerMatchBacktest.

async function withTempOutDir<T>(fn: (outDir: string) => Promise<T>): Promise<T> {
  const outDir = await mkdtemp(path.join(tmpdir(), "one-per-match-backtest-test-"));
  try {
    return await fn(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function baseRow(overrides: Partial<BacktestRawRow>): BacktestRawRow {
  return {
    created_at: "2026-07-01T00:00:00.000Z",
    resolved_at: "2026-07-01T12:00:00.000Z",
    signal_result: "won",
    entry_price_num: 0.5,
    data_coverage_num: 80,
    ...overrides,
  };
}

test("two rows sharing match_family_key: existing ranking behavior selects the expected row", async () => {
  const rowHighScore = baseRow({
    id: "row-a",
    match_family_key: "Lakers-vs-Celtics",
    condition_id: "0xA1",
    selected_token_id: "tokenA1",
    signal_confidence_num: 90,
    signal_result: "won",
  });
  const rowLowScore = baseRow({
    id: "row-b",
    match_family_key: "Lakers-vs-Celtics",
    condition_id: "0xA2",
    selected_token_id: "tokenA2",
    signal_confidence_num: 40,
    signal_result: "lost",
  });

  await withTempOutDir(async (outDir) => {
    const result = await runOnePerMatchBacktestFromRows([rowHighScore, rowLowScore], outDir);

    assert.equal(result.uniqueEventGroups, 1);
    assert.equal(result.selectedRows, 1);
    assert.equal(result.selectedPicks[0]?.signal_id, "row-a");
  });
});

test("weak match_family_key is ignored and the fallback key is used", async () => {
  const weakRow = baseRow({
    id: "row-c",
    match_family_key: "weak_12345",
    event_slug: "some-event-slug",
    condition_id: "0xC1",
    selected_token_id: "tokenC1",
  });

  const helperResult = buildEventGroupKey(weakRow);
  assert.equal(helperResult.source, "event_slug");

  await withTempOutDir(async (outDir) => {
    const result = await runOnePerMatchBacktestFromRows([weakRow], outDir);

    assert.equal(result.selectedRows, 1);
    assert.equal(result.eventGroupRows[0]?.event_group_key_source, "event_slug");
    assert.equal(result.eventGroupRows[0]?.event_group_key, helperResult.key);
  });
});

test("rows with only condition_id group deterministically into separate groups", async () => {
  const rowD1 = baseRow({ id: "row-d1", condition_id: "0xD1", selected_token_id: "tokenD1" });
  const rowD2 = baseRow({ id: "row-d2", condition_id: "0xD2", selected_token_id: "tokenD2" });

  // condition_fallback intentionally does not normalize casing (matches
  // the original eventGroup() behavior in onePerMatchBacktest.ts).
  assert.equal(buildEventGroupKey(rowD1).key, "condition:0xD1");
  assert.equal(buildEventGroupKey(rowD2).key, "condition:0xD2");
  assert.notEqual(buildEventGroupKey(rowD1).key, buildEventGroupKey(rowD2).key);

  await withTempOutDir(async (outDir) => {
    const result = await runOnePerMatchBacktestFromRows([rowD1, rowD2], outDir);

    assert.equal(result.uniqueEventGroups, 2);
    assert.equal(result.selectedRows, 2);
  });
});

test("helper and backtest grouping produce equivalent group counts on a mixed fixture", async () => {
  const rows: BacktestRawRow[] = [
    baseRow({
      id: "row-a",
      match_family_key: "Lakers-vs-Celtics",
      condition_id: "0xA1",
      selected_token_id: "tokenA1",
      signal_confidence_num: 90,
    }),
    baseRow({
      id: "row-b",
      match_family_key: "Lakers-vs-Celtics",
      condition_id: "0xA2",
      selected_token_id: "tokenA2",
      signal_confidence_num: 40,
      signal_result: "lost",
    }),
    baseRow({
      id: "row-c",
      match_family_key: "weak_12345",
      event_slug: "some-event-slug",
      condition_id: "0xC1",
      selected_token_id: "tokenC1",
    }),
    baseRow({ id: "row-d1", condition_id: "0xD1", selected_token_id: "tokenD1" }),
    baseRow({ id: "row-d2", condition_id: "0xD2", selected_token_id: "tokenD2" }),
  ];

  const helperGroupCount = groupRowsByEventGroup(rows).size;

  await withTempOutDir(async (outDir) => {
    const result = await runOnePerMatchBacktestFromRows(rows, outDir);

    assert.equal(result.uniqueEventGroups, helperGroupCount);
    assert.equal(result.uniqueEventGroups, 4);
    assert.equal(result.selectedRows, 4);
  });
});

test("runOnePerMatchBacktestFromRows never attempts a DB write", async () => {
  const rows: BacktestRawRow[] = [
    baseRow({ id: "row-a", condition_id: "0xA1", selected_token_id: "tokenA1" }),
  ];

  await withTempOutDir(async (outDir) => {
    const result = await runOnePerMatchBacktestFromRows(rows, outDir);

    assert.equal(result.dbStatus.attempted, false);
    assert.equal(result.dbStatus.insertedRun, false);
    assert.equal(result.dbStatus.insertedPicks, 0);
  });
});
