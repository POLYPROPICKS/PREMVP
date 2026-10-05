// T10_SIBLING_OFFPOLICY_V1 — settled off-policy dataset + frozen C0/C1 evaluation over EXACT T10 siblings.
//
// RESEARCH ONLY. Nothing here is read by T10 selection, ranking, the Queue, Ireland or any live money path, and
// T30 plays no role. It answers: "for every supported T_MINUS_10 sibling (exact physical_event_id + condition_id +
// token_id + side) of a physical event, what was the settled outcome, and what would the ORDINARY $2.50 TAKER stake
// have earned from the CURRENT T10 book" — then runs the EXISTING frozen engine (C0/C1, optionally C4/C5) unchanged.
//
// Honest-unknown rules (never invented): unresolved is never a loss; fee is never assumed 0; a pre-telemetry row
// whose depth was never persisted is UNKNOWN (an upper bound), never "executable". RAW signal economics and
// EXECUTABLE-at-T10 economics are separate views and are never merged.
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "../../executor/executorQueueTypes";
import { T10_EXECUTABLE_TELEMETRY_VERSION } from "../../executor/reservationMarketBaseline";
import { resolveSignalOutcome, type GammaMarket } from "../../feed/resolveSignalOutcome";
import {
  FROZEN_MODEL_IDS, aggregateMetrics, evaluateEvent, getFrozenModel, runModel, sortChronologically, settleBetU,
  type FrozenModelId, type ModelResult, type ResearchEngineInputEvent, type SelectedBet,
} from "../research-engine";

export const T10_OFFPOLICY_VERSION = "T10_SIBLING_OFFPOLICY_V1" as const;
const EPS = 1e-9;
const SETTLEMENT_PRICE_PLACEHOLDER = 0.5;
const SUPPORTED_FAMILIES: ReadonlySet<string> = new Set(["MONEYLINE", "SPREADS", "TOTALS", "TOTAL_CORNERS"]);
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const r6 = (v: number) => Math.round((v + Number.EPSILON) * 1e6) / 1e6;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ── input row (explicit columns of reservation_market_observations + joined sport family) ───────────

export type SiblingObservationRow = {
  physical_event_id: string;
  provider_event_id: string | null;
  event_start_iso: string;
  observed_at: string;
  condition_id: string;
  token_id: string;
  side: string;
  canonical_market_family: string | null;
  canonical_market_type: string | null;
  provider_market_type_raw: string | null;
  best_bid: number | null;
  best_ask: number | null;
  tick_size: number | null;
  minimum_order_size: number | null;
  orderbook_fetch_status: string;
  ask_depth_relevant_usd: number | null;
  /** Joined from research_evidence_page_rows.provider_sport_family (the frozen sport authority); null = unknown. */
  sport_family: string | null;
  // T10_EXECUTABLE_SIBLING_TELEMETRY_V1 columns (NULL for every row captured before the telemetry release)
  executable_telemetry_version?: string | null;
  executable_full_stake?: boolean | null;
  executable_full_stake_state?: string | null;
  full_stake_executable_vwap?: number | null;
  full_stake_shares?: number | null;
  taker_fee_state?: string | null;
  taker_fee_usd?: number | null;
};

// ── settlement ───────────────────────────────────────────────────────────────────────────────────────

export type SiblingSettlementState =
  | "SETTLED_WIN" | "SETTLED_LOSS" | "VOID_PUSH" | "UNRESOLVED" | "IDENTITY_NOT_PROVEN" | "SOURCE_UNAVAILABLE";

export type SiblingSettlement = { state: SiblingSettlementState; reason: string; winningTokenId: string | null };

/**
 * Canonical provider settlement for ONE exact sibling, through the EXISTING resolver (resolveSignalOutcome:
 * Gamma, CLOB fallback done by the caller's fetcher). Never converts unresolved to a loss. A market whose
 * conditionId or token list does not prove the sibling's identity is IDENTITY_NOT_PROVEN, not a result.
 */
