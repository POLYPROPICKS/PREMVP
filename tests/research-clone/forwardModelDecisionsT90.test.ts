import test from "node:test";
import assert from "node:assert/strict";
import {
  liveQueueView, measureResearchLiquidity, selectPhysicalEventCohort,
  type InventoryToken, type MeasuredToken, type SourceCandidate,
} from "../../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, decideCohortModels, modelKey, persistenceReadiness, summarizeDecisions, tokenKey,
  type ModelBet, type ModelEvaluation, type ModelRef, type PersistenceEnvironment,
} from "../../lib/research/forwardModelDecisionsT90";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";

// Fixtures prove decision LOGIC only. They are not evidence of any real cohort, BET, liquidity or persistence.
const REF = Date.parse("2026-10-14T10:00:00.000Z");
const H = 3_600_000;
const startIn = (h: number) => new Date(REF + h * H).toISOString();

const book = (tokenId: string, price: number, size: number, completedAt = REF + 60_000): FetchOrderBookResult => ({
  ok: true, tokenId, latencyMs: 10, requestStartedAtMs: completedAt - 10, responseCompletedAtMs: completedAt,
  book: { tokenId, bids: [], asks: [{ price, size }], tickSize: 0.01, minimumOrderSize: 5, providerTimestampMs: completedAt - 5 },
});
const src = (conditionId: string, tokenId: string, sport: string, start: string): SourceCandidate => ({
  conditionId, tokenId, outcome: "Home", providerEventId: `ev-${conditionId}`, eventStartIso: start, sportFamily: sport, sourceMarketType: "moneyline",
  observationId: "o", itemObservationId: `i-${tokenId}`, observedAt: new Date(REF - 3 * H).toISOString(), ingestedAt: new Date(REF - 2 * H).toISOString(),
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

const SAFE: ModelRef = { modelId: "P50_52_SAFE", modelVersion: "OWNER_UNVERSIONED", family: "SAFE_PREMATCH", sportScope: "ALL" };
const TENNIS: ModelRef = { modelId: "TENNIS_P50_52_SAFE", modelVersion: "OWNER_UNVERSIONED", family: "SAFE_PREMATCH", sportScope: "tennis" };
const FOOT: ModelRef = { modelId: "FOOTBALL_X", modelVersion: "1.0.0", family: "FOOTBALL_D1", sportScope: "soccer" };
const bet = (n: number, side: "a" | "b", decisionTimestamp = new Date(REF - 3 * H).toISOString(), start = startIn(10)): ModelBet => ({
  candidateIdentity: `0xe${n}::tok-${n}-${side}::${decisionTimestamp}`, conditionId: `0xe${n}`, tokenId: `tok-${n}-${side}`,
  decisionTimestamp, eventStart: start, entryPrice: 0.51, modelPhysicalEventKey: `model-key-${n}`, sourceIngestedAt: decisionTimestamp,
});
const evaluated = (bets: ModelBet[], keys: string[]): ModelEvaluation => ({ status: "EVALUATED", bets, evaluatedTokenKeys: new Set(keys), sourceAvailability: "DB_INGESTED_AT_BEFORE_T90" });

test("same frozen cohort for every model; digest identical before/after; models cannot mutate it", () => {
  const c = cohort();
  const evals = new Map<string, ModelEvaluation>([
    [modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe1", "tok-1-a"), tokenKey("0xe2", "tok-2-a"), tokenKey("0xe3", "tok-3-a")])],
    [modelKey(FOOT), { status: "BLOCKED", reason: "FOOTBALL_D1_SOURCE_PATH_NOT_PROSPECTIVE", evidence: "x" }],
  ]);
  const r = decideCohortModels(c, [SAFE, TENNIS, FOOT], evals);
  assert.equal(r.digestBefore, r.digestAfter);
  assert.ok(Object.isFrozen(c.selected[0]));
  const events = new Set(c.selected.map((s) => s.physicalEventId));
  for (const m of [SAFE, TENNIS, FOOT]) assert.deepEqual(new Set(r.decisions.filter((d) => d.modelId === m.modelId).map((d) => d.physicalEventId)), events);
});

test("BET only on the model's own token; SKIP needs a genuinely evaluated candidate, otherwise BLOCKED", () => {
  const c = cohort();
  const r = decideCohortModels(c, [SAFE, TENNIS, FOOT], new Map<string, ModelEvaluation>([
    [modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe1", "tok-1-a"), tokenKey("0xe2", "tok-2-a")])],
    [modelKey(FOOT), { status: "BLOCKED", reason: "FOOTBALL_D1_SOURCE_PATH_NOT_PROSPECTIVE", evidence: "x" }],
  ]));
  const get = (m: ModelRef, pid: string) => r.decisions.find((d) => d.modelId === m.modelId && d.physicalEventId === pid)!;
  assert.equal(get(SAFE, "phys-1").outcome, "BET");
  assert.equal(get(SAFE, "phys-1").bet!.tokenId, "tok-1-a");
  assert.equal(get(SAFE, "phys-2").outcome, "SKIP");
  assert.equal(get(SAFE, "phys-4").outcome, "BLOCKED");
  assert.equal(get(SAFE, "phys-4").reason, "NO_MODEL_SOURCE_CANDIDATE_FOR_EVENT");
  assert.equal(get(TENNIS, "phys-1").outcome, "NOT_APPLICABLE");
  assert.equal(get(TENNIS, "phys-3").reason, "MODEL_EVALUATION_MISSING");
  assert.equal(get(FOOT, "phys-1").reason, "FOOTBALL_D1_SOURCE_PATH_NOT_PROSPECTIVE");
  assert.equal(get(FOOT, "phys-3").outcome, "NOT_APPLICABLE");
});

test("the anchor is never inherited: a BET on the opposite token with no own source row is UNPROVEN, not a copied score", () => {
  const c = cohort();
  assert.equal(c.selected.find((s) => s.physicalEventId === "phys-1")!.anchor.tokenId, "tok-1-a");
  const r = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([bet(1, "b")], [tokenKey("0xe1", "tok-1-b")])]]));
  const d = r.decisions.find((x) => x.physicalEventId === "phys-1")!;
  assert.equal(d.outcome, "BLOCKED");
  assert.equal(d.reason, "UNPROVEN_MODEL_TOKEN_HAS_NO_OWN_SOURCE_ROW");
  assert.equal(d.bet, null);
});

