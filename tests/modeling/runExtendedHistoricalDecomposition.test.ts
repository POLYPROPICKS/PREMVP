// Phase 4A.2/A1 -- extended historical decomposition CLI (filesystem runner).
//
// Dry-run default writes zero files; --write-artifacts writes exactly three
// deterministic artifacts atomically with re-read verification. No env, no
// network, no forward data. Import never auto-runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runExtendedHistoricalDecompositionCli,
  parseExtendedDecompositionArgs,
  DEFAULT_DECOMPOSITION_VARIANTS,
} from "../../scripts/modeling/strategies/run-extended-historical-decomposition";
import { SCORECARD_MODEL_ORDER } from "../../lib/modeling/historicalModelScorecard";

function makeRow(n: number): Record<string, unknown> {
  return {
    id: `id-${String(n).padStart(3, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-01-${String((n % 27) + 2).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    diagnostics: { dataCoverage: 80, gameStartIso: "2024-01-01T10:00:00Z" },
  };
}

function corpusJson(n = 60): string {
  return `${JSON.stringify(Array.from({ length: n }, (_, i) => makeRow(i + 1)), null, 2)}\n`;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ext-decomp-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "extended_historical_decomposition.json",
  "extended_historical_decomposition_manifest.json",
  "extended_historical_decomposition_summary.html",
];

// ---- arguments ----

test("A1: defaults are dry-run over the exported 12-model scorecard order", () => {
  const args = parseExtendedDecompositionArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.deepEqual(args.variants, [...SCORECARD_MODEL_ORDER]);
  assert.deepEqual(DEFAULT_DECOMPOSITION_VARIANTS, [...SCORECARD_MODEL_ORDER]);
});

test("A2: repeated --variant replaces the default set", () => {
  const args = parseExtendedDecompositionArgs(["--variant", "ALT2_TS_SCORE_GE_65", "--variant", "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"]);
  assert.deepEqual(args.variants, ["ALT2_TS_SCORE_GE_65", "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS"]);
});

test("A3: explicit paths are honored", () => {
  const args = parseExtendedDecompositionArgs(["--input", "a.json", "--classifier", "b.json", "--output-dir", "c"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.classifier, "b.json");
  assert.equal(args.outputDir, "c");
});

test("A4: unknown argument throws", () => assert.throws(() => parseExtendedDecompositionArgs(["--nope"])));
test("A5: missing value throws", () => assert.throws(() => parseExtendedDecompositionArgs(["--input"])));
test("A6: duplicate variant throws", () =>
  assert.throws(() => parseExtendedDecompositionArgs(["--variant", "ALT2_TS_SCORE_GE_65", "--variant", "ALT2_TS_SCORE_GE_65"])));
test("A7: dry/write conflict throws", () => assert.throws(() => parseExtendedDecompositionArgs(["--dry-run", "--write-artifacts"])));

// ---- CLI behavior ----

test("B1: default dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runExtendedHistoricalDecompositionCli(
      ["--input", input, "--output-dir", outDir, "--variant", "ALT2_TS_SCORE_GE_65"],
      (m) => logs.push(m),
    );
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/);
  });
});

test("B2: write mode creates exactly three artifacts with no stale temp files", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    const code = runExtendedHistoricalDecompositionCli(
      ["--input", input, "--output-dir", outDir, "--variant", "ALT2_TS_SCORE_GE_65", "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 0);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [...OUTPUT_FILES].sort());
    assert.equal(files.some((f) => f.includes(".tmp")), false);
  });
});

test("B3: rerun produces byte-identical artifacts", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outA = path.join(dir, "a");
    const outB = path.join(dir, "b");
    const argsBase = ["--input", input, "--variant", "ALT2_TS_SCORE_GE_65", "--write-artifacts"];
    runExtendedHistoricalDecompositionCli([...argsBase, "--output-dir", outA], () => {});
    runExtendedHistoricalDecompositionCli([...argsBase, "--output-dir", outB], () => {});
    for (const f of OUTPUT_FILES) {
      assert.equal(readFileSync(path.join(outA, f), "utf8"), readFileSync(path.join(outB, f), "utf8"), f);
    }
  });
});

test("B4: missing input exits non-zero without writing", () => {
  withTmp((dir) => {
    const outDir = path.join(dir, "out");
    const code = runExtendedHistoricalDecompositionCli(
      ["--input", path.join(dir, "nope.json"), "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("B5: invalid JSON exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, "{ nope");
    const code = runExtendedHistoricalDecompositionCli(["--input", input, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B6: unknown variant exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const code = runExtendedHistoricalDecompositionCli(
      ["--input", input, "--variant", "NOT_REAL", "--output-dir", path.join(dir, "o")],
      () => {},
    );
    assert.equal(code, 1);
  });
});

test("B7: written JSON parses and contains the model decomposition plus availability matrix", () => {
  withTmp((dir) => {
    const input = path.join(dir, "corpus.json");
    writeFileSync(input, corpusJson());
    const outDir = path.join(dir, "out");
    runExtendedHistoricalDecompositionCli(
      ["--input", input, "--output-dir", outDir, "--variant", "ALT2_TS_SCORE_GE_65", "--write-artifacts"],
      () => {},
    );
    const parsed = JSON.parse(readFileSync(path.join(outDir, "extended_historical_decomposition.json"), "utf8"));
    assert.equal(parsed.models.length, 1);
    assert.ok(parsed.models[0].dimensionAvailability.length >= 17);
    const manifest = JSON.parse(readFileSync(path.join(outDir, "extended_historical_decomposition_manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(Object.keys(manifest.artifactSha256s).length, 2);
  });
});

test("B8: import does not auto-execute the CLI", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../../scripts/modeling/strategies/run-extended-historical-decomposition.ts"),
    "utf8",
  );
  assert.match(src, /require\.main === module/);
});
