// EXECUTABLE_LIQUIDITY_COHORT_T90_V2
//
// RESEARCH-ONLY prospective physical-event cohort (Founder Law #1, Issue #532). It is NOT a virtual BET, a Ledger row,
// a model decision or evidence of profitability. It answers one question: "which DISTINCT PHYSICAL events, ranked by
// independently measured executable liquidity within each sport, form today's T-90 research sample, and what is the
// complete scored market/token inventory behind each of them". Nothing here writes to any database; all reads are injected.
// The legacy 40/20/40 T20 sampler (lib/executor/precontractT20Research.ts) is untouched.
//
// Six SEPARATE contracts (V1 conflated 2-4; V2 keeps them apart):
//   1. candidate inventory      every causal scored condition, BOTH provider-confirmed tokens, kept through measurement
//   2. research liquidity        ONE common measurement for every token of every event: the existing T10 executable-sibling
//                                benchmark (buildExecutableSiblingColumns with its own defaults), never a model ceiling
//   3. physical-event ranking    eligibility, anchor, per-sport rank, quota and cutoff use ONLY contract 2 + source + provider
//   4. frozen BET/SKIP           NOT evaluated here. attachModelDecisions() runs AFTER the cohort is frozen and cannot alter it
//   5. strategy trade economics  NOT evaluated here (Mission B)
//   6. LIVE Queue eligibility    reported per token from the Queue's own constants; never read by 3
//
// Resolved authority (never invented):
//   quotas                50 / 25 / 25, 100 distinct physical events per daily cycle  Founder Law #1; MAX_RESEARCH_EVENTS_PER_DAY
//   "other" subdivision   OTHER_SPORT_FAMILIES, OTHER_DIVERSITY_FLOOR_PER_SPORT floor, then liquidity fill inside "other" only
//   research measurement  T10_EXECUTABLE_SIBLING_TELEMETRY_V1 benchmark: $2.50 full-stake TAKER walk, venue min-order test,
//                         ask USD depth at/below the benchmark limit. The $4.00 adaptive headroom is NOT used.
// UNRESOLVED_AUTHORITY (reported in every receipt; blocks a business PASS, never replaced by an invented value):
//   - the benchmark's price limit is defined as QUEUE_MAX_ENTRY_PRICE; no strategy-neutral research ceiling that is
//     independent of the LIVE Queue exists in the repository (Architect B2);
//   - Law #1 "approved liquidity minimum" above full-stake executability;
//   - a maximum quote age (freshness);
//   - a DB-owned decision_at: no read-only DB clock is exposed to this runner without a migration.
import { createHash } from "node:crypto";
import { fetchOrderBooksConcurrent, fetchTokenFeeSchedule, type TokenFeeScheduleResult } from "../liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../liquidity/types";
import { physicalMatchId } from "../executor/contractADecisions";
import { buildExecutableSiblingColumns } from "../executor/t10ExecutableSiblingTelemetry";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "../executor/executorQueueTypes";
import { defaultExactEventReader, inventoryTokens, T10_EXECUTABLE_TELEMETRY_VERSION } from "../executor/reservationMarketBaseline";
import {
  admitResearchMarket, MAX_RESEARCH_EVENTS_PER_DAY, OTHER_DIVERSITY_FLOOR_PER_SPORT, OTHER_SPORT_FAMILIES, TARGET_SPORT_FAMILIES,
} from "../executor/precontractT20Research";

export const COHORT_VERSION = "EXECUTABLE_LIQUIDITY_COHORT_T90_V2";
export const APPROVED_SCORED_FORMULA = "v2-lite-growth-safe";
export const SOCCER_QUOTA_T90 = 50;
export const TENNIS_QUOTA_T90 = 25;
export const OTHER_QUOTA_T90 = 25;
export const T90_MINUTES = 90;
/** Daily research cycle: events whose start falls in (reference + T-90, reference + 24h]. */
export const COHORT_HORIZON_HOURS = 24;

/** Contract 2. Exactly the T10 benchmark: buildExecutableSiblingColumns is called WITHOUT stake/cap overrides. */
export const RESEARCH_LIQUIDITY_CONTRACT = Object.freeze({
  id: T10_EXECUTABLE_TELEMETRY_VERSION,
  stakeUsd: QUEUE_DEFAULT_STAKE_USD,
  priceLimit: QUEUE_MAX_ENTRY_PRICE,
  priceLimitProvenance: "T10 benchmark definition (= QUEUE_MAX_ENTRY_PRICE); research-independent ceiling NOT_PROVEN",
  rankingMetric: "ask_depth_relevant_usd of the full-stake TAKER walk at/below the benchmark limit",
  adaptiveHeadroom: "NOT_USED",
});
export type ResearchLiquidityContract = { id: string; stakeUsd: number; priceLimit: number };

/** Contract 6. Reported per token only. */
export const LIVE_QUEUE_VIEW = Object.freeze({ stakeUsd: QUEUE_DEFAULT_STAKE_USD, priceCap: QUEUE_MAX_ENTRY_PRICE, adaptiveHeadroom: "NOT_EVALUATED" });

export const UNRESOLVED_AUTHORITY = Object.freeze({
  research_price_limit_independent_of_live_queue: "NOT_PROVEN",
  law1_liquidity_minimum_above_full_stake: "NOT_PROVEN",
  max_quote_age_ms: "NOT_PROVEN",
  db_owned_decision_at: "NOT_AVAILABLE",
  model_decisions: "NOT_EVALUATED_IN_COHORT",
});

const MIN_MS = 60_000;

// ── 1. source reduction ───────────────────────────────────────────────────────────────────────────────────────────

