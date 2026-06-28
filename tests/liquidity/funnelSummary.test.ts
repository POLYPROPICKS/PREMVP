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
import type { SimulationRow, SnapshotRow, WatchlistRow } from "../../lib/liquidity/types";

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

// Align fixtures to the real generated_signal_research_snapshots schema: the
// fine market type lives in nested diagnostics, not the broad market_family
// column. A `market_family` shorthand here is relocated into
// diagnostics.researchContext.marketType (merged with any volume diagnostics).
function src(o: Record<string, unknown>): Record<string, unknown> {
  const { market_family, diagnostics, ...rest } = o as Record<string, unknown>;
  const diag: Record<string, unknown> =
    diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
      ? { ...(diagnostics as Record<string, unknown>) }
      : {};
  if (market_family !== undefined) {
    const rc =
      diag.researchContext && typeof diag.researchContext === "object"
        ? { ...(diag.researchContext as Record<string, unknown>) }
        : {};
    rc.marketType = market_family;
    diag.researchContext = rc;
  }
  return { condition_id: "c", selected_token_id: "t", diagnostics: diag, ...rest };
}

test("summarizeLiquidityFunnel24h aggregates gates by sport and family", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [
        src({ condition_id: "a", selected_token_id: "a", league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } }),
        src({ condition_id: "b", selected_token_id: "b", league: "NBA", market_family: "player_prop", diagnostics: { market_volume_usd: 50000 } }),
        src({ condition_id: "c", selected_token_id: "c", league: "EPL", market_family: "total", diagnostics: { market_volume_usd: 100 } }),
        src({ condition_id: "d", selected_token_id: "d", league: "weirdsport", market_family: "moneyline", diagnostics: { market_volume_usd: 99999 } }),
      ],
    }),
  );
  assert.equal(summary.sourceRows, 4);
  assert.equal(summary.candidateRows, 4);
  assert.equal(summary.familyGatePass, 3); // moneyline x2 + total; prop excluded
  assert.equal(summary.volumePass, 2); // NBA moneyline + weirdsport moneyline (>=10000)
  assert.equal(summary.sourceRowsBySport["basketball"], 2);
  assert.ok((summary.rejectedMarketFamilies["excluded_prop:player_prop"] ?? 0) >= 1);
  assert.ok((summary.volumeRejectionReasons["volume_below_threshold"] ?? 0) >= 1);
  const nbaMl = summarizeSportFamilyLiquidityFunnel24h(summary, "basketball", "moneyline");
  assert.equal(nbaMl.sourceRows, 1);
  assert.equal(nbaMl.volumeGate.pass, 1);
});

test("computeMachineVerdict reports DB/schema first", () => {
  assert.equal(computeMachineVerdict(summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "DB_ENV_MISSING" }))), "DB_ENV_MISSING");
  assert.equal(computeMachineVerdict(summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "SCHEMA_MISSING" }))), "SCHEMA_MISSING");
});

test("computeMachineVerdict flags missing volume source vs no-eligible vs no-watchlist", () => {
  // family-supported but volume entirely missing -> volume source missing
  const volSourceMissing = summarizeLiquidityFunnel24h(
    baseInputs({ sourceRows: [src({ league: "NBA", market_family: "moneyline" })] }),
  );
  assert.equal(computeMachineVerdict(volSourceMissing), "DEGRADED_VOLUME_SOURCE_MISSING");

  // volume present but below threshold -> no volume eligible
  const noVol = summarizeLiquidityFunnel24h(
    baseInputs({ sourceRows: [src({ league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 100 } })] }),
  );
  assert.equal(computeMachineVerdict(noVol), "DEGRADED_NO_VOLUME_ELIGIBLE");

  // volume passes but no watchlist rows materialized
  const noWatchlist = summarizeLiquidityFunnel24h(
    baseInputs({ sourceRows: [src({ league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } })] }),
  );
  assert.equal(computeMachineVerdict(noWatchlist), "DEGRADED_NO_WATCHLIST");
});

test("volumeDisposition is honest: market-level passes, event-level/missing do not", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [
        src({ condition_id: "m", selected_token_id: "m", league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } }), // pass
        src({ condition_id: "e", selected_token_id: "e", league: "NBA", market_family: "moneyline", diagnostics: { event_volume_usd: 80000 } }), // event-only
        src({ condition_id: "x", selected_token_id: "x", league: "NBA", market_family: "moneyline" }), // missing
        src({ condition_id: "b", selected_token_id: "b", league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 100 } }), // below threshold
      ],
    }),
  );
  const vd = summary.volumeDisposition;
  assert.equal(vd.marketVolumeChecked, 4);
  assert.equal(vd.marketVolumePass, 1); // only the concrete market-level >= 10k
  assert.equal(vd.eventVolumeOnly, 1); // event-level never counts as pass
  assert.equal(vd.volumeMissing, 1);
  assert.equal(vd.volumeDeferred, 1);
  assert.equal(vd.volumeRejected, 1); // below threshold only
  assert.equal(summary.volumePass, 1); // event-level no longer inflates volume_pass
});

