// T30_MONEY_GATE_REMOVAL_V1 — T10 economic action policy: CURRENT-BOOK execution authority.
// T30 is research telemetry only: it never authorizes, vetoes, prices or ranks a live action.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  compareMaker,
  compareTaker,
  decideEventAction,
  evaluateMakerPlacement,
  evaluateT10EconomicAction,
  PRICE_AUTHORITY_VERSION,
  t30Telemetry,
  walkAskLevels,
  evaluateMakerSupportPrice,
  type PolicyCandidateInput,
  type PolicyEvaluation,
} from "../../lib/executor/t10EconomicActionPolicy";
import { bStrategySupportRegion } from "../../lib/executor/reservationMarketBaseline";
import {
  evaluateExactMarketReference,
  type ExactMarketIdentity,
  type ReferenceEvidence,
} from "../../lib/executor/exactMarketReference";

const START = "2026-10-02T11:00:00.000Z";
const T30_AT = "2026-10-02T10:30:00.000Z";
const T10_AT = "2026-10-02T10:45:00.000Z";
const EVENT = "provider:polymarket:game:1:2026-10-02";
const id = (token: string, side: string, cond = "0xcond"): ExactMarketIdentity =>
  ({ physicalEventId: EVENT, conditionId: cond, tokenId: token, side });

function book(source: "T10_BOOK" | "T30_BOOK", identity: ExactMarketIdentity, bid: number | null, ask: number | null): ReferenceEvidence {
  const t10 = source === "T10_BOOK";
  return { source, identity, observationKey: `${source}:${identity.tokenId}`,
    observationPhase: t10 ? "T_MINUS_10" : "T_MINUS_30", captureComplete: true, fetchStatus: "SUCCESS",
    bestBid: bid, bestAsk: ask, observedAt: t10 ? T10_AT : T30_AT, eventStartIso: START };
}

type Opts = {
  token?: string; side?: string; cond?: string; family?: string;
  /** CURRENT T10 book [bestBid, bestAsk]. The default is a safe TOTALS maker: bid 0.50 / ask 0.52. */
  t10?: [number | null, number | null]; t30?: [number, number] | null;
  tick?: number | null; support?: boolean; extra?: Partial<PolicyCandidateInput["t10"]>;
  t30Override?: ReferenceEvidence | null; observedAtMs?: number;
};
function cand(o: Opts = {}): PolicyCandidateInput {
  const identity = id(o.token ?? "tok-a", o.side ?? "Under", o.cond ?? "0xcond");
  const [b10, a10] = o.t10 ?? [0.5, 0.52];
  const t30 = o.t30 === undefined ? ([0.5, 0.52] as [number, number]) : o.t30;
  const evidence: ReferenceEvidence[] = [book("T10_BOOK", identity, b10, a10)];
  if (t30) evidence.push(book("T30_BOOK", identity, t30[0], t30[1]));
  return {
    identity, family: o.family ?? "TOTALS", supportFamilyEligible: o.support ?? true, takerSupportEligible: o.support ?? true,
    supportBand: bStrategySupportRegion(o.family ?? "TOTALS"),
    reference: evaluateExactMarketReference(identity, evidence),
    t30Evidence: o.t30Override !== undefined ? o.t30Override : t30 ? book("T30_BOOK", identity, t30[0], t30[1]) : null,
    t10: { bestBid: b10, bestAsk: a10, bookFresh: true, observedAtMs: o.observedAtMs ?? Date.parse(T10_AT),
      tickSize: o.tick === undefined ? 0.01 : o.tick, ...o.extra },
    beforeLatestEntry: true, exposureExists: false,
  };
}
const ladder = (price: number, usd = 10) => [{ price, sizeShares: usd / price }];
/** The live decision surface: everything a money decision may depend on (T30 telemetry deliberately excluded). */
const live = (r: PolicyEvaluation) => ({ shadowAction: r.shadowAction, reason: r.reason, taker: r.taker, maker: r.maker,
  support: r.support, priceAuthority: r.priceAuthority });

// ── T30 never gates, prices or ranks a live action ──────────────────────────────────────────────

test("T30-1: missing T30 does NOT block an otherwise-safe TAKER", () => {
  const r = evaluateT10EconomicAction(cand({ t30: null, extra: { askLevels: ladder(0.52), feeUsdForFullStake: 0.01 } }));
  assert.equal(r.t30.available, false);
  assert.equal(r.taker.eligible, true);
  assert.equal(r.taker.rawVwap, 0.52);
  assert.equal(r.taker.effectiveCost, 0.52208); // (2.50 + 0.01) / (2.50 / 0.52) shares
  assert.equal(r.shadowAction, "TAKER_FIRST");
  assert.equal(r.priceAuthority.version, PRICE_AUTHORITY_VERSION);
  assert.equal(r.priceAuthority.source, "T10_CURRENT_BOOK");
  assert.equal(r.priceAuthority.pBuyMax, 0.54, "TAKER price authority is the hard cap, not a T30 bid");
});

