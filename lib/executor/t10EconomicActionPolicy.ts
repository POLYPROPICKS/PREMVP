// T10_ECONOMIC_ACTION_POLICY_FREEZE_V1 — economic action policy (semantics frozen, unchanged).
//
// Pure and deterministic. Read by the money path ONLY through t10EconomicActivation.ts, behind the
// single switch T10_ECONOMIC_ACTION_ACTIVATION=ON (default OFF => released B priority + LIVE_GUARD).
// It turns one physical event's supported sibling universe into at most one action:
// TAKER_FIRST | MAKER_FIRST | SKIP.
//
// Three separate authorities (never conflated):
//   CANDIDATE authority  - FAMILY/TYPE admission (`supportFamilyEligible`, price-agnostic) plus an
//                          ACTION-SPECIFIC support price proof against the canonical family band:
//                          TAKER = current executable ask (initial) and the executed VWAP (final);
//                          MAKER = the maker limit PREMVP would actually bid (never the current ask).
//   PRICE authority      - T30_EXACT_BID_ANCHOR_V1: how much PREMVP may pay.
//   EXECUTION authority  - TAKER needs full-stake ask-ladder evidence + fee evidence; MAKER needs a tick.
//
// Statistical honesty (frozen):
//   - There is NO calibrated internal live win-probability model in V1.
//   - The CLOB is price evidence, not oracle truth. T30 and T10 are the SAME venue at different
//     times, not independent venues.
//   - P_BUY_MAX is a price anchor ("a real participant was bidding this exact token at this price
//     at T30"). It is NOT a true probability and NOT +EV proof.
//   - The Founder 40-45% win-rate hypothesis is NOT an input here. If the settled win rate at
//     0.50-0.54 entries is truly 40-45%, selection is structurally negative and no execution
//     optimisation can repair it.
//   - There is NO fill probability anywhere in this module (no phi, no P(fill)).
//   - Family priority (SPREADS > CORNERS > MONEYLINE > TOTALS) never decides the winner.
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "./executorQueueTypes";
import {
  evaluateExactMarketReference,
  type ExactMarketIdentity,
  type ExactMarketReference,
  type ReferenceEvidence,
} from "./exactMarketReference";

export const T10_ECONOMIC_ACTION_POLICY_VERSION = "T10_ECONOMIC_ACTION_POLICY_SHADOW_V1" as const;
export const PRICE_AUTHORITY_VERSION = "T30_EXACT_BID_ANCHOR_V1" as const;

export type ShadowAction = "TAKER_FIRST" | "MAKER_FIRST" | "SKIP";
export type AskLevel = { price: number; sizeShares: number };

export type SupportBand = { min: number; max: number };

export type PolicyCandidateInput = {
  identity: ExactMarketIdentity;
  family: string;
  /** CANDIDATE authority (price-agnostic): family/type/book proof only. Gates both TAKER and MAKER. */
  supportFamilyEligible: boolean;
  /** Canonical support band of the family (one authority: bStrategySupportRegion). null => unsupported family. */
  supportBand: SupportBand | null;
  /** TAKER initial support evidence: the current executable ask lies inside the band (caller-decided). */
  takerSupportEligible: boolean;
  /** Result of evaluateExactMarketReference for this exact token. */
  reference: ExactMarketReference;
  /** Identity-exact T30 book observation of this token; anything else yields no price authority. */
  t30Evidence: ReferenceEvidence | null;
  t10: {
    bestBid: number | null;
    bestAsk: number | null;
    /** Complete run, SUCCESS fetch, inside the T_MINUS_10 window (caller-proven). */
    bookFresh: boolean;
    observedAtMs: number | null;
    /** Pre-Queue full ask ladder, only when an authoritative carrier exists. */
    askLevels?: readonly AskLevel[] | null;
    /** Total fee in USD for the full-stake fill, only when authoritative. Never assumed zero. */
    feeUsdForFullStake?: number | null;
    tickSize?: number | null;
    /** Authoritative "meaningful" best bid; absent => the guard is NOT_PROVEN, never invented. */
    meaningfulBestBid?: number | null;
    askDepthUsd?: number | null;
  };
  stakeUsd?: number;
  hardCap?: number;
  beforeLatestEntry: boolean;
  exposureExists: boolean;
};

