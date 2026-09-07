import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRows, resolveSportFamily } from "../../lib/research-clone/modelReady";
import { evaluateEvent } from "../../lib/modeling/research-engine/engine";
import { ENTRY_PRICE_BAND } from "../../lib/modeling/research-engine/models";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

const series = { firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, observationCount: 0, delta: null };

/** Shape of an OLD accepted persisted row: `sportFamily` key entirely absent
 * (never rewritten), real authority only under `providerSportFamily` --
 * exactly what research_model_ready_rows.canonical_row looks like for
 * Sep03/04/06, accepted before the write-boundary carrier fix. */
function oldPersistedRow(overrides: Partial<Record<string, unknown>> = {}) {
  const base: Record<string, unknown> = {
    populationId: "SEP_PUBLIC_RICH_V1",
    conditionId: "0xold",
    selectedTokenId: "tok",
    providerEventId: "evt-old-1",
    decisionAt: "2026-09-03T01:00:00Z",
    entryPrice: 0.55,
    eventStart: "2026-09-03T04:00:00Z", // 3h lead, well under C4's 24h branch
    scoreLevel: 60,
    score: series,
    selectedPrice: series,
    volumeUsd: null,
    leadTimeHours: 36, // unrelated stored value; must NOT be trusted by the evaluator
    frozenLabel: "WIN",
    labelAsOf: "WIN",
    providerSportFamily: "soccer",
    providerSportCode: "pol",
    sport: "pol",
  };
  delete base.sportFamily; // never present on old rows
  return { ...base, ...overrides };
}

/** Shape of a NEW persisted row (post write-boundary fix): normalized
 * `sportFamily` present, `providerSportFamily` also still carried verbatim. */
function newPersistedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    populationId: "SEP_PUBLIC_RICH_V1",
    conditionId: "0xnew",
    selectedTokenId: "tok",
    providerEventId: "evt-new-1",
    decisionAt: "2026-09-08T01:00:00Z",
    entryPrice: 0.55,
    eventStart: "2026-09-08T04:00:00Z",
    scoreLevel: 60,
    score: series,
    selectedPrice: series,
    volumeUsd: null,
    leadTimeHours: null,
    frozenLabel: "WIN",
    labelAsOf: "WIN",
    sportFamily: "soccer",
    providerSportFamily: "soccer",
    ...overrides,
  };
}

test("resolveSportFamily: old providerSportFamily-only row falls back correctly", () => {
  assert.equal(resolveSportFamily({ providerSportFamily: "soccer" }), "soccer");
  assert.equal(resolveSportFamily({ providerSportFamily: "Table-Tennis" }), "table-tennis");
});

test("resolveSportFamily: new normalized sportFamily row is used directly, no fallback needed", () => {
  assert.equal(resolveSportFamily({ sportFamily: "soccer", providerSportFamily: "soccer" }), "soccer");
});

test("resolveSportFamily: genuinely missing authority on either shape stays explicit null", () => {
  assert.equal(resolveSportFamily({}), null);
  assert.equal(resolveSportFamily({ sportFamily: null, providerSportFamily: undefined }), null);
  assert.equal(resolveSportFamily({ sportFamily: "", providerSportFamily: "" }), null);
});

