// T10_EXACT_MARKET_REFERENCE_SHADOW_PROOF_V1 — SHADOW-ONLY exact-market price-reference engine.
//
// Pure, deterministic classification of whether ONE exact market token
// (physical event + condition_id + token_id + side) has defensible, non-circular
// market-price evidence before Queue. It is market price evidence only; it is
// NOT a probability and it is not read by any money path (Queue, TAKER, MAKER,
// LIVE_GUARD, stake, price cap, Reservation) in this version.
//
// Frozen V1 rule (conservative):
//   STRONG     = >=2 usable, non-duplicative, identity-exact witnesses whose
//                [best_bid, best_ask] intervals share a common price (market-grid
//                overlap rule — no new tolerance constant).
//   WEAK       = exactly 1 usable witness.
//   UNRESOLVED = 0 usable witnesses, identity inconsistency, or >=2 usable
//                witnesses with no common price (irreconcilable conflict).
//   reference_price is null whenever status = UNRESOLVED.
//
// Source rules:
//   - SAME condition_id, other token (binary complement) is a mirror of the SAME
//     CLOB: diagnostic only, never a witness, never upgrades WEAK -> STRONG.
//   - Book witnesses (T_MINUS_30 / T_MINUS_10) reuse existing capture semantics:
//     complete capture run, SUCCESS fetch, observation inside the phase window of
//     classifyReservationMarketPhase, two-sided book, and spread within the existing
//     LIVE_EXECUTION_MAX_SPREAD used here ONLY as a source-quality label.
//   - Recent trade: no authoritative carrier exists in the T10 lineage -> SOURCE_UNAVAILABLE.
//   - Planning price / other line / other family: never a witness for another exact
//     market; no validated exact mapping between lines exists in this engine.
import { LIVE_EXECUTION_MAX_SPREAD } from "./executorQueueTypes";
import { classifyReservationMarketPhase } from "./reservationMarketBaseline";

export const EXACT_MARKET_REFERENCE_VERSION = "EXACT_MARKET_REFERENCE_SHADOW_V1" as const;

export type ExactMarketIdentity = {
  physicalEventId: string;
  conditionId: string;
  tokenId: string;
  side: string;
};

export type ReferenceSource =
  | "T10_BOOK"
  | "T30_BOOK"
  | "RECENT_TRADE"
  | "PLANNING_PRICE"
  | "BINARY_COMPLEMENT"
  | "OTHER_LINE";

export type ReferenceEvidence = {
  source: ReferenceSource;
  /** Unique id of the underlying observation; repeated keys are duplicates. */
  observationKey: string;
  identity: ExactMarketIdentity;
  observationPhase?: string | null;
  captureComplete?: boolean | null;
  fetchStatus?: string | null;
  bestBid?: number | null;
  bestAsk?: number | null;
  observedAt?: string | null;
  eventStartIso?: string | null;
};

export type ExactMarketReferenceStatus = "STRONG" | "WEAK" | "UNRESOLVED";

export type ExactMarketReference = {
  status: ExactMarketReferenceStatus;
  reference_price: number | null;
  uncertainty: number | null;
  independent_witness_count: number;
  sources_used: string[];
  rejected_sources: { source: string; reason: string }[];
  reason: string;
  version: typeof EXACT_MARKET_REFERENCE_VERSION;
};

const BOOK_PHASE: Partial<Record<ReferenceSource, "T_MINUS_30" | "T_MINUS_10">> = {
  T30_BOOK: "T_MINUS_30",
  T10_BOOK: "T_MINUS_10",
};
// Float guard only (prices are on a >=0.001 tick grid); not a pricing tolerance.
const FLOAT_EPS = 1e-9;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

type Usable = { source: ReferenceSource; bid: number; ask: number };

function bookRejection(item: ReferenceEvidence, phase: "T_MINUS_30" | "T_MINUS_10"): string | null {
  if (item.observationPhase !== phase) return "PHASE_LABEL_MISMATCH";
  if (item.captureComplete !== true) return "CAPTURE_INCOMPLETE";
  if (item.fetchStatus !== "SUCCESS") return "ORDERBOOK_FETCH_NOT_SUCCESS";
  const start = item.eventStartIso ?? "";
  const observedMs = Date.parse(item.observedAt ?? "");
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(observedMs) ||
      classifyReservationMarketPhase(start, observedMs) !== phase) return "STALE_OR_OUTSIDE_PHASE_WINDOW";
  const { bestBid: bid, bestAsk: ask } = item;
  if (!finite(bid) || !finite(ask) || bid <= 0 || ask >= 1) return "BOOK_ONE_SIDED";
  if (bid > ask + FLOAT_EPS) return "BOOK_CROSSED";
  if (ask - bid > LIVE_EXECUTION_MAX_SPREAD + FLOAT_EPS) return "BOOK_SPREAD_ABOVE_SOURCE_QUALITY";
  return null;
}

