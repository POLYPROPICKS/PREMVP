/**
 * FORWARD_MODEL_DECISIONS_T90_V1 — research-only prospective decision producer.
 *
 * Consumes the FROZEN, model-independent EXECUTABLE_LIQUIDITY_COHORT_T90_V2 and the outputs of the existing frozen model
 * selectors (injected; never re-implemented here) and produces one explicit outcome per (physical event, model version):
 * BET, SKIP, BLOCKED/UNPROVEN or NOT_APPLICABLE (sport scope). It then classifies execution authority and DB first-persistence
 * readiness for every BET. It contains NO database write path: persistence readiness is a fail-closed gate whose first
 * failed edge is reported. Pure; all I/O lives in the runner.
 *
 * Invariants:
 *  - the cohort is deep-frozen and its canonical digest is proven identical before and after evaluation;
 *  - a model's BET token is the model's OWN selected token (exact condition|token in the event's provider-confirmed
 *    inventory); the research anchor is never used as a betting side;
 *  - a BET on a token with no scored source row of its own is UNPROVEN (scores/prices are never copied across tokens);
 *  - SKIP is emitted only when the model actually evaluated at least one source candidate of the event; missing data is BLOCKED;
 *  - chronological first claim: at most one BET per (model version, physical event);
 *  - unknown model economics => not EXECUTABLE; LIVE Queue eligibility is never assumed.
 */
import {
  cohortDigest, measureResearchLiquidity, RESEARCH_LIQUIDITY_CONTRACT, t90CutoffMs,
  type Cohort, type CohortSelection, type MeasuredToken, type ResearchLiquidity,
} from "./executableLiquidityCohortT90";
import type { FetchOrderBookResult } from "../liquidity/types";
import type { TokenFeeScheduleResult } from "../liquidity/polymarketClient";

export const FORWARD_DECISIONS_VERSION = "FORWARD_MODEL_DECISIONS_T90_V1";
/** The deployed guard (per mission authority) classifies an observation older than this at persistence as LATE_OR_REPLAY. */
export const GUARD_LATE_OR_REPLAY_MS = 2 * 60 * 60_000;

// ── model registry views (identities come from the frozen owners; this file only names their families) ───────────

export type ModelFamily = "SAFE_PREMATCH" | "FOOTBALL_D1";
export type ModelRef = { modelId: string; modelVersion: string; family: ModelFamily; sportScope: "ALL" | "soccer" | "tennis" };

/** One frozen-selector pick. candidateIdentity = `${condition_id}::${selected_token_id}::${decision_at}` (owner format). */
export type ModelBet = {
  candidateIdentity: string; conditionId: string; tokenId: string; decisionTimestamp: string; eventStart: string;
  entryPrice: number; modelPhysicalEventKey: string;
  /** DB `ingested_at` of the model's OWN source row behind this pick (not the cohort's newest row); null = unproven. */
  sourceIngestedAt: string | null;
};

export type ModelEvaluation =
  | {
    status: "EVALUATED";
    bets: readonly ModelBet[];
    /** condition|token keys of every source candidate the frozen selector received (selected or not). */
    evaluatedTokenKeys: ReadonlySet<string>;
    /** How each candidate's pre-T-90 availability is proven. Only DB_INGESTED_AT_BEFORE_T90 is causal proof. */
    sourceAvailability: "DB_INGESTED_AT_BEFORE_T90";
  }
  | { status: "BLOCKED"; reason: string; evidence: string };

export const tokenKey = (conditionId: string, tokenId: string) => `${conditionId}|${tokenId}`;

export function parseCandidateIdentity(identity: string): { conditionId: string; tokenId: string; decisionAt: string } | null {
  const parts = identity.split("::");
  if (parts.length !== 3 || parts.some((p) => p.trim() === "")) return null;
  return { conditionId: parts[0], tokenId: parts[1], decisionAt: parts[2] };
}