export function classifySiblingSettlement(input: { conditionId: string; tokenId: string; market: GammaMarket | null }): SiblingSettlement {
  const { conditionId, tokenId, market } = input;
  if (!conditionId || !tokenId) return { state: "IDENTITY_NOT_PROVEN", reason: "NO_EXACT_IDENTITY", winningTokenId: null };
  if (!market) return { state: "SOURCE_UNAVAILABLE", reason: "NO_PROVIDER_MARKET", winningTokenId: null };
  if (typeof market.conditionId === "string" && market.conditionId.toLowerCase() !== conditionId.toLowerCase()) {
    return { state: "IDENTITY_NOT_PROVEN", reason: "PROVIDER_CONDITION_MISMATCH", winningTokenId: null };
  }
  // The resolver needs a valid (0,1) price only to compute its own realizedReturnPct, which this research layer ignores;
  // the winner is decided purely by the provider's single >= 0.99 outcome and the sibling's exact token.
  const r = resolveSignalOutcome({ conditionId, selectedTokenId: tokenId, entryPriceNum: SETTLEMENT_PRICE_PLACEHOLDER, market });
  if (r.resolverState === "lookup_failed") return { state: "SOURCE_UNAVAILABLE", reason: "LOOKUP_FAILED", winningTokenId: null };
  if (r.selectedOutcomeIndexByToken === null) return { state: "IDENTITY_NOT_PROVEN", reason: "TOKEN_NOT_IN_PROVIDER_MARKET", winningTokenId: null };
  if (r.resolverState === "active_unresolved") return { state: "UNRESOLVED", reason: "MARKET_OPEN", winningTokenId: null };
  if (r.resolverState === "resolved_candidate" && r.signalResult === "won") return { state: "SETTLED_WIN", reason: "PROVIDER_RESOLVED", winningTokenId: r.candidateWinningTokenId };
  if (r.resolverState === "resolved_candidate" && r.signalResult === "lost") return { state: "SETTLED_LOSS", reason: "PROVIDER_RESOLVED", winningTokenId: r.candidateWinningTokenId };
  // closed without exactly one >= 0.99 winner: a 50/50 refund is a push; anything else stays unresolved.
  const prices = r.outcomePrices;
  if (r.closed && prices && prices.length === 2 && prices.every((p) => Math.abs(p - 0.5) <= 0.01)) {
    return { state: "VOID_PUSH", reason: "CLOSED_50_50", winningTokenId: null };
  }
  return { state: "UNRESOLVED", reason: r.resolverState === "closed_unknown" ? "CLOSED_WITHOUT_SINGLE_WINNER" : "UNRESOLVED_OTHER", winningTokenId: null };
}

// ── executability at T10 (ordinary $2.50 TAKER, hard cap 0.54) ───────────────────────────────────────

export type ExecutabilitySource = "TELEMETRY_V1" | "PERSISTED_BOOK_PROXY";
export type ExecutabilityState =
  | "EXECUTABLE" | "NOT_EXECUTABLE_MIN_ORDER_SIZE" | "NOT_EXECUTABLE_DEPTH_AT_CAP"
  | "UNKNOWN_BOOK_UNAVAILABLE" | "UNKNOWN_MIN_ORDER_SIZE" | "UNKNOWN_TELEMETRY_COMPUTE_FAILED"
  /** Pre-telemetry row: best ask is within the cap and min size holds at the best ask, but the ladder was never persisted. */
  | "UNKNOWN_DEPTH_NOT_PERSISTED";

export type ExecutabilityClass = { state: ExecutabilityState; source: ExecutabilitySource; conclusive: boolean };

/**
 * Telemetry rows carry the authoritative state. Older rows only persisted the top of book, so the verdicts that are
 * CONCLUSIVE from it are the blocked ones (best ask above the cap leaves no ask <= cap; a fill's VWAP is >= the best
 * ask, so shares <= stake / best_ask and a min-size block at the best ask cannot be cured by depth). Anything else is
 * UNKNOWN — an upper bound, never "executable".
 */
