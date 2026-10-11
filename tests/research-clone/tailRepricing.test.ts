/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLineAuthority, validateGameState, findScoreInconsistencies, validateExecutableBuy, validateEvAuthority, assessTailRow,
  freezeContractDecision, summarizeCoverage, replayTotalsPayoff, reconcileSettlement, lineFromSlug, lineFromLabel, tailDecisionId,
  TAIL_CAN_EMIT_BET, MAX_STATE_AGE_MS, type ProbabilityModel, type ProbabilityEstimate, type LineAuthority, type TailRowAssessment,
} from "../../lib/research/tailRepricing";
import { ALPHA_PROGRAMS, buildDecision, type Observation } from "../../lib/research/inplayPaperDecisions";

const COND = "0xABC", OVER = "tok-over", UNDER = "tok-under";
const market = (o: Record<string, unknown> = {}): any => ({
  conditionId: COND.toLowerCase(), question: "A vs. B: O/U 2.5", slug: "epl-a-b-2026-10-10-total-2pt5", sportsMarketType: "totals", line: 2.5,
  groupItemTitle: "O/U 2.5", outcomes: '["Over", "Under"]', clobTokenIds: JSON.stringify([OVER, UNDER]), ...o,
});
const lineOf = (o: Record<string, unknown> = {}, token = OVER, side = "Over", obsSlug: string | null = "epl-a-b-2026-10-10-total-2pt5") =>
  resolveLineAuthority({ conditionId: COND, tokenId: token, side, observationSlug: obsSlug, market: market(o) });

const OBS_AT = "2026-10-10T15:00:00.000Z";
let n = 0;
function row(o: Record<string, unknown> = {}): Observation & { state_clock_seconds_elapsed: number | null; state_received_at: string | null } {
  return {
    id: `id-${++n}`, physical_event_id: "ev1", provider_game_id: "g1", provider_event_id: "pe1", provider_sport_family: "soccer",
    event_start_iso: "2026-10-10T14:00:00.000Z", observed_at: OBS_AT, created_at: OBS_AT, event_live_status: "LIVE", state_authority: "SPORTS_WS_STRUCTURED_STATUS",
    state_phase: "S2", state_period_num: 2, state_clock_seconds_remaining: null, state_clock_seconds_elapsed: 3600, state_received_at: "2026-10-10T14:59:50.000Z",
    side_a_score: 1, side_b_score: 0, condition_id: COND, token_id: OVER, side: "Over", canonical_market_family: "TOTALS", canonical_market_type: "TOTAL",
    market_slug: "epl-a-b-2026-10-10-total-2pt5", best_bid: 0.1, best_ask: 0.12, bid_depth_relevant_usd: 50, ask_depth_relevant_usd: 50,
    full_stake_executable_vwap: 0.12, full_stake_shares: 20, full_stake_exit_vwap: 0.1, full_stake_exit_fully_filled: true, taker_fee_usd: 0.02,
    orderbook_fetch_status: "SUCCESS", ...o,
  } as any;
}
const validModel = (p = 0.3, lcb = 0.25): ProbabilityModel => ({
  id: "m", version: "1", estimate: (): ProbabilityEstimate => ({
    model_id: "m", model_version: "1", p_win: p, p_lcb: lcb, inputs_exclude_market_price: true,
    calibration: { method: "walk-forward", frozen_before_decision: true, holdout_independent_games_n: 150, brier_model: 0.18, brier_market_baseline: 0.2, reliability_ok: true },
  }),
});
const PROVEN: LineAuthority = { status: "PROVEN", reason: "x", line: 2.5, direction: "OVER" };