export type SupportAudit = {
  /** The price the band was proven against for this action (null when not reached). */
  SUPPORT_PRICE: number | null;
  /** 1 / SUPPORT_PRICE. */
  SUPPORT_DECIMAL_ODDS: number | null;
  /** Band verdict for this action's price. */
  SUPPORT_PRICE_IN_BAND: boolean | null;
};

export type PolicyEvaluation = {
  policyVersion: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  candidateIdentity: ExactMarketIdentity & { family: string };
  referenceStatus: ExactMarketReference["status"];
  priceAuthority: {
    version: typeof PRICE_AUTHORITY_VERSION;
    source: "T30_BOOK" | null;
    /** Observation key of the T30 witness the anchor came from (to be frozen in the Queue contract). */
    t30ObservationKey: string | null;
    available: boolean;
    pBuyMax: number | null;
    reason: string;
  };
  /** Auditable support evidence, separated per action. Scalars only. */
  support: {
    SUPPORT_BAND_MIN: number | null;
    SUPPORT_BAND_MAX: number | null;
    taker: SupportAudit & { TAKER_SUPPORT_PRICE_SOURCE: "EXECUTABLE_CURRENT_ASK" };
    maker: SupportAudit & { MAKER_SUPPORT_PRICE_SOURCE: "MAKER_LIMIT" };
  };
  taker: {
    eligible: boolean;
    rawVwap: number | null;
    effectiveCost: number | null;
    depthUsd: number | null;
    feeEvidence: "PRESENT" | "MISSING";
    priceAdvantageVsAnchor: number | null;
    rejectReason: string | null;
  };
  maker: {
    eligible: boolean;
    limitPrice: number | null;
    ticksToAsk: number | null;
    cushionVsAnchor: number | null;
    meaningfulBidGuard: "PASSED" | "NOT_PROVEN";
    rejectReason: string | null;
  };
  shadowAction: ShadowAction;
  reason: string;
};

const EPS = 1e-9;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const idKey = (i: ExactMarketIdentity) => `${i.conditionId}|${i.tokenId}|${i.side}`;

/** Walk cap-eligible asks (ascending) for a full USD stake. Never approximates with bestAsk. */
export function walkAskLevels(levels: readonly AskLevel[], stakeUsd: number, hardCap: number):
  { filled: boolean; rawVwap: number | null; shares: number; depthUsd: number } {
  const usable = levels.filter((l) => num(l.price) && num(l.sizeShares) && l.price > 0 && l.price <= hardCap + EPS && l.sizeShares > 0)
    .sort((a, b) => a.price - b.price);
  const depthUsd = usable.reduce((s, l) => s + l.price * l.sizeShares, 0);
  let remaining = stakeUsd;
  let shares = 0;
  for (const l of usable) {
    const take = Math.min(remaining, l.price * l.sizeShares);
    shares += take / l.price;
    remaining -= take;
    if (remaining <= EPS) break;
  }
  const filled = remaining <= EPS && shares > 0;
  return { filled, rawVwap: filled ? r6(stakeUsd / shares) : null, shares, depthUsd: r6(depthUsd) };
}

/** PRICE authority V1: P_BUY_MAX = min(T30 exact-token best_bid, hardCap). No extra margin. */
export function t30ExactBidAnchor(identity: ExactMarketIdentity, evidence: ReferenceEvidence | null, hardCap: number):
  PolicyEvaluation["priceAuthority"] {
  const none = (reason: string): PolicyEvaluation["priceAuthority"] =>
    ({ version: PRICE_AUTHORITY_VERSION, source: null, t30ObservationKey: null, available: false, pBuyMax: null, reason });
  if (!evidence) return none("NO_T30_EXACT_WITNESS");
  if (evidence.source !== "T30_BOOK") return none("SOURCE_NOT_T30_BOOK");
  // Reuse the canonical engine's identity + capture + window + book-quality rules for the witness.
  const check = evaluateExactMarketReference(identity, [evidence]);
  if (check.status !== "WEAK" || !num(evidence.bestBid) || evidence.bestBid <= 0) {
    return none(`T30_WITNESS_REJECTED:${check.rejected_sources[0]?.reason ?? check.reason}`);
  }
  return { version: PRICE_AUTHORITY_VERSION, source: "T30_BOOK", t30ObservationKey: evidence.observationKey, available: true,
    pBuyMax: r6(Math.min(evidence.bestBid, hardCap)), reason: "T30_EXACT_BID_ANCHOR" };
}

