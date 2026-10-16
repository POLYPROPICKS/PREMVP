/**
 * Forward virtual-BUY authority (FORWARD_BUY_V1) for QUALITY_FILL_D_SAFE and P50_52_SAFE.
 *
 * Pure, side-effect-free. It decides whether an already-selected SAFE candidate gets an EXECUTABLE virtual BUY and, when
 * it does, produces the exact receipt and the contract columns that the database freezes at first insert. It never
 * selects, re-ranks or re-prices a candidate: the SAFE selection (and its original observation time) is an input.
 *
 * A candidate that fails any rule here yields a rejection and NO contract row; it therefore never enters forward-contract
 * classification. Rejections carry a small fixed-shape diagnostic, never a raw book.
 *
 * Virtual stake: USD 2.50 of ask-side notional, filled across the real CLOB ask depth (full-stake VWAP). The taker fee is
 * charged on top. This ledger (FORWARD_BUY_VIRTUAL_USD_2_50) is separate from the legacy USD 2 unit accounting.
 */
import { createHash } from "node:crypto";
import type { ParsedOrderBook } from "../liquidity/types";
import {
  buildForwardBetColumns,
  FORWARD_BET_CONTRACT_VERSION,
  type ForwardBetColumns,
  type ForwardCandidate,
  type ForwardEvidenceSource,
} from "./forwardBetContract";

export const FORWARD_BUY_VERSION = "FORWARD_BUY_V1" as const;
export const FORWARD_BUY_MODELS = ["QUALITY_FILL_D_SAFE", "P50_52_SAFE"] as const;
export type ForwardBuyModel = (typeof FORWARD_BUY_MODELS)[number];
export const FORWARD_BUY_STAKE_USD = 2.5;
export const FORWARD_BUY_STAKE_LEDGER = "FORWARD_BUY_VIRTUAL_USD_2_50" as const;
/** Legacy unit accounting is USD 2 per unit; the forward BUY ledger must never be mixed into it. */
export const LEGACY_UNIT_STAKE_USD = 2;

/** Execution-authority bounds. These gate executability only; they are not selection thresholds. */
export const MAX_PROVIDER_QUOTE_AGE_MS = 30_000;
/** Tolerated provider-clock lead over our receipt clock. */
export const PROVIDER_CLOCK_SKEW_TOLERANCE_MS = 2_000;
export const MAX_DECISION_AFTER_QUOTE_MS = 10_000;
export const MAX_FEE_AGE_MS = 60_000;
/** Longest allowed gap between the quote receipt and the moment the row is handed to the database (rows are inserted in a batch after the evaluation loop). */
export const MAX_QUOTE_AGE_AT_PERSIST_MS = 60_000;
export const MAX_TAKER_FEE_RATE = 0.05;
export const MAX_REFERENCE_SLIPPAGE = 0.03;
/** Same margin the temporal gate uses: the start must still be ahead of the decision. */
export const MIN_START_LEAD_MS = 300_000;
const EPSILON = 1e-9;

export type BuyRejectReason =
  | "MODEL_NOT_BUY_ENABLED" | "IDENTITY_NOT_STRUCTURED_MONEYLINE" | "IDENTITY_TOKEN_MISMATCH" | "IDENTITY_CONDITION_MISMATCH"
  | "IDENTITY_CONDITION_UNVERIFIED" | "ECONOMIC_UNIT_UNKNOWN" | "DUPLICATE_ECONOMIC_UNIT"
  | "BOOK_UNAVAILABLE" | "MIN_ORDER_SIZE_UNKNOWN" | "STALE_AT_PERSIST" | "QUOTE_RECEIPT_MISSING" | "QUOTE_PROVIDER_TIME_MISSING" | "QUOTE_PROVIDER_TIME_IN_FUTURE" | "STALE_QUOTE"
  | "QUOTE_BEFORE_SELECTION" | "DECISION_BEFORE_QUOTE" | "DECISION_TOO_LONG_AFTER_QUOTE" | "START_NOT_AFTER_DECISION"
  | "REFERENCE_PRICE_INVALID" | "NO_ASKS" | "INSUFFICIENT_DEPTH" | "BELOW_MIN_ORDER_SIZE" | "PRICE_MOVED_AGAINST_REFERENCE" | "VWAP_OUT_OF_RANGE"
  | "FEE_UNKNOWN" | "FEE_OUT_OF_BOUNDS" | "FEE_SOURCE_MISMATCH" | "FEE_STALE" | "FEE_AFTER_DECISION";

