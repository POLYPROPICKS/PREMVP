import test from "node:test";
import assert from "node:assert/strict";
import type { ExactMarketIdentity, ReferenceEvidence } from "../../lib/executor/exactMarketReference";
import {
  evaluateEventPolicy,
  evaluatePolicyCandidate,
  type PolicyCandidateInput,
} from "../../lib/executor/t10EconomicActionPolicy";

const START = "2026-10-02T11:00:00.000Z";
const T30_AT = "2026-10-02T10:30:00.000Z";
const T10_AT = "2026-10-02T10:48:00.000Z";
const EVENT = "provider:polymarket:game:1:2026-10-02";

function id(conditionId: string, side = "Under"): ExactMarketIdentity {
  return { physicalEventId: EVENT, conditionId, tokenId: `tok-${conditionId}-${side}`, side };
}
function book(source: ReferenceEvidence["source"], identity: ExactMarketIdentity, bid: number | null, ask: number | null): ReferenceEvidence {
  const t10 = source !== "T30_BOOK";
  return {
    source, identity, observationKey: `${source}:${identity.tokenId}`,
    observationPhase: t10 ? "T_MINUS_10" : "T_MINUS_30", captureComplete: true, fetchStatus: "SUCCESS",
    bestBid: bid, bestAsk: ask, observedAt: t10 ? T10_AT : T30_AT, eventStartIso: START,
  };
}
type Opts = Partial<PolicyCandidateInput["execution"]> & { family?: string; extra?: ReferenceEvidence[]; context?: PolicyCandidateInput["context"] };
function candidate(target: ExactMarketIdentity, t10: [number | null, number | null], t30: [number, number] | null, opts: Opts = {}): PolicyCandidateInput {
  const evidence = [book("T10_BOOK", target, ...t10)];
  if (t30) evidence.push(book("T30_BOOK", target, ...t30));
  return {
    target, family: opts.family ?? "TOTALS", evidence: [...evidence, ...(opts.extra ?? [])],
    execution: {
      askLevels: opts.askLevels ?? null, tickSize: opts.tickSize === undefined ? 0.01 : opts.tickSize,
      takerFeeZeroProven: opts.takerFeeZeroProven ?? false, meaningfulBestBid: opts.meaningfulBestBid ?? null,
    },
    context: opts.context ?? { beforeLatestEntry: true, existingExposure: false },
  };
}
const deepAsks = (price: number) => [{ price, size: 1000 }];

test("1 + 15: UNRESOLVED -> SKIP; real rank-4 0.02/0.51 does not bet because ask <= 0.54", () => {
  const under = id("rank4", "Under");
  const over = { ...under, tokenId: "tok-rank4-Over", side: "Over" };
  const input = candidate(under, [0.02, 0.51], [0.02, 0.52], { extra: [{ ...book("T10_BOOK", over, 0.49, 0.98), source: "BINARY_COMPLEMENT" }], askLevels: deepAsks(0.51), takerFeeZeroProven: true });
  const event = evaluateEventPolicy([input]);
  assert.equal(event.shadowAction, "SKIP");
  assert.equal(event.candidates[0].referenceStatus, "UNRESOLVED");
  assert.equal(event.candidates[0].pBuyMax, null);
  assert.match(event.candidates[0].reason ?? "", /^REFERENCE_UNRESOLVED/);
});

test("2: same-condition mirror cannot create P_BUY_MAX", () => {
  const under = id("c2", "Under");
  const over = { ...under, tokenId: "tok-c2-Over", side: "Over" };
  // Exact T10 is the only usable witness; the mirror's T30 book is offered as a T30 witness.
  const d = evaluatePolicyCandidate(candidate(under, [0.5, 0.52], null, { extra: [book("T30_BOOK", over, 0.48, 0.5)] }));
  assert.equal(d.referenceStatus, "WEAK");
  assert.equal(d.pBuyMax, null);
  assert.equal(d.reason, "PRICE_AUTHORITY_MISSING_NO_ACCEPTED_T30_WITNESS");
});

test("3: Planning sibling price cannot create P_BUY_MAX", () => {
  const target = id("c3");
  const sibling = id("c3-sibling");
  const d = evaluatePolicyCandidate(candidate(target, [0.5, 0.52], null, { extra: [{ ...book("T30_BOOK", sibling, 0.51, 0.52), source: "PLANNING_PRICE" }] }));
  assert.equal(d.pBuyMax, null);
  assert.equal(d.priceAuthoritySource, null);
});

