// T10_ECONOMIC_ACTION_POLICY_FREEZE_V1 — SHADOW-ONLY economic action policy.
//
// Pure, deterministic: for ONE reserved physical event, evaluates every supported
// T10 sibling candidate and returns at most ONE shadow economic action
// (TAKER_FIRST | MAKER_FIRST | SKIP). No Queue write, no runtime side effect, not
// read by any money path. Architecture:
//   docs/ai-context/control-plane/T10_REBALANCE_PRICE_DISCIPLINE_AND_EXECUTION_ARCHITECTURE_V1.md
//
// Three authorities are kept separate:
//   BET-SELECTION  = supported family + existing B support band (V1 boundary)
//                    + exactMarketReference status (STRONG / WEAK / UNRESOLVED).
//   PRICE          = T30_BID_ANCHOR_V1: P_BUY_MAX = min(T30 best_bid, 0.54) of the
//                    identity-exact T30 witness ACCEPTED by the canonical reference
//                    engine. Never derived from the current T10 ask. Market price
//                    evidence only — not a probability.
//   EXECUTION      = current T10 book (freshness/identity), full-stake ask levels,
//                    tick size, fee evidence. Missing evidence is reported, never
//                    fabricated.
import { evaluateExactMarketReference, type ExactMarketIdentity, type ExactMarketReference, type ReferenceEvidence } from "./exactMarketReference";
import { fullStakeExecutableVwap } from "./eventExecutionQueue";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "./executorQueueTypes";
import { compareExactIdentity } from "./exactIdentityOrder";
import { bStrategySupportRegion, classifyReservationMarketPhase } from "./reservationMarketBaseline";

export const T10_ECONOMIC_ACTION_POLICY_VERSION = "T10_ECONOMIC_ACTION_POLICY_SHADOW_V1" as const;
export const PRICE_AUTHORITY_VERSION = "T30_BID_ANCHOR_V1" as const;
export const SHADOW_STAKE_USD = QUEUE_DEFAULT_STAKE_USD;
const EPS = 1e-9;
const round8 = (v: number) => Math.round(v * 1e8) / 1e8;

export type ShadowAction = "TAKER_FIRST" | "MAKER_FIRST" | "SKIP";
export type GuardState = "PASS" | "FAIL" | "NOT_PROVEN";

export type PolicyCandidateInput = {
  target: ExactMarketIdentity;
  family: string | null;
  marketSlug?: string | null;
  /** Exact-market reference evidence, as passed to evaluateExactMarketReference. */
  evidence: readonly ReferenceEvidence[];
  execution: {
    /** Full T10 ask ladder for the exact token; null when no carrier persisted it. */
    askLevels: readonly { price: number; size: number }[] | null;
    tickSize: number | null;
    /** True only when an authoritative carrier proves the taker fee for this order is zero. */
    takerFeeZeroProven: boolean;
    /** Best bid proven non-dust by an authoritative rule; null = semantics unavailable. */
    meaningfulBestBid: number | null;
  };
  context: { beforeLatestEntry: boolean; existingExposure: boolean };
};

export type PolicyCandidateDecision = {
  candidateIdentity: ExactMarketIdentity;
  family: string | null;
  marketSlug: string | null;
  referenceStatus: ExactMarketReference["status"];
  referenceReason: string;
  priceAuthorityVersion: typeof PRICE_AUTHORITY_VERSION;
  priceAuthoritySource: "T30_BOOK_BEST_BID" | null;
  pBuyMax: number | null;
  currentBid: number | null;
  currentAsk: number | null;
  inSupportBand: boolean;
  taker: {
    eligible: boolean; effectiveCost: number | null; rawVwap: number | null; depthUsd: number | null;
    feeEvidence: "ZERO_PROVEN" | "UNAVAILABLE"; priceAdvantage: number | null; rejectReason: string | null;
  };
  maker: {
    eligible: boolean; limitPrice: number | null; ticksToAsk: number | null; priceCushion: number | null;
    meaningfulBidGuard: GuardState; rejectReason: string | null;
  };
  /** First gate that blocked this candidate (null when an action is available). */
  reason: string | null;
};

export type EventPolicyDecision = {
  version: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  shadowAction: ShadowAction;
  selected: PolicyCandidateDecision | null;
  bestTaker: PolicyCandidateDecision | null;
  /** Always reported, even when TAKER wins, so future data can compare modes. */
  bestMaker: PolicyCandidateDecision | null;
  candidates: PolicyCandidateDecision[];
  reason: string;
};

const exact = (a: ExactMarketIdentity, b: ExactMarketIdentity) =>
  a.physicalEventId === b.physicalEventId && a.conditionId === b.conditionId && a.tokenId === b.tokenId && a.side === b.side;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function currentBook(target: ExactMarketIdentity, evidence: readonly ReferenceEvidence[]) {
  const t10 = evidence.find((e) => e.source === "T10_BOOK" && exact(e.identity, target));
  if (!t10) return { bid: null, ask: null, fresh: false };
  const start = t10.eventStartIso ?? "";
  const observed = Date.parse(t10.observedAt ?? "");
  const fresh = t10.observationPhase === "T_MINUS_10" && t10.captureComplete === true && t10.fetchStatus === "SUCCESS" &&
    Number.isFinite(observed) && classifyReservationMarketPhase(start, observed) === "T_MINUS_10";
  return { bid: finite(t10.bestBid) ? t10.bestBid : null, ask: finite(t10.bestAsk) ? t10.bestAsk : null, fresh };
}