// ── 1. per (event, model) outcome ─────────────────────────────────────────────────────────────────────────────────

export type DecisionOutcome = "BET" | "SKIP" | "BLOCKED" | "NOT_APPLICABLE";
export type ModelEventDecision = {
  physicalEventId: string; sportFamily: string; eventStartIso: string; t90CutoffIso: string;
  modelId: string; modelVersion: string; family: ModelFamily;
  outcome: DecisionOutcome; reason: string;
  bet: (ModelBet & {
    outcomeLabel: string; oppositeTokenId: string; providerMarketType: string; providerEventId: string;
    /** The model token's OWN scored source row (never the anchor's or the opposite token's). */
    source: { score: number | null; entryPrice: number | null; observedAt: string; ingestedAt: string; itemObservationId: string };
    isCohortAnchor: boolean;
  }) | null;
};

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const inScope = (m: ModelRef, sport: string) => m.sportScope === "ALL" || m.sportScope === sport;

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]); }
  return v;
}

/**
 * Pure. The cohort is frozen first; evaluations are produced by the frozen selectors over their OWN source universe
 * (not over the cohort), and joined to cohort events only by exact condition|token membership.
 */
export function decideCohortModels(
  cohort: Cohort,
  models: readonly ModelRef[],
  evaluations: ReadonlyMap<string, ModelEvaluation>,
): { decisions: ModelEventDecision[]; digestBefore: string; digestAfter: string; outOfCohortBets: Record<string, number>; uniquenessViolations: string[] } {
  deepFreeze(cohort);
  const digestBefore = cohortDigest(cohort);
  const byToken = new Map<string, { event: CohortSelection; token: MeasuredToken }>();
  for (const event of cohort.selected) for (const token of event.inventory) byToken.set(tokenKey(token.conditionId, token.tokenId), { event, token });

  const decisions: ModelEventDecision[] = [];
  const outOfCohortBets: Record<string, number> = {};
  const uniquenessViolations: string[] = [];
  for (const model of models) {
    const key = modelKey(model);
    const evaluation = evaluations.get(key) ?? { status: "BLOCKED", reason: "MODEL_EVALUATION_MISSING", evidence: "no evaluation supplied for this model version" } as const;
    // Chronological first claim per physical event, under THIS model only.
    const claims = new Map<string, ModelBet>();
    if (evaluation.status === "EVALUATED") {
      const ordered = [...evaluation.bets].sort((a, b) => Date.parse(a.decisionTimestamp) - Date.parse(b.decisionTimestamp) || cmp(a.candidateIdentity, b.candidateIdentity));
      for (const bet of ordered) {
        const hit = byToken.get(tokenKey(bet.conditionId, bet.tokenId));
        if (!hit) { outOfCohortBets[key] = (outOfCohortBets[key] ?? 0) + 1; continue; }
        const pid = hit.event.physicalEventId;
        if (claims.has(pid)) { uniquenessViolations.push(`${key}:${pid}`); continue; }
        claims.set(pid, bet);
      }
    }
    for (const event of cohort.selected) {
      const base = {
        physicalEventId: event.physicalEventId, sportFamily: event.sportFamily, eventStartIso: event.eventStartIso, t90CutoffIso: event.t90CutoffIso,
        modelId: model.modelId, modelVersion: model.modelVersion, family: model.family, bet: null,
      };
      if (!inScope(model, event.sportFamily)) { decisions.push({ ...base, outcome: "NOT_APPLICABLE", reason: `SPORT_SCOPE:${model.sportScope}` }); continue; }
      if (evaluation.status === "BLOCKED") { decisions.push({ ...base, outcome: "BLOCKED", reason: evaluation.reason }); continue; }
      const bet = claims.get(event.physicalEventId);
      if (!bet) {
        const seen = event.inventory.some((t) => evaluation.evaluatedTokenKeys.has(tokenKey(t.conditionId, t.tokenId)));
        decisions.push(seen
          ? { ...base, outcome: "SKIP", reason: "FROZEN_SELECTOR_DID_NOT_SELECT" }
          : { ...base, outcome: "BLOCKED", reason: "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT" });
        continue;
      }
      const token = byToken.get(tokenKey(bet.conditionId, bet.tokenId))!.token;
      if (!token.source) { decisions.push({ ...base, outcome: "BLOCKED", reason: "UNPROVEN_MODEL_TOKEN_HAS_NO_OWN_SOURCE_ROW" }); continue; }
      if (Date.parse(bet.decisionTimestamp) > t90CutoffMs(event.eventStartIso)) { decisions.push({ ...base, outcome: "BLOCKED", reason: "MODEL_DECISION_AFTER_T90" }); continue; }
      // The pick exists only once the DB possessed its own row: that ingest must be proven and at/before T-90.
      if (bet.sourceIngestedAt === null || !Number.isFinite(Date.parse(bet.sourceIngestedAt))) { decisions.push({ ...base, outcome: "BLOCKED", reason: "UNPROVEN_MODEL_SOURCE_INGEST_TIME" }); continue; }
      if (Date.parse(bet.sourceIngestedAt) > t90CutoffMs(event.eventStartIso)) { decisions.push({ ...base, outcome: "BLOCKED", reason: "MODEL_SOURCE_INGESTED_AFTER_T90" }); continue; }
      if (Date.parse(bet.eventStart) !== Date.parse(event.eventStartIso)) { decisions.push({ ...base, outcome: "BLOCKED", reason: "MODEL_EVENT_START_CONTRADICTS_COHORT" }); continue; }
      decisions.push({
        ...base, outcome: "BET", reason: "MODEL_ELIGIBLE",
        bet: {
          ...bet, outcomeLabel: token.outcome, oppositeTokenId: token.oppositeTokenId, providerMarketType: token.providerMarketType, providerEventId: token.providerEventId,
          source: { score: token.source.score, entryPrice: token.source.entryPrice, observedAt: token.source.observedAt, ingestedAt: token.source.ingestedAt, itemObservationId: token.source.itemObservationId },
          isCohortAnchor: event.anchor.conditionId === bet.conditionId && event.anchor.tokenId === bet.tokenId,
        },
      });
    }
  }
  decisions.sort((a, b) => cmp(a.physicalEventId, b.physicalEventId) || cmp(a.modelId, b.modelId) || cmp(a.modelVersion, b.modelVersion));
  return { decisions, digestBefore, digestAfter: cohortDigest(cohort), outOfCohortBets, uniquenessViolations };
}