// ── line authority ──
test("line: provider-corroborated half line is PROVEN with direction from token index", () => {
  assert.deepEqual([lineOf().status, lineOf().line, lineOf().direction], ["PROVEN", 2.5, "OVER"]);
  assert.equal(lineOf({}, UNDER, "Under").direction, "UNDER");
});
test("line: ambiguous cases never prove a line", () => {
  assert.equal(lineOf({ line: 3.5 }).reason, "LINE_SOURCES_DISAGREE");
  assert.equal(lineOf({ slug: "epl-a-b-2026-10-10-total-3pt5" }).reason, "LINE_SOURCES_DISAGREE");
  assert.equal(lineOf({ question: "A vs. B: O/U 3.5" }).status, "AMBIGUOUS");
  assert.equal(lineOf({ slug: "other-slug-without-suffix", question: "A vs B", groupItemTitle: "x" }).reason, "SCOPE_SUFFIX_NOT_FULL_GAME_MAIN_TOTAL");
  assert.equal(lineOf({ slug: null, question: "A vs B", groupItemTitle: null }).reason, "LINE_UNCORROBORATED");
  assert.equal(lineOf({ conditionId: "0xother" }).reason, "PROVIDER_CONDITION_MISMATCH");
  assert.equal(lineOf({}, "unknown-token").reason, "TOKEN_NOT_IN_PROVIDER_MARKET");
  assert.equal(lineOf({}, OVER, "Under").reason, "OBSERVATION_SIDE_CONTRADICTS_PROVIDER_OUTCOME");
  assert.equal(lineOf({}, OVER, "Over", "different-slug").reason, "OBSERVATION_SLUG_DIFFERS_FROM_PROVIDER_SLUG");
  assert.equal(lineOf({ outcomes: '["Yes","No"]' }).reason, "OUTCOME_TOKEN_STRUCTURE_NOT_OVER_UNDER");
});
test("line: unsupported scopes and payoff shapes", () => {
  assert.equal(lineOf({ sportsMarketType: "first_half_totals" }).status, "UNSUPPORTED");
  assert.equal(lineOf({ sportsMarketType: "spreads" }).status, "UNSUPPORTED");
  const integer = lineOf({ line: 3, slug: "x-total-3pt0", question: "O/U 3", groupItemTitle: "O/U 3" }, OVER, "Over", null);
  assert.equal(integer.reason, "NON_HALF_LINE_PAYOFF_NOT_TWO_WAY");
  const quarter = lineOf({ line: 2.25, slug: "x-total-2pt25", question: "O/U 2.25", groupItemTitle: "O/U 2.25" }, OVER, "Over", null);
  assert.equal(quarter.status, "UNSUPPORTED");
});
test("line: unavailable provider metadata is UNAVAILABLE, not guessed from slug/title", () => {
  assert.equal(resolveLineAuthority({ conditionId: COND, tokenId: OVER, side: "Over", market: null }).status, "UNAVAILABLE");
  const noMeta = lineOf({ sportsMarketType: undefined, line: undefined });
  assert.deepEqual([noMeta.status, noMeta.reason, noMeta.line], ["UNAVAILABLE", "PROVIDER_MARKET_TYPE_METADATA_ABSENT", null]);
  assert.equal(lineOf({ line: undefined }).reason, "PROVIDER_LINE_ABSENT");
  assert.equal(lineFromSlug("a-total-2pt5"), 2.5);
  assert.equal(lineFromSlug("a-total-2pt5-first-half"), null);
  assert.equal(lineFromLabel("A vs. B: O/U 2.5"), 2.5);
});

