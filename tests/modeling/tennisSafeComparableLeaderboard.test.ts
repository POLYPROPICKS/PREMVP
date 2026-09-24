// TENNIS_SAFE_COMPARABLE_LEADERBOARD_V1 — focused coverage for the pure,
// DB-independent parts: the shared safe-tennis universe filter (reusing
// resolveTennisMoneyEligibility verbatim, never a re-derived rule),
// decision-time-safe identity lookup, the QUALITY_FILL_A_SAFE exact live-mix
// allocation (selectLiveReservationMix, reused verbatim), and the
// settlement-blind selection / post-selection settlement-join contract.
//   node --import tsx --test tests/modeling/tennisSafeComparableLeaderboard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityLookup,
  buildSafeUniverse,
  resolveSafeTennisDecision,
  sportSplit,
  daysSupplyAtCapRate,
  applyReconciledAuthority,
  buildReconciledClassificationMap,
  referenceEconomics,
  PNL_CLASS,
  PNL_AUTHORITY,
  applyLiveMixAllocation,
  QUALITY_FILL_A_SAFE_MIX_CONFIGS,
  round,
  type IdentityCandidate,
} from "../../scripts/modeling/tennis-safe-comparable-leaderboard";
import type { DecisionTimeCandidate } from "../../scripts/modeling/factor-atlas";
import type { SelectedCandidate } from "../../scripts/modeling/daily-portfolio-frontier";
import type { CorpusLabel } from "../../lib/modeling/research-corpus/rollingCorpus";
import { selectLiveReservationMix } from "../../lib/executor/liveReservationAllocationPolicy";

