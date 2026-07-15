// Phase 4B.2A / B2A -- bounded observable routing experiments (pure engine).
//
// HISTORICAL BOUNDED EXPERIMENT ONLY. This suite proves the engine evaluates
// exactly three FROZEN candidate policies against the ALT4 base comparator
// using the canonical engines (strict dedup, ALT4 selection, ROI/PnL/equity,
// event grouping, stable hashes) -- it never rewrites the math, never changes
// formula weights, never fabricates a missing component, and never promotes a
// model or names a Champion.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BOUNDED_ROUTING_ENGINE_VERSION,
  BOUNDED_ROUTING_SCHEMA_VERSION,
  BASE_COMPARATOR_ID,
  CANDIDATE_IDS,
  CANDIDATE_DEFINITIONS,
  PRICE_FLOOR,
  TIMING_UPPER_HOURS,
  passesPriceFloor,
  passesTimingWithin120m,
  classifyTriage,
  buildBoundedRoutingExperiments,
  serializeBoundedRoutingJson,
  renderBoundedRoutingHtml,
  buildBoundedRoutingManifest,
} from "../../lib/modeling/boundedRoutingExperiments";
import { buildScoreComponentAnalysis } from "../../lib/modeling/scoreComponentAnalysis";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import { evaluateHistoricalFunnelVariant } from "../../lib/modeling/historicalFunnelVariants";

const classifier = loadExecutableFunnelClassifier();

function makeRow(
  n: number,
  opts: Partial<{ hours: number | null; price: number; score: number; hasStart: boolean; sport: string; win: boolean }> = {},
): Record<string, unknown> {
  const hours = opts.hours === undefined ? 1 : opts.hours;
  const createdMs = Date.parse("2024-01-01T00:00:00Z");
  const hasStart = opts.hasStart ?? hours !== null;
  const diagnostics: Record<string, unknown> = { dataCoverage: 70 };
  if (hasStart && hours !== null) diagnostics.gameStartIso = new Date(createdMs + hours * 3_600_000).toISOString();
  const win = opts.win ?? n % 3 !== 0;
  const slug = `${opts.sport ?? "epl"}-team${n}-vs-team${n + 1}`;
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    condition_id: `cond-${n}`,
    token_id: `tok-${n}`,
    created_at: "2024-01-01T00:00:00Z",
    resolved_at: `2024-02-${String((n % 27) + 1).padStart(2, "0")}T00:00:00Z`,
    signal_confidence_num: opts.score ?? 70,
    entry_price_num: opts.price ?? 0.5,
    metric_formula_version: "v2-lite-growth-safe",
    league: opts.sport ?? "epl",
    event_slug: slug,
    market_slug: `${slug}-moneyline`,
    signal_result: win ? "win" : "loss",
    realized_return_pct: win ? 40 : -100,
    diagnostics,
  };
}

// A corpus whose ALT4 selection is non-empty: score >= 65, non-esports.
function corpus(n = 300): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    makeRow(i + 1, {
      hours: (i % 8) * 0.5, // 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5
      price: 0.2 + (i % 6) * 0.14, // 0.20 .. 0.90
      score: 66 + (i % 20),
    }),
  );
}

function evidenceFor(rawRows: Record<string, unknown>[]) {
  return buildScoreComponentAnalysis({
    rawRows,
    classifier,
    requestedVariantIds: [BASE_COMPARATOR_ID],
  });
}

// ---------------------------------------------------------------- constants