test("HISTORICAL_ROW_COMPATIBILITY: old providerSportFamily-only soccer row is visible to C1/C4 via the shared evaluateRows path", () => {
  const row = oldPersistedRow({ providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const result = evaluateRows([row]);
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 1, "old row visible to C1 soccer branch");
  assert.equal(result.C4.SELECTED_PHYSICAL_EVENT_N, 1, "old row visible to C4 soccer branch");
  assert.equal(result.C4.selectedBets[0]?.sportFamily, "soccer");
});

test("FUTURE_ROW_COMPATIBILITY: new normalized sportFamily row is visible to C1/C4 identically", () => {
  const row = newPersistedRow({ sportFamily: "soccer", providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const result = evaluateRows([row]);
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(result.C4.SELECTED_PHYSICAL_EVENT_N, 1);
});

test("old and new rows with identical underlying source authority evaluate identically", () => {
  const oldRow = oldPersistedRow({ providerEventId: "evt-x", conditionId: "0xevt-x", providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const newRow = newPersistedRow({ providerEventId: "evt-x", conditionId: "0xevt-x", sportFamily: "soccer", providerSportFamily: "soccer", decisionAt: (oldRow as any).decisionAt, eventStart: (oldRow as any).eventStart, entryPrice: (oldRow as any).entryPrice, labelAsOf: (oldRow as any).labelAsOf }) as unknown as ScorecardReadyRow;
  const oldResult = evaluateRows([oldRow]);
  const newResult = evaluateRows([newRow]);
  assert.equal(oldResult.C1.SELECTED_PHYSICAL_EVENT_N, newResult.C1.SELECTED_PHYSICAL_EVENT_N);
  assert.equal(oldResult.C4.SELECTED_PHYSICAL_EVENT_N, newResult.C4.SELECTED_PHYSICAL_EVENT_N);
  assert.equal(oldResult.C1.selectedBets[0]?.sportFamily, newResult.C1.selectedBets[0]?.sportFamily);
});

test("table-tennis exclusion works through the fallback for an old row", () => {
  const tableTennisOld = oldPersistedRow({ providerEventId: "evt-tt", conditionId: "0xtt", providerSportFamily: "table-tennis", entryPrice: 0.52 }) as unknown as ScorecardReadyRow;
  const soccerOld = oldPersistedRow({ providerEventId: "evt-soc", conditionId: "0xsoc", providerSportFamily: "soccer", entryPrice: 0.52 }) as unknown as ScorecardReadyRow;
  const result = evaluateRows([tableTennisOld, soccerOld]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 2);
  assert.equal(result.C5.SELECTED_PHYSICAL_EVENT_N, 1, "C5 excludes exactly the table-tennis event");
  assert.equal(result.C5.selectedBets[0]?.sportFamily, "soccer");
});

test("missing real authority on an old row (neither key populated) stays missing, not fabricated", () => {
  const row = oldPersistedRow({ providerSportFamily: undefined, entryPrice: 0.52 }) as unknown as ScorecardReadyRow;
  assert.equal(resolveSportFamily(row as any), null);
  const result = evaluateRows([row]);
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 0, "no fabricated soccer membership");
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1, "still visible to C0");
  assert.equal(result.C5.SELECTED_PHYSICAL_EVENT_N, 1, "still visible to C5 (missing is not table-tennis)");
});

test("UNCHANGED: leadTimeHours remains derived from eventStart - decisionTimestamp, not the stored materializer value", () => {
  const ev = evaluateEvent({
    physicalEventKey: "evt-lt",
    decisionTimestamp: "2026-09-03T01:00:00Z",
    eventStart: "2026-09-03T13:00:00Z",
    entryPrice: 0.55,
    sportFamily: "soccer",
    outcome: "WIN",
  });
  assert.equal(ev.leadTimeHours, 12, "derived from eventStart-decisionTimestamp, ignoring the old row's unrelated leadTimeHours:36 field");
});

test("UNCHANGED: physical-event dedup still collapses repeated old-shape candidate rows for the same event", () => {
  const a = oldPersistedRow({ providerEventId: "evt-dup", conditionId: "0xdup-a", decisionAt: "2026-09-03T01:00:00Z", providerSportFamily: "soccer", entryPrice: 0.52 }) as unknown as ScorecardReadyRow;
  const b = oldPersistedRow({ providerEventId: "evt-dup", conditionId: "0xdup-b", decisionAt: "2026-09-03T02:00:00Z", providerSportFamily: "soccer", entryPrice: 0.53 }) as unknown as ScorecardReadyRow;
  const result = evaluateRows([a, b]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1, "one physical event -> maximum one selected bet");
  assert.equal(result.C0.selectedBets[0]?.ref, "0xdup-a", "chronologically-first candidate wins");
});

test("UNCHANGED: price-band semantics are untouched by the read-boundary compatibility fallback", () => {
  assert.equal(ENTRY_PRICE_BAND.minInclusive, 0.5);
  assert.equal(ENTRY_PRICE_BAND.maxExclusive, 0.6);
  const below = oldPersistedRow({ providerEventId: "evt-low", conditionId: "0xlow", entryPrice: 0.49, providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const at = oldPersistedRow({ providerEventId: "evt-at", conditionId: "0xat", entryPrice: 0.5, providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const aboveExclusive = oldPersistedRow({ providerEventId: "evt-hi", conditionId: "0xhi", entryPrice: 0.6, providerSportFamily: "soccer" }) as unknown as ScorecardReadyRow;
  const result = evaluateRows([below, at, aboveExclusive]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(result.C0.selectedBets[0]?.entryPrice, 0.5);
});
