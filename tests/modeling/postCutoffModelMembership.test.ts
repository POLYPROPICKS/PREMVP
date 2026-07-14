// Phase 3E.8E.2D -- frozen post-cutoff model membership + forward metrics.
//
// evaluatePostCutoffFrozenModels consumes the canonical
// PostCutoffEvaluationDataset, runs exactly the three frozen variants through
// the existing frozen evaluator (never re-deriving thresholds), maps selected
// evaluator rows back to canonical observation keys, and computes PnL/ROI,
// equity/drawdown, event concentration, and UTC weekly metrics -- all via the
// existing canonical contracts. Deterministic, pure: no fs/network/env/clock.

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePostCutoffFrozenModels,
  POST_CUTOFF_FROZEN_VARIANT_IDS,
} from "../../lib/modeling/postCutoffModelMembership";
import {
  buildPostCutoffEvaluationDataset,
  toFrozenEvaluatorRow,
  type PostCutoffEvaluationDataset,
} from "../../lib/modeling/postCutoffEvaluationDataset";
import { buildObservationKey } from "../../lib/modeling/postCutoffObservation";
import {
  evaluateHistoricalFunnelVariant,
  loadExecutableFunnelClassifier,
} from "../../lib/modeling/historicalFunnelVariants";
import { computeFlatStakeRoiSummary } from "../../lib/modeling/roiPnlContract";

const classifier = loadExecutableFunnelClassifier();

// All defaults PASS every frozen variant (score>=72, safe coverage/price, no
// NBA/NHL, no timing window, resolved strictly after the frozen cutoff).
function makeRow(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    condition_id: `0xcond-${id}`,
    token_id: `tok-${id}`,
    resolved_at: "2026-07-14T00:00:00.000Z",
    created_at: "2026-07-10T00:00:00.000Z",
    signal_confidence_num: 80,
    entry_price_num: 0.5,
    signal_result: "win",
    realized_return_pct: 40,
    event_slug: `soccer-match-${id}`,
    diagnostics: { dataCoverage: 80 },
    ...over,
  };
}

function datasetOf(rows: Record<string, unknown>[]): PostCutoffEvaluationDataset {
  return buildPostCutoffEvaluationDataset(rows);
}

function evaluate(dataset: PostCutoffEvaluationDataset) {
  return evaluatePostCutoffFrozenModels(dataset, classifier);
}

function modelOf(result: ReturnType<typeof evaluate>, variantId: string) {
  const m = result.models.find((x) => x.variantId === variantId);
  assert.ok(m, `missing model ${variantId}`);
  return m!;
}

// Direct frozen-evaluator membership (source of truth for parity assertions).
function directMembership(dataset: PostCutoffEvaluationDataset, variantId: string): string[] {
  const rows = dataset.observations.map(toFrozenEvaluatorRow);
  const res = evaluateHistoricalFunnelVariant(rows, classifier, variantId);
  return res.selectedRows.map((r) => buildObservationKey(r) as string).filter((k) => k !== null).sort();
}

const [PRIMARY, ALT2, ALT1] = POST_CUTOFF_FROZEN_VARIANT_IDS;

// A mixed corpus: high-score soccer rows (pass all), a 68-score row (ALT2 only),
// a sub-threshold row (none), an NBA row (ALT2 + ALT1, not PRIMARY), and two
// rows sharing one event (ALT1 dedups, PRIMARY/ALT2 keep both).
function mixedCorpus(): Record<string, unknown>[] {
  return [
    makeRow("a", { signal_confidence_num: 80 }),
    makeRow("b", { signal_confidence_num: 68 }), // ALT2 only (>=65, <72)
    makeRow("c", { signal_confidence_num: 40 }), // none
    makeRow("d", { signal_confidence_num: 90, event_slug: "nba-lakers-celtics", market_slug: "nba" }),
    makeRow("e", { signal_confidence_num: 85, event_slug: "shared-event" }),
    makeRow("f", { signal_confidence_num: 84, event_slug: "shared-event", token_id: "tok-f2" }),
  ];
}

// ---- Input validation ----

test("T1: invalid schemaVersion throws", () => {
  const ds = datasetOf([makeRow("a")]);
  assert.throws(() => evaluate({ ...ds, schemaVersion: 2 as unknown as 1 }));
});