test("T30-2: unusable / wide T30 (and an UNRESOLVED reference grade) does NOT block an otherwise-safe TAKER", () => {
  const taker = { askLevels: ladder(0.52), feeUsdForFullStake: 0.01 };
  const wideT30 = evaluateT10EconomicAction(cand({ t30: [0.1, 0.6], extra: taker }));
  assert.equal(wideT30.t30.available, false);
  assert.match(wideT30.t30.reason, /BOOK_SPREAD_ABOVE_SOURCE_QUALITY/);
  assert.equal(wideT30.taker.eligible, true);
  assert.equal(wideT30.shadowAction, "TAKER_FIRST");
  // T10 spread 0.07 AND T30 spread 0.5: no usable witness => reference grade UNRESOLVED, which is telemetry only.
  const unresolved = evaluateT10EconomicAction(cand({ t10: [0.45, 0.52], t30: [0.1, 0.6], extra: taker }));
  assert.equal(unresolved.referenceStatus, "UNRESOLVED");
  assert.equal(unresolved.taker.eligible, true);
  assert.equal(unresolved.shadowAction, "TAKER_FIRST");
});

test("T30-3: missing T30 does NOT block an otherwise-safe MAKER", () => {
  const r = evaluateT10EconomicAction(cand({ t30: null }));
  assert.equal(r.t30.available, false);
  assert.equal(r.maker.eligible, true);
  assert.equal(r.maker.limitPrice, 0.5);
  assert.equal(r.shadowAction, "MAKER_FIRST");
  assert.equal(r.priceAuthority.pBuyMax, 0.5, "MAKER price authority is the current-book maker limit");
});

test("T30-4: unusable / wide T30 does NOT block an otherwise-safe MAKER", () => {
  const wide = evaluateT10EconomicAction(cand({ t30: [0.1, 0.6] }));
  assert.equal(wide.t30.available, false);
  assert.equal(wide.maker.eligible, true);
  assert.equal(wide.shadowAction, "MAKER_FIRST");
  const unresolved = evaluateT10EconomicAction(cand({ t10: [0.5, 0.56], t30: [0.1, 0.6] }));
  assert.equal(unresolved.referenceStatus, "UNRESOLVED");
  assert.equal(unresolved.maker.limitPrice, 0.5);
  assert.equal(unresolved.shadowAction, "MAKER_FIRST");
});

test("T30-5: changing ONLY T30 while the current evidence is identical never changes the live action", () => {
  const identity = id("tok-a", "Under");
  const sibling = id("tok-x", "Over", "0xother");
  const t30Variants: Array<Pick<Opts, "t30" | "t30Override">> = [
    { t30: null }, { t30: [0.5, 0.52] }, { t30: [0.2, 0.22] }, { t30: [0.56, 0.58] }, { t30: [0.1, 0.6] },
    { t30: null, t30Override: book("T30_BOOK", sibling, 0.5, 0.52) },                                   // other market
    { t30: null, t30Override: book("T30_BOOK", id("tok-over", "Over"), 0.5, 0.52) },                      // binary mirror
    { t30: null, t30Override: { ...book("T30_BOOK", sibling, 0.5, 0.52), source: "PLANNING_PRICE" } },    // planning price
    { t30: null, t30Override: { ...book("T30_BOOK", identity, 0.5, 0.52), observationPhase: "T_MINUS_10" } },
  ];
  for (const current of [
    { t10: [0.5, 0.52] as [number, number], extra: undefined },                                          // MAKER
    { t10: [0.5, 0.52] as [number, number], extra: { askLevels: ladder(0.52), feeUsdForFullStake: 0.01 } }, // TAKER
    { t10: [0.05, 0.5] as [number, number], extra: undefined, family: "SPREADS" },                        // SKIP
  ]) {
    const baseline = live(evaluateT10EconomicAction(cand({ ...current, t30: null })));
    for (const v of t30Variants) assert.deepEqual(live(evaluateT10EconomicAction(cand({ ...current, ...v }))), baseline);
  }
  // Event level: identical current evidence, wildly different T30 per sibling => identical ranking, order independent.
  const a = (t30: [number, number] | null) => cand({ token: "tok-a", cond: "0xa", t10: [0.52, 0.53], t30 });
  const b = (t30: [number, number] | null) => cand({ token: "tok-b", cond: "0xb", t10: [0.5, 0.55], t30 });
  const winners = [[null, null], [[0.5, 0.52], [0.54, 0.56]], [[0.2, 0.9], [0.52, 0.53]]] as const;
  for (const [ta, tb] of winners) {
    const d = decideEventAction([b(tb as [number, number] | null), a(ta as [number, number] | null)]);
    assert.equal(d.selected?.candidateIdentity.tokenId, "tok-a", "fewer ticks to the current ask wins regardless of T30");
    assert.equal(d.action, "MAKER_FIRST");
  }
});

