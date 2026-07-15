// Phase 4B.1 / B1 -- score-component analysis CLI (filesystem runner).
//
// Dry-run default writes zero files; --write-artifacts writes exactly three
// deterministic artifacts atomically with re-read verification and no stale
// temp files. No env, no network, no forward data. Import never auto-runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runScoreComponentAnalysisCli,
  parseScoreComponentAnalysisArgs,
  DEFAULT_SCORE_COMPONENT_VARIANTS,
} from "../../scripts/modeling/strategies/run-score-component-analysis";
import { SCORECARD_MODEL_ORDER } from "../../lib/modeling/historicalModelScorecard";

function makeRow(n: number): Record<string, unknown> {
  const hours = (n % 10) * 0.4 + 0.1;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 70 + (n % 20),
    smart_money_score_num: 40 + (n % 40),
    whale_public_score_num: 30 + (n % 50),
    pre_event_score_num: 55 + (n % 30),
    entry_price_num: 0.25 + (n % 5) * 0.12,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: {
      dataCoverage: 40 + (n % 60),
      gameStartIso: new Date(createdMs + hours * 3_600_000).toISOString(),
    },
  };
}

function corpusJson(n = 120): string {
  return `${JSON.stringify(Array.from({ length: n }, (_, i) => makeRow(i + 1)), null, 2)}\n`;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "score-comp-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "score_component_analysis.json",
  "score_component_analysis.html",
  "score_component_analysis_manifest.json",
];

// ------------------------------------------------------------- arguments

test("defaults are dry-run over the exported scorecard model order", () => {
  const args = parseScoreComponentAnalysisArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.deepEqual(args.variants, [...SCORECARD_MODEL_ORDER]);
  assert.deepEqual(DEFAULT_SCORE_COMPONENT_VARIANTS, [...SCORECARD_MODEL_ORDER]);
});

test("repeated --variant replaces the default set", () => {
  const args = parseScoreComponentAnalysisArgs([
    "--variant",
    "BASELINE_V1_CONTROL",
    "--variant",
    "ALT2_TS_SCORE_GE_65",
  ]);
  assert.deepEqual(args.variants, ["BASELINE_V1_CONTROL", "ALT2_TS_SCORE_GE_65"]);
});

test("explicit paths are honored", () => {
  const args = parseScoreComponentAnalysisArgs(["--input", "a.json", "--classifier", "b.json", "--output-dir", "c"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.classifier, "b.json");
  assert.equal(args.outputDir, "c");
});

test("unknown argument throws", () => assert.throws(() => parseScoreComponentAnalysisArgs(["--nope"])));
test("missing value throws", () => assert.throws(() => parseScoreComponentAnalysisArgs(["--input"])));
test("duplicate variant throws", () =>
  assert.throws(() =>
    parseScoreComponentAnalysisArgs(["--variant", "BASELINE_V1_CONTROL", "--variant", "BASELINE_V1_CONTROL"]),
  ));
test("dry/write conflict throws", () =>
  assert.throws(() => parseScoreComponentAnalysisArgs(["--dry-run", "--write-artifacts"])));
test("unknown variant is rejected", () =>
  assert.throws(() => parseScoreComponentAnalysisArgs(["--variant", "NOT_A_REAL_MODEL"])));

// ------------------------------------------------------------- CLI behavior

test("default dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runScoreComponentAnalysisCli(
      ["--input", input, "--output-dir", outDir, "--variant", "BASELINE_V1_CONTROL"],
      (m) => logs.push(m),
    );
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/);
  });
});

test("write mode creates exactly three artifacts with no stale temp files", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const code = runScoreComponentAnalysisCli(
      ["--input", input, "--output-dir", outDir, "--variant", "BASELINE_V1_CONTROL", "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 0);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [...OUTPUT_FILES].sort());
    assert.equal(files.some((f) => f.includes(".tmp")), false);
  });
});

test("write mode is byte-deterministic on rerun", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const run = () =>
      runScoreComponentAnalysisCli(
        ["--input", input, "--output-dir", outDir, "--variant", "BASELINE_V1_CONTROL", "--write-artifacts"],
        () => {},
      );
    run();
    const first = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    run();
    const second = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    assert.deepEqual(first, second);
  });
});

test("missing input file exits non-zero without writing", () => {
  withTmp((dir) => {
    const outDir = path.join(dir, "out");
    const code = runScoreComponentAnalysisCli(
      ["--input", path.join(dir, "nope.json"), "--output-dir", outDir, "--variant", "BASELINE_V1_CONTROL", "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("importing the module does not auto-run the CLI", async () => {
  // The `if (require.main === module)` guard means importing the script here
  // (as this test already does at the top) must not read the default corpus,
  // write artifacts, or exit the process. A dynamic re-import must resolve to
  // the exported runner function rather than a side-effecting execution.
  const mod = await import("../../scripts/modeling/strategies/run-score-component-analysis");
  assert.equal(typeof mod.runScoreComponentAnalysisCli, "function");
  assert.equal(typeof mod.parseScoreComponentAnalysisArgs, "function");
  // No default-output artifact directory was created as a side effect of import.
  assert.equal(existsSync(path.join("modeling", "local_exports", "score_component_analysis")), false);
});