test("chronological first claim per model and event; late decisions and start contradictions are BLOCKED; outside-cohort bets ignored", () => {
  const c = cohort();
  const early = new Date(REF - 4 * H).toISOString();
  const r = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([
    bet(1, "a", new Date(REF - 2 * H).toISOString()), bet(1, "a", early),
    bet(2, "a", startIn(9)),               // after T-90 of a +10h start
    bet(4, "a", early, startIn(11)),        // start contradicts cohort
    { ...bet(99, "a"), conditionId: "0xnot", tokenId: "nope" },
  ], [])]]));
  const d1 = r.decisions.find((x) => x.physicalEventId === "phys-1")!;
  assert.equal(d1.bet!.decisionTimestamp, early);
  assert.deepEqual(r.uniquenessViolations, ["P50_52_SAFE@OWNER_UNVERSIONED:phys-1"]);
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-2")!.reason, "MODEL_DECISION_AFTER_T90");
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-4")!.reason, "MODEL_EVENT_START_CONTRADICTS_COHORT");
  assert.equal(r.outOfCohortBets[modelKey(SAFE)], 1);
  assert.equal(summarizeDecisions(r.decisions).outcomes_by_model[modelKey(SAFE)].BET, 1);
});

const FEE: TokenFeeScheduleResult = { ok: true, takerRate: 0, formulaVersion: "f1" } as unknown as TokenFeeScheduleResult;
const ENV_ALL: PersistenceEnvironment = { cloneWriteCapability: true, deployedContractVerified: true, ledgerEncodesModelVersion: true, authoritativeStartSource: "APPROVED_START" };