test("T30-6: T30 survives only as telemetry (LIVE_AUTHORITY=false) and the source has no T30 gate/price/rank path", () => {
  const identity = id("tok-a", "Under");
  const t = evaluateT10EconomicAction(cand({ t30: [0.5, 0.52] })).t30;
  assert.deepEqual([t.LIVE_AUTHORITY, t.available, t.observationKey, t.bestBid], [false, true, "T30_BOOK:tok-a", 0.5]);
  assert.equal(t30Telemetry(identity, null).reason, "NO_T30_EXACT_WITNESS");
  assert.equal(t30Telemetry(identity, book("T10_BOOK", identity, 0.5, 0.52)).reason, "SOURCE_NOT_T30_BOOK");
  assert.match(t30Telemetry(identity, { ...book("T30_BOOK", identity, 0.5, 0.52), observationPhase: "T_MINUS_10" }).reason, /PHASE_LABEL_MISMATCH/);
  assert.equal(t30Telemetry(identity, book("T30_BOOK", id("tok-over", "Over"), 0.5, 0.52)).available, false, "binary mirror");
  const src = fs.readFileSync(new URL("../../lib/executor/t10EconomicActionPolicy.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
  assert.doesNotMatch(src, /PRICE_AUTHORITY_UNAVAILABLE|REFERENCE_UNRESOLVED|TAKER_REQUIRES_STRONG|T30_EXACT_BID_ANCHOR|EFFECTIVE_COST_ABOVE_ANCHOR|MAKER_ABOVE_ANCHOR/);
  // t30Evidence is read in exactly one place: the telemetry call.
  assert.equal(src.match(/input\.t30Evidence/g)?.length, 1);
  assert.match(src, /t30: t30Telemetry\(input\.identity, input\.t30Evidence\)/);
});

// ── TAKER = current execution authority ─────────────────────────────────────────────────────────

test("TAKER-1: effective cost within the hard cap -> eligible, fee is part of the cost", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.5, 0.52], t30: null, extra: { askLevels: ladder(0.5), feeUsdForFullStake: 0.01 } }));
  assert.equal(r.taker.eligible, true);
  assert.equal(r.taker.rawVwap, 0.5);
  assert.equal(r.taker.effectiveCost, 0.502); // (2.50 + 0.01) / 5 shares
  assert.equal(r.shadowAction, "TAKER_FIRST");
});

test("TAKER-2: fee-inclusive cost above the hard cap -> no TAKER (hard cap fails closed)", () => {
  // raw VWAP 0.54 is within the cap and the band, but 0.54 + fee 0.05 / 4.63 sh = 0.5508 > 0.54.
  const r = evaluateT10EconomicAction(cand({ t10: [0.52, 0.54], extra: { askLevels: ladder(0.54), feeUsdForFullStake: 0.05 } }));
  assert.equal(r.taker.rawVwap, 0.54);
  assert.equal(r.taker.eligible, false);
  assert.equal(r.taker.rejectReason, "TAKER_EFFECTIVE_COST_ABOVE_CAP");
  // A custom (tighter) cap is honoured the same way.
  const tight = evaluateT10EconomicAction({ ...cand({ t10: [0.5, 0.52], extra: { askLevels: ladder(0.52), feeUsdForFullStake: 0 } }), hardCap: 0.51 });
  assert.equal(tight.taker.eligible, false);
  assert.equal(tight.taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT", "no level at or below the cap");
});

test("TAKER-3: depth, ladder and fee evidence are required - never approximated from bestAsk", () => {
  const none = evaluateT10EconomicAction(cand({ t30: null, t10: [0.5, 0.52] }));
  assert.equal(none.taker.rejectReason, "TAKER_EXECUTION_EVIDENCE_MISSING");
  const noFee = evaluateT10EconomicAction(cand({ t30: null, t10: [0.5, 0.52], extra: { askLevels: ladder(0.5) } }));
  assert.equal(noFee.taker.feeEvidence, "MISSING");
  assert.equal(noFee.taker.rejectReason, "TAKER_FEE_EVIDENCE_MISSING");
  const thin = evaluateT10EconomicAction(cand({ t30: null, t10: [0.5, 0.52], extra: { askLevels: ladder(0.5, 1), feeUsdForFullStake: 0 } }));
  assert.equal(thin.taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT");
  assert.equal(thin.taker.eligible, false);
  const aboveCap = evaluateT10EconomicAction(cand({ t30: null, t10: [0.5, 0.52], extra: { askLevels: ladder(0.56, 100), feeUsdForFullStake: 0 } }));
  assert.equal(aboveCap.taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT", "depth above the 0.54 cap does not count");
  const walk = walkAskLevels([{ price: 0.5, sizeShares: 2 }, { price: 0.52, sizeShares: 10 }, { price: 0.6, sizeShares: 100 }], 2.5, 0.54);
  assert.equal(walk.filled, true);
  assert.equal(walk.rawVwap, 0.511811); // $1.00 @0.50 + $1.50 @0.52; the 0.60 level is above the cap and never touched
});

test("TAKER-4: the current ask AND the executed VWAP must each lie inside the family band", () => {
  const outsideAsk = evaluateT10EconomicAction(cand({ t10: [0.6, 0.62], extra: { askLevels: ladder(0.62), feeUsdForFullStake: 0 } }));
  assert.equal(outsideAsk.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(outsideAsk.support.taker.SUPPORT_PRICE_IN_BAND, false);
  // Ask 0.52 is in the band, but the ladder that would actually be paid sits at 0.45 (odds 2.22): final re-proof fails.
  const outsideVwap = evaluateT10EconomicAction(cand({ t10: [0.5, 0.52], extra: { askLevels: ladder(0.45), feeUsdForFullStake: 0 } }));
  assert.equal(outsideVwap.taker.eligible, false);
  assert.equal(outsideVwap.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(outsideVwap.support.taker.SUPPORT_PRICE, 0.45);
  assert.equal(outsideVwap.support.taker.SUPPORT_PRICE_IN_BAND, false);
  assert.equal(outsideVwap.shadowAction, "MAKER_FIRST", "the maker (limit 0.50) is judged on its own price");
});

// ── MAKER = current book authority ──────────────────────────────────────────────────────────────

test("MAKER-A: TOTALS bid 0.54 / ask 0.69 / tick 0.01 -> maker limit 0.54, support PASS (the real Sri Lanka - Mauritius pattern)", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.54, 0.69], t30: null }));
  assert.equal(r.maker.eligible, true);
  assert.equal(r.maker.limitPrice, 0.54);
  assert.equal(r.maker.ticksToAsk, 15);
  assert.equal(r.support.maker.SUPPORT_PRICE, 0.54);
  assert.ok(Math.abs(r.support.maker.SUPPORT_DECIMAL_ODDS! - 1.851852) < 1e-6);
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, true);
  assert.equal(r.support.SUPPORT_BAND_MIN, 1.85);
  assert.equal(r.shadowAction, "MAKER_FIRST");
  assert.equal(r.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND", "ask 0.69 is never bought");
  // A wide T30 (or any T30) changes nothing.
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.54, 0.69], t30: [0.1, 0.6] })).maker.limitPrice, 0.54);
});

