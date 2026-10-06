// T10_EXACT_MARKET_EXECUTION_EVIDENCE_AND_MONEY_ACTIVATION_V1 / T30_MONEY_GATE_REMOVAL_V1
//
// Wires the T10 economic action policy (t10EconomicActionPolicy.ts) into the PREMVP final-rebalance
// decision, behind ONE rollback switch:
//
//   T10_ECONOMIC_ACTION_ACTIVATION=ON  -> this module decides the event's single action.
//   anything else (default)            -> released B priority + LIVE_GUARD, byte-for-byte unchanged.
//
// T30 is research telemetry ONLY. It never authorizes, vetoes, prices or ranks a live action:
//   T30_LIVE_ELIGIBILITY_GATE=NO   T30_LIVE_PRICE_AUTHORITY=NO   T30_LIVE_RANKING_AUTHORITY=NO
// The T30 universe is still read and its observation key is still frozen as lineage telemetry.
//
// Authoritative CURRENT execution evidence (all read-only, exact token, fetched at decision time):
//   ask ladder / best bid / best ask  CLOB GET /book            (fetchOrderBook -> ParsedOrderBook.asks)
//   tick size / minimum order size    same /book payload        (tick_size / min_order_size, no hardcoded tick)
//   taker fee schedule                Gamma GET /markets?clob_token_ids=  (fetchTokenFeeSchedule)
//   exposure                          existing Queue authority  (non-terminal Queue row for the Reservation)
//   latest entry                      nightWindow.latestEntryIso (canonical: physical event start + 3 minutes)
//
// Frozen price ceiling (`p_buy_max` / price_authority_version T10_CURRENT_BOOK_EXECUTION_AUTHORITY_V1):
//   TAKER_FIRST = the hard cap (QUEUE_MAX_ENTRY_PRICE = 0.555): fee-inclusive cost per share must stay <= the cap.
//   MAKER_FIRST = the current-book maker limit (never raised after selection).
//   price_authority_observation_id = the CURRENT execution book observation (never a T30 key).
//
// TAKER economic cost (Polymarket documented taker fee, USDC, per fill):
//   fee_i          = ceil_1e-5( shares_i * rate * p_i * (1 - p_i) )
//   effective_cost = (stake_usd + sum fee_i) / sum shares_i            (USDC per share acquired)
//   per-share bound at fill price p: p * (1 + rate * (1 - p))  -- strictly increasing on (0, 1).
//
// TAKER execution limit (frozen as the Queue max_entry_price, the only price Ireland may pay):
//   L = the highest on-tick price with L * (1 + rate * (1 - L)) <= the hard cap and L <= the hard cap.
//   Every share filled at <= L therefore costs <= the hard cap after fees, even if the book moves
//   between this decision and the venue. The full $2.50 stake must be fillable from levels <= L.
//   The policy is evaluated on exactly that executable ladder (asks <= L).
//
// MAKER limit (CURRENT book only): floor_to_tick(min(current best bid, current best ask - tick, hard cap)).
//   The current best bid is the placement authority; an empty/wide spread is never jumped with
//   `ask - tick` alone. Support is proven on the limit itself. No fill probability anywhere.
//
// Ireland boundary: TAKER_FIRST is emitted as execution_mode "TAKER" / TAKER_ATTEMPT_1 with
// price_cap = the fee-inclusive limit. A frozen MAKER_FIRST row is emitted explicitly through the
// released primary-maker contract (execution_mode = attempt_id = MAKER_FIRST, maker_limit_price,
// maker_shares, tick_size, minimum_order_size, p_buy_max, price-authority lineage); a malformed one is
// never emitted and never translated into a TAKER (mapQueueRowToIrelandCandidate).
//
// Minimum order: the provider min_order_size of the exact token must be known for BOTH modes; unknown
// fails closed. LIVE_EXECUTION_FINAL_ACTIVATION_V1 adaptive headroom: every evaluation starts at $2.50.
// ONLY when the venue minimum quantity is the SOLE blocker at $2.50 is the stake raised to the smallest
// cent amount that satisfies it (<= QUEUE_MAX_STAKE_USD $4.00, else SKIP). TAKER re-walks the ACTUAL
// increased stake against the actual book and re-proves full depth, fee-inclusive cost <= the hard cap
// and raw price <= the hard cap. The hard cap and the limit formulas are never changed by this stage.
//
// MAKER_FIRST timing (released Ireland contract, LIVE_BETTING_RECOVERY_FINAL_HOTFIX_V2): fallback_deadline =
// latest_entry (event start + 3 minutes); primary_maker_cancel_by = event start - 12m40s (a FIXED offset, never
// derived from latest_entry); the >= 580 s fallback reserve between them is validated, not a formula. The Queue is
// created at ~T-20, so the primary has ~440 s. A MAKER_FIRST at/after cancel_by fails closed.
import { getBestBidAsk, computeSpread } from "@/lib/liquidity/orderbookMath";
import type { FetchOrderBookResult } from "@/lib/liquidity/types";
import type { TokenFeeScheduleResult } from "@/lib/liquidity/polymarketClient";
import { evaluateExactMarketReference, type ExactMarketIdentity, type ReferenceEvidence } from "./exactMarketReference";
import {
  QUEUE_DEFAULT_STAKE_USD,
  QUEUE_MAX_ENTRY_PRICE,
  QUEUE_MAX_STAKE_USD,
  STAKE_ADJUSTMENT_REASON_MIN_ORDER,
  ceilCentUsd,
  ceilShares,
  floorShares,
  primaryMakerTiming,
  type StakeAuthorization,
} from "./executorQueueTypes";
import { latestEntryIso } from "./nightWindow";
import { bStrategySupportRegion, isBSupportFamilyEligible, type FinalT3MarketObservation } from "./reservationMarketBaseline";
import {
  decideEventAction,
  evaluateMakerPlacement,
  evaluateMakerSupportPrice,
  priceInBand,
  PRICE_AUTHORITY_VERSION,
  T10_ECONOMIC_ACTION_POLICY_VERSION,
  type AskLevel,
  type EventDecision,
  type PolicyCandidateInput,
  type PolicyEvaluation,
} from "./t10EconomicActionPolicy";