export type BuyDiagnostics = Partial<Record<
  "model" | "conditionId" | "selectedTokenId" | "economicUnitKey" | "referencePrice" | "bestAsk" | "depthAvailableUsd" | "neededUsd"
  | "vwap" | "feeRate" | "quoteAgeMs" | "decisionMinusQuoteMs" | "detail",
  string | number | null
>>;
export type BuyRejection = { reason: BuyRejectReason; diagnostics: BuyDiagnostics };

/** The only fee authority accepted: the token-specific schedule from lib/liquidity fetchTokenFeeSchedule. */
export type BuyFeeAuthority =
  | { ok: true; tokenId: string; conditionId: string | null; feesEnabled: boolean; takerRate: number; formulaVersion: string; source: string; observedAtIso: string }
  | { ok: false; errorCode?: string };

export type BuyQuote = {
  book: ParsedOrderBook | null;
  /** Wall-clock epoch ms the request was sent and the response fully received (the quote RECEIPT). */
  requestStartedAtMs: number | null;
  receivedAtMs: number | null;
};

export type FullStakeFill = {
  filled: true;
  shares: number;
  notionalUsd: number;
  vwap: number;
  feeUsd: number;
  levelsUsed: number;
};
export type FullStakeFillResult = FullStakeFill | { filled: false; availableUsd: number };

/**
 * Walk the real ask ladder (asks must be ascending) until the FULL stake is spent. The taker fee is charged per fill level as
 * shares * rate * p * (1 - p). A ladder that cannot absorb the full stake is not a fill: there is no partial BUY.
 */
export function fillFullStake(asks: ReadonlyArray<{ price: number; size: number }>, stakeUsd: number, takerRate: number): FullStakeFillResult {
  let remaining = stakeUsd;
  let shares = 0;
  let feeUsd = 0;
  let levelsUsed = 0;
  let availableUsd = 0;
  for (const level of asks) {
    if (!(level.price > 0 && level.price < 1) || !(level.size > 0)) continue;
    const levelUsd = level.price * level.size;
    availableUsd += levelUsd;
    if (remaining <= EPSILON) continue;
    const spend = Math.min(remaining, levelUsd);
    const levelShares = spend / level.price;
    shares += levelShares;
    feeUsd += levelShares * takerRate * level.price * (1 - level.price);
    remaining -= spend;
    levelsUsed += 1;
  }
  if (remaining > EPSILON) return { filled: false, availableUsd };
  return { filled: true, shares, notionalUsd: stakeUsd, vwap: stakeUsd / shares, feeUsd, levelsUsed };
}

export type ForwardBuyReceipt = {
  version: typeof FORWARD_BUY_VERSION;
  stakeLedger: typeof FORWARD_BUY_STAKE_LEDGER;
  model: ForwardBuyModel;
  conditionId: string;
  selectedTokenId: string;
  selectedOutcome: string | null;
  marketType: string;
  scopeBasis: ForwardBetColumns["scope_basis"];
  gameIdentityBasis: ForwardBetColumns["game_identity_basis"];
  economicUnitKey: string;
  /** Original SAFE selection time (the observation). Never rewritten by the BUY path. */
  selectionObservedAt: string;
  referencePrice: number;
  stakeUsd: number;
  shares: number;
  vwap: number;
  bestAsk: number;
  depthLevelsUsed: number;
  depthAvailableUsd: number;
  fee: { usd: number; rate: number; formulaVersion: string; source: string; observedAt: string };
  allInCostUsd: number;
  allInPrice: number;
  slippageVsReference: number;
  minOrderSize: number | null;
  tickSize: number | null;
  quote: { requestStartedAt: string; receivedAt: string; providerTimestamp: string; providerAgeMs: number };
  /** Execution decision time: strictly at or after the quote receipt. */
  decisionAt: string;
  decisionMinusQuoteMs: number;
  digest: string;
};

