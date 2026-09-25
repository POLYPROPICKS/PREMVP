// Bounded coverage for the football S1/S2/S3 materializer wiring
// (scripts/execution-matrix/materializeFootballS1S2S3.ts). Pure
// mapping/assembly logic only — no live DB calls in this suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assembleCandidate,
  candidateFromRow,
  evaluateCandidate,
  isExcludedFromOrdinaryHold,
  isOrdinaryFullMatchSnapshot,
  attributeExecutedFill,
  type RawCandidateRow,
  type RawSnapshotRow,
} from "../../scripts/execution-matrix/materializeFootballS1S2S3";

const baseRow: RawCandidateRow = {
  condition_id: "0xcond-real",
  selected_token_id: "token-under",
  event_slug: "mls-lag-laf-2026-07-17-total-2pt5",
  market_slug: null,
  formula_version: "trusted-initial-formula-v1.1",
  metric_formula_version: "v2-lite-growth-safe",
  created_at: "2026-07-16T09:34:41.255239+00:00",
  entry_price_num: 0.385,
};

// 1. Real-source mapping shape -----------------------------------------------

test("candidateFromRow maps real generated_signal_pairs fields to the shared identity shape", () => {
  const candidate = candidateFromRow(baseRow);
  assert.equal(candidate.conditionId, baseRow.condition_id);
  assert.equal(candidate.selectedTokenId, baseRow.selected_token_id);
  assert.equal(candidate.providerEventId, baseRow.event_slug);
  assert.equal(candidate.formulaVersion, baseRow.metric_formula_version);
  assert.equal(candidate.decisionTimeIso, baseRow.created_at);
});

test("candidateFromRow falls back to condition_id when event_slug is absent, never fabricating an id", () => {
  const candidate = candidateFromRow({ ...baseRow, event_slug: null });
  assert.equal(candidate.providerEventId, baseRow.condition_id);
});

// 2. Identity preservation across S1/S2/S3 -----------------------------------

test("evaluateCandidate produces S1/S2/S3 rows that all carry the same candidate identity fields", () => {
  const materialized = assembleCandidate(baseRow, [], null);
  const rows = evaluateCandidate(materialized);
  assert.equal(rows.length, 3);
  const identityKeys = rows.map(
    (r) => `${r.payload.condition_id}::${r.payload.selected_token_id}::${r.payload.provider_event_id}::${r.payload.formula_version}::${r.payload.decision_time}`,
  );
  assert.equal(new Set(identityKeys).size, 1);
});

// 3. Temporal ordering / causality -------------------------------------------

test("assembleCandidate excludes snapshots at or before decision time from S2/S3 observations", () => {
  const before: RawSnapshotRow = {
    captured_at: "2026-07-16T09:00:00.000Z",
    condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id,
    implied_decimal_odds_mid: 2.5,
    implied_decimal_odds_bid: 2.4,
    spread_bps: 100,
    bid_depth_total: 100,
    event_slug: baseRow.event_slug,
    market_slug: null,
    event_title: null,
    market_title: null,
    normalized_sport: "soccer",
    normalized_market_family: "total",
    market_family_gate_status: "passed",
  };
  const atDecisionTime: RawSnapshotRow = { ...before, captured_at: baseRow.created_at };
  const after: RawSnapshotRow = { ...before, captured_at: "2026-07-17T03:21:09.814Z", implied_decimal_odds_mid: 2.6 };

  const materialized = assembleCandidate(baseRow, [before, atDecisionTime, after], null);
  assert.equal(materialized.s2s3Observations.length, 1);
  assert.equal(materialized.s2s3Observations[0].observedAtIso, after.captured_at);
});

