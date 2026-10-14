/**
 * FORWARD_DECISION_V2 (Research DBClone only): pure builders for the immutable prospective virtual decision.
 *
 *  - BET  -> existing ledger public.prospective_selection_shadow_runtime (contract_version FORWARD_DECISION_V2)
 *  - SKIP -> append-only sibling public.forward_decision_v2_skip (evidence only; it claims nothing)
 *
 * Virtual size is 5 shares of the EXACT selected token, filled on that token's own CLOB asks. Each SAFE model keeps its own frozen
 * price eligibility (the frozen selector chose the pick); no price threshold is introduced here. Fees are never fetched, never
 * assumed zero: fee_state / net_state are NOT_EVALUATED. The database owns first_persisted_at and every timing derivative.
 */
import { createHash } from "node:crypto";
import type { FetchOrderBookResult } from "../liquidity/types";
import { t90CutoffMs } from "./executableLiquidityCohortT90";
import { causalEdge, sourceRowEdge, type ModelEventDecision, type ModelRef } from "./forwardModelDecisionsT90";

export const FORWARD_DECISION_V2 = Object.freeze({
  version: "FORWARD_DECISION_V2",
  ledgerTable: "prospective_selection_shadow_runtime",
  skipTable: "forward_decision_v2_skip",
  clockRpc: "forward_decision_v2_clock",
  migration: "20261014120000_forward_decision_v2_contract",
  virtualShares: 5,
  /** A decision must be persisted within this window of its generation (mirrors the DB trigger). */
  maxPersistDelayMs: 300_000,
  fee: "NOT_EVALUATED",
  net: "NOT_EVALUATED",
  skipReasons: ["MODEL_PREDICATE_EVALUATED_NOT_SELECTED", "MODEL_GATE_EVALUATED_REJECTED", "MODEL_SELECTED_DAILY_CAP_SPENT"] as const,
});

export const DEFINITION_HEX = /^[0-9a-f]{64}$/;
export const SOURCE_SHA_HEX = /^[0-9a-f]{40}$/;

// ── 5-share virtual fill on the exact token's own asks ───────────────────────────────────────────────────────────────

export type VirtualFill =
  | {
    state: "FILLED"; shares: number; grossCostUsd: number; vwap: number; bestAsk: number; worstAsk: number; levelsUsed: number;
    venueMinOrderSize: number; providerQuoteAtMs: number; responseCompletedAtMs: number | null;
  }
  | { state: "BLOCKED"; reason: "BOOK_MISSING" | "BOOK_TOKEN_MISMATCH" | "BOOK_ASK_LEVEL_INVALID" | "BOOK_TIMESTAMP_UNKNOWN" | "VENUE_MIN_ORDER_UNKNOWN" | "VENUE_MIN_ORDER_ABOVE_VIRTUAL_SIZE" | "DEPTH_BELOW_VIRTUAL_SIZE" };

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * Pure. Walks the exact token's asks (ascending) for exactly `shares`. Honors the venue minimum order size: an unknown minimum or
 * a minimum above the virtual size is BLOCKED, never defaulted and never escalated. No price cap is applied here.
 */
export function fillVirtualShares(tokenId: string, result: FetchOrderBookResult | null | undefined, shares: number = FORWARD_DECISION_V2.virtualShares): VirtualFill {
  if (!result || !result.ok || !result.book) return { state: "BLOCKED", reason: "BOOK_MISSING" };
  const book = result.book;
  if (book.tokenId !== tokenId || result.tokenId !== tokenId) return { state: "BLOCKED", reason: "BOOK_TOKEN_MISMATCH" };
  const providerTs = book.providerTimestampMs;
  if (typeof providerTs !== "number" || !Number.isFinite(providerTs)) return { state: "BLOCKED", reason: "BOOK_TIMESTAMP_UNKNOWN" };
  const min = book.minimumOrderSize;
  if (typeof min !== "number" || !Number.isFinite(min) || min <= 0) return { state: "BLOCKED", reason: "VENUE_MIN_ORDER_UNKNOWN" };
  if (min > shares) return { state: "BLOCKED", reason: "VENUE_MIN_ORDER_ABOVE_VIRTUAL_SIZE" };
  const asks = book.asks;
  for (const level of asks) {
    if (!(Number.isFinite(level.price) && level.price > 0 && level.price < 1 && Number.isFinite(level.size) && level.size > 0)) return { state: "BLOCKED", reason: "BOOK_ASK_LEVEL_INVALID" };
  }
  const ordered = [...asks].sort((a, b) => a.price - b.price);
  let remaining = shares;
  let cost = 0;
  let used = 0;
  let worst = 0;
  for (const level of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, level.size);
    cost += take * level.price;
    remaining = round9(remaining - take);
    used++;
    worst = level.price;
  }
  if (remaining > 0 || used === 0) return { state: "BLOCKED", reason: "DEPTH_BELOW_VIRTUAL_SIZE" };
  const gross = round9(cost);
  return {
    state: "FILLED", shares, grossCostUsd: gross, vwap: round9(gross / shares), bestAsk: ordered[0].price, worstAsk: worst, levelsUsed: used,
    venueMinOrderSize: min, providerQuoteAtMs: providerTs, responseCompletedAtMs: result.responseCompletedAtMs ?? null,
  };
}