// ── state ──
test("state: complete fresh state is OK; missing/delayed/future/inconsistent are not", () => {
  assert.equal(validateGameState(row()).ok, true);
  assert.equal(validateGameState(row()).total_goals, 1);
  assert.match(validateGameState(row({ side_a_score: null }) as any).blocker!, /SOURCE_STATE_NULL_OR_INVALID:score/);
  assert.match(validateGameState(row({ state_clock_seconds_elapsed: null }) as any).blocker!, /clock/);
  assert.match(validateGameState(row({ state_received_at: null }) as any).blocker!, /receipt/);
  assert.equal(validateGameState(row({ state_received_at: new Date(Date.parse(OBS_AT) - MAX_STATE_AGE_MS - 1000).toISOString() }) as any).blocker, "STATE_DELAYED");
  assert.equal(validateGameState(row({ state_received_at: new Date(Date.parse(OBS_AT) + 30_000).toISOString() }) as any).blocker, "STATE_RECEIVED_AFTER_QUOTE");
  assert.equal(validateGameState(row({ side_a_score: 1.5 }) as any).ok, false);
  assert.equal(validateGameState(row({ state_period_num: 9 }) as any).blocker, "STATE_PERIOD_OR_CLOCK_OUT_OF_RANGE");
});
test("state: score decreasing across observations is flagged", () => {
  const a = row({ observed_at: "2026-10-10T14:50:00.000Z", side_a_score: 2, side_b_score: 0 });
  const b = row({ observed_at: "2026-10-10T14:55:00.000Z", side_a_score: 1, side_b_score: 0 });
  const c = row({ observed_at: "2026-10-10T14:58:00.000Z", side_a_score: 2, side_b_score: 1 });
  assert.deepEqual([...findScoreInconsistencies([c, b, a])], [b.id]);
});

// ── BUY depth ──
test("buy: insufficient depth / unavailable book / wrong vwap rejected", () => {
  assert.equal(validateExecutableBuy(row() as any).ok, true);
  assert.equal(validateExecutableBuy(row({ full_stake_executable_vwap: null, full_stake_shares: null }) as any).blocker, "BUY_DEPTH_INSUFFICIENT_FOR_FULL_STAKE");
  assert.equal(validateExecutableBuy(row({ orderbook_fetch_status: "FAILED" }) as any).blocker, "ORDERBOOK_UNAVAILABLE");
  assert.equal(validateExecutableBuy(row({ full_stake_executable_vwap: 1 }) as any).blocker, "FULL_STAKE_VWAP_INVALID");
  assert.equal(validateExecutableBuy(row({ full_stake_executable_vwap: 0.05 }) as any).blocker, "VWAP_BELOW_BEST_ASK_INCONSISTENT");
  assert.equal(validateExecutableBuy(row({ event_live_status: "FINAL" }) as any).blocker, "NOT_LIVE");
});

// ── EV authority / false-positive rejection ──
test("ev: no model => WAITING with exact blocker, never BET", () => {
  const a = assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: false, model: null });
  assert.deepEqual([a.status, a.first_broken_edge, a.blockers], ["WAITING", "EV_MODEL_AUTHORITY", ["EV_MODEL_AUTHORITY_ABSENT"]]);
  assert.equal(a.state_ok && a.line_proven && a.buy_ok, true);
});
test("ev: false-positive EV is rejected (market-derived, uncalibrated, tiny holdout, no better than market, bad probability)", () => {
  const base = validModel().estimate({} as any)!;
  assert.equal(validateEvAuthority(base), null);
  assert.equal(validateEvAuthority({ ...base, inputs_exclude_market_price: false }), "PROBABILITY_DERIVED_FROM_MARKET_PRICE");
  assert.equal(validateEvAuthority({ ...base, calibration: null }), "CALIBRATION_RECEIPT_ABSENT");
  assert.equal(validateEvAuthority({ ...base, calibration: { ...base.calibration!, holdout_independent_games_n: 12 } }), "HOLDOUT_INDEPENDENT_GAMES_BELOW_MINIMUM");
  assert.equal(validateEvAuthority({ ...base, calibration: { ...base.calibration!, brier_model: 0.21 } }), "NOT_BETTER_THAN_MARKET_BASELINE");
  assert.equal(validateEvAuthority({ ...base, calibration: { ...base.calibration!, frozen_before_decision: false } }), "MODEL_NOT_FROZEN_BEFORE_DECISION");
  assert.equal(validateEvAuthority({ ...base, p_lcb: 0.9 }), "PROBABILITY_INVALID");
  const unfrozen: ProbabilityModel = { id: "m", version: "1", estimate: () => ({ ...base, inputs_exclude_market_price: false }) };
  const a = assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: false, model: unfrozen });
  assert.deepEqual([a.status, a.ev_valid, a.ev_qualified], ["WAITING", false, false]);
});
test("ev: huge edge is rejected as suspect; thin edge is SKIP; qualified edge still cannot BET", () => {
  const suspect = assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: false, model: validModel(0.5, 0.45) }); // vwap .12 => EV 3.17
  assert.deepEqual([suspect.status, suspect.blockers.at(-1)], ["SKIP", "SUSPECT_EV_ABOVE_CEILING_REJECTED"]);
  const thin = assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: false, model: validModel(0.125, 0.12) });
  assert.deepEqual([thin.status, thin.blockers.at(-1)], ["SKIP", "NO_POSITIVE_EV_AFTER_UNCERTAINTY_MARGIN"]);
  const ok = assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: false, model: validModel(0.2, 0.15) }); // EV lcb .25
  assert.deepEqual([ok.status, ok.ev_qualified, ok.first_broken_edge, ok.blockers.at(-1)], ["WAITING", true, "BET_AUTHORITY", "BET_AUTHORITY_NOT_GRANTED_FOR_ALPHA_PROGRAM"]);
});
test("tail program can never BET: authority flag and construction guard", () => {
  assert.equal(TAIL_CAN_EMIT_BET, false);
  const tail = ALPHA_PROGRAMS.find((p) => p.id === "VALUE_BACKED_TAIL_REPRICING")!;
  assert.throws(() => buildDecision(tail, "BET", {}), /ALPHA_BET_FORBIDDEN/);
});

