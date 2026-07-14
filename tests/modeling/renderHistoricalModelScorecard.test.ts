// Phase 3E.6 -- historical model scorecard CLI (filesystem runner).
//
// Reads local comparison/manifest/slice JSON, validates, and (only under
// --write-artifacts) writes exactly three deterministic artifacts atomically,
// re-reading and verifying hashes. Dry-run is the default and writes zero
// files. Never reads env, never touches the network, never auto-runs on import.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runRenderHistoricalModelScorecardCli,
  parseHistoricalScorecardArgs,
} from "../../scripts/modeling/strategies/render-historical-model-scorecard";
import {
  LOCKED_EXECUTION_SET,
  BASELINE_VARIANT_ID,
  COMPARISON_ENGINE_VERSION,
  type VariantExecution,
  type VariantMetrics,
} from "../../lib/modeling/historicalFunnelComparison";

const CORPUS_HASH = "a".repeat(64);
const CLASSIFIER_HASH = "b".repeat(64);

function metrics(outputRows: number, pnl: number): VariantMetrics {
  const wins = Math.max(0, Math.floor(outputRows * 0.55));
  const losses = Math.max(0, outputRows - wins);
  return {
    inputRows: 1850,
    outputRows,
    retentionRate: outputRows / 1850,
    removedRows: 1850 - outputRows,
    wins,
    losses,
    voidOrExcludedResultRows: 0,
    winRate: outputRows > 0 ? (wins / outputRows) * 100 : null,
    flatUnitPnl: pnl,
    flatUnitRoi: outputRows > 0 ? (pnl / outputRows) * 100 : null,
    firstResolvedAt: "2026-01-02T00:00:00.000Z",
    lastResolvedAt: "2026-07-10T00:00:00.000Z",
    coveredCalendarDays: 190,
    signalsPerCoveredDay: outputRows / 190,
    uniqueConditionTokenPairs: outputRows,
    uniqueMarkets: outputRows,
    workingEventGroups: Math.max(1, Math.floor(outputRows / 2)),
    maximumSignalsPerWorkingEvent: 3,
    equity: {
      endingPnl: pnl,
      peakPnl: pnl + 5,
      maximumDrawdownUnits: 9,
      maximumDrawdownPctOfPeak: 20,
      longestWinningStreak: 5,
      longestLosingStreak: 3,
    },
  };
}

function executed(variantId: string, outputRows: number, pnl: number): VariantExecution {
  return {
    variantId,
    evaluationStatus: "EXECUTED",
    classifierRunStatus: "RUNNABLE",
    metrics: metrics(outputRows, pnl),
    limitationFlags: [],
    historicalStakePolicy: null,
    normalizedStakePolicy: null,
    blocker: null,
  };
}

const PNL_BY_ID: Record<string, [number, number]> = {
  BASELINE_V1_CONTROL: [1850, 10],
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: [317, 26.7742],
  ALT1_CANONICAL_EVENT_GROUPING: [274, 21.6841],
  ALT2_TS_SCORE_GE_65: [1110, 57.6341],
  ALT2_PY_SCORE_GE_65_SM_LT_85: [800, -5.5],
  ALT3_TS_SCORE_GE_65_EXCLUDE_NBA_NHL: [0, 0],
  ALT3_PY_SCORE_GE_65: [620, 3.2],
  ALT_SM_GUARD_ON_PRIMARY: [290, 18],
  ALT_SM_GUARD_ON_PRIMARY_APPROX: [288, 17.5],
};

function comparisonJson(): string {
  const comparison = {
    corpus: {
      inputRows: 1850,
      firstResolvedAt: "2026-01-02T00:00:00.000Z",
      lastResolvedAt: "2026-07-10T00:00:00.000Z",
      coveredCalendarDays: 190,
    },
    comparisonEngineVersion: COMPARISON_ENGINE_VERSION,
    baselineVariantId: BASELINE_VARIANT_ID,
    executions: LOCKED_EXECUTION_SET.map((id) => executed(id, PNL_BY_ID[id][0], PNL_BY_ID[id][1])),
    inputSha256: CORPUS_HASH,
    classifierSha256: CLASSIFIER_HASH,
  };
  return `${JSON.stringify(comparison, null, 2)}\n`;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "scorecard-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "historical_model_scorecard.json",
  "historical_model_scorecard.html",
  "historical_model_scorecard_manifest.json",
];