export function evaluatePolicyCandidate(input: PolicyCandidateInput): PolicyCandidateDecision {
  const { target, evidence, execution, context } = input;
  const ref = evaluateExactMarketReference(target, evidence);
  // Price authority: only the T30 witness the canonical engine accepted (STRONG/WEAK always
  // list accepted sources; the accepted T30 is the first identity-exact T30_BOOK item).
  const t30 = ref.status !== "UNRESOLVED" && ref.sources_used.includes("T30_BOOK")
    ? evidence.find((e) => e.source === "T30_BOOK" && exact(e.identity, target)) : undefined;
  const pBuyMax = t30 && finite(t30.bestBid) ? Math.min(t30.bestBid, QUEUE_MAX_ENTRY_PRICE) : null;
  const book = currentBook(target, evidence);
  const region = bStrategySupportRegion(input.family ?? "");
  const odds = book.ask && book.ask > 0 ? 1 / book.ask : null;
  const inSupportBand = !!region && odds !== null && odds >= region.min - EPS && odds <= region.max + EPS;

  // Shared gates, in order. The first failure is the candidate reason.
  const shared: [boolean, string][] = [
    [ref.status !== "UNRESOLVED", `REFERENCE_UNRESOLVED:${ref.reason}`],
    [pBuyMax !== null && pBuyMax > 0, "PRICE_AUTHORITY_MISSING_NO_ACCEPTED_T30_WITNESS"],
    [inSupportBand, "OUTSIDE_V1_SUPPORT_BAND"],
    [book.fresh, "CURRENT_BOOK_NOT_FRESH_OR_NOT_EXACT"],
    [book.ask !== null && book.ask > 0 && book.ask < 1, "NO_EXECUTABLE_ASK"],
    [context.beforeLatestEntry, "LATEST_ENTRY_PASSED"],
    [!context.existingExposure, "EXISTING_EXPOSURE"],
  ];
  const sharedFail = shared.find(([ok]) => !ok)?.[1] ?? null;
  const ask = book.ask as number;

  // ---- TAKER: STRONG only; full-stake cost must be proven <= P_BUY_MAX. ----
  const taker: PolicyCandidateDecision["taker"] = {
    eligible: false, effectiveCost: null, rawVwap: null, depthUsd: null,
    feeEvidence: execution.takerFeeZeroProven ? "ZERO_PROVEN" : "UNAVAILABLE", priceAdvantage: null, rejectReason: null,
  };
  if (sharedFail) taker.rejectReason = sharedFail;
  else if (ref.status !== "STRONG") taker.rejectReason = "TAKER_REQUIRES_STRONG_REFERENCE";
  else if (ask > QUEUE_MAX_ENTRY_PRICE + EPS) taker.rejectReason = "TAKER_ASK_ABOVE_HARD_CAP";
  else if (ask > (pBuyMax as number) + EPS) taker.rejectReason = "TAKER_ASK_ABOVE_P_BUY_MAX"; // VWAP >= best ask
  else if (!execution.askLevels) taker.rejectReason = "TAKER_FULL_STAKE_ASK_LEVELS_UNAVAILABLE";
  else {
    const limit = Math.min(pBuyMax as number, QUEUE_MAX_ENTRY_PRICE);
    taker.depthUsd = round8(execution.askLevels.filter((l) => l.price > 0 && l.size > 0 && l.price <= limit + EPS)
      .reduce((s, l) => s + l.price * l.size, 0));
    const vwap = fullStakeExecutableVwap(execution.askLevels, limit + EPS, SHADOW_STAKE_USD);
    taker.rawVwap = vwap === null ? null : round8(vwap);
    if (vwap === null) taker.rejectReason = "TAKER_INSUFFICIENT_DEPTH_AT_OR_BELOW_P_BUY_MAX";
    else if (!execution.takerFeeZeroProven) taker.rejectReason = "TAKER_FEE_EVIDENCE_UNAVAILABLE";
    else {
      taker.effectiveCost = round8(vwap);
      if (taker.effectiveCost > (pBuyMax as number) + EPS) taker.rejectReason = "TAKER_EFFECTIVE_COST_ABOVE_P_BUY_MAX";
      else {
        taker.eligible = true;
        taker.priceAdvantage = round8((pBuyMax as number) - taker.effectiveCost);
      }
    }
  }

  // ---- MAKER_FIRST: limit priced from P_BUY_MAX, never from bestBid + tick. ----
  const maker: PolicyCandidateDecision["maker"] = {
    eligible: false, limitPrice: null, ticksToAsk: null, priceCushion: null,
    meaningfulBidGuard: execution.meaningfulBestBid === null ? "NOT_PROVEN" : "PASS", rejectReason: null,
  };
  const tick = execution.tickSize;
  if (sharedFail) maker.rejectReason = sharedFail;
  else if (tick === null || !(tick > 0) || tick >= 1) maker.rejectReason = "MAKER_TICK_UNAVAILABLE_PRE_QUEUE";
  else {
    const raw = Math.min(pBuyMax as number, ask - tick, QUEUE_MAX_ENTRY_PRICE);
    const limit = round8(Math.floor(raw / tick + 1e-6) * tick);
    if (!(limit > 0)) maker.rejectReason = "MAKER_LIMIT_NOT_POSITIVE";
    else if (!(limit < ask - EPS)) maker.rejectReason = "MAKER_LIMIT_NOT_BELOW_ASK";
    else if (limit > QUEUE_MAX_ENTRY_PRICE + EPS) maker.rejectReason = "MAKER_LIMIT_ABOVE_HARD_CAP";
    else if (execution.meaningfulBestBid !== null && limit < execution.meaningfulBestBid - EPS) {
      maker.meaningfulBidGuard = "FAIL";
      maker.rejectReason = "MAKER_LIMIT_BELOW_MEANINGFUL_BEST_BID";
    } else {
      maker.eligible = true;
      maker.limitPrice = limit;
      maker.ticksToAsk = Math.round((ask - limit) / tick);
      maker.priceCushion = round8((pBuyMax as number) - limit);
    }
    if (!maker.eligible) maker.limitPrice = null;
  }

  return {
    candidateIdentity: target, family: input.family, marketSlug: input.marketSlug ?? null,
    referenceStatus: ref.status, referenceReason: ref.reason,
    priceAuthorityVersion: PRICE_AUTHORITY_VERSION, priceAuthoritySource: pBuyMax !== null ? "T30_BOOK_BEST_BID" : null,
    pBuyMax: pBuyMax === null ? null : round8(pBuyMax), currentBid: book.bid, currentAsk: book.ask, inSupportBand,
    taker, maker,
    reason: taker.eligible || maker.eligible ? null : sharedFail ?? maker.rejectReason ?? taker.rejectReason,
  };
}

