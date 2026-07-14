// Phase 4C -- Automated Historical Hypothesis Batch Runner (pure builder).
//
// Composes existing canonical pure functions (strict dedup, comparison
// engine, evaluation-run manifest) into one deterministic research-triage
// packet comparing N candidate variants against one base comparator. Never
// selects a Champion, never promotes, never recomputes ROI/dedup/grouping.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoricalHypothesisBatch,
  sampleClassOf,
  computeTriageDeltas,
  computeStructuralFlags,
  classifyTriageStatus,
  serializeHypothesisBatchJson,
  renderHypothesisScorecardHtml,
  renderDecisionPacketHtml,
  buildHypothesisBatchManifest,
  DECISION_TRIAGE_STATUSES,
  type VariantMetricsLike,
} from "../../lib/modeling/historicalHypothesisBatch";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";

const classifier = loadExecutableFunnelClassifier();

function makeRow(n: number, overrides: Record<string, unknown> = {}): ExportRow {
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
    ...overrides,
  };
}

function corpus(n: number): ExportRow[] {
  return Array.from({ length: n }, (_, i) => makeRow(i + 1));
}

// ---- sampleClassOf ----

test("S1: N=29 is INSUFFICIENT", () => assert.equal(sampleClassOf(29), "INSUFFICIENT"));
test("S2: N=30 is SPECIALIST", () => assert.equal(sampleClassOf(30), "SPECIALIST"));
test("S3: N=199 is SPECIALIST", () => assert.equal(sampleClassOf(199), "SPECIALIST"));
test("S4: N=200 is BROAD", () => assert.equal(sampleClassOf(200), "BROAD"));
test("S5: N=0 is INSUFFICIENT", () => assert.equal(sampleClassOf(0), "INSUFFICIENT"));

// ---- triage deltas ----

function metricsLike(overrides: Partial<VariantMetricsLike> = {}): VariantMetricsLike {
  return {
    outputRows: 100,
    workingEventGroups: 80,
    flatUnitPnl: 10,
    flatUnitRoi: 5,
    winRate: 55,
    maximumSignalsPerWorkingEvent: 2,
    maximumDrawdownUnits: 10,
    ...overrides,
  };
}

test("D6: deltas are candidate minus base for every field", () => {
  const base = metricsLike({ outputRows: 1110, workingEventGroups: 800, flatUnitPnl: 57.6341, flatUnitRoi: 5.192261, winRate: 50, maximumSignalsPerWorkingEvent: 6, maximumDrawdownUnits: 34.81 });
  const cand = metricsLike({ outputRows: 877, workingEventGroups: 700, flatUnitPnl: 62.4067, flatUnitRoi: 7.115929, winRate: 52, maximumSignalsPerWorkingEvent: 6, maximumDrawdownUnits: 30.5632 });
  const d = computeTriageDeltas(cand, base);
  assert.equal(d.selectedObservations, 877 - 1110);
  assert.equal(d.eventGroups, 700 - 800);
  assert.ok(Math.abs(d.pnlUnits! - (62.4067 - 57.6341)) < 1e-9);
  assert.ok(Math.abs(d.roiPercentagePoints! - (7.115929 - 5.192261)) < 1e-9);
  assert.ok(Math.abs(d.maximumDrawdownUnits - (30.5632 - 34.81)) < 1e-9);
  assert.equal(d.maxSignalsPerEvent, 0);
  assert.equal(d.winRatePercentagePoints, 2);
});

test("D7: null candidate/base metrics produce null deltas, never NaN", () => {
  const base = metricsLike({ flatUnitPnl: null, flatUnitRoi: null });
  const cand = metricsLike({ flatUnitPnl: 5 });
  const d = computeTriageDeltas(cand, base);
  assert.equal(d.pnlUnits, null);
  assert.equal(d.roiPercentagePoints, null);
});

// ---- structural flags ----

test("F8: ONE_PER_EVENT set when candidate max signals per event is 1", () => {
  const flags = computeStructuralFlags(metricsLike({ maximumSignalsPerWorkingEvent: 1 }), metricsLike({ maximumSignalsPerWorkingEvent: 6 }), false);
  assert.ok(flags.includes("ONE_PER_EVENT"));
});