// ── identities ──────────────────────────────────────────────────────────────────────────────────────────────────────

const sha = (parts: readonly string[]) => createHash("sha256").update(parts.join("\u0001")).digest("hex");
/** Deterministic across runs and across model definitions: a BET claim is keyed by model_id and event only. */
export const betRowKey = (modelId: string, physicalEventKey: string) => `FDV2:BET:${sha([modelId, physicalEventKey])}`;
/** One SKIP per (model_id, definition digest, physical event). */
export const skipRowKey = (modelId: string, definitionDigest: string, physicalEventKey: string) => `FDV2:SKIP:${sha([modelId, definitionDigest, physicalEventKey])}`;

export const definitionDigestOf = (modelVersion: string): string | null => {
  const m = /^def-sha256:([0-9a-f]{64})$/.exec(modelVersion);
  return m ? m[1] : null;
};

const minskDate = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);
const isoOf = (ms: number) => new Date(ms).toISOString();

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type V2Blocked = { ok: false; reason: string };
export type V2BetRow = Record<string, string | number | null | Record<string, unknown>>;
export type V2SkipRow = Record<string, string | number | null | Record<string, unknown>>;

export type BuildContext = {
  /** DB clock instant (forward_decision_v2_clock) sampled after the fill was measured. The decision is sealed here. */
  decisionGeneratedAtMs: number;
  sourceSha: string | null;
  cohortDigest: string;
  /** Registered independent actual-start evidence; null = scheduled-only (PROVISIONAL). Never inferred. */
  authoritativeStart: { atIso: string; source: "OFFICIAL_SOURCE_CONFIRMED_START" | "PROVIDER_PUBLISHED_ACTUAL_START" } | null;
};

function identityEdge(model: Pick<ModelRef, "modelId" | "modelVersion">, ctx: BuildContext): string | null {
  if (!definitionDigestOf(model.modelVersion)) return "MODEL_DEFINITION_DIGEST_UNPROVEN";
  if (!ctx.sourceSha || !SOURCE_SHA_HEX.test(ctx.sourceSha)) return "SOURCE_SHA_UNPROVEN";
  return null;
}

/** Client-side mirror of the DB timing rules; the DB trigger remains the authority and re-derives every timing field. */
function preflightTiming(eventStartIso: string, ctx: BuildContext): string | null {
  if (!Number.isFinite(ctx.decisionGeneratedAtMs)) return "UNPROVEN_DECISION_GENERATION_TIME";
  const authoritative = ctx.authoritativeStart ? Date.parse(ctx.authoritativeStart.atIso) : null;
  if (ctx.authoritativeStart && !Number.isFinite(authoritative)) return "AUTHORITATIVE_START_INVALID";
  const start = Math.min(Date.parse(eventStartIso), authoritative ?? Number.POSITIVE_INFINITY);
  if (!(ctx.decisionGeneratedAtMs < t90CutoffMs(isoOf(start)))) return "DECISION_AT_OR_AFTER_T90";
  return null;
}

