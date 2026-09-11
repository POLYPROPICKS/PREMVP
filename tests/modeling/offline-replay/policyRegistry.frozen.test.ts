/**
 * POLICY REGISTRY — proves C0/C1/C4/C5 delegate to the FROZEN research engine
 * predicates (no re-encoded thresholds) and C2/C3 compose from the same
 * exported frozen constants.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FROZEN_MODELS,
  ENTRY_PRICE_BAND,
  C4_LEAD_TIME_HOURS_THRESHOLD,
} from "../../../lib/modeling/research-engine";
import { POLICY_REGISTRY } from "../../../lib/modeling/offline-replay/policyRegistry";
import type { ModelReadyRow } from "../../../lib/modeling/offline-replay/types";

function row(over: Partial<ModelReadyRow>): ModelReadyRow {
  return {
    research_identity: "c|t",
    physical_event_id: "e",
    provider_event_id: "e",
    condition_id: "c",
    selected_token_id: "t",
    selected_outcome: "Yes",
    sport: "soccer",
    market_family: null,
    market_type: "moneyline",
    event_start: "2026-09-05T18:00:00Z",
    decision_at: "2026-09-05T10:00:00Z",
    observed_as_of: null,
    lead_time_hours: 8,
    entry_price: 0.55,
    decimal_odds: 1 / 0.55,
    signal_score: 70,
    signal_score_source: "t",
    confidence: null,
    coverage: 50,
    volume_usd: null,
    liquidity_usd: null,
    formula_version: "shadow-strategic-sports-v1",
    terminal_status: "WIN",
    winning_outcome: null,
    winning_token_id: null,
    gross_pnl_u_if_win: 1 / 0.55 - 1,
    gross_pnl_u_if_loss: -1,
    settlement_provenance: "t",
    source_day: "2026-09-05",
    ...over,
  };
}

test("C0 in-band ⇔ frozen C0 predicate", () => {
  assert.equal(POLICY_REGISTRY.C0.evaluate(row({ entry_price: 0.55 })).pass, true);
  assert.equal(POLICY_REGISTRY.C0.evaluate(row({ entry_price: 0.49 })).pass, false);
  assert.equal(POLICY_REGISTRY.C0.evaluate(row({ entry_price: 0.6 })).pass, false);
  // matches the frozen source constant
  assert.equal(ENTRY_PRICE_BAND.minInclusive, 0.5);
  assert.equal(ENTRY_PRICE_BAND.maxExclusive, 0.6);
});

test("C1 = C0 ∧ soccer (frozen predicate)", () => {
  assert.equal(POLICY_REGISTRY.C1.evaluate(row({ sport: "soccer" })).pass, true);
  assert.equal(POLICY_REGISTRY.C1.evaluate(row({ sport: "tennis" })).pass, false);
});

test("C2 = C0 ∧ lead ≥ frozen threshold", () => {
  assert.equal(C4_LEAD_TIME_HOURS_THRESHOLD, 24);
  assert.equal(POLICY_REGISTRY.C2.evaluate(row({ lead_time_hours: 25, sport: "tennis" })).pass, true);
  assert.equal(POLICY_REGISTRY.C2.evaluate(row({ lead_time_hours: 23 })).pass, false);
  assert.equal(POLICY_REGISTRY.C2.evaluate(row({ lead_time_hours: null })).reason, "MISSING_LEAD_TIME");
});

test("C3 = C1 ∩ C2", () => {
  assert.equal(POLICY_REGISTRY.C3.evaluate(row({ sport: "soccer", lead_time_hours: 30 })).pass, true);
  assert.equal(POLICY_REGISTRY.C3.evaluate(row({ sport: "tennis", lead_time_hours: 30 })).pass, false);
  assert.equal(POLICY_REGISTRY.C3.evaluate(row({ sport: "soccer", lead_time_hours: 10 })).pass, false);
});

test("C4 = C1 ∪ C2 (frozen predicate) — soccer OR lead≥24", () => {
  assert.equal(POLICY_REGISTRY.C4.evaluate(row({ sport: "soccer", lead_time_hours: 2 })).pass, true);
  assert.equal(POLICY_REGISTRY.C4.evaluate(row({ sport: "tennis", lead_time_hours: 30 })).pass, true);
  assert.equal(POLICY_REGISTRY.C4.evaluate(row({ sport: "tennis", lead_time_hours: 2 })).pass, false);
});

test("C5 = C0 ∧ not table-tennis (frozen predicate)", () => {
  assert.equal(POLICY_REGISTRY.C5.evaluate(row({ sport: "tennis" })).pass, true);
  assert.equal(POLICY_REGISTRY.C5.evaluate(row({ sport: "table-tennis" })).pass, false);
});

test("registry predicate descriptions come from the frozen models (C0/C1/C4/C5)", () => {
  for (const id of ["C0", "C1", "C4", "C5"] as const) {
    assert.equal(POLICY_REGISTRY[id].predicateDescription, FROZEN_MODELS[id].predicateDescription);
  }
});