export type SourceRow = {
  observation_id: string;
  item_observation_id: string;
  observed_at: string;
  ingested_at: string;
  condition_id: string;
  selected_token_id: string;
  selected_outcome: string | null;
  metric_formula_version: string | null;
  provider_event_id: string | null;
  provider_sport_family: string | null;
  market_type: string | null;
  game_start_iso: string | null;
  entry_price_num: number | string | null;
  pre_event_score_num: number | string | null;
};

export type Rejection = { reason: string; subject: string; /** Set for token-level rejections. */ tokenId?: string };
export type SourceCandidate = {
  conditionId: string; tokenId: string; outcome: string | null;
  providerEventId: string; eventStartIso: string; sportFamily: string; sourceMarketType: string | null;
  observationId: string; itemObservationId: string; observedAt: string; ingestedAt: string;
  entryPrice: number | null; score: number | null; sourceRowN: number;
  /** Every qualifying source row (item_observation_id, sorted) behind this condition/token; the winning row is itemObservationId. */
  sourceItemObservationIds: string[];
};

/**
 * Snapshot timing. `dbIngestWatermarkMs` is a DB-OWNED instant (max `ingested_at`, a `default now()` column) that bounds
 * the source snapshot; it is NOT a statement timestamp and NOT decision_at. `referenceMs` is the LOCAL clock at snapshot
 * read completion; it only bounds the daily universe and is never used as proof of causality.
 */
export type SnapshotTiming = { dbIngestWatermarkMs: number; referenceMs: number };

const str = (v: unknown): string | null => typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const iso = (ms: number) => new Date(ms).toISOString();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const t90CutoffMs = (eventStartIso: string) => Date.parse(eventStartIso) - T90_MINUTES * MIN_MS;

/**
 * Forward-causal source reduction. A source row is usable ONLY if the DB possessed it (`ingested_at`, never the upstream
 * `observed_at`) inside the snapshot (<= watermark) AND no later than event start - 90 min. A condition whose rows
 * disagree on provider event, start or sport is an identity collision and is rejected whole. Every distinct
 * (condition, token) pair is kept (newest qualifying row). Settlement/label columns are not part of SourceRow.
 */
