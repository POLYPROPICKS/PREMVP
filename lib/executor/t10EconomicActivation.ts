// T10_EXACT_MARKET_EXECUTION_EVIDENCE_AND_MONEY_ACTIVATION_V1
//
// Wires the frozen T10 economic action policy (t10EconomicActionPolicy.ts, semantics unchanged)
// into the PREMVP final-rebalance decision, behind ONE rollback switch:
//
//   T10_ECONOMIC_ACTION_ACTIVATION=ON  -> this module decides the event's single action.
//   anything else (default)            -> released B priority + LIVE_GUARD, byte-for-byte unchanged.
//
// Authoritative execution evidence (all read-only, exact token, fetched at decision time):
//   ask ladder / best bid / best ask  CLOB GET /book            (fetchOrderBook -> ParsedOrderBook.asks)
//   tick size / minimum order size    same /book payload        (tick_size / min_order_size, no hardcoded tick)
//   taker fee schedule                Gamma GET /markets?clob_token_ids=  (fetchTokenFeeSchedule)
//   exposure                          existing Queue authority  (non-terminal Queue row for the Reservation)
//   latest entry                      nightWindow.latestEntryIso (canonical, unchanged)
//   P_BUY_MAX                         T30_EXACT_BID_ANCHOR_V1 over the persisted, complete T_MINUS_30 capture
//
// TAKER economic cost (Polymarket documented taker fee, USDC, per fill):
//   fee_i          = ceil_1e-5( shares_i * rate * p_i * (1 - p_i) )
//   effective_cost = (stake_usd + sum fee_i) / sum shares_i            (USDC per share acquired)
//   per-share bound at fill price p: p * (1 + rate * (1 - p))  -- strictly increasing on (0, 1).
//
// TAKER execution limit (frozen as the Queue max_entry_price, the only price Ireland may pay):
//   L = the highest on-tick price with L * (1 + rate * (1 - L)) <= P_BUY_MAX and L <= 0.54.
//   Every share filled at <= L therefore costs <= P_BUY_MAX after fees, even if the book moves
//   between this decision and the venue. The full $2.50 stake must be fillable from levels <= L.
//   The policy is evaluated on exactly that executable ladder (asks <= L).
//
// MAKER limit (unchanged policy formula): floor_to_tick(min(P_BUY_MAX, current_ask - tick, 0.54)).
//   Never bestBid + tick. No fill probability anywhere.
//
// Ireland boundary: the published Queue contract (mapQueueRowToIrelandCandidate) emits every row as
// execution_mode "TAKER" / TAKER_ATTEMPT_1 with price_cap = max_entry_price. TAKER_FIRST is consumable
// through that contract. A primary MAKER_FIRST instruction is NOT expressible in it, so a MAKER_FIRST
// decision is never written to the Queue (IRELAND_PRIMARY_MAKER_CONTRACT_SUPPORTED = false) and is never
// translated into a TAKER.
import { getBestBidAsk, computeSpread } from "@/lib/liquidity/orderbookMath";
import type { FetchOrderBookResult } from "@/lib/liquidity/types";
import type { TokenFeeScheduleResult } from "@/lib/liquidity/polymarketClient";
import { evaluateExactMarketReference, type ExactMarketIdentity, type ReferenceEvidence } from "./exactMarketReference";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "./executorQueueTypes";
import { latestEntryIso } from "./nightWindow";
import { isBSupportEligible, type FinalT3MarketObservation } from "./reservationMarketBaseline";
import {
  decideEventAction,
  PRICE_AUTHORITY_VERSION,
  t30ExactBidAnchor,
  T10_ECONOMIC_ACTION_POLICY_VERSION,
  type AskLevel,
  type EventDecision,
  type PolicyCandidateInput,
  type PolicyEvaluation,
} from "./t10EconomicActionPolicy";

export const T10_ECONOMIC_ACTIVATION_ENV = "T10_ECONOMIC_ACTION_ACTIVATION" as const;
export const T10_EXECUTION_POLICY_VERSION = "T10_ECONOMIC_ACTION_EXECUTION_V1" as const;
export const T10_ECONOMIC_TAKER_SELECTION_REASON = "T10_ECONOMIC_ACTION_TAKER_FIRST_V1" as const;
/** Published Ireland Queue contract has no primary-maker instruction (see header). */
export const IRELAND_PRIMARY_MAKER_CONTRACT_SUPPORTED = false as const;

