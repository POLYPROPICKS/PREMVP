import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideEventAction,
  evaluateT10EconomicAction,
  PRICE_AUTHORITY_VERSION,
  walkAskLevels,
  evaluateMakerSupportPrice,
  type PolicyCandidateInput,
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
  t10?: [number | null, number | null]; t30?: [number, number] | null;
  tick?: number | null; support?: boolean; extra?: Partial<PolicyCandidateInput["t10"]>;
  t30Override?: ReferenceEvidence | null; observedAtMs?: number;
};
function cand(o: Opts = {}): PolicyCandidateInput {
  const identity = id(o.token ?? "tok-a", o.side ?? "Under", o.cond ?? "0xcond");
  const [b10, a10] = o.t10 ?? [0.49, 0.51];
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

test("1: UNRESOLVED -> SKIP, no price", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.02, 0.51], t30: [0.02, 0.52] }));
  assert.equal(r.referenceStatus, "UNRESOLVED");
  assert.equal(r.shadowAction, "SKIP");
  assert.equal(r.priceAuthority.pBuyMax, null);
});

test("2: binary mirror cannot create P_BUY_MAX", () => {
  const mirror = book("T30_BOOK", id("tok-over", "Over"), 0.5, 0.52);
  const r = evaluateT10EconomicAction(cand({ t30: null, t30Override: mirror }));
  assert.equal(r.priceAuthority.available, false);
  assert.equal(r.priceAuthority.pBuyMax, null);
  assert.equal(r.shadowAction, "SKIP");
});

test("3: planning price from another sibling cannot create P_BUY_MAX", () => {
  const sibling = id("tok-x", "Over", "0xother");
  const planning: ReferenceEvidence = { ...book("T30_BOOK", sibling, 0.5, 0.52), source: "PLANNING_PRICE" };
  assert.equal(evaluateT10EconomicAction(cand({ t30: null, t30Override: planning })).priceAuthority.available, false);
  // A real T30 book of another condition is also not authority for this token.
  assert.equal(evaluateT10EconomicAction(cand({ t30: null, t30Override: book("T30_BOOK", sibling, 0.5, 0.52) })).priceAuthority.available, false);
});

test("4: exact T30 best bid creates T30_EXACT_BID_ANCHOR_V1, capped at 0.54", () => {
  const r = evaluateT10EconomicAction(cand({ t30: [0.5, 0.52] }));
  assert.equal(r.priceAuthority.version, PRICE_AUTHORITY_VERSION);
  assert.equal(r.priceAuthority.source, "T30_BOOK");
  assert.equal(r.priceAuthority.pBuyMax, 0.5);
  const capped = evaluateT10EconomicAction(cand({ t10: [0.55, 0.57], t30: [0.55, 0.57] }));
  assert.equal(capped.priceAuthority.pBuyMax, 0.54);
});

test("5: no T30 authority -> no fabricated P_BUY_MAX and no action", () => {
  const r = evaluateT10EconomicAction(cand({ t30: null }));
  assert.equal(r.priceAuthority.available, false);
  assert.equal(r.priceAuthority.pBuyMax, null);
  assert.equal(r.shadowAction, "SKIP");
});

test("6: STRONG + effective cost above P_BUY_MAX -> no TAKER", () => {
  const r = evaluateT10EconomicAction(cand({ extra: { askLevels: ladder(0.51), feeUsdForFullStake: 0 } }));
  assert.equal(r.referenceStatus, "STRONG");
  assert.equal(r.taker.eligible, false);
  assert.equal(r.taker.rejectReason, "TAKER_EFFECTIVE_COST_ABOVE_ANCHOR");
  assert.equal(r.taker.priceAdvantageVsAnchor, -0.01);
});

test("7: STRONG + effective cost <= P_BUY_MAX -> TAKER candidate with fee in the cost", () => {
  const r = evaluateT10EconomicAction(cand({ t30: [0.52, 0.54], t10: [0.5, 0.52], extra: { askLevels: ladder(0.5), feeUsdForFullStake: 0.01 } }));
  assert.equal(r.taker.eligible, true);
  assert.equal(r.taker.rawVwap, 0.5);
  assert.equal(r.taker.effectiveCost, 0.502); // (2.50 + 0.01) / 5 shares
  assert.equal(r.taker.priceAdvantageVsAnchor, 0.018);
  assert.equal(r.shadowAction, "TAKER_FIRST");
});