export function reduceSourceRows(rows: readonly SourceRow[], timing: SnapshotTiming): { candidates: SourceCandidate[]; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  const byCondition = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const subject = str(row.condition_id) ?? "UNKNOWN_CONDITION";
    if (row.metric_formula_version !== APPROVED_SCORED_FORMULA) { rejected.push({ reason: "FORMULA_NOT_APPROVED", subject }); continue; }
    const eventId = str(row.provider_event_id); const start = str(row.game_start_iso);
    const token = str(row.selected_token_id); const cond = str(row.condition_id);
    const ingested = Date.parse(row.ingested_at ?? ""); const observed = Date.parse(row.observed_at ?? "");
    if (!eventId || !start || !token || !cond || !Number.isFinite(Date.parse(start))) { rejected.push({ reason: "SOURCE_IDENTITY_INCOMPLETE", subject }); continue; }
    if (!Number.isFinite(ingested) || !Number.isFinite(observed)) { rejected.push({ reason: "SOURCE_AVAILABILITY_TIMESTAMP_MISSING", subject }); continue; }
    const startMs = Date.parse(start);
    if (startMs - timing.referenceMs <= T90_MINUTES * MIN_MS) { rejected.push({ reason: "EVENT_NOT_AFTER_T90_AT_REFERENCE", subject }); continue; }
    if (startMs - timing.referenceMs > COHORT_HORIZON_HOURS * 3_600_000) { rejected.push({ reason: "EVENT_BEYOND_CYCLE_HORIZON", subject }); continue; }
    if (ingested > timing.dbIngestWatermarkMs) { rejected.push({ reason: "SOURCE_INGESTED_AFTER_SNAPSHOT_WATERMARK", subject }); continue; }
    if (ingested > startMs - T90_MINUTES * MIN_MS) { rejected.push({ reason: "SOURCE_AVAILABLE_AFTER_T90", subject }); continue; }
    if (observed > ingested) { rejected.push({ reason: "SOURCE_OBSERVED_AFTER_INGESTED", subject }); continue; }
    const list = byCondition.get(cond) ?? [];
    list.push(row); byCondition.set(cond, list);
  }
  const candidates: SourceCandidate[] = [];
  for (const [cond, list] of [...byCondition.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (new Set(list.map((r) => `${str(r.provider_event_id)}|${iso(Date.parse(str(r.game_start_iso)!))}`)).size > 1) {
      rejected.push({ reason: "CONDITION_PROVIDER_EVENT_CONTRADICTION", subject: cond }); continue;
    }
    if (new Set(list.map((r) => str(r.provider_sport_family)?.toLowerCase() ?? "")).size > 1) {
      rejected.push({ reason: "CONDITION_SPORT_FAMILY_CONTRADICTION", subject: cond }); continue;
    }
    const family = str(list[0].provider_sport_family)?.toLowerCase() ?? null;
    if (!family || !(TARGET_SPORT_FAMILIES as readonly string[]).includes(family)) { rejected.push({ reason: "SPORT_FAMILY_NOT_TARGET", subject: cond }); continue; }
    const byToken = new Map<string, SourceRow[]>();
    for (const r of list) { const t = str(r.selected_token_id)!; byToken.set(t, [...(byToken.get(t) ?? []), r]); }
    for (const [token, tokenRows] of [...byToken.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const newest = [...tokenRows].sort((a, b) => Date.parse(b.ingested_at) - Date.parse(a.ingested_at) || cmp(b.item_observation_id, a.item_observation_id))[0];
      candidates.push({
        conditionId: cond, tokenId: token, outcome: str(newest.selected_outcome),
        providerEventId: str(newest.provider_event_id)!, eventStartIso: iso(Date.parse(str(newest.game_start_iso)!)), sportFamily: family,
        sourceMarketType: str(newest.market_type), observationId: newest.observation_id, itemObservationId: newest.item_observation_id,
        observedAt: newest.observed_at, ingestedAt: newest.ingested_at,
        entryPrice: numOrNull(newest.entry_price_num), score: numOrNull(newest.pre_event_score_num), sourceRowN: tokenRows.length,
        sourceItemObservationIds: tokenRows.map((r) => r.item_observation_id).sort(cmp),
      });
    }
  }
  return { candidates, rejected };
}

// ── provider identity (condition level) ──────────────────────────────────────────────────────────────────────────

export type ProviderMarket = Awaited<ReturnType<typeof defaultExactEventReader>>[number];
/** One provider-confirmed outcome token. `source` is null for the token the scored source did not select. */
export type InventoryToken = {
  conditionId: string; tokenId: string; outcome: string; oppositeTokenId: string;
  physicalEventId: string; providerEventId: string; providerGameId: string | null; eventStartIso: string; sportFamily: string;
  providerMarketType: string; providerMarketFamily: string; providerMarketSlug: string | null;
  sourceSelected: boolean; source: SourceCandidate | null;
};

/**
 * Condition-level provider confirmation. The provider's own market for this condition must list exactly two distinct
 * outcome tokens with outcomes, EVERY source-selected token must be one of them, the market must be admitted for the
 * sport, and no source market type may contradict the provider's. Any failure rejects the WHOLE condition. On success
 * BOTH tokens enter the inventory (the source's one-sided selection is not evidence of which side is liquid).
 */
export function confirmProviderCondition(sourceTokens: readonly SourceCandidate[], markets: readonly ProviderMarket[]): InventoryToken[] | Rejection {
  const first = sourceTokens[0];
  const subject = first.conditionId;
  const own = markets.filter((m) => m.condition_id === first.conditionId);
  if (own.length !== 1) return { reason: own.length === 0 ? "CONDITION_NOT_IN_PROVIDER_EVENT" : "CONDITION_DUPLICATED_IN_PROVIDER_EVENT", subject };
  const market = own[0];
  const { tokens, missingIdentity } = inventoryTokens([market]);
  if (missingIdentity > 0 || tokens.length !== 2 || new Set(tokens.map((t) => t.tokenId)).size !== 2) return { reason: "PROVIDER_TOKEN_PAIR_NOT_BINARY", subject };
  if (sourceTokens.some((s) => !tokens.some((t) => t.tokenId === s.tokenId))) return { reason: "SOURCE_TOKEN_NOT_IN_PROVIDER_PAIR", subject };
  const admitted = admitResearchMarket(first.sportFamily, market.sports_market_type, market.provider_market_slug);
  if (!admitted.admitted) return { reason: "MARKET_TYPE_NOT_ADMITTED", subject };
  for (const s of sourceTokens) {
    if (s.sourceMarketType !== null && admitResearchMarket(s.sportFamily, s.sourceMarketType, market.provider_market_slug).type !== admitted.type) {
      return { reason: "SOURCE_PROVIDER_MARKET_TYPE_CONTRADICTION", subject };
    }
  }
  const gameId = market.provider_game_id ?? null;
  const physicalEventId = physicalMatchId({ eventId: first.providerEventId, eventStartIso: first.eventStartIso, gameId });
  return [...tokens].sort((a, b) => cmp(a.tokenId, b.tokenId)).map((t) => {
    const source = sourceTokens.find((s) => s.tokenId === t.tokenId) ?? null;
    return {
      conditionId: first.conditionId, tokenId: t.tokenId, outcome: t.outcome as string, oppositeTokenId: tokens.find((o) => o.tokenId !== t.tokenId)!.tokenId,
      physicalEventId, providerEventId: first.providerEventId, providerGameId: gameId, eventStartIso: first.eventStartIso, sportFamily: first.sportFamily,
      providerMarketType: admitted.type, providerMarketFamily: admitted.family, providerMarketSlug: market.provider_market_slug ?? null,
      sourceSelected: source !== null, source,
    };
  });
}

// ── 2. research liquidity measurement (one common contract) ──────────────────────────────────────────────────────

export type ResearchLiquidityState =
  | "EXECUTABLE"
  | "BLOCKED_DEPTH_AT_LIMIT"
  | "BLOCKED_VENUE_MIN_ORDER"
  | "UNKNOWN_BOOK_MISSING"
  | "UNKNOWN_MIN_ORDER_SIZE"
  | "UNKNOWN_QUOTE_TIMESTAMP"
  | "QUOTE_BEFORE_SOURCE_SNAPSHOT"
  | "QUOTE_AFTER_T90"
  | "UNAUTHORIZED_CONTRACT";

export type ResearchLiquidity = {
  contractId: string; stakeUsd: number; priceLimit: number;
  state: ResearchLiquidityState;
  /** true only for EXECUTABLE. UNKNOWN_* and timing failures are never executable. */
  executable: boolean;
  /** Ranking value: the measured depth, ONLY when executable. */
  rankingDepthUsd: number | null;
  measuredAskDepthUsd: number | null; vwap: number | null; shares: number | null; worstAskPrice: number | null;
  bestAsk: number | null; venueMinOrderShares: number | null;
  quoteStartedAtLocalMs: number | null; quoteCompletedAtLocalMs: number | null; providerBookTimestampMs: number | null;
  /** Measured only; no approved maximum exists (UNRESOLVED_AUTHORITY.max_quote_age_ms). */
  quoteAgeAtCompletionMs: number | null;
  t90CutoffMs: number;
};

const sameContract = (c: ResearchLiquidityContract) =>
  c.id === RESEARCH_LIQUIDITY_CONTRACT.id && c.stakeUsd === RESEARCH_LIQUIDITY_CONTRACT.stakeUsd && c.priceLimit === RESEARCH_LIQUIDITY_CONTRACT.priceLimit;

/**
 * Pure. Measures ONE exact token book under the research contract and the token's own T-90 cutoff. Any stake or limit
 * other than the registered benchmark is UNAUTHORIZED_CONTRACT (no stake adjustment, no model ceiling). A quote is
 * causal only if it completed after the source snapshot was read and both the local completion and the provider book
 * timestamp are at/before the cutoff; a missing timestamp fails closed.
 */
export function measureResearchLiquidity(
  token: Pick<InventoryToken, "conditionId" | "tokenId" | "outcome" | "eventStartIso">,
  result: FetchOrderBookResult | null | undefined,
  snapshotReadCompletedLocalMs: number,
  contract: ResearchLiquidityContract = RESEARCH_LIQUIDITY_CONTRACT,
): ResearchLiquidity {
  const cutoff = t90CutoffMs(token.eventStartIso);
  const book = result?.ok && result.book && result.book.tokenId === token.tokenId ? result.book : null;
  const started = book ? result?.requestStartedAtMs ?? null : null;
  const completed = book ? result?.responseCompletedAtMs ?? null : null;
  const providerTs = book?.providerTimestampMs ?? null;
  const base = {
    contractId: contract.id, stakeUsd: contract.stakeUsd, priceLimit: contract.priceLimit,
    rankingDepthUsd: null, measuredAskDepthUsd: null, vwap: null, shares: null, worstAskPrice: null,
    bestAsk: book?.asks.length ? Math.min(...book.asks.map((l) => l.price)) : null, venueMinOrderShares: book?.minimumOrderSize ?? null,
    quoteStartedAtLocalMs: started, quoteCompletedAtLocalMs: completed, providerBookTimestampMs: providerTs,
    quoteAgeAtCompletionMs: completed !== null && providerTs !== null ? completed - providerTs : null, t90CutoffMs: cutoff,
  };
  const fail = (state: ResearchLiquidityState): ResearchLiquidity => ({ ...base, state, executable: false });
  if (!sameContract(contract)) return fail("UNAUTHORIZED_CONTRACT");
  if (!book) return fail("UNKNOWN_BOOK_MISSING");
  if (completed === null || providerTs === null) return fail("UNKNOWN_QUOTE_TIMESTAMP");
  if (completed < snapshotReadCompletedLocalMs) return fail("QUOTE_BEFORE_SOURCE_SNAPSHOT");
  if (completed > cutoff || providerTs > cutoff) return fail("QUOTE_AFTER_T90");
  // Exactly the T10 benchmark: NO stake/cap override is passed.
  const cols = buildExecutableSiblingColumns({ token: { conditionId: token.conditionId, tokenId: token.tokenId, side: token.outcome ?? "" }, result, fee: null });
  const measured = {
    ...base,
    measuredAskDepthUsd: (cols.ask_depth_relevant_usd as number | null) ?? null, vwap: (cols.full_stake_executable_vwap as number | null) ?? null,
    shares: (cols.full_stake_shares as number | null) ?? null, worstAskPrice: (cols.full_stake_worst_ask_price as number | null) ?? null,
  };
  const t10 = String(cols.executable_full_stake_state);
  const state: ResearchLiquidityState = t10 === "EXECUTABLE" ? "EXECUTABLE"
    : t10 === "NOT_EXECUTABLE_DEPTH_AT_CAP" ? "BLOCKED_DEPTH_AT_LIMIT"
    : t10 === "NOT_EXECUTABLE_MIN_ORDER_SIZE" ? "BLOCKED_VENUE_MIN_ORDER"
    : t10 === "UNKNOWN_MIN_ORDER_SIZE" ? "UNKNOWN_MIN_ORDER_SIZE" : "UNKNOWN_BOOK_MISSING";
  const executable = state === "EXECUTABLE" && cols.executable_full_stake === true && measured.measuredAskDepthUsd !== null;
  return { ...measured, state: executable ? "EXECUTABLE" : state === "EXECUTABLE" ? "UNKNOWN_BOOK_MISSING" : state, executable, rankingDepthUsd: executable ? measured.measuredAskDepthUsd : null };
}

/** Contract 6, pure: the same book under the Queue's own constants. Reported only; selection never reads it. */
export function liveQueueView(token: Pick<InventoryToken, "conditionId" | "tokenId" | "outcome">, result: FetchOrderBookResult | null | undefined) {
  const cols = buildExecutableSiblingColumns({
    token: { conditionId: token.conditionId, tokenId: token.tokenId, side: token.outcome ?? "" }, result, fee: null,
    stakeUsd: LIVE_QUEUE_VIEW.stakeUsd, hardCap: LIVE_QUEUE_VIEW.priceCap,
  });
  return { state: String(cols.executable_full_stake_state), executable: (cols.executable_full_stake as boolean | null) ?? null, adaptiveHeadroom: LIVE_QUEUE_VIEW.adaptiveHeadroom };
}

export type MeasuredToken = InventoryToken & { research: ResearchLiquidity; liveQueue: ReturnType<typeof liveQueueView> };

// ── 3. physical-event eligibility, ranking, allocation ──────────────────────────────────────────────────────────

export type CohortBucket = "SOCCER" | "TENNIS" | "OTHER_DIVERSITY_FLOOR" | "OTHER_LIQUIDITY_FILL";
export type PhysicalEvent = {
  physicalEventId: string; sportFamily: string; eventStartIso: string; t90CutoffIso: string;
  providerEventIds: string[]; providerGameIds: string[];
  /** One research ranking anchor per event: the deepest research-EXECUTABLE token. A sampling key, NOT a betting side. */
  anchor: { conditionId: string; tokenId: string; rankingDepthUsd: number };
  /** Complete scored inventory of the event (both tokens of every confirmed condition), sorted, with per-token state. */
  inventory: MeasuredToken[];
  sportRank: number;
};
export type CohortSelection = PhysicalEvent & { bucket: CohortBucket };
export type Cohort = {
  version: string; contract: typeof RESEARCH_LIQUIDITY_CONTRACT;
  selected: CohortSelection[];
  /** Eligible but outside the quota, per sport, in rank order (cutoff evidence). */
  excludedByQuota: Array<{ physicalEventId: string; sportFamily: string; sportRank: number; rankingDepthUsd: number }>;
  rejected: Rejection[];
  diagnostics: Record<string, unknown>;
};

/** Rank depth DESC, then start ASC, then physical id: total order, no randomness. */
export function compareEvents(a: Pick<PhysicalEvent, "anchor" | "eventStartIso" | "physicalEventId">, b: Pick<PhysicalEvent, "anchor" | "eventStartIso" | "physicalEventId">): number {
  return b.anchor.rankingDepthUsd - a.anchor.rankingDepthUsd || Date.parse(a.eventStartIso) - Date.parse(b.eventStartIso) || cmp(a.physicalEventId, b.physicalEventId);
}
const tokenOrder = (a: MeasuredToken, b: MeasuredToken) => cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId);