/** Pure. A BET decision plus its 5-share fill -> the V2 ledger row. Anything unproven is blocked, never fabricated. */
export function buildV2BetRow(decision: ModelEventDecision, fill: VirtualFill, ctx: BuildContext): { ok: true; row: V2BetRow } | V2Blocked {
  if (decision.outcome !== "BET" || !decision.bet) return { ok: false, reason: "NOT_A_BET" };
  const bet = decision.bet;
  const identity = identityEdge(decision, ctx);
  if (identity) return { ok: false, reason: identity };
  if (decision.versionAuthority !== "DEFINITION_DIGEST") return { ok: false, reason: "MODEL_DEFINITION_DIGEST_UNPROVEN" };
  const rowEdge = sourceRowEdge(bet) ?? causalEdge(bet, decision.eventStartIso, ctx.decisionGeneratedAtMs);
  if (rowEdge) return { ok: false, reason: rowEdge };
  const timing = preflightTiming(decision.eventStartIso, ctx);
  if (timing) return { ok: false, reason: timing };
  if (fill.state !== "FILLED") return { ok: false, reason: `VIRTUAL_FILL_${fill.reason}` };
  if (fill.providerQuoteAtMs > ctx.decisionGeneratedAtMs) return { ok: false, reason: "QUOTE_AFTER_DECISION_GENERATION" };
  if (fill.providerQuoteAtMs > t90CutoffMs(decision.eventStartIso)) return { ok: false, reason: "QUOTE_AFTER_T90" };
  if (!(bet.entryPrice > 0 && bet.entryPrice < 1)) return { ok: false, reason: "MODEL_ENTRY_PRICE_INVALID" };
  const digest = definitionDigestOf(decision.modelVersion)!;
  const key = bet.modelPhysicalEventKey;
  const row: V2BetRow = {
    row_key: betRowKey(decision.modelId, key), row_kind: "LEDGER", contract_version: FORWARD_DECISION_V2.version, decision_kind: "BET",
    model_id: decision.modelId, model_version: decision.modelVersion, definition_digest: digest, source_sha: ctx.sourceSha!,
    decision_date: minskDate(bet.observedAt), candidate_identity: bet.candidateIdentity, physical_event_key: key, economic_unit_key: `PE:${key}`,
    decision_timestamp: bet.observedAt, event_start: decision.eventStartIso, scheduled_start_at: decision.eventStartIso,
    authoritative_start_at: ctx.authoritativeStart?.atIso ?? null, authoritative_start_source: ctx.authoritativeStart?.source ?? null,
    entry_price: bet.entryPrice, sport_family: decision.sportFamily, condition_id: bet.conditionId, selected_token_id: bet.tokenId,
    selected_outcome: bet.outcomeLabel, pre_event_score: bet.cohortSource.score, provider_event_id: bet.modelPhysicalEventKey,
    market_type: bet.providerMarketType || null,
    settlement_state: "UNQUERIED", observed_at: bet.observedAt, source_ingested_at: bet.sourceIngestedAt!,
    source_observation_id: bet.sourceRow!.observationId, source_item_observation_id: bet.sourceRow!.itemObservationId,
    decision_generated_at: isoOf(ctx.decisionGeneratedAtMs),
    virtual_shares: fill.shares, virtual_fill_vwap: fill.vwap, virtual_gross_cost_usd: fill.grossCostUsd, venue_min_order_size: fill.venueMinOrderSize,
    executable_price_authority: "CLOB_DEPTH_VWAP", executable_buy_price: fill.vwap, executable_quote_at: isoOf(fill.providerQuoteAtMs),
    fee_state: FORWARD_DECISION_V2.fee, net_state: FORWARD_DECISION_V2.net,
    evaluation_evidence: {
      cohort: { digest: ctx.cohortDigest, physical_event_id: decision.physicalEventId, t90_cutoff_at: decision.t90CutoffIso },
      model: { id: decision.modelId, version: decision.modelVersion, version_authority: decision.versionAuthority, source_sha: ctx.sourceSha },
      pick: { candidate_identity: bet.candidateIdentity, token_id: bet.tokenId, opposite_token_id: bet.oppositeTokenId, claim_instant: bet.claimInstant, model_entry_price: bet.entryPrice },
      fill: { shares: fill.shares, gross_cost_usd: fill.grossCostUsd, vwap: fill.vwap, best_ask: fill.bestAsk, worst_ask: fill.worstAsk, levels_used: fill.levelsUsed, price_drift_vs_model_entry: round9(fill.vwap - bet.entryPrice), size_basis: "RESEARCH_VIRTUAL_5_SHARES", price_authority: "MODEL_OWN_FROZEN_RULE_AT_SELECTION" },
      fees: { state: FORWARD_DECISION_V2.fee, note: "not fetched, not assumed zero" },
    },
  };
  return { ok: true, row };
}

export type SkipEvidence = {
  reason: (typeof FORWARD_DECISION_V2.skipReasons)[number];
  /** The model's own provider event key for the evaluated token (the key a BET by this model would claim). */
  physicalEventKey: string;
  /** Latest cited source row of the evaluated token (the model's own evaluation input). */
  source: { observedAt: string; ingestedAt: string; observationId: string; itemObservationId: string; conditionId: string; tokenId: string };
  evaluatedTokenKeys: readonly string[];
};

export const isSkipReason = (r: string): r is SkipEvidence["reason"] => (FORWARD_DECISION_V2.skipReasons as readonly string[]).includes(r);

