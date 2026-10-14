// EXECUTABLE_LIQUIDITY_COHORT_T90_V1
//
// RESEARCH-ONLY prospective cohort selector (Founder Law #1, Issue #532, 2026-10-14). It is NOT a virtual BET, a Ledger
// row or a model decision: it only answers "which physical events, with which candidate market/side, would be sampled
// for a T-90 decision, ranked by independently measured executable liquidity within each sport".
//
// It does NOT replace or modify the legacy 40/20/40 T20 sampler (lib/executor/precontractT20Research.ts), which ranks by
// historical 24h parent volume. Nothing here writes to any database; all reads are injected.
//
// Resolved from existing repository authority (never invented):
//   quotas                50 / 25 / 25                Founder Law #1 (Issue #532)
//   "other" subdivision   OTHER_SPORT_FAMILIES, per-sport floor OTHER_DIVERSITY_FLOOR_PER_SPORT, then liquidity fill
//                         inside the other pool only (precontractT20Research.ts, PRECONTRACT_RESEARCH_TELEMETRY_GUIDE_V1.md #6)
//   cadence               daily cycle, 100 events/day   (guide #3, MAX_RESEARCH_EVENTS_PER_DAY)
//   stake / LIVE cap      QUEUE_DEFAULT_STAKE_USD 2.50 / QUEUE_MAX_ENTRY_PRICE 0.555 (executorQueueTypes.ts) = the LIVE QUEUE view only
//   executable metric     buildExecutableSiblingColumns(): full-stake taker walk, ask USD depth at/below a ceiling
//   executable minimum    executable_full_stake_state === "EXECUTABLE" (full stake fills and satisfies min order size)
// NOT_PROVEN (reported, never gated on an invented value): a liquidity minimum above full-stake executability and a
// maximum quote age.
//
// Four separate decisions (never one):
//   1. candidate inventory     every causal (condition, token) pair, both opposing tokens, kept until after book evaluation
//   2. research liquidity      book.* = LIVE Queue view (cap 0.555, unchanged); `rank` = the evidence that qualified the token
//   3. model eligibility       OWNED BY THE MODEL: an injected ModelAuthority returns BET/SKIP, the exact token and the
//                              model's OWN entry-price ceiling. This module never evaluates a frozen predicate and never
//                              derives a universal ceiling (e.g. max(strategy price_max, 0.555)) from several models.
//   4. LIVE Queue eligibility  book.executable at 0.555, reported per model token, never used to discard a model-chosen token
// The cohort ranking anchor (best-depth token of the physical event) is a research sampling key, NOT the betting side.
import { createHash } from "node:crypto";
import { fetchOrderBooksConcurrent, fetchTokenFeeSchedule, type TokenFeeScheduleResult } from "../liquidity/polymarketClient";
import type { FetchOrderBookResult } from "../liquidity/types";
import { physicalMatchId } from "../executor/contractADecisions";
import { buildExecutableSiblingColumns } from "../executor/t10ExecutableSiblingTelemetry";
import { QUEUE_DEFAULT_STAKE_USD, QUEUE_MAX_ENTRY_PRICE } from "../executor/executorQueueTypes";
import { defaultExactEventReader, inventoryTokens } from "../executor/reservationMarketBaseline";
import {
  admitResearchMarket, MAX_RESEARCH_EVENTS_PER_DAY, OTHER_DIVERSITY_FLOOR_PER_SPORT, OTHER_SPORT_FAMILIES, TARGET_SPORT_FAMILIES,
} from "../executor/precontractT20Research";