/**
 * Pure, deterministic and MODEL-INDEPENDENT (it has no model input). An event is eligible iff its identity is coherent
 * and at least one inventory token is research-EXECUTABLE; its rank key is the deepest such token (anchor). Per-sport
 * ranking, 50/25/25, other = per-family floor then liquidity fill inside "other" only, no cross-quota backfill.
 */
export function selectPhysicalEventCohort(measured: readonly MeasuredToken[]): Cohort {
  const rejected: Rejection[] = [];
  const byPhysical = new Map<string, MeasuredToken[]>();
  for (const t of measured) byPhysical.set(t.physicalEventId, [...(byPhysical.get(t.physicalEventId) ?? []), t]);
  const eligible: Omit<PhysicalEvent, "sportRank">[] = [];
  const eventStates: Record<string, number> = {};
  for (const [pid, raw] of [...byPhysical.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const tokens = [...raw].sort(tokenOrder);
    const keys = new Set(tokens.map((t) => `${t.conditionId}|${t.tokenId}`));
    let reason: string | null = null;
    if (keys.size !== tokens.length) reason = "PHYSICAL_EVENT_DUPLICATE_TOKEN";
    else if (new Set(tokens.map((t) => t.sportFamily)).size > 1) reason = "PHYSICAL_EVENT_SPORT_CONTRADICTION";
    else if (new Set(tokens.map((t) => t.eventStartIso)).size > 1) reason = "PHYSICAL_EVENT_START_CONTRADICTION";
    const executable = tokens.filter((t) => t.research.executable && t.research.rankingDepthUsd !== null);
    if (!reason && executable.length === 0) {
      const states = [...new Set(tokens.map((t) => t.research.state))].sort(cmp);
      reason = `NO_RESEARCH_EXECUTABLE_TOKEN:${states.join("+")}`;
    }
    if (reason) { rejected.push({ reason, subject: pid }); eventStates[reason.split(":")[0]] = (eventStates[reason.split(":")[0]] ?? 0) + 1; continue; }
    const anchor = [...executable].sort((a, b) => (b.research.rankingDepthUsd as number) - (a.research.rankingDepthUsd as number) || tokenOrder(a, b))[0];
    eventStates.ELIGIBLE = (eventStates.ELIGIBLE ?? 0) + 1;
    eligible.push({
      physicalEventId: pid, sportFamily: tokens[0].sportFamily, eventStartIso: tokens[0].eventStartIso, t90CutoffIso: iso(t90CutoffMs(tokens[0].eventStartIso)),
      providerEventIds: [...new Set(tokens.map((t) => t.providerEventId))].sort(cmp),
      providerGameIds: [...new Set(tokens.map((t) => t.providerGameId).filter((g): g is string => g !== null))].sort(cmp),
      anchor: { conditionId: anchor.conditionId, tokenId: anchor.tokenId, rankingDepthUsd: anchor.research.rankingDepthUsd as number },
      inventory: tokens,
    });
  }
  const rankedFamily = (family: string): PhysicalEvent[] =>
    eligible.filter((e) => e.sportFamily === family).sort(compareEvents).map((e, i) => ({ ...e, sportRank: i + 1 }));
  const selected: CohortSelection[] = [];
  const taken = new Set<string>();
  const take = (e: PhysicalEvent, bucket: CohortBucket) => { taken.add(e.physicalEventId); selected.push({ ...e, bucket }); };
  const soccer = rankedFamily("soccer"); const tennis = rankedFamily("tennis");
  soccer.slice(0, SOCCER_QUOTA_T90).forEach((e) => take(e, "SOCCER"));
  tennis.slice(0, TENNIS_QUOTA_T90).forEach((e) => take(e, "TENNIS"));
  const otherByFamily = new Map(OTHER_SPORT_FAMILIES.map((f) => [f, rankedFamily(f)] as const));
  let otherN = 0;
  for (const family of OTHER_SPORT_FAMILIES) {
    for (const e of otherByFamily.get(family)!.slice(0, OTHER_DIVERSITY_FLOOR_PER_SPORT)) {
      if (otherN >= OTHER_QUOTA_T90) break;
      take(e, "OTHER_DIVERSITY_FLOOR"); otherN++;
    }
  }
  const otherPool = [...otherByFamily.values()].flat().sort(compareEvents);
  for (const e of otherPool) {
    if (otherN >= OTHER_QUOTA_T90) break;
    if (taken.has(e.physicalEventId)) continue;
    take(e, "OTHER_LIQUIDITY_FILL"); otherN++;
  }
  const final = selected.slice(0, MAX_RESEARCH_EVENTS_PER_DAY);
  const allRanked = [...soccer, ...tennis, ...otherPool];
  const excludedByQuota = allRanked.filter((e) => !taken.has(e.physicalEventId))
    .map((e) => ({ physicalEventId: e.physicalEventId, sportFamily: e.sportFamily, sportRank: e.sportRank, rankingDepthUsd: e.anchor.rankingDepthUsd }));

  const bySport = (list: readonly { sportFamily: string }[]) => {
    const out: Record<string, number> = {};
    for (const e of list) out[e.sportFamily] = (out[e.sportFamily] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => cmp(a[0], b[0])));
  };
  const n = (f: (s: CohortSelection) => boolean) => final.filter(f).length;
  const soccerN = n((s) => s.bucket === "SOCCER"); const tennisN = n((s) => s.bucket === "TENNIS"); const otherSelN = n((s) => s.bucket.startsWith("OTHER"));
  const cutoff = (inBucket: (s: CohortSelection) => boolean, families: readonly string[]) => {
    const sel = final.filter(inBucket);
    const firstOut = excludedByQuota.find((e) => families.includes(e.sportFamily)) ?? null;
    return {
      last_selected_depth_usd: sel.length ? Math.min(...sel.map((s) => s.anchor.rankingDepthUsd)) : null,
      first_excluded_depth_usd: firstOut?.rankingDepthUsd ?? null,
      semantics: "eligible = >=1 research-EXECUTABLE token; rank = anchor depth DESC, start ASC, physical id ASC; no liquidity minimum (NOT_PROVEN)",
    };
  };
  const tokenStates: Record<string, number> = {};
  for (const t of measured) tokenStates[t.research.state] = (tokenStates[t.research.state] ?? 0) + 1;
  const otherFamilyUnderfill = Object.fromEntries(OTHER_SPORT_FAMILIES.map((f) => [f, {
    eligible: otherByFamily.get(f)!.length, selected: final.filter((s) => s.sportFamily === f).length,
    floor_underfill: Math.max(0, OTHER_DIVERSITY_FLOOR_PER_SPORT - final.filter((s) => s.sportFamily === f).length),
  }]));
  return {
    version: COHORT_VERSION, contract: RESEARCH_LIQUIDITY_CONTRACT, selected: final, excludedByQuota, rejected,
    diagnostics: {
      measured_token_n: measured.length, token_research_states: Object.fromEntries(Object.entries(tokenStates).sort((a, b) => cmp(a[0], b[0]))),
      physical_event_n: byPhysical.size, event_states: Object.fromEntries(Object.entries(eventStates).sort((a, b) => cmp(a[0], b[0]))),
      eligible_physical_event_n: eligible.length, eligible_by_sport: bySport(eligible), selected_by_sport: bySport(final),
      soccer_selected_n: soccerN, tennis_selected_n: tennisN, other_selected_n: otherSelN,
      soccer_quota_underfill_n: SOCCER_QUOTA_T90 - soccerN, tennis_quota_underfill_n: TENNIS_QUOTA_T90 - tennisN, other_quota_underfill_n: OTHER_QUOTA_T90 - otherSelN,
      other_family: otherFamilyUnderfill, global_backfill_n: 0,
      cutoff: {
        soccer: cutoff((s) => s.bucket === "SOCCER", ["soccer"]), tennis: cutoff((s) => s.bucket === "TENNIS", ["tennis"]),
        other: cutoff((s) => s.bucket.startsWith("OTHER"), OTHER_SPORT_FAMILIES),
      },
    },
  };
}