/** Contract columns after a BUY: the three executable columns plus the provider quote time are frozen at first insert. */
export type ForwardBuyColumns = Omit<ForwardBetColumns, "decision_generated_at" | "provider_quote_at" | "executable_buy_price" | "executable_price_authority" | "executable_quote_at"> & {
  decision_generated_at: string;
  provider_quote_at: string;
  executable_buy_price: number;
  executable_price_authority: "CLOB_DEPTH_VWAP";
  executable_quote_at: string;
};

export type BuyEvaluation =
  | { ok: true; receipt: ForwardBuyReceipt; columns: ForwardBuyColumns }
  | { ok: false; rejection: BuyRejection };

export function isForwardBuyModel(model: string): model is ForwardBuyModel {
  return (FORWARD_BUY_MODELS as readonly string[]).includes(model);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function receiptDigest(receipt: Omit<ForwardBuyReceipt, "digest">): string {
  return createHash("sha256").update(canonicalJson(receipt)).digest("hex");
}

function bounded(value: string | number | null | undefined): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  return value.length > 80 ? value.slice(0, 80) : value;
}

function reject(reason: BuyRejectReason, base: BuyDiagnostics, extra: BuyDiagnostics = {}): BuyEvaluation {
  const merged: BuyDiagnostics = { ...base, ...extra };
  const diagnostics: BuyDiagnostics = {};
  for (const key of Object.keys(merged) as Array<keyof BuyDiagnostics>) diagnostics[key] = bounded(merged[key]);
  return { ok: false, rejection: { reason, diagnostics } };
}

export type BuyIdentityGate = { ok: true; base: ForwardBetColumns } | { ok: false; rejection: BuyRejection };

/**
 * Network-free identity gate: BUY-enabled model, STRUCTURED_MONEYLINE scope (structured market_type, MONEYLINE family, full
 * match, no line) and a known economic unit not already held by this model. Game identity may stay TEAM_PAIR_START_DEDUP or
 * PROVIDER_EVENT_ONLY: the BUY then simply remains UNVERIFIED because verification is computed by the database, never here.
 */
export function gateBuyIdentity(input: {
  model: string;
  source: ForwardEvidenceSource;
  candidate: ForwardCandidate;
  decisionGeneratedAt: string;
  heldEconomicUnits?: ReadonlySet<string>;
}): BuyIdentityGate {
  const { model, source, candidate } = input;
  const diag: BuyDiagnostics = { model, conditionId: source.condition_id, selectedTokenId: source.selected_token_id, referencePrice: candidate.entryPrice };
  if (!isForwardBuyModel(model)) return reject("MODEL_NOT_BUY_ENABLED", diag) as BuyIdentityGate;
  const base = buildForwardBetColumns({ model, source, candidate, decisionGeneratedAt: input.decisionGeneratedAt });
  if (base.scope_basis !== "STRUCTURED_MONEYLINE" || !source.condition_id || !source.selected_token_id) {
    return reject("IDENTITY_NOT_STRUCTURED_MONEYLINE", diag, { detail: `${base.market_type ?? "null"}|${base.market_family}|${base.period_scope}` }) as BuyIdentityGate;
  }
  if (!base.economic_unit_key) return reject("ECONOMIC_UNIT_UNKNOWN", diag) as BuyIdentityGate;
  if (input.heldEconomicUnits?.has(base.economic_unit_key)) return reject("DUPLICATE_ECONOMIC_UNIT", diag, { economicUnitKey: base.economic_unit_key }) as BuyIdentityGate;
  return { ok: true, base };
}

