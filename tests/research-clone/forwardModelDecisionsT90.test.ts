import test from "node:test";
import assert from "node:assert/strict";
import {
  liveQueueView, measureResearchLiquidity, selectPhysicalEventCohort,
  type InventoryToken, type MeasuredToken, type SourceCandidate,
} from "../../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, causalEdge, chronologicalClaims, decideCohortModels, modelKey, persistenceReadiness, summarizeDecisions, tokenKey, VERSION_ABSENT,
  type ModelBet, type ModelEvaluation, type ModelRef, type PersistenceEnvironment, type PrefixSelection,
} from "../../lib/research/forwardModelDecisionsT90";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";

// Fixtures prove decision LOGIC only. They are not evidence of any real cohort, BET, liquidity or persistence.
const REF = Date.parse("2026-10-14T10:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const startIn = (h: number) => iso(REF + h * H);
const GEN = REF; // the instant the runner actually generated its decisions

const book = (tokenId: string, price: number, size: number, completedAt = REF + 60_000, minimumOrderSize = 5): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 10, requestStartedAtMs: completedAt - 10, responseCompletedAtMs: completedAt,
  book: { tokenId, bids: [], asks: [{ price, size }], tickSize: 0.01, minimumOrderSize, providerTimestampMs: completedAt - 5 },
});
const src = (conditionId: string, tokenId: string, sport: string, start: string): SourceCandidate => ({
  conditionId, tokenId, outcome: "Home", providerEventId: `ev-${conditionId}`, eventStartIso: start, sportFamily: sport, sourceMarketType: "moneyline",
  observationId: "o", itemObservationId: `i-${tokenId}`, observedAt: iso(REF - 3 * H), ingestedAt: iso(REF - 2 * H),
  entryPrice: 0.5, score: 70, sourceRowN: 1, sourceItemObservationIds: [`i-${tokenId}`],
});

/** One event; token a is source-selected and deep (the anchor), token b is shallow and has NO source row. */
function event(n: number, sport: string, start = startIn(10)): MeasuredToken[] {
  const mk = (side: "a" | "b", depthUsd: number): MeasuredToken => {
    const t: InventoryToken = {
      conditionId: `0xe${n}`, tokenId: `tok-${n}-${side}`, outcome: side === "a" ? "Home" : "Away", oppositeTokenId: `tok-${n}-${side === "a" ? "b" : "a"}`,
      physicalEventId: `phys-${n}`, providerEventId: `ev-0xe${n}`, providerGameId: `g${n}`, eventStartIso: start, sportFamily: sport,
      providerMarketType: "MONEYLINE", providerMarketFamily: "MONEYLINE", providerMarketSlug: null,
      sourceSelected: side === "a", source: side === "a" ? src(`0xe${n}`, `tok-${n}-a`, sport, start) : null,
    };
    const b = book(t.tokenId, 0.5, depthUsd / 0.5);
    return { ...t, research: measureResearchLiquidity(t, b, REF), liveQueue: liveQueueView(t, b) };
  };
  return [mk("a", 500), mk("b", 50)];
}
const cohort = () => selectPhysicalEventCohort([...event(1, "soccer"), ...event(2, "soccer"), ...event(3, "tennis"), ...event(4, "soccer"), ...event(5, "soccer")]);

const UNVERSIONED = { modelVersion: VERSION_ABSENT, versionAuthority: { state: "ABSENT", reason: "owner exports ids only" } as const, sourceSha: "sha" };
const SAFE: ModelRef = { modelId: "P50_52_SAFE", ...UNVERSIONED, family: "SAFE_PREMATCH", sportScope: "ALL" };
const TENNIS: ModelRef = { modelId: "TENNIS_P50_52_SAFE", ...UNVERSIONED, family: "SAFE_PREMATCH", sportScope: "tennis" };
const FOOT: ModelRef = { modelId: "FOOTBALL_X", modelVersion: "1.0.0", versionAuthority: { state: "SEMANTIC_VERSION", source: "registry" }, sourceSha: "sha", family: "FOOTBALL_D1", sportScope: "soccer" };
const VERSIONED: ModelRef = { ...FOOT, modelId: "VERSIONED_ALL", sportScope: "ALL" };