// ── canonical digest ─────────────────────────────────────────────────────────────────────────────────────────────

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const sha256 = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

/** Deterministic business fields only (no local timestamps, no raw payloads). */
export function cohortBusinessFields(cohort: Pick<Cohort, "version" | "contract" | "selected" | "excludedByQuota">) {
  return {
    version: cohort.version, contract: { id: cohort.contract.id, stake_usd: cohort.contract.stakeUsd, price_limit: cohort.contract.priceLimit },
    selected: cohort.selected.map((s) => ({
      bucket: s.bucket, sport: s.sportFamily, sport_rank: s.sportRank, physical_event_id: s.physicalEventId,
      provider_event_ids: s.providerEventIds, provider_game_ids: s.providerGameIds, event_start_at: s.eventStartIso, t90_cutoff_at: s.t90CutoffIso,
      anchor: { condition_id: s.anchor.conditionId, token_id: s.anchor.tokenId, ranking_depth_usd: s.anchor.rankingDepthUsd },
      inventory: s.inventory.map((t) => ({ condition_id: t.conditionId, token_id: t.tokenId, research_state: t.research.state, ranking_depth_usd: t.research.rankingDepthUsd })),
    })),
    excluded_by_quota: cohort.excludedByQuota,
  };
}
export const cohortDigest = (cohort: Pick<Cohort, "version" | "contract" | "selected" | "excludedByQuota">) => sha256(cohortBusinessFields(cohort));

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
}