export const COHORT_VERSION = "EXECUTABLE_LIQUIDITY_COHORT_T90_V1";
export const APPROVED_SCORED_FORMULA = "v2-lite-growth-safe";
export const SOCCER_QUOTA_T90 = 50;
export const TENNIS_QUOTA_T90 = 25;
export const OTHER_QUOTA_T90 = 25;
export const T90_MINUTES = 90;
/** Daily research cycle: events whose start falls in (asOf + T-90, asOf + 24h]. */
export const COHORT_HORIZON_HOURS = 24;
export const COHORT_STAKE_USD = QUEUE_DEFAULT_STAKE_USD;
export const COHORT_PRICE_CAP = QUEUE_MAX_ENTRY_PRICE;
export const NOT_PROVEN = { liquidity_minimum_above_full_stake: "NOT_PROVEN", max_quote_age_ms: "NOT_PROVEN" } as const;

const MIN_MS = 60_000;

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

export type Rejection = { reason: string; subject: string; /** Set for candidate-level (condition + token) rejections. */ tokenId?: string };
export type SourceCandidate = {
  conditionId: string; tokenId: string; outcome: string | null;
  providerEventId: string; eventStartIso: string; sportFamily: string; sourceMarketType: string | null;
  observationId: string; itemObservationId: string; observedAt: string; ingestedAt: string;
  entryPrice: number | null; score: number | null; sourceRowN: number;
  /** Every qualifying source row (item_observation_id, sorted) behind this condition/token candidate; the winning row is itemObservationId. */
  sourceItemObservationIds: string[];
};

const str = (v: unknown): string | null => typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const iso = (ms: number) => new Date(ms).toISOString();
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Forward-causal source reduction. A source row is usable ONLY if the DB possessed it (`ingested_at`, never the
 * upstream `observed_at`) no later than the DB as-of AND no later than event start - 90 min. A condition whose
 * qualifying rows disagree on provider event or start is an identity collision and is rejected whole. Otherwise EVERY
 * distinct (condition, token) pair is preserved as its own candidate (newest qualifying row per pair): the two opposing
 * tokens of one condition must both reach the independent CLOB depth measurement, because the source's one-sided
 * `selected_token_id` is not evidence of which side is the most liquid. Choosing one candidate per physical event
 * happens only after that measurement (selectExecutableLiquidityCohort). Settlement/label columns are not part of
 * SourceRow and are never read.
 */
