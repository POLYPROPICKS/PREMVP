// TENNIS_SAFE_COMPARABLE_LEADERBOARD_V1 — focused coverage for the pure,
// DB-independent parts: the shared safe-tennis universe filter (reusing
// resolveTennisMoneyEligibility verbatim, never a re-derived rule),
// decision-time-safe identity lookup, and the QUALITY_FILL_A cap30
// already-approved live allocation rule.
//   node --import tsx --test tests/modeling/tennisSafeComparableLeaderboard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityLookup,
  buildSafeUniverse,
  resolveSafeTennisDecision,
  sportSplit,
  fillRateAtCap,
  applyQualityFillACap30,
  round,
  type IdentityCandidate,
} from "../../scripts/modeling/tennis-safe-comparable-leaderboard";
import type { AtlasInputEvent } from "../../scripts/modeling/factor-atlas";
import type { TieredBet } from "../../scripts/modeling/daily-portfolio-frontier";

function baseEvent(overrides: Partial<AtlasInputEvent>): AtlasInputEvent {
  return {
    physicalEventKey: "evt-1",
    decisionTimestamp: "2026-09-01T10:00:00.000Z",
    eventStart: "2026-09-01T12:00:00.000Z",
    entryPrice: 0.51,
    sportFamily: "tennis",
    outcome: "WIN",
    ref: "0xcond1",
    scoreLevel: null,
    score: { observationCount: 0, delta: null } as any,
    selectedPrice: { observationCount: 0, delta: null } as any,
    volumeUsd: null,
    rowLeadTimeHours: null,
    marketTypeRaw: null,
    ...overrides,
  };
}

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
  const { safeUniverse, rawTennisN, approvedTennisN } = buildSafeUniverse([soccerRow], () => undefined, () => null);
  assert.deepEqual(safeUniverse, [soccerRow]);
  assert.equal(rawTennisN, 0);
  assert.equal(approvedTennisN, 0);
});

test("buildSafeUniverse: an approved tennis row is retained, an excluded one is dropped and counted", () => {
  const approvedRow = baseEvent({ physicalEventKey: "evt-approved", ref: "0xapproved" });
  const excludedRow = baseEvent({ physicalEventKey: "evt-excluded", ref: "0xexcluded" });
  const identityLookup = (conditionId: string): IdentityCandidate | null =>
    conditionId === "0xapproved"
      ? { createdAt: "2026-09-01T09:59:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "ATP Rome: Completed Match: A vs B", eventIdentityText: "ATP Rome: A vs B" }
      : { createdAt: "2026-09-01T09:59:00.000Z", structuredMarketType: "tennis_completed_match", marketText: "M15 Reus: Completed Match: A vs B", eventIdentityText: "M15 Reus: A vs B" };
  const result = buildSafeUniverse([approvedRow, excludedRow], () => "tok1", identityLookup);
  assert.equal(result.rawTennisN, 2);
  assert.equal(result.approvedTennisN, 1);
  assert.deepEqual(result.safeUniverse.map((e) => e.physicalEventKey), ["evt-approved"]);
  assert.deepEqual(result.excludedTennisInput.map((e) => e.physicalEventKey), ["evt-excluded"]);
});

test("buildSafeUniverse: a tennis row with no resolvable selected_token_id is excluded (safe default), never silently approved", () => {
  const row = baseEvent({ physicalEventKey: "evt-no-token" });
  const result = buildSafeUniverse([row], () => undefined, () => {
    throw new Error("identityLookup must not be called without a selectedTokenId");
  });
  assert.equal(result.approvedTennisN, 0);
  assert.equal(result.rawTennisN, 1);
  assert.deepEqual(result.excludedTennisInput.map((e) => e.physicalEventKey), ["evt-no-token"]);
});

function tieredBet(overrides: Partial<TieredBet>): TieredBet {
  return {
    physicalEventKey: "k",
    decisionTimestamp: "2026-09-01T10:00:00.000Z",
    eventStart: "2026-09-01T12:00:00.000Z",
    leadTimeHours: 2,
    entryPrice: 0.51,
    sportFamily: "soccer",
    outcome: "WIN",
    pnlU: 1,
    tier: 1,
    day: "2026-09-01",
    ...overrides,
  };
}

test("sportSplit buckets into football/tennis/other with correct pct", () => {
  const bets = [
    tieredBet({ sportFamily: "soccer", physicalEventKey: "a" }),
    tieredBet({ sportFamily: "tennis", physicalEventKey: "b" }),
    tieredBet({ sportFamily: "baseball", physicalEventKey: "c" }),
    tieredBet({ sportFamily: "baseball", physicalEventKey: "d" }),
  ];
  const split = sportSplit(bets);
  assert.equal(split.FOOTBALL_N, 1);
  assert.equal(split.TENNIS_N, 1);
  assert.equal(split.OTHER_N, 2);
  assert.equal(split.FOOTBALL_PCT, 25);
  assert.equal(split.TENNIS_PCT, 25);
  assert.equal(split.OTHER_PCT, 50);
});

test("fillRateAtCap: fraction of days meeting the cap threshold, measured on UNCAPPED daily supply", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const bets = [
    ...Array.from({ length: 30 }, (_, i) => tieredBet({ physicalEventKey: `d1-${i}`, day: "2026-09-01" })),
    ...Array.from({ length: 10 }, (_, i) => tieredBet({ physicalEventKey: `d2-${i}`, day: "2026-09-02" })),
  ];
  assert.equal(fillRateAtCap(bets, dates, 30), round(1 / 3, 4));
  assert.equal(fillRateAtCap(bets, dates, 5), round(2 / 3, 4));
});

