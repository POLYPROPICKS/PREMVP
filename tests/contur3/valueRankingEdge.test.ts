// VALUE_RANKING_V1 — max proven edge ranking, external fair de-vig, fail-closed VALUE_REFERENCE_UNPROVEN.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decideEventAction, evaluateT10EconomicAction, type PolicyCandidateInput,
} from "../../lib/executor/t10EconomicActionPolicy";
import {
  resolveExternalFair, makerPriceEdge, takerProvenEdge, type BookmakerQuote, type FairTarget, type ExternalFairResolution,
} from "../../lib/executor/externalFairReference";
import { bStrategySupportRegion } from "../../lib/executor/reservationMarketBaseline";
import { evaluateExactMarketReference, type ExactMarketIdentity } from "../../lib/executor/exactMarketReference";
import {
  buildShadowMarkerFromPlannedRow, readRealMoneyExecutionSwitch, valueEdgeScalars,
} from "../../lib/executor/t10RealMoneyPause";

const KICKOFF = "2026-10-02T11:00:00.000Z";
const NOW = Date.parse("2026-10-02T10:45:00.000Z");
const OBS = "2026-10-02T10:40:00.000Z";
const EVENT = "provider:polymarket:game:1:2026-10-02";
const ident = (token: string, side: string): ExactMarketIdentity => ({ physicalEventId: EVENT, conditionId: `0x${token}`, tokenId: token, side });
const ladder = (price: number, usd = 10) => [{ price, sizeShares: usd / price }];

const quote = (o: Partial<BookmakerQuote> & { outcome: BookmakerQuote["outcome"]; decimalOdds: number }): BookmakerQuote => ({
  kind: "BOOKMAKER_ODDS", provider: "book-x", independentOfPolymarket: true, physicalEventId: EVENT, kickoffIso: KICKOFF,
  marketType: "TOTAL", line: 2.5, period: "FULL_MATCH", settlement: "REGULATION_90", observedAtIso: OBS, ...o,
});
const target = (o: Partial<FairTarget> = {}): FairTarget => ({
  physicalEventId: EVENT, kickoffIso: KICKOFF, marketType: "TOTAL", line: 2.5, period: "FULL_MATCH",
  settlement: "REGULATION_90", outcome: "OVER", ...o,
});
const overUnder = (over = 1.9, under = 1.9, o: Partial<BookmakerQuote> = {}) =>
  [quote({ outcome: "OVER", decimalOdds: over, ...o }), quote({ outcome: "UNDER", decimalOdds: under, ...o })];
const provenFair = (p: number): ExternalFairResolution =>
  ({ status: "PROVEN", fairProbability: p, source: "BOOKMAKER_ODDS:book-x", observedAtIso: OBS, overround: 1.05, reason: "EXTERNAL_FAIR_DEVIGGED" });

type C = { token: string; side?: string; family?: string; ask?: number; fee?: number; fair?: ExternalFairResolution | null; bid?: number; maker?: boolean };
function cand(o: C): PolicyCandidateInput {
  const identity = ident(o.token, o.side ?? "Over");
  const family = o.family ?? "TOTALS";
  const ask = o.ask ?? 0.52;
  const bid = o.bid ?? 0.5;
  return {
    identity, family, supportFamilyEligible: true, takerSupportEligible: true, supportBand: bStrategySupportRegion(family),
    reference: evaluateExactMarketReference(identity, []), externalFair: o.fair ?? null,
    t10: { bestBid: bid, bestAsk: ask, bookFresh: true, observedAtMs: NOW, tickSize: 0.01,
      askLevels: o.maker ? null : ladder(ask), feeUsdForFullStake: o.maker ? null : (o.fee ?? 0.01) },
    beforeLatestEntry: true, exposureExists: false,
  };
}

test("V1: highest positive proven TAKER edge wins over higher-priced/lower-priced siblings", () => {
  const a = cand({ token: "a", ask: 0.54, fee: 0, fair: provenFair(0.6) });  // edge 0.06
  const b = cand({ token: "b", ask: 0.5, fee: 0, fair: provenFair(0.55) });  // edge 0.05
  const d = decideEventAction([b, a]);
  assert.equal(d.selected?.candidateIdentity.tokenId, "a", "higher edge wins despite higher purchase price");
  assert.equal(d.value.action, "TAKER_FIRST");
  assert.equal(d.value.provenEdge, 0.06);
  assert.equal(d.rankingReason, "MAX_PROVEN_EDGE");
});

test("V2: a cheaper price cannot override a higher edge (and loses even when much cheaper)", () => {
  const cheap = cand({ token: "cheap", ask: 0.5, fee: 0, fair: provenFair(0.52) });   // edge 0.02
  const dear = cand({ token: "dear", ask: 0.54, fee: 0, fair: provenFair(0.57) });    // edge 0.03
  assert.equal(decideEventAction([cheap, dear]).selected?.candidateIdentity.tokenId, "dear");
  assert.equal(decideEventAction([dear, cheap]).selected?.candidateIdentity.tokenId, "dear");
});