/**
 * Full BUY decision from a received quote and fee authority. Ordering proof: selection observation <= quote receipt <=
 * execution decision, and the provider book timestamp is present, not in the future and fresh at receipt.
 */
export function evaluateForwardBuy(input: {
  model: string;
  source: ForwardEvidenceSource;
  candidate: ForwardCandidate;
  quote: BuyQuote;
  fee: BuyFeeAuthority;
  decisionAtIso: string;
  heldEconomicUnits?: ReadonlySet<string>;
  stakeUsd?: number;
}): BuyEvaluation {
  const { model, source, candidate, quote, fee } = input;
  const decisionMs = Date.parse(input.decisionAtIso);
  const gate = gateBuyIdentity({ model, source, candidate, decisionGeneratedAt: input.decisionAtIso, heldEconomicUnits: input.heldEconomicUnits });
  if (!gate.ok) return { ok: false, rejection: gate.rejection };
  const base = gate.base;
  const diag: BuyDiagnostics = {
    model, conditionId: source.condition_id, selectedTokenId: source.selected_token_id,
    economicUnitKey: base.economic_unit_key, referencePrice: candidate.entryPrice,
  };
  const stake = input.stakeUsd ?? FORWARD_BUY_STAKE_USD;

  const book = quote.book;
  if (!book) return reject("BOOK_UNAVAILABLE", diag);
  // parseOrderBook takes the token from the request hint, so the provider's own asset_id and market are the real identity proof.
  const raw = (book.raw ?? null) as { asset_id?: unknown; market?: unknown } | null;
  if (book.tokenId !== source.selected_token_id) return reject("IDENTITY_TOKEN_MISMATCH", diag, { detail: book.tokenId });
  if (typeof raw?.asset_id !== "string" || raw.asset_id !== source.selected_token_id) return reject("IDENTITY_TOKEN_MISMATCH", diag, { detail: typeof raw?.asset_id === "string" ? raw.asset_id : "ASSET_ID_MISSING" });
  if (typeof raw.market !== "string" || raw.market.length === 0) return reject("IDENTITY_CONDITION_UNVERIFIED", diag, { detail: "BOOK_MARKET_MISSING" });
  if (raw.market.toLowerCase() !== source.condition_id.toLowerCase()) return reject("IDENTITY_CONDITION_MISMATCH", diag, { detail: raw.market });

  // Quote receipt and provider timestamp (both required; neither is ever inferred).
  if (quote.requestStartedAtMs === null || quote.receivedAtMs === null || quote.receivedAtMs < quote.requestStartedAtMs) return reject("QUOTE_RECEIPT_MISSING", diag);
  const providerMs = book.providerTimestampMs ?? null;
  if (providerMs === null) return reject("QUOTE_PROVIDER_TIME_MISSING", diag);
  if (providerMs > quote.receivedAtMs + PROVIDER_CLOCK_SKEW_TOLERANCE_MS) return reject("QUOTE_PROVIDER_TIME_IN_FUTURE", diag, { quoteAgeMs: quote.receivedAtMs - providerMs });
  const quoteAgeMs = Math.max(0, quote.receivedAtMs - providerMs);
  if (quoteAgeMs > MAX_PROVIDER_QUOTE_AGE_MS) return reject("STALE_QUOTE", diag, { quoteAgeMs });
  if (!Number.isFinite(decisionMs)) return reject("DECISION_BEFORE_QUOTE", diag, { detail: "DECISION_TIME_INVALID" });
  const selectionMs = Date.parse(source.observed_at);
  if (!Number.isFinite(selectionMs) || quote.receivedAtMs < selectionMs) return reject("QUOTE_BEFORE_SELECTION", diag, { quoteAgeMs });
  const decisionMinusQuoteMs = decisionMs - quote.receivedAtMs;
  if (decisionMinusQuoteMs < 0) return reject("DECISION_BEFORE_QUOTE", diag, { quoteAgeMs, decisionMinusQuoteMs });
  if (decisionMinusQuoteMs > MAX_DECISION_AFTER_QUOTE_MS) return reject("DECISION_TOO_LONG_AFTER_QUOTE", diag, { quoteAgeMs, decisionMinusQuoteMs });
  const startMs = source.game_start_iso ? Date.parse(source.game_start_iso) : NaN;
  if (!Number.isFinite(startMs) || startMs <= decisionMs + MIN_START_LEAD_MS) return reject("START_NOT_AFTER_DECISION", diag, { decisionMinusQuoteMs });

  // Bounded fee authority.
  if (!fee.ok) return reject("FEE_UNKNOWN", diag, { detail: fee.errorCode ?? "FEE_FETCH_FAILED" });
  if (fee.tokenId !== source.selected_token_id || fee.conditionId === null || fee.conditionId.toLowerCase() !== source.condition_id.toLowerCase()) {
    return reject("FEE_SOURCE_MISMATCH", diag, { detail: fee.conditionId ?? "null" });
  }
  if (!Number.isFinite(fee.takerRate) || fee.takerRate < 0 || fee.takerRate > MAX_TAKER_FEE_RATE) return reject("FEE_OUT_OF_BOUNDS", diag, { feeRate: fee.takerRate });
  if (!fee.feesEnabled && fee.takerRate !== 0) return reject("FEE_OUT_OF_BOUNDS", diag, { feeRate: fee.takerRate });
  const feeAtMs = Date.parse(fee.observedAtIso);
  if (!Number.isFinite(feeAtMs)) return reject("FEE_UNKNOWN", diag, { detail: "FEE_TIME_INVALID" });
  if (feeAtMs > decisionMs) return reject("FEE_AFTER_DECISION", diag, { feeRate: fee.takerRate });
  if (decisionMs - feeAtMs > MAX_FEE_AGE_MS) return reject("FEE_STALE", diag, { feeRate: fee.takerRate });

  // Real depth pricing.
  const reference = candidate.entryPrice;
  if (!(reference > 0 && reference < 1)) return reject("REFERENCE_PRICE_INVALID", diag);
  const asks = book.asks;
  if (asks.length === 0) return reject("NO_ASKS", diag);
  const bestAsk = asks[0].price;
  const fill = fillFullStake(asks, stake, fee.takerRate);
  if (!fill.filled) return reject("INSUFFICIENT_DEPTH", diag, { bestAsk, depthAvailableUsd: fill.availableUsd, neededUsd: stake });
  if (book.minimumOrderSize == null) return reject("MIN_ORDER_SIZE_UNKNOWN", diag, { bestAsk });
  if (fill.shares + EPSILON < book.minimumOrderSize) return reject("BELOW_MIN_ORDER_SIZE", diag, { bestAsk, detail: `shares=${fill.shares.toFixed(4)} min=${book.minimumOrderSize}` });
  const vwap = Math.round(fill.vwap * 1e6) / 1e6;
  if (!(vwap > 0 && vwap < 1)) return reject("VWAP_OUT_OF_RANGE", diag, { bestAsk, vwap });
  const slippage = vwap - reference;
  if (slippage > MAX_REFERENCE_SLIPPAGE + EPSILON) return reject("PRICE_MOVED_AGAINST_REFERENCE", diag, { bestAsk, vwap });

  const depthAvailableUsd = asks.reduce((sum, level) => sum + (level.price > 0 && level.price < 1 && level.size > 0 ? level.price * level.size : 0), 0);
  const allInCostUsd = stake + fill.feeUsd;
  const unsigned: Omit<ForwardBuyReceipt, "digest"> = {
    version: FORWARD_BUY_VERSION,
    stakeLedger: FORWARD_BUY_STAKE_LEDGER,
    model: model as ForwardBuyModel,
    conditionId: source.condition_id,
    selectedTokenId: source.selected_token_id,
    selectedOutcome: source.selected_outcome ?? null,
    marketType: base.market_type ?? "moneyline",
    scopeBasis: base.scope_basis,
    gameIdentityBasis: base.game_identity_basis,
    economicUnitKey: base.economic_unit_key as string,
    selectionObservedAt: source.observed_at,
    referencePrice: reference,
    stakeUsd: stake,
    shares: fill.shares,
    vwap,
    bestAsk,
    depthLevelsUsed: fill.levelsUsed,
    depthAvailableUsd,
    fee: { usd: fill.feeUsd, rate: fee.takerRate, formulaVersion: fee.formulaVersion, source: fee.source, observedAt: fee.observedAtIso },
    allInCostUsd,
    allInPrice: allInCostUsd / fill.shares,
    slippageVsReference: slippage,
    minOrderSize: book.minimumOrderSize ?? null,
    tickSize: book.tickSize ?? null,
    quote: {
      requestStartedAt: new Date(quote.requestStartedAtMs).toISOString(),
      receivedAt: new Date(quote.receivedAtMs).toISOString(),
      providerTimestamp: new Date(providerMs).toISOString(),
      providerAgeMs: quoteAgeMs,
    },
    decisionAt: new Date(decisionMs).toISOString(),
    decisionMinusQuoteMs,
  };
  const receipt: ForwardBuyReceipt = { ...unsigned, digest: receiptDigest(unsigned) };
  return { ok: true, receipt, columns: applyBuyToColumns(base, receipt) };
}

