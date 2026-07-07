// Contur3 stake/price source-of-truth policy tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Locks the founder-approved MVP execution-boundary policy:
//   1. PREMVP queue row carries the recommended/max stake (dynamic, not hardcoded $7).
//   2/3. Consumer may spend <= queue stake, never more.
//   4. PREMVP queue row exposes max entry price / price cap.
//   5/6. Consumer may execute at <= queue max_entry_price, never above.
//   7/8. Consumer cannot submit order-events for a different row/token/side/market;
//        mismatches are rejected, not silently recorded.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateOrderEventAgainstQueueRow,
  type EventExecutionQueueRow,
  type OrderEventSubmission,
} from "../../lib/executor/executorQueueTypes";

function baseQueueRow(overrides: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
  return {
    reservation_id: "res-1",
    plan_run_id: "plan-1",
    rebalance_run_id: "rebalance-1",
    match_family_key: "argentina-vs-egypt",
    event_title: "Argentina vs Egypt",
    event_slug: "argentina-vs-egypt",
    sport: "soccer",
    league: null,
    game_start_iso: "2026-07-07T16:00:00.000Z",
    condition_id: "cond-1",
    token_id: "token-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    market_title: "argentina-vs-egypt-moneyline",
    market_family: "allowed_fullmatch_moneyline",
    score: 80,
    coverage: 60,
    tier: "TIER1",
    stake_usd: 7,
    preferred_entry_iso: "2026-07-07T14:50:00.000Z",
    latest_entry_iso: "2026-07-07T15:57:00.000Z",
    selection_rank: 1,
    selection_reason: null,
    status: "READY",
    order_key: "cond-1:token-1:Argentina",
    idempotency_key: "idem-1",
    diagnostics: { max_entry_price: 0.62 },
    ...overrides,
  };
}

function baseSubmission(overrides: Partial<OrderEventSubmission> = {}): OrderEventSubmission {
  return {
    idempotency_key: "idem-1",
    token_id: "token-1",
    condition_id: "cond-1",
    side: "Argentina",
    market_slug: "argentina-vs-egypt-moneyline",
    submitted_size: 7,
    submitted_price: 0.6,
    ...overrides,
  };
}

test("valid event passes: matching identity, stake <= max, price <= cap", () => {
  const result = validateOrderEventAgainstQueueRow(baseSubmission(), baseQueueRow());
  assert.equal(result.ok, true);
});

test("consumer may execute at strictly lower stake than queue max", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ submitted_size: 3 }),
    baseQueueRow({ stake_usd: 7 })
  );
  assert.equal(result.ok, true);
});

test("submitted size > queue stake is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ submitted_size: 10 }),
    baseQueueRow({ stake_usd: 7 })
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "STAKE_EXCEEDS_QUEUE_MAX");
});

test("consumer may execute at strictly lower price than max_entry_price", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ submitted_price: 0.5 }),
    baseQueueRow()
  );
  assert.equal(result.ok, true);
});

test("submitted price > queue max_entry_price is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ submitted_price: 0.9 }),
    baseQueueRow()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "PRICE_EXCEEDS_QUEUE_MAX");
});

test("token_id mismatch is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ token_id: "other-token" }),
    baseQueueRow()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "TOKEN_ID_MISMATCH");
});

test("condition_id mismatch is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ condition_id: "other-cond" }),
    baseQueueRow()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "CONDITION_ID_MISMATCH");
});

test("side mismatch is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ side: "Egypt" }),
    baseQueueRow()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "SIDE_MISMATCH");
});

test("market_slug mismatch is rejected", () => {
  const result = validateOrderEventAgainstQueueRow(
    baseSubmission({ market_slug: "argentina-vs-egypt-total" }),
    baseQueueRow()
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "MARKET_SLUG_MISMATCH");
});