// ── 4. frozen model decisions: strictly AFTER the cohort is frozen ───────────────────────────────────────────────

/** Source + provider facts only: no book, no rank, no settlement. */
export type ModelTokenView = {
  conditionId: string; tokenId: string; outcome: string; oppositeTokenId: string; providerMarketType: string;
  sourceSelected: boolean; score: number | null; entryPrice: number | null; ingestedAt: string | null;
};
export type ModelEventView = { physicalEventId: string; sportFamily: string; eventStartIso: string; tokens: readonly ModelTokenView[] };
export type ModelEligibility = { strategyId: string; strategyVersion: string; decision: "BET" | "SKIP"; tokenId: string | null };
export type ModelAuthority = (event: Readonly<ModelEventView>) => readonly ModelEligibility[];
export type ModelDecisionRecord = ModelEligibility & { physicalEventId: string; status: "RECORDED" | "MODEL_TOKEN_NOT_IN_INVENTORY" };

/**
 * Consumes a FROZEN cohort and returns per-model decisions next to it. The cohort is deep-frozen first, so an authority
 * cannot mutate it; the selector never receives this output. A model may choose any inventory token of the event,
 * including one other than the research anchor. No execution economics are computed here (Mission B).
 */
export function attachModelDecisions(cohort: Cohort, authority: ModelAuthority | undefined): ModelDecisionRecord[] {
  deepFreeze(cohort);
  if (!authority) return [];
  const out: ModelDecisionRecord[] = [];
  for (const s of cohort.selected) {
    const view: ModelEventView = deepFreeze({
      physicalEventId: s.physicalEventId, sportFamily: s.sportFamily, eventStartIso: s.eventStartIso,
      tokens: s.inventory.map((t) => ({
        conditionId: t.conditionId, tokenId: t.tokenId, outcome: t.outcome, oppositeTokenId: t.oppositeTokenId, providerMarketType: t.providerMarketType,
        sourceSelected: t.sourceSelected, score: t.source?.score ?? null, entryPrice: t.source?.entryPrice ?? null, ingestedAt: t.source?.ingestedAt ?? null,
      })),
    });
    for (const d of authority(view)) {
      const inInventory = d.tokenId === null || s.inventory.some((t) => t.tokenId === d.tokenId);
      out.push({ ...d, physicalEventId: s.physicalEventId, status: d.decision === "BET" && !inInventory ? "MODEL_TOKEN_NOT_IN_INVENTORY" : "RECORDED" });
    }
  }
  return out.sort((a, b) => cmp(a.physicalEventId, b.physicalEventId) || cmp(a.strategyId, b.strategyId) || cmp(a.strategyVersion, b.strategyVersion));
}

