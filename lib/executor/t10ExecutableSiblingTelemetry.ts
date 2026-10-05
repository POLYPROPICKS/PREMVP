// T10_EXECUTABLE_SIBLING_TELEMETRY_V1 — ordinary-$2.50 TAKER execution evidence for EVERY supported
// T_MINUS_10 sibling of one reserved physical event.
//
// ANALYTICS / OFF-POLICY EVIDENCE ONLY. Nothing here is read by T10 selection, ranking, the support
// bands, the 0.54 hard cap, stake, the Queue, fallback or Ireland, and nothing here places an order.
// T30 is research telemetry only and plays NO role here: the CURRENT T10 book is the only authority this
// module reads (T30_MONEY_GATE_REMOVAL_V1: no T30-derived value is computed, persisted or consulted).
// It answers one question per exact sibling (physical_event_id, condition_id, token_id, side):
//
//   "If this sibling had been chosen at T10, could the ORDINARY $2.50 stake have been executed as a
//    TAKER, at what VWAP, with what fee evidence?"
//
// Benchmark definition (frozen, mirrors the live TAKER walk; no new venue model):
//   stake            QUEUE_DEFAULT_STAKE_USD ($2.50). The $4.00 adaptive headroom is NOT used.
//   price limit      QUEUE_MAX_ENTRY_PRICE (0.54) — the hard cap, the one authority every sibling has.
//   walk             walkTakerFill (t10EconomicActivation) over the exact token's ask ladder <= cap.
//   min order        blocked when walk.shares + 1e-9 < book.minimumOrderSize (same test as the live
//                    LIVE_GUARD re-verification), recorded explicitly, never silently dropped.
//   fee              fetchTokenFeeSchedule (token-specific Gamma schedule). Never assumed zero: a
//                    missing/ambiguous/unsupported schedule is fee_state=UNKNOWN with a typed reason and
//                    every fee-inclusive number stays NULL. rate 0 is recorded only when the provider
//                    itself states feesEnabled=false.
//
// Honest-unknown semantics: executable_full_stake is TRUE / FALSE / NULL(unknown) and
// executable_full_stake_state always names why. Depth, VWAP, shares and fee are NULL (never 0) whenever
// they are not authoritative.
//
// IMPORT NOTE: this module is loaded lazily by reservationMarketBaseline.captureReservationMarketObservation
// (reservationMarketBaseline <- t10EconomicActivation / exactMarketReference are import-cyclic otherwise).
import type { FetchOrderBookResult } from "../liquidity/types";
import { fetchTokenFeeSchedule, type TokenFeeScheduleResult } from "../liquidity/polymarketClient";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "./executorQueueTypes";
import { T10_EXECUTABLE_TELEMETRY_VERSION } from "./reservationMarketBaseline";
import type { AskLevel } from "./t10EconomicActionPolicy";
import { walkTakerFill } from "./t10EconomicActivation";

const EPS = 1e-9;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type ExecutableFullStakeState =
  | "EXECUTABLE"
  | "NOT_EXECUTABLE_MIN_ORDER_SIZE"
  | "NOT_EXECUTABLE_DEPTH_AT_CAP"
  | "UNKNOWN_BOOK_UNAVAILABLE"
  | "UNKNOWN_MIN_ORDER_SIZE"
  | "UNKNOWN_TELEMETRY_COMPUTE_FAILED";

export type TakerFeeState = "KNOWN" | "UNKNOWN";

// ── bounded fee fetch ───────────────────────────────────────────────────────

// Capture runs inside the live rebalance tick (eventExecutionQueue -> captureReservationMarketMilestones), so
// these bounds are a live-latency guard, not just a politeness limit.
export const FEE_FETCH_CONCURRENCY = 5;
export const FEE_FETCH_PER_CALL_TIMEOUT_MS = 2_500;
export const FEE_FETCH_TOTAL_BUDGET_MS = 5_000;