const oddsOf = (price: number | null): number | null => (num(price) && price > 0 ? r6(1 / price) : null);
export const priceInBand = (price: number | null, band: SupportBand | null): boolean =>
  band !== null && num(price) && price > 0 && 1 / price >= band.min - EPS && 1 / price <= band.max + EPS;

/**
 * MAKER price proof: the limit PREMVP would bid must itself be authorised (<= P_BUY_MAX, <= hard cap) and its
 * decimal odds must lie inside the canonical family band. Fails closed; never reads the current ask.
 */
export function evaluateMakerSupportPrice(limit: number, pBuyMax: number, cap: number, band: SupportBand | null):
  { ok: boolean; reason: string | null } {
  if (!num(limit) || !(limit > 0)) return { ok: false, reason: "MAKER_LIMIT_NOT_POSITIVE" };
  if (!num(pBuyMax) || limit > pBuyMax + EPS) return { ok: false, reason: "MAKER_ABOVE_P_BUY_MAX" };
  if (!num(cap) || limit > cap + EPS) return { ok: false, reason: "MAKER_ABOVE_PRICE_CAP" };
  if (!priceInBand(limit, band)) return { ok: false, reason: "MAKER_SUPPORT_PRICE_OUTSIDE_BAND" };
  return { ok: true, reason: null };
}

