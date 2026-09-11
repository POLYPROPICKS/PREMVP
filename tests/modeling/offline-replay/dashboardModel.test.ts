/**
 * BUILD_OFFLINE_PLOTLY_MODEL_COMPARISON_DASHBOARD_V1 — dashboard-model parity.
 *
 * The dashboard model is a VIEW. These tests prove every number it exposes is
 * copied verbatim from a source artifact and that null economics stay null.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDashboardModel } from "../../../lib/modeling/offline-replay/dashboardModel";

const DIR = join("modeling", "evidence", "offline-replay-plane-v1");
const readJson = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

const septemberTables = readJson("SEPTEMBER_TABLES.json");
const contractAAttribution = readJson("CONTRACT_A_ATTRIBUTION_V1.json");
const contractACandidates = readJson("CONTRACT_A_CANDIDATES_V1.json");
const manifest = readJson("MANIFEST.json");

const model = buildDashboardModel({
  septemberTables,
  contractAAttribution,
  contractACandidates,
  manifest,
});

test("primary models are exactly the SEPTEMBER_TABLES.overall models, in order", () => {
  const expected = septemberTables.overall.map((r: any) => r.MODEL);
  assert.deepEqual(model.primaryModels, expected);
  for (const m of ["C0", "C1", "C2", "C3", "C4", "C5", "CONTRACT_A_FILTER_SIM_CURRENT"]) {
    assert.ok(model.primaryModels.includes(m), `missing primary model ${m}`);
  }
});

test("MODEL OVERVIEW rows are verbatim passthrough of SEPTEMBER_TABLES.overall", () => {
  for (const raw of septemberTables.overall) {
    const row = model.overallModels.find((r) => r.model === raw.MODEL && r.source === "SEPTEMBER_TABLES.json");
    assert.ok(row, `no dashboard row for ${raw.MODEL}`);
    assert.equal(row!.BETS, raw.SIMULATED_BET_N);
    assert.equal(row!.TERMINAL, raw.TERMINAL_BET_N);
    assert.equal(row!.UNRESOLVED, raw.UNRESOLVED_BET_N);
    assert.equal(row!.WINS, raw.WINS);
    assert.equal(row!.LOSSES, raw.LOSSES);
    assert.equal(row!.PNL_U, raw.GROSS_PNL_U);
    assert.equal(row!.ROI_PCT, raw.GROSS_ROI_PCT);
    assert.equal(row!.MAX_DD_U, raw.MAX_DD_U);
    assert.equal(row!.WIN_RATE_PCT, raw.WIN_RATE_PCT);
    assert.equal(row!.CONCENTRATION, raw.CONCENTRATION);
  }
});

test("null economics stay null and are never coerced to 0 (C2 / C3)", () => {
  for (const m of ["C2", "C3"]) {
    const row = model.overallModels.find((r) => r.model === m)!;
    assert.equal(row.ROI_PCT, null, `${m} ROI must be null`);
    assert.equal(row.WIN_RATE_PCT, null, `${m} win-rate must be null`);
    assert.equal(row.CONCENTRATION, null, `${m} concentration must be null`);
    // counts that genuinely are 0 in the source stay 0
    assert.equal(row.TERMINAL, 0);
  }
});

test("candidate-only models come from CONTRACT_A_CANDIDATES_V1 and do not shadow primary rows", () => {
  const compModels: string[] = contractACandidates.comparison_table.map((r: any) => r.MODEL);
  for (const cm of model.candidateModels) {
    assert.ok(compModels.includes(cm));
    assert.ok(!model.primaryModels.includes(cm));
  }
  // the candidate artifact's own CONTRACT_A_FILTER_SIM_CURRENT row is deduped away,
  // and C0_REFERENCE is not surfaced as a separate operator model
  assert.ok(!model.candidateModels.includes("CONTRACT_A_FILTER_SIM_CURRENT"));
  assert.ok(!model.candidateModels.includes("C0_REFERENCE"));
  for (const cm of ["CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF", "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF"]) {
    assert.ok(model.candidateModels.includes(cm), `missing candidate model ${cm}`);
    const row = model.overallModels.find((r) => r.model === cm)!;
    const raw = contractACandidates.comparison_table.find((r: any) => r.MODEL === cm);
    assert.equal(row.BETS, raw.BETS);
    assert.equal(row.PNL_U, raw.PNL_U);
    assert.equal(row.ROI_PCT, raw.ROI_PCT);
    assert.equal(row.MAX_DD_U, raw.MAX_DD_U);
  }
});

test("SPORT COMPARISON rows are verbatim passthrough of SEPTEMBER_TABLES.grouped", () => {
  let checked = 0;
  for (const [m, rows] of Object.entries<any[]>(septemberTables.grouped)) {
    for (const raw of rows) {
      const row = model.sportRows.find((r) => r.model === m && r.sport === raw.GROUP_KEY)!;
      assert.ok(row, `no sport row ${m}/${raw.GROUP_KEY}`);
      assert.equal(row.BETS, raw.SIMULATED_BET_N);
      assert.equal(row.TERMINAL, raw.TERMINAL_BET_N);
      assert.equal(row.WINS, raw.WINS);
      assert.equal(row.LOSSES, raw.LOSSES);
      assert.equal(row.PNL_U, raw.GROSS_PNL_U);
      assert.equal(row.ROI_PCT, raw.GROSS_ROI_PCT);
      assert.equal(row.MAX_DD_U, raw.MAX_DD_U);
      checked++;
    }
  }
  assert.ok(checked > 20, `expected many grouped rows, checked ${checked}`);
});

test("CONTRACT A band breakdowns cover every persisted dimension, verbatim", () => {
  const a1 = contractAAttribution.analysis_1_selected_bet_economics;
  assert.deepEqual(
    model.contractAAttribution.bandDimensions.slice().sort(),
    Object.keys(a1).slice().sort(),
  );
  for (const [dim, buckets] of Object.entries<any>(a1)) {
    for (const [bucket, raw] of Object.entries<any>(buckets)) {
      const row = model.contractAAttribution.bands.find((b) => b.dimension === dim && b.bucket === bucket)!;
      assert.ok(row, `missing band ${dim}/${bucket}`);
      assert.equal(row.BETS, raw.BETS);
      assert.equal(row.TERMINAL, raw.TERMINAL);
      assert.equal(row.PNL_U, raw.PNL_U);
      assert.equal(row.ROI_PCT, raw.ROI_PCT);
      assert.equal(row.MAX_DD_U, raw.MAX_DD_U);
    }
  }
});

test("ranked Contract A damage attribution is passed through verbatim", () => {
  assert.equal(
    model.contractAAttribution.ranked.length,
    contractAAttribution.ranked_founder_table.length,
  );
  for (const raw of contractAAttribution.ranked_founder_table) {
    const row = model.contractAAttribution.ranked.find((r) => r.RANK === raw.RANK)!;
    assert.equal(row.CONTRACT_A_SEMANTIC, raw.CONTRACT_A_SEMANTIC);
    assert.equal(row.DELTA_PNL, raw.DELTA_PNL);
    assert.equal(row.DELTA_ROI_PP, raw.DELTA_ROI_PP);
    assert.equal(row.VERDICT, raw.VERDICT);
  }
});

test("meta carries window / determinism hash / counts from source", () => {
  assert.equal(model.meta.determinism_hash, septemberTables.determinism_hash);
  assert.equal(model.meta.counts.IDENTITY_N, septemberTables.view_meta.counts.IDENTITY_N);
  assert.equal(model.meta.window.as_of, manifest.window.as_of);
  assert.deepEqual(model.meta.days_missing, septemberTables.view_meta.days_missing);
});

test("PRIMARY operator comparison defaults to exactly the 4 canonical lanes", () => {
  assert.deepEqual(model.dashboardDefaultModels, [
    "C0",
    "CONTRACT_A_FILTER_SIM_CURRENT",
    "CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF",
    "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF",
  ]);
  assert.deepEqual(model.defaultModels.map((r) => r.model), model.dashboardDefaultModels);
  for (const r of model.defaultModels) assert.equal(r.DASHBOARD_DEFAULT_VISIBLE, true);
});

test("C1–C5 + C0_REFERENCE are research/hidden, not default; source results retained", () => {
  for (const m of ["C1", "C2", "C3", "C4", "C5"]) {
    const r = model.overallModels.find((x) => x.model === m)!;
    assert.equal(r.DASHBOARD_DEFAULT_VISIBLE, false, `${m} must not be default-visible`);
    assert.ok(model.researchModels.some((x) => x.model === m), `${m} must be in researchModels`);
  }
  // C0_REFERENCE is not rendered as a separate operator model...
  assert.ok(!model.overallModels.some((x) => x.model === "C0_REFERENCE"));
  assert.ok(!model.candidateModels.includes("C0_REFERENCE"));
  // ...but its raw numbers stay in the candidate comparison passthrough
  assert.ok(model.contractACandidates.comparison.some((r: any) => r.MODEL === "C0_REFERENCE"));
});

test("every model carries a deterministic, LLM-free runtime contract", () => {
  assert.ok(model.runtimeContract.length >= 9);
  for (const c of model.runtimeContract) {
    assert.equal(c.RUNTIME_KIND, "DETERMINISTIC_CODE");
    assert.equal(c.LLM_DEPENDENCY_AT_RUNTIME, false);
    assert.equal(c.NETWORK_DEPENDENCY_AT_REPLAY, false);
    assert.equal(c.DATABASE_DEPENDENCY_AT_REPLAY, false);
    assert.ok(c.CANONICAL_PREDICATE_OWNER.length > 10, `${c.MODEL_ID} needs a predicate owner`);
    assert.ok(c.STATUS.length > 3);
  }
  const byId = Object.fromEntries(model.runtimeContract.map((c) => [c.MODEL_ID, c]));
  assert.equal(byId.C0.STATUS, "ACTIVE_REFERENCE");
  assert.equal(byId.C5.STATUS, "REDUNDANT_WITH_C0_CURRENT_WINDOW");
  assert.equal(byId.C1.STATUS, "RESEARCH_REFERENCE_NOT_ACTIVE_OPERATOR_MODEL");
  assert.equal(byId.C4.STATUS, "REDUNDANT_WITH_C1_CURRENT_WINDOW");
  assert.equal(byId.C2.STATUS, "ZERO_SELECTION_CURRENT_WINDOW");
  assert.equal(byId.C3.STATUS, "ZERO_SELECTION_CURRENT_WINDOW");
  assert.equal(byId.CONTRACT_A_FILTER_SIM_CURRENT.STATUS, "ACTIVE_CURRENT_POLICY_SIMULATION");
});

test("unavailable dimensions are explicit and include the known gaps", () => {
  const text = model.unavailableDimensions.map((d) => d.dimension).join(" | ");
  assert.match(text, /equity curve/i);
  assert.match(text, /CONTRACT_A_ACTUAL/);
  assert.match(text, /Volume \/ liquidity/i);
  assert.ok(model.unavailableDimensions.every((d) => d.reason.length > 10));
});