export const modelKey = (m: Pick<ModelRef, "modelId" | "modelVersion">) => `${m.modelId}@${m.modelVersion}`;

// ── 2. model-specific execution authority (per BET, on the model's OWN token) ─────────────────────────────────────

export type ExecutionTier = "MODEL_ELIGIBLE" | "RESEARCH_SAMPLE_ELIGIBLE" | "EXECUTABLE" | "LIVE_QUEUE_ELIGIBLE";
/** Model-specific stake/price/fee authority. No registered entry exists today; an absent entry is never defaulted. */
export type ModelEconomicsAuthority = ReadonlyMap<string, { stakeUsd: number; maxEntryPrice: number; source: string }>;
export const REGISTERED_MODEL_ECONOMICS: ModelEconomicsAuthority = new Map();

export type ExecutionAssessment = {
  tierReached: ExecutionTier;
  /** The first tier NOT reached and why; null only if every tier was reached (never, today). */
  blockedAt: { tier: ExecutionTier; reason: string } | null;
  research: Pick<ResearchLiquidity, "contractId" | "stakeUsd" | "priceLimit" | "state" | "executable" | "vwap" | "shares" | "bestAsk" | "venueMinOrderShares" | "providerBookTimestampMs" | "quoteCompletedAtLocalMs" | "quoteAgeAtCompletionMs">;
  researchContractProvisional: true;
  fee: { state: "KNOWN"; rate: number; formula: string } | { state: "UNKNOWN"; reason: string };
  liveQueue: "NOT_EVALUATED_NO_AUTHORITY";
};