test("execution stops at the first missing authority; unknown economics never becomes EXECUTABLE or LIVE_QUEUE", () => {
  const c = cohort();
  const d = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([bet(1, "a")], [])]])).decisions.find((x) => x.outcome === "BET")!;
  const ok = assessExecution(d, book("tok-1-a", 0.5, 1000), FEE, REF);
  assert.equal(ok.tierReached, "RESEARCH_SAMPLE_ELIGIBLE");
  assert.deepEqual(ok.blockedAt, { tier: "EXECUTABLE", reason: "MODEL_ECONOMICS_AUTHORITY_ABSENT" });
  assert.equal(ok.research.stakeUsd, 2.5); assert.equal(ok.researchContractProvisional, true); assert.equal(ok.liveQueue, "NOT_EVALUATED_NO_AUTHORITY");
  assert.equal(assessExecution(d, book("tok-1-a", 0.6, 1000), FEE, REF).blockedAt!.reason, "RESEARCH_BOOK:BLOCKED_DEPTH_AT_LIMIT");
  assert.equal(assessExecution(d, book("tok-1-a", 0.5, 1000), null, REF).blockedAt!.reason, "FEE_UNKNOWN:NOT_FETCHED");
  // Wrong token book is never accepted for the model's token.
  assert.equal(assessExecution(d, book("tok-1-b", 0.5, 1000), FEE, REF).research.state, "UNKNOWN_BOOK_MISSING");
  const withEconomics = assessExecution(d, book("tok-1-a", 0.5, 1000), FEE, REF, new Map([[modelKey(SAFE), { stakeUsd: 2.5, maxEntryPrice: 0.52, source: "test" }]]));
  assert.equal(withEconomics.tierReached, "EXECUTABLE");
  assert.equal(withEconomics.blockedAt!.reason, "LIVE_QUEUE_AUTHORIZATION_NOT_INHERITED");
});

test("persistence readiness is fail-closed and reports the first failed edge in provenance order", () => {
  const c = cohort();
  const obs = new Date(REF - 0.5 * H).toISOString();
  const d = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([bet(1, "a", obs)], [])]])).decisions.find((x) => x.outcome === "BET")!;
  const sample = assessExecution(d, book("tok-1-a", 0.5, 1000), FEE, REF);
  const blocked = persistenceReadiness(d, sample, { cloneWriteCapability: false, deployedContractVerified: false, ledgerEncodesModelVersion: false, authoritativeStartSource: null }, REF);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.firstFailedEdge, "EXECUTION_AUTHORITY");
  assert.deepEqual(blocked.failedEdges, ["EXECUTION_AUTHORITY", "AUTHORITATIVE_EVENT_START", "LEDGER_ENCODES_MODEL_VERSION", "DEPLOYED_CONTRACT_VERIFIED", "CLONE_WRITE_CAPABILITY"]);
  const exec = assessExecution(d, book("tok-1-a", 0.5, 1000), FEE, REF, new Map([[modelKey(SAFE), { stakeUsd: 2.5, maxEntryPrice: 0.52, source: "test" }]]));
  assert.equal(persistenceReadiness(d, exec, ENV_ALL, REF).ready, true);
  // Older than the guard's 2h LATE_OR_REPLAY window, or past T-90: never ready.
  assert.equal(persistenceReadiness(d, exec, ENV_ALL, REF + 2 * H).firstFailedEdge, "OBSERVATION_FRESH_FOR_GUARD");
  assert.ok(persistenceReadiness(d, exec, ENV_ALL, REF + 9 * H).failedEdges.includes("BEFORE_T90_AT_CHECK"));
  const skip = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([], [tokenKey("0xe2", "tok-2-a")])]])).decisions.find((x) => x.outcome === "SKIP")!;
  assert.equal(persistenceReadiness(skip, null, ENV_ALL, REF).firstFailedEdge, "NOT_A_BET");
});

test("a pick is causal only if the DB possessed the model's own row at/before T-90", () => {
  const c = cohort();
  const late = { ...bet(1, "a"), sourceIngestedAt: startIn(9) };
  const unknown = { ...bet(2, "a"), sourceIngestedAt: null };
  const r = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([late, unknown], [])]]));
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-1")!.reason, "MODEL_SOURCE_INGESTED_AFTER_T90");
  assert.equal(r.decisions.find((x) => x.physicalEventId === "phys-2")!.reason, "UNPROVEN_MODEL_SOURCE_INGEST_TIME");
});