test("4: usable exact T30 witness creates T30_BID_ANCHOR_V1 = T30 best_bid", () => {
  const d = evaluatePolicyCandidate(candidate(id("c4"), [0.5, 0.52], [0.51, 0.53]));
  assert.equal(d.referenceStatus, "STRONG");
  assert.equal(d.priceAuthoritySource, "T30_BOOK_BEST_BID");
  assert.equal(d.pBuyMax, 0.51);
});

test("5: TAKER full-stake cost above P_BUY_MAX is rejected", () => {
  const d = evaluatePolicyCandidate(candidate(id("c5"), [0.51, 0.52], [0.51, 0.52], { askLevels: deepAsks(0.52), takerFeeZeroProven: true }));
  assert.equal(d.taker.eligible, false);
  assert.equal(d.taker.rejectReason, "TAKER_ASK_ABOVE_P_BUY_MAX");
});

test("6: TAKER full-stake cost at/below P_BUY_MAX is eligible; missing ladder or fee is not fabricated", () => {
  const ok = evaluatePolicyCandidate(candidate(id("c6"), [0.5, 0.51], [0.51, 0.52], { askLevels: [{ price: 0.51, size: 3 }, { price: 0.51, size: 100 }], takerFeeZeroProven: true }));
  assert.equal(ok.taker.eligible, true);
  assert.equal(ok.taker.effectiveCost, 0.51);
  assert.equal(ok.taker.priceAdvantage, 0);
  const noLadder = evaluatePolicyCandidate(candidate(id("c6"), [0.5, 0.51], [0.51, 0.52], { takerFeeZeroProven: true }));
  assert.equal(noLadder.taker.rejectReason, "TAKER_FULL_STAKE_ASK_LEVELS_UNAVAILABLE");
  const noFee = evaluatePolicyCandidate(candidate(id("c6"), [0.5, 0.51], [0.51, 0.52], { askLevels: deepAsks(0.51) }));
  assert.equal(noFee.taker.rejectReason, "TAKER_FEE_EVIDENCE_UNAVAILABLE");
  const thin = evaluatePolicyCandidate(candidate(id("c6"), [0.5, 0.51], [0.51, 0.52], { askLevels: [{ price: 0.51, size: 1 }, { price: 0.53, size: 100 }], takerFeeZeroProven: true }));
  assert.equal(thin.taker.rejectReason, "TAKER_INSUFFICIENT_DEPTH_AT_OR_BELOW_P_BUY_MAX");
});

test("7 + 8: WEAK cannot TAKER; WEAK makes MAKER only with an accepted prior T30 authority", () => {
  // Current T10 book too wide (rejected witness), T30 exact witness usable -> WEAK with authority.
  const weakT30 = evaluatePolicyCandidate(candidate(id("c7"), [0.4, 0.52], [0.51, 0.52], { askLevels: deepAsks(0.5), takerFeeZeroProven: true }));
  assert.equal(weakT30.referenceStatus, "WEAK");
  assert.equal(weakT30.taker.eligible, false);
  assert.equal(weakT30.taker.rejectReason, "TAKER_REQUIRES_STRONG_REFERENCE");
  assert.equal(weakT30.maker.eligible, true);
  assert.equal(weakT30.maker.limitPrice, 0.51);
  // WEAK from the current T10 book only -> no prior authority -> no maker.
  const weakT10 = evaluatePolicyCandidate(candidate(id("c8"), [0.5, 0.52], null));
  assert.equal(weakT10.maker.eligible, false);
  assert.equal(weakT10.reason, "PRICE_AUTHORITY_MISSING_NO_ACCEPTED_T30_WITNESS");
});

test("9: maker limit comes from P_BUY_MAX, not bestBid + tick", () => {
  const d = evaluatePolicyCandidate(candidate(id("c9"), [0.49, 0.52], [0.505, 0.515], { tickSize: 0.001 }));
  assert.equal(d.pBuyMax, 0.505);
  assert.equal(d.maker.limitPrice, 0.505);
  assert.notEqual(d.maker.limitPrice, 0.491);
  assert.equal(d.maker.ticksToAsk, 15);
});

test("10: maker limit must be >= a meaningful best bid when that semantics is available", () => {
  const unknown = evaluatePolicyCandidate(candidate(id("c10"), [0.5, 0.52], [0.5, 0.52]));
  assert.equal(unknown.maker.meaningfulBidGuard, "NOT_PROVEN");
  assert.equal(unknown.maker.eligible, true);
  const fail = evaluatePolicyCandidate(candidate(id("c10"), [0.5, 0.52], [0.5, 0.52], { meaningfulBestBid: 0.51 }));
  assert.equal(fail.maker.meaningfulBidGuard, "FAIL");
  assert.equal(fail.maker.rejectReason, "MAKER_LIMIT_BELOW_MEANINGFUL_BEST_BID");
  const pass = evaluatePolicyCandidate(candidate(id("c10"), [0.5, 0.52], [0.5, 0.52], { meaningfulBestBid: 0.5 }));
  assert.equal(pass.maker.meaningfulBidGuard, "PASS");
  assert.equal(pass.maker.eligible, true);
});

