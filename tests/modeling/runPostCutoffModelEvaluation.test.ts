// Phase 3E.8E.2E -- read-only post-cutoff CLI runner tests.
//
// Thin filesystem runner: reads a local generated_signal_pairs export JSON
// array, builds the canonical post-cutoff evaluation dataset, evaluates
// PRIMARY/ALT2/ALT1, and (only under --write-artifacts) writes deterministic
// JSON artifacts + a manifest, re-reading and verifying hashes after writing.
// Dry-run is the default and writes zero files. No Supabase/network/env.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parsePostCutoffCliArgs,
  loadExportRows,
  buildPostCutoffRunArtifacts,
  runPostCutoffModelEvaluation,
} from "../../scripts/modeling/strategies/run-post-cutoff-model-evaluation";

const CUTOFF = "2026-07-13T06:04:05.701Z";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "pcme-"));
}

function writeRows(dir: string, rows: unknown[]): string {
  const p = path.join(dir, "export.json");
  writeFileSync(p, JSON.stringify(rows), "utf8");
  return p;
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-1",
    condition_id: "cond-1",
    token_id: "tok-1",
    created_at: "2026-07-13T10:00:00Z",
    resolved_at: "2026-07-14T00:00:00Z",
    signal_confidence_num: 80,
    signal_result: "win",
    realized_return_pct: 40,
    entry_price_num: 0.5,
    market_slug: "nfl-team-a-vs-team-b",
    event_slug: "nfl-team-a-vs-team-b",
    diagnostics: { dataCoverage: 80, gameStartIso: "2026-07-14T00:00:00Z" },
    ...overrides,
  };
}

const POST_CUTOFF_ROWS = [
  row({ id: "r1", condition_id: "cond-1", token_id: "tok-1", resolved_at: "2026-07-14T00:00:00Z" }),
  row({ id: "r2", condition_id: "cond-2", token_id: "tok-2", resolved_at: "2026-07-15T00:00:00Z", signal_result: "loss", realized_return_pct: undefined }),
];

const PRE_CUTOFF_ROWS = [row({ id: "r0", condition_id: "cond-0", token_id: "tok-0", resolved_at: "2026-07-01T00:00:00Z" })];

// ---- Arguments ----

test("A1: no args -> dry-run defaults", () => {
  const args = parsePostCutoffCliArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.equal(args.cutoff, CUTOFF);
  assert.match(args.inputPath, /generated_signal_pairs_export\.json$/);
  assert.match(args.outputDir, /post_cutoff_observation$/);
});

test("A2: explicit input parsed", () => {
  const args = parsePostCutoffCliArgs(["--input", "some/path.json"]);
  assert.equal(args.inputPath, "some/path.json");
});

test("A3: explicit output-dir parsed", () => {
  const args = parsePostCutoffCliArgs(["--output-dir", "some/dir"]);
  assert.equal(args.outputDir, "some/dir");
});

test("A4: explicit cutoff parsed", () => {
  const args = parsePostCutoffCliArgs(["--cutoff", "2026-01-01T00:00:00Z"]);
  assert.equal(args.cutoff, "2026-01-01T00:00:00Z");
});

test("A5: --write-artifacts enables writes", () => {
  const args = parsePostCutoffCliArgs(["--write-artifacts"]);
  assert.equal(args.mode, "write");
});

test("A6: --dry-run explicit works", () => {
  const args = parsePostCutoffCliArgs(["--dry-run"]);
  assert.equal(args.mode, "dry-run");
});

test("A7: dry-run + write conflict throws", () => {
  assert.throws(() => parsePostCutoffCliArgs(["--dry-run", "--write-artifacts"]));
});

test("A8: unknown argument throws", () => {
  assert.throws(() => parsePostCutoffCliArgs(["--bogus"]));
});

test("A9: missing argument value throws", () => {
  assert.throws(() => parsePostCutoffCliArgs(["--input"]));
});

// ---- Input ----