const bet = (n: number, side: "a" | "b", observedAt = iso(REF - 1 * H), start = startIn(10), ingestedAt: string | null = iso(REF - 0.5 * H)): ModelBet => ({
  candidateIdentity: `0xe${n}::tok-${n}-${side}::${observedAt}`, conditionId: `0xe${n}`, tokenId: `tok-${n}-${side}`,
  observedAt, eventStart: start, entryPrice: 0.51, modelPhysicalEventKey: `model-key-${n}`, sourceIngestedAt: ingestedAt, claimInstant: ingestedAt ?? observedAt,
});
const evaluated = (bets: ModelBet[], predicate: string[] = [], gate: string[] = []): ModelEvaluation =>
  ({ status: "EVALUATED", bets, predicateEvaluatedTokenKeys: new Set(predicate), gateRejectedTokenKeys: new Set(gate) });
const FOOT_BLOCK: ModelEvaluation = { status: "BLOCKED", reason: "FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT", evidence: "x" };

test("same frozen cohort digest for every model; models cannot mutate it", () => {
  const c = cohort();
  const r = decideCohortModels(c, [SAFE, TENNIS, FOOT], new Map([[modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")])], [modelKey(FOOT), FOOT_BLOCK]]), GEN);
  assert.equal(r.digestBefore, r.digestAfter);
  assert.deepEqual(new Set(Object.values(r.digestByModel)), new Set([r.digestBefore]));
  assert.equal(Object.keys(r.digestByModel).length, 3);
  assert.ok(Object.isFrozen(c.selected[0]));
  const events = new Set(c.selected.map((s) => s.physicalEventId));
  for (const m of [SAFE, TENNIS, FOOT]) assert.deepEqual(new Set(r.decisions.filter((d) => d.modelId === m.modelId).map((d) => d.physicalEventId)), events);
});

test("SKIP requires model-specific evaluation evidence; general source presence alone is BLOCKED", () => {
  const c = cohort();
  const r = decideCohortModels(c, [SAFE, TENNIS, FOOT], new Map<string, ModelEvaluation>([
    [modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")], [tokenKey("0xe5", "tok-5-a")])],
    [modelKey(FOOT), FOOT_BLOCK],
  ]), GEN);
  const get = (m: ModelRef, pid: string) => r.decisions.find((d) => d.modelId === m.modelId && d.physicalEventId === pid)!;
  assert.equal(get(SAFE, "phys-1").outcome, "BET");
  assert.equal(get(SAFE, "phys-1").bet!.tokenId, "tok-1-a");
  assert.deepEqual([get(SAFE, "phys-2").outcome, get(SAFE, "phys-2").reason], ["SKIP", "MODEL_PREDICATE_EVALUATED_NOT_SELECTED"]);
  assert.deepEqual([get(SAFE, "phys-5").outcome, get(SAFE, "phys-5").reason], ["SKIP", "MODEL_GATE_EVALUATED_REJECTED"]);
  // phys-4 HAS a scored source row in the cohort, but this model never evaluated it: not a SKIP.
  assert.ok(c.selected.find((s) => s.physicalEventId === "phys-4")!.inventory.some((t) => t.source));
  assert.deepEqual([get(SAFE, "phys-4").outcome, get(SAFE, "phys-4").reason], ["BLOCKED", "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT"]);
  assert.equal(get(TENNIS, "phys-1").outcome, "NOT_APPLICABLE");
  assert.equal(get(TENNIS, "phys-3").reason, "MODEL_EVALUATION_MISSING");
  assert.equal(get(FOOT, "phys-1").reason, "FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT");
  assert.equal(get(FOOT, "phys-3").outcome, "NOT_APPLICABLE");
  assert.equal(get(SAFE, "phys-1").versionAuthority, "ABSENT");
  const s = summarizeDecisions(r.decisions);
  assert.equal(s.reasons_by_model[modelKey(SAFE)]["SKIP:MODEL_GATE_EVALUATED_REJECTED"], 1);
});

test("the anchor is never inherited: a BET on the opposite token with no own source row is UNPROVEN", () => {
  const c = cohort();
  assert.equal(c.selected.find((s) => s.physicalEventId === "phys-1")!.anchor.tokenId, "tok-1-a");
  const d = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([bet(1, "b")])]]), GEN).decisions.find((x) => x.physicalEventId === "phys-1")!;
  assert.deepEqual([d.outcome, d.reason, d.bet], ["BLOCKED", "UNPROVEN_MODEL_TOKEN_HAS_NO_OWN_SOURCE_ROW", null]);
});

test("first claim per model and event; start contradictions BLOCKED; outside-cohort bets ignored", () => {
  const c = cohort();
  const early = iso(REF - 4 * H);
  const r = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([
    bet(1, "a", iso(REF - 2 * H)), bet(1, "a", early, startIn(10), iso(REF - 3 * H)),
    bet(4, "a", early, startIn(11)),
    { ...bet(99, "a"), conditionId: "0xnot", tokenId: "nope" },
  ])]]), GEN);
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-1")!.bet!.observedAt, early);
  assert.deepEqual(r.uniquenessViolations, [`${modelKey(SAFE)}:phys-1`]);
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-4")!.reason, "MODEL_EVENT_START_CONTRADICTS_COHORT");
  assert.equal(r.outOfCohortBets[modelKey(SAFE)], 1);
});