/** Pure. An evaluated SKIP decision plus the model's own evaluation evidence -> the V2 SKIP row. */
export function buildV2SkipRow(decision: ModelEventDecision, evidence: SkipEvidence | null, ctx: BuildContext): { ok: true; row: V2SkipRow } | V2Blocked {
  if (decision.outcome !== "SKIP") return { ok: false, reason: "NOT_A_SKIP" };
  if (!isSkipReason(decision.reason) || !evidence || evidence.reason !== decision.reason) return { ok: false, reason: "SKIP_EVIDENCE_MISSING" };
  const identity = identityEdge(decision, ctx);
  if (identity) return { ok: false, reason: identity };
  if (decision.versionAuthority !== "DEFINITION_DIGEST") return { ok: false, reason: "MODEL_DEFINITION_DIGEST_UNPROVEN" };
  const observed = Date.parse(evidence.source.observedAt);
  const ingested = Date.parse(evidence.source.ingestedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(ingested)) return { ok: false, reason: "SKIP_SOURCE_TIME_UNPROVEN" };
  if (observed > ingested) return { ok: false, reason: "SOURCE_OBSERVED_AFTER_INGEST" };
  if (ingested > ctx.decisionGeneratedAtMs) return { ok: false, reason: "DECISION_BEFORE_SOURCE_INGEST" };
  const timing = preflightTiming(decision.eventStartIso, ctx);
  if (timing) return { ok: false, reason: timing };
  const digest = definitionDigestOf(decision.modelVersion)!;
  const row: V2SkipRow = {
    row_key: skipRowKey(decision.modelId, digest, evidence.physicalEventKey), contract_version: FORWARD_DECISION_V2.version, decision_kind: "SKIP",
    model_id: decision.modelId, model_version: decision.modelVersion, definition_digest: digest, source_sha: ctx.sourceSha!,
    physical_event_key: evidence.physicalEventKey, cohort_physical_event_id: decision.physicalEventId, sport_family: decision.sportFamily, skip_reason: evidence.reason,
    observed_at: evidence.source.observedAt, source_ingested_at: evidence.source.ingestedAt, decision_generated_at: isoOf(ctx.decisionGeneratedAtMs),
    scheduled_start_at: decision.eventStartIso, authoritative_start_at: ctx.authoritativeStart?.atIso ?? null, authoritative_start_source: ctx.authoritativeStart?.source ?? null,
    fee_state: FORWARD_DECISION_V2.fee, net_state: FORWARD_DECISION_V2.net,
    evaluation_evidence: {
      cohort: { digest: ctx.cohortDigest, physical_event_id: decision.physicalEventId, t90_cutoff_at: decision.t90CutoffIso },
      model: { id: decision.modelId, version: decision.modelVersion, version_authority: decision.versionAuthority, source_sha: ctx.sourceSha },
      evaluation: { reason: evidence.reason, evaluated_token_keys: [...evidence.evaluatedTokenKeys].sort(), cited_source: evidence.source },
    },
  };
  return { ok: true, row };
}

// ── writer-level idempotency ────────────────────────────────────────────────────────────────────────────────────────

export type PriorClaims = {
  /** model_id -> physical_event_key held by ANY legacy / V1 / V2 BET claim. */
  betClaims: ReadonlyMap<string, ReadonlySet<string>>;
  /** `${model_id}|${model_version}|${physical_event_key}` already holding a V2 SKIP. */
  skips: ReadonlySet<string>;
};

export type WriteVerdict = "WRITE" | "ALREADY_CLAIMED_BET" | "ALREADY_PERSISTED_SKIP" | "SKIP_AFTER_BET_CLAIM";

/** Pure pre-write decision. The DB constraints/trigger remain the race-proof authority; this removes avoidable conflicts. */
export function writeVerdict(kind: "BET" | "SKIP", modelId: string, modelVersion: string, physicalEventKey: string, prior: PriorClaims): WriteVerdict {
  const claimed = prior.betClaims.get(modelId)?.has(physicalEventKey) === true;
  if (kind === "BET") return claimed ? "ALREADY_CLAIMED_BET" : "WRITE";
  if (claimed) return "SKIP_AFTER_BET_CLAIM";
  return prior.skips.has(`${modelId}|${modelVersion}|${physicalEventKey}`) ? "ALREADY_PERSISTED_SKIP" : "WRITE";
}

/** Postgres unique_violation (row_key / unique index / guard DUPLICATE_ECONOMIC_UNIT) = already decided; never retried, never overwritten. */
export const isIdempotentConflict = (error: { code?: string | null; message?: string | null } | null | undefined) =>
  !!error && (error.code === "23505" || /DUPLICATE_ECONOMIC_UNIT|SKIP_AFTER_BET_CLAIM/.test(error.message ?? ""));
