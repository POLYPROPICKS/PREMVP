import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMaterializedSportFamily } from "../../scripts/modeling/clone-model-ready-pipeline";
import { evaluateRows } from "../../lib/research-clone/modelReady";
import { evaluateEvent } from "../../lib/modeling/research-engine/engine";
import { FROZEN_MODELS, ENTRY_PRICE_BAND } from "../../lib/modeling/research-engine/models";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

const series = { firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, observationCount: 0, delta: null };

/** The actual shape persisted by scripts/modeling/live-d1-research-corpus.ts: it
 * carries `providerSportFamily`, never a `sportFamily` key. */
function persistedMaterializerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    populationId: "SEP_PUBLIC_RICH_V1",
    conditionId: "0xcondition",
    selectedTokenId: "tok",
    providerEventId: "evt-1",
    decisionAt: "2026-09-03T01:00:00Z",
    entryPrice: 0.55,
    eventStart: "2026-09-04T13:00:00Z",
    scoreLevel: 60,
    score: series,
    selectedPrice: series,
    volumeUsd: null,
    leadTimeHours: 36,
    label: "WIN",
    providerSportFamily: "soccer",
    providerSportCode: "pol",
    sport: "pol",
    marketFamily: null,
    marketTypeRaw: null,
    formulaVersion: "trusted-initial-formula-v1.1",
    ...overrides,
  };
}

test("providerSportFamily carries through the normalization boundary verbatim (lowercased)", () => {
  assert.equal(normalizeMaterializedSportFamily({ providerSportFamily: "soccer" }), "soccer");
  assert.equal(normalizeMaterializedSportFamily({ providerSportFamily: "Table-Tennis" }), "table-tennis");
});

test("missing providerSportFamily stays explicit null; never fabricated", () => {
  assert.equal(normalizeMaterializedSportFamily({}), null);
  assert.equal(normalizeMaterializedSportFamily({ providerSportFamily: "" }), null);
  assert.equal(normalizeMaterializedSportFamily({ providerSportFamily: "   " }), null);
});

function toScorecardReadyRow(raw: ReturnType<typeof persistedMaterializerRow>): ScorecardReadyRow {
  // Mirrors clone-model-ready-pipeline.ts loadRows(): normalize the real
  // persisted shape into the frozen-evaluator ScorecardReadyRow carrier.
  return {
    ...(raw as unknown as ScorecardReadyRow),
    sportFamily: normalizeMaterializedSportFamily(raw),
    frozenLabel: raw.label as "WIN" | "LOSS",
    labelAsOf: raw.label as "WIN" | "LOSS",
  };
}

test("REGRESSION: persisted providerSportFamily='soccer' row normalizes to sportFamily='soccer'", () => {
  const row = toScorecardReadyRow(persistedMaterializerRow({ providerSportFamily: "soccer" }));
  assert.equal(row.sportFamily, "soccer");
});

test("REGRESSION: normalized soccer row is visible to the frozen evaluator via evaluateRows (same evaluator used in production)", () => {
  // decisionAt -> eventStart is 3h apart (well under the 24h C4 lead-time
  // threshold), so C4 can only select this event via the soccer branch.
  const row = toScorecardReadyRow(persistedMaterializerRow({
    providerSportFamily: "soccer", entryPrice: 0.55,
    decisionAt: "2026-09-03T01:00:00Z", eventStart: "2026-09-03T04:00:00Z",
  }));
  const result = evaluateRows([row]);

  // C1 = price band AND soccer -> selects the event.
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 1, "C1_SELECTS_SOCCER = YES expected");
  // C4 = price band AND (soccer OR lead_time_hours >= 24) -> soccer branch selects it
  // even though lead_time_hours (3h) is below the 24h threshold.
  assert.equal(result.C4.SELECTED_PHYSICAL_EVENT_N, 1, "C4_SELECTS_SOCCER = YES expected");
  assert.equal(result.C4.selectedBets[0]?.sportFamily, "soccer");
});

test("BEFORE-FIX REPRODUCTION: without normalization the same soccer row is invisible to C4's soccer branch", () => {
  const raw = persistedMaterializerRow({
    providerSportFamily: "soccer", entryPrice: 0.55,
    decisionAt: "2026-09-03T01:00:00Z", eventStart: "2026-09-03T04:00:00Z",
  });
  // Simulates the pre-fix defect: spreading the raw materialized row directly
  // and forcing it `as ScorecardReadyRow` never produces a `sportFamily` key,
  // so the consumer's `r.sportFamily ?? ""` silently becomes "".
  const brokenRow = { ...raw, frozenLabel: raw.label, labelAsOf: raw.label } as unknown as ScorecardReadyRow;
  assert.equal((brokenRow as any).sportFamily, undefined);
  const result = evaluateRows([brokenRow]);
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 0, "pre-fix: soccer-only C1 cannot see this event");
  assert.equal(result.C4.SELECTED_PHYSICAL_EVENT_N, 0, "pre-fix: soccer branch of C4 cannot see this event, and lead_time_hours=3 < 24 also fails");
});