function watch(): WatchlistRow {
  return {
    source_table: null,
    source_row_id: null,
    source_formula_version: null,
    source_scope: null,
    condition_id: "a",
    token_id: "a",
    opposing_token_id: null,
    event_slug: null,
    market_slug: null,
    selected_outcome: null,
    source_sport: null,
    normalized_sport: "basketball",
    sport_source: null,
    source_market_family: null,
    normalized_market_family: "moneyline",
    market_family_source: null,
    market_family_gate_status: "passed",
    market_family_gate_reason: null,
    is_supported_p0_market_family: true,
    is_outright_or_future: false,
    is_prop_market: false,
    league: null,
    match_family_key: null,
    game_start_iso: null,
    market_volume_usd: 50000,
    market_volume_source: "diagnostics",
    volume_gate_status: "passed",
    volume_gate_threshold_usd: 10000,
    volume_gate_reason: null,
    minutes_to_start_at_insert: null,
    tracking_priority: 500,
    tracking_status: "active",
    reason: null,
    diagnostics: {},
  };
}

function okSnapshot(): SnapshotRow {
  return {
    captured_at: WINDOW_END,
    source: "polymarket",
    snapshot_reason: "scheduled",
    snapshot_status: "ok",
    condition_id: "a",
    token_id: "a",
    opposing_token_id: null,
    event_slug: null,
    market_slug: null,
    selected_outcome: null,
    normalized_sport: "basketball",
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
    best_bid: 0.5,
    best_ask: 0.51,
    mid_price: 0.505,
    implied_decimal_odds_mid: null,
    implied_decimal_odds_bid: null,
    implied_decimal_odds_ask: null,
    spread_abs: 0.01,
    spread_bps: 198,
    bid_depth_total: 500,
    ask_depth_total: 500,
    bid_depth_1pct: 100,
    bid_depth_2pct: 200,
    bid_depth_5pct: 500,
    ask_depth_1pct: 100,
    ask_depth_2pct: 200,
    ask_depth_5pct: 500,
    exit_sellable_usd_1pct: 100,
    exit_sellable_usd_2pct: 200,
    exit_sellable_usd_5pct: 500,
    entry_buyable_usd_1pct: 100,
    entry_buyable_usd_2pct: 200,
    entry_buyable_usd_5pct: 500,
    book_levels_json: { bids: [{ price: 0.5, size: 1000 }], asks: [{ price: 0.51, size: 1000 }] },
    api_latency_ms: 10,
    failure_reason: null,
    diagnostics: {},
  };
}

function okSim(): SimulationRow {
  return {
    simulation_run_id: "run-1",
    condition_id: "a",
    token_id: "a",
    opposing_token_id: null,
    event_slug: null,
    market_slug: null,
    normalized_sport: "basketball",
    league: null,
    normalized_market_family: "moneyline",
    match_family_key: null,
    selected_outcome: null,
    game_start_iso: null,
    entry_captured_at: WINDOW_START,
    exit_captured_at: WINDOW_END,
    entry_phase_bucket: "T_1H",
    exit_phase_bucket: "T_5M",
    entry_best_ask: 0.5,
    entry_best_bid: 0.49,
    entry_mid_price: 0.495,
    exit_best_bid: 0.6,
    exit_best_ask: 0.62,
    exit_mid_price: 0.61,
    stake_usd: 10,
    gross_return_pct: 20,
    estimated_slippage_pct: 0,
    estimated_fee_pct: 0,
    net_return_pct: 20,
    exit_liquidity_usd: 6000,
    exit_possible_boolean: true,
    executable_5pct_boolean: true,
    executable_10pct_boolean: true,
    executable_15pct_boolean: true,
    entry_market_volume_usd: 50000,
    exit_market_volume_usd: 50000,
    volume_gate_threshold_usd: 10000,
    market_family_gate_status: "passed",
    exit_reason: "executable_exit",
    model_version: "liquidity_pool_mvp_v1",
    diagnostics: {},
  };
}

// A single-snapshot baseline self-pair: entry and exit are the SAME snapshot,
// so entry_captured_at === exit_captured_at and no executable edge is claimed.
function baselineSim(): SimulationRow {
  return {
    ...okSim(),
    entry_captured_at: WINDOW_START,
    exit_captured_at: WINDOW_START,
    exit_reason: "baseline_same_snapshot",
    net_return_pct: -2,
    gross_return_pct: -2,
    executable_5pct_boolean: false,
    executable_10pct_boolean: false,
    executable_15pct_boolean: false,
    diagnostics: { baseline: true },
  };
}

