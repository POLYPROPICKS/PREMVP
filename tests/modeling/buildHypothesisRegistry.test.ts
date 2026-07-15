// Phase 4C.1 / C1 -- unified hypothesis registry CLI (filesystem runner).
//
// Dry-run default writes zero files; --write-artifacts writes exactly three
// deterministic artifacts atomically with re-read verification and no stale
// temp files. Lineage across the four input evidence artifacts is validated.
// No env, no network, no forward data. Import never auto-runs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runBuildHypothesisRegistryCli,
  parseHypothesisRegistryArgs,
} from "../../scripts/modeling/strategies/build-hypothesis-registry";
import { buildExtendedHistoricalDecomposition, serializeExtendedDecompositionJson } from "../../lib/modeling/extendedHistoricalDecomposition";
import { buildExtendedHistoricalDashboard, serializeExtendedDashboardJson } from "../../lib/modeling/extendedHistoricalDashboard";
import { buildScoreComponentAnalysis, serializeScoreComponentAnalysisJson } from "../../lib/modeling/scoreComponentAnalysis";
import { buildBoundedRoutingExperiments, serializeBoundedRoutingJson, BASE_COMPARATOR_ID } from "../../lib/modeling/boundedRoutingExperiments";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { SCORECARD_MODEL_ORDER } from "../../lib/modeling/historicalModelScorecard";

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

function writeInputs(dir: string): { decomposition: string; dashboard: string; components: string; experiments: string } {
  const decompositionResult = buildExtendedHistoricalDecomposition({
    rawRows: CORPUS,
    classifier,
    requestedVariantIds: [...SCORECARD_MODEL_ORDER],
  });
  const dashboardResult = buildExtendedHistoricalDashboard({ decomposition: decompositionResult });
  const componentsResult = buildScoreComponentAnalysis({
    rawRows: CORPUS,
    classifier,
    requestedVariantIds: [BASE_COMPARATOR_ID],
  });
  const experimentsResult = buildBoundedRoutingExperiments({ rawRows: CORPUS, classifier, evidence: componentsResult });

  const decomposition = path.join(dir, "decomposition.json");
  const dashboard = path.join(dir, "dashboard.json");
  const components = path.join(dir, "components.json");
  const experiments = path.join(dir, "experiments.json");
  writeFileSync(decomposition, serializeExtendedDecompositionJson(decompositionResult));
  writeFileSync(dashboard, serializeExtendedDashboardJson(dashboardResult));
  writeFileSync(components, serializeScoreComponentAnalysisJson(componentsResult));
  writeFileSync(experiments, serializeBoundedRoutingJson(experimentsResult));
  return { decomposition, dashboard, components, experiments };
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "hyp-registry-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = ["hypothesis_registry.json", "hypothesis_registry.html", "hypothesis_registry_manifest.json"];

// ------------------------------------------------------------- arguments

test("defaults are dry-run with canonical default paths", () => {
  const args = parseHypothesisRegistryArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.ok(args.decomposition.endsWith(path.join("extended_historical_decomposition", "extended_historical_decomposition.json")));
  assert.ok(args.dashboard.endsWith(path.join("extended_historical_dashboard", "extended_historical_dashboard.json")));
  assert.ok(args.components.endsWith(path.join("score_component_analysis", "score_component_analysis.json")));
  assert.ok(args.experiments.endsWith(path.join("bounded_routing_experiments", "bounded_routing_experiments.json")));
});

test("explicit paths are honored", () => {
  const args = parseHypothesisRegistryArgs([
    "--decomposition", "a.json", "--dashboard", "b.json", "--components", "c.json", "--experiments", "d.json", "--output-dir", "o",
  ]);
  assert.equal(args.decomposition, "a.json");
  assert.equal(args.dashboard, "b.json");
  assert.equal(args.components, "c.json");
  assert.equal(args.experiments, "d.json");
  assert.equal(args.outputDir, "o");
});

test("unknown argument throws", () => assert.throws(() => parseHypothesisRegistryArgs(["--nope"])));
test("missing value throws", () => assert.throws(() => parseHypothesisRegistryArgs(["--decomposition"])));
test("dry/write conflict throws", () => assert.throws(() => parseHypothesisRegistryArgs(["--dry-run", "--write-artifacts"])));

// ------------------------------------------------------------- CLI behavior

test("default dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const inputs = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runBuildHypothesisRegistryCli(
      [
        "--decomposition", inputs.decomposition,
        "--dashboard", inputs.dashboard,
        "--components", inputs.components,
        "--experiments", inputs.experiments,
        "--output-dir", outDir,
      ],
      (m) => logs.push(m),
    );
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/);
  });
});

test("write mode creates exactly three artifacts with no stale temp files", () => {
  withTmp((dir) => {
    const inputs = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const code = runBuildHypothesisRegistryCli(
      [
        "--decomposition", inputs.decomposition,
        "--dashboard", inputs.dashboard,
        "--components", inputs.components,
        "--experiments", inputs.experiments,
        "--output-dir", outDir,
        "--write-artifacts",
      ],
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
    const inputs = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const run = () =>
      runBuildHypothesisRegistryCli(
        [
          "--decomposition", inputs.decomposition,
          "--dashboard", inputs.dashboard,
          "--components", inputs.components,
          "--experiments", inputs.experiments,
          "--output-dir", outDir,
          "--write-artifacts",
        ],
        () => {},
      );
    run();
    const first = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    run();
    const second = OUTPUT_FILES.map((f) => readFileSync(path.join(outDir, f), "utf8"));
    assert.deepEqual(first, second);
  });
});

test("missing artifact exits non-zero without writing", () => {
  withTmp((dir) => {
    const inputs = writeInputs(dir);
    const outDir = path.join(dir, "out");
    const code = runBuildHypothesisRegistryCli(
      [
        "--decomposition", path.join(dir, "nope.json"),
        "--dashboard", inputs.dashboard,
        "--components", inputs.components,
        "--experiments", inputs.experiments,
        "--output-dir", outDir,
        "--write-artifacts",
      ],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("lineage mismatch exits non-zero", () => {
  withTmp((dir) => {
    const inputs = writeInputs(dir);
    // Corrupt dashboard content so its sourceDecompositionHash no longer matches.
    const badDashboard = path.join(dir, "bad-dashboard.json");
    const parsed = JSON.parse(readFileSync(inputs.dashboard, "utf8"));
    parsed.sourceDecompositionHash = "0".repeat(64);
    writeFileSync(badDashboard, `${JSON.stringify(parsed, null, 2)}\n`);
    const outDir = path.join(dir, "out");
    const code = runBuildHypothesisRegistryCli(
      [
        "--decomposition", inputs.decomposition,
        "--dashboard", badDashboard,
        "--components", inputs.components,
        "--experiments", inputs.experiments,
        "--output-dir", outDir,
        "--write-artifacts",
      ],
      () => {},
    );
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("importing the module does not auto-run the CLI", async () => {
  const mod = await import("../../scripts/modeling/strategies/build-hypothesis-registry");
  assert.equal(typeof mod.runBuildHypothesisRegistryCli, "function");
  assert.equal(typeof mod.parseHypothesisRegistryArgs, "function");
  assert.equal(existsSync(path.join("modeling", "local_exports", "hypothesis_registry")), false);
});