test("MAKER-B: SPREADS bid 0.05 / ask 0.50 / tick 0.01 -> maker limit 0.05 fails the support band -> SKIP", () => {
  const r = evaluateT10EconomicAction(cand({ family: "SPREADS", t10: [0.05, 0.5], t30: null }));
  assert.equal(r.maker.eligible, false);
  assert.equal(r.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(r.support.maker.SUPPORT_PRICE, 0.05, "the empty/wide spread is NOT jumped with ask - tick (0.49)");
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, false);
  assert.equal(r.shadowAction, "SKIP", "removing T30 does not make this trade executable");
  assert.equal(decideEventAction([cand({ family: "SPREADS", t10: [0.05, 0.5], t30: null })]).action, "SKIP");
});

test("MAKER-1: the limit is the CURRENT best bid - never bid + tick, never ask - tick alone", () => {
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.5, 0.53] })).maker.limitPrice, 0.5);   // bid + tick 0.51, ask - tick 0.52
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.51, 0.55] })).maker.limitPrice, 0.51);
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.5, 0.52], tick: 0.001 })).maker.limitPrice, 0.5);
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.5075, 0.55], tick: 0.01 })).maker.limitPrice, 0.5, "floored to a valid tick");
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.52, 0.53] })).maker.limitPrice, 0.52);
  assert.equal(evaluateT10EconomicAction(cand({ t10: [0.53, 0.54] })).maker.limitPrice, 0.53, "ask - tick binds when the book is tight");
});

test("MAKER-2: the maker limit is passive, inside the band and never above the hard cap", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.5, 0.51] }));
  assert.equal(r.maker.limitPrice, 0.5);
  assert.ok((r.maker.limitPrice as number) < 0.51);
  assert.equal(r.maker.ticksToAsk, 1);
  // bid 0.49 (odds 2.04) is outside the 1.85..2.00 band: maker support is proven on the limit.
  const outside = evaluateT10EconomicAction(cand({ t10: [0.49, 0.5] }));
  assert.equal(outside.maker.eligible, false);
  assert.equal(outside.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  // Hard cap: bid 0.58 -> limit 0.54, never higher; a tighter cap binds the same way.
  const capped = evaluateT10EconomicAction(cand({ t10: [0.58, 0.6] }));
  assert.equal(capped.maker.limitPrice, 0.54);
  assert.equal(evaluateT10EconomicAction({ ...cand({ t10: [0.58, 0.6] }), hardCap: 0.52 }).maker.limitPrice, 0.52);
  assert.deepEqual(evaluateMakerSupportPrice(0.55, 0.6, 0.54, bStrategySupportRegion("MONEYLINE")), { ok: false, reason: "MAKER_ABOVE_PRICE_CAP" });
});

test("MAKER-3: missing / unusable tick blocks MAKER - the tick is never invented", () => {
  for (const tick of [null, 0, -0.01, 1, 2, Number.NaN]) {
    const r = evaluateT10EconomicAction(cand({ tick }));
    assert.equal(r.maker.eligible, false, `tick ${tick}`);
    assert.equal(r.maker.rejectReason, "TICK_UNKNOWN");
  }
  assert.equal(evaluateT10EconomicAction(cand({ tick: undefined as never })).maker.eligible, true, "default fixture tick 0.01");
});

test("MAKER-4: missing / non-positive best bid blocks MAKER - the bid is never invented", () => {
  for (const bid of [null, 0, -0.1]) {
    const r = evaluateT10EconomicAction(cand({ t10: [bid, 0.52] }));
    assert.equal(r.maker.eligible, false, `bid ${bid}`);
    assert.equal(r.maker.rejectReason, "MAKER_BEST_BID_MISSING");
    assert.equal(r.shadowAction, "SKIP");
  }
});