test("observations feeding S2/S3 stay in ascending time order regardless of input order", () => {
  const s = (iso: string, odds: number): RawSnapshotRow => ({
    captured_at: iso,
    condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id,
    implied_decimal_odds_mid: odds,
    implied_decimal_odds_bid: odds,
    spread_bps: 10,
    bid_depth_total: 10,
    event_slug: baseRow.event_slug,
    market_slug: null,
    event_title: null,
    market_title: null,
    normalized_sport: "soccer",
    normalized_market_family: "total",
    market_family_gate_status: "passed",
  });
  const materialized = assembleCandidate(
    baseRow,
    [s("2026-07-17T05:00:00Z", 2.1), s("2026-07-17T03:00:00Z", 2.0), s("2026-07-17T04:00:00Z", 2.05)],
    null,
  );
  const times = materialized.s2s3Observations.map((o) => o.observedAtIso);
  assert.deepEqual(
    times,
    [...times].sort(),
  );
});

// 4. Exact Score exclusion ---------------------------------------------------

test("isExcludedFromOrdinaryHold flags Exact Score / Correct Score text and nothing else", () => {
  assert.equal(isExcludedFromOrdinaryHold("Exact Score: 2-1"), true);
  assert.equal(isExcludedFromOrdinaryHold("Correct score market"), true);
  assert.equal(isExcludedFromOrdinaryHold("mls-lag-laf-2026-07-17-total-2pt5"), false);
  assert.equal(isExcludedFromOrdinaryHold(null), false);
  assert.equal(isExcludedFromOrdinaryHold(undefined), false);
});

test("assembleCandidate drops Exact Score snapshots from the S2/S3 observation window", () => {
  const exactScoreSnapshot: RawSnapshotRow = {
    captured_at: "2026-07-17T03:21:09.814Z",
    condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id,
    implied_decimal_odds_mid: 5.0,
    implied_decimal_odds_bid: 4.8,
    spread_bps: 10,
    bid_depth_total: 10,
    event_slug: null,
    market_slug: null,
    event_title: "Exact Score 2-1",
    market_title: null,
    normalized_sport: "soccer",
    normalized_market_family: "total",
    market_family_gate_status: "passed",
  };
  const materialized = assembleCandidate(baseRow, [exactScoreSnapshot], null);
  assert.equal(materialized.s2s3Observations.length, 0);
});

// 5. No fabricated ACTUAL_FILL -----------------------------------------------

test("without an authoritative fill row, S2/S3 status is never ACTUAL_FILL even when reachable", () => {
  const s: RawSnapshotRow = {
    captured_at: "2026-07-17T03:21:09.814Z",
    condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id,
    implied_decimal_odds_mid: 2.6,
    implied_decimal_odds_bid: 2.5,
    spread_bps: 10,
    bid_depth_total: 10,
    event_slug: baseRow.event_slug,
    market_slug: null,
    event_title: null,
    market_title: null,
    normalized_sport: "soccer",
    normalized_market_family: "total",
    market_family_gate_status: "passed",
  };
  const materialized = assembleCandidate(baseRow, [s], null);
  const rows = evaluateCandidate(materialized);
  const s2 = rows.find((r) => r.strategy === "S2_FIXED_MAKER_HOLD")!;
  const s3 = rows.find((r) => r.strategy === "S3_MAKER_VALUE_BAND_HOLD")!;
  assert.notEqual(s2.payload.status, "ACTUAL_FILL");
  assert.notEqual(s3.payload.status, "ACTUAL_FILL");
  assert.equal(s2.payload.actual_fill_decimal_odds, null);
  assert.equal(s3.payload.actual_fill_decimal_odds, null);
});

test("an authoritative fill row is required for ACTUAL_FILL, and only then is it populated", () => {
  const fill = { filledDecimalOdds: 2.0, filledAtIso: "2026-07-17T04:00:00Z", source: "bet_execution_ledger" as const };
  const materialized = assembleCandidate(baseRow, [], fill);
  const rows = evaluateCandidate(materialized);
  const s2 = rows.find((r) => r.strategy === "S2_FIXED_MAKER_HOLD")!;
  assert.equal(s2.payload.status, "ACTUAL_FILL");
  assert.equal(s2.payload.actual_fill_decimal_odds, 2.0);
  assert.equal(s2.payload.fill_evidence_source, "bet_execution_ledger");
});

