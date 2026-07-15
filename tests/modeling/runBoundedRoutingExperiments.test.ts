// Phase 4B.2A / B2A -- bounded routing experiments CLI (filesystem runner).
//
// Dry-run default writes zero files; --write-artifacts writes exactly three
// deterministic artifacts atomically with re-read verification and no stale
// temp files. Evidence provenance is validated. No env, no network, no
// forward data. Import never auto-runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runBoundedRoutingExperimentsCli,
  parseBoundedRoutingArgs,
} from "../../scripts/modeling/strategies/run-bounded-routing-experiments";
import { buildScoreComponentAnalysis } from "../../lib/modeling/scoreComponentAnalysis";
import { serializeScoreComponentAnalysisJson } from "../../lib/modeling/scoreComponentAnalysis";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { BASE_COMPARATOR_ID } from "../../lib/modeling/boundedRoutingExperiments";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number): Record<string, unknown> {
  const hours = (n % 8) * 0.5;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 66 + (n % 20),
    entry_price_num: 0.2 + (n % 6) * 0.14,
    metric_formula_version: "v2-lite-growth-safe",
    league: "epl",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    signal_result: n % 3 === 0 ? "loss" : "win",
    realized_return_pct: n % 3 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 70, gameStartIso: new Date(createdMs + hours * 3_600_000).toISOString() },
  };
}

const CORPUS = Array.from({ length: 300 }, (_, i) => makeRow(i + 1));

function writeInputs(dir: string): { input: string; evidence: string } {
  const input = path.join(dir, "corpus.json");
  writeFileSync(input, `${JSON.stringify(CORPUS, null, 2)}\n`);
  const evidenceResult = buildScoreComponentAnalysis({
    rawRows: CORPUS,
    classifier,
    requestedVariantIds: [BASE_COMPARATOR_ID],
  });
  const evidence = path.join(dir, "evidence.json");
  writeFileSync(evidence, serializeScoreComponentAnalysisJson(evidenceResult));
  return { input, evidence };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "bounded-routing-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "bounded_routing_experiments.json",
  "bounded_routing_experiments.html",
  "bounded_routing_experiments_manifest.json",
];

// ------------------------------------------------------------- arguments

test("defaults are dry-run with canonical default paths", () => {
  const args = parseBoundedRoutingArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.ok(args.input.endsWith(path.join("local_exports", "generated_signal_pairs_export.json")));
  assert.ok(args.evidence.endsWith(path.join("score_component_analysis", "score_component_analysis.json")));
});

test("explicit paths are honored", () => {
  const args = parseBoundedRoutingArgs(["--input", "a.json", "--classifier", "b.json", "--evidence", "e.json", "--output-dir", "o"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.classifier, "b.json");
  assert.equal(args.evidence, "e.json");
  assert.equal(args.outputDir, "o");
});

test("unknown argument throws", () => assert.throws(() => parseBoundedRoutingArgs(["--nope"])));
test("missing value throws", () => assert.throws(() => parseBoundedRoutingArgs(["--input"])));
test("dry/write conflict throws", () => assert.throws(() => parseBoundedRoutingArgs(["--dry-run", "--write-artifacts"])));
test("no candidate-selection flags exist", () =>
  assert.throws(() => parseBoundedRoutingArgs(["--candidate", "B2_PRICE_FLOOR_030"])));

// ------------------------------------------------------------- CLI behavior

test("default dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const { input, evidence } = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runBoundedRoutingExperimentsCli(["--input", input, "--evidence", evidence, "--output-dir", outDir], (m) => logs.push(m));
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/);
  });
});

test("write mode creates exactly three artifacts with no stale temp files", () => {
  withTmp((dir) => {
    const { input, evidence } = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const code = runBoundedRoutingExperimentsCli(
      ["--input", input, "--evidence", evidence, "--output-dir", outDir, "--write-artifacts"],
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
    const { input, evidence } = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const run = () =>
      runBoundedRoutingExperimentsCli(["--input", input, "--evidence", evidence, "--output-dir", outDir, "--write-artifacts"], () => {});
    run();
    const first = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    run();
    const second = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    assert.deepEqual(first, second);
  });
});

test("invalid evidence hash exits non-zero and writes nothing", () => {
  withTmp((dir) => {
    const { input } = writeInputs(dir);
    const badEvidence = path.join(dir, "bad-evidence.json");
    writeFileSync(badEvidence, `${JSON.stringify({ contentHash: "bad", corpusSummary: { rawRowCount: 1, strictDedupRowCount: 1, strictDedupPolicy: "x" } }, null, 2)}\n`);
    const outDir = path.join(dir, "out");
    const code = runBoundedRoutingExperimentsCli(
      ["--input", input, "--evidence", badEvidence, "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("corpus/evidence mismatch exits non-zero", () => {
  withTmp((dir) => {
    const { evidence } = writeInputs(dir);
    // Different corpus than the one the evidence was built from.
    const otherInput = path.join(dir, "other.json");
    writeFileSync(otherInput, `${JSON.stringify(CORPUS.slice(0, 50), null, 2)}\n`);
    const outDir = path.join(dir, "out");
    const code = runBoundedRoutingExperimentsCli(
      ["--input", otherInput, "--evidence", evidence, "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("missing input file exits non-zero", () => {
  withTmp((dir) => {
    const { evidence } = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const code = runBoundedRoutingExperimentsCli(
      ["--input", path.join(dir, "nope.json"), "--evidence", evidence, "--output-dir", outDir, "--write-artifacts"],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("importing the module does not auto-run the CLI", async () => {
  const mod = await import("../../scripts/modeling/strategies/run-bounded-routing-experiments");
  assert.equal(typeof mod.runBoundedRoutingExperimentsCli, "function");
  assert.equal(typeof mod.parseBoundedRoutingArgs, "function");
  assert.equal(existsSync(path.join("modeling", "local_exports", "bounded_routing_experiments")), false);
});