test("MAKER-5: a maker limit >= the ask is impossible - crossed / locked / no-room books fail closed", () => {
  for (const [bid, ask] of [[0.52, 0.52], [0.55, 0.52]] as const) {
    const r = evaluateT10EconomicAction(cand({ t10: [bid, ask] }));
    assert.equal(r.maker.rejectReason, "MAKER_BOOK_CROSSED");
    assert.equal(r.maker.eligible, false);
  }
  const noRoom = evaluateT10EconomicAction(cand({ t10: [0.005, 0.01] }));
  assert.equal(noRoom.maker.eligible, false);
  assert.equal(noRoom.maker.rejectReason, "MAKER_LIMIT_NOT_POSITIVE");
  // Exhaustive grid: whenever a limit exists it is on-tick, passive, <= bid and <= cap.
  let valid = 0;
  for (const tick of [0.001, 0.01]) for (let bidK = 1; bidK <= 99; bidK++) for (let askK = 1; askK <= 100; askK++) {
    const bid = Math.round(bidK * 0.01 * 1e6) / 1e6, ask = Math.round(askK * 0.01 * 1e6) / 1e6;
    const p = evaluateMakerPlacement(bid, ask, tick, 0.54);
    if (p.limit === null) { assert.ok(p.reason); continue; }
    valid++;
    assert.ok(p.limit < ask - 1e-9 && p.limit <= bid + 1e-9 && p.limit <= 0.54 + 1e-9 && p.limit > 0, `${bid}/${ask}/${tick} -> ${p.limit}`);
    assert.ok(Math.abs(p.limit / tick - Math.round(p.limit / tick)) < 1e-6);
  }
  assert.ok(valid > 1000);
});

test("MAKER-6: meaningful-best-bid guard only when authoritative; otherwise NOT_PROVEN", () => {
  const unproven = evaluateT10EconomicAction(cand({ t10: [0.52, 0.55] }));
  assert.equal(unproven.maker.meaningfulBidGuard, "NOT_PROVEN");
  assert.equal(unproven.maker.eligible, true);
  const below = evaluateT10EconomicAction(cand({ t10: [0.52, 0.55], extra: { meaningfulBestBid: 0.53 } }));
  assert.equal(below.maker.rejectReason, "MAKER_BELOW_MEANINGFUL_BID");
  const ok = evaluateT10EconomicAction(cand({ t10: [0.52, 0.55], extra: { meaningfulBestBid: 0.52 } }));
  assert.equal(ok.maker.eligible, true);
  assert.equal(ok.maker.meaningfulBidGuard, "PASSED");
});

// ── ranking: CURRENT evidence only ──────────────────────────────────────────────────────────────

test("RANK-1: TAKER ranking = lower current fee-inclusive cost, then depth, freshness, identity - never T30", () => {
  const take = (token: string, ask: number, fee: number, o: Opts = {}) =>
    cand({ token, cond: `0x${token}`, t10: [ask - 0.02, ask], extra: { askLevels: ladder(ask, 100), feeUsdForFullStake: fee }, ...o });
  const cheap = take("tok-cheap", 0.5, 0.0625, { t30: null });                // effective 0.5125
  const dear = take("tok-dear", 0.52, 0.06, { t30: [0.54, 0.56] });             // effective 0.5325, "great" T30
  for (const order of [[cheap, dear], [dear, cheap]]) {
    const d = decideEventAction(order);
    assert.equal(d.action, "TAKER_FIRST");
    assert.equal(d.selected?.candidateIdentity.tokenId, "tok-cheap");
  }
  // Flipping T30 between the two siblings does not flip the winner.
  const swapped = decideEventAction([take("tok-cheap", 0.5, 0.0625, { t30: [0.2, 0.9] }), take("tok-dear", 0.52, 0.06, { t30: [0.5, 0.52] })]);
  assert.equal(swapped.selected?.candidateIdentity.tokenId, "tok-cheap");
  // Equal cost -> deeper full-stake depth -> fresher book -> identity.
  const x = (token: string, depthUsd: number, observedAtMs: number) =>
    ({ input: cand({ token, cond: `0x${token}`, observedAtMs }), evaluation: { ...evaluateT10EconomicAction(take(token, 0.5, 0.0625)), taker: { ...evaluateT10EconomicAction(take(token, 0.5, 0.0625)).taker, depthUsd } } });
  assert.ok(compareTaker(x("b", 900, 1), x("a", 800, 1)) < 0, "deeper depth first");
  assert.ok(compareTaker(x("b", 800, 2), x("a", 800, 1)) < 0, "fresher first");
  assert.ok(compareTaker(x("a", 800, 1), x("b", 800, 1)) < 0, "identity last");
});

test("RANK-2: MAKER ranking = fewer ticks to the current ask, depth, freshness, identity - never STRONG/WEAK, cushion or witnesses", () => {
  // m-far: STRONG (two agreeing witnesses) but 3 ticks from the ask. m-near: WEAK (no T30) but 1 tick from the ask.
  const far = cand({ token: "m-far", cond: "0xfar", t10: [0.5, 0.53], t30: [0.5, 0.52] });
  const near = cand({ token: "m-near", cond: "0xnear", t10: [0.52, 0.53], t30: null });
  assert.equal(far.reference.status, "STRONG");
  assert.equal(near.reference.status, "WEAK");
  for (const order of [[far, near], [near, far]]) {
    const d = decideEventAction(order);
    assert.equal(d.action, "MAKER_FIRST");
    assert.equal(d.selected?.candidateIdentity.tokenId, "m-near");
  }
  // A stronger T30 anchor cushion is irrelevant: only the current placement counts.
  const cushion = cand({ token: "m-cushion", cond: "0xcushion", t10: [0.5, 0.53], t30: [0.54, 0.56] });
  assert.equal(decideEventAction([cushion, near]).selected?.candidateIdentity.tokenId, "m-near");
  // Equal ticks -> current depth -> freshness -> identity.
  const m = (token: string, depth: number | null, observedAtMs: number) => ({ input: cand({ token, cond: `0x${token}`, observedAtMs, extra: { askDepthUsd: depth } }),
    evaluation: evaluateT10EconomicAction(cand({ token, cond: `0x${token}`, t10: [0.52, 0.53] })) });
  assert.ok(compareMaker(m("b", 500, 1), m("a", 100, 1)) < 0, "deeper first");
  assert.ok(compareMaker(m("b", 100, 2), m("a", 100, 1)) < 0, "fresher first");
  assert.ok(compareMaker(m("a", 100, 1), m("b", 100, 1)) < 0, "identity last");
  assert.ok(compareMaker(m("a", null, 1), m("b", 100, 1)) > 0, "null depth sorts last, never NaN");
});