function baseEvent(overrides: Partial<DecisionTimeCandidate>): DecisionTimeCandidate {
  return {
    physicalEventKey: "evt-1",
    decisionTimestamp: "2026-09-01T10:00:00.000Z",
    eventStart: "2026-09-01T12:00:00.000Z",
    entryPrice: 0.51,
    sportFamily: "tennis",
    ref: "0xcond1",
    candidateRef: "tok1",
    scoreLevel: null,
    score: { observationCount: 0, delta: null } as any,
    selectedPrice: { observationCount: 0, delta: null } as any,
    volumeUsd: null,
    rowLeadTimeHours: null,
    marketTypeRaw: null,
    candidateIdentity: "0xcond1::tok1::2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

test("FOCUSED: DecisionTimeCandidate (what every model predicate and the safe-tennis gate receive) has no settlement field at all", () => {
  const e = baseEvent({});
  assert.equal("labelAsOf" in e, false);
  assert.equal("outcome" in e, false);
});

test("resolveSafeTennisDecision reuses resolveTennisMoneyEligibility verbatim: eligible completed-match tennis with clean identity passes", () => {
  const identity: IdentityCandidate = {
    createdAt: "2026-09-01T09:59:00.000Z",
    structuredMarketType: "tennis_completed_match",
    marketText: "ATP Rome: Completed Match: A vs B",
    eventIdentityText: "ATP Rome: A vs B",
  };
  const decision = resolveSafeTennisDecision({ marketTypeRaw: null }, identity);
  assert.equal(decision.eligible, true);
  assert.equal(decision.reasonCode, "TENNIS_MONEY_ELIGIBLE");
});

test("resolveSafeTennisDecision excludes M15/M25/W15/W35/W50, Juniors, and Qualifying", () => {
  for (const level of ["M15", "M25", "W15", "W35", "W50"]) {
    const decision = resolveSafeTennisDecision(
      { marketTypeRaw: "tennis_completed_match" },
      { createdAt: "x", structuredMarketType: "tennis_completed_match", marketText: `${level} Reus: Completed Match: A vs B`, eventIdentityText: `${level} Reus: A vs B` },
    );
    assert.equal(decision.eligible, false, level);
    assert.equal(decision.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL", level);
  }
  const juniors = resolveSafeTennisDecision(
    { marketTypeRaw: "tennis_completed_match" },
    { createdAt: "x", structuredMarketType: "tennis_completed_match", marketText: "Wimbledon Juniors: Completed Match: A vs B", eventIdentityText: "Wimbledon Juniors: A vs B" },
  );
  assert.equal(juniors.eligible, false);
  assert.equal(juniors.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
  const qualifying = resolveSafeTennisDecision(
    { marketTypeRaw: "tennis_completed_match" },
    { createdAt: "x", structuredMarketType: "tennis_completed_match", marketText: "ATP Rome Qualifying: Completed Match: A vs B", eventIdentityText: "ATP Rome Qualifying: A vs B" },
  );
  assert.equal(qualifying.eligible, false);
  assert.equal(qualifying.reasonCode, "TENNIS_EXCLUDED_TOURNAMENT_LEVEL");
});

test("resolveSafeTennisDecision rejects tennis with no joined identity (no event identity text) and non-completed-match types", () => {
  const noIdentity = resolveSafeTennisDecision({ marketTypeRaw: null }, null);
  assert.equal(noIdentity.eligible, false);
  assert.equal(noIdentity.reasonCode, "TENNIS_MARKET_TYPE_NOT_COMPLETED_MATCH");

  const wrongType = resolveSafeTennisDecision(
    { marketTypeRaw: "tennis_moneyline" },
    { createdAt: "x", structuredMarketType: "tennis_moneyline", marketText: "ATP Rome: A vs B", eventIdentityText: "ATP Rome: A vs B" },
  );
  assert.equal(wrongType.eligible, false);
  assert.equal(wrongType.reasonCode, "TENNIS_MARKET_TYPE_NOT_COMPLETED_MATCH");
});

test("buildIdentityLookup is decision-time-safe: never returns a GSP candidate created after decisionAt", () => {
  const rowsByPair = new Map<string, IdentityCandidate[]>([
    [
      "0xcond1::tok1",
      [
        { createdAt: "2026-09-01T08:00:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "old text", eventIdentityText: "old identity" },
        { createdAt: "2026-09-01T10:30:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "future text", eventIdentityText: "future identity" },
      ],
    ],
  ]);
  const lookup = buildIdentityLookup(rowsByPair);
  const atDecision = lookup("0xcond1", "tok1", "2026-09-01T09:00:00.000Z");
  assert.equal(atDecision?.eventIdentityText, "old identity", "must never pick the candidate created AFTER decisionAt");
  const noneEligible = lookup("0xcond1", "tok1", "2026-09-01T07:00:00.000Z");
  assert.equal(noneEligible, null, "no candidate before decisionAt -> null, never a future one");
});

test("buildSafeUniverse: non-tennis rows pass through unchanged", () => {
  const soccerRow = baseEvent({ sportFamily: "soccer", physicalEventKey: "evt-soccer" });
  const { safeUniverse, rawTennisN, approvedTennisN } = buildSafeUniverse([soccerRow], () => null);
  assert.deepEqual(safeUniverse, [soccerRow]);
  assert.equal(rawTennisN, 0);
  assert.equal(approvedTennisN, 0);
});

test("buildSafeUniverse: an approved tennis row is retained, an excluded one is dropped and counted (gate runs BEFORE model selection, decision-time only)", () => {
  const approvedRow = baseEvent({ physicalEventKey: "evt-approved", ref: "0xapproved", candidateRef: "tok1" });
  const excludedRow = baseEvent({ physicalEventKey: "evt-excluded", ref: "0xexcluded", candidateRef: "tok1" });
  const identityLookup = (conditionId: string): IdentityCandidate | null =>
    conditionId === "0xapproved"
      ? { createdAt: "2026-09-01T09:59:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "ATP Rome: Completed Match: A vs B", eventIdentityText: "ATP Rome: A vs B" }
      : { createdAt: "2026-09-01T09:59:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "M15 Reus: Completed Match: A vs B", eventIdentityText: "M15 Reus: A vs B" };
  const result = buildSafeUniverse([approvedRow, excludedRow], identityLookup);
  assert.equal(result.rawTennisN, 2);
  assert.equal(result.approvedTennisN, 1);
  assert.deepEqual(result.safeUniverse.map((e) => e.physicalEventKey), ["evt-approved"]);
  assert.deepEqual(result.excludedTennisInput.map((e) => e.physicalEventKey), ["evt-excluded"]);
});

function selectedCandidate(overrides: Partial<SelectedCandidate>): SelectedCandidate {
  return {
    physicalEventKey: "k",
    decisionTimestamp: "2026-09-01T10:00:00.000Z",
    eventStart: "2026-09-01T12:00:00.000Z",
    leadTimeHours: 2,
    entryPrice: 0.51,
    sportFamily: "soccer",
    tier: 1,
    day: "2026-09-01",
    candidateIdentity: "k::identity",
    ...overrides,
  };
}

test("SelectedCandidate (output of selection+cap) also has no settlement field", () => {
  const c = selectedCandidate({});
  assert.equal("labelAsOf" in c, false);
  assert.equal("outcome" in c, false);
});

test("sportSplit buckets into football/tennis/other with correct pct", () => {
  const bets = [
    selectedCandidate({ sportFamily: "soccer", physicalEventKey: "a" }),
    selectedCandidate({ sportFamily: "tennis", physicalEventKey: "b" }),
    selectedCandidate({ sportFamily: "baseball", physicalEventKey: "c" }),
    selectedCandidate({ sportFamily: "baseball", physicalEventKey: "d" }),
  ];
  const split = sportSplit(bets);
  assert.equal(split.FOOTBALL_N, 1);
  assert.equal(split.TENNIS_N, 1);
  assert.equal(split.OTHER_N, 2);
  assert.equal(split.FOOTBALL_PCT, 25);
  assert.equal(split.TENNIS_PCT, 25);
  assert.equal(split.OTHER_PCT, 50);
});

test("daysSupplyAtCapRate (supply coverage, NOT venue fill probability): fraction of days whose UNCAPPED supply meets the cap", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const bets = [
    ...Array.from({ length: 30 }, (_, i) => selectedCandidate({ physicalEventKey: `d1-${i}`, day: "2026-09-01" })),
    ...Array.from({ length: 10 }, (_, i) => selectedCandidate({ physicalEventKey: `d2-${i}`, day: "2026-09-02" })),
  ];
  assert.equal(daysSupplyAtCapRate(bets, dates, 30), round(1 / 3, 4));
  assert.equal(daysSupplyAtCapRate(bets, dates, 5), round(2 / 3, 4));
});

// ── QUALITY_FILL_A_SAFE live-mix allocation (selectLiveReservationMix, reused verbatim) ──

test("cap30/40/50 configs never exceed their cap (sufficient-football branch)", () => {
  const day = "2026-09-01";
  for (const cap of [30, 40, 50] as const) {
    const config = QUALITY_FILL_A_SAFE_MIX_CONFIGS[cap];
    const football = Array.from({ length: config.footballFirstSlots + 10 }, (_, i) => selectedCandidate({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day }));
    const tennis = Array.from({ length: 30 }, (_, i) => selectedCandidate({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day }));
    const other = Array.from({ length: 30 }, (_, i) => selectedCandidate({ physicalEventKey: `ot-${i}`, sportFamily: "baseball", day }));
    const kept = applyLiveMixAllocation([...football, ...tennis, ...other], [day], config);
    assert.ok(kept.length <= cap, `cap${cap}: kept.length=${kept.length} must be <= ${cap}`);
  }
});

test("cap30/40/50: sufficient-football branch enforces exactly footballFirstSlots + tennisMaxWhenFootballSufficient", () => {
  const day = "2026-09-01";
  const expectations: Array<[30 | 40 | 50, number, number]> = [
    [30, 20, 7],
    [40, 26, 10],
    [50, 33, 12],
  ];
  for (const [cap, footballFirstSlots, tennisMax] of expectations) {
    const config = QUALITY_FILL_A_SAFE_MIX_CONFIGS[cap];
    assert.equal(config.footballFirstSlots, footballFirstSlots);
    assert.equal(config.tennisMaxWhenFootballSufficient, tennisMax);
    const football = Array.from({ length: footballFirstSlots + 15 }, (_, i) => selectedCandidate({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day }));
    const tennis = Array.from({ length: 20 }, (_, i) => selectedCandidate({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day }));
    const other = Array.from({ length: 20 }, (_, i) => selectedCandidate({ physicalEventKey: `ot-${i}`, sportFamily: "baseball", day }));
    const kept = applyLiveMixAllocation([...football, ...tennis, ...other], [day], config);
    const split = sportSplit(kept);
    assert.equal(split.FOOTBALL_N, footballFirstSlots, `cap${cap} football`);
    assert.equal(split.TENNIS_N, tennisMax, `cap${cap} tennis`);
    assert.equal(split.OTHER_N, cap - footballFirstSlots - tennisMax, `cap${cap} other`);
    assert.equal(kept.length, cap);
  }
});

test("cap30/40/50: shortage branch (football < footballFirstSlots) allows ALL football + tennis to fill remaining capacity without the percentage cap, other fills the rest, total never exceeds cap", () => {
  const day = "2026-09-01";
  for (const cap of [30, 40, 50] as const) {
    const config = QUALITY_FILL_A_SAFE_MIX_CONFIGS[cap];
    const footballN = Math.floor(config.footballFirstSlots / 2);
    const football = Array.from({ length: footballN }, (_, i) => selectedCandidate({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day }));
    const tennis = Array.from({ length: 50 }, (_, i) => selectedCandidate({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day }));
    const other = Array.from({ length: 50 }, (_, i) => selectedCandidate({ physicalEventKey: `ot-${i}`, sportFamily: "baseball", day }));
    const kept = applyLiveMixAllocation([...football, ...tennis, ...other], [day], config);
    const split = sportSplit(kept);
    assert.equal(split.FOOTBALL_N, footballN, `cap${cap}: all football kept, not capped at footballFirstSlots`);
    assert.equal(kept.length, cap, `cap${cap}: total must hit the cap exactly (tennis+other backfill), never exceed it`);
    assert.ok(split.TENNIS_N > config.tennisMaxWhenFootballSufficient, `cap${cap}: tennis must NOT be restricted to ${config.tennisMaxWhenFootballSufficient} in the shortage branch`);
  }
});

test("selectLiveReservationMix (the exact reused rule) never returns more than cap even with abundant supply in every bucket", () => {
  const football = Array.from({ length: 100 }, (_, i) => ({ id: `fb-${i}` }));
  const tennis = Array.from({ length: 100 }, (_, i) => ({ id: `tn-${i}` }));
  const other = Array.from({ length: 100 }, (_, i) => ({ id: `ot-${i}` }));
  for (const config of Object.values(QUALITY_FILL_A_SAFE_MIX_CONFIGS)) {
    const { finalN } = selectLiveReservationMix(football, tennis, other, config);
    assert.ok(finalN <= config.cap);
  }
});

// ── settlement reconciliation (post-selection join only) ───────────────────

test("settlement reconciliation: SELECTED_N = SETTLED_N + OPEN_N + OTHER_NONTERMINAL_N on a mixed capped set", async () => {
  const { partialMetricsFor } = await import("../../scripts/modeling/daily-portfolio-frontier");
  const capped: SelectedCandidate[] = [
    selectedCandidate({ physicalEventKey: "e1", candidateIdentity: "e1::id" }),
    selectedCandidate({ physicalEventKey: "e2", candidateIdentity: "e2::id" }),
    selectedCandidate({ physicalEventKey: "e3", candidateIdentity: "e3::id" }),
    selectedCandidate({ physicalEventKey: "e4", candidateIdentity: "e4::id" }),
  ];
  const settlementByCandidateIdentity = new Map<string, CorpusLabel>([
    ["e1::id", "WIN"],
    ["e2::id", "LOSS"],
    ["e3::id", "OPEN"],
    ["e4::id", "VOID"],
  ]);
  const m = partialMetricsFor(capped, settlementByCandidateIdentity);
  assert.equal(m.SELECTED_N, 4);
  assert.equal(m.SETTLED_N, 2);
  assert.equal(m.OPEN_N, 1);
  assert.equal(m.OTHER_NONTERMINAL_N, 1);
  assert.equal(m.SETTLED_N + m.OPEN_N + m.OTHER_NONTERMINAL_N, m.SELECTED_N);
});

// ── Review A repairs ──────────────────────────────────────────────────────────
import { runPortfolioStrict, runStandaloneStrict, applyDailyCap } from "../../scripts/modeling/daily-portfolio-frontier";

function overlayLine(e: DecisionTimeCandidate, sport: string | null, market: string | null) {
  const [condition_id, selected_token_id, decision_at] = e.candidateIdentity.split("::");
  return { condition_id, selected_token_id, decision_at, reconciled_sport_family: sport, reconciled_market_type: market };
}
function ev(id: string, evt: string, at: string, price: number, extra: Partial<DecisionTimeCandidate> = {}): DecisionTimeCandidate {
  return baseEvent({ physicalEventKey: evt, ref: `c-${id}`, candidateRef: "t", decisionTimestamp: at, entryPrice: price, sportFamily: "soccer", candidateIdentity: `c-${id}::t::${at}`, ...extra });
}

test("EXACT SCORE: excluded BEFORE physical-event selection — a later eligible candidate fills the event, Exact Score never claims it or a cap slot", () => {
  const es = ev("es", "evt-A", "2026-09-01T09:00:00.000Z", 0.51, { marketTypeRaw: "soccer_exact_score" });
  const ml = ev("ml", "evt-A", "2026-09-01T10:00:00.000Z", 0.51, { marketTypeRaw: "soccer_moneyline" });
  const others = Array.from({ length: 3 }, (_, i) => ev(`o${i}`, `evt-o${i}`, `2026-09-01T11:0${i}:00.000Z`, 0.51));
  const all = [es, ml, ...others];
  const overlay = buildReconciledClassificationMap(all.map((e) => overlayLine(e, "soccer", e.marketTypeRaw)));
  const r = applyReconciledAuthority(all, overlay);
  assert.equal(r.exactScoreExcludedIdentities.has(es.candidateIdentity), true);
  const selected = runStandaloneStrict(r.eligible, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52);
  const capped = applyDailyCap(selected, 2);
  assert.equal(capped.filter((c) => r.exactScoreExcludedIdentities.has(c.candidateIdentity)).length, 0);
  assert.equal(selected.find((c) => c.physicalEventKey === "evt-A")!.candidateIdentity, ml.candidateIdentity);
});

test("FOOTBALL AUTHORITY: sport comes only from the reconciled overlay; missing/conflicting overlay fails closed to unresolved", () => {
  const recovered = ev("r", "evt-r", "2026-09-01T09:00:00.000Z", 0.51, { sportFamily: "" });
  const missing = ev("m", "evt-m", "2026-09-01T09:00:00.000Z", 0.51, { sportFamily: "soccer" });
  const conflict = ev("x", "evt-x", "2026-09-01T09:00:00.000Z", 0.51, { sportFamily: "soccer" });
  const overlay = buildReconciledClassificationMap([
    overlayLine(recovered, "soccer", null),
    overlayLine(conflict, "soccer", null),
    overlayLine(conflict, "basketball", null),
  ]);
  const r = applyReconciledAuthority([recovered, missing, conflict], overlay);
  const byId = new Map(r.eligible.map((e) => [e.candidateIdentity, e.sportFamily]));
  assert.equal(byId.get(recovered.candidateIdentity), "soccer");
  assert.equal(byId.get(missing.candidateIdentity), "");
  assert.equal(byId.get(conflict.candidateIdentity), "");
  assert.equal(r.overlayMissN, 1);
});

const TIERS = [(e: any) => e.entryPrice >= 0.5 && e.entryPrice < 0.52, (e: any) => e.entryPrice >= 0.52 && e.entryPrice < 0.54];

test("PREFIX INVARIANCE: appending later observations never changes an already-made portfolio event decision", () => {
  const early = ev("1", "evt-P", "2026-09-01T09:00:00.000Z", 0.53); // tier 2, first qualifying observation
  const later = ev("2", "evt-P", "2026-09-01T12:00:00.000Z", 0.51); // tier 1, arrives later
  const prefix = runPortfolioStrict([early], TIERS as any);
  const full = runPortfolioStrict([early, later], TIERS as any);
  const fullReversedInput = runPortfolioStrict([later, early], TIERS as any);
  assert.deepEqual(full, prefix);
  assert.deepEqual(fullReversedInput, prefix);
  assert.equal(full[0].candidateIdentity, early.candidateIdentity);
  assert.equal(full[0].tier, 2);
  // Every prefix of a longer stream keeps every decision it already made.
  const stream = [early, later, ev("3", "evt-Q", "2026-09-01T13:00:00.000Z", 0.55), ev("4", "evt-Q", "2026-09-01T14:00:00.000Z", 0.52), ev("5", "evt-Q", "2026-09-01T15:00:00.000Z", 0.50)];
  for (let k = 1; k < stream.length; k++) {
    const before = new Map(runPortfolioStrict(stream.slice(0, k), TIERS as any).map((c) => [c.physicalEventKey, c]));
    const after = new Map(runPortfolioStrict(stream, TIERS as any).map((c) => [c.physicalEventKey, c]));
    for (const [key, c] of before) assert.deepEqual(after.get(key), c, `prefix ${k} event ${key}`);
  }
});

test("SELECTION BEFORE SETTLEMENT: selection is identical under any settlement map (outcome-independent)", () => {
  const cands = [ev("1", "evt-S", "2026-09-01T09:00:00.000Z", 0.53), ev("2", "evt-S", "2026-09-01T10:00:00.000Z", 0.51)];
  const selected = runPortfolioStrict(cands, TIERS as any);
  const winMap = new Map<string, CorpusLabel>(cands.map((c) => [c.candidateIdentity, "WIN"]));
  const lossMap = new Map<string, CorpusLabel>(cands.map((c) => [c.candidateIdentity, "LOSS"]));
  assert.deepEqual(runPortfolioStrict(cands, TIERS as any), selected);
  assert.notEqual(referenceEconomics(selected, winMap).REFERENCE_PNL_U, referenceEconomics(selected, lossMap).REFERENCE_PNL_U);
});

test("FINALITY: every nonterminal status (OPEN/NO_MATCH/AMBIGUOUS) is bounded; VOID is terminal with 0 reference PnL per RESEARCH_CORPUS_CONTRACT §5.3", () => {
  const labels: CorpusLabel[] = ["WIN", "LOSS", "VOID", "OPEN", "NO_MATCH", "AMBIGUOUS"];
  const capped = labels.map((_, i) => selectedCandidate({ physicalEventKey: `f${i}`, candidateIdentity: `f${i}::id`, entryPrice: 0.5 }));
  const map = new Map<string, CorpusLabel>(labels.map((l, i) => [`f${i}::id`, l]));
  const r = referenceEconomics(capped, map);
  assert.equal(r.SELECTED_N, 6);
  assert.equal(r.SETTLED_N, 2);
  assert.equal(r.VOID_N, 1);
  assert.equal(r.TERMINAL_N, 3);
  assert.equal(r.UNRESOLVED_N, 3);
  assert.deepEqual(r.UNRESOLVED_BY_STATUS, { OPEN: 1, NO_MATCH: 1, AMBIGUOUS: 1 });
  assert.equal(r.REFERENCE_PNL_U, 0); // +1 WIN @0.5, -1 LOSS, VOID 0
  assert.equal(r.REFERENCE_FINAL_PNL_WORST_U, -3);
  assert.equal(r.REFERENCE_FINAL_PNL_BEST_U, 3);
  assert.equal(r.STATUS, "PARTIAL_SETTLEMENT");
  const allVoid = referenceEconomics([capped[2]], map);
  assert.equal(allVoid.STATUS, "FINAL_REPRODUCIBLE");
  assert.equal(allVoid.REFERENCE_FINAL_PNL_WORST_U, 0);
  assert.equal(PNL_CLASS, "REFERENCE_PNL");
  assert.equal(PNL_AUTHORITY, "NOT_EXECUTION_AUTHORITY");
});