const identityOrder = (a: PolicyCandidateDecision, b: PolicyCandidateDecision) =>
  compareExactIdentity({ condition_id: a.candidateIdentity.conditionId, token_id: a.candidateIdentity.tokenId },
    { condition_id: b.candidateIdentity.conditionId, token_id: b.candidateIdentity.tokenId }) ||
  a.candidateIdentity.side.localeCompare(b.candidateIdentity.side);

/** TAKER rank: larger EXECUTION_PRICE_ADVANTAGE_VS_ANCHOR, then identity. Family never ranks. */
export function compareTaker(a: PolicyCandidateDecision, b: PolicyCandidateDecision): number {
  return (b.taker.priceAdvantage ?? -Infinity) - (a.taker.priceAdvantage ?? -Infinity) || identityOrder(a, b);
}

/** MAKER rank: STRONG first, larger price cushion, fewer ticks to ask, then identity. Family never ranks. */
export function compareMaker(a: PolicyCandidateDecision, b: PolicyCandidateDecision): number {
  const strength = (d: PolicyCandidateDecision) => (d.referenceStatus === "STRONG" ? 0 : 1);
  return strength(a) - strength(b) ||
    (b.maker.priceCushion ?? -Infinity) - (a.maker.priceCushion ?? -Infinity) ||
    (a.maker.ticksToAsk ?? Infinity) - (b.maker.ticksToAsk ?? Infinity) ||
    identityOrder(a, b);
}

/** One reserved physical event -> at most one shadow economic action. */
export function evaluateEventPolicy(inputs: readonly PolicyCandidateInput[]): EventPolicyDecision {
  const events = new Set(inputs.map((i) => i.target.physicalEventId));
  if (events.size > 1) throw new Error("EVENT_POLICY_MIXED_PHYSICAL_EVENTS");
  const candidates = inputs.map(evaluatePolicyCandidate);
  const bestTaker = candidates.filter((c) => c.taker.eligible).sort(compareTaker)[0] ?? null;
  const bestMaker = candidates.filter((c) => c.maker.eligible).sort(compareMaker)[0] ?? null;
  const base = { version: T10_ECONOMIC_ACTION_POLICY_VERSION, bestTaker, bestMaker, candidates };
  if (bestTaker) return { ...base, shadowAction: "TAKER_FIRST", selected: bestTaker, reason: "BEST_SAFE_TAKER" };
  if (bestMaker) return { ...base, shadowAction: "MAKER_FIRST", selected: bestMaker, reason: "BEST_SAFE_MAKER_NO_SAFE_TAKER" };
  return { ...base, shadowAction: "SKIP", selected: null, reason: candidates.length ? "NO_SAFE_ACTION" : "NO_CANDIDATES" };
}