test("A1: argument parser defaults to dry-run", () => {
  const args = parseHistoricalScorecardArgs([]);
  assert.equal(args.mode, "dry-run");
});

test("A2: --write-artifacts selects write mode", () => {
  const args = parseHistoricalScorecardArgs(["--write-artifacts"]);
  assert.equal(args.mode, "write");
});

test("A3: --dry-run and --write-artifacts together is a hard error", () => {
  assert.throws(() => parseHistoricalScorecardArgs(["--dry-run", "--write-artifacts"]));
});

test("A4: an unknown flag is rejected", () => {
  assert.throws(() => parseHistoricalScorecardArgs(["--nope"]));
});

test("B5: dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, comparisonJson());
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runRenderHistoricalModelScorecardCli(
      ["--comparison", comparison, "--output-dir", outDir],
      (m) => logs.push(m),
    );
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/i);
  });
});

test("B6: write mode creates exactly three artifacts and leaves no temp files", () => {
  withTmp((dir) => {
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, comparisonJson());
    const outDir = path.join(dir, "out");
    const code = runRenderHistoricalModelScorecardCli(
      ["--comparison", comparison, "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 0);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [...OUTPUT_FILES].sort());
    assert.equal(files.some((f) => f.includes(".tmp")), false);
  });
});

test("B7: written artifacts are byte-identical across two runs (deterministic)", () => {
  withTmp((dir) => {
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, comparisonJson());
    const outA = path.join(dir, "a");
    const outB = path.join(dir, "b");
    runRenderHistoricalModelScorecardCli(["--comparison", comparison, "--output-dir", outA, "--write-artifacts"], () => {});
    runRenderHistoricalModelScorecardCli(["--comparison", comparison, "--output-dir", outB, "--write-artifacts"], () => {});
    for (const f of OUTPUT_FILES) {
      assert.equal(readFileSync(path.join(outA, f), "utf8"), readFileSync(path.join(outB, f), "utf8"), f);
    }
  });
});

test("B8: a missing comparison file exits non-zero without writing", () => {
  withTmp((dir) => {
    const outDir = path.join(dir, "out");
    const code = runRenderHistoricalModelScorecardCli(
      ["--comparison", path.join(dir, "nope.json"), "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("B9: invalid JSON exits non-zero", () => {
  withTmp((dir) => {
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, "{ not json");
    const code = runRenderHistoricalModelScorecardCli(["--comparison", comparison, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B10: a comparison missing a frozen comparator exits non-zero", () => {
  withTmp((dir) => {
    const parsed = JSON.parse(comparisonJson());
    parsed.executions = parsed.executions.filter((e: VariantExecution) => e.variantId !== "ALT2_TS_SCORE_GE_65");
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, `${JSON.stringify(parsed, null, 2)}\n`);
    const code = runRenderHistoricalModelScorecardCli(["--comparison", comparison, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B11: written JSON parses and embeds the corpus hash", () => {
  withTmp((dir) => {
    const comparison = path.join(dir, "comparison.json");
    writeFileSync(comparison, comparisonJson());
    const outDir = path.join(dir, "out");
    runRenderHistoricalModelScorecardCli(["--comparison", comparison, "--output-dir", outDir, "--write-artifacts"], () => {});
    const parsed = JSON.parse(readFileSync(path.join(outDir, "historical_model_scorecard.json"), "utf8"));
    assert.equal(parsed.executive.corpusHash, CORPUS_HASH);
    assert.equal(parsed.executive.strictDedupRowCount, 1850);
  });
});
