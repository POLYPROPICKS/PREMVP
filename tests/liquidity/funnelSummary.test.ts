import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMachineVerdict,
  renderLiquidityFunnelJson,
  renderLiquidityFunnelMarkdown,
  summarizeLiquidityFunnel24h,
  summarizeSportFamilyLiquidityFunnel24h,
  type FunnelInputs,
} from "../../lib/liquidity/funnelSummary";
import type { SimulationRow, SnapshotRow } from "../../lib/liquidity/types";

const WINDOW_START = "2026-06-25T00:00:00.000Z";
const WINDOW_END = "2026-06-26T00:00:00.000Z";

function baseInputs(overrides: Partial<FunnelInputs> = {}): FunnelInputs {
  return {
    windowStartIso: WINDOW_START,
    windowEndIso: WINDOW_END,
    dbStatus: "OK",
    sourceRows: [],
    watchlistRows: [],
    snapshotRows: [],
    simulationRows: [],
    ...overrides,
  };
}

test("summarizeLiquidityFunnel24h aggregates gates by sport and family", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [
        { token_id: "a", sport: "NBA", market_family: "moneyline", volume_usd: 50000 },
        { token_id: "b", sport: "NBA", market_family: "player_prop", volume_usd: 50000 },
        { token_id: "c", sport: "EPL", market_family: "total", volume_usd: 100 },
        { token_id: "d", sport: "weirdsport", market_family: "moneyline", volume_usd: 99999 },
      ],
    }),
  );
  assert.equal(summary.sourceRows, 4);
  assert.equal(summary.candidateRows, 4);
  assert.equal(summary.familyGatePass, 3); // moneyline x2 + total ; prop excluded
  assert.equal(summary.volumePass, 2); // NBA moneyline + weirdsport moneyline (>=10000)
  assert.equal(summary.sourceRowsBySport["basketball"], 2);
  assert.ok(summary.rejectedMarketFamilies["excluded_prop:player_prop"] >= 1);
  const nbaMl = summarizeSportFamilyLiquidityFunnel24h(summary, "basketball", "moneyline");
  assert.equal(nbaMl.sourceRows, 1);
  assert.equal(nbaMl.volumeGate.pass, 1);
});

test("computeMachineVerdict reports DB/schema first", () => {
  assert.equal(computeMachineVerdict(summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "DB_ENV_MISSING" }))), "DB_ENV_MISSING");
  assert.equal(computeMachineVerdict(summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "SCHEMA_MISSING" }))), "SCHEMA_MISSING");
});

test("computeMachineVerdict flags no-watchlist and no-volume-eligible", () => {
  const noVol = summarizeLiquidityFunnel24h(
    baseInputs({ sourceRows: [{ token_id: "a", sport: "NBA", market_family: "moneyline", volume_usd: 100 }] }),
  );
  assert.equal(computeMachineVerdict(noVol), "DEGRADED_NO_VOLUME_ELIGIBLE");

  const noWatchlist = summarizeLiquidityFunnel24h(
    baseInputs({ sourceRows: [{ token_id: "a", sport: "NBA", market_family: "moneyline", volume_usd: 50000 }] }),
  );
  assert.equal(computeMachineVerdict(noWatchlist), "DEGRADED_NO_WATCHLIST");
});

test("computeMachineVerdict OK_CAPTURING on a full healthy funnel", () => {
  const snapshot: SnapshotRow = {
    token_id: "a",
    market_id: null,
    normalized_sport: "basketball",
    normalized_market_family: "moneyline",
    captured_at: WINDOW_END,
    game_start_iso: null,
    minutes_to_start: null,
    phase_bucket: "T_1H",
    status: "OK",
    failure_code: null,
    best_bid: 0.5,
    best_ask: 0.51,
    mid_price: 0.505,
    spread: 0.01,
    spread_bps: 198,
    bid_depth_1pct_usd: 100,
    ask_depth_1pct_usd: 100,
    bid_depth_2pct_usd: 200,
    ask_depth_2pct_usd: 200,
    bid_depth_5pct_usd: 500,
    ask_depth_5pct_usd: 500,
    latency_ms: 10,
    bids: [{ price: 0.5, size: 1000 }],
    asks: [{ price: 0.51, size: 1000 }],
  };
  const sim: SimulationRow = {
    token_id: "a",
    market_id: null,
    normalized_sport: "basketball",
    normalized_market_family: "moneyline",
    simulated_at: WINDOW_END,
    phase_bucket: "T_1H",
    stake_usd: 10,
    entry_price: 0.51,
    shares: 19.6,
    exit_proceeds_5pct_usd: 9.8,
    exit_proceeds_10pct_usd: 9.8,
    exit_proceeds_15pct_usd: 9.8,
    net_return_5pct_pct: -2,
    net_return_10pct_pct: -2,
    net_return_15pct_pct: -2,
    executable_5pct: true,
    executable_10pct: true,
    executable_15pct: true,
  };
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [{ token_id: "a", sport: "NBA", market_family: "moneyline", volume_usd: 50000 }],
      watchlistRows: [
        {
          token_id: "a",
          market_id: null,
          event_id: null,
          question: null,
          normalized_sport: "basketball",
          normalized_market_family: "moneyline",
          market_family_gate: "SUPPORTED",
          volume_usd: 50000,
          volume_scope: "market_level",
          volume_gate: "PASS",
          game_start_iso: null,
          priority_score: 5,
          source_table: null,
          source_row_id: null,
        },
      ],
      snapshotRows: [snapshot],
      simulationRows: [sim],
    }),
  );
  assert.equal(computeMachineVerdict(summary), "OK_CAPTURING");
  assert.equal(summary.executable5pct, 1);
});

test("renderers produce report from empty inputs without throwing", () => {
  const summary = summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "DB_ENV_MISSING" }));
  const verdict = computeMachineVerdict(summary);
  const md = renderLiquidityFunnelMarkdown(summary, verdict, WINDOW_END);
  assert.match(md, /# LIQUIDITY_POOL_MVP 24H FUNNEL REPORT/);
  assert.match(md, /## 19\. Next Action/);
  assert.match(md, /machine_verdict: \*\*DB_ENV_MISSING\*\*/);

  const json = renderLiquidityFunnelJson(summary, verdict, WINDOW_END);
  assert.equal(json.machine_verdict, "DB_ENV_MISSING");
  assert.ok("source_rows_by_sport" in json);
  assert.ok("volume_gate_by_sport_family" in json);
  assert.ok("rejected_market_families" in json);
});