// OLD FAIL / NEW PASS (PR #536 @ ccae7a2 accepted all three as BET: it timed a pick at observed_at and only required
// ingested_at <= T-90, so a decision could precede the ingest of its own input or be generated after T-90).
test("CAUSALITY: observed_at <= ingested_at <= decision generation < T-90; never backdated to observed_at", () => {
  const c = cohort();
  const decide = (b: ModelBet, gen: number) => decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([b])]]), gen).decisions.find((x) => x.physicalEventId === `phys-${b.conditionId.slice(3)}`)!;
  // Row observed 3h before, ingested 2h before; the decision is claimed generated 2.5h before = before its input existed in the DB.
  const beforeIngest = decide(bet(1, "a", iso(REF - 3 * H), startIn(10), iso(REF - 2 * H)), REF - 2.5 * H);
  assert.deepEqual([beforeIngest.outcome, beforeIngest.reason], ["BLOCKED", "DECISION_BEFORE_SOURCE_INGEST"]);
  // Ingested well before T-90, but the decision is only generated after T-90 (start +1h => T-90 already passed).
  const afterT90 = decide(bet(2, "a", iso(REF - 3 * H), startIn(10), iso(REF - 2 * H)), REF + 9 * H);
  assert.deepEqual([afterT90.outcome, afterT90.reason], ["BLOCKED", "DECISION_GENERATED_AT_OR_AFTER_T90"]);
  // A row whose observation is after its own ingest is impossible availability.
  const inverted = decide(bet(4, "a", iso(REF - 1 * H), startIn(10), iso(REF - 2 * H)), GEN);
  assert.deepEqual([inverted.outcome, inverted.reason], ["BLOCKED", "SOURCE_OBSERVED_AFTER_INGEST"]);
  // NEW PASS: the lawful ordering is a BET, timed at the generation instant, with positive minutes to start.
  const ok = decide(bet(5, "a", iso(REF - 1 * H), startIn(10), iso(REF - 0.5 * H)), GEN);
  assert.equal(ok.outcome, "BET");
  assert.equal(ok.decisionGeneratedAt, iso(GEN));
  assert.equal(ok.bet!.minutesToStartAtDecision, 600);
  assert.equal(causalEdge({ observedAt: iso(REF), sourceIngestedAt: null, claimInstant: iso(REF) }, startIn(10), GEN), "UNPROVEN_MODEL_SOURCE_INGEST_TIME");
  // A claim instant later than the generation instant cannot have produced this decision.
  assert.equal(causalEdge({ observedAt: iso(REF - H), sourceIngestedAt: iso(REF - H), claimInstant: iso(REF + 60_000) }, startIn(10), GEN), "CLAIM_AFTER_DECISION_GENERATION");
});