test("11: no price above 0.54 — P_BUY_MAX and maker limit are capped, taker above cap rejected", () => {
  // TOTAL_CORNERS band 2.25..2.50 -> ask ~0.40..0.444; use MONEYLINE band with a high T30 bid.
  const d = evaluatePolicyCandidate(candidate(id("c11"), [0.53, 0.54], [0.56, 0.58], { family: "MONEYLINE" }));
  // T30 0.56/0.58 and T10 0.53/0.54 do not overlap -> UNRESOLVED; rebuild with overlap at the cap.
  assert.equal(d.referenceStatus, "UNRESOLVED");
  const capped = evaluatePolicyCandidate(candidate(id("c11b"), [0.53, 0.54], [0.54, 0.56], { family: "MONEYLINE", tickSize: 0.001 }));
  assert.equal(capped.pBuyMax, 0.54);
  assert.ok((capped.maker.limitPrice ?? 0) <= 0.54);
  assert.equal(capped.maker.limitPrice, 0.539);
});

test("12 + 13: one economic action per event; ranking is deterministic regardless of input order", () => {
  const inputs = [
    candidate(id("a"), [0.5, 0.52], [0.5, 0.52]),
    candidate(id("b"), [0.5, 0.53], [0.51, 0.53]),
    candidate(id("c"), [0.5, 0.52], [0.51, 0.52]),
  ];
  const forward = evaluateEventPolicy(inputs);
  const reversed = evaluateEventPolicy([...inputs].reverse());
  assert.equal(forward.shadowAction, "MAKER_FIRST");
  assert.equal(forward.selected?.candidateIdentity.conditionId, reversed.selected?.candidateIdentity.conditionId);
  assert.equal(forward.candidates.filter((c) => c === forward.selected).length, 1);
  // b: pBuyMax 0.51, limit min(0.51, 0.52) = 0.51, cushion 0, 2 ticks; c: limit 0.51, 1 tick -> c wins on fillability.
  assert.equal(forward.selected?.candidateIdentity.conditionId, "c");
  assert.throws(() => evaluateEventPolicy([candidate(id("x"), [0.5, 0.52], [0.5, 0.52]), candidate({ ...id("y"), physicalEventId: "other" }, [0.5, 0.52], [0.5, 0.52])]));
});

test("13b: TAKER wins when safe, and the best MAKER alternative is still reported", () => {
  const event = evaluateEventPolicy([
    candidate(id("m"), [0.5, 0.52], [0.5, 0.52]),
    candidate(id("t"), [0.5, 0.51], [0.51, 0.52], { askLevels: deepAsks(0.51), takerFeeZeroProven: true }),
  ]);
  assert.equal(event.shadowAction, "TAKER_FIRST");
  assert.equal(event.selected?.candidateIdentity.conditionId, "t");
  assert.ok(event.bestMaker);
});

test("14: family priority (SPREADS before TOTALS) does not override the better economic action", () => {
  const event = evaluateEventPolicy([
    candidate(id("spread"), [0.51, 0.53], [0.5, 0.52], { family: "SPREADS" }), // limit 0.50, cushion 0, 3 ticks
    candidate(id("total"), [0.51, 0.52], [0.51, 0.52], { family: "TOTALS", askLevels: deepAsks(0.51), takerFeeZeroProven: true }),
  ]);
  assert.equal(event.selected?.family, "TOTALS");
  const makerOnly = evaluateEventPolicy([
    candidate(id("s2"), [0.5, 0.53], [0.5, 0.52], { family: "SPREADS" }), // limit 0.50, 3 ticks
    candidate(id("t2"), [0.5, 0.51], [0.5, 0.52], { family: "TOTALS" }), // limit 0.50, 1 tick
  ]);
  assert.equal(makerOnly.selected?.family, "TOTALS");
});

test("execution evidence is never fabricated: missing tick blocks MAKER pre-Queue", () => {
  const d = evaluatePolicyCandidate(candidate(id("tick"), [0.5, 0.52], [0.5, 0.52], { tickSize: null }));
  assert.equal(d.maker.eligible, false);
  assert.equal(d.maker.rejectReason, "MAKER_TICK_UNAVAILABLE_PRE_QUEUE");
});