export type FeeFetcher = (tokenId: string, opts: { timeoutMs: number }) => Promise<TokenFeeScheduleResult>;

/**
 * Fee schedules for the whole sibling set, bounded so that telemetry can never stall the capture that feeds
 * the live T10 decision: per-call timeout, bounded concurrency and a total wall-clock budget. A token not
 * reached inside the budget is an explicit typed UNKNOWN (FEE_BUDGET_EXCEEDED). Never throws; returns one
 * entry per distinct token.
 *
 * The schedule is a property of the Gamma MARKET (both outcome tokens share one object), so it is fetched
 * once per condition_id through the token-specific fetcher and reused for the sibling token ONLY when the
 * returned conditionId equals that token's inventory condition_id; an answer for a different market is not
 * reused and the sibling is fetched itself. A FAILED market lookup is not retried per token (it would double
 * the calls exactly when the provider is unhealthy): the sibling carries the same typed reason.
 */
export async function fetchFeeSchedulesBounded(
  tokens: readonly { tokenId: string; conditionId: string }[],
  opts: { fetchFee?: FeeFetcher; concurrency?: number; perCallTimeoutMs?: number; totalBudgetMs?: number; nowMs?: () => number } = {},
): Promise<Map<string, TokenFeeScheduleResult>> {
  const fetchFee: FeeFetcher = opts.fetchFee ?? ((tokenId, o) => fetchTokenFeeSchedule(tokenId, o));
  const now = opts.nowMs ?? Date.now;
  const perCall = opts.perCallTimeoutMs ?? FEE_FETCH_PER_CALL_TIMEOUT_MS;
  const budget = opts.totalBudgetMs ?? FEE_FETCH_TOTAL_BUDGET_MS;
  const startedAt = now();
  const out = new Map<string, TokenFeeScheduleResult>();
  const groups = new Map<string, string[]>();
  for (const t of tokens) {
    const group = groups.get(t.conditionId) ?? [];
    if (!group.includes(t.tokenId)) group.push(t.tokenId);
    groups.set(t.conditionId, group);
  }
  const fetchOne = async (tokenId: string): Promise<TokenFeeScheduleResult> => {
    const remaining = budget - (now() - startedAt);
    if (remaining <= 0) return { ok: false, tokenId, errorCode: "FEE_BUDGET_EXCEEDED", latencyMs: 0 };
    try { return await fetchFee(tokenId, { timeoutMs: Math.max(250, Math.min(perCall, remaining)) }); }
    catch { return { ok: false, tokenId, errorCode: "FEE_FETCH_THREW", latencyMs: 0 }; }
  };
  const queue = [...groups.entries()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const [conditionId, tokenIds] = queue[cursor++];
      const [first, ...rest] = tokenIds;
      const head = await fetchOne(first);
      out.set(first, head);
      for (const tokenId of rest) {
        if (!head.ok) out.set(tokenId, { ...head, tokenId });
        else out.set(tokenId, head.conditionId === conditionId ? { ...head, tokenId } : await fetchOne(tokenId));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? FEE_FETCH_CONCURRENCY), queue.length) }, worker));
  return out;
}

// ── per-sibling evidence (pure) ─────────────────────────────────────────────

/** Highest ask level the full-stake walk consumes (smallest cap at which $stake is fillable). */
function worstAskPriceForFullStake(levels: readonly AskLevel[], stakeUsd: number, cap: number): number | null {
  const prices = [...new Set(levels
    .filter((l) => num(l.price) && num(l.sizeShares) && l.price > 0 && l.sizeShares > 0 && l.price <= cap + EPS)
    .map((l) => l.price))].sort((a, b) => a - b);
  for (const p of prices) if (walkTakerFill(levels, stakeUsd, p, 0).filled) return p;
  return null;
}

export type ExecutableSiblingInput = {
  token: { conditionId: string; tokenId: string; side: string };
  /** The result of the SAME book fetch that produced the persisted best_bid/best_ask of this row. */
  result: FetchOrderBookResult | null | undefined;
  fee: TokenFeeScheduleResult | null | undefined;
  stakeUsd?: number;
  hardCap?: number;
};

