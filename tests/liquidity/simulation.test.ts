import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEntryExitSimulation,
  selectEntryExitPairs,
  summarizeSimulationFlags,
} from "../../lib/liquidity/simulation";
import type { OrderBookLevel, SnapshotRow } from "../../lib/liquidity/types";

function snap(overrides: Partial<SnapshotRow>): SnapshotRow {
  const bids: OrderBookLevel[] = overrides.book_levels_json?.bids ?? [{ price: 0.5, size: 10000 }];
  const asks: OrderBookLevel[] = overrides.book_levels_json?.asks ?? [{ price: 0.51, size: 10000 }];
  return {
    captured_at: "2026-06-26T00:00:00.000Z",
    source: "polymarket",
    snapshot_reason: "scheduled",
    snapshot_status: "ok",
    condition_id: "c",
    token_id: "t",
    opposing_token_id: null,
    event_slug: null,
    market_slug: null,
    selected_outcome: null,
    normalized_sport: "soccer",
    league: null,
    normalized_market_family: "moneyline",
    match_family_key: null,
    game_start_iso: null,
    minutes_to_start: null,
    phase_bucket: "T_1H",
    market_volume_usd: 50000,
    volume_gate_status: "passed",
    volume_gate_threshold_usd: 10000,
    market_family_gate_status: "passed",
    best_bid: bids.length ? bids[0].price : null,
    best_ask: asks.length ? asks[0].price : null,
    mid_price: null,
    implied_decimal_odds_mid: null,
    implied_decimal_odds_bid: null,
    implied_decimal_odds_ask: null,
    spread_abs: null,
    spread_bps: null,
    bid_depth_total: null,
    ask_depth_total: null,
    bid_depth_1pct: null,
    bid_depth_2pct: null,
    bid_depth_5pct: null,
    ask_depth_1pct: null,
    ask_depth_2pct: null,
    ask_depth_5pct: null,
    exit_sellable_usd_1pct: null,
    exit_sellable_usd_2pct: null,
    exit_sellable_usd_5pct: null,
    entry_buyable_usd_1pct: null,
    entry_buyable_usd_2pct: null,
    entry_buyable_usd_5pct: null,
    book_levels_json: { bids, asks },
    api_latency_ms: null,
    failure_reason: null,
    diagnostics: {},
    ...overrides,
  };
}

test("selectEntryExitPairs pairs an entry-phase snapshot with a later exit-phase one", () => {
  const pairs = selectEntryExitPairs([
    snap({ token_id: "a", phase_bucket: "T_1H", captured_at: "2026-06-26T10:00:00.000Z" }),
    snap({ token_id: "a", phase_bucket: "T_5M", captured_at: "2026-06-26T10:55:00.000Z" }),
    // token b has only an entry phase -> no pair.
    snap({ token_id: "b", phase_bucket: "T_2H", captured_at: "2026-06-26T09:00:00.000Z" }),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].entry.token_id, "a");
  assert.equal(pairs[0].entry.phase_bucket, "T_1H");
  assert.equal(pairs[0].exit.phase_bucket, "T_5M");
});

test("selectEntryExitPairs requires exit after entry and respects the cap", () => {
  // exit captured BEFORE entry -> no valid pair.
  const none = selectEntryExitPairs([
    snap({ token_id: "a", phase_bucket: "T_1H", captured_at: "2026-06-26T11:00:00.000Z" }),
    snap({ token_id: "a", phase_bucket: "T_5M", captured_at: "2026-06-26T10:00:00.000Z" }),
  ]);
  assert.equal(none.length, 0);

  const capped = selectEntryExitPairs(
    [
      snap({ token_id: "a", phase_bucket: "T_1H", captured_at: "2026-06-26T10:00:00.000Z" }),
      snap({ token_id: "a", phase_bucket: "T_5M", captured_at: "2026-06-26T10:55:00.000Z" }),
      snap({ token_id: "b", phase_bucket: "T_1H", captured_at: "2026-06-26T10:00:00.000Z" }),
      snap({ token_id: "b", phase_bucket: "T_5M", captured_at: "2026-06-26T10:55:00.000Z" }),
    ],
    1,
  );
  assert.equal(capped.length, 1);
});

test("buildEntryExitSimulation marks executable when exit fills with profit", () => {
  // entry ask 0.50 -> 20 shares for $10. exit bids 0.60 deep -> proceeds 12 -> +20%.
  const entry = snap({ phase_bucket: "T_1H", book_levels_json: { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.5, size: 10000 }] }, best_ask: 0.5, best_bid: 0.49 });
  const exit = snap({
    phase_bucket: "T_5M",
    captured_at: "2026-06-26T01:00:00.000Z",
    book_levels_json: { bids: [{ price: 0.6, size: 10000 }], asks: [{ price: 0.62, size: 100 }] },
    best_bid: 0.6,
    best_ask: 0.62,
  });
  const sim = buildEntryExitSimulation({ entry, exit }, "run-1", 10);
  assert.equal(sim.entry_best_ask, 0.5);
  assert.equal(sim.exit_possible_boolean, true);
  assert.ok(Math.abs(sim.net_return_pct! - 20) < 1e-6);
  assert.equal(sim.executable_5pct_boolean, true);
  assert.equal(sim.executable_15pct_boolean, true);
});

test("buildEntryExitSimulation not executable on thin exit book or loss", () => {
  const entry = snap({ phase_bucket: "T_1H", book_levels_json: { bids: [{ price: 0.49, size: 1 }], asks: [{ price: 0.5, size: 10000 }] }, best_ask: 0.5 });
  // exit depth too thin to fill 20 shares
  const thinExit = snap({ phase_bucket: "T_5M", captured_at: "2026-06-26T01:00:00.000Z", book_levels_json: { bids: [{ price: 0.6, size: 1 }], asks: [] }, best_bid: 0.6, best_ask: null });
  const sim = buildEntryExitSimulation({ entry, exit: thinExit }, "run-1", 10);
  assert.equal(sim.exit_possible_boolean, false);
  assert.equal(sim.executable_5pct_boolean, false);
  assert.equal(sim.exit_reason, "insufficient_exit_depth");
});

test("summarizeSimulationFlags aggregates executable counts", () => {
  const entry = snap({ phase_bucket: "T_1H", best_ask: 0.5, book_levels_json: { bids: [], asks: [{ price: 0.5, size: 10000 }] } });
  const exit = snap({ phase_bucket: "T_5M", captured_at: "2026-06-26T01:00:00.000Z", best_bid: 0.6, book_levels_json: { bids: [{ price: 0.6, size: 10000 }], asks: [] } });
  const rows = [
    buildEntryExitSimulation({ entry: { ...entry, token_id: "a" }, exit: { ...exit, token_id: "a" } }, "run-1"),
    buildEntryExitSimulation({ entry: { ...entry, token_id: "b" }, exit: { ...exit, token_id: "b" } }, "run-1"),
  ];
  const flags = summarizeSimulationFlags(rows);
  assert.equal(flags.simulations, 2);
  assert.equal(flags.tokens, 2);
  assert.equal(flags.executable5pct, 2);
});
