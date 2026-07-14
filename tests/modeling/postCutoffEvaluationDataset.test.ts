// Phase 3E.8E.2C-B -- canonical forward evaluation dataset.
//
// Pure dataset layer over the 3E.8E.2A/2B boundary: cutoff filter -> full
// evaluation-relevant projection -> exact-duplicate collapse (conflict-on-
// divergence across every projected field) -> deterministic sort + SHA-256
// hash -> a lossless adapter back to the exact row shape the frozen
// evaluators (PRIMARY/ALT2/ALT1) and ROI/event-group contracts already read.
// No model evaluation, no fs/network/env/Supabase, no raw row persistence.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPostCutoffEvaluationDataset,
  projectForwardEvaluationObservation,
  toFrozenEvaluatorRow,
  EvaluationConflictError,
  type ForwardEvaluationObservation,
} from "../../lib/modeling/postCutoffEvaluationDataset";
import { POST_CUTOFF_RESOLVED_AT_EXCLUSIVE } from "../../lib/modeling/postCutoffObservation";
import { evaluateHistoricalFunnelVariant, loadExecutableFunnelClassifier } from "../../lib/modeling/historicalFunnelVariants";
import { buildEventGroupKey } from "../../lib/modeling/eventGroupSelection";
import { computeFlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";

const AFTER1 = "2026-07-13T06:04:05.702Z";
const AFTER2 = "2026-07-14T00:00:00.000Z";
const BEFORE = "2026-07-13T06:04:05.700Z";
const EQUAL = "2026-07-13T06:04:05.701Z";

function rawRow(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${n}`,
    condition_id: `0xcond${n}`,
    token_id: `tok-${n}`,
    resolved_at: AFTER1,
    created_at: "2026-07-12T00:00:00.000Z",
    metric_formula_version: "v2-lite-growth-safe",
    signal_confidence_num: 80,
    entry_price_num: 0.6,
    smart_money_score_num: 40,
    signal_result: n % 4 === 0 ? "loss" : "win",
    realized_return_pct: n % 4 === 0 ? -100 : 40,
    diagnostics: { dataCoverage: 80, gameStartIso: "2026-07-12T06:00:00.000Z" },
    event_slug: `epl-team${n}-vs-team${n + 1}`,
    market_slug: `epl-team${n}-vs-team${n + 1}-moneyline`,
    ...overrides,
  };
}

// ---- Eligibility ----

test("E1: a pre-cutoff row is excluded", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1, { resolved_at: BEFORE })]);
  assert.equal(d.eligibleRowCount, 0);
});

test("E2: an exact-cutoff row is excluded", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1, { resolved_at: EQUAL })]);
  assert.equal(d.eligibleRowCount, 0);
});

test("E3: a post-cutoff row is included", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1)]);
  assert.equal(d.eligibleRowCount, 1);
});

test("E4: a malformed identity/timestamp row is excluded", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1, { resolved_at: "not-a-date" }), rawRow(2, { condition_id: undefined })]);
  assert.equal(d.eligibleRowCount, 0);
});

test("E5: an explicit cutoff is respected", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1)], "2026-07-13T06:04:05.900Z");
  assert.equal(d.eligibleRowCount, 0);
});

test("E6: an invalid explicit cutoff propagates the deterministic cutoff error", () => {
  assert.throws(() => buildPostCutoffEvaluationDataset([rawRow(1)], "garbage"));
});

// ---- Projection ----

test("P7: score priority matches the frozen evaluator (signal_confidence_num -> score -> signal_score -> pre_event_score_num)", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { signal_confidence_num: 90, score: 10 }))!.score, 90);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { signal_confidence_num: undefined, score: 70 }))!.score, 70);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { signal_confidence_num: undefined, score: undefined, signal_score: 55 }))!.score, 55);
  assert.equal(
    projectForwardEvaluationObservation(rawRow(1, { signal_confidence_num: undefined, score: undefined, signal_score: undefined, pre_event_score_num: 33 }))!.score,
    33,
  );
});

test("P8: coverage is extracted only from diagnostics.dataCoverage", () => {
  const obs = projectForwardEvaluationObservation(rawRow(1, { diagnostics: { dataCoverage: 61, gameStartIso: "2026-07-12T06:00:00.000Z" } }));
  assert.equal(obs!.coverage, 61);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { diagnostics: {} }))!.coverage, null);
});

test("P9: entry price is normalized (finite -> value, otherwise null)", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { entry_price_num: 0.42 }))!.entryPriceNum, 0.42);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { entry_price_num: "0.42" }))!.entryPriceNum, null);
});

test("P10: smart-money score is normalized", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { smart_money_score_num: 88 }))!.smartMoneyScoreNum, 88);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { smart_money_score_num: undefined }))!.smartMoneyScoreNum, null);
});

test("P11: result alias priority is normalized (signal_result -> result -> outcome_status)", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { signal_result: "WIN" }))!.signalResultLabel, "win");
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { signal_result: undefined, result: "Loss" }))!.signalResultLabel, "loss");
  assert.equal(
    projectForwardEvaluationObservation(rawRow(1, { signal_result: undefined, result: undefined, outcome_status: "Pending" }))!.signalResultLabel,
    "pending",
  );
});

test("P12: realized return is preserved", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { realized_return_pct: 55.5 }))!.realizedReturnPct, 55.5);
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { realized_return_pct: undefined }))!.realizedReturnPct, null);
});

test("P13: formula version is preserved", () => {
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { metric_formula_version: "v2-lite-growth-safe" }))!.metricFormulaVersion, "v2-lite-growth-safe");
  assert.equal(projectForwardEvaluationObservation(rawRow(1, { metric_formula_version: "" }))!.metricFormulaVersion, null);
});

test("P14: timing fields / derived hours are correct", () => {
  const obs = projectForwardEvaluationObservation(
    rawRow(1, { created_at: "2026-07-12T00:00:00.000Z", diagnostics: { dataCoverage: 80, gameStartIso: "2026-07-12T06:00:00.000Z" } }),
  )!;
  assert.equal(obs.hoursUntilStart, 6);
  assert.equal(obs.createdAt, "2026-07-12T00:00:00.000Z");
  assert.equal(obs.gameStartIso, "2026-07-12T06:00:00.000Z");
});

test("P15: event-group identity is sufficient to reproduce buildEventGroupKey", () => {
  const raw = rawRow(1, { event_slug: "epl-arsenal-vs-chelsea" });
  const obs = projectForwardEvaluationObservation(raw)!;
  assert.equal(obs.eventGroupKey, buildEventGroupKey(raw).key);
});

test("P16: raw diagnostics are not persisted wholesale", () => {
  const obs = projectForwardEvaluationObservation(rawRow(1, { diagnostics: { dataCoverage: 80, gameStartIso: "x", secretField: "should-not-leak" } }));
  assert.doesNotMatch(JSON.stringify(obs), /secretField|should-not-leak/);
});

test("P17: the full raw row is absent from the projection", () => {
  const obs = projectForwardEvaluationObservation(rawRow(1, { signal_result: "win", extraneousField: "leak-me-not" }));
  assert.doesNotMatch(JSON.stringify(obs), /extraneousField|leak-me-not/);
});

// ---- Duplicate / conflict ----

test("C18: an exact duplicate collapses to one observation", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1)]);
  assert.equal(d.uniqueObservationCount, 1);
});

test("C19: exactDuplicateCount increments", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1)]);
  assert.equal(d.exactDuplicateCount, 1);
  assert.equal(d.eligibleRowCount, 2);
});

test("C20: a score conflict throws EvaluationConflictError", () => {
  assert.throws(() => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { signal_confidence_num: 99 })]), EvaluationConflictError);
});

test("C21: a result conflict throws", () => {
  assert.throws(() => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { signal_result: "loss" })]), EvaluationConflictError);
});

test("C22: an entry-price conflict throws", () => {
  assert.throws(() => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { entry_price_num: 0.9 })]), EvaluationConflictError);
});

test("C23: a coverage conflict throws", () => {
  assert.throws(
    () => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { diagnostics: { dataCoverage: 10, gameStartIso: "2026-07-12T06:00:00.000Z" } })]),
    EvaluationConflictError,
  );
});

test("C24: a timing conflict throws", () => {
  assert.throws(
    () => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { created_at: "2020-01-01T00:00:00.000Z" })]),
    EvaluationConflictError,
  );
});

test("C25: a formula-version conflict throws", () => {
  assert.throws(
    () => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { metric_formula_version: "shadow-firemodel1_1_research_v0" })]),
    EvaluationConflictError,
  );
});

test("C26: an event-group conflict throws", () => {
  assert.throws(
    () => buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { event_slug: "totally-different-event" })]),
    EvaluationConflictError,
  );
});

test("C27: conflictingFields are sorted", () => {
  try {
    buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { signal_confidence_num: 5, entry_price_num: 0.99 })]);
    assert.fail("expected throw");
  } catch (e) {
    const fields = (e as EvaluationConflictError).conflictingFields;
    assert.deepEqual(fields, [...fields].sort());
    assert.ok(fields.includes("score") || fields.includes("entryPriceNum"));
  }
});

test("C28: the conflict error contains no raw row", () => {
  try {
    buildPostCutoffEvaluationDataset([rawRow(1), rawRow(1, { signal_confidence_num: 5 })]);
    assert.fail("expected throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.doesNotMatch(msg, /diagnostics|realized_return_pct|market_slug/);
  }
});

// ---- Determinism ----

test("D29: reversed input is deep-equal", () => {
  const rows = [rawRow(1), rawRow(2)];
  const a = buildPostCutoffEvaluationDataset(rows);
  const b = buildPostCutoffEvaluationDataset([...rows].reverse());
  assert.deepEqual(a, b);
});

test("D30: reversed input gives the same hash", () => {
  const rows = [rawRow(1), rawRow(2)];
  const a = buildPostCutoffEvaluationDataset(rows);
  const b = buildPostCutoffEvaluationDataset([...rows].reverse());
  assert.equal(a.datasetHash, b.datasetHash);
});

test("D31: a repeated build is deep-equal", () => {
  const rows = [rawRow(1), rawRow(2)];
  assert.deepEqual(buildPostCutoffEvaluationDataset(rows), buildPostCutoffEvaluationDataset(rows));
});

test("D32: a canonical field change changes the hash", () => {
  const a = buildPostCutoffEvaluationDataset([rawRow(1)]);
  const b = buildPostCutoffEvaluationDataset([rawRow(1, { signal_confidence_num: 5 })]);
  assert.notEqual(a.datasetHash, b.datasetHash);
});

test("D33: the hash is 64 lowercase hex characters", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1)]);
  assert.match(d.datasetHash, /^[0-9a-f]{64}$/);
});

test("D34: input rows are not mutated", () => {
  const rows = [rawRow(1), rawRow(2)];
  const snap = JSON.parse(JSON.stringify(rows));
  buildPostCutoffEvaluationDataset(rows);
  assert.deepEqual(rows, snap);
});

// ---- Adapter parity ----

const classifier = loadExecutableFunnelClassifier();

function corpus(n: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push(
      rawRow(i, {
        condition_id: `0xcond${i}`,
        token_id: `tok-${i}`,
        signal_confidence_num: 60 + (i % 40),
        diagnostics: { dataCoverage: 50 + (i % 50), gameStartIso: "2026-07-12T06:00:00.000Z" },
        event_slug: `epl-team${i}-vs-team${i + 1}`,
        market_slug: `epl-team${i}-vs-team${i + 1}-moneyline`,
      }),
    );
  }
  return rows;
}

const RAW_CORPUS = corpus(60);
const ADAPTED_CORPUS = RAW_CORPUS.map((r) => toFrozenEvaluatorRow(projectForwardEvaluationObservation(r)!));

test("A35: the adapter recreates score fields expected by the frozen evaluator", () => {
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(rawRow(1, { signal_confidence_num: 77 }))!);
  assert.equal(adapted.signal_confidence_num, 77);
});

test("A36: the adapter recreates coverage diagnostics", () => {
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(rawRow(1, { diagnostics: { dataCoverage: 63, gameStartIso: "2026-07-12T06:00:00.000Z" } }))!);
  assert.equal((adapted.diagnostics as Record<string, unknown>).dataCoverage, 63);
});

test("A37: the adapter recreates timing inputs (created_at + diagnostics.gameStartIso)", () => {
  const raw = rawRow(1, { created_at: "2026-07-12T00:00:00.000Z", diagnostics: { dataCoverage: 80, gameStartIso: "2026-07-12T06:00:00.000Z" } });
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(raw)!);
  assert.equal(adapted.created_at, "2026-07-12T00:00:00.000Z");
  assert.equal((adapted.diagnostics as Record<string, unknown>).gameStartIso, "2026-07-12T06:00:00.000Z");
});

test("A38: the adapter recreates league/sport fields (market_slug + event_slug)", () => {
  const raw = rawRow(1, { event_slug: "nba-lakers-vs-celtics", market_slug: "nba-lakers-vs-celtics-moneyline" });
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(raw)!);
  assert.equal(adapted.event_slug, "nba-lakers-vs-celtics");
  assert.equal(adapted.market_slug, "nba-lakers-vs-celtics-moneyline");
});

test("A39: the adapter recreates result/ROI fields", () => {
  const raw = rawRow(1, { signal_result: "win", realized_return_pct: 42, entry_price_num: 0.5 });
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(raw)!);
  assert.equal(adapted.signal_result, "win");
  assert.equal(adapted.realized_return_pct, 42);
  assert.equal(adapted.entry_price_num, 0.5);
});

test("A40: the adapter recreates event-group source fields", () => {
  const raw = rawRow(1, { match_family_key: "mf-1", event_slug: "epl-x-vs-y" });
  const adapted = toFrozenEvaluatorRow(projectForwardEvaluationObservation(raw)!);
  assert.equal(buildEventGroupKey(adapted).key, buildEventGroupKey(raw).key);
});

test("A41: original vs adapted fixtures produce identical PRIMARY membership", () => {
  const rawResult = evaluateHistoricalFunnelVariant(RAW_CORPUS, classifier, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  const adaptedResult = evaluateHistoricalFunnelVariant(ADAPTED_CORPUS, classifier, "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP");
  assert.equal(adaptedResult.outputRows, rawResult.outputRows);
  assert.deepEqual(
    adaptedResult.selectedRows.map((r) => r.condition_id),
    rawResult.selectedRows.map((r) => r.condition_id),
  );
});

test("A42: original vs adapted fixtures produce identical ALT2 membership", () => {
  const rawResult = evaluateHistoricalFunnelVariant(RAW_CORPUS, classifier, "ALT2_TS_SCORE_GE_65");
  const adaptedResult = evaluateHistoricalFunnelVariant(ADAPTED_CORPUS, classifier, "ALT2_TS_SCORE_GE_65");
  assert.equal(adaptedResult.outputRows, rawResult.outputRows);
  assert.deepEqual(
    adaptedResult.selectedRows.map((r) => r.condition_id),
    rawResult.selectedRows.map((r) => r.condition_id),
  );
});

test("A43: original vs adapted fixtures produce identical ALT1 membership", () => {
  const rawResult = evaluateHistoricalFunnelVariant(RAW_CORPUS, classifier, "ALT1_CANONICAL_EVENT_GROUPING");
  const adaptedResult = evaluateHistoricalFunnelVariant(ADAPTED_CORPUS, classifier, "ALT1_CANONICAL_EVENT_GROUPING");
  assert.equal(adaptedResult.outputRows, rawResult.outputRows);
  assert.deepEqual(
    adaptedResult.selectedRows.map((r) => r.condition_id),
    rawResult.selectedRows.map((r) => r.condition_id),
  );
});

test("A44: ROI summary for the original fixture equals ROI summary for the adapted fixture", () => {
  const rawRoi = computeFlatStakeRoiSummary(RAW_CORPUS, { strict: false, stakeUnits: 1 });
  const adaptedRoi = computeFlatStakeRoiSummary(ADAPTED_CORPUS, { strict: false, stakeUnits: 1 });
  assert.equal(rawRoi.totalPnlUnits, adaptedRoi.totalPnlUnits);
  assert.equal(rawRoi.roiPct, adaptedRoi.roiPct);
  assert.equal(rawRoi.winCount, adaptedRoi.winCount);
  assert.equal(rawRoi.lossCount, adaptedRoi.lossCount);
});

test("A45: the event-group key from the original row equals the event-group key from the adapted row", () => {
  for (let i = 0; i < RAW_CORPUS.length; i++) {
    assert.equal(buildEventGroupKey(ADAPTED_CORPUS[i]).key, buildEventGroupKey(RAW_CORPUS[i]).key);
  }
});

// ---- Locked constant sanity ----

test("L0: the dataset embeds the locked default cutoff", () => {
  const d = buildPostCutoffEvaluationDataset([rawRow(1)]);
  assert.equal(d.cutoffResolvedAtExclusive, POST_CUTOFF_RESOLVED_AT_EXCLUSIVE);
});