export function classifyExecutability(row: SiblingObservationRow, stakeUsd = QUEUE_DEFAULT_STAKE_USD, cap = QUEUE_MAX_ENTRY_PRICE): ExecutabilityClass {
  if (row.executable_telemetry_version === T10_EXECUTABLE_TELEMETRY_VERSION && typeof row.executable_full_stake_state === "string") {
    return { state: row.executable_full_stake_state as ExecutabilityState, source: "TELEMETRY_V1", conclusive: !row.executable_full_stake_state.startsWith("UNKNOWN") };
  }
  const proxy = (state: ExecutabilityState, conclusive: boolean): ExecutabilityClass => ({ state, source: "PERSISTED_BOOK_PROXY", conclusive });
  if (row.orderbook_fetch_status !== "SUCCESS" || !num(row.best_ask) || !(row.best_ask > 0)) return proxy("UNKNOWN_BOOK_UNAVAILABLE", false);
  if (row.best_ask > cap + EPS) return proxy("NOT_EXECUTABLE_DEPTH_AT_CAP", true);
  if (!num(row.minimum_order_size) || !(row.minimum_order_size > 0)) return proxy("UNKNOWN_MIN_ORDER_SIZE", false);
  if (stakeUsd / row.best_ask + EPS < row.minimum_order_size) return proxy("NOT_EXECUTABLE_MIN_ORDER_SIZE", true);
  return proxy("UNKNOWN_DEPTH_NOT_PERSISTED", false);
}

// ── dataset row ──────────────────────────────────────────────────────────────────────────────────────

export type OffPolicyFeeState = "FEE_KNOWN_NET_AVAILABLE" | "FEE_UNKNOWN_GROSS_ONLY";

export type OffPolicyDatasetRow = {
  dataset_version: typeof T10_OFFPOLICY_VERSION;
  physical_event_id: string;
  event_start_iso: string;
  event_date_utc: string;
  sport_family: string | null;
  canonical_market_family: string | null;
  canonical_market_type: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  decision_at: string;
  best_bid: number | null;
  best_ask: number | null;
  tick_size: number | null;
  minimum_order_size: number | null;
  orderbook_fetch_status: string;
  ordinary_stake_usd: number;
  hard_cap: number;
  executability_state: ExecutabilityState;
  executability_source: ExecutabilitySource;
  executability_conclusive: boolean;
  /** Price the ordinary stake is evaluated at: the telemetry VWAP when the full stake is proven fillable, else the best ask. */
  offpolicy_entry_price: number | null;
  offpolicy_entry_price_source: "TELEMETRY_VWAP" | "BEST_ASK" | "NONE";
  fee_state: OffPolicyFeeState;
  fee_usd: number | null;
  settlement_state: SiblingSettlementState;
  settlement_reason: string;
  winning_token_id: string | null;
  /** Gross (fee-excluded) result of the ordinary stake. NULL unless settled WIN / LOSS / VOID_PUSH and priced. */
  offpolicy_gross_pnl_usd: number | null;
  offpolicy_net_pnl_usd: number | null;
  /** Source lineage: persisted observation capture, never re-derived. */
  lineage: { source_table: "reservation_market_observations"; observation_phase: "T_MINUS_10"; observed_at: string; telemetry_version: string | null };
};

export function isSupportedSibling(row: Pick<SiblingObservationRow, "canonical_market_family">): boolean {
  return typeof row.canonical_market_family === "string" && SUPPORTED_FAMILIES.has(row.canonical_market_family);
}

const keyOf = (r: { condition_id: string; token_id: string }) => `${r.condition_id}|${r.token_id}`;