/** The single rollback switch. Exactly "ON" activates; unset / anything else = released behaviour. */
export function isT10EconomicActivationOn(env: Record<string, string | undefined> = process.env): boolean {
  return env[T10_ECONOMIC_ACTIVATION_ENV]?.trim() === "ON";
}

const EPS = 1e-9;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const key = (i: { conditionId: string; tokenId: string; side: string }) => `${i.conditionId}|${i.tokenId}|${i.side}`;

// ── fee math (pure) ─────────────────────────────────────────────────────────

/** USDC taker fee for `shares` filled at `price`, rounded UP to the provider's 1e-5 USDC precision. */
export function takerFeeUsd(shares: number, price: number, rate: number): number {
  const raw = shares * rate * price * (1 - price);
  return raw <= 0 ? 0 : Math.ceil(raw * 1e5 - EPS) / 1e5;
}

/** Highest on-tick price whose fee-inclusive per-share cost stays <= pBuyMax (and <= cap). */
export function takerPriceLimit(pBuyMax: number, rate: number, tick: number, cap: number): number | null {
  if (![pBuyMax, rate, tick, cap].every(num) || !(tick > 0) || tick >= 1 || rate < 0 || !(pBuyMax > 0)) return null;
  for (let k = Math.floor(Math.min(pBuyMax, cap) / tick + EPS); k >= 1; k--) {
    const p = r6(k * tick);
    if (p * (1 + rate * (1 - p)) <= pBuyMax + EPS) return p;
  }
  return null;
}

export type TakerFill = { filled: boolean; shares: number; rawVwap: number | null; feeUsd: number | null; effectiveCost: number | null; depthUsd: number };

/** Walk asks (ascending) priced <= limit for the full USD stake; never approximates with bestAsk. */
export function walkTakerFill(levels: readonly AskLevel[], stakeUsd: number, limit: number, rate: number): TakerFill {
  const usable = levels.filter((l) => num(l.price) && num(l.sizeShares) && l.price > 0 && l.sizeShares > 0 && l.price <= limit + EPS)
    .sort((a, b) => a.price - b.price);
  const depthUsd = r6(usable.reduce((s, l) => s + l.price * l.sizeShares, 0));
  let remaining = stakeUsd;
  let shares = 0;
  let fee = 0;
  for (const l of usable) {
    const take = Math.min(remaining, l.price * l.sizeShares);
    const s = take / l.price;
    shares += s;
    fee += takerFeeUsd(s, l.price, rate);
    remaining -= take;
    if (remaining <= EPS) break;
  }
  const filled = remaining <= EPS && shares > 0;
  return filled
    ? { filled, shares, rawVwap: r6(stakeUsd / shares), feeUsd: r6(fee), effectiveCost: r6((stakeUsd + fee) / shares), depthUsd }
    : { filled, shares, rawVwap: null, feeUsd: null, effectiveCost: null, depthUsd };
}

/** Policy MAKER formula, recomputed mechanically at re-verification with the SAME frozen P_BUY_MAX. */
export function makerLimitPrice(pBuyMax: number, ask: number, tick: number, cap: number): number | null {
  if (![pBuyMax, ask, tick, cap].every(num) || !(tick > 0) || tick >= 1) return null;
  const limit = r6(Math.floor(Math.min(pBuyMax, ask - tick, cap) / tick + EPS) * tick);
  return limit > 0 && limit < ask - EPS && limit <= cap + EPS ? limit : null;
}

// ── execution evidence ──────────────────────────────────────────────────────

/** Normalized exact-token execution evidence. Scalars only are ever persisted (never the ladder). */
export type ExecutionEvidence = {
  tokenId: string;
  observedAtIso: string;
  latencyMs: number | null;
  ok: boolean;
  errorCode: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  tickSize: number | null;
  minimumOrderSize: number | null;
  providerTimestampMs: number | null;
  /** In memory only. */
  asks: AskLevel[];
  capDepthUsd: number | null;
};