test("T2: invalid dataset hash throws", () => {
  const ds = datasetOf([makeRow("a")]);
  assert.throws(() => evaluate({ ...ds, datasetHash: "NOTHEX" }));
  assert.throws(() => evaluate({ ...ds, datasetHash: ds.datasetHash.toUpperCase() }));
});

test("T3: mismatched observation count throws", () => {
  const ds = datasetOf([makeRow("a"), makeRow("b")]);
  assert.throws(() => evaluate({ ...ds, uniqueObservationCount: 99 }));
});

test("T4: valid empty dataset accepted", () => {
  const ds = datasetOf([]);
  const result = evaluate(ds);
  assert.equal(result.models.length, 3);
});

// ---- Model dispatch ----

test("T5-T7: exactly three frozen variants in locked order, no extras", () => {
  const result = evaluate(datasetOf(mixedCorpus()));
  assert.equal(result.models.length, 3);
  assert.deepEqual(result.models.map((m) => m.variantId), [PRIMARY, ALT2, ALT1]);
});

test("T8: evaluator reused, not local thresholds (65 vs 72 fixture)", () => {
  const ds = datasetOf(mixedCorpus());
  const result = evaluate(ds);
  const bKey = ds.observations.find((o) => o.sourceId === "b")!.observationKey;
  // score-68 row is in ALT2 (>=65) but not PRIMARY/ALT1 (>=72): thresholds come
  // from the frozen evaluator, not duplicated in this module.
  assert.ok(modelOf(result, ALT2).selectedObservationKeys.includes(bKey));
  assert.ok(!modelOf(result, PRIMARY).selectedObservationKeys.includes(bKey));
  assert.ok(!modelOf(result, ALT1).selectedObservationKeys.includes(bKey));
});

// ---- Membership parity ----

test("T9: PRIMARY membership matches direct frozen evaluator", () => {
  const ds = datasetOf(mixedCorpus());
  assert.deepEqual([...modelOf(evaluate(ds), PRIMARY).selectedObservationKeys].sort(), directMembership(ds, PRIMARY));
});

test("T10: ALT2 membership matches direct frozen evaluator", () => {
  const ds = datasetOf(mixedCorpus());
  assert.deepEqual([...modelOf(evaluate(ds), ALT2).selectedObservationKeys].sort(), directMembership(ds, ALT2));
});

test("T11: ALT1 membership matches direct frozen evaluator", () => {
  const ds = datasetOf(mixedCorpus());
  assert.deepEqual([...modelOf(evaluate(ds), ALT1).selectedObservationKeys].sort(), directMembership(ds, ALT1));
});

test("T12: mapping uses canonical observation key", () => {
  const ds = datasetOf(mixedCorpus());
  const keys = new Set(ds.observations.map((o) => o.observationKey));
  for (const m of evaluate(ds).models) {
    for (const k of m.selectedObservationKeys) assert.ok(keys.has(k), `unknown key ${k}`);
  }
});

test("T13: selected keys deterministic after reversed input", () => {
  const rows = mixedCorpus();
  const a = evaluate(datasetOf(rows));
  const b = evaluate(datasetOf([...rows].reverse()));
  for (const v of POST_CUTOFF_FROZEN_VARIANT_IDS) {
    assert.deepEqual(modelOf(a, v).selectedObservationKeys, modelOf(b, v).selectedObservationKeys);
  }
});

test("T14: unmappable selected row throws integrity error", () => {
  const ds = datasetOf([makeRow("a")]);
  // Corrupt the stored key so it can no longer be rebuilt from the canonical
  // tuple; the selected frozen row rebuilds a different key -> unmappable.
  const corrupt: PostCutoffEvaluationDataset = {
    ...ds,
    observations: ds.observations.map((o) => ({ ...o, observationKey: "CORRUPT::KEY::MISMATCH" })),
  };
  assert.throws(() => evaluate(corrupt), /integrity/i);
});

// ---- PnL / ROI ----

function roiKeysParity(dataset: PostCutoffEvaluationDataset, variantId: string) {
  const selectedObs = dataset.observations.filter((o) =>
    directMembership(dataset, variantId).includes(o.observationKey),
  );
  return computeFlatStakeRoiSummary(selectedObs.map(toFrozenEvaluatorRow), { strict: true, stakeUnits: 1 });
}