test("7b: TAKER evidence missing is recorded, never approximated from bestAsk", () => {
  const none = evaluateT10EconomicAction(cand({ t30: [0.52, 0.54], t10: [0.5, 0.52] }));
  assert.equal(none.taker.rejectReason, "TAKER_EXECUTION_EVIDENCE_MISSING");
  const noFee = evaluateT10EconomicAction(cand({ t30: [0.52, 0.54], t10: [0.5, 0.52], extra: { askLevels: ladder(0.5) } }));
  assert.equal(noFee.taker.rejectReason, "TAKER_FEE_EVIDENCE_MISSING");
  const thin = evaluateT10EconomicAction(cand({ t30: [0.52, 0.54], t10: [0.5, 0.52], extra: { askLevels: ladder(0.5, 1), feeUsdForFullStake: 0 } }));
  assert.equal(thin.taker.rejectReason, "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT");
  const walk = walkAskLevels([{ price: 0.5, sizeShares: 2 }, { price: 0.52, sizeShares: 10 }, { price: 0.6, sizeShares: 100 }], 2.5, 0.54);
  assert.equal(walk.filled, true);
  assert.equal(walk.rawVwap, 0.511811); // $1.00 @0.50 + $1.50 @0.52; the 0.60 level is above the cap and never touched
});

test("8: WEAK never TAKER", () => {
  // T10 only spread-wide (source-quality fail) + valid T30 -> WEAK, anchor from T30.
  const c = cand({ t10: [0.45, 0.51], t30: [0.5, 0.52], extra: { askLevels: ladder(0.4), feeUsdForFullStake: 0 } });
  const r = evaluateT10EconomicAction(c);
  assert.equal(r.referenceStatus, "WEAK");
  assert.equal(r.taker.eligible, false);
  assert.equal(r.taker.rejectReason, "TAKER_REQUIRES_STRONG");
});

test("9: WEAK + valid anchor may create MAKER", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.45, 0.51], t30: [0.5, 0.52] }));
  assert.equal(r.referenceStatus, "WEAK");
  assert.equal(r.maker.eligible, true);
  assert.equal(r.shadowAction, "MAKER_FIRST");
});

test("10: Maker uses P_BUY_MAX, not bestBid + tick", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.45, 0.53], t30: [0.5, 0.52], tick: 0.01 }));
  // bestBid + tick would be 0.46; the anchor/ask rule gives min(0.50, 0.52) = 0.50.
  assert.equal(r.maker.limitPrice, 0.5);
  assert.notEqual(r.maker.limitPrice, 0.46);
  assert.equal(r.maker.cushionVsAnchor, 0);
});

test("11: maker limit never crosses the ask", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.49, 0.51], t30: [0.5, 0.52], tick: 0.01 }));
  assert.equal(r.maker.limitPrice, 0.5);
  assert.ok((r.maker.limitPrice as number) < 0.51);
  assert.equal(r.maker.ticksToAsk, 1);
  // ask 0.50 => limit 0.49 (odds 2.04) is outside the 1.85..2.00 band: maker support is proven on the limit.
  const outside = evaluateT10EconomicAction(cand({ t10: [0.49, 0.5], t30: [0.5, 0.52], tick: 0.01 }));
  assert.equal(outside.maker.eligible, false);
  assert.equal(outside.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  const noRoom = evaluateT10EconomicAction(cand({ t10: [0.005, 0.01], t30: [0.5, 0.52], tick: 0.01 }));
  assert.equal(noRoom.maker.eligible, false);
});

test("12: maker limit never exceeds 0.54", () => {
  const r = evaluateT10EconomicAction(cand({ t10: [0.58, 0.6], t30: [0.57, 0.6], tick: 0.01 }));
  assert.ok(r.maker.limitPrice === null || r.maker.limitPrice <= 0.54);
  assert.equal(r.priceAuthority.pBuyMax, 0.54);
  assert.equal(r.maker.limitPrice, 0.54);
});

test("13: meaningful-best-bid guard only when authoritative; otherwise NOT_PROVEN", () => {
  const unproven = evaluateT10EconomicAction(cand({ t10: [0.45, 0.53], t30: [0.5, 0.52] }));
  assert.equal(unproven.maker.meaningfulBidGuard, "NOT_PROVEN");
  assert.equal(unproven.maker.eligible, true);
  const below = evaluateT10EconomicAction(cand({ t10: [0.45, 0.53], t30: [0.5, 0.52], extra: { meaningfulBestBid: 0.51 } }));
  assert.equal(below.maker.rejectReason, "MAKER_BELOW_MEANINGFUL_BID");
  const ok = evaluateT10EconomicAction(cand({ t10: [0.45, 0.53], t30: [0.5, 0.52], extra: { meaningfulBestBid: 0.5 } }));
  assert.equal(ok.maker.eligible, true);
  assert.equal(ok.maker.meaningfulBidGuard, "PASSED");
});

