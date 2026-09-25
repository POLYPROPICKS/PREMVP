/**
 * CONTRACT A FILTER SEMANTIC SMOKE — each canonical pre-Reservation gate
 * rejects/admits the row it should.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contractAFilterVerdict } from "../../../lib/modeling/offline-replay/contractAFilterSim";
import type { ModelReadyRow } from "../../../lib/modeling/offline-replay/types";

function row(over: Partial<ModelReadyRow>): ModelReadyRow {
  return {
    research_identity: "0xabc|tok",
    physical_event_id: "evt-1",
    provider_event_id: "evt-1",
    condition_id: "0xabc",
    selected_token_id: "tok",
    selected_outcome: "Yes",
    sport: "soccer",
    market_family: null,
    market_type: "moneyline",
    event_start: "2026-09-05T18:00:00Z",
    decision_at: "2026-09-05T10:00:00Z",
    observed_as_of: null,
    lead_time_hours: 8,
    entry_price: 0.52,
    decimal_odds: 1 / 0.52,
    signal_score: 70,
    signal_score_source: "test",
    confidence: null,
    coverage: 40,
    volume_usd: null,
    liquidity_usd: null,
    formula_version: "v2-lite-growth-safe",
    terminal_status: "OPEN",
    winning_outcome: null,
    winning_token_id: null,
    gross_pnl_u_if_win: 1 / 0.52 - 1,
    gross_pnl_u_if_loss: -1,
    settlement_provenance: "unresolved",
    source_day: "2026-09-05",
    ...over,
  };
}

test("full-match moneyline, scored, priced, future → ALLOWED (TIER3)", () => {
  const v = contractAFilterVerdict(row({}));
  assert.equal(v.pass, true);
  assert.equal(v.tier, "TIER3_MICRO_EXPAND_50_COV25");
  assert.equal(v.market_class, "allowed_fullmatch_moneyline");
});

test("halftime market → rejected by canonical anchor", () => {
  const v = contractAFilterVerdict(row({ market_type: "soccer_halftime_result" }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /MARKET_ANCHOR/);
});

test("corners market → rejected by canonical anchor", () => {
  const v = contractAFilterVerdict(row({ market_type: "total_corners" }));
  assert.equal(v.pass, false);
});

test("map/round handicap → PARTIAL_EVENT_SCOPE", () => {
  const v = contractAFilterVerdict(row({ market_type: "map_handicap" }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /PARTIAL_EVENT_SCOPE/);
});

test("score below 50 → LOW_SCORE", () => {
  assert.equal(contractAFilterVerdict(row({ signal_score: 44 })).reason, "LOW_SCORE");
});

test("no score → LOW_SCORE_NO_SCORE (fail-closed)", () => {
  assert.equal(contractAFilterVerdict(row({ signal_score: null })).reason, "LOW_SCORE_NO_SCORE");
});

test("event already started (lead <= 0) → GAME_STARTED_OR_INVALID", () => {
  assert.equal(contractAFilterVerdict(row({ lead_time_hours: -1 })).reason, "GAME_STARTED_OR_INVALID");
});

test("missing entry price → MISSING_ENTRY_PRICE", () => {
  assert.equal(contractAFilterVerdict(row({ entry_price: null })).reason, "MISSING_ENTRY_PRICE");
});

test("bad bucket: coverage 60, price 0.50 → BAD_BUCKET_COV_PRICE", () => {
  const v = contractAFilterVerdict(row({ coverage: 60, entry_price: 0.5, signal_score: 70 }));
  assert.equal(v.reason, "BAD_BUCKET_COV_PRICE");
});

test("tier gate: score 55 + coverage 20 → NO_TIER", () => {
  // coverage 20 avoids bad-bucket; below TIER3 cov floor 25
  const v = contractAFilterVerdict(row({ signal_score: 55, coverage: 20, entry_price: 0.52 }));
  assert.equal(v.reason, "NO_TIER");
});

test("disallowed non-research formula version → FORMULA_VERSION_NOT_ALLOWED", () => {
  assert.equal(
    contractAFilterVerdict(row({ formula_version: "some-other-formula-v9" })).reason,
    "FORMULA_VERSION_NOT_ALLOWED",
  );
});

test("compact-corpus research placeholder formula → gate not enforced", () => {
  const v = contractAFilterVerdict(row({ formula_version: "trusted-initial-formula-v1.1" }));
  assert.equal(v.pass, true);
});
