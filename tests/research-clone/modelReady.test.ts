import test from "node:test";
import assert from "node:assert/strict";
import { DEGRADED_MODEL_DATES, evaluateRows, toStoredModelRow } from "../../lib/research-clone/modelReady";
import { isSchemaPendingError } from "../../scripts/modeling/clone-model-ready-pipeline";

const series = { firstEligibleValue: null, firstEligibleObservedAt: null, lastEligibleValue: null, lastEligibleObservedAt: null, observationCount: 0, delta: null };
const row = (label: "WIN"|"LOSS", event="e") => ({ populationId:"SEP_PUBLIC_RICH_V1" as const, conditionId:`c-${label}-${event}`, selectedTokenId:"t", providerEventId:event, decisionAt:"2026-09-03T01:00:00Z", entryPrice:0.5, eventStart:"2026-09-03T12:00:00Z", sportFamily:"soccer", scoreLevel:60, score:series, selectedPrice:series, volumeUsd:null, leadTimeHours:11, frozenLabel:label, labelAsOf:label });

test("stored rows preserve explicit canonical grain and deterministic identity hash", () => {
  const a = toStoredModelRow("2026-09-03", row("WIN"));
  const b = toStoredModelRow("2026-09-03", row("WIN"));
  assert.equal(a.source_kind, "RESEARCH_CLONE");
  assert.equal(a.canonical_row_sha256, b.canonical_row_sha256);
  assert.equal(a.provider_event_id, "e");
});

test("frozen evaluator remains one physical event per model selection", () => {
  const result = evaluateRows([row("WIN"), row("LOSS")]);
  assert.equal(result.C0.SELECTED_PHYSICAL_EVENT_N, 1);
});

test("Sep-05 is explicitly degraded", () => assert.equal(DEGRADED_MODEL_DATES.has("2026-09-05"), true));

test("unactivated clone schema is a safe downstream no-op; other failures remain failures", () => {
  assert.equal(isSchemaPendingError(new Error("CLONE_MODEL_DAY_READ:PGRST205")), true);
  assert.equal(isSchemaPendingError(new Error("CLONE_MODEL_DAY_READ:500")), false);
});