test("engine constants and frozen budget", () => {
  assert.equal(BOUNDED_ROUTING_SCHEMA_VERSION, 1);
  assert.equal(typeof BOUNDED_ROUTING_ENGINE_VERSION, "string");
  assert.equal(BASE_COMPARATOR_ID, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  assert.equal(PRICE_FLOOR, 0.3);
  assert.equal(TIMING_UPPER_HOURS, 2);
  assert.deepEqual([...CANDIDATE_IDS], [
    "B2_PRICE_FLOOR_030",
    "B2_TIMING_WITHIN_120M",
    "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M",
  ]);
  assert.equal(CANDIDATE_DEFINITIONS.length, 3);
});

test("candidate direct parents are correct", () => {
  const byId = new Map(CANDIDATE_DEFINITIONS.map((c) => [c.id, c]));
  assert.equal(byId.get("B2_PRICE_FLOOR_030")?.parentId, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  assert.equal(byId.get("B2_TIMING_WITHIN_120M")?.parentId, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS");
  assert.equal(byId.get("B2_PRICE_FLOOR_030_TIMING_WITHIN_120M")?.parentId, "B2_PRICE_FLOOR_030");
});

// ----------------------------------------------------------- predicates

test("price floor boundary 0.2999 vs 0.30 and fail-closed", () => {
  assert.equal(passesPriceFloor(makeRow(1, { price: 0.2999 })), false);
  assert.equal(passesPriceFloor(makeRow(1, { price: 0.3 })), true);
  assert.equal(passesPriceFloor(makeRow(1, { price: 1 })), true);
  assert.equal(passesPriceFloor({ entry_price_num: 1.01 }), false);
  assert.equal(passesPriceFloor({ entry_price_num: 0 }), false);
  assert.equal(passesPriceFloor({ entry_price_num: "0.5" }), false); // strings rejected
  assert.equal(passesPriceFloor({}), false); // missing fails closed
});

test("timing boundary -1m / 0 / 119.999m / 120m and fail-closed", () => {
  assert.equal(passesTimingWithin120m(makeRow(1, { hours: -1 / 60 })), false); // already started
  assert.equal(passesTimingWithin120m(makeRow(1, { hours: 0 })), true);
  assert.equal(passesTimingWithin120m(makeRow(1, { hours: 119.999 / 60 })), true);
  assert.equal(passesTimingWithin120m(makeRow(1, { hours: 2 })), false); // exactly 120m excluded
  assert.equal(passesTimingWithin120m(makeRow(1, { hasStart: false })), false); // unknown fails closed
});

test("timing never substitutes resolved_at for event start", () => {
  // resolved_at present, gameStartIso absent -> unknown start -> fail closed.
  const row = { resolved_at: "2024-01-01T05:00:00Z", created_at: "2024-01-01T00:00:00Z", diagnostics: {} };
  assert.equal(passesTimingWithin120m(row), false);
});

// -------------------------------------------------------- parent contracts

test("price candidate differs from ALT4 only by the price floor", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const alt4 = result.baseMetrics;
  const price = result.candidateMetrics.find((c) => c.id === "B2_PRICE_FLOOR_030")!;
  // every price-candidate observation is an ALT4 observation with price >= 0.30
  assert.ok(price.selectedObservations <= alt4.selectedObservations);
});

test("combined candidate differs from price candidate only by timing", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const price = result.candidateMetrics.find((c) => c.id === "B2_PRICE_FLOOR_030")!;
  const combo = result.candidateMetrics.find((c) => c.id === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M")!;
  assert.ok(combo.selectedObservations <= price.selectedObservations);
});

test("existing ALT4 model selection is unchanged by the engine", () => {
  const rows = corpus(120);
  const before = evaluateHistoricalFunnelVariant(rows, classifier, BASE_COMPARATOR_ID).selectedRows.length;
  const evidence = evidenceFor(rows);
  buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const after = evaluateHistoricalFunnelVariant(rows, classifier, BASE_COMPARATOR_ID).selectedRows.length;
  assert.equal(before, after);
});

test("input rows are not mutated", () => {
  const rows = corpus(60);
  const snapshot = JSON.stringify(rows);
  const evidence = evidenceFor(rows);
  buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  assert.equal(JSON.stringify(rows), snapshot);
});

// ------------------------------------------------------------- metrics

test("canonical ROI/PnL/drawdown reused; deltas reconcile", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  for (const c of result.candidateMetrics) {
    const parentCmp = result.parentComparisons.find((p) => p.candidateId === c.id)!;
    const parentMetrics =
      c.id === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M"
        ? result.candidateMetrics.find((x) => x.id === "B2_PRICE_FLOOR_030")!
        : result.baseMetrics;
    assert.equal(parentCmp.deltaN, c.selectedObservations - parentMetrics.selectedObservations);
  }
});

test("removed-row attribution reconciles with parent minus candidate", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  for (const attr of result.removedRowAttribution) {
    const c = result.candidateMetrics.find((x) => x.id === attr.candidateId)!;
    const parentMetrics =
      attr.candidateId === "B2_PRICE_FLOOR_030_TIMING_WITHIN_120M"
        ? result.candidateMetrics.find((x) => x.id === "B2_PRICE_FLOOR_030")!
        : result.baseMetrics;
    assert.equal(attr.removedObservations, parentMetrics.selectedObservations - c.selectedObservations);
    // removed attribution buckets sum to removedObservations
    const bandSum = attr.byPriceBand.reduce((s, b) => s + b.observations, 0);
    assert.equal(bandSum, attr.removedObservations);
  }
});

