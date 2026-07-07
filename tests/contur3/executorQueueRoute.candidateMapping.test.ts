// Contur3 /api/executor/queue response contract tests (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Locks the consumer-facing candidate projection: MVP treats recommended
// stake as the hard max (max_stake_usd === stake_usd), and the price cap
// computed by the model (max_entry_price / price_cap) must reach the
// consumer through the queue API — not just live buried in diagnostics.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapQueueRowToIrelandCandidate,
  type EventExecutionQueueRow,
} from "../../lib/executor/executorQueueTypes";

function baseRow(overrides: Partial<EventExecutionQueueRow> = {}): EventExecutionQueueRow {
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
    stake_usd: 3,
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

test("candidate mapping includes core identity fields", () => {
  const nowMs = Date.parse("2026-07-07T15:00:00.000Z");
  const c = mapQueueRowToIrelandCandidate(baseRow(), nowMs);
  assert.equal(c.condition_id, "cond-1");
  assert.equal(c.token_id, "token-1");
  assert.equal(c.side, "Argentina");
  assert.equal(c.market_slug, "argentina-vs-egypt-moneyline");
  assert.equal(c.event_slug, "argentina-vs-egypt");
  assert.equal(c.latest_entry_iso, "2026-07-07T15:57:00.000Z");
});

test("candidate mapping exposes dynamic stake_usd and max_stake_usd equal to it (MVP)", () => {
  const nowMs = Date.parse("2026-07-07T15:00:00.000Z");
  const c = mapQueueRowToIrelandCandidate(baseRow({ stake_usd: 3 }), nowMs);
  assert.equal(c.stake_usd, 3);
  assert.equal(c.max_stake_usd, 3);
});

test("candidate mapping exposes max_entry_price / price_cap read from diagnostics", () => {
  const nowMs = Date.parse("2026-07-07T15:00:00.000Z");
  const c = mapQueueRowToIrelandCandidate(baseRow({ diagnostics: { max_entry_price: 0.71 } }), nowMs);
  assert.equal(c.max_entry_price, 0.71);
  assert.equal(c.price_cap, 0.71);
});

test("candidate mapping falls back to null price cap when diagnostics missing it", () => {
  const nowMs = Date.parse("2026-07-07T15:00:00.000Z");
  const c = mapQueueRowToIrelandCandidate(baseRow({ diagnostics: {} }), nowMs);
  assert.equal(c.max_entry_price, null);
  assert.equal(c.price_cap, null);
});