export function evaluateT10EconomicAction(input: PolicyCandidateInput): PolicyEvaluation {
  const stake = input.stakeUsd ?? QUEUE_DEFAULT_STAKE_USD;
  const cap = input.hardCap ?? QUEUE_MAX_ENTRY_PRICE;
  const status = input.reference.status;
  const priceAuthority = t30ExactBidAnchor(input.identity, input.t30Evidence, cap);
  const pBuyMax = priceAuthority.pBuyMax;
  const { t10 } = input;
  const ask = t10.bestAsk;

  const taker: PolicyEvaluation["taker"] = { eligible: false, rawVwap: null, effectiveCost: null, depthUsd: null,
    feeEvidence: num(t10.feeUsdForFullStake) && t10.feeUsdForFullStake >= 0 ? "PRESENT" : "MISSING",
    priceAdvantageVsAnchor: null, rejectReason: null };
  const maker: PolicyEvaluation["maker"] = { eligible: false, limitPrice: null, ticksToAsk: null, cushionVsAnchor: null,
    meaningfulBidGuard: num(t10.meaningfulBestBid) ? "PASSED" : "NOT_PROVEN", rejectReason: null };
  const band = input.supportBand;
  const support: PolicyEvaluation["support"] = {
    SUPPORT_BAND_MIN: band?.min ?? null, SUPPORT_BAND_MAX: band?.max ?? null,
    taker: { TAKER_SUPPORT_PRICE_SOURCE: "EXECUTABLE_CURRENT_ASK", SUPPORT_PRICE: num(ask) ? ask : null,
      SUPPORT_DECIMAL_ODDS: oddsOf(num(ask) ? ask : null), SUPPORT_PRICE_IN_BAND: null },
    maker: { MAKER_SUPPORT_PRICE_SOURCE: "MAKER_LIMIT", SUPPORT_PRICE: null, SUPPORT_DECIMAL_ODDS: null, SUPPORT_PRICE_IN_BAND: null },
  };

  const gate = status === "UNRESOLVED" ? "REFERENCE_UNRESOLVED"
    : !input.supportFamilyEligible ? "NOT_SUPPORT_ELIGIBLE"
    : !priceAuthority.available ? "PRICE_AUTHORITY_UNAVAILABLE"
    : input.exposureExists ? "EXPOSURE_EXISTS"
    : !input.beforeLatestEntry ? "AFTER_LATEST_ENTRY"
    : !t10.bookFresh || !num(ask) ? "T10_BOOK_NOT_FRESH" : null;

  if (gate) {
    taker.rejectReason = maker.rejectReason = gate;
  } else {
    // ---- TAKER: STRONG only; full-stake ladder + fee evidence required, else recorded as missing. ----
    support.taker.SUPPORT_PRICE_IN_BAND = input.takerSupportEligible && priceInBand(ask, band);
    if (!support.taker.SUPPORT_PRICE_IN_BAND) taker.rejectReason = "TAKER_SUPPORT_PRICE_OUTSIDE_BAND";
    else if (status !== "STRONG") taker.rejectReason = "TAKER_REQUIRES_STRONG";
    else if (!t10.askLevels || t10.askLevels.length === 0) taker.rejectReason = "TAKER_EXECUTION_EVIDENCE_MISSING";
    else {
      const walk = walkAskLevels(t10.askLevels, stake, cap);
      taker.depthUsd = walk.depthUsd;
      if (!walk.filled || walk.rawVwap === null) taker.rejectReason = "TAKER_FULL_STAKE_DEPTH_INSUFFICIENT";
      else if (walk.rawVwap > cap + EPS) taker.rejectReason = "TAKER_ABOVE_PRICE_CAP";
      else if (!priceInBand(walk.rawVwap, band)) {
        // Final re-proof: the price actually paid must itself lie inside the family band.
        support.taker.SUPPORT_PRICE = walk.rawVwap; support.taker.SUPPORT_DECIMAL_ODDS = oddsOf(walk.rawVwap);
        support.taker.SUPPORT_PRICE_IN_BAND = false;
        taker.rejectReason = "TAKER_SUPPORT_PRICE_OUTSIDE_BAND";
      } else {
        taker.rawVwap = walk.rawVwap;
        if (taker.feeEvidence === "MISSING") taker.rejectReason = "TAKER_FEE_EVIDENCE_MISSING";
        else {
          // net shares = stake / rawVwap; effective cost per share = (stake + fee) / net shares.
          taker.effectiveCost = r6((stake + (t10.feeUsdForFullStake as number)) / walk.shares);
          taker.priceAdvantageVsAnchor = r6((pBuyMax as number) - taker.effectiveCost);
          if (taker.effectiveCost <= (pBuyMax as number) + EPS) taker.eligible = true;
          else taker.rejectReason = "TAKER_EFFECTIVE_COST_ABOVE_ANCHOR";
        }
      }
    }
    // ---- MAKER: STRONG or WEAK with a prior exact-token anchor. NOT bestBid + tick. ----
    const tick = t10.tickSize;
    if (!num(tick) || !(tick > 0) || tick >= 1) maker.rejectReason = "TICK_UNKNOWN";
    else {
      const raw = Math.min(pBuyMax as number, (ask as number) - tick, cap);
      const limit = r6(Math.floor(raw / tick + EPS) * tick);
      let proof: { ok: boolean; reason: string | null } = { ok: true, reason: null };
      if (limit > 0 && limit < (ask as number) - EPS) {
        // MAKER support is proven on the price PREMVP would bid, never on the current ask.
        support.maker.SUPPORT_PRICE = limit; support.maker.SUPPORT_DECIMAL_ODDS = oddsOf(limit);
        proof = evaluateMakerSupportPrice(limit, pBuyMax as number, cap, band);
        support.maker.SUPPORT_PRICE_IN_BAND = proof.reason === "MAKER_SUPPORT_PRICE_OUTSIDE_BAND" ? false : proof.ok ? true : null;
      }
      if (!(limit > 0)) maker.rejectReason = "MAKER_LIMIT_NOT_POSITIVE";
      else if (!(limit < (ask as number) - EPS)) maker.rejectReason = "MAKER_LIMIT_NOT_BELOW_ASK";
      else if (!proof.ok) maker.rejectReason = proof.reason;
      else if (num(t10.meaningfulBestBid) && limit < t10.meaningfulBestBid - EPS) maker.rejectReason = "MAKER_BELOW_MEANINGFUL_BID";
      else {
        maker.eligible = true;
        maker.limitPrice = limit;
        maker.ticksToAsk = Math.round(((ask as number) - limit) / tick);
        maker.cushionVsAnchor = r6((pBuyMax as number) - limit);
      }
    }
  }

  const shadowAction: ShadowAction = taker.eligible ? "TAKER_FIRST" : maker.eligible ? "MAKER_FIRST" : "SKIP";
  const reason = shadowAction === "SKIP" ? (gate ?? maker.rejectReason ?? "NO_SAFE_ACTION")
    : shadowAction === "TAKER_FIRST" ? "SAFE_TAKER" : "SAFE_MAKER";
  return {
    policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION,
    candidateIdentity: { ...input.identity, family: input.family },
    referenceStatus: status, priceAuthority, support, taker, maker, shadowAction, reason,
  };
}

type Ranked = { input: PolicyCandidateInput; evaluation: PolicyEvaluation };
// Null sorts last in both directions; two nulls tie (never NaN).
const cmpDesc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
const cmpAsc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
const finish = (n: number, a: Ranked, b: Ranked) =>
  n !== 0 ? n : idKey(a.input.identity) < idKey(b.input.identity) ? -1 : idKey(a.input.identity) > idKey(b.input.identity) ? 1 : 0;