// ------------------------------------------------------------- duplicates

test("duplicate detection: unique / existing-model / batch", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const valid = new Set(["UNIQUE_SELECTION", "EXACT_DUPLICATE_EXISTING_MODEL", "EXACT_DUPLICATE_BATCH_CANDIDATE"]);
  for (const d of result.duplicateAnalysis) {
    assert.ok(valid.has(d.status));
  }
});

test("a candidate identical to ALT4 is flagged as existing-model duplicate", () => {
  // All prices >= 0.30 and all timing within 120m -> the price and combined
  // candidates select exactly the ALT4 set.
  const rows = Array.from({ length: 120 }, (_, i) => makeRow(i + 1, { hours: 1, price: 0.5, score: 70 }));
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const price = result.duplicateAnalysis.find((d) => d.candidateId === "B2_PRICE_FLOOR_030")!;
  assert.equal(price.status, "EXACT_DUPLICATE_EXISTING_MODEL");
});

// ------------------------------------------------------------- triage

test("triage: broad advance", () => {
  const parent = { selectedObservations: 500, flatUnitPnl: 50, flatUnitRoi: 5, maximumDrawdownUnits: 30 };
  const cand = { selectedObservations: 300, flatUnitPnl: 70, flatUnitRoi: 12, maximumDrawdownUnits: 20 };
  assert.equal(classifyTriage(cand, parent, true), "ADVANCE_BROAD_FOLLOWUP");
});

test("triage: risk-efficient advance", () => {
  const parent = { selectedObservations: 500, flatUnitPnl: 100, flatUnitRoi: 5, maximumDrawdownUnits: 40 };
  const cand = { selectedObservations: 300, flatUnitPnl: 85, flatUnitRoi: 9, maximumDrawdownUnits: 15 };
  assert.equal(classifyTriage(cand, parent, true), "ADVANCE_RISK_EFFICIENT_FOLLOWUP");
});

test("triage: dominated rejection", () => {
  const parent = { selectedObservations: 500, flatUnitPnl: 100, flatUnitRoi: 10, maximumDrawdownUnits: 20 };
  const cand = { selectedObservations: 300, flatUnitPnl: 50, flatUnitRoi: 5, maximumDrawdownUnits: 30 };
  assert.equal(classifyTriage(cand, parent, true), "REJECT_DOMINATED");
});

test("triage: mixed hold", () => {
  const parent = { selectedObservations: 500, flatUnitPnl: 100, flatUnitRoi: 10, maximumDrawdownUnits: 20 };
  const cand = { selectedObservations: 300, flatUnitPnl: 120, flatUnitRoi: 8, maximumDrawdownUnits: 25 };
  assert.equal(classifyTriage(cand, parent, true), "HOLD_MIXED");
});

test("triage: duplicate never advances", () => {
  const parent = { selectedObservations: 500, flatUnitPnl: 50, flatUnitRoi: 5, maximumDrawdownUnits: 30 };
  const cand = { selectedObservations: 300, flatUnitPnl: 70, flatUnitRoi: 12, maximumDrawdownUnits: 20 };
  assert.equal(classifyTriage(cand, parent, false), "REJECT_DUPLICATE");
});