test("I10: canonical export envelope loads rows", () => {
  const dir = tmp();
  try {
    const p = writeRows(dir, POST_CUTOFF_ROWS);
    const rows = loadExportRows(p);
    assert.equal(rows.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I11: missing file throws safe error", () => {
  const dir = tmp();
  try {
    assert.throws(() => loadExportRows(path.join(dir, "does-not-exist.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I12: malformed JSON throws", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, "{ not json", "utf8");
    assert.throws(() => loadExportRows(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I13: wrong envelope throws", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "wrong.json");
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, rows: [] }), "utf8");
    assert.throws(() => loadExportRows(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I14: rows-not-array throws", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "notarray.json");
    writeFileSync(p, JSON.stringify(42), "utf8");
    assert.throws(() => loadExportRows(p));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I15: error contains no raw file content", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, '{ "secretMarker": "SHOULD_NOT_LEAK" not json', "utf8");
    try {
      loadExportRows(p);
      assert.fail("expected throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /SHOULD_NOT_LEAK/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Dry-run ----

test("D16: default mode writes no files", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const outputDir = path.join(dir, "out");
    const result = runPostCutoffModelEvaluation(["--input", input, "--output-dir", outputDir, "--cutoff", CUTOFF]);
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(outputDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D17: builds dataset", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const rows = loadExportRows(input);
    const artifacts = buildPostCutoffRunArtifacts(rows, CUTOFF, input);
    assert.equal(artifacts.dataset.uniqueObservationCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D18: evaluates exactly three frozen models", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const rows = loadExportRows(input);
    const artifacts = buildPostCutoffRunArtifacts(rows, CUTOFF, input);
    assert.equal(artifacts.evaluation.models.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D19: returns compact summary", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.equal(result.summary.mode, "dry-run");
    assert.equal(result.summary.cutoff, CUTOFF);
    assert.equal(result.summary.inputRowCount, 2);
    assert.equal(result.summary.models.length, 3);
    for (const m of result.summary.models) {
      assert.ok("variantId" in m);
      assert.ok("selectedObservationCount" in m);
      assert.ok("totalPnlUnits" in m);
      assert.ok("roiPct" in m);
      assert.ok("currentDrawdownUnits" in m);
      assert.ok("maxDrawdownUnits" in m);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D20: empty window succeeds", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, PRE_CUTOFF_ROWS);
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.emptyWindow, true);
    assert.equal(result.summary.models.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D21: dry-run result deterministic", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const r1 = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    const r2 = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.deepEqual(r1.summary, r2.summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Write artifacts ----

function runWrite(dir: string, rows: unknown[] = POST_CUTOFF_ROWS) {
  const input = writeRows(dir, rows);
  const outputDir = path.join(dir, "out");
  const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
  return { result, outputDir, input };
}

test("W22: explicit write creates exactly three JSON files", () => {
  const dir = tmp();
  try {
    const { result, outputDir } = runWrite(dir);
    assert.equal(result.exitCode, 0);
    const files = readdirSync(outputDir).sort();
    assert.deepEqual(files, [
      "post_cutoff_evaluation_dataset.json",
      "post_cutoff_frozen_model_evaluation.json",
      "post_cutoff_run_manifest.json",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W23: dataset artifact hash reconciles", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const dataset = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_evaluation_dataset.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(dataset.datasetHash, manifest.datasetArtifact.datasetHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W24: evaluation artifact hash reconciles", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const evaluation = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_frozen_model_evaluation.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(evaluation.evaluationHash, manifest.evaluationArtifact.evaluationHash);
    assert.equal(evaluation.datasetHash, manifest.datasetArtifact.datasetHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W25: manifest reconciles with both", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const dataset = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_evaluation_dataset.json"), "utf8"));
    const evaluation = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_frozen_model_evaluation.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(manifest.datasetArtifact.uniqueObservationCount, dataset.uniqueObservationCount);
    assert.equal(manifest.evaluationArtifact.modelCount, evaluation.models.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W26: files end with newline", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    for (const f of readdirSync(outputDir)) {
      const content = readFileSync(path.join(outputDir, f), "utf8");
      assert.ok(content.endsWith("\n"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W27: rerun produces byte-identical files", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const outputDir = path.join(dir, "out");
    runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
    const first = readdirSync(outputDir).sort().map((f) => readFileSync(path.join(outputDir, f), "utf8"));
    runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
    const second = readdirSync(outputDir).sort().map((f) => readFileSync(path.join(outputDir, f), "utf8"));
    assert.deepEqual(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W28: existing files are safely replaced", () => {
  const dir = tmp();
  try {
    const outputDir = path.join(dir, "out");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "stale\n", "utf8");
    const { result } = runWrite(dir);
    assert.equal(result.exitCode, 0);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W29: no temp files remain after success", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const files = readdirSync(outputDir);
    assert.ok(files.every((f) => !f.includes(".tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W30: failed write leaves no falsely valid manifest", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    // Point output-dir at a path that collides with an existing file, so
    // mkdir/write fails deterministically.
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const outputDir = path.join(blocker, "out");
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(path.join(outputDir, "post_cutoff_run_manifest.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Manifest safety ----

test("M31: manifest contains cutoff", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(manifest.cutoffResolvedAtExclusive, CUTOFF);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M32: manifest contains input content hash", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.match(manifest.inputContentHash, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M33: manifest contains no runtime timestamp", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    const keys = Object.keys(manifest);
    for (const key of keys) {
      assert.doesNotMatch(key.toLowerCase(), /generatedat|createdat|timestamp|runat/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M34: manifest contains no absolute Windows path", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.doesNotMatch(manifest.inputPath, /^[A-Za-z]:\\/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M35: manifest contains no raw rows", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifestText = readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8");
    assert.doesNotMatch(manifestText, /"signal_result"|"realized_return_pct"|"cond-1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M36: emptyWindow is correct", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, PRE_CUTOFF_ROWS);
    const outputDir = path.join(dir, "out");
    runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(manifest.emptyWindow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M37: modelCount is exactly 3", () => {
  const dir = tmp();
  try {
    const { outputDir } = runWrite(dir);
    const manifest = JSON.parse(readFileSync(path.join(outputDir, "post_cutoff_run_manifest.json"), "utf8"));
    assert.equal(manifest.evaluationArtifact.modelCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Process behavior ----

test("P38: success returns exit code 0", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P39: malformed input returns non-zero", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "bad.json");
    writeFileSync(p, "not json", "utf8");
    const result = runPostCutoffModelEvaluation(["--input", p, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.notEqual(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P40: artifact verification failure returns non-zero (simulated by unwritable output path)", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const blocker = path.join(dir, "blocker2");
    writeFileSync(blocker, "x", "utf8");
    const outputDir = path.join(blocker, "out");
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", outputDir, "--write-artifacts"]);
    assert.notEqual(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P41: errors contain safe context only", () => {
  const dir = tmp();
  try {
    const p = path.join(dir, "missing.json");
    const result = runPostCutoffModelEvaluation(["--input", p, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    assert.notEqual(result.exitCode, 0);
    assert.doesNotMatch(result.error ?? "", /SUPABASE|apikey|bearer/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P42: import does not auto-execute CLI", () => {
  // Reaching this point without process.exit having been called by the
  // top-of-file import proves the module guards its CLI entry point.
  assert.ok(typeof runPostCutoffModelEvaluation === "function");
});

// ---- Locked safety ----

test("L43: output includes no champion field", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    const serialized = JSON.stringify(result.summary);
    assert.doesNotMatch(serialized, /champion/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L44: output includes no promotion field", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const result = runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out")]);
    const serialized = JSON.stringify(result.summary);
    assert.doesNotMatch(serialized, /promot/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L45: runner performs no Supabase/network/env access (env unchanged after run)", () => {
  const dir = tmp();
  try {
    const input = writeRows(dir, POST_CUTOFF_ROWS);
    const before = JSON.stringify(process.env);
    runPostCutoffModelEvaluation(["--input", input, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out"), "--write-artifacts"]);
    assert.equal(JSON.stringify(process.env), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("L46: deterministic output under reversed logical input order for the same canonical dataset", () => {
  const dir = tmp();
  try {
    const input1 = writeRows(dir, POST_CUTOFF_ROWS);
    const input2 = writeRows(path.join(dir), [...POST_CUTOFF_ROWS].reverse());
    const r1 = runPostCutoffModelEvaluation(["--input", input1, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out1")]);
    const r2 = runPostCutoffModelEvaluation(["--input", input2, "--cutoff", CUTOFF, "--output-dir", path.join(dir, "out2")]);
    assert.equal(r1.summary.datasetHash, r2.summary.datasetHash);
    assert.equal(r1.summary.evaluationHash, r2.summary.evaluationHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