test("13b: unknown tick -> no Maker, never an invented tick", () => {
  const r = evaluateT10EconomicAction(cand({ tick: null }));
  assert.equal(r.maker.eligible, false);
  assert.equal(r.maker.rejectReason, "TICK_UNKNOWN");
});

test("14: deterministic multi-sibling ranking, order independent", () => {
  const a = cand({ token: "tok-a", cond: "0xa", t10: [0.5, 0.52], t30: [0.52, 0.53] });
  const b = cand({ token: "tok-b", cond: "0xb", t10: [0.47, 0.51], t30: [0.5, 0.52] });
  const c = cand({ token: "tok-c", cond: "0xc", t10: [0.47, 0.51], t30: [0.5, 0.52] });
  const forward = decideEventAction([a, b, c]);
  const reverse = decideEventAction([c, b, a]);
  assert.equal(forward.selected?.candidateIdentity.tokenId, reverse.selected?.candidateIdentity.tokenId);
  // a: limit 0.51 cushion 0.01 ticks 1; b/c: limit 0.50 cushion 0 ticks 1 -> a has the larger cushion.
  assert.equal(forward.selected?.candidateIdentity.tokenId, "tok-a");
  // b vs c tie on every criterion -> identity order.
  assert.equal(decideEventAction([c, b]).selected?.candidateIdentity.tokenId, "tok-b");
});

test("15: family priority cannot override a better economic action", () => {
  const spreads = cand({ token: "tok-s", cond: "0xs", family: "SPREADS", t10: [0.45, 0.53], t30: [0.5, 0.52] });
  const totals = cand({ token: "tok-t", cond: "0xt", family: "TOTALS", t10: [0.51, 0.52], t30: [0.52, 0.53] });
  const d = decideEventAction([spreads, totals]);
  // TOTALS has the larger cushion (limit 0.51 vs 0.50); SPREADS is higher in the old priority.
  assert.equal(d.selected?.candidateIdentity.family, "TOTALS");
});

test("15b: SAFE_TAKER beats any Maker, and the best Maker alternative is retained", () => {
  const taker = cand({ token: "tok-t", cond: "0xt", t30: [0.52, 0.54], t10: [0.5, 0.52], extra: { askLevels: ladder(0.5), feeUsdForFullStake: 0 } });
  const maker = cand({ token: "tok-m", cond: "0xm", t10: [0.49, 0.51], t30: [0.5, 0.52] });
  const d = decideEventAction([maker, taker]);
  assert.equal(d.action, "TAKER_FIRST");
  assert.equal(d.selected?.candidateIdentity.tokenId, "tok-t");
  assert.ok(d.bestMakerAlternative);
});

test("16: exactly one final action per physical event; mixed events are refused", () => {
  const d = decideEventAction([cand({ token: "a", cond: "0xa" }), cand({ token: "b", cond: "0xb" })]);
  assert.ok(["TAKER_FIRST", "MAKER_FIRST", "SKIP"].includes(d.action));
  assert.equal(d.selected === null, d.action === "SKIP");
  const other = cand({ token: "z", cond: "0xz" });
  other.identity = { ...other.identity, physicalEventId: "another-event" };
  assert.throws(() => decideEventAction([cand(), other]), /MULTIPLE_PHYSICAL_EVENTS/);
});

test("16b: exposure or after latest-entry -> SKIP", () => {
  assert.equal(evaluateT10EconomicAction({ ...cand(), exposureExists: true }).shadowAction, "SKIP");
  assert.equal(evaluateT10EconomicAction({ ...cand(), beforeLatestEntry: false }).shadowAction, "SKIP");
  assert.equal(evaluateT10EconomicAction({ ...cand(), supportFamilyEligible: false }).reason, "NOT_SUPPORT_ELIGIBLE");
});