test("CHRONOLOGY: later-in-the-day observations cannot change, add to or reorder an earlier decision", () => {
  type Row = { id: string; event: string; score: number; observed_at: string; ingested_at: string };
  const rows: Row[] = [
    { id: "late-best", event: "E2", score: 95, observed_at: iso(REF - 1 * H), ingested_at: iso(REF - 0.5 * H) },
    { id: "early", event: "E1", score: 60, observed_at: iso(REF - 5 * H), ingested_at: iso(REF - 4 * H) },
    // observed early but only ingested late: it may not act before its ingest instant
    { id: "early-obs-late-ingest", event: "E3", score: 99, observed_at: iso(REF - 6 * H), ingested_at: iso(REF - 0.25 * H) },
    { id: "impossible", event: "E4", score: 100, observed_at: iso(REF), ingested_at: iso(REF - 1 * H) },
  ];
  // A day-ranked, cap-1 selector (like a tier/score-ordered daily cap): on the full day it would pick the best score.
  const selector = (prefix: readonly Row[]): PrefixSelection<{ candidateIdentity: string; physicalEventKey: string }> => {
    const best = [...prefix].sort((a, b) => b.score - a.score)[0];
    return { picks: new Map([["M", best ? [{ candidateIdentity: best.id, physicalEventKey: best.event }] : []]]), predicateEvaluated: new Map([["M", new Set(prefix.map((r) => r.id))]]), gateRejected: new Map() };
  };
  assert.equal(selector(rows.filter((r) => r.id !== "impossible")).picks.get("M")![0].candidateIdentity, "early-obs-late-ingest"); // whole-day view
  const r = chronologicalClaims(rows, ["M"], 1, selector);
  assert.deepEqual(r.claims.get("M")!.map((c) => [c.candidateIdentity, c.claimInstant]), [["early", iso(REF - 4 * H)]]);
  assert.equal(r.capExhaustedN, 2);
  assert.equal(r.inconsistentAvailabilityN, 1);
  assert.equal(r.instants, 3);
  assert.ok(!r.predicateEvaluated.get("M")!.has("impossible"));
  // Partially spent cap: the selector's rank order wins, not identity order.
  const ranked = chronologicalClaims([{ observed_at: iso(REF - H), ingested_at: iso(REF - H) }], ["M"], 1, () => ({
    picks: new Map([["M", [{ candidateIdentity: "z-best", physicalEventKey: "E9" }, { candidateIdentity: "a-worse", physicalEventKey: "E8" }]]]), predicateEvaluated: new Map(), gateRejected: new Map(),
  }));
  assert.deepEqual(ranked.claims.get("M")!.map((c) => c.candidateIdentity), ["z-best"]);
});

const FEE: TokenFeeScheduleResult = { ok: true, takerRate: 0.01, formulaVersion: "f1" } as unknown as TokenFeeScheduleResult;
const ECON = (m: ModelRef, stakeUsd = 2.5, maxEntryPrice = 0.52) => new Map([[modelKey(m), { stakeUsd, maxEntryPrice, source: "test-only" }]]);

// OLD FAIL / NEW PASS (ccae7a2 returned EXECUTABLE whenever a registry entry existed, measured only under the provisional
// $2.50 / 0.555 cohort benchmark, never the model's own stake/cap/min-order/fee).
test("EXECUTABLE only from the model's OWN full-stake authority; absent authority stays BLOCKED", () => {
  const c = cohort();
  const pick = (m: ModelRef) => decideCohortModels(c, [m], new Map([[modelKey(m), evaluated([bet(1, "a")])]]), GEN).decisions.find((x) => x.outcome === "BET")!;
  const safe = pick(SAFE);
  const unversioned = assessExecution(safe, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(SAFE));
  assert.deepEqual([unversioned.tierReached, unversioned.blockedAt!.reason], ["MODEL_ELIGIBLE", "MODEL_VERSION_AUTHORITY_ABSENT"]);
  const v = pick(VERSIONED);
  const noAuthority = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF);
  assert.equal(noAuthority.researchDiagnostic.executable, true); // the provisional benchmark fills ...
  assert.deepEqual([noAuthority.tierReached, noAuthority.blockedAt!.reason, noAuthority.model], ["MODEL_ELIGIBLE", "MODEL_ECONOMICS_AUTHORITY_ABSENT", null]); // ... but grants nothing
  // Above the MODEL's cap (0.52) but inside the provisional 0.555: not executable for this model.
  const aboveCap = assessExecution(v, book("tok-1-a", 0.53, 1000, REF + 60_000, 1), FEE, REF, ECON(VERSIONED));
  assert.equal(aboveCap.researchDiagnostic.executable, true);
  assert.equal(aboveCap.blockedAt!.reason, "MODEL_FULL_STAKE:NOT_EXECUTABLE_DEPTH_AT_CAP");
  // Model stake too small for the venue minimum order.
  assert.equal(assessExecution(v, book("tok-1-a", 0.5, 1000, REF + 60_000, 10), FEE, REF, ECON(VERSIONED, 2.5)).blockedAt!.reason, "MODEL_FULL_STAKE:NOT_EXECUTABLE_MIN_ORDER_SIZE");
  assert.equal(assessExecution(v, book("tok-1-a", 0.5, 1000), null, REF, ECON(VERSIONED)).blockedAt!.reason, "FEE_UNKNOWN:NOT_FETCHED");
  assert.equal(assessExecution(v, book("tok-1-b", 0.5, 1000), FEE, REF, ECON(VERSIONED)).blockedAt!.reason, "MODEL_TOKEN_BOOK_MISSING");
  assert.equal(assessExecution(v, book("tok-1-a", 0.5, 1000, REF - 1), FEE, REF, ECON(VERSIONED)).blockedAt!.reason, "QUOTE_BEFORE_SOURCE_SNAPSHOT");
  const ok = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(VERSIONED, 7.5, 0.52));
  assert.equal(ok.tierReached, "EXECUTABLE");
  assert.equal(ok.model!.stakeUsd, 7.5);
  assert.equal(ok.model!.shares, 15);
  assert.ok(ok.model!.effectiveCostPerShare! > 0.5);
  assert.equal(ok.blockedAt!.reason, "LIVE_QUEUE_AUTHORIZATION_NOT_INHERITED");
});

