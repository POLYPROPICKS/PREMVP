import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  probeShockReversion, probeTailPathOptionality, probeLateLock, probeCoreRelativeValue, tailDecisions,
  runInplayShadowProbes, synchronizedGroups, type InplayObservation,
} from "../../lib/modeling/inplay-shadow/inplayShadowProbes";

const T0 = Date.parse("2026-10-08T10:00:00Z");
let seq = 0;
function row(o: Partial<InplayObservation> & { t: number }): InplayObservation {
  const { t, ...rest } = o;
  seq++;
  return {
    id: `r${seq}`, physical_event_id: "E1", provider_sport_family: "tennis", observed_at: new Date(T0 + t * 1000).toISOString(),
    event_live_status: "LIVE", state_phase: "S1", side_a_score: null, side_b_score: null, condition_id: "C1", token_id: "T1",
    canonical_market_type: "MONEYLINE", mid_price: 0.5, spread_abs: 0.02, bid_depth_relevant_usd: 100, ask_depth_relevant_usd: 100,
    full_stake_executable_vwap: 0.5, full_stake_exit_vwap: 0.5, full_stake_exit_fully_filled: true,
    orderbook_fetch_status: "SUCCESS", persistence_reason: "PRICE_MOVE", sequence_in_event: seq, ...rest,
  };
}