/**
 * ALL columns every T_MINUS_10 observation row carries (uniform key set, so a bulk upsert is homogeneous).
 * Existing columns reused with identical LIVE_GUARD semantics: requested_stake_usd, execution_price_cap,
 * ask_depth_relevant_usd (ask USD at/below the cap), full_stake_executable_vwap (raw VWAP of the full stake).
 */
export function buildExecutableSiblingColumns(input: ExecutableSiblingInput): Record<string, unknown> {
  const stake = input.stakeUsd ?? QUEUE_DEFAULT_STAKE_USD;
  const cap = input.hardCap ?? QUEUE_MAX_ENTRY_PRICE;
  const { token, result, fee } = input;
  const book = result?.ok && result.book && result.book.tokenId === token.tokenId ? result.book : null;

  const feeKnown = !!fee?.ok;
  const rate = fee?.ok ? fee.takerRate : 0;

  let state: ExecutableFullStakeState;
  let executable: boolean | null = null;
  let depthUsd: number | null = null;
  let vwap: number | null = null;
  let shares: number | null = null;
  let worst: number | null = null;
  let feeUsd: number | null = null;
  let effective: number | null = null;

  if (!book) {
    state = "UNKNOWN_BOOK_UNAVAILABLE";
  } else {
    const levels: AskLevel[] = book.asks.map((l) => ({ price: l.price, sizeShares: l.size }));
    // rate is 0 when the fee is unknown: that only feeds the discarded fee fields below, never the walk.
    const walk = walkTakerFill(levels, stake, cap, rate);
    depthUsd = walk.depthUsd;
    const minOrder = book.minimumOrderSize;
    if (!walk.filled || walk.rawVwap === null) {
      state = "NOT_EXECUTABLE_DEPTH_AT_CAP";
      executable = false;
    } else {
      vwap = walk.rawVwap;
      shares = r6(walk.shares);
      worst = worstAskPriceForFullStake(levels, stake, cap);
      if (feeKnown && walk.feeUsd !== null && walk.effectiveCost !== null) { feeUsd = walk.feeUsd; effective = walk.effectiveCost; }
      if (!num(minOrder) || !(minOrder > 0)) {
        state = "UNKNOWN_MIN_ORDER_SIZE";
      } else if (walk.shares + EPS < minOrder) {
        state = "NOT_EXECUTABLE_MIN_ORDER_SIZE";
        executable = false;
      } else {
        state = "EXECUTABLE";
        executable = true;
      }
    }
  }

  return {
    executable_telemetry_version: T10_EXECUTABLE_TELEMETRY_VERSION,
    requested_stake_usd: stake,
    execution_price_cap: cap,
    ask_depth_relevant_usd: depthUsd,
    full_stake_executable_vwap: vwap,
    full_stake_shares: shares,
    full_stake_worst_ask_price: worst,
    executable_full_stake: executable,
    executable_full_stake_state: state,
    taker_fee_state: (feeKnown ? "KNOWN" : "UNKNOWN") satisfies TakerFeeState,
    taker_fee_reason: feeKnown ? null : fee && !fee.ok ? fee.errorCode : "FEE_NOT_ATTEMPTED",
    taker_fee_rate: fee?.ok ? fee.takerRate : null,
    taker_fee_usd: feeUsd,
    taker_effective_cost_per_share: effective,
    taker_fee_formula_version: fee?.ok ? fee.formulaVersion : null,
  };
}

// ── aggregate proof (pure) ──────────────────────────────────────────────────

export type SiblingTelemetryRowForSummary = {
  physical_event_id: string;
  condition_id: string;
  token_id: string;
  side: string;
  orderbook_fetch_status?: string | null;
  executable_telemetry_version?: string | null;
  executable_full_stake?: boolean | null;
  executable_full_stake_state?: string | null;
  taker_fee_state?: string | null;
};