const ENV_ALL: PersistenceEnvironment = {
  deployedContractColumnsVerified: true, existingEconomicUnitsByModelId: new Map(), approvedPersistenceRoute: "APPROVED_WRITER", authoritativeStartSource: "OFFICIAL_SOURCE_CONFIRMED_START",
};

test("persistence readiness follows the deployed FORWARD_BET_V1 contract and reports the first failed edge", () => {
  const c = cohort();
  const pick = (m: ModelRef) => decideCohortModels(c, [m], new Map([[modelKey(m), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")])]]), GEN).decisions;
  const v = pick(VERSIONED).find((x) => x.outcome === "BET")!;
  const exec = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(VERSIONED));
  assert.equal(persistenceReadiness(v, exec, ENV_ALL, REF).ready, true);
  const safe = pick(SAFE).find((x) => x.outcome === "BET")!;
  const blocked = persistenceReadiness(safe, assessExecution(safe, book("tok-1-a", 0.5, 1000), FEE, REF), { ...ENV_ALL, approvedPersistenceRoute: null, authoritativeStartSource: null }, REF);
  assert.deepEqual(blocked.failedEdges, ["MODEL_VERSION_AUTHORITY", "EXECUTION_AUTHORITY", "AUTHORITATIVE_EVENT_START", "APPROVED_PERSISTENCE_ROUTE"]);
  // The deployed contract only accepts decision_kind BET.
  const skip = pick(VERSIONED).find((x) => x.outcome === "SKIP")!;
  assert.equal(persistenceReadiness(skip, null, ENV_ALL, REF).firstFailedEdge, "CONTRACT_DECISION_KIND");
  // Observation older than the trigger's 7200s LATE_OR_REPLAY window (with margin), or past T-90: never ready.
  assert.equal(persistenceReadiness(v, exec, ENV_ALL, REF + 1.95 * H).firstFailedEdge, "OBSERVATION_FRESH_FOR_GUARD");
  assert.ok(persistenceReadiness(v, exec, ENV_ALL, REF + 9 * H).failedEdges.includes("BEFORE_T90_AT_CHECK"));
  // Uniqueness is model_id-keyed: an event already held by ANY ledger row of the same model_id (legacy too) is rejected.
  assert.equal(persistenceReadiness(v, exec, { ...ENV_ALL, existingEconomicUnitsByModelId: new Map([[VERSIONED.modelId, new Set(["model-key-1"])]]) }, REF).firstFailedEdge, "ECONOMIC_UNIT_UNCLAIMED_FOR_MODEL_ID");
  // A schedule or unregistered source never stands in for an authoritative start.
  assert.equal(persistenceReadiness(v, exec, { ...ENV_ALL, authoritativeStartSource: "SCHEDULED" }, REF).firstFailedEdge, "AUTHORITATIVE_EVENT_START");
});