/**
 * Overlay the executable evidence on the contract columns. verification_status, timing_class and contract_status are
 * deliberately absent: the database computes them, so a BUY can never promote an incomplete identity to VERIFIED.
 */
export function applyBuyToColumns(base: ForwardBetColumns, receipt: ForwardBuyReceipt): ForwardBuyColumns {
  if (base.contract_version !== FORWARD_BET_CONTRACT_VERSION) throw new Error("FORWARD_BUY_REQUIRES_CONTRACT_COLUMNS");
  return {
    ...base,
    decision_generated_at: receipt.decisionAt,
    provider_quote_at: receipt.quote.providerTimestamp,
    executable_buy_price: receipt.vwap,
    executable_price_authority: "CLOB_DEPTH_VWAP",
    executable_quote_at: receipt.quote.receivedAt,
  };
}

/** Bounded rejection summary: reason counts plus at most `sampleLimit` diagnostics. */
export function summarizeRejections(rejections: readonly BuyRejection[], sampleLimit = 20): { total: number; byReason: Record<string, number>; samples: BuyRejection[] } {
  const byReason: Record<string, number> = {};
  for (const rejection of rejections) byReason[rejection.reason] = (byReason[rejection.reason] ?? 0) + 1;
  return { total: rejections.length, byReason, samples: rejections.slice(0, sampleLimit) };
}

/**
 * Persist-time freshness: rows are inserted in a batch after the evaluation loop, so the quote must still be recent and the
 * start still ahead when the row is handed to the database (the database stamps first_persisted_at moments later).
 */
export function checkBuyPersistFreshness(columns: Pick<ForwardBuyColumns, "executable_quote_at" | "scheduled_start_at">, nowMs: number): BuyRejection | null {
  const quoteMs = Date.parse(columns.executable_quote_at);
  const startMs = columns.scheduled_start_at ? Date.parse(columns.scheduled_start_at) : NaN;
  if (!Number.isFinite(quoteMs) || nowMs - quoteMs > MAX_QUOTE_AGE_AT_PERSIST_MS) return { reason: "STALE_AT_PERSIST", diagnostics: { quoteAgeMs: Number.isFinite(quoteMs) ? nowMs - quoteMs : null } };
  if (!Number.isFinite(startMs) || startMs <= nowMs + MIN_START_LEAD_MS) return { reason: "START_NOT_AFTER_DECISION", diagnostics: { detail: "AT_PERSIST" } };
  return null;
}
