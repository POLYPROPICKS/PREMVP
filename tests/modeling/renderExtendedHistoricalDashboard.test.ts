// Phase A2 -- extended historical dashboard CLI (filesystem runner).
//
// Reads the local A1 decomposition JSON, builds the dashboard via the pure
// lib, and (only under --write-artifacts) writes exactly three deterministic
// artifacts atomically with re-read verification. Dry-run is the default and
// writes zero files. No raw corpus input required. No env, no network.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runRenderExtendedHistoricalDashboardCli,
  parseExtendedDashboardArgs,
} from "../../scripts/modeling/strategies/render-extended-historical-dashboard";
import { buildExtendedHistoricalDecomposition, serializeExtendedDecompositionJson } from "../../lib/modeling/extendedHistoricalDecomposition";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number): Record<string, unknown> {
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-01-${String((n % 27) + 2).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: n % 4 === 0 ? "loss" : "win",
    realized_return_pct: n % 4 === 0 ? -100 : 40,
    metric_formula_version: "v2-lite-growth-safe",
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    diagnostics: { dataCoverage: 80, gameStartIso: "2024-01-01T10:00:00Z" },
  };
}

function decompositionJson(n = 60): string {
  const rows = Array.from({ length: n }, (_, i) => makeRow(i + 1));
  const decomp = buildExtendedHistoricalDecomposition({
    rawRows: rows,
    classifier,
    requestedVariantIds: ["ALT2_TS_SCORE_GE_65", "BASELINE_V1_CONTROL"],
  });
  return serializeExtendedDecompositionJson(decomp);
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "ext-dash-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OUTPUT_FILES = [
  "extended_historical_dashboard.json",
  "extended_historical_dashboard.html",
  "extended_historical_dashboard_manifest.json",
];

// ---- arguments ----

test("A1: defaults are dry-run with the canonical A1 default path", () => {
  const args = parseExtendedDashboardArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.match(args.input, /extended_historical_decomposition\.json$/);
});

test("A2: explicit paths are honored", () => {
  const args = parseExtendedDashboardArgs(["--input", "a.json", "--output-dir", "b"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.outputDir, "b");
});

test("A3: unknown argument throws", () => assert.throws(() => parseExtendedDashboardArgs(["--nope"])));
test("A4: missing value throws", () => assert.throws(() => parseExtendedDashboardArgs(["--input"])));
test("A5: dry/write conflict throws", () => assert.throws(() => parseExtendedDashboardArgs(["--dry-run", "--write-artifacts"])));

// ---- CLI behavior ----

test("B1: default dry-run writes zero files and exits 0", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, decompositionJson());
    const outDir = path.join(dir, "out");
    const logs: string[] = [];
    const code = runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", outDir], (m) => logs.push(m));
    assert.equal(code, 0);
    assert.equal(existsSync(outDir), false);
    assert.match(logs.join(""), /dry-run/);
  });
});

test("B2: write mode creates exactly three artifacts with no stale temp files", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, decompositionJson());
    const outDir = path.join(dir, "out");
    const code = runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", outDir, "--write-artifacts"], () => {});
    assert.equal(code, 0);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [...OUTPUT_FILES].sort());
    assert.equal(files.some((f) => f.includes(".tmp")), false);
  });
});

test("B3: rerun produces byte-identical artifacts", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, decompositionJson());
    const outA = path.join(dir, "a");
    const outB = path.join(dir, "b");
    runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", outA, "--write-artifacts"], () => {});
    runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", outB, "--write-artifacts"], () => {});
    for (const f of OUTPUT_FILES) {
      assert.equal(readFileSync(path.join(outA, f), "utf8"), readFileSync(path.join(outB, f), "utf8"), f);
    }
  });
});

test("B4: missing input exits non-zero without writing", () => {
  withTmp((dir) => {
    const outDir = path.join(dir, "out");
    const code = runRenderExtendedHistoricalDashboardCli(["--input", path.join(dir, "nope.json"), "--output-dir", outDir, "--write-artifacts"], () => {});
    assert.equal(code, 1);
    assert.equal(existsSync(outDir), false);
  });
});

test("B5: invalid JSON exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, "{ nope");
    const code = runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B6: schema mismatch (missing required field) exits non-zero", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, JSON.stringify({ schemaVersion: 1 }));
    const code = runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", path.join(dir, "o")], () => {});
    assert.equal(code, 1);
  });
});

test("B7: written JSON parses and retains all requested models", () => {
  withTmp((dir) => {
    const input = path.join(dir, "decomp.json");
    writeFileSync(input, decompositionJson());
    const outDir = path.join(dir, "out");
    runRenderExtendedHistoricalDashboardCli(["--input", input, "--output-dir", outDir, "--write-artifacts"], () => {});
    const parsed = JSON.parse(readFileSync(path.join(outDir, "extended_historical_dashboard.json"), "utf8"));
    assert.equal(parsed.modelSummaries.length, 2);
  });
});

test("B8: import does not auto-execute the CLI", () => {
  const src = require("node:fs").readFileSync(
    require.resolve("../../scripts/modeling/strategies/render-extended-historical-dashboard.ts"),
    "utf8",
  );
  assert.match(src, /require\.main === module/);
});
