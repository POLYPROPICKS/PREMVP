// T30_MONEY_GATE_REMOVAL_V1 — T10 economic action policy: CURRENT-BOOK execution authority.
//
// Pure and deterministic. Read by the money path ONLY through t10EconomicActivation.ts, behind the
// single switch T10_ECONOMIC_ACTION_ACTIVATION=ON (default OFF => released B priority + LIVE_GUARD).
// It turns one physical event's supported sibling universe into at most one action:
// TAKER_FIRST | MAKER_FIRST | SKIP.
//
// T30 is research telemetry ONLY. It never authorizes, vetoes, prices or ranks a live action:
//   T30_LIVE_ELIGIBILITY_GATE=NO   T30_LIVE_PRICE_AUTHORITY=NO   T30_LIVE_RANKING_AUTHORITY=NO
//
// Three separate authorities (never conflated), all read from the CURRENT T10 execution book:
//   CANDIDATE authority  - FAMILY/TYPE admission (`supportFamilyEligible`, price-agnostic) plus an
//                          ACTION-SPECIFIC support price proof against the canonical family band:
//                          TAKER = current executable ask (initial) and the executed VWAP (final);
//                          MAKER = the maker limit PREMVP would actually bid (never the current ask).
//   PRICE authority      - T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1:
//                          TAKER = full-stake ask-ladder VWAP and fee-inclusive cost within the hard cap;
//                          MAKER = floor_to_tick(min(current best bid, current best ask - tick, hard cap)).
//                          The current best bid is the placement authority; an empty/wide spread is never
//                          jumped with `ask - tick` alone.
//   EXECUTION authority  - TAKER needs full-stake ask-ladder evidence + fee evidence; MAKER needs a tick,
//                          a best bid and a best ask.
//
// Statistical honesty (frozen):
//   - There is NO calibrated internal live win-probability model in V1.
//   - The CLOB is price evidence, not oracle truth. Nothing here is +EV proof.
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
import { makerPriceEdge, takerProvenEdge, type ExternalFairResolution } from "./externalFairReference";

export const T10_ECONOMIC_ACTION_POLICY_VERSION = "T10_ECONOMIC_ACTION_POLICY_SHADOW_V1" as const;
export const PRICE_AUTHORITY_VERSION = "T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1" as const;

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
  /** TAKER initial support evidence: the CURRENT executable ask lies inside the band (caller-decided). */
  takerSupportEligible: boolean;
  /** TELEMETRY ONLY. The reference grade (T10 + T30 witnesses) never gates, prices or ranks a live action. */
  reference: ExactMarketReference;
  /** TELEMETRY ONLY. T30 research observation of this token; it never authorizes, vetoes, prices or ranks. */
  t30Evidence?: ReferenceEvidence | null;
  /**
   * VALUE_RANKING_V1: independent (non-Polymarket) fair probability for exactly this token, already de-vigged and
   * identity-checked by externalFairReference.ts. Absent => VALUE_REFERENCE_UNPROVEN. `reference` (Polymarket
   * price evidence) is never read as a fair probability.
   */
  externalFair?: ExternalFairResolution | null;
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

/** T30 research telemetry. LIVE_AUTHORITY is the literal `false`: T30 is never a live gate, price or rank. */
export type T30Telemetry = {
  LIVE_AUTHORITY: false;
  /** An identity-exact, usable T30 book of this token was observed. */
  available: boolean;
  observationKey: string | null;
  bestBid: number | null;
  reason: string;
};

export type PolicyEvaluation = {
  policyVersion: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  candidateIdentity: ExactMarketIdentity & { family: string };
  /** TELEMETRY ONLY (never a live gate). */
  referenceStatus: ExactMarketReference["status"];
  priceAuthority: {
    version: typeof PRICE_AUTHORITY_VERSION;
    source: "T10_CURRENT_BOOK" | null;
    /** A safe current-book action exists, so a frozen price ceiling exists. */
    available: boolean;
    /**
     * Frozen price ceiling of the evaluated action, derived from the CURRENT book only:
     * TAKER = the hard cap (fee-inclusive cost bound); MAKER = the current-book maker limit.
     */
    pBuyMax: number | null;
    reason: string;
  };
  /** T30 research telemetry; never read by any decision. */
  t30: T30Telemetry;
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
    /** Deprecated and always null: there is no T30 anchor. Kept only so the read-only T30 replay script type-checks. */
    priceAdvantageVsAnchor: null;
    rejectReason: string | null;
  };
  maker: {
    eligible: boolean;
    limitPrice: number | null;
    ticksToAsk: number | null;
    /** Deprecated and always null: there is no T30 anchor. Kept only so the read-only T30 replay script type-checks. */
    cushionVsAnchor: null;
    meaningfulBidGuard: "PASSED" | "NOT_PROVEN";
    rejectReason: string | null;
  };
  /** VALUE_RANKING_V1 scalars. Never a live gate: execution authority stays on the CURRENT book. */
  value: ValueEvidence;
  shadowAction: ShadowAction;
  reason: string;
};