// Test A: live capture + snapshots + baseline simulation succeeded, volume is
// deferred (source rows carry no volume) -> NOT a failure verdict.
test("VERDICT: baseline contour success is OK_BASELINE_CAPTURE, not DEGRADED_VOLUME_SOURCE_MISSING", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [src({ condition_id: "a", selected_token_id: "a", league: "NBA", market_family: "moneyline" })], // no volume
      watchlistRows: [watch()],
      snapshotRows: [okSnapshot()],
      simulationRows: [baselineSim()],
    }),
  );
  assert.equal(summary.entryExitSimulations, 0);
  assert.equal(summary.baselineSimulations, 1);
  assert.equal(summary.sourceVolumeDeferred, true);
  assert.equal(computeMachineVerdict(summary), "OK_BASELINE_CAPTURE");
});

// Test B: no active tokens (or no snapshots) stays a degraded failure.
test("VERDICT: no active watchlist stays DEGRADED_NO_WATCHLIST", () => {
  const noActive = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [src({ league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } })],
      watchlistRows: [],
      snapshotRows: [],
      simulationRows: [],
    }),
  );
  assert.equal(computeMachineVerdict(noActive), "DEGRADED_NO_WATCHLIST");

  const noSnapshots = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [src({ condition_id: "a", selected_token_id: "a", league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } })],
      watchlistRows: [watch()],
      snapshotRows: [],
      simulationRows: [],
    }),
  );
  assert.equal(computeMachineVerdict(noSnapshots), "DEGRADED_NO_SNAPSHOTS");
});

// Test C: working contour without source volume keeps the volume warning visible.
test("VERDICT: source volume missing remains a visible warning, not the primary verdict", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [src({ condition_id: "a", selected_token_id: "a", league: "NBA", market_family: "moneyline" })],
      watchlistRows: [watch()],
      snapshotRows: [okSnapshot()],
      simulationRows: [baselineSim()],
    }),
  );
  // Honest volume warning fields preserved...
  assert.ok(summary.volumeChecked > 0);
  assert.equal(summary.volumePass, 0);
  assert.ok((summary.volumeRejectionReasons["volume_missing"] ?? 0) >= 1);
  assert.equal(summary.sourceVolumeDeferred, true);
  // ...but it is not the primary verdict when the contour actually worked.
  assert.notEqual(computeMachineVerdict(summary), "DEGRADED_VOLUME_SOURCE_MISSING");
});

test("computeMachineVerdict OK_CAPTURING on a full healthy funnel", () => {
  const summary = summarizeLiquidityFunnel24h(
    baseInputs({
      sourceRows: [src({ condition_id: "a", selected_token_id: "a", league: "NBA", market_family: "moneyline", diagnostics: { market_volume_usd: 50000 } })],
      watchlistRows: [watch()],
      snapshotRows: [okSnapshot()],
      simulationRows: [okSim()],
    }),
  );
  assert.equal(computeMachineVerdict(summary), "OK_CAPTURING");
  assert.equal(summary.executable5pct, 1);
  assert.equal(summary.executableOpportunitiesBySport["basketball"], 1);
  assert.equal(summary.snapshotSuccessBySport["basketball"], 1);
});

test("renderers produce report from empty inputs without throwing", () => {
  const summary = summarizeLiquidityFunnel24h(baseInputs({ dbStatus: "DB_ENV_MISSING" }));
  const verdict = computeMachineVerdict(summary);
  const md = renderLiquidityFunnelMarkdown(summary, verdict, WINDOW_END);
  assert.match(md, /# LIQUIDITY_POOL_MVP 24H FUNNEL REPORT/);
  assert.match(md, /## 18\. Next Action/);
  assert.match(md, /machine_verdict: \*\*DB_ENV_MISSING\*\*/);

  const json = renderLiquidityFunnelJson(summary, verdict, WINDOW_END);
  assert.equal(json.verdict, "DB_ENV_MISSING");
  for (const key of [
    "source_rows_by_sport",
    "source_rows_by_sport_family",
    "market_family_gate_by_sport",
    "volume_gate_by_sport",
    "volume_gate_by_sport_family",
    "active_watchlist_by_sport",
    "active_watchlist_by_sport_family",
    "snapshot_success_by_sport",
    "snapshot_success_by_sport_family",
    "simulation_summary_by_sport",
    "simulation_summary_by_sport_family",
    "executable_opportunities_by_sport",
    "executable_opportunities_by_sport_family",
    "rejected_market_families",
    "volume_rejection_reasons",
    "top_examples",
  ]) {
    assert.ok(key in json, `missing json key ${key}`);
  }
});