test("T15-T17: PnL/ROI equal direct computeFlatStakeRoiSummary for each variant", () => {
  const ds = datasetOf(mixedCorpus());
  const result = evaluate(ds);
  for (const v of POST_CUTOFF_FROZEN_VARIANT_IDS) {
    const m = modelOf(result, v);
    const roi = roiKeysParity(ds, v);
    assert.equal(m.totalPnlUnits, roi.totalPnlUnits);
    assert.equal(m.roiPct, roi.roiPct);
    assert.equal(m.winCount, roi.winCount);
    assert.equal(m.lossCount, roi.lossCount);
  }
});

test("T18-T19: invalid row count preserved; strict PnL/ROI null", () => {
  // score-80 win row with no realized return and no valid entry price -> invalid.
  const ds = datasetOf([
    makeRow("ok", { realized_return_pct: 40 }),
    makeRow("bad", { realized_return_pct: undefined, entry_price_num: undefined }),
  ]);
  const m = modelOf(evaluate(ds), ALT2);
  assert.equal(m.invalidRowCount, 1);
  assert.equal(m.totalPnlUnits, null);
  assert.equal(m.roiPct, null);
  assert.equal(m.winCount, 1); // the clean win still counted
});

test("T20: real_pnl_usd has no influence on PnL", () => {
  const base = evaluate(datasetOf([makeRow("a")]));
  const withNoise = evaluate(datasetOf([makeRow("a", { real_pnl_usd: 999999 })]));
  assert.equal(modelOf(base, ALT2).totalPnlUnits, modelOf(withNoise, ALT2).totalPnlUnits);
});

// ---- Equity / drawdown ----

// Force a controlled selection by using ALT2 (score>=65 keep-all): every row is
// selected, so the model's equity path == the crafted rows in resolved order.
function alt2Equity(rows: Record<string, unknown>[]) {
  return modelOf(evaluate(datasetOf(rows)), ALT2);
}

function eqRow(id: string, day: string, ret: number): Record<string, unknown> {
  const result = ret >= 0 ? "win" : "loss";
  return makeRow(id, { resolved_at: `2026-07-${day}T00:00:00.000Z`, signal_result: result, realized_return_pct: ret });
}

test("T21: all-win path -> final equals peak, zero drawdown", () => {
  const m = alt2Equity([eqRow("a", "14", 40), eqRow("b", "15", 20)]);
  assert.ok(Math.abs((m.finalEquityUnits as number) - 0.6) < 1e-9);
  assert.equal(m.finalEquityUnits, m.peakEquityUnits);
  assert.equal(m.currentDrawdownUnits, 0);
  assert.equal(m.maxDrawdownUnits, 0);
});

test("T22: win-loss path drawdown", () => {
  const m = alt2Equity([eqRow("a", "14", 100), eqRow("b", "15", -100)]);
  assert.ok(Math.abs((m.peakEquityUnits as number) - 1) < 1e-9);
  assert.ok(Math.abs((m.finalEquityUnits as number) - 0) < 1e-9);
  assert.ok(Math.abs((m.maxDrawdownUnits as number) - 1) < 1e-9);
});

test("T23-T24: drawdown recovery -> current differs from max", () => {
  // +1, -1, -1, +1.5 : trough at -1 (peak 1 -> equity -1 => dd 2), recovers.
  const m = alt2Equity([eqRow("a", "14", 100), eqRow("b", "15", -100), eqRow("c", "16", -100), eqRow("d", "17", 150)]);
  assert.ok(Math.abs((m.maxDrawdownUnits as number) - 2) < 1e-9);
  assert.ok((m.currentDrawdownUnits as number) < (m.maxDrawdownUnits as number));
});

test("T25: invalid row blocks equity metrics (all null)", () => {
  const m = alt2Equity([
    eqRow("a", "14", 40),
    makeRow("bad", { resolved_at: "2026-07-15T00:00:00.000Z", realized_return_pct: undefined, entry_price_num: undefined }),
  ]);
  assert.equal(m.finalEquityUnits, null);
  assert.equal(m.peakEquityUnits, null);
  assert.equal(m.currentDrawdownUnits, null);
  assert.equal(m.maxDrawdownUnits, null);
});