export function buildOffPolicyDataset(
  rows: readonly SiblingObservationRow[],
  settlementByKey: ReadonlyMap<string, SiblingSettlement>,
  stakeUsd = QUEUE_DEFAULT_STAKE_USD,
  cap = QUEUE_MAX_ENTRY_PRICE,
): OffPolicyDatasetRow[] {
  return rows.filter(isSupportedSibling).map((row) => {
    const exec = classifyExecutability(row, stakeUsd, cap);
    const settlement = settlementByKey.get(keyOf(row)) ?? { state: "SOURCE_UNAVAILABLE" as const, reason: "NOT_RESOLVED_BY_RUN", winningTokenId: null };
    const vwapOk = exec.source === "TELEMETRY_V1" && exec.state === "EXECUTABLE" && num(row.full_stake_executable_vwap) && row.full_stake_executable_vwap > 0 && row.full_stake_executable_vwap < 1;
    const bookPrice = row.orderbook_fetch_status === "SUCCESS" && num(row.best_ask) && row.best_ask > 0 && row.best_ask < 1 ? row.best_ask : null;
    const price = vwapOk ? (row.full_stake_executable_vwap as number) : bookPrice;
    const feeKnown = row.taker_fee_state === "KNOWN" && num(row.taker_fee_usd);
    let gross: number | null = null;
    if (price !== null) {
      if (settlement.state === "SETTLED_WIN") gross = r6(stakeUsd * (1 / price - 1));
      else if (settlement.state === "SETTLED_LOSS") gross = -stakeUsd;
      else if (settlement.state === "VOID_PUSH") gross = 0;
    }
    return {
      dataset_version: T10_OFFPOLICY_VERSION,
      physical_event_id: row.physical_event_id,
      event_start_iso: row.event_start_iso,
      event_date_utc: new Date(row.event_start_iso).toISOString().slice(0, 10),
      sport_family: row.sport_family,
      canonical_market_family: row.canonical_market_family,
      canonical_market_type: row.canonical_market_type,
      condition_id: row.condition_id, token_id: row.token_id, side: row.side,
      decision_at: new Date(row.observed_at).toISOString(),
      best_bid: row.best_bid, best_ask: row.best_ask, tick_size: row.tick_size, minimum_order_size: row.minimum_order_size,
      orderbook_fetch_status: row.orderbook_fetch_status,
      ordinary_stake_usd: stakeUsd, hard_cap: cap,
      executability_state: exec.state, executability_source: exec.source, executability_conclusive: exec.conclusive,
      offpolicy_entry_price: price, offpolicy_entry_price_source: price === null ? "NONE" : vwapOk ? "TELEMETRY_VWAP" : "BEST_ASK",
      fee_state: feeKnown ? "FEE_KNOWN_NET_AVAILABLE" : "FEE_UNKNOWN_GROSS_ONLY",
      fee_usd: feeKnown ? (row.taker_fee_usd as number) : null,
      settlement_state: settlement.state, settlement_reason: settlement.reason, winning_token_id: settlement.winningTokenId,
      offpolicy_gross_pnl_usd: gross,
      offpolicy_net_pnl_usd: gross !== null && feeKnown && vwapOk ? r6(gross - (row.taker_fee_usd as number)) : null,
      lineage: { source_table: "reservation_market_observations", observation_phase: "T_MINUS_10", observed_at: new Date(row.observed_at).toISOString(), telemetry_version: row.executable_telemetry_version ?? null },
    };
  });
}

// ── evaluation through the EXISTING frozen engine ───────────────────────────────────────────────────

export type EvaluationView = "RAW" | "EXECUTABLE_UPPER_BOUND" | "EXECUTABLE_PROVEN";

const isSettledResult = (r: OffPolicyDatasetRow) => r.settlement_state === "SETTLED_WIN" || r.settlement_state === "SETTLED_LOSS";
const isPriced = (r: OffPolicyDatasetRow) => r.offpolicy_entry_price !== null;

/** Which rows a view may even consider (before the frozen predicate). RAW ignores executability on purpose. */
export function viewIncludes(view: EvaluationView, r: OffPolicyDatasetRow): boolean {
  if (view === "RAW") return true;
  if (view === "EXECUTABLE_PROVEN") return r.executability_state === "EXECUTABLE";
  // Upper bound: everything NOT conclusively blocked (proven executable, or unknown depth / unknown min size).
  return r.executability_state === "EXECUTABLE" || r.executability_state === "UNKNOWN_DEPTH_NOT_PERSISTED" || r.executability_state === "UNKNOWN_MIN_ORDER_SIZE";
}

const toEngineInput = (r: OffPolicyDatasetRow): ResearchEngineInputEvent => ({
  physicalEventKey: r.physical_event_id,
  decisionTimestamp: r.decision_at,
  eventStart: new Date(r.event_start_iso).toISOString(),
  entryPrice: r.offpolicy_entry_price as number,
  sportFamily: r.sport_family ?? "",
  outcome: r.settlement_state === "SETTLED_WIN" ? "WIN" : "LOSS",
  ref: r.condition_id,
  candidateRef: r.token_id,
});