test("triage never emits Champion/promotion/live wording", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const allowed = new Set([
    "ADVANCE_BROAD_FOLLOWUP",
    "ADVANCE_RISK_EFFICIENT_FOLLOWUP",
    "HOLD_MIXED",
    "REJECT_DOMINATED",
    "REJECT_DUPLICATE",
  ]);
  for (const t of result.triage) assert.ok(allowed.has(t.status));
  const blob = JSON.stringify(result.triage);
  assert.ok(!/champion|promot|live/i.test(blob));
});

// -------------------------------------------------- timing sensitivity

test("timing sensitivity reports sub-windows and cumulative gates, no candidate IDs", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const subWindows = result.timingSensitivity.subWindows.map((s) => s.bucket);
  assert.deepEqual(subWindows, ["T_0_TO_30M", "T_30_TO_60M", "T_60_TO_120M", "T_120_TO_180M"]);
  const gates = result.timingSensitivity.cumulativeGates.map((g) => g.gate);
  assert.deepEqual(gates, ["WITHIN_30M", "WITHIN_60M", "WITHIN_120M", "WITHIN_180M"]);
  assert.ok(!/candidateId/.test(JSON.stringify(result.timingSensitivity)));
});

// -------------------------------------------------- evidence provenance

test("evidence contentHash mismatch is rejected", () => {
  const rows = corpus(120);
  const evidence = evidenceFor(rows);
  const broken = { ...evidence, contentHash: "not-a-hash" };
  assert.throws(() => buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence: broken }));
});

test("evidence corpus count mismatch is rejected", () => {
  const rows = corpus(120);
  const evidence = evidenceFor(rows);
  const broken = { ...evidence, corpusSummary: { ...evidence.corpusSummary, rawRowCount: 999 } };
  assert.throws(() => buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence: broken }));
});

test("evidence strict-dedup policy mismatch is rejected", () => {
  const rows = corpus(120);
  const evidence = evidenceFor(rows);
  const broken = { ...evidence, corpusSummary: { ...evidence.corpusSummary, strictDedupPolicy: "other_policy" } };
  assert.throws(() => buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence: broken }));
});

// -------------------------------------------------- serialization

test("serialize/html/manifest are deterministic and content-hashed", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const a = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const b = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const ja = serializeBoundedRoutingJson(a);
  const jb = serializeBoundedRoutingJson(b);
  assert.equal(ja, jb);
  assert.equal(a.contentHash, b.contentHash);
  assert.ok(ja.endsWith("}\n"));
  const html = renderBoundedRoutingHtml(a);
  assert.match(html, /HISTORICAL BOUNDED EXPERIMENT ONLY/);
  assert.match(html, /NO AUTOMATIC CHAMPION/);
  assert.match(html, /NO MODEL PROMOTION/);
  assert.match(html, /NO LIVE CHANGE/);
  assert.ok(!/<script/i.test(html));
  assert.ok(!/http:\/\/|https:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")));
  const manifest = buildBoundedRoutingManifest(
    a,
    { inputSha256: "a".repeat(64), classifierSha256: "b".repeat(64), evidenceSha256: "c".repeat(64) },
    ja,
    html,
  );
  assert.equal(manifest.experimentContentHash, a.contentHash);
  assert.equal(manifest.evidenceContentHash, evidence.contentHash);
  assert.deepEqual(manifest.candidateIds, [...CANDIDATE_IDS]);
  assert.equal(manifest.baseComparatorId, BASE_COMPARATOR_ID);
});

test("HTML contains all required research sections", () => {
  const rows = corpus(300);
  const evidence = evidenceFor(rows);
  const result = buildBoundedRoutingExperiments({ rawRows: rows, classifier, evidence });
  const html = renderBoundedRoutingHtml(result);
  for (const needle of [
    "Frozen Candidate Budget",
    "Base ALT4",
    "Parent Delta",
    "Removed",
    "Timing Sensitivity",
    "Duplicate",
    "Triage",
    "Limitations",
    "C1",
  ]) {
    assert.ok(html.includes(needle), `missing section: ${needle}`);
  }
});