test("REGRESSION: C5 still applies table-tennis exclusion correctly against a normalized carrier", () => {
  const tableTennisRow = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-tt", conditionId: "0xtt", providerSportFamily: "table-tennis", entryPrice: 0.52 }));
  const soccerRow = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-soc", conditionId: "0xsoc", providerSportFamily: "soccer", entryPrice: 0.52 }));
  const result = evaluateRows([tableTennisRow, soccerRow]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 2, "C0 selects both -- price band only");
  assert.equal(result.C5.SELECTED_PHYSICAL_EVENT_N, 1, "C5 excludes exactly the table-tennis event");
  assert.equal(result.C5.selectedBets[0]?.sportFamily, "soccer");
});

test("REGRESSION: a row with genuinely missing sport authority stays excluded from C1/soccer path, never fabricated", () => {
  const row = toScorecardReadyRow(persistedMaterializerRow({ providerSportFamily: undefined, entryPrice: 0.52 }));
  assert.equal(row.sportFamily, null);
  const result = evaluateRows([row]);
  assert.equal(result.C1.SELECTED_PHYSICAL_EVENT_N, 0);
  // Still visible to C0/C5 (missing sport is not table-tennis) -- unchanged predicate behavior.
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(result.C5.SELECTED_PHYSICAL_EVENT_N, 1);
});

test("UNCHANGED: price-band semantics are untouched by the carrier fix", () => {
  assert.equal(ENTRY_PRICE_BAND.minInclusive, 0.5);
  assert.equal(ENTRY_PRICE_BAND.maxExclusive, 0.6);
  const below = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-low", conditionId: "0xlow", entryPrice: 0.49, providerSportFamily: "soccer" }));
  const at = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-at", conditionId: "0xat", entryPrice: 0.5, providerSportFamily: "soccer" }));
  const aboveExclusive = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-hi", conditionId: "0xhi", entryPrice: 0.6, providerSportFamily: "soccer" }));
  const result = evaluateRows([below, at, aboveExclusive]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1);
  assert.equal(result.C0.selectedBets[0]?.entryPrice, 0.5);
});

test("UNCHANGED: physical-event dedup still collapses repeated candidate rows for the same event to one selection", () => {
  const a = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-dup", conditionId: "0xdup-a", decisionAt: "2026-09-03T01:00:00Z", providerSportFamily: "soccer", entryPrice: 0.52 }));
  const b = toScorecardReadyRow(persistedMaterializerRow({ providerEventId: "evt-dup", conditionId: "0xdup-b", decisionAt: "2026-09-03T02:00:00Z", providerSportFamily: "soccer", entryPrice: 0.53 }));
  const result = evaluateRows([a, b]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1, "one physical event -> maximum one selected bet");
  assert.equal(result.C0.selectedBets[0]?.ref, "0xdup-a", "chronologically-first candidate wins");
});

test("UNCHANGED: leadTimeHours remains derived from eventStart - decisionTimestamp, not from the stored materializer value", () => {
  // decisionAt=01:00Z, eventStart=13:00Z same day -> 12h, regardless of the
  // (unrelated) leadTimeHours value the persisted row happens to carry.
  const ev = evaluateEvent({
    physicalEventKey: "evt-lt",
    decisionTimestamp: "2026-09-03T01:00:00Z",
    eventStart: "2026-09-03T13:00:00Z",
    entryPrice: 0.55,
    sportFamily: "soccer",
    outcome: "WIN",
  });
  assert.equal(ev.leadTimeHours, 12);
});

test("UNCHANGED: no frozen model threshold was modified", () => {
  assert.equal(FROZEN_MODELS.C0.predicateDescription, "0.50 <= entry_price < 0.60");
  assert.equal(FROZEN_MODELS.C1.predicateDescription, "0.50 <= entry_price < 0.60 AND sport_family = soccer");
  assert.equal(FROZEN_MODELS.C4.predicateDescription, "0.50 <= entry_price < 0.60 AND (sport_family = soccer OR lead_time_hours >= 24)");
  assert.equal(FROZEN_MODELS.C5.predicateDescription, "0.50 <= entry_price < 0.60 AND sport_family != table-tennis");
});