test("RANK-3: deterministic multi-sibling ranking, order independent; b vs c tie falls to identity", () => {
  const a = cand({ token: "tok-a", cond: "0xa", t10: [0.52, 0.53], t30: [0.52, 0.53] });
  const b = cand({ token: "tok-b", cond: "0xb", t10: [0.5, 0.55], t30: [0.5, 0.52] });
  const c = cand({ token: "tok-c", cond: "0xc", t10: [0.5, 0.55], t30: [0.5, 0.52] });
  assert.equal(decideEventAction([a, b, c]).selected?.candidateIdentity.tokenId, "tok-a");
  assert.equal(decideEventAction([c, b, a]).selected?.candidateIdentity.tokenId, "tok-a");
  assert.equal(decideEventAction([c, b]).selected?.candidateIdentity.tokenId, "tok-b");
});

test("RANK-4: family priority cannot override a better economic action", () => {
  const spreads = cand({ token: "tok-s", cond: "0xs", family: "SPREADS", t10: [0.5, 0.56] });
  const totals = cand({ token: "tok-t", cond: "0xt", family: "TOTALS", t10: [0.52, 0.53] });
  // TOTALS sits 1 tick from the ask (limit 0.52); SPREADS is higher in the old priority but 6 ticks away.
  assert.equal(decideEventAction([spreads, totals]).selected?.candidateIdentity.family, "TOTALS");
});

// ── TAKER-first, one exposure per physical event ────────────────────────────────────────────────

test("FIRST-1: SAFE_TAKER beats any Maker (TAKER_FIRST outranks MAKER_FIRST) and the best Maker alternative is retained", () => {
  const taker = cand({ token: "tok-t", cond: "0xt", t10: [0.5, 0.52], t30: null, extra: { askLevels: ladder(0.5), feeUsdForFullStake: 0 } });
  // The maker sits 1 tick from the ask (limit 0.52) - closer than the taker's own maker leg - yet cannot outrank a safe taker.
  const maker = cand({ token: "tok-m", cond: "0xm", t10: [0.52, 0.53] });
  for (const order of [[maker, taker], [taker, maker]]) {
    const d = decideEventAction(order);
    assert.equal(d.action, "TAKER_FIRST");
    assert.equal(d.selected?.candidateIdentity.tokenId, "tok-t");
    assert.equal(d.selected?.reason, "BEST_SAFE_TAKER");
    assert.ok(d.bestMakerAlternative);
  }
  // No safe taker -> best safe maker; nothing safe -> SKIP.
  assert.equal(decideEventAction([maker]).action, "MAKER_FIRST");
  assert.equal(decideEventAction([cand({ family: "SPREADS", t10: [0.05, 0.5] })]).action, "SKIP");
});

test("FIRST-2: exactly one final action per physical event; mixed events are refused", () => {
  const d = decideEventAction([cand({ token: "a", cond: "0xa" }), cand({ token: "b", cond: "0xb" })]);
  assert.ok(["TAKER_FIRST", "MAKER_FIRST", "SKIP"].includes(d.action));
  assert.equal(d.selected === null, d.action === "SKIP");
  const other = cand({ token: "z", cond: "0xz" });
  other.identity = { ...other.identity, physicalEventId: "another-event" };
  assert.throws(() => decideEventAction([cand(), other]), /MULTIPLE_PHYSICAL_EVENTS/);
});

test("GUARD-1: exposure, deadline, family and book freshness gates are unchanged", () => {
  assert.equal(evaluateT10EconomicAction({ ...cand(), exposureExists: true }).shadowAction, "SKIP");
  assert.equal(evaluateT10EconomicAction({ ...cand(), exposureExists: true }).reason, "EXPOSURE_EXISTS");
  assert.equal(evaluateT10EconomicAction({ ...cand(), beforeLatestEntry: false }).reason, "AFTER_LATEST_ENTRY");
  assert.equal(evaluateT10EconomicAction({ ...cand(), supportFamilyEligible: false }).reason, "NOT_SUPPORT_ELIGIBLE");
  const stale = cand(); stale.t10.bookFresh = false;
  assert.equal(evaluateT10EconomicAction(stale).reason, "T10_BOOK_NOT_FRESH");
  const noAsk = cand({ t10: [0.5, null] });
  assert.equal(evaluateT10EconomicAction(noAsk).reason, "T10_BOOK_NOT_FRESH");
});