test("V3: edge uses the FEE-INCLUSIVE effective cost, not the raw VWAP", () => {
  const e = evaluateT10EconomicAction(cand({ token: "a", ask: 0.5, fee: 0.05, fair: provenFair(0.52) }));
  assert.equal(e.taker.rawVwap, 0.5);
  assert.equal(e.taker.effectiveCost, 0.51);
  assert.equal(e.value.taker_proven_edge, 0.01);
  // Fee flips the sign: fair 0.505 beats raw 0.5 but not the 0.51 fee-inclusive cost.
  const f = evaluateT10EconomicAction(cand({ token: "a", ask: 0.5, fee: 0.05, fair: provenFair(0.505) }));
  assert.equal(f.value.taker_edge_status, "NON_POSITIVE_EDGE");
  assert.equal(decideEventAction([cand({ token: "a", ask: 0.5, fee: 0.05, fair: provenFair(0.505) })]).value.reason, "NO_POSITIVE_PROVEN_EDGE");
});

test("V4: missing fair => VALUE_REFERENCE_UNPROVEN, shadow VALUE action SKIP, executable order is NOT presented as value", () => {
  const d = decideEventAction([cand({ token: "a", ask: 0.5 }), cand({ token: "b", ask: 0.54 })]);
  assert.equal(d.value.action, "SKIP");
  assert.equal(d.value.reason, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(d.value.edgeStatus, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(d.value.provenEdge, null);
  assert.equal(d.rankingReason, "EXECUTION_ORDER_ONLY_VALUE_UNPROVEN");
  assert.equal(d.selected?.candidateIdentity.tokenId, "a", "execution order only (cost tie-break), unchanged executable behaviour");
  const ev = d.evaluations[0];
  assert.equal(ev.value.fair_status, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(ev.value.taker_proven_edge, null);
});

test("V5: Polymarket-derived references can never masquerade as an external fair", () => {
  for (const provider of ["polymarket", "POLYMARKET_T40", "t20-midpoint", "exactMarketReference", "clob-book"]) {
    const r = resolveExternalFair(target(), overUnder(1.9, 1.9, { provider }), NOW);
    assert.equal(r.status, "VALUE_REFERENCE_UNPROVEN", provider);
    assert.equal(r.reason, "SOURCE_IS_POLYMARKET_DERIVED");
  }
  const notIndependent = overUnder().map((q) => ({ ...q, independentOfPolymarket: false as unknown as true }));
  assert.equal(resolveExternalFair(target(), notIndependent, NOW).reason, "SOURCE_NOT_INDEPENDENT_BOOKMAKER");
  const wrongKind = overUnder().map((q) => ({ ...q, kind: "POLYMARKET_BOOK" as unknown as "BOOKMAKER_ODDS" }));
  assert.equal(resolveExternalFair(target(), wrongKind, NOW).reason, "SOURCE_NOT_INDEPENDENT_BOOKMAKER");
  // The candidate's Polymarket reference grade is never read as a fair probability.
  const e = evaluateT10EconomicAction(cand({ token: "a" }));
  assert.equal(e.value.fair_probability, null);
  const src = fs.readFileSync("lib/executor/t10EconomicActionPolicy.ts", "utf8");
  assert.doesNotMatch(src, /externalFair[^\n]*reference\./);
});

test("V6: an incomplete external market is rejected", () => {
  assert.equal(resolveExternalFair(target(), [overUnder()[0]], NOW).reason, "INCOMPLETE_EXTERNAL_MARKET");
  assert.equal(resolveExternalFair(target(), null, NOW).reason, "NO_EXTERNAL_FAIR_CARRIER");
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9).concat(quote({ outcome: "OVER", decimalOdds: 2 })), NOW).reason, "DUPLICATE_OUTCOME");
});

test("V7: wrong line is rejected (including a half of a pair at another line)", () => {
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { line: 3.5 }), NOW).reason, "LINE_MISMATCH");
  const mixed = [quote({ outcome: "OVER", decimalOdds: 1.9 }), quote({ outcome: "UNDER", decimalOdds: 1.9, line: 3.5 })];
  assert.equal(resolveExternalFair(target(), mixed, NOW).reason, "LINE_MISMATCH");
});