/**
 * Pure. Measures the model's own token book under the PROVISIONAL research benchmark (no stake/limit override is possible:
 * measureResearchLiquidity rejects any non-registered contract) and stops at the first missing authority.
 */
export function assessExecution(
  decision: ModelEventDecision,
  book: FetchOrderBookResult | null | undefined,
  fee: TokenFeeScheduleResult | null | undefined,
  snapshotReadCompletedLocalMs: number,
  economics: ModelEconomicsAuthority = REGISTERED_MODEL_ECONOMICS,
): ExecutionAssessment {
  if (decision.outcome !== "BET" || !decision.bet) throw new Error("ASSESS_EXECUTION_REQUIRES_BET");
  const r = measureResearchLiquidity(
    { conditionId: decision.bet.conditionId, tokenId: decision.bet.tokenId, outcome: decision.bet.outcomeLabel, eventStartIso: decision.eventStartIso },
    book, snapshotReadCompletedLocalMs, RESEARCH_LIQUIDITY_CONTRACT,
  );
  const feeView: ExecutionAssessment["fee"] = fee?.ok ? { state: "KNOWN", rate: fee.takerRate, formula: fee.formulaVersion } : { state: "UNKNOWN", reason: fee && !fee.ok ? fee.errorCode : "NOT_FETCHED" };
  const research = {
    contractId: r.contractId, stakeUsd: r.stakeUsd, priceLimit: r.priceLimit, state: r.state, executable: r.executable, vwap: r.vwap, shares: r.shares,
    bestAsk: r.bestAsk, venueMinOrderShares: r.venueMinOrderShares, providerBookTimestampMs: r.providerBookTimestampMs,
    quoteCompletedAtLocalMs: r.quoteCompletedAtLocalMs, quoteAgeAtCompletionMs: r.quoteAgeAtCompletionMs,
  };
  const out = (tierReached: ExecutionTier, blockedAt: ExecutionAssessment["blockedAt"]): ExecutionAssessment =>
    ({ tierReached, blockedAt, research, researchContractProvisional: true, fee: feeView, liveQueue: "NOT_EVALUATED_NO_AUTHORITY" });
  if (!r.executable) return out("MODEL_ELIGIBLE", { tier: "RESEARCH_SAMPLE_ELIGIBLE", reason: `RESEARCH_BOOK:${r.state}` });
  if (feeView.state !== "KNOWN") return out("MODEL_ELIGIBLE", { tier: "RESEARCH_SAMPLE_ELIGIBLE", reason: `FEE_UNKNOWN:${feeView.reason}` });
  if (!economics.has(modelKey(decision))) return out("RESEARCH_SAMPLE_ELIGIBLE", { tier: "EXECUTABLE", reason: "MODEL_ECONOMICS_AUTHORITY_ABSENT" });
  return out("EXECUTABLE", { tier: "LIVE_QUEUE_ELIGIBLE", reason: "LIVE_QUEUE_AUTHORIZATION_NOT_INHERITED" });
}

// ── 3. DB first-persistence readiness (fail-closed; no write path exists in this module) ──────────────────────────

export type PersistenceEnvironment = {
  /** Application-owned Research DBClone write credential bound to nppznoujvnyjargjkmnv. */
  cloneWriteCapability: boolean;
  /** The deployed guard/trigger/columns were verified read-only against the forward contract (incl. lead time and LATE_OR_REPLAY). */
  deployedContractVerified: boolean;
  /** The ledger contract stores an immutable model VERSION (repo schema: model_id only; writer restricts model_id to SAFE ids). */
  ledgerEncodesModelVersion: boolean;
  /** Event start comes from an approved authoritative start source (not the scored source's scheduled start). */
  authoritativeStartSource: string | null;
};