export function reduceSourceRows(rows: readonly SourceRow[], asOfMs: number): { candidates: SourceCandidate[]; rejected: Rejection[] } {
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
    if (startMs - asOfMs <= T90_MINUTES * MIN_MS) { rejected.push({ reason: "EVENT_NOT_AFTER_T90_AT_ASOF", subject }); continue; }
    if (startMs - asOfMs > COHORT_HORIZON_HOURS * 3_600_000) { rejected.push({ reason: "EVENT_BEYOND_CYCLE_HORIZON", subject }); continue; }
    if (ingested > asOfMs) { rejected.push({ reason: "SOURCE_INGESTED_AFTER_ASOF", subject }); continue; }
    if (ingested > startMs - T90_MINUTES * MIN_MS) { rejected.push({ reason: "SOURCE_AVAILABLE_AFTER_T90", subject }); continue; }
    if (observed > ingested) { rejected.push({ reason: "SOURCE_OBSERVED_AFTER_INGESTED", subject }); continue; }
    const list = byCondition.get(cond) ?? [];
    list.push(row); byCondition.set(cond, list);
  }
  const candidates: SourceCandidate[] = [];
  for (const [cond, list] of [...byCondition.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const identities = new Set(list.map((r) => `${str(r.provider_event_id)}|${iso(Date.parse(str(r.game_start_iso)!))}`));
    if (identities.size > 1) { rejected.push({ reason: "CONDITION_PROVIDER_EVENT_CONTRADICTION", subject: cond }); continue; }
    const byToken = new Map<string, SourceRow[]>();
    for (const r of list) { const t = str(r.selected_token_id)!; byToken.set(t, [...(byToken.get(t) ?? []), r]); }
    for (const [token, tokenRows] of [...byToken.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      const newest = [...tokenRows].sort((a, b) => Date.parse(b.ingested_at) - Date.parse(a.ingested_at) || cmp(b.item_observation_id, a.item_observation_id))[0];
      const family = str(newest.provider_sport_family)?.toLowerCase() ?? null;
      if (!family || !(TARGET_SPORT_FAMILIES as readonly string[]).includes(family)) { rejected.push({ reason: "SPORT_FAMILY_NOT_TARGET", subject: cond, tokenId: token }); continue; }
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

export type ProviderMarket = Awaited<ReturnType<typeof defaultExactEventReader>>[number];
export type ProviderConfirmation = {
  physicalEventId: string; providerGameId: string | null; oppositeTokenId: string; providerMarketType: string; providerMarketFamily: string;
  providerMarketSlug: string | null;
};

/**
 * Provider-confirmed condition + outcome-token pair. The provider's own market for this condition must list exactly two
 * outcome tokens, the source-selected token must be one of them, the market must be an admitted full-match type for the
 * sport, and the source market type (when stated) must not contradict the provider's.
 */
export function confirmProviderIdentity(c: SourceCandidate, markets: readonly ProviderMarket[]): ProviderConfirmation | Rejection {
  const subject = c.conditionId;
  const own = markets.filter((m) => m.condition_id === c.conditionId);
  if (own.length !== 1) return { reason: own.length === 0 ? "CONDITION_NOT_IN_PROVIDER_EVENT" : "CONDITION_DUPLICATED_IN_PROVIDER_EVENT", subject, tokenId: c.tokenId };
  const market = own[0];
  const { tokens, missingIdentity } = inventoryTokens([market]);
  if (missingIdentity > 0 || tokens.length !== 2 || new Set(tokens.map((t) => t.tokenId)).size !== 2) return { reason: "PROVIDER_TOKEN_PAIR_NOT_BINARY", subject, tokenId: c.tokenId };
  const selected = tokens.find((t) => t.tokenId === c.tokenId);
  const opposite = tokens.find((t) => t.tokenId !== c.tokenId);
  if (!selected || !opposite) return { reason: "SELECTED_TOKEN_NOT_IN_PROVIDER_PAIR", subject, tokenId: c.tokenId };
  const admitted = admitResearchMarket(c.sportFamily, market.sports_market_type, market.provider_market_slug);
  if (!admitted.admitted) return { reason: "MARKET_TYPE_NOT_ADMITTED", subject, tokenId: c.tokenId };
  if (c.sourceMarketType !== null) {
    const src = admitResearchMarket(c.sportFamily, c.sourceMarketType, market.provider_market_slug);
    if (src.type !== admitted.type) return { reason: "SOURCE_PROVIDER_MARKET_TYPE_CONTRADICTION", subject, tokenId: c.tokenId };
  }
  const gameId = market.provider_game_id ?? null;
  return {
    physicalEventId: physicalMatchId({ eventId: c.providerEventId, eventStartIso: c.eventStartIso, gameId }),
    providerGameId: gameId, oppositeTokenId: opposite.tokenId, providerMarketType: admitted.type, providerMarketFamily: admitted.family,
    providerMarketSlug: market.provider_market_slug,
  };
}

export type BookEvidence = {
  state: string; executable: boolean | null; askDepthUsd: number | null; vwap: number | null; shares: number | null;
  quoteCompletedAtMs: number | null; providerBookTimestampMs: number | null; stakeUsd: number; priceCap: number;
};

/** Pure: one independent token book -> executable full-stake evidence via the existing sibling-telemetry authority. */
export function bookEvidence(
  c: Pick<SourceCandidate, "conditionId" | "tokenId" | "outcome">, result: FetchOrderBookResult | null | undefined,
  /** Omitted = the LIVE Queue cap (QUEUE_MAX_ENTRY_PRICE). A model's own ceiling is passed only by resolveModelDecisions. */
  hardCap?: number,
): BookEvidence {
  const cols = buildExecutableSiblingColumns({ token: { conditionId: c.conditionId, tokenId: c.tokenId, side: c.outcome ?? "" }, result, fee: null, ...(hardCap === undefined ? {} : { hardCap }) });
  return {
    state: String(cols.executable_full_stake_state), executable: (cols.executable_full_stake as boolean | null) ?? null,
    askDepthUsd: (cols.ask_depth_relevant_usd as number | null) ?? null, vwap: (cols.full_stake_executable_vwap as number | null) ?? null,
    shares: (cols.full_stake_shares as number | null) ?? null,
    quoteCompletedAtMs: result?.ok ? result.responseCompletedAtMs ?? null : null,
    providerBookTimestampMs: result?.ok ? result.book?.providerTimestampMs ?? null : null,
    stakeUsd: COHORT_STAKE_USD, priceCap: hardCap ?? COHORT_PRICE_CAP,
  };
}

/** Which evidence qualified a token for event ranking. LIVE_QUEUE = unchanged 0.555 view; MODEL_AUTHORITY = the model's own ceiling. */
export type RankView = { source: "LIVE_QUEUE" | "MODEL_AUTHORITY"; strategyId: string | null; strategyVersion: string | null; depthUsd: number; priceCap: number };
export type EvaluatedCandidate = SourceCandidate & ProviderConfirmation & {
  /** LIVE Queue view (cap 0.555). A failure here is a LIVE Queue fact, not a research or model verdict. */
  book: BookEvidence;
  /** Raw independent book, kept so a model's own ceiling can be applied without a second fetch. */
  bookResult?: FetchOrderBookResult | null;
  rank?: RankView;
};

// ── model authority (injected; frozen predicates are never re-implemented here) ───────────────────────────────────
/** Source facts only: no book, no result, no settlement, so neither the LIVE cap nor the future can influence a model. */
export type ModelTokenView = Pick<SourceCandidate, "conditionId" | "tokenId" | "outcome" | "sourceMarketType" | "entryPrice" | "score" | "observedAt" | "ingestedAt" | "eventStartIso" | "sportFamily">
  & Pick<ProviderConfirmation, "oppositeTokenId" | "providerMarketType" | "providerMarketFamily">;
export type ModelEventView = { physicalEventId: string; sportFamily: string; eventStartIso: string; tokens: readonly ModelTokenView[] };
export type ModelEligibility = {
  strategyId: string; strategyVersion: string;
  decision: "BET" | "SKIP" | "UNEVALUATED";
  /** The model's own exact side; may differ from the cohort ranking anchor and from any other strategy's side. */
  tokenId: string | null;
  /** The model's own frozen entry-price ceiling for that token. null = execution authority UNKNOWN. */
  entryPriceCeiling: number | null;
};
export type ModelAuthority = (event: ModelEventView) => readonly ModelEligibility[];
export type ModelDecisionRecord = {
  strategyId: string; strategyVersion: string; physicalEventId: string;
  /** UNKNOWN = a BET that cannot be accepted (no execution authority, or token outside the inventory). */
  decision: "BET" | "SKIP" | "UNEVALUATED" | "UNKNOWN";
  tokenId: string | null; entryPriceCeiling: number | null;
  execution: { state: string; executable: boolean | null; askDepthUsd: number | null; vwap: number | null; priceCap: number | null };
  /** The same token under the unchanged LIVE Queue policy (0.555). Reported, never used to discard the model's choice. */
  liveQueue: { state: string | null; executable: boolean | null };
};
const validCeiling = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;

/** Pure: apply the injected model authority to ALL tokens of one physical event, then measure execution at the model's own ceiling. */
export function resolveModelDecisions(physicalEventId: string, tokens: readonly EvaluatedCandidate[], authority: ModelAuthority | undefined): ModelDecisionRecord[] {
  if (!authority || tokens.length === 0) return [];
  const ordered = [...tokens].sort((a, b) => cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId));
  const view: ModelEventView = {
    physicalEventId, sportFamily: ordered[0].sportFamily, eventStartIso: ordered[0].eventStartIso,
    tokens: ordered.map((t) => ({
      conditionId: t.conditionId, tokenId: t.tokenId, outcome: t.outcome, sourceMarketType: t.sourceMarketType, entryPrice: t.entryPrice, score: t.score,
      observedAt: t.observedAt, ingestedAt: t.ingestedAt, eventStartIso: t.eventStartIso, sportFamily: t.sportFamily,
      oppositeTokenId: t.oppositeTokenId, providerMarketType: t.providerMarketType, providerMarketFamily: t.providerMarketFamily,
    })),
  };
  const none = { state: "NOT_APPLICABLE", executable: null, askDepthUsd: null, vwap: null, priceCap: null };
  const out = authority(view).map((m): ModelDecisionRecord => {
    const base = { strategyId: m.strategyId, strategyVersion: m.strategyVersion, physicalEventId, tokenId: m.tokenId ?? null, entryPriceCeiling: m.entryPriceCeiling ?? null };
    if (m.decision !== "BET") return { ...base, decision: m.decision, execution: none, liveQueue: { state: null, executable: null } };
    const token = ordered.find((t) => t.tokenId === m.tokenId);
    if (!token) return { ...base, decision: "UNKNOWN", execution: { ...none, state: "MODEL_TOKEN_NOT_IN_INVENTORY" }, liveQueue: { state: null, executable: null } };
    const liveQueue = { state: token.book.state, executable: token.book.executable };
    if (!validCeiling(m.entryPriceCeiling)) return { ...base, decision: "UNKNOWN", execution: { ...none, state: "UNKNOWN_EXECUTION_AUTHORITY" }, liveQueue };
    const ev = bookEvidence(token, token.bookResult, m.entryPriceCeiling);
    return { ...base, decision: "BET", execution: { state: ev.state, executable: ev.executable, askDepthUsd: ev.askDepthUsd, vwap: ev.vwap, priceCap: ev.priceCap }, liveQueue };
  });
  return out.sort((a, b) => cmp(a.strategyId, b.strategyId) || cmp(a.strategyVersion, b.strategyVersion) || cmp(a.tokenId ?? "", b.tokenId ?? ""));
}

export type CohortSelection = {
  event: EvaluatedCandidate; bucket: "SOCCER" | "TENNIS" | "OTHER_DIVERSITY_FLOOR" | "OTHER_LIQUIDITY_FILL"; sportRank: number;
  /** Every injected model's own decision for this physical event. The ranking anchor (`event`) is NOT any model's side. */
  modelDecisions: ModelDecisionRecord[];
};

const rankDepth = (e: EvaluatedCandidate) => e.rank?.depthUsd ?? e.book.askDepthUsd ?? 0;

/** Rank depth DESC, then start ASC, physical id, condition, token: total order, no randomness. */
export function compareExecutableLiquidity(a: EvaluatedCandidate, b: EvaluatedCandidate): number {
  return rankDepth(b) - rankDepth(a)
    || Date.parse(a.eventStartIso) - Date.parse(b.eventStartIso)
    || cmp(a.physicalEventId, b.physicalEventId) || cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId);
}

/**
 * Pure, deterministic 50/25/25 selection. Only quote-causal, full-stake EXECUTABLE candidates are eligible. Exactly one
 * candidate (best executable depth, compared AFTER every distinct condition/token candidate was independently measured)
 * survives per physical event, so no event can carry duplicate or opposing sides; each loser is reported with its token.
 * Ranking is per sport; there is NO backfill between the soccer, tennis and other quotas (the other quota subdivides
 * only inside OTHER_SPORT_FAMILIES via the approved floor + liquidity fill).
 */
export function selectExecutableLiquidityCohort(evaluated: readonly EvaluatedCandidate[], asOfMs: number, modelAuthority?: ModelAuthority) {
  const rejected: Rejection[] = [];
  // Model decisions are resolved on the WHOLE inventory of each physical event, before any executability gate.
  const inventoryByPhysical = new Map<string, EvaluatedCandidate[]>();
  for (const e of evaluated) inventoryByPhysical.set(e.physicalEventId, [...(inventoryByPhysical.get(e.physicalEventId) ?? []), e]);
  const decisionsByPhysical = new Map<string, ModelDecisionRecord[]>();
  for (const [pid, tokens] of [...inventoryByPhysical.entries()].sort((a, b) => cmp(a[0], b[0]))) decisionsByPhysical.set(pid, resolveModelDecisions(pid, tokens, modelAuthority));
  const quoteCausal: EvaluatedCandidate[] = [];
  for (const candidate of evaluated) {
    // LIVE Queue evidence qualifies a token exactly as before; a token that fails it is rescued ONLY by a model's own BET on
    // that exact token, measured at that model's own ceiling. Without an injected authority this branch is never taken.
    let rank: RankView | null = null;
    if (candidate.book.executable === true && candidate.book.askDepthUsd !== null) {
      rank = { source: "LIVE_QUEUE", strategyId: null, strategyVersion: null, depthUsd: candidate.book.askDepthUsd, priceCap: candidate.book.priceCap };
    } else {
      const viable = (decisionsByPhysical.get(candidate.physicalEventId) ?? [])
        .filter((d) => d.decision === "BET" && d.tokenId === candidate.tokenId && d.execution.executable === true && d.execution.askDepthUsd !== null && d.execution.priceCap !== null)
        .sort((a, b) => (b.execution.askDepthUsd as number) - (a.execution.askDepthUsd as number) || cmp(a.strategyId, b.strategyId) || cmp(a.strategyVersion, b.strategyVersion))[0];
      if (viable) rank = { source: "MODEL_AUTHORITY", strategyId: viable.strategyId, strategyVersion: viable.strategyVersion, depthUsd: viable.execution.askDepthUsd as number, priceCap: viable.execution.priceCap as number };
    }
    const e = rank ? { ...candidate, rank } : candidate;
    if (!rank) { rejected.push({ reason: `NOT_EXECUTABLE:${e.book.state}`, subject: e.conditionId, tokenId: e.tokenId }); continue; }
    if (e.book.quoteCompletedAtMs === null || e.book.quoteCompletedAtMs < asOfMs) { rejected.push({ reason: "QUOTE_TIMESTAMP_MISSING_OR_BEFORE_ASOF", subject: e.conditionId, tokenId: e.tokenId }); continue; }
    if (e.book.quoteCompletedAtMs > Date.parse(e.eventStartIso) - T90_MINUTES * MIN_MS) { rejected.push({ reason: "QUOTE_AFTER_T90", subject: e.conditionId, tokenId: e.tokenId }); continue; }
    quoteCausal.push(e);
  }
  const byPhysical = new Map<string, EvaluatedCandidate[]>();
  for (const e of quoteCausal) byPhysical.set(e.physicalEventId, [...(byPhysical.get(e.physicalEventId) ?? []), e]);
  const perEvent: EvaluatedCandidate[] = [];
  for (const [pid, list] of [...byPhysical.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    if (new Set(list.map((e) => e.sportFamily)).size > 1) { rejected.push({ reason: "PHYSICAL_EVENT_SPORT_CONTRADICTION", subject: pid }); continue; }
    const sorted = [...list].sort(compareExecutableLiquidity);
    perEvent.push(sorted[0]);
    for (const loser of sorted.slice(1)) {
      const opposing = loser.conditionId === sorted[0].conditionId;
      rejected.push({ reason: opposing ? "EVENT_OPPOSING_TOKEN_LOWER_LIQUIDITY" : "EVENT_ALTERNATE_CANDIDATE_LOWER_LIQUIDITY", subject: loser.conditionId, tokenId: loser.tokenId });
    }
  }
  const ranked = (family: string) => perEvent.filter((e) => e.sportFamily === family).sort(compareExecutableLiquidity);
  const selected: CohortSelection[] = [];
  const taken = new Set<string>();
  const take = (event: EvaluatedCandidate, bucket: CohortSelection["bucket"], rank: number) => {
    taken.add(event.physicalEventId); selected.push({ event, bucket, sportRank: rank, modelDecisions: decisionsByPhysical.get(event.physicalEventId) ?? [] });
  };
  ranked("soccer").slice(0, SOCCER_QUOTA_T90).forEach((e, i) => take(e, "SOCCER", i + 1));
  ranked("tennis").slice(0, TENNIS_QUOTA_T90).forEach((e, i) => take(e, "TENNIS", i + 1));
  const otherRanks = new Map<string, number>();
  const otherPool = perEvent.filter((e) => (OTHER_SPORT_FAMILIES as readonly string[]).includes(e.sportFamily)).sort(compareExecutableLiquidity);
  for (const family of OTHER_SPORT_FAMILIES) ranked(family).forEach((e, i) => otherRanks.set(e.physicalEventId, i + 1));
  let otherN = 0;
  for (const family of OTHER_SPORT_FAMILIES) {
    for (const e of ranked(family).slice(0, OTHER_DIVERSITY_FLOOR_PER_SPORT)) {
      if (otherN >= OTHER_QUOTA_T90) break;
      take(e, "OTHER_DIVERSITY_FLOOR", otherRanks.get(e.physicalEventId)!); otherN++;
    }
  }
  for (const e of otherPool) {
    if (otherN >= OTHER_QUOTA_T90) break;
    if (taken.has(e.physicalEventId)) continue;
    take(e, "OTHER_LIQUIDITY_FILL", otherRanks.get(e.physicalEventId)!); otherN++;
  }
  const final = selected.slice(0, MAX_RESEARCH_EVENTS_PER_DAY);
  const count = (f: (s: CohortSelection) => boolean) => final.filter(f).length;
  const eligibleBySport: Record<string, number> = {};
  for (const e of perEvent) eligibleBySport[e.sportFamily] = (eligibleBySport[e.sportFamily] ?? 0) + 1;
  const selectedBySport: Record<string, number> = {};
  for (const s of final) selectedBySport[s.event.sportFamily] = (selectedBySport[s.event.sportFamily] ?? 0) + 1;
  const cutoff = (bucketFilter: (s: CohortSelection) => boolean) => {
    const depths = final.filter(bucketFilter).map((s) => rankDepth(s.event));
    return depths.length ? Math.min(...depths) : null;
  };
  const soccerN = count((s) => s.bucket === "SOCCER"); const tennisN = count((s) => s.bucket === "TENNIS");
  const otherSelN = count((s) => s.bucket.startsWith("OTHER"));
  return {
    selected: final, rejected,
    diagnostics: {
      eligible_physical_event_n: perEvent.length, eligible_by_sport: eligibleBySport, selected_by_sport: selectedBySport,
      soccer_selected_n: soccerN, tennis_selected_n: tennisN, other_selected_n: otherSelN,
      soccer_quota_underfill_n: SOCCER_QUOTA_T90 - soccerN, tennis_quota_underfill_n: TENNIS_QUOTA_T90 - tennisN,
      other_quota_underfill_n: OTHER_QUOTA_T90 - otherSelN, global_backfill_n: 0,
      depth_cutoff_usd: { soccer: cutoff((s) => s.bucket === "SOCCER"), tennis: cutoff((s) => s.bucket === "TENNIS"), other: cutoff((s) => s.bucket.startsWith("OTHER")) },
      model_authority_injected: modelAuthority !== undefined,
      model_decision_n: [...decisionsByPhysical.values()].reduce((n, d) => n + d.length, 0),
      model_decision_unknown_n: [...decisionsByPhysical.values()].reduce((n, d) => n + d.filter((x) => x.decision === "UNKNOWN").length, 0),
      model_rescued_candidate_n: quoteCausal.filter((e) => e.rank?.source === "MODEL_AUTHORITY").length,
      selected_anchor_differs_from_model_token_n: final.filter((s) => s.modelDecisions.some((d) => d.decision === "BET" && d.tokenId !== s.event.tokenId)).length,
    },
    /** Full candidate inventory: nothing is dropped silently; each token states which evidence (if any) qualified it. */
    inventory: [...evaluated].sort((a, b) => cmp(a.physicalEventId, b.physicalEventId) || cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId)).map((e) => ({
      physical_event_id: e.physicalEventId, condition_id: e.conditionId, token_id: e.tokenId, live_queue_state: e.book.state,
      qualified_by: quoteCausal.find((q) => q.conditionId === e.conditionId && q.tokenId === e.tokenId)?.rank?.source ?? null,
    })),
  };
}

export function countReasons(rejections: readonly Rejection[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejections) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => a[0] < b[0] ? -1 : 1));
}