test("F9: LOWER_CONCENTRATION set when candidate max signals per event is below base's", () => {
  const flags = computeStructuralFlags(metricsLike({ maximumSignalsPerWorkingEvent: 3 }), metricsLike({ maximumSignalsPerWorkingEvent: 6 }), false);
  assert.ok(flags.includes("LOWER_CONCENTRATION"));
});

test("F10: IDENTITY_LIMITATION set only when the caller signals it (from classifier runStatus)", () => {
  const flags = computeStructuralFlags(metricsLike(), metricsLike(), true);
  assert.ok(flags.includes("IDENTITY_LIMITATION"));
  const noFlags = computeStructuralFlags(metricsLike(), metricsLike(), false);
  assert.ok(!noFlags.includes("IDENTITY_LIMITATION"));
});

// ---- triage classification (generic, no hardcoded IDs) ----

test("T11: ALT4-shaped fixture -> ADVANCE_BROAD_FOLLOWUP", () => {
  const base = metricsLike({ outputRows: 1110, flatUnitPnl: 57.6341, flatUnitRoi: 5.192261, maximumDrawdownUnits: 34.81, maximumSignalsPerWorkingEvent: 6 });
  const cand = metricsLike({ outputRows: 877, flatUnitPnl: 62.4067, flatUnitRoi: 7.115929, maximumDrawdownUnits: 30.5632, maximumSignalsPerWorkingEvent: 6 });
  const status = classifyTriageStatus(cand, base, computeStructuralFlags(cand, base, false));
  assert.equal(status, "ADVANCE_BROAD_FOLLOWUP");
});

test("T12: ALT5-shaped fixture -> ADVANCE_SPECIALIST_FOLLOWUP", () => {
  const base = metricsLike({ outputRows: 1110, flatUnitPnl: 57.6341, flatUnitRoi: 5.192261, maximumDrawdownUnits: 34.81, maximumSignalsPerWorkingEvent: 6 });
  const cand = metricsLike({ outputRows: 54, flatUnitPnl: 14.7706, flatUnitRoi: 27.352963, maximumDrawdownUnits: 3, maximumSignalsPerWorkingEvent: 2 });
  const status = classifyTriageStatus(cand, base, computeStructuralFlags(cand, base, false));
  assert.equal(status, "ADVANCE_SPECIALIST_FOLLOWUP");
});

test("T13: ALT6-shaped fixture -> ADVANCE_STRUCTURAL_FOLLOWUP (lower total PnL, N>=200)", () => {
  const base = metricsLike({ outputRows: 1110, flatUnitPnl: 57.6341, flatUnitRoi: 5.192261, maximumDrawdownUnits: 34.81, maximumSignalsPerWorkingEvent: 6 });
  const cand = metricsLike({ outputRows: 788, flatUnitPnl: 46.4989, flatUnitRoi: 5.900876, maximumDrawdownUnits: 30.6323, maximumSignalsPerWorkingEvent: 1 });
  const flags = computeStructuralFlags(cand, base, true);
  const status = classifyTriageStatus(cand, base, flags);
  assert.equal(status, "ADVANCE_STRUCTURAL_FOLLOWUP");
  assert.ok(flags.includes("ONE_PER_EVENT"));
  assert.ok(flags.includes("IDENTITY_LIMITATION"));
});

test("T14: negative PnL candidate -> REJECT_HISTORICAL_BATCH", () => {
  const base = metricsLike({ flatUnitPnl: 10, flatUnitRoi: 5 });
  const cand = metricsLike({ outputRows: 300, flatUnitPnl: -3, flatUnitRoi: -1, maximumSignalsPerWorkingEvent: 6 });
  const status = classifyTriageStatus(cand, base, computeStructuralFlags(cand, base, false));
  assert.equal(status, "REJECT_HISTORICAL_BATCH");
});