test("clone unique and upsert keys include provider_event_id", () => {
  const sql = readFileSync("supabase/migrations/20260925051832_football_execution_matrix_authority_repair.sql", "utf8");
  assert.match(sql, /unique \(condition_id, selected_token_id, provider_event_id, formula_version,/);
  assert.match(sql, /on conflict \(condition_id, selected_token_id, provider_event_id, formula_version,/);
});

test("structured gate rejects non ordinary, partial and Exact Score soccer markets", () => {
  const base: RawSnapshotRow = { captured_at: "2026-07-17T03:21:09Z", condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id, implied_decimal_odds_mid: 2.5, implied_decimal_odds_bid: 2.4,
    spread_bps: 10, bid_depth_total: 10, event_slug: "match", market_slug: null,
    event_title: "Generic match", market_title: "Total Goals", normalized_sport: "soccer",
    normalized_market_family: "total", market_family_gate_status: "passed" };
  assert.equal(isOrdinaryFullMatchSnapshot(base), true);
  assert.equal(isOrdinaryFullMatchSnapshot({ ...base, normalized_market_family: "UNKNOWN" }), false);
  assert.equal(isOrdinaryFullMatchSnapshot({ ...base, market_title: "First Half Total Goals" }), false);
  assert.equal(isOrdinaryFullMatchSnapshot({ ...base, market_title: "Exact Score 2-1" }), false);
  assert.equal(isOrdinaryFullMatchSnapshot({ ...base, market_title: "Correct Score" , normalized_market_family: undefined }), false);
  assert.equal(isOrdinaryFullMatchSnapshot({ ...base, market_title: null, market_slug: "correct-score-2-1" }), false);
});

test("fill attribution requires unique matched order, causal executed ledger price", () => {
  const candidate = { ...baseRow, id: "pair-1" };
  const order = { source_signal_pair_id: "pair-1", clob_order_id: "order-1", condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id, fill_status: "MATCHED_CONFIRMED" };
  const ledger = { exchange_order_id: "order-1", condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id, bet_status: "filled", fill_price: 0.5,
    filled_at: "2026-07-16T10:00:00Z" };
  assert.equal(attributeExecutedFill(candidate, [order], [ledger])?.filledDecimalOdds, 2);
  assert.equal(attributeExecutedFill(candidate, [{ ...order, source_signal_pair_id: "other" }], [ledger]), null);
  assert.equal(attributeExecutedFill(candidate, [order], [{ ...ledger, filled_at: "2026-07-16T09:00:00Z" }]), null);
  assert.equal(attributeExecutedFill(candidate, [order], [{ ...ledger, fill_price: null }]), null);
  assert.equal(attributeExecutedFill(candidate, [order, order], [ledger]), null);
  assert.equal(attributeExecutedFill(candidate, [order], [{ ...ledger, exchange_order_id: "other" }]), null);
});

// 6. Idempotency (logical-identity window) -----------------------------------

test("recorded_window_start is deterministic from the same source snapshot set, enabling idempotent upsert", () => {
  const s: RawSnapshotRow = {
    captured_at: "2026-07-17T03:21:09.814Z",
    condition_id: baseRow.condition_id,
    token_id: baseRow.selected_token_id,
    implied_decimal_odds_mid: 2.6,
    implied_decimal_odds_bid: 2.5,
    spread_bps: 10,
    bid_depth_total: 10,
    event_slug: baseRow.event_slug,
    market_slug: null,
    event_title: null,
    market_title: null,
    normalized_sport: "soccer",
    normalized_market_family: "total",
    market_family_gate_status: "passed",
  };
  const run1 = evaluateCandidate(assembleCandidate(baseRow, [s], null));
  const run2 = evaluateCandidate(assembleCandidate(baseRow, [s], null));
  const s2run1 = run1.find((r) => r.strategy === "S2_FIXED_MAKER_HOLD")!;
  const s2run2 = run2.find((r) => r.strategy === "S2_FIXED_MAKER_HOLD")!;
  assert.equal(s2run1.payload.recorded_window_start, s2run2.payload.recorded_window_start);
  assert.deepEqual(s2run1.payload, s2run2.payload);
});