export function countReasons(rejections: readonly Rejection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejections) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => cmp(a[0], b[0])));
}

// ── orchestration (all I/O injected; read-only) ──────────────────────────────────────────────────────────────────

export type SourceSnapshot = {
  rows: SourceRow[];
  timing: SnapshotTiming & {
    /** HTTP Date header of the API gateway: a PROXY, never decision_at. */
    httpDateProxyMs: number | null;
    snapshotReadCompletedLocalMs: number;
  };
};
export type CohortDeps = {
  readSource: () => Promise<SourceSnapshot>;
  readProviderEvent?: typeof defaultExactEventReader;
  fetchBooks?: typeof fetchOrderBooksConcurrent;
  fetchFee?: (tokenId: string) => Promise<TokenFeeScheduleResult>;
  concurrency?: number;
};

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export async function buildExecutableLiquidityCohort(deps: CohortDeps) {
  const readProviderEvent = deps.readProviderEvent ?? defaultExactEventReader;
  const fetchBooks = deps.fetchBooks ?? fetchOrderBooksConcurrent;
  const fetchFee = deps.fetchFee ?? ((tokenId: string) => fetchTokenFeeSchedule(tokenId, { timeoutMs: 5000 }));
  const limit = deps.concurrency ?? 6;
  const snapshot = await deps.readSource();
  const reduced = reduceSourceRows(snapshot.rows, snapshot.timing);
  const rejected: Rejection[] = [...reduced.rejected];

  const conditions = new Map<string, SourceCandidate[]>();
  for (const c of reduced.candidates) conditions.set(c.conditionId, [...(conditions.get(c.conditionId) ?? []), c]);
  const events = new Map<string, SourceCandidate[][]>();
  for (const list of [...conditions.values()]) {
    const key = `${list[0].providerEventId}|${list[0].eventStartIso}`;
    events.set(key, [...(events.get(key) ?? []), list]);
  }
  const inventory: InventoryToken[] = [];
  await mapLimit([...events.entries()].sort((a, b) => cmp(a[0], b[0])), limit, async ([, conds]) => {
    let markets: ProviderMarket[];
    try { markets = await readProviderEvent(conds[0][0].providerEventId, conds[0][0].eventStartIso); }
    catch (error) {
      const code = error instanceof Error && error.message === "RESERVED_EVENT_START_MISMATCH" ? error.message : "UNAVAILABLE";
      for (const list of conds) rejected.push({ reason: `PROVIDER_EVENT:${code}`, subject: list[0].conditionId });
      return;
    }
    for (const list of conds) {
      const result = confirmProviderCondition(list, markets);
      if ("reason" in result) rejected.push(result); else inventory.push(...result);
    }
  });
  inventory.sort((a, b) => cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId));

  const books = await fetchBooks(inventory.map((t) => t.tokenId), limit);
  const measured: MeasuredToken[] = inventory.map((t, i) => ({
    ...t, research: measureResearchLiquidity(t, books[i], snapshot.timing.snapshotReadCompletedLocalMs), liveQueue: liveQueueView(t, books[i]),
  }));
  const cohort = selectPhysicalEventCohort(measured);
  rejected.push(...cohort.rejected);
  const fees = await mapLimit(cohort.selected, limit, async (s) => fetchFee(s.anchor.tokenId));
  return {
    timing: snapshot.timing,
    funnel: {
      source_rows: snapshot.rows.length, source_tokens_after_causal_reduction: reduced.candidates.length, source_conditions: conditions.size,
      provider_events: events.size, provider_confirmed_conditions: new Set(inventory.map((t) => t.conditionId)).size,
      inventory_tokens: inventory.length, inventory_tokens_not_source_selected: inventory.filter((t) => !t.sourceSelected).length,
      research_executable_tokens: measured.filter((t) => t.research.executable).length,
      physical_events: cohort.diagnostics.physical_event_n, eligible_physical_events: cohort.diagnostics.eligible_physical_event_n, selected_physical_events: cohort.selected.length,
    },
    cohort, fees, rejected,
  };
}

// ── receipt (pure; the runner writes exactly this) ───────────────────────────────────────────────────────────────