test("V8: wrong period, settlement and staleness are rejected", () => {
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { period: "FIRST_HALF" }), NOW).reason, "PERIOD_MISMATCH");
  assert.equal(resolveExternalFair(target({ period: "FIRST_HALF" }), overUnder(1.9, 1.9, { period: "FIRST_HALF" }), NOW).reason, "TARGET_PERIOD_NOT_FULL_MATCH");
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { settlement: "INCLUDING_OT" }), NOW).reason, "SETTLEMENT_MISMATCH");
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { observedAtIso: "2026-10-02T09:00:00.000Z" }), NOW).reason, "EXTERNAL_FAIR_STALE");
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { observedAtIso: "2026-10-02T11:30:00.000Z" }), Date.parse("2026-10-02T11:31:00.000Z")).reason, "EXTERNAL_FAIR_NOT_PRE_EVENT");
});

test("V9: wrong physical event or kickoff is rejected", () => {
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { physicalEventId: "other:event" }), NOW).reason, "EVENT_MISMATCH");
  assert.equal(resolveExternalFair(target(), overUnder(1.9, 1.9, { kickoffIso: "2026-10-02T12:00:00.000Z" }), NOW).reason, "KICKOFF_MISMATCH");
});

test("V10: 3-way MONEYLINE requires Home + Draw + Away; binary needs both sides", () => {
  const ml = (o: BookmakerQuote["outcome"], odds: number) => quote({ marketType: "MONEYLINE", line: null, outcome: o, decimalOdds: odds });
  const t = target({ marketType: "MONEYLINE", line: null, outcome: "HOME" });
  assert.equal(resolveExternalFair(t, [ml("HOME", 1.9), ml("AWAY", 2.0)], NOW).status, "PROVEN", "binary moneyline: both sides");
  assert.equal(resolveExternalFair(t, [ml("HOME", 2.2), ml("DRAW", 3.3)], NOW).reason, "INCOMPLETE_EXTERNAL_MARKET");
  assert.equal(resolveExternalFair(target({ marketType: "MONEYLINE", line: null, outcome: "DRAW" }), [ml("HOME", 2.2), ml("AWAY", 3.4)], NOW).reason, "INCOMPLETE_EXTERNAL_MARKET");
  const full = resolveExternalFair(t, [ml("HOME", 2.2), ml("DRAW", 3.3), ml("AWAY", 3.4)], NOW);
  assert.equal(full.status, "PROVEN");
  const q = [1 / 2.2, 1 / 3.3, 1 / 3.4]; const sum = q[0] + q[1] + q[2];
  assert.equal(full.status === "PROVEN" ? full.fairProbability : null, Math.round((q[0] / sum) * 1e6) / 1e6);
});

test("V11: TOTAL / SPREAD exact pair semantics (de-vig)", () => {
  const r = resolveExternalFair(target(), overUnder(1.9, 1.9), NOW);
  assert.equal(r.status === "PROVEN" ? r.fairProbability : null, 0.5);
  assert.equal(r.status === "PROVEN" ? r.overround : null, Math.round((2 / 1.9) * 1e6) / 1e6);
  const skew = resolveExternalFair(target(), overUnder(1.8, 2.1), NOW);
  const q = [1 / 1.8, 1 / 2.1];
  assert.equal(skew.status === "PROVEN" ? skew.fairProbability : null, Math.round((q[0] / (q[0] + q[1])) * 1e6) / 1e6);
  const sp = (o: BookmakerQuote["outcome"], odds: number) => quote({ marketType: "SPREAD", line: -1.5, outcome: o, decimalOdds: odds });
  const st = target({ marketType: "SPREAD", line: -1.5, outcome: "HOME" });
  assert.equal(resolveExternalFair(st, [sp("HOME", 1.95), sp("AWAY", 1.95)], NOW).status, "PROVEN");
  assert.equal(resolveExternalFair(st, [sp("OVER", 1.95), sp("UNDER", 1.95)], NOW).reason, "INCOMPLETE_EXTERNAL_MARKET", "OVER/UNDER is not a spread pair");
  assert.equal(resolveExternalFair(target(), overUnder(2.1, 2.1), NOW).reason, "OVERROUND_OUT_OF_RANGE", "sum(q) < 1 is incoherent");
});

test("V12: TOTAL_CORNERS exact full-match pair is allowed; other periods are not", () => {
  const c = (o: BookmakerQuote["outcome"]) => quote({ marketType: "TOTAL_CORNERS", line: 9.5, outcome: o, decimalOdds: 1.9 });
  assert.equal(resolveExternalFair(target({ marketType: "TOTAL_CORNERS", line: 9.5 }), [c("OVER"), c("UNDER")], NOW).status, "PROVEN");
  assert.equal(resolveExternalFair(target({ marketType: "TOTAL_CORNERS", line: 9.5 }), [c("OVER")], NOW).reason, "INCOMPLETE_EXTERNAL_MARKET");
  const h = [c("OVER"), c("UNDER")].map((q) => ({ ...q, period: "FIRST_HALF" }));
  assert.equal(resolveExternalFair(target({ marketType: "TOTAL_CORNERS", line: 9.5 }), h, NOW).reason, "PERIOD_MISMATCH");
});