export function executionEvidenceFromBook(tokenId: string, result: FetchOrderBookResult | null, observedAtIso: string): ExecutionEvidence {
  const book = result?.ok && result.book && result.book.tokenId === tokenId ? result.book : null;
  const latency = result && num(result.latencyMs) && result.latencyMs >= 0 ? result.latencyMs : null;
  const { bestBid, bestAsk } = getBestBidAsk(book);
  const asks = book ? book.asks.map((l) => ({ price: l.price, sizeShares: l.size })) : [];
  return {
    tokenId, observedAtIso, latencyMs: latency,
    ok: book !== null && latency !== null,
    errorCode: book ? (latency === null ? "BOOK_REFRESH_NOT_FRESH" : null)
      : result?.ok && result.book ? "BOOK_TOKEN_MISMATCH" : result?.errorCode ?? "BOOK_UNAVAILABLE",
    bestBid, bestAsk, spread: book && computeSpread(book) !== null ? r6(computeSpread(book) as number) : null,
    tickSize: book?.tickSize ?? null, minimumOrderSize: book?.minimumOrderSize ?? null,
    providerTimestampMs: book?.providerTimestampMs ?? null,
    asks,
    capDepthUsd: book ? r6(asks.filter((l) => l.price <= QUEUE_MAX_ENTRY_PRICE + EPS).reduce((s, l) => s + l.price * l.sizeShares, 0)) : null,
  };
}

// ── event decision ──────────────────────────────────────────────────────────

export type ActivationDeps = {
  fetchExactTokenOrderbook: (tokenId: string) => Promise<FetchOrderBookResult>;
  fetchTokenFeeSchedule: (tokenId: string) => Promise<TokenFeeScheduleResult>;
};

export type CandidateExecution = {
  identity: ExactMarketIdentity;
  family: string;
  marketSlug: string | null;
  evidence: ExecutionEvidence | null;
  fee: TokenFeeScheduleResult | null;
  takerLimit: number | null;
  t30ObservationKey: string | null;
};

export type T10EconomicEventDecision = {
  decision: EventDecision;
  latestEntryIso: string;
  beforeLatestEntry: boolean;
  exposureExists: boolean;
  t30SourceAvailable: boolean;
  executions: Map<string, CandidateExecution>;
};