export const T10_ECONOMIC_ACTIVATION_ENV = "T10_ECONOMIC_ACTION_ACTIVATION" as const;
export const T10_EXECUTION_POLICY_VERSION = "T10_ECONOMIC_ACTION_EXECUTION_V1" as const;
export const T10_ECONOMIC_TAKER_SELECTION_REASON = "T10_ECONOMIC_ACTION_TAKER_FIRST_V1" as const;
export const T10_ECONOMIC_MAKER_SELECTION_REASON = "T10_ECONOMIC_ACTION_MAKER_FIRST_V1" as const;
/** Released Ireland primary-maker contract is consumed (see header). */
export const IRELAND_PRIMARY_MAKER_CONTRACT_SUPPORTED = true as const;

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

/** USD notional to acquire `shares` from asks priced <= limit (ascending). Null when depth is short. */
export function askNotionalForShares(levels: readonly AskLevel[], shares: number, limit: number): number | null {
  const usable = levels.filter((l) => num(l.price) && num(l.sizeShares) && l.price > 0 && l.sizeShares > 0 && l.price <= limit + EPS)
    .sort((a, b) => a.price - b.price);
  let remaining = shares;
  let notional = 0;
  for (const l of usable) {
    const take = Math.min(remaining, l.sizeShares);
    notional += take * l.price;
    remaining -= take;
    if (remaining <= EPS) return r6(notional);
  }
  return null;
}

/**
 * The pure on-tick MAKER formula floor_to_tick(min(upperBound, ask - tick, cap)), strictly below the ask.
 * Kept identical to the callback-side makerFallbackAuthorization.t10MakerLimitPrice (parity-tested). For the
 * CURRENT-book authority `upperBound` is the current best bid; the full placement rule (best bid present,
 * book not crossed, tick valid) is evaluateMakerPlacement in the policy, which the money path uses.
 */
export function makerLimitPrice(upperBound: number, ask: number, tick: number, cap: number): number | null {
  if (![upperBound, ask, tick, cap].every(num) || !(tick > 0) || tick >= 1) return null;
  const limit = r6(Math.floor(Math.min(upperBound, ask - tick, cap) / tick + EPS) * tick);
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
  /** T30 research telemetry only (lineage); never read by a decision or by the re-verification guard. */
  t30ObservationKey: string | null;
};