export type PersistenceReadiness = { ready: boolean; firstFailedEdge: string | null; failedEdges: string[]; observationAgeAtCheckMs: number; leadToT90MsAtCheck: number };

export const PERSISTENCE_EDGES = [
  "EXECUTION_AUTHORITY", "AUTHORITATIVE_EVENT_START", "OBSERVATION_FRESH_FOR_GUARD", "BEFORE_T90_AT_CHECK",
  "LEDGER_ENCODES_MODEL_VERSION", "DEPLOYED_CONTRACT_VERIFIED", "CLONE_WRITE_CAPABILITY",
] as const;

/** Pure. Every edge is evaluated; `firstFailedEdge` follows the business provenance order of PERSISTENCE_EDGES. */
export function persistenceReadiness(decision: ModelEventDecision, execution: ExecutionAssessment | null, env: PersistenceEnvironment, nowMs: number): PersistenceReadiness {
  const failed: string[] = [];
  const observedMs = decision.bet ? Date.parse(decision.bet.decisionTimestamp) : NaN;
  const age = nowMs - observedMs;
  const lead = t90CutoffMs(decision.eventStartIso) - nowMs;
  if (!execution || execution.tierReached !== "EXECUTABLE" && execution.tierReached !== "LIVE_QUEUE_ELIGIBLE") failed.push("EXECUTION_AUTHORITY");
  if (!env.authoritativeStartSource) failed.push("AUTHORITATIVE_EVENT_START");
  if (!(Number.isFinite(age) && age >= 0 && age <= GUARD_LATE_OR_REPLAY_MS)) failed.push("OBSERVATION_FRESH_FOR_GUARD");
  if (!(lead > 0)) failed.push("BEFORE_T90_AT_CHECK");
  if (!env.ledgerEncodesModelVersion) failed.push("LEDGER_ENCODES_MODEL_VERSION");
  if (!env.deployedContractVerified) failed.push("DEPLOYED_CONTRACT_VERIFIED");
  if (!env.cloneWriteCapability) failed.push("CLONE_WRITE_CAPABILITY");
  const ordered = PERSISTENCE_EDGES.filter((e) => failed.includes(e));
  return { ready: decision.outcome === "BET" && ordered.length === 0, firstFailedEdge: decision.outcome !== "BET" ? "NOT_A_BET" : ordered[0] ?? null, failedEdges: ordered, observationAgeAtCheckMs: age, leadToT90MsAtCheck: lead };
}

// ── 4. aggregate receipt (no raw identities beyond the local receipt file) ───────────────────────────────────────

export function summarizeDecisions(decisions: readonly ModelEventDecision[]) {
  const byModel: Record<string, Record<DecisionOutcome, number>> = {};
  const blockedReasons: Record<string, number> = {};
  const eventsBySport: Record<string, Set<string>> = {};
  for (const d of decisions) {
    const k = modelKey(d);
    byModel[k] ??= { BET: 0, SKIP: 0, BLOCKED: 0, NOT_APPLICABLE: 0 };
    byModel[k][d.outcome]++;
    if (d.outcome === "BLOCKED") blockedReasons[d.reason] = (blockedReasons[d.reason] ?? 0) + 1;
    (eventsBySport[d.sportFamily] ??= new Set()).add(d.physicalEventId);
  }
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort((a, b) => cmp(a[0], b[0])));
  return {
    model_event_evaluations: decisions.filter((d) => d.outcome !== "NOT_APPLICABLE").length,
    selected_events_by_sport: sorted(Object.fromEntries(Object.entries(eventsBySport).map(([s, ids]) => [s, ids.size]))),
    outcomes_by_model: sorted(byModel), blocked_reasons: sorted(blockedReasons),
    bet_on_cohort_anchor_n: decisions.filter((d) => d.bet?.isCohortAnchor).length,
    bet_on_non_anchor_token_n: decisions.filter((d) => d.bet && !d.bet.isCohortAnchor).length,
  };
}
