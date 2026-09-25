/**
 * FREEZE_AND_CANONICALIZE_DETERMINISTIC_MODELING_PLANE_V1 — release regression.
 *
 * Proves the accepted current baselines reproduce EXACTLY from frozen code +
 * pinned evidence, and that the offline plane declares zero LLM / network /
 * database dependency at replay. If the baselines drift, the lineage must not
 * be canonicalized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runReplay } from "../../../lib/modeling/offline-replay/replayRunner";
import {
  MODEL_RUNTIME_CONTRACT,
  DASHBOARD_DEFAULT_MODELS,
} from "../../../lib/modeling/offline-replay/policyRegistry";

const WINDOW = { from: "2026-09-01", to: "2026-09-10", asOf: "2026-09-10T14:04:29.586Z" as const };
const DIR = join("modeling", "evidence", "offline-replay-plane-v1");
const readJson = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

test("C0 baseline reproduces (TERMINAL 1578 · PnL +241.60 · ROI +15.31)", () => {
  const run = runReplay({ models: ["C0"], groupBy: "none", ...WINDOW });
  const c0 = run.overall.find((r) => r.MODEL === "C0")!;
  assert.equal(c0.TERMINAL_BET_N, 1578);
  assert.equal(c0.GROSS_PNL_U, 241.6);
  assert.equal(Math.round(c0.GROSS_ROI_PCT! * 100) / 100, 15.31);
});

test("CONTRACT_A_FILTER_SIM_CURRENT reproduces the CURRENT origin/main baseline (TERMINAL 251 · PnL -50.29 · ROI -20.04)", () => {
  // Re-frozen to current origin/main authority:
  // lib/executor/productionSignalPopulation.ts::PRODUCTION_SCORED_PLANNING_VERSIONS (planning mode).
  // The old 545 / -86.91 / -15.95 result is NON_CANONICAL_LOCAL_WIP_SEMANTICS (3-version
  // unreleased Founder WIP list) — historical only, never presented as CURRENT.
  const run = runReplay({ models: ["CONTRACT_A_FILTER_SIM_CURRENT"], groupBy: "none", ...WINDOW });
  const a = run.overall.find((r) => r.MODEL === "CONTRACT_A_FILTER_SIM_CURRENT")!;
  assert.equal(a.TERMINAL_BET_N, 251);
  assert.equal(a.GROSS_PNL_U, -50.29);
  assert.equal(Math.round(a.GROSS_ROI_PCT! * 100) / 100, -20.04);
  assert.notEqual(a.TERMINAL_BET_N, 545);
});

test("full replay reproduces the pinned SEPTEMBER_TABLES.json economics exactly (every model, every metric)", () => {
  const run = runReplay({ models: "all", groupBy: "sport", ...WINDOW });
  const pinned = readJson("SEPTEMBER_TABLES.json");
  for (const raw of pinned.overall) {
    const got = run.overall.find((r) => r.MODEL === raw.MODEL)!;
    for (const k of ["SIMULATED_BET_N", "TERMINAL_BET_N", "UNRESOLVED_BET_N", "WINS", "LOSSES", "GROSS_PNL_U", "GROSS_ROI_PCT", "MAX_DD_U", "WIN_RATE_PCT"]) {
      assert.deepEqual((got as any)[k], raw[k], `${raw.MODEL}.${k}`);
    }
  }
  for (const [mdl, rows] of Object.entries<any[]>(pinned.grouped)) {
    for (const raw of rows) {
      const got = run.grouped[mdl].find((r) => r.GROUP_KEY === raw.GROUP_KEY)!;
      assert.deepEqual(got.GROSS_PNL_U, raw.GROSS_PNL_U, `${mdl}/${raw.GROUP_KEY}.GROSS_PNL_U`);
      assert.deepEqual(got.TERMINAL_BET_N, raw.TERMINAL_BET_N, `${mdl}/${raw.GROUP_KEY}.TERMINAL_BET_N`);
    }
  }
});

test("replay is self-consistently deterministic (identical hash across repeated runs)", () => {
  const a = runReplay({ models: "all", groupBy: "sport", ...WINDOW });
  const b = runReplay({ models: "all", groupBy: "sport", ...WINDOW });
  assert.equal(a.determinism_hash, b.determinism_hash);
});

test("fixed correction-candidate artifact is self-consistent with the current Contract A authority", () => {
  const pinned = readJson("CONTRACT_A_CANDIDATES_V1.json");
  // the candidate artifact reproduces its own CONTRACT_A_FILTER_SIM_CURRENT baseline...
  assert.equal(pinned.baseline_reproduced.match, true);
  assert.equal(pinned.baseline_reproduced.value.TERMINAL, 251);
  assert.equal(pinned.baseline_reproduced.value.PNL_U, -50.29);
  // ...and carries exactly the 4 comparison lanes, with C0_REFERENCE == C0
  const models = pinned.comparison_table.map((r: any) => r.MODEL);
  assert.deepEqual(models, [
    "CONTRACT_A_FILTER_SIM_CURRENT",
    "CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    "C0_REFERENCE",
  ]);
  const c0ref = pinned.comparison_table.find((r: any) => r.MODEL === "C0_REFERENCE")!;
  assert.equal(c0ref.TERMINAL, 1578);
  assert.equal(c0ref.PNL_U, 241.6);
  // candidate economics are whatever the current authority produces — not the stale 291 / 67
  for (const m of ["CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF", "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF"]) {
    const row = pinned.comparison_table.find((r: any) => r.MODEL === m)!;
    assert.ok(typeof row.TERMINAL === "number");
    assert.ok(row.PNL_U === null || typeof row.PNL_U === "number");
  }
});

test("offline plane declares zero LLM / AI-agent / network / database dependency at replay", () => {
  for (const c of Object.values(MODEL_RUNTIME_CONTRACT)) {
    assert.equal(c.RUNTIME_KIND, "DETERMINISTIC_CODE");
    assert.equal(c.LLM_DEPENDENCY_AT_RUNTIME, false);
    assert.equal(c.NETWORK_DEPENDENCY_AT_REPLAY, false);
    assert.equal(c.DATABASE_DEPENDENCY_AT_REPLAY, false);
  }
  // no AI SDK / inference client is importable from the offline module graph
  const srcFiles = [
    "lib/modeling/offline-replay/replayRunner.ts",
    "lib/modeling/offline-replay/policyRegistry.ts",
    "lib/modeling/offline-replay/contractAFilterSim.ts",
    "lib/modeling/offline-replay/modelReadyView.ts",
    "lib/modeling/offline-replay/dashboardModel.ts",
    "scripts/modeling/offline-replay.ts",
    "scripts/modeling/offline-replay-dashboard.ts",
  ];
  for (const f of srcFiles) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /from ["']@?(anthropic|openai|@ai-sdk\/|langchain|cohere-ai)/, `${f} imports an AI SDK`);
    assert.doesNotMatch(src, /\.(chat\.completions|messages)\.create\(/, `${f} calls an inference API`);
  }
});

test("dashboard default model set is the canonical 4 lanes", () => {
  assert.deepEqual(DASHBOARD_DEFAULT_MODELS, [
    "C0",
    "CONTRACT_A_FILTER_SIM_CURRENT",
    "CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF",
  ]);
});