test("QUALITY_FILL_A cap30: football >=20 supply keeps exactly 20 football + max 7 tennis, other fills the rest", () => {
  const day = "2026-09-01";
  const football = Array.from({ length: 25 }, (_, i) => tieredBet({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day, tier: 1 }));
  const tennis = Array.from({ length: 10 }, (_, i) => tieredBet({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day, tier: 1 }));
  const other = Array.from({ length: 5 }, (_, i) => tieredBet({ physicalEventKey: `ot-${i}`, sportFamily: "baseball", day, tier: 1 }));
  const kept = applyQualityFillACap30([...football, ...tennis, ...other], [day]);
  const split = sportSplit(kept);
  assert.equal(split.FOOTBALL_N, 20);
  assert.equal(split.TENNIS_N, 7);
  assert.equal(split.OTHER_N, 3); // 30 - 20 - 7
  assert.equal(kept.length, 30);
});

test("QUALITY_FILL_A cap30: football <20 supply keeps ALL football + unrestricted approved tennis, other fills what remains", () => {
  const day = "2026-09-01";
  const football = Array.from({ length: 12 }, (_, i) => tieredBet({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day, tier: 1 }));
  const tennis = Array.from({ length: 15 }, (_, i) => tieredBet({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day, tier: 1 }));
  const other = Array.from({ length: 10 }, (_, i) => tieredBet({ physicalEventKey: `ot-${i}`, sportFamily: "baseball", day, tier: 1 }));
  const kept = applyQualityFillACap30([...football, ...tennis, ...other], [day]);
  const split = sportSplit(kept);
  assert.equal(split.FOOTBALL_N, 12, "all football kept, not capped at 20");
  assert.equal(split.TENNIS_N, 15, "tennis is unrestricted when football supply < 20");
  assert.equal(split.OTHER_N, 3); // 30 - 12 - 15
});

test("QUALITY_FILL_A cap30: unrestricted tennis can push a thin-football day past 30 total (rule is literal, not re-capped)", () => {
  const day = "2026-09-01";
  const football = Array.from({ length: 5 }, (_, i) => tieredBet({ physicalEventKey: `fb-${i}`, sportFamily: "soccer", day, tier: 1 }));
  const tennis = Array.from({ length: 40 }, (_, i) => tieredBet({ physicalEventKey: `tn-${i}`, sportFamily: "tennis", day, tier: 1 }));
  const kept = applyQualityFillACap30([...football, ...tennis], [day]);
  const split = sportSplit(kept);
  assert.equal(split.FOOTBALL_N, 5);
  assert.equal(split.TENNIS_N, 40);
  assert.equal(kept.length, 45);
});