test("17: real rank-4 evidence (Under 0.02/0.51, T30 0.02/0.52, Over mirror 0.49/0.98) is not a bet", () => {
  const under = id("tok-under", "Under");
  const over = id("tok-over", "Over");
  const t10 = book("T10_BOOK", under, 0.02, 0.51);
  const t30 = book("T30_BOOK", under, 0.02, 0.52);
  const mirror: ReferenceEvidence = { ...book("T10_BOOK", over, 0.49, 0.98), source: "BINARY_COMPLEMENT" };
  const reference = evaluateExactMarketReference(under, [t10, t30, mirror]);
  const input: PolicyCandidateInput = {
    identity: under, family: "TOTALS", supportFamilyEligible: true, takerSupportEligible: true,
    supportBand: bStrategySupportRegion("TOTALS"), reference, t30Evidence: t30,
    t10: { bestBid: 0.02, bestAsk: 0.51, bookFresh: true, observedAtMs: Date.parse(T10_AT), tickSize: 0.01,
      askLevels: ladder(0.51), feeUsdForFullStake: 0 },
    beforeLatestEntry: true, exposureExists: false,
  };
  const r = evaluateT10EconomicAction(input);
  assert.equal(r.referenceStatus, "UNRESOLVED");
  assert.equal(r.priceAuthority.available, false);
  assert.equal(r.shadowAction, "SKIP");
  assert.equal(decideEventAction([input]).action, "SKIP");
});