// ── row assessment edges ──
test("assess: inconsistent score, delayed state, ambiguous line, thin depth each break the right edge", () => {
  assert.deepEqual(assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: true, model: null }).first_broken_edge, "GAME_STATE");
  assert.equal(assessTailRow({ row: row(), line: PROVEN, scoreInconsistent: true, model: null }).status, "SKIP");
  const delayed = assessTailRow({ row: row({ state_received_at: new Date(Date.parse(OBS_AT) - 5 * 60_000).toISOString() }), line: PROVEN, scoreInconsistent: false, model: null });
  assert.deepEqual([delayed.status, delayed.blockers[0]], ["WAITING", "STATE_DELAYED"]);
  const amb = assessTailRow({ row: row(), line: lineOf({ line: 3.5 }), scoreInconsistent: false, model: null });
  assert.deepEqual([amb.status, amb.first_broken_edge], ["SKIP", "CONTRACT_LINE_AUTHORITY"]);
  const unavailable = assessTailRow({ row: row(), line: lineOf({ sportsMarketType: undefined, line: undefined }), scoreInconsistent: false, model: null });
  assert.deepEqual([unavailable.status, unavailable.line, unavailable.line_proven], ["WAITING", null, false]);
  const thin = assessTailRow({ row: row({ full_stake_executable_vwap: null, full_stake_shares: null }), line: PROVEN, scoreInconsistent: false, model: validModel() });
  assert.deepEqual([thin.status, thin.first_broken_edge], ["WAITING", "EXECUTABLE_BUY"]);
  const dear = assessTailRow({ row: row({ full_stake_executable_vwap: 0.5, best_ask: 0.5 }), line: PROVEN, scoreInconsistent: false, model: validModel() });
  assert.deepEqual([dear.status, dear.first_broken_edge], ["SKIP", "TAIL_PRICE_RANGE"]);
  assert.equal(PROVEN.line, 2.5);
});