export type ModelEvaluation = {
  model: FrozenModelId;
  view: EvaluationView;
  common_processed_physical_events_n: number;
  selected_physical_events_n: number;
  wins: number;
  losses: number;
  /** Qualifying (frozen predicate) siblings in this view that have no WIN/LOSS result — never counted as losses. */
  unresolved_qualifying_siblings_n: number;
  pnl_u: number;
  roi_pct: number;
  max_drawdown_u: number;
  /** pnl_u scaled to the ordinary $2.50 stake (gross, fee-excluded). */
  pnl_usd_gross_at_ordinary_stake: number;
  events_per_day: number;
  date_coverage: { first_event_date: string | null; last_event_date: string | null; days_n: number };
  sport_mix: Record<string, number>;
  selected_fee_known_n: number;
  selected_fee_unknown_n: number;
  selected_executability: Record<string, number>;
  /** Every qualifying settled sibling as an independent flat-1u bet (no per-event collapse): selection-sensitivity check. */
  uncollapsed_qualifying_siblings: { n: number; wins: number; losses: number; pnl_u: number; roi_pct: number };
  /** The same uncollapsed bets split by canonical market family (selection-by-family sensitivity). */
  uncollapsed_by_family: Record<string, { n: number; wins: number; losses: number; pnl_u: number; roi_pct: number }>;
};

function daysBetween(first: string | null, last: string | null): number {
  if (!first || !last) return 0;
  return Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
}

export function evaluateView(dataset: readonly OffPolicyDatasetRow[], view: EvaluationView, models: readonly FrozenModelId[] = ["C0", "C1"]): ModelEvaluation[] {
  // ONE common physical-event denominator for every view and model: events with >= 1 priced, settled supported sibling.
  const settledPriced = dataset.filter((r) => isSettledResult(r) && isPriced(r));
  const commonEvents = new Set(settledPriced.map((r) => r.physical_event_id));
  const dates = settledPriced.map((r) => r.event_date_utc).sort();
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  const days = daysBetween(first, last);
  const population = settledPriced.filter((r) => viewIncludes(view, r));
  const byKey = new Map(population.map((r) => [`${r.physical_event_id}|${r.condition_id}|${r.token_id}`, r]));
  const input = population.map(toEngineInput);

  return models.map((model) => {
    const result: ModelResult = runModel(model, input);
    // The frozen membership predicate itself (price band / sport family); the outcome never enters it.
    const predicate = (e: ResearchEngineInputEvent) => getFrozenModel(model).predicate(evaluateEvent(e));
    const selectedRows = result.selectedBets.map((b: SelectedBet) => byKey.get(`${b.physicalEventKey}|${b.ref}|${b.candidateRef}`) as OffPolicyDatasetRow);
    const sportMix: Record<string, number> = {};
    const execMix: Record<string, number> = {};
    for (const r of selectedRows) {
      sportMix[r.sport_family ?? "UNKNOWN"] = (sportMix[r.sport_family ?? "UNKNOWN"] ?? 0) + 1;
      execMix[r.executability_state] = (execMix[r.executability_state] ?? 0) + 1;
    }
    const qualifying = population.filter((r) => predicate(toEngineInput(r)));
    const uncollapsedBets: SelectedBet[] = sortChronologically(qualifying.map((r) => evaluateEvent(toEngineInput(r)))).map((e) => ({
      physicalEventKey: e.physicalEventKey, decisionTimestamp: e.decisionTimestamp, eventStart: e.eventStart, leadTimeHours: e.leadTimeHours,
      entryPrice: e.entryPrice, sportFamily: e.sportFamily, outcome: e.outcome, pnlU: settleBetU(e.outcome, e.entryPrice),
    }));
    const unc = aggregateMetrics(uncollapsedBets);
    const byFamily: ModelEvaluation["uncollapsed_by_family"] = {};
    for (const family of [...new Set(qualifying.map((r) => r.canonical_market_family ?? "UNKNOWN"))].sort()) {
      const m = aggregateMetrics(sortChronologically(qualifying.filter((r) => (r.canonical_market_family ?? "UNKNOWN") === family).map((r) => evaluateEvent(toEngineInput(r)))).map((e) => ({
        physicalEventKey: e.physicalEventKey, decisionTimestamp: e.decisionTimestamp, eventStart: e.eventStart, leadTimeHours: e.leadTimeHours,
        entryPrice: e.entryPrice, sportFamily: e.sportFamily, outcome: e.outcome, pnlU: settleBetU(e.outcome, e.entryPrice),
      })));
      byFamily[family] = { n: m.SELECTED_PHYSICAL_EVENT_N, wins: m.WINS, losses: m.LOSSES, pnl_u: m.PNL_U, roi_pct: m.ROI_PCT };
    }
    // Qualifying-but-unsettled siblings of this view (priced rows whose settlement is not WIN/LOSS); counted, never lost.
    const unresolved = dataset.filter((r) => isPriced(r) && !isSettledResult(r) && viewIncludes(view, r)
      && predicate({ ...toEngineInput(r), outcome: "LOSS" })).length;
    return {
      model, view,
      common_processed_physical_events_n: commonEvents.size,
      selected_physical_events_n: result.SELECTED_PHYSICAL_EVENT_N,
      wins: result.WINS, losses: result.LOSSES,
      unresolved_qualifying_siblings_n: unresolved,
      pnl_u: result.PNL_U, roi_pct: result.ROI_PCT, max_drawdown_u: result.MAX_DRAWDOWN_U,
      pnl_usd_gross_at_ordinary_stake: r2(result.raw.pnlU * QUEUE_DEFAULT_STAKE_USD),
      events_per_day: days > 0 ? r2(result.SELECTED_PHYSICAL_EVENT_N / days) : 0,
      date_coverage: { first_event_date: first, last_event_date: last, days_n: days },
      sport_mix: sportMix,
      selected_fee_known_n: selectedRows.filter((r) => r.fee_state === "FEE_KNOWN_NET_AVAILABLE").length,
      selected_fee_unknown_n: selectedRows.filter((r) => r.fee_state === "FEE_UNKNOWN_GROSS_ONLY").length,
      selected_executability: execMix,
      uncollapsed_qualifying_siblings: { n: unc.SELECTED_PHYSICAL_EVENT_N, wins: unc.WINS, losses: unc.LOSSES, pnl_u: unc.PNL_U, roi_pct: unc.ROI_PCT },
      uncollapsed_by_family: byFamily,
    };
  });
}