export type T10EconomicEventDecision = {
  decision: EventDecision;
  /** The physical event start the timing contract (cancel_by) and latest_entry are anchored to. */
  eventStartIso: string;
  latestEntryIso: string;
  beforeLatestEntry: boolean;
  exposureExists: boolean;
  /** T30 research telemetry only. */
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
  /** T30 research telemetry only: absent, empty or unusable T30 never blocks, prices or ranks a live action. */
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
    // T30 + reference grade are TELEMETRY ONLY: recorded for research, never part of `competes` or any decision.
    const t30Rows = t30ByKey.get(key(identity)) ?? [];
    const t30Evidence = t30Rows.length === 1 ? referenceEvidence(t30Rows[0], "T30_BOOK") : null;
    const evidence = [referenceEvidence(row, "T10_BOOK"), ...(t30Evidence ? [t30Evidence] : [])];
    const reference = evaluateExactMarketReference(identity, evidence);
    // Family/type admission is price-agnostic: a candidate whose CURRENT ASK sits outside the band may still
    // be a safe MAKER (the band is proven per action, on the price actually transacted).
    const supportFamilyEligible = isBSupportFamilyEligible(row);
    const competes = supportFamilyEligible && beforeLatestEntry && !input.exposureExists;
    return { row, identity, t30Evidence, reference, supportFamilyEligible, competes };
  });

  const executions = new Map<string, CandidateExecution>();
  const competing = base.filter((b) => b.competes);
  const fetched = await mapLimited(competing, 5, async (b) => {
    let book: FetchOrderBookResult | null = null;
    try { book = await input.deps.fetchExactTokenOrderbook(b.identity.tokenId); } catch { book = null; }
    const evidence = executionEvidenceFromBook(b.identity.tokenId, book, new Date().toISOString());
    // TAKER needs authoritative CURRENT fee evidence. Only a candidate whose current ask can be a TAKER (inside
    // the family band) needs it; the fetch no longer depends on any T30 / reference grade.
    const band = bStrategySupportRegion(b.row.canonical_market_family ?? "");
    let fee: TokenFeeScheduleResult | null = null;
    if (evidence.ok && priceInBand(evidence.bestAsk, band)) {
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
    // TAKER price authority = the hard cap: fee-inclusive cost per share <= cap. No T30 anchor.
    const takerLimit = fee?.ok && ev?.ok && num(ev.tickSize)
      ? takerPriceLimit(cap, fee.takerRate, ev.tickSize, cap) : null;
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
    const supportBand = bStrategySupportRegion(b.row.canonical_market_family ?? "");
    return {
      identity: b.identity, family: b.row.canonical_market_family ?? "",
      // TAKER initial support = the CURRENT executable ask of the fresh book (never the capture-time row).
      supportFamilyEligible: b.supportFamilyEligible, takerSupportEligible: b.supportFamilyEligible && !!ev?.ok && priceInBand(ev.bestAsk, supportBand),
      supportBand, reference: b.reference, t30Evidence: b.t30Evidence,
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
  return { decision, eventStartIso: input.eventStartIso, latestEntryIso: latest, beforeLatestEntry, exposureExists: input.exposureExists,
    t30SourceAvailable: input.t30Universe !== null, executions };
}

// ── LIVE_GUARD re-verification of the FROZEN selected action ────────────────

export type FrozenExecutionContract = {
  execution_policy_version: typeof T10_EXECUTION_POLICY_VERSION;
  economic_policy_version: typeof T10_ECONOMIC_ACTION_POLICY_VERSION;
  execution_mode: "TAKER_FIRST" | "MAKER_FIRST";
  price_authority_version: typeof PRICE_AUTHORITY_VERSION;
  /** The CURRENT execution book observation the action was frozen on (never a T30 key). */
  price_authority_observation_id: string;
  /** Frozen current-book price ceiling: TAKER = hard cap, MAKER = the maker limit. */
  p_buy_max: number;
  /** T30 research telemetry only (grade of T10 + T30 witnesses); never a gate. */
  reference_status: string;
  physical_event_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  market_family: string;
  stake_usd: number;
  /** Auditable stake authority: base $2.50, actual authorized stake, $4.00 ceiling, adjustment reason. */
  stake_authorization: StakeAuthorization;
  hard_price_cap: number;
  latest_entry_iso: string;
  execution_book_observed_at: string;
  execution_book_provider_timestamp_ms: number | null;
  execution_book_latency_ms: number | null;
  tick_size: number;
  minimum_order_size: number;
  spread_telemetry: number | null;
  /** T30 research telemetry only: the T30 observation key if one existed. LIVE_AUTHORITY is always false. */
  t30_telemetry_v1: { observation_key: string | null; LIVE_AUTHORITY: false };
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
  /** MAKER_FIRST only (released Ireland timing contract). */
  primary_maker_cancel_by_iso?: string;
  fallback_deadline_iso?: string;
  required_min_remaining_seconds?: number;
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
  if (!exec || !exec.evidence?.ok || !num(exec.evidence.tickSize) || !num(pBuyMax)) {
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
  if (!num(ev.minimumOrderSize) || !(ev.minimumOrderSize > 0)) return fail("T10_ECON_GUARD_MIN_ORDER_SIZE_UNKNOWN", null, ev);
  const minOrder = ev.minimumOrderSize;

  const common = {
    execution_policy_version: T10_EXECUTION_POLICY_VERSION, economic_policy_version: T10_ECONOMIC_ACTION_POLICY_VERSION,
    price_authority_version: PRICE_AUTHORITY_VERSION,
    price_authority_observation_id: `T10_CURRENT_BOOK:${sel.candidateIdentity.conditionId}:${sel.candidateIdentity.tokenId}:${sel.candidateIdentity.side}:${ev.observedAtIso}`,
    p_buy_max: pBuyMax, reference_status: sel.referenceStatus,
    physical_event_id: sel.candidateIdentity.physicalEventId, condition_id: sel.candidateIdentity.conditionId,
    token_id: sel.candidateIdentity.tokenId, side: sel.candidateIdentity.side, market_family: sel.candidateIdentity.family,
    hard_price_cap: cap, latest_entry_iso: input.event.latestEntryIso,
    execution_book_observed_at: ev.observedAtIso, execution_book_provider_timestamp_ms: ev.providerTimestampMs,
    execution_book_latency_ms: ev.latencyMs, tick_size: ev.tickSize, minimum_order_size: minOrder,
    spread_telemetry: ev.spread, activation_switch: T10_ECONOMIC_ACTIVATION_ENV,
    t30_telemetry_v1: { observation_key: exec.t30ObservationKey, LIVE_AUTHORITY: false as const },
  } as const;

  if (decision.action === "TAKER_FIRST") {
    const fee = exec.fee;
    const limit = exec.takerLimit;
    if (!fee?.ok || !num(limit)) return fail("T10_ECON_FROZEN_TAKER_EVIDENCE_INCOMPLETE", null, ev);
    if (limit > cap + EPS || limit > pBuyMax + EPS) return fail("T10_ECON_GUARD_TAKER_LIMIT_ABOVE_AUTHORITY", null, ev);
    // Every economic condition is first proven at the ordinary $2.50 stake.
    let walk = walkTakerFill(ev.asks, stake, limit, fee.takerRate);
    if (!walk.filled || walk.rawVwap === null || walk.effectiveCost === null || walk.feeUsd === null) {
      return fail(`T10_ECON_GUARD_FULL_STAKE_UNAVAILABLE: depth_usd_at_limit=${walk.depthUsd} limit=${limit}`, null, ev);
    }
    if (walk.effectiveCost > pBuyMax + EPS) return fail(`T10_ECON_GUARD_EFFECTIVE_COST_ABOVE_P_BUY_MAX: cost=${walk.effectiveCost} p_buy_max=${pBuyMax}`, null, ev);
    if (walk.rawVwap > cap + EPS) return fail("T10_ECON_GUARD_ABOVE_HARD_CAP", null, ev);
    let authorized = stake;
    let requiredNotional: number | null = null;
    if (walk.shares + EPS < minOrder) {
      // Minimum quantity is the ONLY blocker: smallest cent stake buying the minimum at <= limit.
      requiredNotional = askNotionalForShares(ev.asks, ceilShares(minOrder), limit);
      if (requiredNotional === null) {
        return fail(`T10_ECON_GUARD_TAKER_BELOW_MIN_ORDER_SIZE: shares=${r6(walk.shares)} min=${minOrder} depth_short_for_minimum`, null, ev);
      }
      authorized = Math.max(stake, ceilCentUsd(requiredNotional));
      if (authorized > QUEUE_MAX_STAKE_USD + EPS) {
        return fail(`T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE: required_usd=${authorized} max=${QUEUE_MAX_STAKE_USD}`, null, ev);
      }
      // Re-evaluate the ACTUAL increased stake against the actual book.
      walk = walkTakerFill(ev.asks, authorized, limit, fee.takerRate);
      if (!walk.filled || walk.rawVwap === null || walk.effectiveCost === null || walk.feeUsd === null) {
        return fail(`T10_ECON_GUARD_HEADROOM_FULL_STAKE_UNAVAILABLE: stake=${authorized} depth_usd_at_limit=${walk.depthUsd}`, null, ev);
      }
      if (walk.effectiveCost > pBuyMax + EPS) return fail(`T10_ECON_GUARD_HEADROOM_EFFECTIVE_COST_ABOVE_P_BUY_MAX: cost=${walk.effectiveCost}`, null, ev);
      if (walk.rawVwap > cap + EPS) return fail("T10_ECON_GUARD_HEADROOM_ABOVE_HARD_CAP", null, ev);
      if (walk.shares + EPS < minOrder) {
        return fail(`T10_ECON_GUARD_TAKER_BELOW_MIN_ORDER_SIZE: shares=${r6(walk.shares)} min=${minOrder}`, null, ev);
      }
    }
    const stakeAuthorization = stakeAuthorizationOf(stake, authorized, minOrder, requiredNotional);
    return { ok: true, evidence: ev, contract: { ...common, stake_usd: authorized, stake_authorization: stakeAuthorization,
      execution_mode: "TAKER_FIRST", maker: null, taker: {
      price_limit: limit, authorized_raw_vwap: walk.rawVwap, authorized_effective_cost: walk.effectiveCost,
      authorized_fee_usd: walk.feeUsd, full_stake_depth_usd_at_limit: walk.depthUsd,
      fee_rate: fee.takerRate, fee_exponent: fee.exponent, fee_enabled: fee.feesEnabled, fee_type: fee.feeType,
      fee_formula_version: fee.formulaVersion, fee_source: fee.source, fee_observed_at: fee.observedAtIso,
    } } };
  }

  // MAKER_FIRST: recompute the mechanical on-tick limit from the REFRESHED current book; the frozen decision-time
  // maker limit (p_buy_max) is a ceiling, so a rising bid can never raise the price after selection.
  const timing = primaryMakerTiming(input.event.eventStartIso, input.event.latestEntryIso);
  if (!timing) return fail("T10_ECON_GUARD_MAKER_TIMING_INVALID", null, ev);
  // The released Ireland reserve is never weakened: a late T10 after cancel_by fails closed.
  if (!(input.nowMs < Date.parse(timing.primary_maker_cancel_by_iso))) {
    return fail(`T10_ECON_GUARD_AFTER_PRIMARY_MAKER_CANCEL_BY: cancel_by=${timing.primary_maker_cancel_by_iso}`, null, ev);
  }
  if (!num(ev.bestBid) || !(ev.bestBid > 0)) return fail("T10_ECON_GUARD_MAKER_BEST_BID_MISSING", null, ev);
  const makerLimit = evaluateMakerPlacement(ev.bestBid, ev.bestAsk, ev.tickSize, Math.min(pBuyMax, cap)).limit;
  if (makerLimit === null) return fail("T10_ECON_GUARD_MAKER_LIMIT_INVALID", null, ev);
  // MAKER support is re-proven on the refreshed limit (never the ask): <= frozen ceiling, <= the hard cap, inside the band.
  const makerSupport = evaluateMakerSupportPrice(makerLimit, pBuyMax, cap, bStrategySupportRegion(sel.candidateIdentity.family));
  if (!makerSupport.ok) return fail(`T10_ECON_GUARD_${makerSupport.reason}: limit=${makerLimit}`, null, ev);
  const requiredShares = ceilShares(minOrder);
  const requiredNotional = r6(requiredShares * makerLimit);
  let authorized = stake;
  let shares = floorShares(stake / makerLimit);
  if (shares + EPS < minOrder) {
    // Minimum quantity is the only blocker (limit/P_BUY_MAX/cap are already proven): smallest cent stake.
    authorized = Math.max(stake, ceilCentUsd(requiredNotional));
    if (authorized > QUEUE_MAX_STAKE_USD + EPS) {
      return fail(`T10_ECON_GUARD_MIN_ORDER_HEADROOM_ABOVE_MAX_STAKE: required_usd=${authorized} max=${QUEUE_MAX_STAKE_USD}`, null, ev);
    }
    shares = floorShares(authorized / makerLimit);
  }
  if (!(shares > 0) || shares + EPS < minOrder) {
    return fail(`T10_ECON_GUARD_MAKER_BELOW_MIN_ORDER_SIZE: shares=${shares} min=${minOrder}`, null, ev);
  }
  const contract: FrozenExecutionContract = { ...common, stake_usd: authorized,
    stake_authorization: stakeAuthorizationOf(stake, authorized, minOrder, requiredNotional),
    execution_mode: "MAKER_FIRST", taker: null,
    maker: { maker_limit_price: makerLimit, maker_shares: shares }, ...timing };
  return { ok: true, contract, evidence: ev };
}

function stakeAuthorizationOf(base: number, authorized: number, minOrder: number, requiredNotional: number | null): StakeAuthorization {
  return {
    base_stake_usd: base, authorized_stake_usd: authorized, max_stake_usd: QUEUE_MAX_STAKE_USD,
    stake_adjustment_reason: authorized > base + EPS ? STAKE_ADJUSTMENT_REASON_MIN_ORDER : null,
    minimum_order_size: minOrder, required_minimum_notional_usd: requiredNotional,
  };
}
