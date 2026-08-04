import { test } from "node:test";
import assert from "node:assert/strict";

import { runFounderBattleBatch, type BattleBatchRepoPort } from "../../lib/executor/eventExecutionQueue";

test("C1 RED: founder battle batch remains read-only and cannot insert a Queue row without a Reservation", async () => {
  let insertCalls = 0;
  const repo: BattleBatchRepoPort = {
    async fetchSignalPairs() {
      return [{
        id: "00000000-0000-4000-8000-000000000010",
        event_slug: "Yankees vs Phillies",
        market_slug: "Yankees vs Phillies - Moneyline",
        condition_id: "cond-founder",
        selected_outcome: "Yankees",
        selected_token_id: "token-founder",
        entry_price_num: 0.42,
        signal_confidence_num: 80,
        metric_formula_version: "v2-lite-growth-safe",
        created_at: "2026-07-27T19:00:00.000Z",
        expires_at: "2026-07-27T21:00:00.000Z",
        diagnostics: {}, signal_result: null, premium_signal: null, market_source: null,
      }];
    },
    async findBlockingQueueRowByIdentity() { return []; },
    async findQueueRowByIdempotencyKey() { return null; },
    async insertQueueRow() { insertCalls += 1; },
  };
  const result = await runFounderBattleBatch(Date.parse("2026-07-27T20:00:00.000Z"), { FOUNDER_BATTLE_BATCH_MODE: "YES" }, { write: true }, { repo });
  assert.equal(result.wrote_count, 0);
  assert.equal(insertCalls, 0);
  assert.match(result.reason, /RESERVATION/);
});
