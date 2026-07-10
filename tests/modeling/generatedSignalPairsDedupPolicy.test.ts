import test from "node:test";
import assert from "node:assert/strict";
import {
  STRICT_DEDUP_POLICY_NAME,
  projectGeneratedSignalPairsStrictDedup,
} from "../../lib/modeling/generatedSignalPairsDedupPolicy";
import { getStrictDedupKeyForExportRow, type ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

test("policy name is exposed", () => {
  assert.equal(STRICT_DEDUP_POLICY_NAME, "strict_latest_created_before_resolved");
});

test("selects exactly one row per strict key", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
    { id: "c", condition_id: "c2", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupRows, 2);
  assert.equal(result.dedupedRows.length, 2);
  assert.equal(result.uniqueStrictDedupKeys, 2);
});

test("strict key computation is reused from getStrictDedupKeyForExportRow (same result for identical inputs)", () => {
  const row: ExportRow = { condition_id: "c1", token_id: "t1" };
  // Sanity check: the dedup policy must group rows using exactly the keys
  // getStrictDedupKeyForExportRow would produce -- not a re-implementation.
  assert.equal(getStrictDedupKeyForExportRow(row), "c1::t1");

  const rows: ExportRow[] = [
    { id: "a", conditionId: "c1", tokenId: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);
  // Both rows share the same strict key via aliases, so they must collapse
  // to a single deduped row, proving key reuse (not independent parsing).
  assert.equal(result.dedupRows, 1);
});

test("preferred row is latest created_at that is <= resolved_at", () => {
  const rows: ExportRow[] = [
    {
      id: "a",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
    {
      id: "b",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-03T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupedRows.length, 1);
  assert.equal(result.dedupedRows[0].id, "b");
});

test("a row with created_at > resolved_at is not preferred when a valid before-resolved row exists", () => {
  const rows: ExportRow[] = [
    {
      id: "valid",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-02T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
    {
      id: "after-resolved",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-06T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupedRows[0].id, "valid");
  assert.equal(result.rowsCreatedAfterResolved, 1);
});

test("if all rows for a key are after resolved_at, fall back to latest created_at and count keysWithNoCreatedAtBeforeResolved", () => {
  const rows: ExportRow[] = [
    {
      id: "a",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-06T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
    {
      id: "b",
      condition_id: "c1",
      token_id: "t1",
      created_at: "2026-07-07T00:00:00.000Z",
      resolved_at: "2026-07-05T00:00:00.000Z",
    },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupedRows[0].id, "b");
  assert.equal(result.keysWithNoCreatedAtBeforeResolved, 1);
  assert.equal(result.rowsCreatedAfterResolved, 2);
});

test("rows missing strict key are excluded from dedupedRows and counted", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c2" }, // missing token
    { id: "c" }, // missing both
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.rowsMissingStrictDedupKey, 2);
  assert.equal(result.dedupRows, 1);
  assert.equal(result.dedupedRows.length, 1);
});

test("duplicate rows are counted as droppedDuplicateRows", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
    { id: "c", condition_id: "c1", token_id: "t1", created_at: "2026-07-03T00:00:00.000Z" },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.rawRows, 3);
  assert.equal(result.dedupRows, 1);
  assert.equal(result.droppedDuplicateRows, 2);
});

test("duplicate keys count is reported as keysWithDuplicates", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
    { id: "c", condition_id: "c2", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "d", condition_id: "c2", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
    { id: "e", condition_id: "c3", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.keysWithDuplicates, 2);
});

test("does not mutate input rows", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
  ];
  const snapshot = JSON.parse(JSON.stringify(rows));

  projectGeneratedSignalPairsStrictDedup(rows);

  assert.deepEqual(rows, snapshot);
});

test("row object references are preserved for selected rows", () => {
  const rowB = { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" };
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    rowB,
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupedRows[0], rowB);
});

test("output has no ROI/PnL/profit keys", () => {
  const rows: ExportRow[] = [{ id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" }];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes("\"roi\""));
  assert.ok(!serialized.includes("\"pnl\""));
  assert.ok(!serialized.includes("profit"));
});

test("hasDuplicateStrictKeyRisk is true when droppedDuplicateRows > 0", () => {
  const dupRows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z" },
  ];
  assert.equal(projectGeneratedSignalPairsStrictDedup(dupRows).hasDuplicateStrictKeyRisk, true);

  const cleanRows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "b", condition_id: "c2", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
  ];
  assert.equal(projectGeneratedSignalPairsStrictDedup(cleanRows).hasDuplicateStrictKeyRisk, false);
});

test("stable deterministic tie-break: same key and same created_at prefers lexicographically larger id", () => {
  const rows: ExportRow[] = [
    { id: "aaa", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "zzz", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.dedupedRows[0].id, "zzz");
});

test("stable deterministic tie-break: same key, same created_at, no ids -- preserves original order (first wins)", () => {
  const rowFirst = { condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" };
  const rowSecond = { condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" };
  const result = projectGeneratedSignalPairsStrictDedup([rowFirst, rowSecond]);

  assert.equal(result.dedupedRows[0], rowFirst);
});

test("full diagnostics shape across a mixed fixture", () => {
  const rows: ExportRow[] = [
    { id: "a", condition_id: "c1", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z", resolved_at: "2026-07-05T00:00:00.000Z" },
    { id: "b", condition_id: "c1", token_id: "t1", created_at: "2026-07-02T00:00:00.000Z", resolved_at: "2026-07-05T00:00:00.000Z" },
    { id: "c", condition_id: "c2", token_id: "t1", created_at: "2026-07-01T00:00:00.000Z" },
    { id: "d" }, // missing key
  ];
  const result = projectGeneratedSignalPairsStrictDedup(rows);

  assert.equal(result.policyName, "strict_latest_created_before_resolved");
  assert.equal(result.rawRows, 4);
  assert.equal(result.dedupRows, 2);
  assert.equal(result.uniqueStrictDedupKeys, 2);
  assert.equal(result.droppedDuplicateRows, 1);
  assert.equal(result.rowsMissingStrictDedupKey, 1);
  assert.equal(result.keysWithDuplicates, 1);
  assert.equal(result.hasDuplicateStrictKeyRisk, true);
  assert.ok(Array.isArray(result.dedupedRows));
});
