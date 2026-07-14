// Phase 4C -- historical hypothesis batch CLI (filesystem runner).
//
// Reads a local raw corpus + classifier, builds the hypothesis batch via the
// pure lib, and (only under --write-artifacts) writes exactly seven
// deterministic artifacts atomically, re-reading and verifying hashes.
// Dry-run is the default and writes zero files. No env, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runHistoricalHypothesisBatchCli,
  parseHistoricalHypothesisBatchArgs,
} from "../../scripts/modeling/strategies/run-historical-hypothesis-batch";

function makeRow(n: number): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-01-0${(n % 9) + 1}T00:00:00Z`,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 80 },
  };
}

function corpusJson(n = 300): string {
  return `${JSON.stringify(Array.from({ length: n }, (_, i) => makeRow(i + 1)), null, 2)}\n`;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "hyp-batch-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "historical_hypothesis_comparison.json",
  "historical_hypothesis_comparison_manifest.json",
  "historical_hypothesis_scorecard.json",
  "historical_hypothesis_scorecard.html",
  "historical_hypothesis_decision_packet.json",
  "historical_hypothesis_decision_packet.html",
  "historical_hypothesis_batch_manifest.json",
];

// ---- argument parsing ----

test("A1: defaults are dry-run with the Batch 1 variant list and ALT2 base", () => {
  const args = parseHistoricalHypothesisBatchArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.equal(args.base, "ALT2_TS_SCORE_GE_65");
  assert.deepEqual(args.variants, [
    "ALT2_TS_SCORE_GE_65",
    "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
    "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
    "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
  ]);
});

test("A2: repeated --variant replaces the defaults", () => {
  const args = parseHistoricalHypothesisBatchArgs(["--base", "ALT2_TS_SCORE_GE_65", "--variant", "ALT2_TS_SCORE_GE_65", "--variant", "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"]);
  assert.deepEqual(args.variants, ["ALT2_TS_SCORE_GE_65", "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"]);
});

test("A3: explicit --base overrides default", () => {
  const args = parseHistoricalHypothesisBatchArgs(["--base", "ALT1_CANONICAL_EVENT_GROUPING", "--variant", "ALT1_CANONICAL_EVENT_GROUPING", "--variant", "ALT2_TS_SCORE_GE_65"]);
  assert.equal(args.base, "ALT1_CANONICAL_EVENT_GROUPING");
});

test("A4: explicit input/classifier/output-dir paths are honored", () => {
  const args = parseHistoricalHypothesisBatchArgs(["--input", "a.json", "--classifier", "b.json", "--output-dir", "c"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.classifier, "b.json");
  assert.equal(args.outputDir, "c");
});

test("A5: --dry-run and --write-artifacts together throw", () => {
  assert.throws(() => parseHistoricalHypothesisBatchArgs(["--dry-run", "--write-artifacts"]));
});

test("A6: a duplicate --variant throws", () => {
  assert.throws(() =>
    parseHistoricalHypothesisBatchArgs(["--variant", "ALT2_TS_SCORE_GE_65", "--variant", "ALT2_TS_SCORE_GE_65"]),
  );
});

test("A7: base missing from an explicit variant list throws", () => {
  assert.throws(() =>
    parseHistoricalHypothesisBatchArgs(["--base", "ALT2_TS_SCORE_GE_65", "--variant", "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"]),
  );
});

test("A8: an unknown argument throws", () => {
  assert.throws(() => parseHistoricalHypothesisBatchArgs(["--nope"]));
});

test("A9: a flag missing its value throws", () => {
  assert.throws(() => parseHistoricalHypothesisBatchArgs(["--input"]));
});

// ---- dry-run / write behavior ----

test("B10: dry-run writes zero files, exits 0, prints only the summary contract", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", outDir], (m) => logs.push(m));
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    const out = logs.join("");
    assert.match(out, /"mode"/);
    assert.match(out, /"rawRowCount"/);
    assert.match(out, /"strictDedupRowCount"/);
    assert.match(out, /"triageCounts"/);
    assert.doesNotMatch(out, /condition_id/);
  });
});

test("B11: write mode creates exactly seven files with no stale temp files", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const code = runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", outDir, "--write-artifacts"], () => {});
    assert.equal(code, 0);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [...OUTPUT_FILES].sort());
    assert.equal(files.some((f) => f.includes(".tmp")), false);
  });
});

test("B12: written artifacts are byte-identical across two runs", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outA = path.join(dir, "a");
    const outB = path.join(dir, "b");
    runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", outA, "--write-artifacts"], () => {});
    runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", outB, "--write-artifacts"], () => {});
    for (const f of OUTPUT_FILES) {
      assert.equal(readFileSync(path.join(outA, f), "utf8"), readFileSync(path.join(outB, f), "utf8"), f);
    }
  });
});

test("B13: a missing input file exits non-zero without writing", () => {
  withTmp((dir) => {
    const outDir = path.join(dir, "out");
    const code = runHistoricalHypothesisBatchCli(["--input", path.join(dir, "nope.json"), "--output-dir", outDir, "--write-artifacts"], () => {});
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("B14: invalid JSON exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, "{ not json");
    const code = runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B15: an unknown requested variant exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const code = runHistoricalHypothesisBatchCli(
      ["--input", input, "--base", "ALT2_TS_SCORE_GE_65", "--variant", "ALT2_TS_SCORE_GE_65", "--variant", "NOT_REAL", "--output-dir", path.join(dir, "o")],
      () => {},
    );
    assert.equal(code, 1);
  });
});

test("B16: written comparison JSON parses and the decision packet reflects triage for all three batch-1 candidates", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    runHistoricalHypothesisBatchCli(["--input", input, "--output-dir", outDir, "--write-artifacts"], () => {});
    const packet = JSON.parse(readFileSync(path.join(outDir, "historical_hypothesis_decision_packet.json"), "utf8"));
    const ids = packet.candidates.map((c: { candidateId: string }) => c.candidateId).sort();
    assert.deepEqual(ids, [
      "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS",
      "ALT5_TS_SCORE_GE_65_TENNIS_ONLY",
      "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING",
    ]);
    for (const c of packet.candidates) {
      assert.ok(typeof c.triageStatus === "string");
    }
  });
});

test("B17: import does not auto-execute the CLI", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../../scripts/modeling/strategies/run-historical-hypothesis-batch.ts"),
    "utf8",
  );
  assert.match(src, /require\.main === module/);
});