// ── freeze + coverage ──
test("freeze: causal first complete row, deterministic id, research-only", () => {
  const early = assessTailRow({ row: row({ id: "r1", full_stake_executable_vwap: null, full_stake_shares: null }), line: PROVEN, scoreInconsistent: false, model: null });
  const first = assessTailRow({ row: row({ id: "r2" }), line: PROVEN, scoreInconsistent: false, model: null });
  const later = assessTailRow({ row: row({ id: "r3", full_stake_executable_vwap: 0.2, best_ask: 0.2 }), line: PROVEN, scoreInconsistent: false, model: null });
  const d = freezeContractDecision([early, first, later])!;
  assert.deepEqual([d.observation_id, d.research_only, d.can_emit_bet, d.status], ["r2", true, false, "WAITING"]);
  assert.equal(d.decision_id, tailDecisionId("ev1", COND, OVER));
  assert.equal(freezeContractDecision([]), null);
});
test("coverage: counts games/contracts/rows, no BET, no advantage claimed", () => {
  const lines = new Map<string, LineAuthority>();
  const rows: TailRowAssessment[] = [];
  for (const ev of ["e1", "e2", "e3"]) {
    const r = row({ physical_event_id: ev, id: `${ev}-a` });
    const ln = ev === "e3" ? lineOf({ line: 9.5 }) : PROVEN;
    lines.set(`${ev}|${COND}|${OVER}`, ln);
    rows.push(assessTailRow({ row: r, line: ln, scoreInconsistent: false, model: null }));
  }
  const cov = summarizeCoverage(rows, lines);
  assert.deepEqual([cov.physical_games_n, cov.contracts_n, cov.line_proven_contracts_n, cov.line_status_counts.AMBIGUOUS], [3, 3, 2, 1]);
  assert.deepEqual([cov.bet_n, cov.skip_n, cov.waiting_n, cov.independent_games_with_full_facts_n], [0, 1, 2, 2]);
  assert.equal(cov.ev_valid_rows_n, 0);
  assert.equal(cov.any_economic_advantage_demonstrated, false);
  assert.equal(cov.blocker_counts.EV_MODEL_AUTHORITY_ABSENT, 2);
});

// ── settlement replay ──
test("settlement: replay from final score + line and reconcile with provider", () => {
  const over = replayTotalsPayoff({ line: PROVEN, finalSideAScore: 2, finalSideBScore: 1, maxPeriodObserved: 2 });
  assert.equal(over.state, "WIN");
  assert.equal(replayTotalsPayoff({ line: PROVEN, finalSideAScore: 1, finalSideBScore: 1, maxPeriodObserved: 2 }).state, "LOSS");
  assert.equal(replayTotalsPayoff({ line: { ...PROVEN, direction: "UNDER" }, finalSideAScore: 1, finalSideBScore: 1, maxPeriodObserved: 2 }).state, "WIN");
  assert.equal(replayTotalsPayoff({ line: PROVEN, finalSideAScore: null, finalSideBScore: 1, maxPeriodObserved: 2 }).reason, "FINAL_SCORE_UNAVAILABLE");
  assert.equal(replayTotalsPayoff({ line: PROVEN, finalSideAScore: 2, finalSideBScore: 2, maxPeriodObserved: 4 }).reason, "EXTRA_TIME_REGULATION_SCOPE_AMBIGUOUS");
  assert.equal(replayTotalsPayoff({ line: { status: "AMBIGUOUS", reason: "x", line: 2.5, direction: null }, finalSideAScore: 2, finalSideBScore: 2, maxPeriodObserved: 2 }).reason, "LINE_AUTHORITY_NOT_PROVEN");
  const closed = market({ closed: true, outcomePrices: '["1","0"]' });
  assert.equal(reconcileSettlement({ conditionId: COND, tokenId: OVER, market: closed, replay: over }).state, "CONSISTENT");
  assert.equal(reconcileSettlement({ conditionId: COND, tokenId: UNDER, market: closed, replay: { state: "WIN", reason: "" } }).state, "CONTRADICTION");
  assert.equal(reconcileSettlement({ conditionId: COND, tokenId: OVER, market: market({ closed: false, active: true }), replay: over }).state, "PROVIDER_UNSETTLED");
  assert.equal(reconcileSettlement({ conditionId: COND, tokenId: OVER, market: closed, replay: { state: "NOT_REPLAYABLE", reason: "FINAL_SCORE_UNAVAILABLE" } }).state, "NOT_REPLAYABLE");
});