test("GUARD-2: exposure or late entry on ANY sibling blocks the whole physical event (max one exposure)", () => {
  const ok = cand({ token: "a", cond: "0xa" });
  const exposed = { ...cand({ token: "b", cond: "0xb" }), exposureExists: true };
  assert.equal(decideEventAction([ok, exposed]).action, "SKIP");
  assert.equal(decideEventAction([ok, exposed]).reason, "EVENT_EXPOSURE_EXISTS");
  const late = { ...cand({ token: "c", cond: "0xc" }), beforeLatestEntry: false };
  assert.equal(decideEventAction([ok, late]).reason, "EVENT_AFTER_LATEST_ENTRY");
  assert.equal(decideEventAction([ok]).action, "MAKER_FIRST");
});

test("GUARD-3: rank-4 evidence (Under 0.02/0.51, Over mirror 0.49/0.98): the bid-less side is never a MAKER; a TAKER needs real ask depth + fee", () => {
  const under = id("tok-under", "Under");
  const t10 = book("T10_BOOK", under, 0.02, 0.51);
  const t30 = book("T30_BOOK", under, 0.02, 0.52);
  const mirror: ReferenceEvidence = { ...book("T10_BOOK", id("tok-over", "Over"), 0.49, 0.98), source: "BINARY_COMPLEMENT" };
  const reference = evaluateExactMarketReference(under, [t10, t30, mirror]);
  const input: PolicyCandidateInput = {
    identity: under, family: "TOTALS", supportFamilyEligible: true, takerSupportEligible: true,
    supportBand: bStrategySupportRegion("TOTALS"), reference, t30Evidence: t30,
    t10: { bestBid: 0.02, bestAsk: 0.51, bookFresh: true, observedAtMs: Date.parse(T10_AT), tickSize: 0.01 },
    beforeLatestEntry: true, exposureExists: false,
  };
  const noEvidence = evaluateT10EconomicAction(input);
  assert.equal(noEvidence.referenceStatus, "UNRESOLVED", "telemetry only");
  assert.equal(noEvidence.maker.limitPrice, null);
  assert.equal(noEvidence.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(noEvidence.support.maker.SUPPORT_PRICE, 0.02, "never jumps the empty bid to ask - tick");
  assert.equal(noEvidence.shadowAction, "SKIP");
  assert.equal(decideEventAction([input]).action, "SKIP");
  // With full-stake ladder + fee evidence the current executable ask (0.51, in band) is an honest TAKER.
  const withEvidence = { ...input, t10: { ...input.t10, askLevels: ladder(0.51), feeUsdForFullStake: 0 } };
  assert.equal(evaluateT10EconomicAction(withEvidence).maker.eligible, false);
  assert.equal(evaluateT10EconomicAction(withEvidence).taker.eligible, true);
});

test("GUARD-4: no arbitrary fill probability and no T30 anchor anywhere in the evaluation shape", () => {
  const src = fs.readFileSync(new URL("../../lib/executor/t10EconomicActionPolicy.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(src, /\bphi\b|fillProb|pFill|p_fill|fill_probability|probabilityOfFill|Math\.random/i);
  const r = evaluateT10EconomicAction(cand());
  assert.deepEqual(Object.keys(r.maker).sort(), ["cushionVsAnchor", "eligible", "limitPrice", "meaningfulBidGuard", "rejectReason", "ticksToAsk"]);
  assert.equal(r.maker.cushionVsAnchor, null, "deprecated, always null");
  assert.equal(r.taker.priceAdvantageVsAnchor, null, "deprecated, always null");
  assert.deepEqual(Object.keys(r.priceAuthority).sort(), ["available", "pBuyMax", "reason", "source", "version"]);
});

// ── MONEYLINE_SUPPORT_AND_MAKER_PRICE_AUTHORITY_FIX_V1 (support bands unchanged) ─────────────────
// ML(): MONEYLINE candidate whose CURRENT ASK may sit outside the support band (ask odds are decided by the caller).
const ml = (o: Opts & { takerSupport?: boolean } = {}): PolicyCandidateInput =>
  ({ ...cand({ family: "MONEYLINE", ...o }), takerSupportEligible: o.takerSupport ?? true });

test("ML-1: canonical MONEYLINE band is 1.70..2.00; SPREADS/TOTALS/TOTAL_CORNERS unchanged", () => {
  assert.deepEqual(bStrategySupportRegion("MONEYLINE"), { min: 1.7, max: 2 });
  assert.deepEqual(bStrategySupportRegion("SPREADS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTALS"), { min: 1.85, max: 2 });
  assert.deepEqual(bStrategySupportRegion("TOTAL_CORNERS"), { min: 2.25, max: 2.5 });
});

test("ML-2: maker support boundaries: odds 1.70 and 2.00 accepted; 1.69 and >2.00 rejected", () => {
  const band = bStrategySupportRegion("MONEYLINE");
  assert.equal(evaluateMakerSupportPrice(0.5, 0.54, 0.54, band).ok, true, "odds 2.00 boundary");
  assert.equal(evaluateMakerSupportPrice(1 / 1.7, 1, 1, band).ok, true, "odds 1.70 boundary");
  const below = evaluateMakerSupportPrice(1 / 1.69, 1, 1, band);
  assert.deepEqual(below, { ok: false, reason: "MAKER_SUPPORT_PRICE_OUTSIDE_BAND" });
  const above = evaluateMakerSupportPrice(0.49, 0.54, 0.54, band);
  assert.deepEqual(above, { ok: false, reason: "MAKER_SUPPORT_PRICE_OUTSIDE_BAND" });
  assert.equal(evaluateMakerSupportPrice(0.5, 0.54, 0.54, null).ok, false, "unsupported family fails closed");
});

test("ML-3: maker limit above the price ceiling or above 0.54 fails closed", () => {
  const band = bStrategySupportRegion("MONEYLINE");
  assert.deepEqual(evaluateMakerSupportPrice(0.55, 0.54, 0.6, band), { ok: false, reason: "MAKER_ABOVE_P_BUY_MAX" });
  assert.deepEqual(evaluateMakerSupportPrice(0.55, 0.60, 0.54, band), { ok: false, reason: "MAKER_ABOVE_PRICE_CAP" });
  assert.equal(evaluateMakerSupportPrice(0.54, 0.54, 0.54, band).ok, true);
});

test("ML-4 LIVE BUG: MONEYLINE bid 0.56 / ask 0.57 -> TAKER never pays 0.57 (no depth <= cap), MAKER posts 0.54 in band", () => {
  const r = evaluateT10EconomicAction(ml({ t10: [0.56, 0.57], t30: null,
    extra: { askLevels: [], feeUsdForFullStake: 0.01 } }));
  assert.equal(r.taker.eligible, false, "never buy 0.57");
  assert.equal(r.maker.eligible, true);
  assert.equal(r.maker.limitPrice, 0.54);
  assert.equal(r.priceAuthority.pBuyMax, 0.54);
  assert.equal(r.shadowAction, "MAKER_FIRST");
  assert.equal(r.support.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(r.support.maker.SUPPORT_PRICE, 0.54);
  assert.ok(Math.abs(r.support.maker.SUPPORT_DECIMAL_ODDS! - 1.851852) < 1e-5);
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, true);
  assert.equal(r.support.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(r.support.taker.SUPPORT_PRICE, 0.57);
  assert.equal(r.support.SUPPORT_BAND_MIN, 1.7);
  assert.equal(r.support.SUPPORT_BAND_MAX, 2);
  // Ask 0.57 with levels above the cap only: full-stake depth at <= 0.54 does not exist.
  const above = evaluateT10EconomicAction(ml({ t10: [0.56, 0.57], extra: { askLevels: ladder(0.57, 100), feeUsdForFullStake: 0.01 } }));
  assert.equal(above.taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT");
});

test("ML-5: MONEYLINE boundaries on the current book: maker limit odds 1.70/2.00 accepted, outside rejected", () => {
  // Ask 0.40 (odds 2.5): taker support fails; bid 0.35 -> maker limit 0.35 also outside.
  const r = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.35, 0.4], t30: null }));
  assert.equal(r.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(r.maker.eligible, false);
  assert.equal(r.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, false);
  // Bid 0.48 (odds 2.08) under ask 0.57 -> limit 0.48 outside the band -> SKIP.
  const low = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.48, 0.57], t30: [0.48, 0.5] }));
  assert.equal(low.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(low.shadowAction, "SKIP");
  // Bid 0.50 (odds 2.00) is the band edge and is accepted.
  assert.equal(evaluateT10EconomicAction(ml({ t10: [0.5, 0.57] })).maker.limitPrice, 0.5);
});