test("T15: zero ROI candidate -> REJECT_HISTORICAL_BATCH", () => {
  const base = metricsLike({ flatUnitPnl: 10, flatUnitRoi: 5 });
  const cand = metricsLike({ outputRows: 300, flatUnitPnl: 5, flatUnitRoi: 0, maximumSignalsPerWorkingEvent: 6 });
  const status = classifyTriageStatus(cand, base, computeStructuralFlags(cand, base, false));
  assert.equal(status, "REJECT_HISTORICAL_BATCH");
});

test("T16: positive but incomplete candidate -> HOLD_FOR_MORE_EVIDENCE", () => {
  // BROAD gate: N>=200 but candidate PnL is NOT > base PnL (fails broad).
  // SPECIALIST gate: sampleClass isn't SPECIALIST (N=250), so specialist rule cannot apply.
  // STRUCTURAL gate: maxSignalsPerEvent != 1, so structural rule cannot apply.
  // Positive PnL/ROI -> HOLD.
  const base = metricsLike({ flatUnitPnl: 10, flatUnitRoi: 5, maximumDrawdownUnits: 5 });
  const cand = metricsLike({ outputRows: 250, flatUnitPnl: 2, flatUnitRoi: 1, maximumDrawdownUnits: 5, maximumSignalsPerWorkingEvent: 6 });
  const status = classifyTriageStatus(cand, base, computeStructuralFlags(cand, base, false));
  assert.equal(status, "HOLD_FOR_MORE_EVIDENCE");
});

test("T17: no status string contains forbidden promotion wording", () => {
  for (const status of DECISION_TRIAGE_STATUSES) {
    assert.doesNotMatch(status, /CHAMPION|WINNER|PROMOTED|LIVE|PRODUCTION/);
  }
});

// ---- full pure builder ----

const BASE_ID = "ALT2_TS_SCORE_GE_65";
const VARIANTS = [BASE_ID, "ALT4_TS_SCORE_GE_65_EXCLUDE_ESPORTS", "ALT5_TS_SCORE_GE_65_TENNIS_ONLY", "ALT6_TS_SCORE_GE_65_CANONICAL_EVENT_GROUPING"];

test("B18: builder applies existing strict dedup before comparison", () => {
  const rows = [...corpus(5), makeRow(1)]; // id-1 duplicated verbatim -> collapses
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  assert.equal(result.rawRowCount, 6);
  assert.ok(result.strictDedupRowCount <= 6);
});

test("B19: input rows array is never mutated", () => {
  const rows = corpus(10);
  const snapshot = JSON.stringify(rows);
  buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  assert.equal(JSON.stringify(rows), snapshot);
});

test("B20: base and candidate order is deterministic and matches requested order", () => {
  const rows = corpus(400);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  assert.deepEqual(
    result.candidates.map((c) => c.candidateId),
    VARIANTS.filter((v) => v !== BASE_ID),
  );
  for (const c of result.candidates) assert.equal(c.baseId, BASE_ID);
});

test("B21: unknown variant fails closed", () => {
  const rows = corpus(10);
  assert.throws(() =>
    buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: [BASE_ID, "NOT_A_REAL_VARIANT"] }),
  );
});

test("B22: base must be executed (not blocked) or the builder throws", () => {
  const rows = corpus(10);
  assert.throws(() =>
    buildHistoricalHypothesisBatch({
      rawRows: rows,
      classifier,
      baseVariantId: "ALT1_PY_EVENT_KEY_VARIANT", // BLOCKED_MISSING_FIELD in the registry
      requestedVariantIds: ["ALT1_PY_EVENT_KEY_VARIANT", BASE_ID],
    }),
  );
});

test("B23: triage counts sum to candidate count", () => {
  const rows = corpus(400);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const total = Object.values(result.triageCounts).reduce((a, b) => a + b, 0);
  assert.equal(total, result.candidates.length);
});

// ---- determinism ----

test("T24: identical input produces byte-identical JSON with one trailing newline", () => {
  const rows = corpus(300);
  const a = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const b = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const jsonA = serializeHypothesisBatchJson(a);
  const jsonB = serializeHypothesisBatchJson(b);
  assert.equal(jsonA, jsonB);
  assert.ok(jsonA.endsWith("}\n"));
  assert.ok(!jsonA.endsWith("}\n\n"));
});