export const FIRST_BROKEN_TIMING_EDGE =
  "DB_OWNED_DECISION_AT: the Research DBClone exposes no read-only DB clock via PostgREST (no migration allowed); quote causality "
  + "is proven against the LOCAL fetch-completion clock and the provider book timestamp, and the DB->local clock edge is bounded "
  + "only by the HTTP Date proxy skew guard";

type CohortRun = Awaited<ReturnType<typeof buildExecutableLiquidityCohort>>;
const isoOrNull = (ms: number | null | undefined) => typeof ms === "number" && Number.isFinite(ms) ? iso(ms) : null;

export function buildCohortReceipt(run: CohortRun, generatedLocalMs: number, guards: Record<string, unknown> = {}) {
  const { cohort, timing } = run;
  const quotaMet = cohort.diagnostics.soccer_quota_underfill_n === 0 && cohort.diagnostics.tennis_quota_underfill_n === 0 && cohort.diagnostics.other_quota_underfill_n === 0;
  const selected = cohort.selected.map((s, i) => {
    const fee = run.fees[i];
    return {
      bucket: s.bucket, sport: s.sportFamily, sport_rank: s.sportRank, physical_event_id: s.physicalEventId,
      provider_event_ids: s.providerEventIds, provider_game_ids: s.providerGameIds, event_start_at: s.eventStartIso, t90_cutoff_at: s.t90CutoffIso,
      eligibility: "ELIGIBLE_RESEARCH_EXECUTABLE",
      anchor: { condition_id: s.anchor.conditionId, token_id: s.anchor.tokenId, ranking_depth_usd: s.anchor.rankingDepthUsd, is_betting_side: false },
      anchor_taker_fee: fee?.ok ? { state: "KNOWN", rate: fee.takerRate, formula: fee.formulaVersion } : { state: "UNKNOWN", reason: fee && !fee.ok ? fee.errorCode : "NOT_FETCHED" },
      inventory: s.inventory.map((t) => ({
        condition_id: t.conditionId, token_id: t.tokenId, outcome: t.outcome, opposite_token_id: t.oppositeTokenId,
        market_type: t.providerMarketType, market_family: t.providerMarketFamily, provider_event_id: t.providerEventId,
        source: t.source ? {
          selected_by_source: true, formula: APPROVED_SCORED_FORMULA, score: t.source.score, entry_price: t.source.entryPrice,
          observation_id: t.source.observationId, item_observation_id: t.source.itemObservationId, source_row_n: t.source.sourceRowN,
          observed_at_source: t.source.observedAt, ingested_at_db: t.source.ingestedAt,
        } : { selected_by_source: false },
        research: {
          contract: t.research.contractId, stake_usd: t.research.stakeUsd, price_limit: t.research.priceLimit,
          state: t.research.state, executable: t.research.executable, ranking_depth_usd: t.research.rankingDepthUsd,
          measured_ask_depth_usd: t.research.measuredAskDepthUsd, vwap: t.research.vwap, shares: t.research.shares,
          best_ask: t.research.bestAsk, venue_min_order_shares: t.research.venueMinOrderShares,
          provider_book_timestamp: isoOrNull(t.research.providerBookTimestampMs),
          quote_started_at_local: isoOrNull(t.research.quoteStartedAtLocalMs), quote_completed_at_local: isoOrNull(t.research.quoteCompletedAtLocalMs),
          quote_age_ms_measured: t.research.quoteAgeAtCompletionMs,
        },
        live_queue_view: t.liveQueue,
        model_specific_execution: "NOT_EVALUATED_IN_COHORT",
      })),
    };
  });
  return {
    version: COHORT_VERSION, research_only: true, is_virtual_bet: false, is_db_persistence: false,
    status: quotaMet ? "PARTIAL_NOT_PROVEN_AUTHORITY" : "PARTIAL_NOT_PROVEN_AUTHORITY_AND_UNDERFILLED",
    unresolved_authority: UNRESOLVED_AUTHORITY,
    authority: {
      quotas: { soccer: SOCCER_QUOTA_T90, tennis: TENNIS_QUOTA_T90, other: OTHER_QUOTA_T90 }, max_events: MAX_RESEARCH_EVENTS_PER_DAY,
      other_families: OTHER_SPORT_FAMILIES, other_floor_per_family: OTHER_DIVERSITY_FLOOR_PER_SPORT,
      horizon_hours: COHORT_HORIZON_HOURS, t90_minutes: T90_MINUTES, formula: APPROVED_SCORED_FORMULA,
      research_liquidity_contract: RESEARCH_LIQUIDITY_CONTRACT, live_queue_view: LIVE_QUEUE_VIEW,
    },
    timing: {
      db_source_ingest_watermark: isoOrNull(timing.dbIngestWatermarkMs), db_source_ingest_watermark_kind: "DB_OWNED_COLUMN_MAX_INGESTED_AT_SNAPSHOT_BOUND_NOT_DECISION_AT",
      http_date_proxy: isoOrNull(timing.httpDateProxyMs), http_date_proxy_kind: "API_GATEWAY_HTTP_DATE_PROXY_NOT_DECISION_AT",
      local_reference_at: isoOrNull(timing.referenceMs), local_snapshot_read_completed_at: isoOrNull(timing.snapshotReadCompletedLocalMs),
      db_decision_at: null, first_broken_timing_edge: FIRST_BROKEN_TIMING_EDGE, guards,
    },
    generated_local: iso(generatedLocalMs),
    funnel: run.funnel, diagnostics: cohort.diagnostics, rejection_reasons: countReasons(run.rejected),
    cohort_digest: cohortDigest(cohort), cohort_digest_basis: "sha256(canonicalJson(cohortBusinessFields(cohort)))",
    selected, excluded_by_quota: cohort.excludedByQuota,
  };
}
