import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  materializeGeneratedSignalPairsExportFromText,
  writeGeneratedSignalPairsExportFile,
} from "../../scripts/modeling/strategies/materialize-generated-signal-pairs-export";

const RAW_ROW = {
  id: "a",
  condition_id: "c1",
  token_id: "t1",
  created_at: "2026-07-01T00:00:00.000Z",
  formula_version: "trusted-initial-formula-v1.1",
  signal_result: "won",
  entry_price_num: 0.4,
};

async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "materialize-export-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("accepts raw JSON array string and returns normalized array", () => {
  const text = JSON.stringify([RAW_ROW]);
  const rows = materializeGeneratedSignalPairsExportFromText(text);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], RAW_ROW);
});

test("accepts Supabase wrapper array: [{ generated_signal_pairs_export: '[...]' }]", () => {
  const text = JSON.stringify([{ generated_signal_pairs_export: JSON.stringify([RAW_ROW]) }]);
  const rows = materializeGeneratedSignalPairsExportFromText(text);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], RAW_ROW);
});

test("accepts Supabase wrapper object: { generated_signal_pairs_export: '[...]' }", () => {
  const text = JSON.stringify({ generated_signal_pairs_export: JSON.stringify([RAW_ROW]) });
  const rows = materializeGeneratedSignalPairsExportFromText(text);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], RAW_ROW);
});

test("accepts already-parsed wrapper where generated_signal_pairs_export is an array", () => {
  const text = JSON.stringify({ generated_signal_pairs_export: [RAW_ROW] });
  const rows = materializeGeneratedSignalPairsExportFromText(text);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], RAW_ROW);
});

test("rejects invalid JSON with a safe error", () => {
  assert.throws(
    () => materializeGeneratedSignalPairsExportFromText("not valid json {{{"),
    (error: unknown) => error instanceof Error && !/not valid json/.test(error.message),
  );
});

test("rejects wrapper object without generated_signal_pairs_export", () => {
  const text = JSON.stringify({ some_other_field: "value" });
  assert.throws(() => materializeGeneratedSignalPairsExportFromText(text));
});

test("rejects valid JSON that does not resolve to an array", () => {
  const text = JSON.stringify({ id: "not-an-array-and-no-wrapper-key" });
  assert.throws(() => materializeGeneratedSignalPairsExportFromText(text));
});

test("writes normalized pretty JSON array to output path, creating the directory if missing", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "nested", "export.json");
    writeGeneratedSignalPairsExportFile([RAW_ROW], outputPath);

    const written = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(written);

    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], RAW_ROW);
    // pretty-printed: multi-line, not a single compact line
    assert.ok(written.includes("\n"));
  });
});

test("does not mutate parsed row objects", () => {
  const text = JSON.stringify([RAW_ROW]);
  const rows = materializeGeneratedSignalPairsExportFromText(text);
  const snapshot = JSON.parse(JSON.stringify(rows));

  writeGeneratedSignalPairsExportFile(rows, path.join(tmpdir(), `materialize-mutate-check-${Date.now()}.json`));

  assert.deepEqual(rows, snapshot);
});

test("output written to disk contains no ROI/PnL/profit keys added by the tool", async () => {
  await withTempDir(async (dir) => {
    const outputPath = path.join(dir, "export.json");
    writeGeneratedSignalPairsExportFile([RAW_ROW], outputPath);

    const written = (await readFile(outputPath, "utf8")).toLowerCase();
    assert.ok(!written.includes("\"roi\""));
    assert.ok(!written.includes("\"pnl\""));
    assert.ok(!written.includes("profit"));
  });
});