test("T26: zero-row equity semantics", () => {
  const m = modelOf(evaluate(datasetOf([])), ALT2);
  assert.equal(m.finalEquityUnits, 0);
  assert.equal(m.peakEquityUnits, 0);
  assert.equal(m.currentDrawdownUnits, 0);
  assert.equal(m.maxDrawdownUnits, 0);
});

test("T27: equity ordering by resolvedAt is deterministic under reversed input", () => {
  const rows = [eqRow("a", "14", 100), eqRow("b", "15", -100), eqRow("c", "16", 50)];
  const a = alt2Equity(rows);
  const b = alt2Equity([...rows].reverse());
  assert.equal(a.maxDrawdownUnits, b.maxDrawdownUnits);
  assert.equal(a.finalEquityUnits, b.finalEquityUnits);
});

// ---- Event concentration ----

test("T28: one observation -> one group, max 1", () => {
  const c = alt2Equity([makeRow("a")]).eventConcentration;
  assert.equal(c.eventGroupCount, 1);
  assert.equal(c.multiSignalEventGroupCount, 0);
  assert.equal(c.maxSignalsPerEvent, 1);
});

test("T29: two signals same event -> one group, max 2", () => {
  const c = alt2Equity([
    makeRow("a", { event_slug: "shared" }),
    makeRow("b", { event_slug: "shared", token_id: "tok-b2" }),
  ]).eventConcentration;
  assert.equal(c.eventGroupCount, 1);
  assert.equal(c.multiSignalEventGroupCount, 1);
  assert.equal(c.maxSignalsPerEvent, 2);
});

test("T30: two separate events -> two groups, max 1", () => {
  const c = alt2Equity([makeRow("a", { event_slug: "one" }), makeRow("b", { event_slug: "two" })]).eventConcentration;
  assert.equal(c.eventGroupCount, 2);
  assert.equal(c.maxSignalsPerEvent, 1);
});

test("T31: weak/fallback grouping keys remain isolated", () => {
  // Two rows sharing condition_id but no event identity -> condition fallback;
  // must NOT merge, each is its own synthetic group.
  const c = alt2Equity([
    makeRow("a", { condition_id: "0xsame", token_id: "tok-1", event_slug: undefined, market_slug: undefined }),
    makeRow("b", { condition_id: "0xsame", token_id: "tok-2", event_slug: undefined, market_slug: undefined }),
  ]).eventConcentration;
  assert.equal(c.eventGroupCount, 2);
  assert.equal(c.maxSignalsPerEvent, 1);
});

test("T32: ALT1 maxSignalsPerEvent remains 1 on grouping fixture", () => {
  const ds = datasetOf([
    makeRow("a", { event_slug: "shared" }),
    makeRow("b", { event_slug: "shared", token_id: "tok-b2" }),
  ]);
  const c = modelOf(evaluate(ds), ALT1).eventConcentration;
  assert.equal(c.maxSignalsPerEvent, 1);
});

test("T33: zero-row concentration all zero", () => {
  const c = modelOf(evaluate(datasetOf([])), ALT2).eventConcentration;
  assert.deepEqual(c, { eventGroupCount: 0, multiSignalEventGroupCount: 0, maxSignalsPerEvent: 0 });
});

// ---- Weekly metrics ----

test("T34: one week produces one bucket", () => {
  const m = alt2Equity([eqRow("a", "14", 40), eqRow("b", "15", 40)]);
  assert.equal(m.weeklyMetrics.length, 1);
});

test("T35: two weeks sorted ascending", () => {
  const m = alt2Equity([eqRow("a", "21", 40), eqRow("b", "14", 40)]);
  assert.equal(m.weeklyMetrics.length, 2);
  assert.deepEqual(m.weeklyMetrics.map((w) => w.weekBucket), ["2026-07-13", "2026-07-20"]);
});

test("T36: weekly PnL uses only that week's rows", () => {
  const m = alt2Equity([eqRow("a", "14", 100), eqRow("b", "21", -100)]);
  const [w1, w2] = m.weeklyMetrics;
  assert.ok((w1.totalPnlUnits as number) > 0);
  assert.ok((w2.totalPnlUnits as number) < 0);
});