test("18: no arbitrary fill probability anywhere in the policy source", () => {
  const src = fs.readFileSync(new URL("../../lib/executor/t10EconomicActionPolicy.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(src, /\bphi\b|fillProb|pFill|p_fill|fill_probability|probabilityOfFill|Math\.random/i);
  const r = evaluateT10EconomicAction(cand());
  assert.deepEqual(Object.keys(r.maker).sort(), ["cushionVsAnchor", "eligible", "limitPrice", "meaningfulBidGuard", "rejectReason", "ticksToAsk"]);
});

test("16c: exposure or late entry on ANY sibling blocks the whole physical event", () => {
  const ok = cand({ token: "a", cond: "0xa" });
  const exposed = { ...cand({ token: "b", cond: "0xb" }), exposureExists: true };
  assert.equal(decideEventAction([ok, exposed]).action, "SKIP");
  assert.equal(decideEventAction([ok, exposed]).reason, "EVENT_EXPOSURE_EXISTS");
  const late = { ...cand({ token: "c", cond: "0xc" }), beforeLatestEntry: false };
  assert.equal(decideEventAction([ok, late]).reason, "EVENT_AFTER_LATEST_ENTRY");
  assert.equal(decideEventAction([ok]).action, "MAKER_FIRST");
});

test("4b: only an identity-exact T30_BOOK anchors; a T10 book or wrong-phase witness in the T30 slot does not; key is surfaced", () => {
  const identity = id("tok-a", "Under");
  assert.equal(evaluateT10EconomicAction(cand({ t30Override: book("T10_BOOK", identity, 0.5, 0.52) })).priceAuthority.reason, "SOURCE_NOT_T30_BOOK");
  const wrongPhase = { ...book("T30_BOOK", identity, 0.5, 0.52), observationPhase: "T_MINUS_10" };
  const r = evaluateT10EconomicAction(cand({ t30Override: wrongPhase }));
  assert.equal(r.priceAuthority.available, false);
  assert.match(r.priceAuthority.reason, /PHASE_LABEL_MISMATCH/);
  assert.equal(evaluateT10EconomicAction(cand()).priceAuthority.t30ObservationKey, "T30_BOOK:tok-a");
});

test("14b: cushion key is isolated when both siblings are STRONG-equal in status (WEAK vs WEAK)", () => {
  const w = (token: string, cond: string, t10: [number, number], t30: [number, number]) => cand({ token, cond, t10, t30 });
  const a = w("tok-a", "0xa", [0.45, 0.52], [0.52, 0.53]);   // WEAK (wide T10 spread), limit 0.51, cushion 0.01
  const b = w("tok-b", "0xb", [0.45, 0.53], [0.5, 0.52]);    // WEAK, limit 0.50, cushion 0
  assert.equal(a.reference.status, "WEAK");
  assert.equal(b.reference.status, "WEAK");
  assert.equal(decideEventAction([b, a]).selected?.candidateIdentity.tokenId, "tok-a");
});


// ── MONEYLINE_SUPPORT_AND_MAKER_PRICE_AUTHORITY_FIX_V1 ─────────────────────────────────────────────
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

test("ML-3: maker limit above P_BUY_MAX or above 0.54 fails closed", () => {
  const band = bStrategySupportRegion("MONEYLINE");
  assert.deepEqual(evaluateMakerSupportPrice(0.55, 0.54, 0.6, band), { ok: false, reason: "MAKER_ABOVE_P_BUY_MAX" });
  assert.deepEqual(evaluateMakerSupportPrice(0.55, 0.60, 0.54, band), { ok: false, reason: "MAKER_ABOVE_PRICE_CAP" });
  assert.equal(evaluateMakerSupportPrice(0.54, 0.54, 0.54, band).ok, true);
});

test("ML-4 LIVE BUG: ask 0.57, P_BUY_MAX 0.54, tick 0.01, cap 0.54 -> TAKER rejected, MAKER posts 0.54 in band", () => {
  // T30 bid 0.56 => P_BUY_MAX = min(0.56, 0.54) = 0.54. Current ask odds 1/0.57 = 1.754 (inside 1.70, outside old 1.85).
  const r = evaluateT10EconomicAction(ml({ t10: [0.56, 0.57], t30: [0.56, 0.57],
    extra: { askLevels: ladder(0.57), feeUsdForFullStake: 0.01 } }));
  assert.equal(r.priceAuthority.pBuyMax, 0.54);
  assert.equal(r.taker.eligible, false, "never buy 0.57");
  assert.equal(r.maker.eligible, true);
  assert.equal(r.maker.limitPrice, 0.54);
  assert.equal(r.shadowAction, "MAKER_FIRST");
  assert.equal(r.support.maker.MAKER_SUPPORT_PRICE_SOURCE, "MAKER_LIMIT");
  assert.equal(r.support.maker.SUPPORT_PRICE, 0.54);
  assert.ok(Math.abs(r.support.maker.SUPPORT_DECIMAL_ODDS! - 1.851852) < 1e-5);
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, true);
  assert.equal(r.support.taker.TAKER_SUPPORT_PRICE_SOURCE, "EXECUTABLE_CURRENT_ASK");
  assert.equal(r.support.taker.SUPPORT_PRICE, 0.57);
  assert.equal(r.support.SUPPORT_BAND_MIN, 1.7);
  assert.equal(r.support.SUPPORT_BAND_MAX, 2);
});

test("ML-5: ask outside the band for taker but maker limit inside -> MAKER evaluated (old gate rejected both)", () => {
  // Ask 0.40 (odds 2.5, outside) with a low anchor: taker support fails, maker limit 0.39 odds 2.56 also outside -> rejected.
  const r = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.35, 0.40], t30: [0.5, 0.52] }));
  assert.equal(r.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(r.maker.eligible, false);
  assert.equal(r.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(r.support.maker.SUPPORT_PRICE_IN_BAND, false);
  // Same ask 0.57 but the anchor drives the limit under 0.50 (odds > 2.00) -> maker rejected.
  const low = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.48, 0.57], t30: [0.48, 0.50] }));
  assert.equal(low.priceAuthority.pBuyMax, 0.48);
  assert.equal(low.maker.rejectReason, "MAKER_SUPPORT_PRICE_OUTSIDE_BAND");
  assert.equal(low.shadowAction, "SKIP");
});

test("ML-6: maker support is NOT judged from the current ask (ask odds 1.754, limit odds 1.852)", () => {
  const withAskBand = evaluateT10EconomicAction(ml({ takerSupport: false, t10: [0.56, 0.57], t30: [0.56, 0.57] }));
  assert.equal(withAskBand.maker.eligible, true);
  assert.equal(withAskBand.taker.rejectReason, "TAKER_SUPPORT_PRICE_OUTSIDE_BAND");
});

test("ML-7: unsupported family still SKIPs for both actions", () => {
  const r = evaluateT10EconomicAction({ ...ml(), supportFamilyEligible: false });
  assert.equal(r.reason, "NOT_SUPPORT_ELIGIBLE");
  assert.equal(r.maker.eligible, false);
  assert.equal(r.taker.eligible, false);
});

test("ML-8: TAKER final re-proof: executed VWAP odds must lie inside the band", () => {
  // Ask band flag true from caller, but the executed price (0.45 => odds 2.22) is outside 1.70..2.00.
  const r = evaluateT10EconomicAction(ml({ t10: [0.44, 0.45], t30: [0.5, 0.52],
    extra: { askLevels: ladder(0.45), feeUsdForFullStake: 0 } }));
  assert.equal(r.taker.eligible, false);
});