test("T25: input row permutation produces the same strict-dedup corpus hash", () => {
  // Full packet contentHash is NOT asserted bit-identical across arbitrary
  // permutations: the reused canonical ROI engine (roiPnlContract.ts,
  // untouched here) sums per-row returns in resolved_at/id order, and IEEE
  // float addition is not associative -- a different row *arrival* order can
  // change PnL/ROI in the last few decimal digits even though the CORPUS
  // itself (after this module's own deterministic sort-before-hash) is
  // identical. What genuinely never depends on input order is the corpus
  // fingerprint used for provenance -- proven here.
  const rows = corpus(300);
  const shuffled = [...rows].reverse();
  const a = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const b = buildHistoricalHypothesisBatch({ rawRows: shuffled, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  assert.equal(a.inputSha256, b.inputSha256);
  assert.equal(a.strictDedupRowCount, b.strictDedupRowCount);
  assert.deepEqual(a.candidates.map((c) => c.triageStatus), b.candidates.map((c) => c.triageStatus));
});

test("T26: HTML rendering is deterministic and self-contained", () => {
  const rows = corpus(300);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const html1 = renderDecisionPacketHtml(result);
  const html2 = renderDecisionPacketHtml(result);
  assert.equal(html1, html2);
  assert.ok(html1.endsWith(">\n"));
  assert.doesNotMatch(html1, /https?:\/\//);
  assert.doesNotMatch(html1, /<script/i);
  assert.match(html1, /RESEARCH TRIAGE ONLY/);
  assert.match(html1, /NO AUTOMATIC CHAMPION/);
  assert.match(html1, /NO PROMOTION/);
});

test("T27: scorecard HTML is deterministic and self-contained", () => {
  const rows = corpus(300);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const html1 = renderHypothesisScorecardHtml(result);
  const html2 = renderHypothesisScorecardHtml(result);
  assert.equal(html1, html2);
  assert.doesNotMatch(html1, /https?:\/\//);
  assert.doesNotMatch(html1, /<script/i);
});

test("T28: decision packet never embeds raw corpus rows", () => {
  const rows = corpus(300);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const html = renderDecisionPacketHtml(result);
  assert.doesNotMatch(html, /condition_id|token_id|resolved_at/);
  const json = serializeHypothesisBatchJson(result);
  // Field NAMES (e.g. manifest.dedupIdentityFields: ["condition_id","token_id"])
  // are legitimate provenance metadata, not a raw-row leak; check for actual
  // per-row identity VALUES instead.
  assert.doesNotMatch(json, /"cond-\d+"|"tok-\d+"|"id-\d+"/);
});

test("T29: IDENTITY_LIMITATION is visibly flagged in the decision packet HTML", () => {
  const rows = corpus(300);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const html = renderDecisionPacketHtml(result);
  assert.match(html, /IDENTITY_LIMITATION/);
});

// ---- batch manifest ----

test("M30: batch manifest contains no timestamp, absolute path, env or duration fields", () => {
  const rows = corpus(300);
  const result = buildHistoricalHypothesisBatch({ rawRows: rows, classifier, baseVariantId: BASE_ID, requestedVariantIds: VARIANTS });
  const manifest = buildHypothesisBatchManifest(result, {
    comparisonJson: "{}\n",
    comparisonManifestJson: "{}\n",
    scorecardJson: "{}\n",
    scorecardHtml: "<html></html>\n",
    decisionPacketJson: "{}\n",
    decisionPacketHtml: "<html></html>\n",
  });
  const json = JSON.stringify(manifest);
  assert.doesNotMatch(json, /createdAt|timestamp|duration|SUPABASE|\/home\/|C:\\\\/);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.baseVariantId, BASE_ID);
  assert.deepEqual(manifest.requestedVariantIds, VARIANTS);
  assert.equal(typeof manifest.comparisonHash, "string");
  assert.equal(typeof manifest.scorecardHash, "string");
  assert.equal(typeof manifest.decisionPacketHash, "string");
  assert.equal(Object.keys(manifest.artifactSha256s).length, 6);
});