export type SiblingTelemetrySummary = {
  /** Exact sibling denominator: tokens the capture expected from the supported same-game universe. */
  supported_siblings_n: number;
  telemetry_rows_n: number;
  orderbook_success_n: number;
  full_stake_executable_n: number;
  minimum_size_blocked_n: number;
  depth_blocked_n: number;
  /** UNKNOWN_* states (book unavailable, min order size unknown, telemetry compute failed): typed, never a loss. */
  unknown_compute_n: number;
  fee_known_n: number;
  fee_unknown_n: number;
  state_counts: Record<string, number>;
  /** Deduplicated physical-event denominator. */
  physical_events_n: number;
  physical_events_with_executable_sibling_n: number;
  physical_events_with_min_size_blocked_sibling_n: number;
  physical_events_all_fee_known_n: number;
  /** telemetry_rows_n === supported_siblings_n: no sibling lacks a telemetry row. */
  coverage_complete: boolean;
};

/**
 * Per-capture (or per-cohort) denominator proof. `supportedSiblingsN` is the independently counted
 * supported-sibling denominator (capture run market_tokens_expected_n); coverage is only complete when every
 * supported sibling carries exactly one telemetry row, so a missing row is never hidden by the numerator.
 */
export function summarizeExecutableSiblingTelemetry(
  rows: readonly SiblingTelemetryRowForSummary[],
  supportedSiblingsN: number,
): SiblingTelemetrySummary {
  const telemetry = rows.filter((r) => r.executable_telemetry_version === T10_EXECUTABLE_TELEMETRY_VERSION);
  const exact = new Set(telemetry.map((r) => `${r.physical_event_id}|${r.condition_id}|${r.token_id}|${r.side}`));
  const stateCounts: Record<string, number> = {};
  for (const r of telemetry) {
    const s = r.executable_full_stake_state ?? "MISSING_STATE";
    stateCounts[s] = (stateCounts[s] ?? 0) + 1;
  }
  const byEvent = new Map<string, SiblingTelemetryRowForSummary[]>();
  for (const r of telemetry) byEvent.set(r.physical_event_id, [...(byEvent.get(r.physical_event_id) ?? []), r]);
  const events = [...byEvent.values()];
  return {
    supported_siblings_n: supportedSiblingsN,
    telemetry_rows_n: telemetry.length,
    orderbook_success_n: telemetry.filter((r) => r.orderbook_fetch_status === "SUCCESS").length,
    full_stake_executable_n: telemetry.filter((r) => r.executable_full_stake === true).length,
    minimum_size_blocked_n: telemetry.filter((r) => r.executable_full_stake_state === "NOT_EXECUTABLE_MIN_ORDER_SIZE").length,
    depth_blocked_n: telemetry.filter((r) => r.executable_full_stake_state === "NOT_EXECUTABLE_DEPTH_AT_CAP").length,
    unknown_compute_n: telemetry.filter((r) => (r.executable_full_stake_state ?? "MISSING_STATE").startsWith("UNKNOWN") || r.executable_full_stake_state == null).length,
    fee_known_n: telemetry.filter((r) => r.taker_fee_state === "KNOWN").length,
    fee_unknown_n: telemetry.filter((r) => r.taker_fee_state === "UNKNOWN").length,
    state_counts: stateCounts,
    physical_events_n: events.length,
    physical_events_with_executable_sibling_n: events.filter((e) => e.some((r) => r.executable_full_stake === true)).length,
    physical_events_with_min_size_blocked_sibling_n:
      events.filter((e) => e.some((r) => r.executable_full_stake_state === "NOT_EXECUTABLE_MIN_ORDER_SIZE")).length,
    physical_events_all_fee_known_n: events.filter((e) => e.every((r) => r.taker_fee_state === "KNOWN")).length,
    coverage_complete: telemetry.length === supportedSiblingsN && exact.size === telemetry.length,
  };
}