/** TAKER ranking: advantage desc, stronger evidence (more witnesses, tighter uncertainty), depth, freshness, identity. */
export function compareTaker(a: Ranked, b: Ranked): number {
  let n = cmpDesc(a.evaluation.taker.priceAdvantageVsAnchor, b.evaluation.taker.priceAdvantageVsAnchor);
  if (n === 0) n = b.input.reference.independent_witness_count - a.input.reference.independent_witness_count;
  if (n === 0) n = cmpAsc(a.input.reference.uncertainty, b.input.reference.uncertainty);
  if (n === 0) n = cmpDesc(a.evaluation.taker.depthUsd, b.evaluation.taker.depthUsd);
  if (n === 0) n = cmpDesc(a.input.t10.observedAtMs, b.input.t10.observedAtMs);
  return finish(n, a, b);
}

/** MAKER ranking: STRONG before WEAK, cushion desc, fewer ticks to ask, depth, freshness, identity. Fillability never outranks price. */
export function compareMaker(a: Ranked, b: Ranked): number {
  const rank = (r: Ranked) => (r.evaluation.referenceStatus === "STRONG" ? 0 : 1);
  let n = rank(a) - rank(b);
  if (n === 0) n = cmpDesc(a.evaluation.maker.cushionVsAnchor, b.evaluation.maker.cushionVsAnchor);
  if (n === 0) n = cmpAsc(a.evaluation.maker.ticksToAsk, b.evaluation.maker.ticksToAsk);
  if (n === 0) n = cmpDesc(a.input.t10.askDepthUsd ?? null, b.input.t10.askDepthUsd ?? null);
  if (n === 0) n = cmpDesc(a.input.t10.observedAtMs, b.input.t10.observedAtMs);
  return finish(n, a, b);
}

export type EventDecision = {
  policyVersion: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  physicalEventId: string | null;
  action: ShadowAction;
  selected: PolicyEvaluation | null;
  /** Best safe Maker alternative, retained even when TAKER wins (later calibration). */
  bestMakerAlternative: PolicyEvaluation | null;
  evaluations: PolicyEvaluation[];
  reason: string;
};

/** One physical event => at most one economic exposure. All supported siblings compete economically. */
export function decideEventAction(candidates: readonly PolicyCandidateInput[]): EventDecision {
  const events = new Set(candidates.map((c) => c.identity.physicalEventId));
  if (events.size > 1) throw new Error("T10_POLICY_MULTIPLE_PHYSICAL_EVENTS");
  const ranked: Ranked[] = candidates.map((input) => ({ input, evaluation: evaluateT10EconomicAction(input) }));
  // One physical event = one economic exposure: any sibling flag blocks the whole event, not just that sibling.
  const eventGate = candidates.some((c) => c.exposureExists) ? "EVENT_EXPOSURE_EXISTS"
    : candidates.some((c) => !c.beforeLatestEntry) ? "EVENT_AFTER_LATEST_ENTRY" : null;
  if (eventGate) {
    return { policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION, physicalEventId: candidates[0]?.identity.physicalEventId ?? null,
      action: "SKIP", selected: null, bestMakerAlternative: null, evaluations: ranked.map((r) => r.evaluation), reason: eventGate };
  }
  const takers = ranked.filter((r) => r.evaluation.taker.eligible).sort(compareTaker);
  const makers = ranked.filter((r) => r.evaluation.maker.eligible).sort(compareMaker);
  const winner = takers[0] ?? makers[0] ?? null;
  const action: ShadowAction = takers[0] ? "TAKER_FIRST" : makers[0] ? "MAKER_FIRST" : "SKIP";
  const selected = winner ? { ...winner.evaluation, shadowAction: action,
    reason: action === "TAKER_FIRST" ? "BEST_SAFE_TAKER" : "BEST_SAFE_MAKER" } : null;
  return {
    policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION,
    physicalEventId: candidates[0]?.identity.physicalEventId ?? null,
    action, selected,
    bestMakerAlternative: makers[0]?.evaluation ?? null,
    evaluations: ranked.map((r) => r.evaluation),
    reason: action === "SKIP" ? "NO_SAFE_ACTION_IN_SUPPORTED_UNIVERSE" : selected!.reason,
  };
}