export type EdgeStatus = "POSITIVE_EDGE" | "NON_POSITIVE_EDGE" | "VALUE_REFERENCE_UNPROVEN";
export type ValueEvidence = {
  fair_status: "PROVEN" | "VALUE_REFERENCE_UNPROVEN";
  fair_probability: number | null;
  fair_source: string | null;
  fair_observed_at: string | null;
  fair_reason: string;
  /** fair - fee-inclusive effective cost; only for an eligible TAKER with a proven fair. */
  taker_proven_edge: number | null;
  /** fair - maker limit; only for an eligible MAKER with a proven fair. No fill probability. */
  maker_price_edge: number | null;
  taker_edge_status: EdgeStatus;
  maker_edge_status: EdgeStatus;
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

/**
 * T30 RESEARCH TELEMETRY: did an identity-exact, usable T30 book of this token exist, and what was its best bid?
 * Reuses the canonical engine's identity + capture + window + book-quality rules. Never a gate, price or rank.
 */
export function t30Telemetry(identity: ExactMarketIdentity, evidence: ReferenceEvidence | null | undefined): T30Telemetry {
  const none = (reason: string): T30Telemetry => ({ LIVE_AUTHORITY: false, available: false, observationKey: null, bestBid: null, reason });
  if (!evidence) return none("NO_T30_EXACT_WITNESS");
  if (evidence.source !== "T30_BOOK") return none("SOURCE_NOT_T30_BOOK");
  const check = evaluateExactMarketReference(identity, [evidence]);
  if (check.status !== "WEAK" || !num(evidence.bestBid) || evidence.bestBid <= 0) {
    return none(`T30_WITNESS_REJECTED:${check.rejected_sources[0]?.reason ?? check.reason}`);
  }
  return { LIVE_AUTHORITY: false, available: true, observationKey: evidence.observationKey, bestBid: evidence.bestBid, reason: "T30_EXACT_WITNESS_OBSERVED" };
}

const oddsOf = (price: number | null): number | null => (num(price) && price > 0 ? r6(1 / price) : null);
export const priceInBand = (price: number | null, band: SupportBand | null): boolean =>
  band !== null && num(price) && price > 0 && 1 / price >= band.min - EPS && 1 / price <= band.max + EPS;

/**
 * MAKER placement authority (CURRENT book only):
 *   limit = floor_to_tick(min(current best bid, current best ask - tick, ceiling))
 * The current best bid is the placement authority; an empty/wide spread is never jumped with `ask - tick` alone.
 * Fails closed (limit null + reason) on a missing tick/bid/ask, a crossed book, or a non-passive result.
 */
export function evaluateMakerPlacement(bestBid: number | null, bestAsk: number | null, tick: number | null | undefined, ceiling: number):
  { limit: number | null; reason: string | null } {
  const fail = (reason: string) => ({ limit: null, reason });
  if (!num(tick) || !(tick > 0) || tick >= 1) return fail("TICK_UNKNOWN");
  if (!num(bestAsk) || !(bestAsk > 0)) return fail("MAKER_BEST_ASK_MISSING");
  if (!num(bestBid) || !(bestBid > 0)) return fail("MAKER_BEST_BID_MISSING");
  if (bestBid >= bestAsk - EPS) return fail("MAKER_BOOK_CROSSED");
  if (!num(ceiling) || !(ceiling > 0)) return fail("MAKER_CEILING_INVALID");
  const limit = r6(Math.floor(Math.min(bestBid, bestAsk - tick, ceiling) / tick + EPS) * tick);
  if (!(limit > 0)) return fail("MAKER_LIMIT_NOT_POSITIVE");
  if (!(limit < bestAsk - EPS)) return fail("MAKER_LIMIT_NOT_BELOW_ASK");
  return { limit, reason: null };
}

/**
 * MAKER price proof: the limit PREMVP would bid must itself be authorised (<= the price ceiling, <= hard cap) and
 * its decimal odds must lie inside the canonical family band. Fails closed; never reads the current ask.
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

  // Event-level gates only: family admission, exposure, deadline, fresh current book. No T30 / reference gate.
  const gate = !input.supportFamilyEligible ? "NOT_SUPPORT_ELIGIBLE"
    : input.exposureExists ? "EXPOSURE_EXISTS"
    : !input.beforeLatestEntry ? "AFTER_LATEST_ENTRY"
    : !t10.bookFresh || !num(ask) ? "T10_BOOK_NOT_FRESH" : null;

  if (gate) {
    taker.rejectReason = maker.rejectReason = gate;
  } else {
    // ---- TAKER: current executable ask in band + full-stake ladder + fee evidence + cost within the hard cap. ----
    support.taker.SUPPORT_PRICE_IN_BAND = input.takerSupportEligible && priceInBand(ask, band);
    if (!support.taker.SUPPORT_PRICE_IN_BAND) taker.rejectReason = "TAKER_SUPPORT_PRICE_OUTSIDE_BAND";
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
          if (taker.effectiveCost <= cap + EPS) taker.eligible = true;
          else taker.rejectReason = "TAKER_EFFECTIVE_COST_ABOVE_CAP";
        }
      }
    }
    // ---- MAKER: current best bid + current best ask + tick; limit = floor_to_tick(min(bid, ask - tick, cap)). ----
    const placement = evaluateMakerPlacement(t10.bestBid, ask, t10.tickSize, cap);
    if (placement.limit === null) maker.rejectReason = placement.reason;
    else {
      const limit = placement.limit;
      // MAKER support is proven on the price PREMVP would bid, never on the current ask.
      support.maker.SUPPORT_PRICE = limit; support.maker.SUPPORT_DECIMAL_ODDS = oddsOf(limit);
      const proof = evaluateMakerSupportPrice(limit, cap, cap, band);
      support.maker.SUPPORT_PRICE_IN_BAND = proof.reason === "MAKER_SUPPORT_PRICE_OUTSIDE_BAND" ? false : proof.ok ? true : null;
      if (!proof.ok) maker.rejectReason = proof.reason;
      else if (num(t10.meaningfulBestBid) && limit < t10.meaningfulBestBid - EPS) maker.rejectReason = "MAKER_BELOW_MEANINGFUL_BID";
      else {
        maker.eligible = true;
        maker.limitPrice = limit;
        maker.ticksToAsk = Math.round(((ask as number) - limit) / (t10.tickSize as number));
      }
    }
  }

  // A fair only counts for the exact token + event it was resolved for, and must be a probability in (0,1).
  const rawFair = input.externalFair ?? null;
  const fair = rawFair?.status === "PROVEN"
    && rawFair.candidateTokenId === input.identity.tokenId && rawFair.physicalEventId === input.identity.physicalEventId
    && num(rawFair.fairProbability) && rawFair.fairProbability > 0 && rawFair.fairProbability < 1 ? rawFair : null;
  const takerEdge = taker.eligible ? takerProvenEdge(fair, taker.effectiveCost) : null;
  const makerEdge = maker.eligible ? makerPriceEdge(fair, maker.limitPrice) : null;
  const edgeStatus = (e: number | null): EdgeStatus => e === null ? "VALUE_REFERENCE_UNPROVEN" : e > EPS ? "POSITIVE_EDGE" : "NON_POSITIVE_EDGE";
  const value: ValueEvidence = {
    fair_status: fair?.status === "PROVEN" ? "PROVEN" : "VALUE_REFERENCE_UNPROVEN",
    fair_probability: fair?.status === "PROVEN" ? fair.fairProbability : null,
    fair_source: fair?.status === "PROVEN" ? fair.source : null,
    fair_observed_at: fair?.status === "PROVEN" ? fair.observedAtIso : null,
    fair_reason: fair?.reason ?? (rawFair?.status === "PROVEN" ? "EXTERNAL_FAIR_IDENTITY_MISMATCH" : rawFair?.reason ?? "NO_EXTERNAL_FAIR_CARRIER"),
    taker_proven_edge: takerEdge, maker_price_edge: makerEdge,
    taker_edge_status: edgeStatus(takerEdge), maker_edge_status: edgeStatus(makerEdge),
  };

  const shadowAction: ShadowAction = taker.eligible ? "TAKER_FIRST" : maker.eligible ? "MAKER_FIRST" : "SKIP";
  const reason = shadowAction === "SKIP" ? (gate ?? maker.rejectReason ?? "NO_SAFE_ACTION")
    : shadowAction === "TAKER_FIRST" ? "SAFE_TAKER" : "SAFE_MAKER";
  // Frozen price ceiling of the evaluated action, from the CURRENT book only: TAKER = hard cap; MAKER = maker limit.
  const pBuyMax = taker.eligible ? cap : maker.eligible ? maker.limitPrice : null;
  const priceAuthority: PolicyEvaluation["priceAuthority"] = {
    version: PRICE_AUTHORITY_VERSION, source: pBuyMax === null ? null : "T10_CURRENT_BOOK", available: pBuyMax !== null, pBuyMax,
    reason: gate ?? (taker.eligible ? "T10_CURRENT_BOOK_TAKER_HARD_CAP" : maker.eligible ? "T10_CURRENT_BOOK_MAKER_LIMIT" : "NO_SAFE_CURRENT_BOOK_ACTION"),
  };
  return {
    policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION,
    candidateIdentity: { ...input.identity, family: input.family },
    referenceStatus: status, priceAuthority, t30: t30Telemetry(input.identity, input.t30Evidence),
    support, taker, maker, value, shadowAction, reason,
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

/**
 * TAKER ranking: 1) proven edge DESC (fair - fee-inclusive effective cost; unproven last), 2) lower effective cost
 * ONLY as tie-break, 3) deeper full-stake depth, 4) fresher book, 5) identity. Cheaper never wins on price alone.
 */
export function compareTaker(a: Ranked, b: Ranked): number {
  let n = cmpDesc(a.evaluation.value.taker_proven_edge, b.evaluation.value.taker_proven_edge);
  if (n === 0) n = cmpAsc(a.evaluation.taker.effectiveCost, b.evaluation.taker.effectiveCost);
  if (n === 0) n = cmpDesc(a.evaluation.taker.depthUsd, b.evaluation.taker.depthUsd);
  if (n === 0) n = cmpDesc(a.input.t10.observedAtMs, b.input.t10.observedAtMs);
  return finish(n, a, b);
}

/** MAKER ranking: 1) maker price edge DESC (unproven last), then fewer ticks to the current ask, depth, freshness, identity. No fill probability. */
export function compareMaker(a: Ranked, b: Ranked): number {
  let n = cmpDesc(a.evaluation.value.maker_price_edge, b.evaluation.value.maker_price_edge);
  if (n === 0) n = cmpAsc(a.evaluation.maker.ticksToAsk, b.evaluation.maker.ticksToAsk);
  if (n === 0) n = cmpDesc(a.input.t10.askDepthUsd ?? null, b.input.t10.askDepthUsd ?? null);
  if (n === 0) n = cmpDesc(a.input.t10.observedAtMs, b.input.t10.observedAtMs);
  return finish(n, a, b);
}

/**
 * Shadow VALUE decision (telemetry; live_authority=false). TAKER > MAKER; only a PROVEN POSITIVE edge can be a
 * value action. No proven fair => SKIP / VALUE_REFERENCE_UNPROVEN: cheapest price is never presented as value.
 */
export type ValueDecision = {
  action: ShadowAction;
  selected: PolicyEvaluation | null;
  /** Edge of the selected action (taker_proven_edge or maker_price_edge). */
  provenEdge: number | null;
  edgeStatus: EdgeStatus;
  reason: "MAX_PROVEN_TAKER_EDGE" | "MAX_PROVEN_MAKER_EDGE" | "VALUE_REFERENCE_UNPROVEN" | "NO_POSITIVE_PROVEN_EDGE" | "NO_SAFE_ACTION_IN_SUPPORTED_UNIVERSE" | string;
};

export type EventDecision = {
  policyVersion: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  physicalEventId: string | null;
  action: ShadowAction;
  selected: PolicyEvaluation | null;
  /** Best safe Maker alternative, retained even when TAKER wins (later calibration). */
  bestMakerAlternative: PolicyEvaluation | null;
  evaluations: PolicyEvaluation[];
  reason: string;
  /** Why the executable winner won: MAX_PROVEN_EDGE, or EXECUTION_ORDER_ONLY_VALUE_UNPROVEN (cost order is not value). */
  rankingReason: "MAX_PROVEN_EDGE" | "EXECUTION_ORDER_ONLY_VALUE_UNPROVEN" | "NONE";
  value: ValueDecision;
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
      action: "SKIP", selected: null, bestMakerAlternative: null, evaluations: ranked.map((r) => r.evaluation), reason: eventGate,
      rankingReason: "NONE",
      value: { action: "SKIP", selected: null, provenEdge: null, edgeStatus: "VALUE_REFERENCE_UNPROVEN", reason: eventGate } };
  }
  const takers = ranked.filter((r) => r.evaluation.taker.eligible).sort(compareTaker);
  const makers = ranked.filter((r) => r.evaluation.maker.eligible).sort(compareMaker);
  const winner = takers[0] ?? makers[0] ?? null;
  const action: ShadowAction = takers[0] ? "TAKER_FIRST" : makers[0] ? "MAKER_FIRST" : "SKIP";
  const selected = winner ? { ...winner.evaluation, shadowAction: action,
    reason: action === "TAKER_FIRST" ? "BEST_SAFE_TAKER" : "BEST_SAFE_MAKER" } : null;
  const winnerEdge = takers[0] ? takers[0].evaluation.value.taker_proven_edge : makers[0]?.evaluation.value.maker_price_edge ?? null;
  const posTakers = takers.filter((r) => r.evaluation.value.taker_edge_status === "POSITIVE_EDGE");
  const posMakers = makers.filter((r) => r.evaluation.value.maker_edge_status === "POSITIVE_EDGE");
  const anyProven = [...takers, ...makers].some((r) => r.evaluation.value.fair_status === "PROVEN");
  const valueWinner = posTakers[0] ?? posMakers[0] ?? null;
  const valueAction: ShadowAction = posTakers[0] ? "TAKER_FIRST" : posMakers[0] ? "MAKER_FIRST" : "SKIP";
  const valueEdge = posTakers[0] ? posTakers[0].evaluation.value.taker_proven_edge : posMakers[0]?.evaluation.value.maker_price_edge ?? null;
  const value: ValueDecision = {
    action: valueAction,
    selected: valueWinner ? { ...valueWinner.evaluation, shadowAction: valueAction,
      reason: valueAction === "TAKER_FIRST" ? "MAX_PROVEN_TAKER_EDGE" : "MAX_PROVEN_MAKER_EDGE" } : null,
    provenEdge: valueEdge,
    edgeStatus: valueEdge === null ? "VALUE_REFERENCE_UNPROVEN" : "POSITIVE_EDGE",
    reason: valueWinner ? (valueAction === "TAKER_FIRST" ? "MAX_PROVEN_TAKER_EDGE" : "MAX_PROVEN_MAKER_EDGE")
      : !winner ? "NO_SAFE_ACTION_IN_SUPPORTED_UNIVERSE" : anyProven ? "NO_POSITIVE_PROVEN_EDGE" : "VALUE_REFERENCE_UNPROVEN",
  };
  if (!valueWinner && winner && !anyProven) value.edgeStatus = "VALUE_REFERENCE_UNPROVEN";
  else if (!valueWinner && winner) value.edgeStatus = "NON_POSITIVE_EDGE";
  return {
    policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION,
    physicalEventId: candidates[0]?.identity.physicalEventId ?? null,
    rankingReason: !winner ? "NONE" : winnerEdge !== null ? "MAX_PROVEN_EDGE" : "EXECUTION_ORDER_ONLY_VALUE_UNPROVEN",
    value,
    action, selected,
    bestMakerAlternative: makers[0]?.evaluation ?? null,
    evaluations: ranked.map((r) => r.evaluation),
    reason: action === "SKIP" ? "NO_SAFE_ACTION_IN_SUPPORTED_UNIVERSE" : selected!.reason,
  };
}