// ── coverage / denominators ──────────────────────────────────────────────────────────────────────────

export type OffPolicyCoverage = {
  supported_siblings_n: number;
  supported_physical_events_n: number;
  supported_siblings_by_family: Record<string, number>;
  priced_siblings_n: number;
  settlement_state_counts: Record<string, number>;
  settled_siblings_n: number;
  unresolved_siblings_n: number;
  common_physical_events_n: number;
  executability_state_counts: Record<string, number>;
  executability_source_counts: Record<string, number>;
  telemetry_rows_n: number;
  fee_known_n: number;
  fee_unknown_n: number;
  date_range: { first_event_date: string | null; last_event_date: string | null };
};

export function summarizeCoverage(dataset: readonly OffPolicyDatasetRow[]): OffPolicyCoverage {
  const count = <T extends string>(xs: readonly T[]) => xs.reduce<Record<string, number>>((m, x) => { m[x] = (m[x] ?? 0) + 1; return m; }, {});
  const settled = dataset.filter(isSettledResult);
  const dates = dataset.map((r) => r.event_date_utc).sort();
  return {
    supported_siblings_n: dataset.length,
    supported_physical_events_n: new Set(dataset.map((r) => r.physical_event_id)).size,
    supported_siblings_by_family: count(dataset.map((r) => r.canonical_market_family ?? "UNKNOWN")),
    priced_siblings_n: dataset.filter(isPriced).length,
    settlement_state_counts: count(dataset.map((r) => r.settlement_state)),
    settled_siblings_n: settled.length,
    unresolved_siblings_n: dataset.filter((r) => r.settlement_state === "UNRESOLVED").length,
    common_physical_events_n: new Set(dataset.filter((r) => isSettledResult(r) && isPriced(r)).map((r) => r.physical_event_id)).size,
    executability_state_counts: count(dataset.map((r) => r.executability_state)),
    executability_source_counts: count(dataset.map((r) => r.executability_source)),
    telemetry_rows_n: dataset.filter((r) => r.executability_source === "TELEMETRY_V1").length,
    fee_known_n: dataset.filter((r) => r.fee_state === "FEE_KNOWN_NET_AVAILABLE").length,
    fee_unknown_n: dataset.filter((r) => r.fee_state === "FEE_UNKNOWN_GROSS_ONLY").length,
    date_range: { first_event_date: dates[0] ?? null, last_event_date: dates[dates.length - 1] ?? null },
  };
}

export const OFFPOLICY_EVALUATED_MODELS: readonly FrozenModelId[] = ["C0", "C1"];
export const OFFPOLICY_ALL_FROZEN_MODELS: readonly FrozenModelId[] = FROZEN_MODEL_IDS;