test("ML-6: maker support is NOT judged from the current ask (ask odds 1.754, limit odds 1.852)", () => {
  const withAskBand = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.56, 0.57], t30: null }));
  assert.equal(withAskBand.maker.eligible, true);
  assert.equal(withAskBand.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
});

test("ML-7: unsupported family still SKIPs for both actions", () => {
  const r = evaluateT10EconomicAction({ ...ml(), supportFamilyEligible: false });
  assert.equal(r.reason, "NOT_SUPPORT_ELIGIBLE");
  assert.equal(r.maker.eligible, false);
  assert.equal(r.taker.eligible, false);
});

test("ML-8: TAKER final re-proof: executed VWAP odds must lie inside the MONEYLINE band", () => {
  // Ask band flag true from caller, but the executed price (0.45 => odds 2.22) is outside 1.70..2.00.
  const r = evaluateT10EconomicAction(ml({ t10: [0.44, 0.45],
    extra: { askLevels: ladder(0.45), feeUsdForFullStake: 0 } }));
  assert.equal(r.taker.eligible, false);
});

test("ML-9: MONEYLINE 1.70..2.00 behaviour is unchanged for TAKER and MAKER (0.58 taker edge, 0.50 maker edge)", () => {
  // Cap 0.54 binds before the 1.70 edge (price 0.588): a taker at 0.54 is inside the band and the cap.
  const taker = evaluateT10EconomicAction(ml({ t10: [0.52, 0.54], t30: null, extra: { askLevels: ladder(0.54, 100), feeUsdForFullStake: 0 } }));
  assert.equal(taker.taker.eligible, true);
  assert.equal(taker.support.SUPPORT_BAND_MIN, 1.7);
  assert.equal(taker.support.taker.SUPPORT_PRICE_IN_BAND, true);
  // Ask 0.6 (odds 1.667) is outside 1.70..2.00.
  assert.equal(evaluateT10EconomicAction(ml({ t10: [0.58, 0.6], extra: { askLevels: ladder(0.6, 100), feeUsdForFullStake: 0 } })).taker.rejectReason,
    "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
});
