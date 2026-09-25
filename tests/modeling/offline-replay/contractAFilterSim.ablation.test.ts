/**
 * ABLATION SWITCHES — the diagnostic-only `ablate` param disables whole gates,
 * never changes a threshold, and the default (no arg) is byte-identical to the
 * current canonical filter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contractAFilterVerdict } from "../../../lib/modeling/offline-replay/contractAFilterSim";
import type { ModelReadyRow } from "../../../lib/modeling/offline-replay/types";

function row(over: Partial<ModelReadyRow>): ModelReadyRow {
  return {
    research_identity: "c|t", physical_event_id: "e", provider_event_id: "e", condition_id: "c",
    selected_token_id: "t", selected_outcome: "Yes", sport: "soccer", market_family: null,
    market_type: "moneyline", event_start: "2026-09-05T18:00:00Z", decision_at: "2026-09-05T10:00:00Z",
    observed_as_of: null, lead_time_hours: 8, entry_price: 0.5, decimal_odds: 2, signal_score: 70,
    signal_score_source: "t", confidence: null, coverage: 60, volume_usd: null, liquidity_usd: null,
    formula_version: "v2-lite-growth-safe", terminal_status: "OPEN", winning_outcome: null,
    winning_token_id: null, gross_pnl_u_if_win: 1, gross_pnl_u_if_loss: -1,
    settlement_provenance: "t", source_day: "2026-09-05", ...over,
  };
}

test("default arg is unchanged: bad-bucket row still rejected", () => {
  // coverage 60 ∈ [50,74], price 0.50 ∈ [0.44,0.58] → BAD_BUCKET
  assert.equal(contractAFilterVerdict(row({})).reason, "BAD_BUCKET_COV_PRICE");
});

test("skipBadBucket admits the same row", () => {
  const v = contractAFilterVerdict(row({}), { skipBadBucket: true });
  assert.equal(v.pass, true);
});

test("score-floor and tier gates OVERLAP: a sub-50 row is caught by tier even when score-floor is skipped", () => {
  const base = row({ coverage: 30, signal_score: 40, entry_price: 0.52 }); // avoids bad-bucket
  assert.equal(contractAFilterVerdict(base).reason, "LOW_SCORE");
  // score-floor skipped alone → still rejected, now by NO_TIER (score 40 < TIER3 floor 50)
  assert.equal(contractAFilterVerdict(base, { skipScoreFloor: true }).reason, "NO_TIER");
  // both skipped → admitted
  assert.equal(contractAFilterVerdict(base, { skipScoreFloor: true, skipTierAdmission: true }).pass, true);
});

test("skipTierAdmission admits a below-TIER3-coverage row (score clears the floor)", () => {
  const base = row({ coverage: 20, signal_score: 55, entry_price: 0.52 }); // cov 20 < TIER3 cov floor 25
  assert.equal(contractAFilterVerdict(base).reason, "NO_TIER");
  assert.equal(contractAFilterVerdict(base, { skipTierAdmission: true }).pass, true);
});

test("minEntryPrice rejects a below-floor row without touching other gates", () => {
  const base = row({ entry_price: 0.46, coverage: 30 }); // avoids bad-bucket (cov 30)
  assert.equal(contractAFilterVerdict(base).pass, true);
  assert.equal(contractAFilterVerdict(base, { minEntryPrice: 0.5 }).reason, "BELOW_CANDIDATE_PRICE_FLOOR");
  assert.equal(contractAFilterVerdict(row({ entry_price: 0.52, coverage: 30 }), { minEntryPrice: 0.5 }).pass, true);
});

test("restrictToMarketClasses narrows the allow-list, never admits a forbidden class", () => {
  const totalRow = row({ market_type: "totals", coverage: 30, entry_price: 0.52 });
  const mlRow = row({ market_type: "moneyline", coverage: 30, entry_price: 0.52 });
  const halftimeRow = row({ market_type: "soccer_halftime_result", coverage: 30, entry_price: 0.52 });
  const only = { restrictToMarketClasses: ["allowed_fullmatch_total"] };
  assert.equal(contractAFilterVerdict(totalRow, only).pass, true);
  assert.equal(contractAFilterVerdict(mlRow, only).reason, "OUTSIDE_CANDIDATE_MARKET_CLASS_SET");
  // forbidden class is still rejected by the anchor first — restrict never rescues it
  assert.match(contractAFilterVerdict(halftimeRow, only).reason, /MARKET_ANCHOR/);
});

test("skipExecutableMarketAnchor admits a forbidden class, flagged research-only", () => {
  const base = row({ market_type: "soccer_halftime_result", coverage: 30, entry_price: 0.52 });
  assert.match(contractAFilterVerdict(base).reason, /MARKET_ANCHOR/);
  const v = contractAFilterVerdict(base, { skipExecutableMarketAnchor: true });
  assert.equal(v.pass, true);
  assert.equal(v.research_only_counterfactual, true);
  assert.equal(v.reason, "ALLOWED_RESEARCH_ONLY_COUNTERFACTUAL");
});