test("V13: maker edge = fair - limit, with no fill probability anywhere", () => {
  assert.equal(makerPriceEdge(provenFair(0.56), 0.5), 0.06);
  assert.equal(makerPriceEdge(null, 0.5), null);
  assert.equal(takerProvenEdge(provenFair(0.56), null), null);
  const lo = decideEventAction([cand({ token: "m1", maker: true, bid: 0.5, ask: 0.52, fair: provenFair(0.54) })]);
  assert.equal(lo.value.action, "MAKER_FIRST");
  assert.equal(lo.value.provenEdge, 0.04);
  for (const f of ["lib/executor/externalFairReference.ts", "lib/executor/t10EconomicActionPolicy.ts"]) {
    const code = fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /fillProb|pFill|P\(fill\)|phi\b/i, f);
  }
  // Higher maker edge wins among makers.
  const m = decideEventAction([
    cand({ token: "m1", maker: true, bid: 0.5, ask: 0.52, fair: provenFair(0.54) }),
    cand({ token: "m2", maker: true, bid: 0.51, ask: 0.53, fair: provenFair(0.6) }),
  ]);
  assert.equal(m.selected?.candidateIdentity.tokenId, "m2");
});

test("V14: one event => exactly one selected action; multiple physical events are refused", () => {
  const d = decideEventAction([
    cand({ token: "a", fair: provenFair(0.6), fee: 0 }), cand({ token: "b", fair: provenFair(0.58), fee: 0 }),
    cand({ token: "c", maker: true, fair: provenFair(0.7) }),
  ]);
  assert.ok(d.selected);
  assert.ok(d.value.selected);
  assert.equal(d.evaluations.length, 3);
  const other = cand({ token: "z" }); other.identity = { ...other.identity, physicalEventId: "another" };
  assert.throws(() => decideEventAction([cand({ token: "a" }), other]), /T10_POLICY_MULTIPLE_PHYSICAL_EVENTS/);
});

test("V15: TAKER > MAKER priority is unchanged (a bigger maker edge never beats a positive taker edge)", () => {
  const taker = cand({ token: "t", ask: 0.52, fee: 0, fair: provenFair(0.53) });                    // edge 0.01
  const maker = cand({ token: "m", maker: true, bid: 0.5, ask: 0.52, fair: provenFair(0.7) });     // edge 0.20
  const d = decideEventAction([maker, taker]);
  assert.equal(d.action, "TAKER_FIRST");
  assert.equal(d.selected?.candidateIdentity.tokenId, "t");
  assert.equal(d.value.action, "TAKER_FIRST");
  // Unproven taker, proven maker: execution still TAKER (unchanged); VALUE falls to the proven maker.
  const d2 = decideEventAction([cand({ token: "t", ask: 0.52, fee: 0 }), maker]);
  assert.equal(d2.action, "TAKER_FIRST");
  assert.equal(d2.value.action, "MAKER_FIRST");
});

test("V16: real-money pause is untouched; markers stay live_authority=false and carry the value scalars", () => {
  assert.equal(readRealMoneyExecutionSwitch({ T10_REAL_MONEY_EXECUTION_ENABLED: "false" }).enabled, false);
  assert.equal(readRealMoneyExecutionSwitch({ T10_REAL_MONEY_EXECUTION_ENABLED: "garbage" }).enabled, false);
  const d = decideEventAction([cand({ token: "a", ask: 0.52, fee: 0 })]);
  const scalars = valueEdgeScalars(d, "TAKER_FIRST");
  assert.equal(scalars.fair_status, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(scalars.value_action, "SKIP");
  const row = { condition_id: "0xa", token_id: "a", side: "Over", market_family: "TOTALS", selection_reason: "x",
    diagnostics: { physical_event_id: EVENT, t10_value_edge_v1: scalars } } as never;
  const marker = buildShadowMarkerFromPlannedRow({ row, reason: "r", captureRunId: "cap", nowMs: NOW, policyVersion: "p" });
  assert.equal(marker.live_authority, false);
  assert.equal(marker.real_money_paused, true);
  assert.equal(marker.fair_status, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(marker.edge_status, "VALUE_REFERENCE_UNPROVEN");
  assert.equal(marker.proven_edge, null);
  assert.equal(marker.value_action, "SKIP");
  assert.equal(marker.ranking_reason, "EXECUTION_ORDER_ONLY_VALUE_UNPROVEN");
  for (const f of ["lib/executor/externalFairReference.ts", "lib/executor/t10EconomicActionPolicy.ts"]) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /T10_REAL_MONEY_EXECUTION|process\.env/, f);
  }
});