export const sha256 = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// ── orchestration (all I/O injected; read-only) ────────────────────────────────────────────────────────────────────

export type CohortDeps = {
  /** DB-server as-of (ms) and the source rows ingested at/before it. */
  readSource: () => Promise<{ asOfMs: number; rows: SourceRow[] }>;
  readProviderEvent?: typeof defaultExactEventReader;
  fetchBooks?: typeof fetchOrderBooksConcurrent;
  fetchFee?: (tokenId: string) => Promise<TokenFeeScheduleResult>;
  /** Optional model-owned BET/SKIP/side/ceiling authority. Absent = model eligibility UNEVALUATED; only the LIVE Queue view qualifies tokens. */
  modelAuthority?: ModelAuthority;
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
  const { asOfMs, rows } = await deps.readSource();
  const reduced = reduceSourceRows(rows, asOfMs);
  const rejected: Rejection[] = [...reduced.rejected];

  const events = new Map<string, SourceCandidate[]>();
  for (const c of reduced.candidates) events.set(`${c.providerEventId}|${c.eventStartIso}`, [...(events.get(`${c.providerEventId}|${c.eventStartIso}`) ?? []), c]);
  const confirmed: Array<SourceCandidate & ProviderConfirmation> = [];
  await mapLimit([...events.entries()], limit, async ([, list]) => {
    let markets: ProviderMarket[];
    try { markets = await readProviderEvent(list[0].providerEventId, list[0].eventStartIso); }
    catch (error) {
      const code = error instanceof Error ? error.message : "PROVIDER_EVENT_READ_FAILED";
      for (const c of list) rejected.push({ reason: `PROVIDER_EVENT:${code === "RESERVED_EVENT_START_MISMATCH" ? code : "UNAVAILABLE"}`, subject: c.conditionId, tokenId: c.tokenId });
      return;
    }
    for (const c of list) {
      const result = confirmProviderIdentity(c, markets);
      if ("reason" in result) rejected.push(result); else confirmed.push({ ...c, ...result });
    }
  });
  confirmed.sort((a, b) => cmp(a.conditionId, b.conditionId) || cmp(a.tokenId, b.tokenId));

  const books = await fetchBooks(confirmed.map((c) => c.tokenId), limit);
  const evaluated: EvaluatedCandidate[] = confirmed.map((c, i) => ({ ...c, book: bookEvidence(c, books[i]), bookResult: books[i] }));
  const selection = selectExecutableLiquidityCohort(evaluated, asOfMs, deps.modelAuthority);
  rejected.push(...selection.rejected);

  const fees = await mapLimit(selection.selected, limit, async (s) => fetchFee(s.event.tokenId));
  return { asOfMs, sourceRowN: rows.length, reducedCandidateN: reduced.candidates.length, providerConfirmedN: confirmed.length, evaluated, selection, fees, rejected };
}