export function evaluateExactMarketReference(
  target: ExactMarketIdentity,
  evidence: readonly ReferenceEvidence[],
): ExactMarketReference {
  const rejected: { source: string; reason: string }[] = [];
  const usable: Usable[] = [];
  const seenKeys = new Set<string>();
  const seenSources = new Set<ReferenceSource>();
  let identityInconsistent = false;
  const reject = (source: string, reason: string) => rejected.push({ source, reason });

  for (const item of evidence) {
    const id = item.identity;
    if (id.physicalEventId !== target.physicalEventId) {
      reject(item.source, "IDENTITY_PHYSICAL_EVENT_MISMATCH");
      continue;
    }
    if (id.conditionId !== target.conditionId) {
      reject(item.source, item.source === "PLANNING_PRICE"
        ? "PLANNING_SIBLING_NOT_EXACT_MARKET" : "OTHER_MARKET_NO_VALIDATED_EXACT_MAPPING");
      continue;
    }
    if (id.tokenId !== target.tokenId) {
      // Same condition, other token: the binary mirror of the same CLOB.
      if (id.side === target.side) identityInconsistent = true;
      reject(item.source, id.side === target.side ? "IDENTITY_SIDE_TOKEN_INCONSISTENT" : "SAME_CONDITION_BINARY_MIRROR");
      continue;
    }
    if (id.side !== target.side) {
      identityInconsistent = true;
      reject(item.source, "IDENTITY_SIDE_TOKEN_INCONSISTENT");
      continue;
    }
    // Exact identity from here on.
    if (item.source === "BINARY_COMPLEMENT" || item.source === "OTHER_LINE") {
      identityInconsistent = true;
      reject(item.source, "SOURCE_LABEL_IDENTITY_CONFLICT");
      continue;
    }
    if (item.source === "RECENT_TRADE") {
      reject(item.source, "SOURCE_UNAVAILABLE_NO_AUTHORITATIVE_CARRIER");
      continue;
    }
    if (item.source === "PLANNING_PRICE") {
      reject(item.source, "PLANNING_PRICE_NO_CAPTURE_SEMANTICS");
      continue;
    }
    if (seenKeys.has(item.observationKey) || seenSources.has(item.source)) {
      reject(item.source, "DUPLICATE_OBSERVATION");
      continue;
    }
    seenKeys.add(item.observationKey);
    seenSources.add(item.source);
    const phase = BOOK_PHASE[item.source];
    const reason = phase ? bookRejection(item, phase) : "UNKNOWN_SOURCE";
    if (reason) {
      reject(item.source, reason);
      continue;
    }
    usable.push({ source: item.source, bid: item.bestBid as number, ask: item.bestAsk as number });
  }

  const base = { rejected_sources: rejected, version: EXACT_MARKET_REFERENCE_VERSION };
  const unresolved = (reason: string, count: number): ExactMarketReference => ({
    ...base, status: "UNRESOLVED", reference_price: null, uncertainty: null,
    independent_witness_count: count, sources_used: [], reason,
  });
  if (identityInconsistent) return unresolved("IDENTITY_INCONSISTENT", 0);
  if (usable.length === 0) return unresolved("NO_USABLE_EXACT_WITNESS", 0);
  const sources = usable.map((u) => u.source);
  if (usable.length === 1) {
    const [{ bid, ask }] = usable;
    return {
      ...base, status: "WEAK", reference_price: round((bid + ask) / 2), uncertainty: round((ask - bid) / 2),
      independent_witness_count: 1, sources_used: sources, reason: "SINGLE_EXACT_WITNESS",
    };
  }
  const lo = Math.max(...usable.map((u) => u.bid));
  const hi = Math.min(...usable.map((u) => u.ask));
  if (lo > hi + FLOAT_EPS) return unresolved("WITNESS_CONFLICT_NO_COMMON_PRICE", usable.length);
  return {
    ...base, status: "STRONG", reference_price: round((lo + hi) / 2), uncertainty: round(Math.max(0, hi - lo) / 2),
    independent_witness_count: usable.length, sources_used: sources, reason: "EXACT_WITNESSES_AGREE",
  };
}
