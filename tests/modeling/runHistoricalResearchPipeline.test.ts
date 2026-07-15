// Phase 4D.1 / D1 -- one-command historical research pipeline CLI.
//
// Transactional: stages run in a sibling staging directory, all hashes are
// verified, and only a fully-passing run atomically replaces the final
// output root. A failed run must leave any previous valid output untouched
// and must never leave a stale staging directory or a valid new manifest.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runHistoricalResearchPipelineCli,
  parseHistoricalResearchPipelineArgs,
} from "../../scripts/modeling/strategies/run-historical-research-pipeline";

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

function writeInput(dir: string): string {
  const input = path.join(dir, "corpus.json");
  writeFileSync(input, `${JSON.stringify(CORPUS, null, 2)}\n`);
  return input;
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "hist-pipeline-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STAGE_DIR_NAMES = ["a1", "a2", "b1", "b2a", "c1"];
const PACKET_FILES = ["historical_research_packet.json", "historical_research_packet.html", "historical_research_packet_manifest.json"];

// ------------------------------------------------------------- arguments

test("defaults are dry-run with canonical default paths", () => {
  const args = parseHistoricalResearchPipelineArgs([]);
  assert.equal(args.mode, "dry-run");
  assert.ok(args.input.endsWith(path.join("local_exports", "generated_signal_pairs_export.json")));
  assert.ok(args.outputRoot.endsWith(path.join("local_exports", "historical_research_pipeline")));
});

test("explicit paths are honored", () => {
  const args = parseHistoricalResearchPipelineArgs(["--input", "a.json", "--classifier", "b.json", "--output-root", "o"]);
  assert.equal(args.input, "a.json");
  assert.equal(args.classifier, "b.json");
  assert.equal(args.outputRoot, "o");
});

test("unknown argument throws", () => assert.throws(() => parseHistoricalResearchPipelineArgs(["--nope"])));
test("missing value throws", () => assert.throws(() => parseHistoricalResearchPipelineArgs(["--input"])));
test("dry/write conflict throws", () => assert.throws(() => parseHistoricalResearchPipelineArgs(["--dry-run", "--write-artifacts"])));

// ------------------------------------------------------------- dry-run

test("dry-run writes zero files and does not execute stages", () => {
  withTmp((dir) => {
    const input = writeInput(dir);
    const outRoot = path.join(dir, "out");
    const logs: string[] = [];
    const code = runHistoricalResearchPipelineCli(["--input", input, "--output-root", outRoot], (m) => logs.push(m));
    assert.equal(code, 0);
    assert.equal(existsSync(outRoot), false);
    assert.match(logs.join(""), /dry-run/);
    assert.ok(!/stageResults/.test(logs.join(""))); // no full packet computed
  });
});

test("missing input exits non-zero in dry-run", () => {
  withTmp((dir) => {
    const outRoot = path.join(dir, "out");
    const code = runHistoricalResearchPipelineCli(["--input", path.join(dir, "nope.json"), "--output-root", outRoot], () => {});
    assert.equal(code, 1);
  });
});

// ------------------------------------------------------------- write mode

test("write mode creates complete stage tree and exactly three packet artifacts", () => {
  withTmp((dir) => {
    const input = writeInput(dir);
    const outRoot = path.join(dir, "out");
    const code = runHistoricalResearchPipelineCli(["--input", input, "--output-root", outRoot, "--write-artifacts"], () => {});
    assert.equal(code, 0);
    for (const stage of STAGE_DIR_NAMES) {
      assert.ok(existsSync(path.join(outRoot, "stages", stage)), `missing stage dir: ${stage}`);
    }
    const packetFiles = readdirSync(path.join(outRoot, "packet")).sort();
    assert.deepEqual(packetFiles, [...PACKET_FILES].sort());
  });
});

test("no stale staging directory remains after a successful run", () => {
  withTmp((dir) => {
    const input = writeInput(dir);
    const outRoot = path.join(dir, "out");
    runHistoricalResearchPipelineCli(["--input", input, "--output-root", outRoot, "--write-artifacts"], () => {});
    const siblings = readdirSync(dir);
    assert.ok(!siblings.some((f) => f.includes(".tmp-")));
  });
});

test("write mode is byte-deterministic on rerun", () => {
  withTmp((dir) => {
    const input = writeInput(dir);
    const outRoot = path.join(dir, "out");
    const run = () => runHistoricalResearchPipelineCli(["--input", input, "--output-root", outRoot, "--write-artifacts"], () => {});
    run();
    const first = PACKET_FILES.map((f) => readFileSync(path.join(outRoot, "packet", f), "utf8"));
    run();
    const second = PACKET_FILES.map((f) => readFileSync(path.join(outRoot, "packet", f), "utf8"));
    assert.deepEqual(first, second);
  });
});

test("a failed stage preserves the previous valid output and writes no new manifest", () => {
  withTmp((dir) => {
    const input = writeInput(dir);
    const outRoot = path.join(dir, "out");
    // First: a valid successful run.
    const code1 = runHistoricalResearchPipelineCli(["--input", input, "--output-root", outRoot, "--write-artifacts"], () => {});
    assert.equal(code1, 0);
    const before = readFileSync(path.join(outRoot, "packet", "historical_research_packet_manifest.json"), "utf8");

    // Second: an invalid corpus (empty array) should fail the pipeline.
    const badInput = path.join(dir, "bad.json");
    writeFileSync(badInput, "[]\n");
    const code2 = runHistoricalResearchPipelineCli(["--input", badInput, "--output-root", outRoot, "--write-artifacts"], () => {});
    assert.equal(code2, 1);

    const after = readFileSync(path.join(outRoot, "packet", "historical_research_packet_manifest.json"), "utf8");
    assert.equal(before, after);
    // No stale staging directory left behind by the failed run.
    const siblings = readdirSync(dir);
    assert.ok(!siblings.some((f) => f.includes(".tmp-")));
  });
});

test("importing the module does not auto-run the CLI", async () => {
  const mod = await import("../../scripts/modeling/strategies/run-historical-research-pipeline");
  assert.equal(typeof mod.runHistoricalResearchPipelineCli, "function");
  assert.equal(typeof mod.parseHistoricalResearchPipelineArgs, "function");
  assert.equal(existsSync(path.join("modeling", "local_exports", "historical_research_pipeline")), false);
});