test("T37: cumulative PnL carries forward", () => {
  const m = alt2Equity([eqRow("a", "14", 100), eqRow("b", "21", 40)]);
  const [w1, w2] = m.weeklyMetrics;
  assert.ok(Math.abs((w1.cumulativePnlUnits as number) - 1) < 1e-9);
  assert.ok(Math.abs((w2.cumulativePnlUnits as number) - 1.4) < 1e-9);
});

test("T38: weekly current/max drawdown reconciles with full equity path", () => {
  const m = alt2Equity([eqRow("a", "14", 100), eqRow("b", "15", -100), eqRow("c", "21", -100)]);
  const last = m.weeklyMetrics[m.weeklyMetrics.length - 1];
  assert.equal(last.currentDrawdownUnits, m.currentDrawdownUnits);
  assert.equal(last.maxDrawdownUnits, m.maxDrawdownUnits);
});

test("T39: weekly counts sum to selectedObservationCount", () => {
  const m = alt2Equity([eqRow("a", "14", 40), eqRow("b", "15", 40), eqRow("c", "21", 40)]);
  const sum = m.weeklyMetrics.reduce((s, w) => s + w.selectedObservationCount, 0);
  assert.equal(sum, m.selectedObservationCount);
});

test("T40: invalid financial row preserves counts but nulls strict financial path", () => {
  const m = alt2Equity([
    makeRow("bad", { resolved_at: "2026-07-14T00:00:00.000Z", realized_return_pct: undefined, entry_price_num: undefined }),
    eqRow("b", "21", 40),
  ]);
  const w1 = m.weeklyMetrics[0];
  assert.equal(w1.selectedObservationCount, 1);
  assert.equal(w1.invalidRowCount, 1);
  assert.equal(w1.totalPnlUnits, null);
  assert.equal(w1.cumulativePnlUnits, null);
  // cumulative stays blocked forward
  assert.equal(m.weeklyMetrics[1].cumulativePnlUnits, null);
});

// ---- Determinism / hash ----

test("T41-T42: reversed observations -> deep-equal result and same hash", () => {
  const rows = mixedCorpus();
  const a = evaluate(datasetOf(rows));
  const ds = datasetOf(rows);
  const reversed: PostCutoffEvaluationDataset = { ...ds, observations: [...ds.observations].reverse() };
  const b = evaluate(reversed);
  assert.deepEqual(a, b);
  assert.equal(a.evaluationHash, b.evaluationHash);
});

test("T43: repeated run deep-equal", () => {
  const ds = datasetOf(mixedCorpus());
  assert.deepEqual(evaluate(ds), evaluate(ds));
});

test("T44: a canonical model result change changes the hash", () => {
  const a = evaluate(datasetOf([makeRow("a", { realized_return_pct: 40 })]));
  const b = evaluate(datasetOf([makeRow("a", { realized_return_pct: 80 })]));
  assert.notEqual(a.evaluationHash, b.evaluationHash);
});

test("T45: hash is 64 lowercase hex", () => {
  const result = evaluate(datasetOf(mixedCorpus()));
  assert.match(result.evaluationHash, /^[0-9a-f]{64}$/);
});

test("T46: input dataset is not mutated", () => {
  const ds = datasetOf(mixedCorpus());
  const before = JSON.stringify(ds);
  evaluate(ds);
  assert.equal(JSON.stringify(ds), before);
});

test("T47: output contains no runtime timestamp field", () => {
  const result = evaluate(datasetOf(mixedCorpus()));
  assert.deepEqual(
    Object.keys(result).sort(),
    ["cutoffResolvedAtExclusive", "datasetHash", "evaluationHash", "inputObservationCount", "models", "schemaVersion"],
  );
});

// ---- Locked-safety assertions ----

test("T48: variant IDs exactly equal the locked set", () => {
  assert.deepEqual([...POST_CUTOFF_FROZEN_VARIANT_IDS], [
    "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    "ALT2_TS_SCORE_GE_65",
    "ALT1_CANONICAL_EVENT_GROUPING",
  ]);
});

test("T49-T51: no champion/promotion/recommendation/raw-row fields in output", () => {
  const result = evaluate(datasetOf(mixedCorpus()));
  const banned = ["champion", "promotion", "promote", "recommendation", "recommended", "rows", "diagnostics", "rawRows"];
  const blob = JSON.stringify(result).toLowerCase();
  for (const term of banned) assert.ok(!blob.includes(term), `output leaked "${term}"`);
});