test("1 shock reversion is blocked without typed numeric state", () => {
  const p = probeShockReversion([row({ t: 0 }), row({ t: 60, mid_price: 0.9 })]);
  assert.equal(p.state, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  assert.equal(p.eligible_n, 0);
});

test("2 formatted score text cannot create numeric score state", () => {
  const withText = { ...row({ t: 0 }), score: "6-3, 2-1", side_a_score: "6-3", side_b_score: "abc" } as any;
  const p = probeShockReversion([withText]);
  assert.equal(p.typed_numeric_score_row_n, 0);
  assert.equal(p.state, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  assert.equal(p.eligible_n, 0);
  assert.doesNotMatch(readFileSync("lib/modeling/inplay-shadow/inplayShadowProbes.ts", "utf8"), /\.split\(["']-["']\)|parseInt\(|match\(.*score/);
});

test("3 future rows cannot change decision eligibility, entry price or identity", () => {
  const base = [row({ t: 0, full_stake_executable_vwap: 0.4 }), row({ t: 10, orderbook_fetch_status: "FAILED", full_stake_executable_vwap: null })];
  const future = [row({ t: 100, full_stake_executable_vwap: 0.99, full_stake_exit_vwap: 0.1 }), row({ t: 200, event_live_status: "FINAL", state_phase: "X" })];
  const before = tailDecisions(base);
  const after = tailDecisions([...base, ...future]).filter((d) => before.some((b) => b.decision_at === d.decision_at && b.token_id === d.token_id));
  assert.deepEqual(after, before);
  assert.equal(before.length, 1);
  assert.equal(before[0].entry_price, 0.4);
  assert.equal(tailDecisions(base)[0].token_id, "T1");
});

test("4 future exit must be strictly after the decision timestamp", () => {
  const rows = [row({ t: 0, full_stake_executable_vwap: 0.4, full_stake_exit_vwap: 0.9 }), row({ t: 0, id: "same-instant", full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_vwap: 0.8 })];
  const p = probeTailPathOptionality(rows);
  assert.equal(p.metrics.decision_n, 1);
  assert.equal(p.metrics.future_exit_n, 0);
  const later = probeTailPathOptionality([...rows, row({ t: 1, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_vwap: 0.45 })]);
  assert.equal(later.metrics.future_exit_n, 1);
  assert.equal(later.metrics.median_gross_executable_price_delta, 0.05);
});

test("5 non-executable entry is excluded from the tail probe", () => {
  const rows = [row({ t: 0, full_stake_executable_vwap: null }), row({ t: 5, orderbook_fetch_status: "FAILED", full_stake_executable_vwap: 0.4 }), row({ t: 9, full_stake_executable_vwap: 0.4, full_stake_exit_vwap: 0.6 })];
  assert.equal(probeTailPathOptionality(rows).metrics.decision_n, 1);
});

test("6 non-executable future exit is not a proven executable exit", () => {
  const rows = [row({ t: 0, full_stake_executable_vwap: 0.4 }),
    row({ t: 5, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_fully_filled: false, full_stake_exit_vwap: 0.9 }),
    row({ t: 6, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_fully_filled: true, full_stake_exit_vwap: null }),
    row({ t: 7, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_fully_filled: null, full_stake_exit_vwap: 0.9 })];
  const p = probeTailPathOptionality(rows);
  assert.equal(p.metrics.future_exit_n, 0);
  assert.equal(p.status, "DECISIONS_WITHOUT_FUTURE_EXECUTABLE_EXIT");
});

test("7 gross price movement is not labeled net PnL", () => {
  const p = probeTailPathOptionality([row({ t: 0, full_stake_executable_vwap: 0.4 }), row({ t: 30, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_vwap: 0.7 })]);
  assert.equal(p.economics, "GROSS_BEFORE_EXIT_FEE");
  assert.equal(p.net_pnl, "UNKNOWN");
  assert.equal(p.metrics.median_gross_executable_price_delta, 0.3);
  assert.equal(p.metrics.max_favorable_executable_excursion, 0.3);
  assert.equal(p.metrics.time_to_first_favorable_bucket_n["<=60s"], 1);
  assert.doesNotMatch(JSON.stringify(p), /"(net_)?(profit|roi)"/i);
});

test("8 late lock uses explicit provider phase/final only, grouped by sport and phase", () => {
  const rows = [
    row({ t: 0, state_phase: "S1", mid_price: 0.5 }), row({ t: 60, state_phase: "S2", mid_price: 0.6, spread_abs: 0.04 }),
    row({ t: 120, state_phase: "S2", event_live_status: "FINAL", mid_price: 0.95, persistence_reason: "FINAL_STATE" }),
    row({ t: 0, provider_sport_family: "soccer", physical_event_id: "E2", token_id: "T9", state_phase: "H1" }),
    row({ t: 30, provider_sport_family: "soccer", physical_event_id: "E2", token_id: "T9", state_phase: "H2" }),
  ];
  const p = probeLateLock(rows);
  assert.equal(p.status, "PARTIAL");
  assert.equal(p.metrics.phase_transition_n, 2);
  assert.equal(p.metrics.final_transition_n, 1);
  assert.ok(p.metrics.by_sport_family_phase["tennis|PHASE|S1->S2"]);
  assert.ok(p.metrics.by_sport_family_phase["soccer|PHASE|H1->H2"]);
  assert.equal(p.metrics.by_sport_family_phase["tennis|FINAL|S2->S2"].price_change_median, 0.35);
});

test("9 wall-clock elapsed or path percentage cannot create late-state authority", () => {
  const rows = [row({ t: 0 }), row({ t: 3600 * 3 }), row({ t: 3600 * 6 }), row({ t: 3600 * 9, mid_price: 0.97 })];
  const p = probeLateLock(rows);
  assert.equal(p.status, "NO_SAMPLE");
  assert.equal(p.eligible_n, 0);
  assert.equal(probeLateLock([row({ t: 0, state_phase: null }), row({ t: 5, state_phase: "S1" })]).eligible_n, 0);
});

test("10 relative-value groups require the same physical event", () => {
  const p = probeCoreRelativeValue([row({ t: 0, physical_event_id: "E1", token_id: "A" }), row({ t: 0, physical_event_id: "E2", token_id: "B" })]);
  assert.equal(p.metrics.same_event_synchronized_group_n, 0);
});

test("11 cross-event rows are never paired, including inside the sync window", () => {
  const rows = [row({ t: 0, physical_event_id: "E1", token_id: "A", condition_id: "C1" }), row({ t: 1, physical_event_id: "E2", token_id: "B", condition_id: "C1" }),
    row({ t: 2, physical_event_id: "E1", token_id: "A2", condition_id: "C1" })];
  const groups = synchronizedGroups(rows);
  assert.equal(groups.length, 1);
  assert.ok(groups[0].rows.every((r) => r.physical_event_id === "E1"));
  const outside = synchronizedGroups([row({ t: 0, token_id: "A" }), row({ t: 6, token_id: "B" })]);
  assert.equal(outside.length, 0);
});

test("12 derivative market types are excluded", () => {
  const rows = [row({ t: 0, token_id: "A" }), row({ t: 0, token_id: "B", canonical_market_type: "FIRST_SET_WINNER" }), row({ t: 0, token_id: "C", canonical_market_type: "TOTAL_CORNERS" })];
  const p = probeCoreRelativeValue(rows);
  assert.equal(p.metrics.same_event_synchronized_group_n, 0);
  const soccer = probeCoreRelativeValue([row({ t: 0, token_id: "A", provider_sport_family: "soccer" }), row({ t: 0, token_id: "C", provider_sport_family: "soccer", canonical_market_type: "TOTAL_CORNERS" })]);
  assert.equal(soccer.metrics.multi_family_group_n, 1);
});

test("13 zero multi-family sample returns factual zero, not an error", () => {
  const p = probeCoreRelativeValue([
    row({ t: 0, token_id: "A", condition_id: "C1", mid_price: 0.55 }), row({ t: 0, token_id: "B", condition_id: "C1", mid_price: 0.45 })]);
  assert.equal(p.status, "MULTI_FAMILY_SAMPLE_N_0");
  assert.equal(p.metrics.MULTI_FAMILY_SAMPLE_N, 0);
  assert.equal(p.metrics.moneyline_only_group_n, 1);
  assert.equal(p.metrics.complement_mid_sum_median, 1);
  assert.equal(probeCoreRelativeValue([]).status, "NO_SAMPLE");
  assert.doesNotThrow(() => runInplayShadowProbes([]));
});

test("14 output is deterministic and independent of input order", () => {
  const rows = [row({ t: 0, full_stake_executable_vwap: 0.4 }), row({ t: 30, token_id: "T2", condition_id: "C1", state_phase: "S2" }), row({ t: 40, full_stake_executable_vwap: null, orderbook_fetch_status: "FAILED", full_stake_exit_vwap: 0.7 }), row({ t: 90, event_live_status: "FINAL" })];
  const a = JSON.stringify(runInplayShadowProbes(rows));
  assert.equal(JSON.stringify(runInplayShadowProbes(rows)), a);
  assert.equal(JSON.stringify(runInplayShadowProbes([...rows].reverse())), a);
});