function referenceEvidence(row: FinalT3MarketObservation, source: "T10_BOOK" | "T30_BOOK"): ReferenceEvidence {
  return {
    source, observationKey: `${source}:${row.capture_run_id}:${row.token_id}:${row.side}`,
    identity: { physicalEventId: row.physical_event_id, conditionId: row.condition_id, tokenId: row.token_id, side: row.side },
    observationPhase: row.observation_phase,
    // Both universes come from readCompletedPhaseUniverse, which rejects any non-COMPLETE run.
    captureComplete: true,
    fetchStatus: row.orderbook_fetch_status,
    bestBid: toNum(row.best_bid), bestAsk: toNum(row.best_ask),
    observedAt: row.observed_at ?? null, eventStartIso: row.event_start_iso,
  };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * All supported T10 siblings of ONE reserved physical event compete economically. Returns exactly one
 * action (TAKER_FIRST | MAKER_FIRST) or SKIP. Family priority is never consulted.
 */
export async function decideT10EconomicEvent(input: {
  physicalEventId: string;
  eventStartIso: string;
  t10Universe: readonly FinalT3MarketObservation[];
  t30Universe: readonly FinalT3MarketObservation[] | null;
  nowMs: number;
  exposureExists: boolean;
  deps: ActivationDeps;
  stakeUsd?: number;
  hardCap?: number;
}): Promise<T10EconomicEventDecision> {
  const stake = input.stakeUsd ?? QUEUE_DEFAULT_STAKE_USD;
  const cap = input.hardCap ?? QUEUE_MAX_ENTRY_PRICE;
  const latest = latestEntryIso(Date.parse(input.eventStartIso));
  const beforeLatestEntry = input.nowMs < Date.parse(latest);
  const t30ByKey = new Map<string, FinalT3MarketObservation[]>();
  for (const row of input.t30Universe ?? []) {
    const k = key({ conditionId: row.condition_id, tokenId: row.token_id, side: row.side });
    t30ByKey.set(k, [...(t30ByKey.get(k) ?? []), row]);
  }
  const base = input.t10Universe.map((row) => {
    const identity: ExactMarketIdentity = { physicalEventId: input.physicalEventId, conditionId: row.condition_id, tokenId: row.token_id, side: row.side };
    const t30Rows = t30ByKey.get(key(identity)) ?? [];
    const t30Evidence = t30Rows.length === 1 ? referenceEvidence(t30Rows[0], "T30_BOOK") : null;
    const evidence = [referenceEvidence(row, "T10_BOOK"), ...(t30Evidence ? [t30Evidence] : [])];
    const reference = evaluateExactMarketReference(identity, evidence);
    const priceAuthority = t30ExactBidAnchor(identity, t30Evidence, cap);
    const supportEligible = isBSupportEligible(row);
    const competes = supportEligible && reference.status !== "UNRESOLVED" && priceAuthority.available &&
      beforeLatestEntry && !input.exposureExists;
    return { row, identity, t30Evidence, reference, priceAuthority, supportEligible, competes };
  });

  const executions = new Map<string, CandidateExecution>();
  const competing = base.filter((b) => b.competes);
  const fetched = await mapLimited(competing, 5, async (b) => {
    let book: FetchOrderBookResult | null = null;
    try { book = await input.deps.fetchExactTokenOrderbook(b.identity.tokenId); } catch { book = null; }
    const evidence = executionEvidenceFromBook(b.identity.tokenId, book, new Date().toISOString());
    let fee: TokenFeeScheduleResult | null = null;
    if (b.reference.status === "STRONG") {
      try { fee = await input.deps.fetchTokenFeeSchedule(b.identity.tokenId); }
      catch { fee = { ok: false, tokenId: b.identity.tokenId, errorCode: "FEE_FETCH_THREW", latencyMs: 0 }; }
    }
    return { b, evidence, fee };
  });
  const byKey = new Map(fetched.map((f) => [key(f.b.identity), f]));

  const candidates: PolicyCandidateInput[] = base.map((b) => {
    const f = byKey.get(key(b.identity));
    const ev = f?.evidence ?? null;
    const fee = f?.fee ?? null;
    const pBuyMax = b.priceAuthority.pBuyMax;
    const takerLimit = fee?.ok && ev?.ok && num(ev.tickSize) && num(pBuyMax)
      ? takerPriceLimit(pBuyMax, fee.takerRate, ev.tickSize, cap) : null;
    let askLevels: AskLevel[] | null = null;
    let feeUsdForFullStake: number | null = null;
    if (ev?.ok) {
      if (!fee?.ok) askLevels = ev.asks;                       // -> TAKER_FEE_EVIDENCE_MISSING (or depth)
      else if (takerLimit !== null) {
        askLevels = ev.asks.filter((l) => l.price <= takerLimit + EPS);
        const walk = walkTakerFill(askLevels, stake, takerLimit, fee.takerRate);
        feeUsdForFullStake = walk.filled ? walk.feeUsd : null;
      }                                                         // fee ok but no tick/limit -> evidence missing
    }
    executions.set(key(b.identity), {
      identity: b.identity, family: b.row.canonical_market_family ?? "", marketSlug: b.row.market_slug ?? null,
      evidence: ev, fee, takerLimit, t30ObservationKey: b.t30Evidence?.observationKey ?? null,
    });
    return {
      identity: b.identity, family: b.row.canonical_market_family ?? "",
      supportEligible: b.supportEligible, reference: b.reference, t30Evidence: b.t30Evidence,
      t10: ev ? {
        bestBid: ev.bestBid, bestAsk: ev.bestAsk, bookFresh: ev.ok, observedAtMs: Date.parse(ev.observedAtIso),
        askLevels, feeUsdForFullStake, tickSize: ev.tickSize, askDepthUsd: ev.capDepthUsd,
      } : { bestBid: toNum(b.row.best_bid), bestAsk: toNum(b.row.best_ask), bookFresh: false, observedAtMs: null },
      stakeUsd: stake, hardCap: cap, beforeLatestEntry, exposureExists: input.exposureExists,
    };
  });

  const decision = candidates.length > 0 ? decideEventAction(candidates) : {
    policyVersion: T10_ECONOMIC_ACTION_POLICY_VERSION, physicalEventId: input.physicalEventId, action: "SKIP" as const,
    selected: null, bestMakerAlternative: null, evaluations: [], reason: "EMPTY_T10_UNIVERSE",
  };
  return { decision, latestEntryIso: latest, beforeLatestEntry, exposureExists: input.exposureExists,
    t30SourceAvailable: input.t30Universe !== null, executions };
}

// ── LIVE_GUARD re-verification of the FROZEN selected action ────────────────

export type FrozenExecutionContract = {
  execution_policy_version: typeof T10_EXECUTION_POLICY_VERSION;
  economic_policy_version: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  execution_mode: "TAKER_FIRST" | "MAKER_FIRST";
  price_authority_version: typeof PRICE_AUTHORITY_VERSION;
  price_authority_observation_id: string;
  p_buy_max: number;
  reference_status: string;
  physical_event_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  market_family: string;
  stake_usd: number;
  hard_price_cap: number;
  latest_entry_iso: string;
  execution_book_observed_at: string;
  execution_book_provider_timestamp_ms: number | null;
  execution_book_latency_ms: number | null;
  tick_size: number;
  minimum_order_size: number | null;
  spread_telemetry: number | null;
  taker: null | {
    price_limit: number;
    authorized_raw_vwap: number;
    authorized_effective_cost: number;
    authorized_fee_usd: number;
    full_stake_depth_usd_at_limit: number;
    fee_rate: number;
    fee_exponent: 1;
    fee_enabled: boolean;
    fee_type: string | null;
    fee_formula_version: string;
    fee_source: string;
    fee_observed_at: string;
  };
  maker: null | { maker_limit_price: number; maker_shares: number };
  activation_switch: typeof T10_ECONOMIC_ACTIVATION_ENV;
};

export type ReverifyResult =
  | { ok: true; contract: FrozenExecutionContract; evidence: ExecutionEvidence }
  | { ok: false; reason: string; contract: FrozenExecutionContract | null; evidence: ExecutionEvidence | null };

/**
 * Mechanical guard for the ALREADY-selected action. Re-fetches the SAME exact token; never reselects,
 * never changes token, never raises P_BUY_MAX. Spread is telemetry only.
 */
export async function reverifySelectedAction(input: {
  event: T10EconomicEventDecision;
  nowMs: number;
  exposureExists: boolean;
  fetchExactTokenOrderbook: (tokenId: string) => Promise<FetchOrderBookResult>;
  stakeUsd?: number;
  hardCap?: number;
}): Promise<ReverifyResult> {
  const stake = input.stakeUsd ?? QUEUE_DEFAULT_STAKE_USD;
  const cap = input.hardCap ?? QUEUE_MAX_ENTRY_PRICE;
  const { decision } = input.event;
  const sel: PolicyEvaluation | null = decision.selected;
  const fail = (reason: string, contract: FrozenExecutionContract | null = null, evidence: ExecutionEvidence | null = null): ReverifyResult =>
    ({ ok: false, reason, contract, evidence });
  if (decision.action === "SKIP" || !sel) return fail(`T10_ECON_SKIP:${decision.reason}`);
  const k = key(sel.candidateIdentity);
  const exec = input.event.executions.get(k);
  const pBuyMax = sel.priceAuthority.pBuyMax;
  if (!exec || !exec.evidence?.ok || !num(exec.evidence.tickSize) || !num(pBuyMax) || !exec.t30ObservationKey) {
    return fail("T10_ECON_FROZEN_EVIDENCE_INCOMPLETE");
  }
  if (input.exposureExists) return fail("T10_ECON_GUARD_EXPOSURE_EXISTS");
  if (!(input.nowMs < Date.parse(input.event.latestEntryIso))) return fail("T10_ECON_GUARD_AFTER_LATEST_ENTRY");

  let refreshed: FetchOrderBookResult | null = null;
  try { refreshed = await input.fetchExactTokenOrderbook(sel.candidateIdentity.tokenId); } catch { refreshed = null; }
  const ev = executionEvidenceFromBook(sel.candidateIdentity.tokenId, refreshed, new Date(input.nowMs).toISOString());
  if (!ev.ok) return fail(`T10_ECON_GUARD_BOOK_UNAVAILABLE:${ev.errorCode ?? "UNKNOWN"}`, null, ev);
  if (!num(ev.tickSize)) return fail("T10_ECON_GUARD_TICK_UNKNOWN", null, ev);
  if (Math.abs(ev.tickSize - exec.evidence.tickSize) > EPS) return fail("T10_ECON_GUARD_TICK_CHANGED", null, ev);
  if (!num(ev.bestAsk)) return fail("T10_ECON_GUARD_NO_ASK", null, ev);

  const common = {
    execution_policy_version: T10_EXECUTION_POLICY_VERSION, economic_policy_version: T10_ECONOMIC_ACTION_POLICY_VERSION,
    price_authority_version: PRICE_AUTHORITY_VERSION, price_authority_observation_id: exec.t30ObservationKey,
    p_buy_max: pBuyMax, reference_status: sel.referenceStatus,
    physical_event_id: sel.candidateIdentity.physicalEventId, condition_id: sel.candidateIdentity.conditionId,
    token_id: sel.candidateIdentity.tokenId, side: sel.candidateIdentity.side, market_family: sel.candidateIdentity.family,
    stake_usd: stake, hard_price_cap: cap, latest_entry_iso: input.event.latestEntryIso,
    execution_book_observed_at: ev.observedAtIso, execution_book_provider_timestamp_ms: ev.providerTimestampMs,
    execution_book_latency_ms: ev.latencyMs, tick_size: ev.tickSize, minimum_order_size: ev.minimumOrderSize,
    spread_telemetry: ev.spread, activation_switch: T10_ECONOMIC_ACTIVATION_ENV,
  } as const;

  if (decision.action === "TAKER_FIRST") {
    const fee = exec.fee;
    const limit = exec.takerLimit;
    if (!fee?.ok || !num(limit)) return fail("T10_ECON_FROZEN_TAKER_EVIDENCE_INCOMPLETE", null, ev);
    if (limit > cap + EPS || limit > pBuyMax + EPS) return fail("T10_ECON_GUARD_TAKER_LIMIT_ABOVE_AUTHORITY", null, ev);
    const walk = walkTakerFill(ev.asks, stake, limit, fee.takerRate);
    if (!walk.filled || walk.rawVwap === null || walk.effectiveCost === null || walk.feeUsd === null) {
      return fail(`T10_ECON_GUARD_FULL_STAKE_UNAVAILABLE: depth_usd_at_limit=${walk.depthUsd} limit=${limit}`, null, ev);
    }
    if (walk.effectiveCost > pBuyMax + EPS) return fail(`T10_ECON_GUARD_EFFECTIVE_COST_ABOVE_P_BUY_MAX: cost=${walk.effectiveCost} p_buy_max=${pBuyMax}`, null, ev);
    if (walk.rawVwap > cap + EPS) return fail("T10_ECON_GUARD_ABOVE_HARD_CAP", null, ev);
    return { ok: true, evidence: ev, contract: { ...common, execution_mode: "TAKER_FIRST", maker: null, taker: {
      price_limit: limit, authorized_raw_vwap: walk.rawVwap, authorized_effective_cost: walk.effectiveCost,
      authorized_fee_usd: walk.feeUsd, full_stake_depth_usd_at_limit: walk.depthUsd,
      fee_rate: fee.takerRate, fee_exponent: fee.exponent, fee_enabled: fee.feesEnabled, fee_type: fee.feeType,
      fee_formula_version: fee.formulaVersion, fee_source: fee.source, fee_observed_at: fee.observedAtIso,
    } } };
  }

  // MAKER_FIRST: recompute only the mechanical on-tick limit with the SAME frozen P_BUY_MAX.
  const makerLimit = makerLimitPrice(pBuyMax, ev.bestAsk, ev.tickSize, cap);
  if (makerLimit === null) return fail("T10_ECON_GUARD_MAKER_LIMIT_INVALID", null, ev);
  const shares = Math.floor((stake / makerLimit) * 100) / 100;
  if (num(ev.minimumOrderSize) && shares + EPS < ev.minimumOrderSize) {
    return fail(`T10_ECON_GUARD_MAKER_BELOW_MIN_ORDER_SIZE: shares=${shares} min=${ev.minimumOrderSize}`, null, ev);
  }
  const contract: FrozenExecutionContract = { ...common, execution_mode: "MAKER_FIRST", taker: null,
    maker: { maker_limit_price: makerLimit, maker_shares: shares } };
  if (!IRELAND_PRIMARY_MAKER_CONTRACT_SUPPORTED) return fail("MAKER_FIRST_AWAITING_IRELAND_COMPATIBILITY", contract, ev);
  return { ok: true, contract, evidence: ev };
}
