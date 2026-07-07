// Contur3 queue-row stake/price propagation tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Locks that the queue row carries the FireModelCandidate's OWN computed
// stake_usd (from computeBaseStake/computeStake) instead of the legacy
// hardcoded EXECUTABLE_STAKE_USD constant, and that max_entry_price stays
// readable from the row for the consumer-facing API.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQueueRow } from "../../lib/executor/eventExecutionQueue";
import type { FireModelCandidate } from "../../lib/executor/buildFireModelCandidates";
import type { NightEventReservationRow } from "../../lib/executor/executorQueueTypes";

function baseReservation(): NightEventReservationRow {
  return {
    id: "res-1",
    plan_run_id: "plan-1",
    plan_date_minsk: "2026-07-07",
    window_start_iso: "2026-07-07T14:50:00.000Z",
    window_end_iso: "2026-07-07T15:57:00.000Z",
    match_family_key: "argentina-vs-egypt",
    event_slug: "argentina-vs-egypt",
    event_title: "Argentina vs Egypt",
    sport: "soccer",
    league: null,
    strategic_scope: null,
    game_start_iso: "2026-07-07T16:00:00.000Z",
    event_tier: "TIER1",
    event_score: 80,
    best_snapshot_id: null,
    reservation_rank: 1,
    status: "REBALANCE_PENDING",
    selection_reason: null,
    diagnostics: {},
  };
}

function baseCandidate(overrides: Partial<FireModelCandidate> = {}): FireModelCandidate {
  return {
    signal_id: "sig-1",
    strategy: "TIER1_CORE_STRICT_72_COV50",
    market_slug: "argentina-vs-egypt-moneyline",
    match_family_key: "argentina-vs-egypt",
    match_family_key_source: "event_slug",
    match_family_key_is_weak: false,
    event_slug: "argentina-vs-egypt",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    selected_outcome: "Argentina",
    inferred_sport: "soccer",
    market_family: "allowed_fullmatch_moneyline",
    strategic_scope: "WORLD_CUP",
    timing_bucket: "T_MINUS_60",
    identity_quality: "STRONG",
    identity_warning_codes: [],
    canonical_event_key: "argentina-vs-egypt",
    canonical_market_key: "cond-1",
    activity_label_detected: false,
    sport_classification_confidence: "HIGH",
    live_eligible: true,
    live_rejection_reason: null,
    side_mapping_status: "PROVEN_BY_TOKEN_ID",
    live_block_reason: null,
    live_policy_version: "v1",
    paper_eligible: true,
    max_entry_price: 0.62,
    stake_usd: 3,
    max_order_usd: 5,
    max_spread: 0.03,
    one_order_only: true,
    executor_mode_allowed: "dry_run_only",
    first_live_test_allowed: true,
    stale_after: "2026-07-07T16:00:00.000Z",
    no_trade_after: "2026-07-07T16:00:00.000Z",
    idempotency_key: "candidate-idem-1",
    model_rule_id: "v1:P0C_DRAWDOWN_PROTECT_STAKE_GUARD_V1",
    created_at: "2026-07-07T12:00:00.000Z",
    source: "FireModel1_private_executor_2026_06_15",
    diagnostics: {
      executor_action: "BET_OR_PAPER_GO",
      paper_only: false,
      real_trade: false,
      score: 80,
      coverage: 60,
      smart_money: null,
      entry_price: 0.58,
      game_start_iso: "2026-07-07T16:00:00.000Z",
      hours_to_start_now: 1,
      fire_model_alias: "FireModel1",
      version: "v2-lite-growth-safe",
    },
    ...overrides,
  } as FireModelCandidate;
}

test("queue row carries best.stake_usd = 3, not hardcoded EXECUTABLE_STAKE_USD", () => {
  const row = buildQueueRow(baseReservation(), baseCandidate({ stake_usd: 3 }), "rebalance-1");
  assert.equal(row.stake_usd, 3);
});

test("queue row carries best.stake_usd = 5", () => {
  const row = buildQueueRow(baseReservation(), baseCandidate({ stake_usd: 5 }), "rebalance-1");
  assert.equal(row.stake_usd, 5);
});

test("queue row carries best.stake_usd = 7", () => {
  const row = buildQueueRow(baseReservation(), baseCandidate({ stake_usd: 7 }), "rebalance-1");
  assert.equal(row.stake_usd, 7);
});

test("queue row diagnostics preserves max_entry_price for consumer-facing API mapping", () => {
  const row = buildQueueRow(baseReservation(), baseCandidate({ max_entry_price: 0.71 }), "rebalance-1");
  assert.equal((row.diagnostics as Record<string, unknown>).max_entry_price, 0.71);
});
