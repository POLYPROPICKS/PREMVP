// Phase 3E.5 Commit B -- real runner CLI tests.
//
// The CLI reads only local files, validates the classifier and the row-level
// input, hashes both, runs the comparison, and writes a deterministic
// comparison JSON + reproducible manifest. It never reads env vars, never
// touches Supabase/network, and rejects a corpus-audit summary passed where
// row-level data is required.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runHistoricalFunnelComparisonCli,
  validateRowLevelInput,
} from "../../scripts/modeling/strategies/run-historical-funnel-comparison";

const CLASSIFIER_PATH = path.resolve(__dirname, "../../modeling/model_registry/executable_funnel_classifier.json");

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "hfc-"));
}

function writeRows(dir: string, rows: unknown[]): string {
  const p = path.join(dir, "rows.json");
  writeFileSync(p, JSON.stringify(rows), "utf8");
  return p;
}

const SAMPLE_ROWS = [
  { id: "1", condition_id: "c1", token_id: "t1", resolved_at: "2026-05-01T00:00:00Z", signal_confidence_num: 80, signal_result: "win", realized_return_pct: 40, entry_price_num: 0.5, diagnostics: { dataCoverage: 80 } },
  { id: "2", condition_id: "c2", token_id: "t2", resolved_at: "2026-05-02T00:00:00Z", signal_confidence_num: 60, signal_result: "loss", entry_price_num: 0.5, diagnostics: { dataCoverage: 80 } },
];

test("R1: validateRowLevelInput accepts a real row array", () => {
  const res = validateRowLevelInput(SAMPLE_ROWS);
  assert.equal(res.ok, true);
});

test("R2: validateRowLevelInput rejects a corpus-audit summary object", () => {
  const summary = { schemaVersion: 1, sourceRows: 42088, dedupRows: 1657, formulaVersionBreakdown: [] };
  const res = validateRowLevelInput(summary);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /row-level|array|summary/i);
});

test("R3: CLI writes comparison and manifest JSON", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, SAMPLE_ROWS);
    const outComparison = path.join(dir, "comparison.json");
    const outManifest = path.join(dir, "manifest.json");
    const code = runHistoricalFunnelComparisonCli([
      "--input", input, "--classifier", CLASSIFIER_PATH,
      "--output", outComparison, "--manifest", outManifest,
    ]);
    assert.equal(code, 0);
    assert.ok(existsSync(outComparison));
    assert.ok(existsSync(outManifest));
    const manifest = JSON.parse(readFileSync(outManifest, "utf8"));
    assert.equal(manifest.inputRowCount, 2);
    assert.ok(typeof manifest.runId === "string" && manifest.runId.length > 0);
    assert.ok(typeof manifest.inputSha256 === "string" && manifest.inputSha256.length === 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4: CLI comparison input hash equals manifest input hash", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, SAMPLE_ROWS);
    const outComparison = path.join(dir, "comparison.json");
    const outManifest = path.join(dir, "manifest.json");
    runHistoricalFunnelComparisonCli([
      "--input", input, "--classifier", CLASSIFIER_PATH,
      "--output", outComparison, "--manifest", outManifest,
    ]);
    const manifest = JSON.parse(readFileSync(outManifest, "utf8"));
    const comparison = JSON.parse(readFileSync(outComparison, "utf8"));
    assert.equal(comparison.inputSha256, manifest.inputSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5: CLI rejects a corpus-audit summary passed as row data (non-zero exit)", () => {
  const dir = tmp();
  try {
    const summaryPath = path.join(dir, "summary.json");
    writeFileSync(summaryPath, JSON.stringify({ schemaVersion: 1, sourceRows: 42088, dedupRows: 1657, formulaVersionBreakdown: [] }), "utf8");
    const code = runHistoricalFunnelComparisonCli([
      "--input", summaryPath, "--classifier", CLASSIFIER_PATH,
      "--output", path.join(dir, "c.json"), "--manifest", path.join(dir, "m.json"),
    ]);
    assert.notEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R6: CLI rejects a directory where a file is expected", () => {
  const dir = tmp();
  try {
    const code = runHistoricalFunnelComparisonCli([
      "--input", dir, "--classifier", CLASSIFIER_PATH,
      "--output", path.join(dir, "c.json"), "--manifest", path.join(dir, "m.json"),
    ]);
    assert.notEqual(code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R7: CLI output ordering is deterministic across two runs", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, SAMPLE_ROWS);
    const c1 = path.join(dir, "c1.json");
    const c2 = path.join(dir, "c2.json");
    runHistoricalFunnelComparisonCli(["--input", input, "--classifier", CLASSIFIER_PATH, "--output", c1, "--manifest", path.join(dir, "m1.json")]);
    runHistoricalFunnelComparisonCli(["--input", input, "--classifier", CLASSIFIER_PATH, "--output", c2, "--manifest", path.join(dir, "m2.json")]);
    assert.equal(readFileSync(c1, "utf8"), readFileSync(c2, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R8: CLI default requested set is the locked execution set plus visible skips", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, SAMPLE_ROWS);
    const outComparison = path.join(dir, "comparison.json");
    runHistoricalFunnelComparisonCli(["--input", input, "--classifier", CLASSIFIER_PATH, "--output", outComparison, "--manifest", path.join(dir, "m.json")]);
    const comparison = JSON.parse(readFileSync(outComparison, "utf8"));
    const ids = comparison.executions.map((e: { variantId: string }) => e.variantId);
    assert.ok(ids.includes("BASELINE_V1_CONTROL"));
    assert.ok(ids.includes("MODEL_A"));
    assert.ok(ids.includes("CHAMPION_CURRENT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R9: CLI errors carry the artifact path but no secrets", () => {
  const dir = tmp();
  try {
    const missing = path.join(dir, "does-not-exist.json");
    let captured = "";
    const code = runHistoricalFunnelComparisonCli(
      ["--input", missing, "--classifier", CLASSIFIER_PATH, "--output", path.join(dir, "c.json"), "--manifest", path.join(dir, "m.json")],
      (msg) => { captured += msg; },
    );
    assert.notEqual(code, 0);
    assert.match(captured, /does-not-exist\.json/);
    assert.doesNotMatch(captured, /SUPABASE|apikey|bearer/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: CLI reads no env vars (env unchanged after run)", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, SAMPLE_ROWS);
    const before = JSON.stringify(process.env);
    runHistoricalFunnelComparisonCli(["--input", input, "--classifier", CLASSIFIER_PATH, "--output", path.join(dir, "c.json"), "--manifest", path.join(dir, "m.json")]);
    assert.equal(JSON.stringify(process.env), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
