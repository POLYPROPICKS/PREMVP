import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  liveQueueView, measureResearchLiquidity, selectPhysicalEventCohort,
  type InventoryToken, type MeasuredToken, type SourceCandidate,
} from "../../lib/research/executableLiquidityCohortT90";
import {
  assessExecution, buildModelDefinitionManifest, causalEdge, chronologicalClaims, classifyForwardStatus, configurationDigest, decideCohortModels, economicsState,
  FORWARD_CONTRACT, modelKey, modelReadiness, modelVersionOf, persistenceReadiness, sharedDefinitionDigest, sourceRowEdge, summarizeDecisions, tokenKey,
  verifyCommitBinding, versionAuthorityOf, VERSION_UNPROVEN,
  type DefinitionAnalysis, type GitReader, type ModelBet, type ModelEvaluation, type ModelRef, type PersistenceEnvironment, type PrefixSelection,
} from "../../lib/research/forwardModelDecisionsT90";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import type { TokenFeeScheduleResult } from "../../lib/liquidity/polymarketClient";
import { analyzeEffectiveDefinition, buildModels, gitBlobSha, loadSafeDefinitionContext, type DefinitionRoot, type Lockfile } from "../../scripts/research-forward-model-decisions-t90";

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

const UNPROVEN = { modelVersion: VERSION_UNPROVEN, versionAuthority: { state: "UNPROVEN", reason: "definition not proven" } as const, sourceSha: "sha" };
const SAFE: ModelRef = { modelId: "P50_52_SAFE", ...UNPROVEN, family: "SAFE_PREMATCH", sportScope: "ALL" };
const TENNIS: ModelRef = { modelId: "TENNIS_P50_52_SAFE", ...UNPROVEN, family: "SAFE_PREMATCH", sportScope: "tennis" };
const FOOT: ModelRef = { modelId: "FOOTBALL_X", modelVersion: "1.0.0", versionAuthority: { state: "SEMANTIC_VERSION", source: "registry" }, sourceSha: "sha", family: "FOOTBALL_D1", sportScope: "soccer" };
const VERSIONED: ModelRef = { ...FOOT, modelId: "VERSIONED_ALL", sportScope: "ALL" };
const DIGESTED: ModelRef = { modelId: "DIGEST_ALL", modelVersion: "def-sha256:abc", versionAuthority: { state: "DEFINITION_DIGEST", source: "test" }, sourceSha: "sha", family: "SAFE_PREMATCH", sportScope: "ALL" };

const sourceRowFor = (n: number, side: "a" | "b", ingestedAt: string, extra: Partial<NonNullable<ModelBet["sourceRow"]>> = {}): NonNullable<ModelBet["sourceRow"]> =>
  ({ observationId: `obs-${n}`, itemObservationId: `item-${n}-${side}`, ingestedAt, identityRowN: 1, selectorColumnsAgree: true, ...extra });
const bet = (n: number, side: "a" | "b", observedAt = iso(REF - 1 * H), start = startIn(10), ingestedAt: string | null = iso(REF - 0.5 * H)): ModelBet => ({
  candidateIdentity: `0xe${n}::tok-${n}-${side}::${observedAt}`, conditionId: `0xe${n}`, tokenId: `tok-${n}-${side}`,
  observedAt, eventStart: start, entryPrice: 0.51, modelPhysicalEventKey: `model-key-${n}`, sourceIngestedAt: ingestedAt,
  sourceRow: ingestedAt === null ? null : sourceRowFor(n, side, ingestedAt), claimInstant: ingestedAt ?? observedAt,
});
const evaluated = (bets: ModelBet[], predicate: string[] = [], gate: string[] = [], capSpent: string[] = []): ModelEvaluation =>
  ({ status: "EVALUATED", bets, predicateEvaluatedTokenKeys: new Set(predicate), gateRejectedTokenKeys: new Set(gate), capSpentTokenKeys: new Set(capSpent) });
const FOOT_BLOCK: ModelEvaluation = { status: "BLOCKED", reason: "FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT", evidence: "x" };

test("same frozen cohort digest for every model, before AND after each model's evaluation; models cannot mutate it", () => {
  const c = cohort();
  const r = decideCohortModels(c, [SAFE, TENNIS, FOOT], new Map([[modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")])], [modelKey(FOOT), FOOT_BLOCK]]), GEN);
  assert.equal(r.digestBefore, r.digestAfter);
  assert.deepEqual(new Set(Object.values(r.digestByModel)), new Set([r.digestBefore]));
  assert.deepEqual(new Set(Object.values(r.digestBeforeByModel)), new Set([r.digestBefore]));
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
  assert.equal(get(SAFE, "phys-1").versionAuthority, "UNPROVEN");
  const s = summarizeDecisions(r.decisions);
  assert.equal(s.reasons_by_model[modelKey(SAFE)]["SKIP:MODEL_GATE_EVALUATED_REJECTED"], 1);
});

test("SKIP evidence is the model's own: a selection lost only to its spent daily cap is reported as such", () => {
  const c = cohort();
  const d = decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")], [], [tokenKey("0xe2", "tok-2-a")])]]), GEN).decisions.find((x) => x.physicalEventId === "phys-2")!;
  assert.deepEqual([d.outcome, d.reason], ["SKIP", "MODEL_SELECTED_DAILY_CAP_SPENT"]);
  const r = chronologicalClaims([{ observed_at: iso(REF - H), ingested_at: iso(REF - H) }], ["M"], 1, () => ({
    picks: new Map([["M", [{ candidateIdentity: "0xa::t::x", physicalEventKey: "E1" }, { candidateIdentity: "0xb::t::x", physicalEventKey: "E2" }]]]), predicateEvaluated: new Map(), gateRejected: new Map(),
  }));
  assert.deepEqual([...r.capSpentIdentities.get("M")!], ["0xb::t::x"]);
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

// OLD FAIL / NEW PASS (PR #537 @ 769b526 took ingested_at from the LATEST duplicate row and carried no source-row identity, so a
// BET could not name the one row the model selected from and disagreeing duplicates were silently resolved by ingest order).
test("EXACT SOURCE ROW: a BET names the model's own row; missing or ambiguous rows are BLOCKED, agreeing duplicates are exact", () => {
  const c = cohort();
  const decide = (b: ModelBet) => decideCohortModels(c, [SAFE], new Map([[modelKey(SAFE), evaluated([b])]]), GEN).decisions.find((x) => x.physicalEventId === `phys-${b.conditionId.slice(3)}`)!;
  const ing = iso(REF - 0.5 * H);
  const exact = decide(bet(1, "a"));
  assert.equal(exact.outcome, "BET");
  assert.deepEqual([exact.bet!.sourceRow!.observationId, exact.bet!.sourceRow!.itemObservationId], ["obs-1", "item-1-a"]);
  // the cohort's own scored row of that token is a different observation: it is never substituted for the model's row.
  assert.notEqual(exact.bet!.cohortSource.itemObservationId, exact.bet!.sourceRow!.itemObservationId);
  const none = decide({ ...bet(2, "a"), sourceRow: null });
  assert.deepEqual([none.outcome, none.reason], ["BLOCKED", "UNPROVEN_MODEL_SOURCE_ROW"]);
  const ambiguous = decide({ ...bet(2, "a"), sourceRow: sourceRowFor(2, "a", ing, { identityRowN: 2, selectorColumnsAgree: false }) });
  assert.deepEqual([ambiguous.outcome, ambiguous.reason], ["BLOCKED", "MODEL_SOURCE_ROW_AMBIGUOUS"]);
  const agreeing = decide({ ...bet(4, "a"), sourceRow: sourceRowFor(4, "a", ing, { identityRowN: 3, selectorColumnsAgree: true }) });
  assert.equal(agreeing.outcome, "BET");
  const mismatch = decide({ ...bet(5, "a"), sourceRow: sourceRowFor(5, "a", iso(REF - 0.25 * H)) });
  assert.deepEqual([mismatch.outcome, mismatch.reason], ["BLOCKED", "MODEL_SOURCE_ROW_INGEST_MISMATCH"]);
  assert.equal(sourceRowEdge(bet(1, "a")), null);
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
  const unproven = assessExecution(safe, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(SAFE));
  assert.deepEqual([unproven.tierReached, unproven.blockedAt!.reason], ["MODEL_ELIGIBLE", "MODEL_DEFINITION_IDENTITY_UNPROVEN"]);
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
  assert.equal(assessExecution(v, book("tok-1-a", 0.5, 1000, REF - 1), FEE, REF, ECON(VERSIONED)).blockedAt!.reason, "QUOTE_BEFORE_SOURCE_SNAPSHOT");
  const ok = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(VERSIONED, 7.5, 0.52));
  assert.equal(ok.tierReached, "EXECUTABLE");
  assert.equal(ok.model!.stakeUsd, 7.5);
  assert.equal(ok.model!.shares, 15);
  assert.ok(ok.model!.effectiveCostPerShare! > 0.5);
  assert.equal(ok.blockedAt!.reason, "LIVE_QUEUE_AUTHORIZATION_NOT_INHERITED");
  // A proven definition digest is an identity: economics approved for it (keyed by modelId@def-sha256:...) can reach EXECUTABLE.
  const dig = pick(DIGESTED);
  assert.equal(assessExecution(dig, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(DIGESTED, 7.5, 0.52)).tierReached, "EXECUTABLE");
  assert.equal(assessExecution(dig, book("tok-1-a", 0.5, 1000), FEE, REF).blockedAt!.reason, "MODEL_ECONOMICS_AUTHORITY_ABSENT");
});

// NOT a corrected defect: at 769b526 a foreign book already produced null shares / vwap (the sibling-telemetry builder guards by
// token id; probed against that exact SHA). The guard is now local to assessExecution, and no fee/cost is reported for a walk
// that was never taken. Defense in depth only.
test("exact-token book only: a foreign book is never measured or reported; invalid approvals fail closed", () => {
  const c = cohort();
  const v = decideCohortModels(c, [VERSIONED], new Map([[modelKey(VERSIONED), evaluated([bet(1, "a")])]]), GEN).decisions.find((x) => x.outcome === "BET")!;
  const foreign = assessExecution(v, book("tok-1-b", 0.5, 1000), FEE, REF, ECON(VERSIONED));
  assert.equal(foreign.blockedAt!.reason, "MODEL_TOKEN_BOOK_MISSING");
  assert.deepEqual([foreign.model!.state, foreign.model!.shares, foreign.model!.vwap, foreign.model!.effectiveCostPerShare, foreign.model!.executable], ["NO_OWN_TOKEN_BOOK", null, null, null, false]);
  const noProvenance = new Map([[modelKey(VERSIONED), { stakeUsd: 2.5, maxEntryPrice: 0.52, source: "  " }]]);
  assert.equal(economicsState(noProvenance.get(modelKey(VERSIONED))), "INVALID");
  assert.equal(assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, noProvenance).blockedAt!.reason, "MODEL_ECONOMICS_AUTHORITY_INVALID");
  assert.equal(economicsState(undefined), "ABSENT");
  assert.equal(economicsState({ stakeUsd: 2.5, maxEntryPrice: 1, source: "x" }), "INVALID");
});

const ENV_ALL: PersistenceEnvironment = {
  deployedContractColumnsVerified: true, existingEconomicUnitsByModelId: new Map(), approvedPersistenceRoute: "APPROVED_WRITER", authoritativeStartSource: "OFFICIAL_SOURCE_CONFIRMED_START",
};

test("persistence readiness follows the deployed FORWARD_BET_V1 contract and reports the first failed edge", () => {
  const c = cohort();
  const pick = (m: ModelRef) => decideCohortModels(c, [m], new Map([[modelKey(m), evaluated([bet(1, "a")], [tokenKey("0xe2", "tok-2-a")])]]), GEN).decisions;
  const v = pick(VERSIONED).find((x) => x.outcome === "BET")!;
  const exec = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(VERSIONED));
  const ready = persistenceReadiness(v, exec, ENV_ALL, REF);
  assert.equal(ready.ready, true);
  assert.equal(ready.forward.state, "NEW_FORWARD");
  const safe = pick(SAFE).find((x) => x.outcome === "BET")!;
  const blocked = persistenceReadiness(safe, assessExecution(safe, book("tok-1-a", 0.5, 1000), FEE, REF), { ...ENV_ALL, approvedPersistenceRoute: null, authoritativeStartSource: null }, REF);
  // A schedule-only start is insertable under the deployed guard but never VERIFIED: it is not a persistence edge.
  assert.deepEqual(blocked.failedEdges, ["MODEL_DEFINITION_IDENTITY", "EXECUTION_AUTHORITY", "APPROVED_PERSISTENCE_ROUTE"]);
  assert.deepEqual(blocked.verification, { eligible: false, reason: "AUTHORITATIVE_START_NOT_PROVEN_SCHEDULE_ONLY" });
  assert.deepEqual(ready.verification, { eligible: true, reason: null });
  // The deployed contract only accepts decision_kind BET.
  const skip = pick(VERSIONED).find((x) => x.outcome === "SKIP")!;
  assert.equal(persistenceReadiness(skip, null, ENV_ALL, REF).firstFailedEdge, "CONTRACT_DECISION_KIND");
  assert.equal(persistenceReadiness(skip, null, ENV_ALL, REF).forward.state, "NOT_A_BET");
  // Observation older than the trigger's 7200s LATE_OR_REPLAY window (with margin), or past T-90: never ready.
  assert.equal(persistenceReadiness(v, exec, ENV_ALL, REF + 1.95 * H).firstFailedEdge, "OBSERVATION_FRESH_FOR_GUARD");
  assert.ok(persistenceReadiness(v, exec, ENV_ALL, REF + 9 * H).failedEdges.includes("BEFORE_T90_AT_CHECK"));
  // Uniqueness is model_id-keyed: an event already held by ANY ledger row of the same model_id (legacy too) is rejected.
  assert.equal(persistenceReadiness(v, exec, { ...ENV_ALL, existingEconomicUnitsByModelId: new Map([[VERSIONED.modelId, new Set(["model-key-1"])]]) }, REF).firstFailedEdge, "ECONOMIC_UNIT_UNCLAIMED_FOR_MODEL_ID");
  // A schedule or unregistered source never stands in for a registered authoritative start.
  assert.equal(persistenceReadiness(v, exec, { ...ENV_ALL, authoritativeStartSource: "SCHEDULED" }, REF).firstFailedEdge, "AUTHORITATIVE_START_SOURCE_REGISTERED");
  assert.equal(FORWARD_CONTRACT.verifiedFacts.forwardCheck.skipAdmissible, false);
  assert.equal(FORWARD_CONTRACT.verifiedFacts.economicUnitUniqueIndex.includesModelVersion, false);
  assert.equal(FORWARD_CONTRACT.verifiedFacts.modelVersionColumnExists, true);
});

// OLD FAIL / NEW PASS (769b526 had no new-forward vs historical-replay classification or count: a causal BET that the model_id
// already holds, or whose input aged out, appeared only as a persistence-edge failure while still being counted as a BET).
test("NO HISTORICAL REPLAY COUNTS AS A NEW FORWARD BET: claimed, aged and past-T90 BETs are replays; the first claim is irreversible", () => {
  const c = cohort();
  const v = decideCohortModels(c, [VERSIONED], new Map([[modelKey(VERSIONED), evaluated([bet(1, "a")])]]), GEN).decisions.find((x) => x.outcome === "BET")!;
  assert.deepEqual(classifyForwardStatus(v, ENV_ALL, REF), { state: "NEW_FORWARD" });
  const claimed = { ...ENV_ALL, existingEconomicUnitsByModelId: new Map([[VERSIONED.modelId, new Set(["model-key-1"])]]) };
  assert.deepEqual(classifyForwardStatus(v, claimed, REF), { state: "HISTORICAL_REPLAY", reasons: ["ALREADY_CLAIMED_FOR_MODEL_ID"] });
  assert.deepEqual(classifyForwardStatus(v, ENV_ALL, REF + 5 * H), { state: "HISTORICAL_REPLAY", reasons: ["OBSERVATION_AGED_BEYOND_GUARD"] });
  assert.deepEqual(classifyForwardStatus(v, claimed, REF + 9 * H), { state: "HISTORICAL_REPLAY", reasons: ["ALREADY_CLAIMED_FOR_MODEL_ID", "OBSERVATION_AGED_BEYOND_GUARD", "PAST_T90_AT_CHECK"] });
  // The legacy claim stands whether or not the replay would pick the same token.
  const claimToken = (token: string | null | undefined) => persistenceReadiness(v, null, { ...claimed, existingClaimTokensByModelId: new Map([[VERSIONED.modelId, new Map(token === undefined ? [] : [["model-key-1", token] as [string, string | null]])]]) }, REF).existingClaim;
  assert.equal(claimToken("tok-1-a"), "SAME_TOKEN");
  assert.equal(claimToken("tok-1-b"), "DIFFERENT_TOKEN");
  assert.equal(claimToken(null), "TOKEN_UNKNOWN");
  assert.equal(claimToken(undefined), "TOKEN_UNKNOWN");
  assert.equal(persistenceReadiness(v, null, ENV_ALL, REF).existingClaim, "NONE");
  // ready implies a NEW forward claim, never a replay.
  const exec = assessExecution(v, book("tok-1-a", 0.5, 1000), FEE, REF, ECON(VERSIONED));
  for (const env of [ENV_ALL, claimed]) for (const now of [REF, REF + 5 * H]) {
    const r = persistenceReadiness(v, exec, env, now);
    if (r.ready) assert.equal(r.forward.state, "NEW_FORWARD");
  }
});

test("model-level readiness: ordered blockers independent of any BET; SKIP persistence is blocked by the deployed contract", () => {
  const safeEval = evaluated([]);
  const r = modelReadiness(SAFE, safeEval, new Map(), { approvedPersistenceRoute: null });
  assert.deepEqual(r.blockers, ["MODEL_DEFINITION_IDENTITY:definition not proven", "EXECUTION_AUTHORITY:MODEL_ECONOMICS_AUTHORITY_ABSENT", "APPROVED_PERSISTENCE_ROUTE:NONE"]);
  assert.equal(r.firstBlocker, "MODEL_DEFINITION_IDENTITY:definition not proven");
  assert.equal(r.skipPersistence, "BLOCKED_FORWARD_BET_V1_ADMITS_BET_ONLY");
  const proven = modelReadiness(DIGESTED, safeEval, new Map(), { approvedPersistenceRoute: "APPROVED_WRITER" });
  assert.equal(proven.firstBlocker, "EXECUTION_AUTHORITY:MODEL_ECONOMICS_AUTHORITY_ABSENT");
  assert.deepEqual(modelReadiness(DIGESTED, safeEval, ECON(DIGESTED), { approvedPersistenceRoute: "APPROVED_WRITER" }).blockers, []);
  assert.equal(modelReadiness(FOOT, FOOT_BLOCK, new Map(), { approvedPersistenceRoute: "W" }).firstBlocker, "MODEL_INPUT:FOOTBALL_D1_NO_PROSPECTIVE_SETTLEMENT_FREE_INPUT");
});

// ── A. effective-definition manifest ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, types: [], skipLibCheck: true, noEmit: true, allowJs: true };
const FILES = {
  "sel.ts": `import { tier } from "./tiers";\nimport { cap } from "./capital";\nexport function select(x: number) { return tier(x) < 1 ? 1 : 0; }\nexport function unrelated() { return cap(1); }\n`,
  "tiers.ts": `export const LIMIT = 0.52;\nexport function tier(v: number) { return v < LIMIT ? v : LIMIT; }\nexport function other() { return 1; }\n`,
  "capital.ts": `export function cap(n: number) { return n * 2; }\n`,
};
const ROOTS: DefinitionRoot[] = [{ file: "sel.ts", symbol: "select" }];
function analyze(files: Record<string, string>, roots: DefinitionRoot[] = ROOTS, lockfile: Lockfile = { packages: {} }) {
  const root = mkdtempSync(join(tmpdir(), "def-manifest-"));
  for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); }
  const analysis = analyzeEffectiveDefinition({ root, roots, compilerOptions: FIXTURE_OPTIONS, lockfile });
  return { analysis, digest: sharedDefinitionDigest(analysis), root };
}
const names = (a: DefinitionAnalysis) => a.statements.map((s) => `${s.file}:${s.name}`).sort();

// OLD FAIL / NEW PASS (769b526 identified a SAFE model by HEAD + the OWNER file's blob SHA: editing a transitive dependency
// left that identity unchanged, and any unrelated commit changed it).
test("DEFINITION IDENTITY: follows symbols transitively (OLD identity was blind to it) and ignores everything unreferenced", () => {
  const base = analyze(FILES);
  assert.deepEqual(names(base.analysis), ["sel.ts:select", "tiers.ts:LIMIT", "tiers.ts:tier"]);
  assert.ok(!base.analysis.files.some((f) => f.path === "capital.ts"));
  assert.deepEqual(base.analysis.unproven, []);
  const oldIdentity = (files: Record<string, string>) => gitBlobSha(Buffer.from(files["sel.ts"]));
  // transitive edit: the effective definition changed
  const tierEdit = { ...FILES, "tiers.ts": FILES["tiers.ts"].replace("0.52", "0.55") };
  assert.equal(oldIdentity(tierEdit), oldIdentity(FILES)); // OLD: owner blob unchanged => identity unchanged (the defect)
  assert.notEqual(analyze(tierEdit).digest, base.digest); // NEW: identity changes
  assert.notEqual(analyze({ ...FILES, "sel.ts": FILES["sel.ts"].replace("? 1 : 0", "? 2 : 0") }).digest, base.digest);
  // unreferenced code, another module, formatting and comments between statements never change the identity
  assert.equal(analyze({ ...FILES, "tiers.ts": FILES["tiers.ts"].replace("return 1;", "return 99;") }).digest, base.digest);
  assert.equal(analyze({ ...FILES, "capital.ts": "export function cap(n: number) { return n * 3; }\n" }).digest, base.digest);
  assert.equal(analyze({ ...FILES, "tiers.ts": `// header\n\n${FILES["tiers.ts"].replace("export function other", "/** note */\n\n\nexport function other")}` }).digest, base.digest);
  assert.equal(analyze({ ...FILES, "tiers.ts": FILES["tiers.ts"].replace(/\n/g, "\r\n") }).digest, base.digest);
  // line numbers are audit data, never identity
  assert.equal(analyze({ ...FILES, "tiers.ts": `\n\n\n${FILES["tiers.ts"]}` }).digest, base.digest);
});

test("DEFINITION IDENTITY: every unprovable edge keeps the definition UNPROVEN (fail-closed); unreferenced ones do not", () => {
  const withHelper = (helper: string, imports = "") => analyze({
    "sel.ts": `${imports}import { h } from "./helper";\nexport function select() { return h(); }\n`, "helper.ts": helper,
  }, ROOTS).analysis.unproven;
  assert.ok(withHelper(`export function h() { return process.env.X; }\n`).some((r) => r.startsWith("ENVIRONMENT_ACCESS:")));
  assert.ok(withHelper(`export function h() { return process.argv.length; }\n`).some((r) => r.startsWith("PROCESS_STATE_ACCESS:")));
  assert.ok(withHelper(`export function h() { return Date.now(); }\n`).some((r) => r.startsWith("CLOCK_OR_RANDOM_READ:Date.now")));
  assert.ok(withHelper(`export function h() { return new Date().getTime(); }\n`).some((r) => r.startsWith("CLOCK_OR_RANDOM_READ:new Date()")));
  assert.ok(withHelper(`export function h() { return Math.random(); }\n`).some((r) => r.startsWith("CLOCK_OR_RANDOM_READ:Math.random")));
  assert.ok(withHelper(`import { readFileSync } from "node:fs";\nexport function h() { return readFileSync("x", "utf8"); }\n`).some((r) => r.startsWith("FILESYSTEM_OR_NETWORK_IO:")));
  assert.ok(withHelper(`export async function h(n: string) { return (await import(n)).x; }\n`).some((r) => r.startsWith("DYNAMIC_MODULE_LOADING:")));
  assert.ok(withHelper(`export function h() { return eval("1"); }\n`).some((r) => r.startsWith("DYNAMIC_MODULE_LOADING:")));
  // a deterministic `new Date(x)` is not a clock read
  assert.deepEqual(withHelper(`export function h() { return new Date(0).getTime(); }\n`), []);
  // the same reads in code the selector never references prove nothing
  assert.deepEqual(withHelper(`export function h() { return 1; }\nexport function unusedA() { return process.env.X; }\nexport function unusedB() { return Date.now(); }\n`), []);
  // a missing root is itself unproven
  assert.deepEqual(analyze(FILES, [{ file: "sel.ts", symbol: "nope" }]).analysis.unproven, ["ROOT_SYMBOL_NOT_FOUND:sel.ts#nope"]);
  // `if (import.meta.url === process.argv[1] ...) main()` runs only when the module is the process entrypoint
  const guarded = analyze({
    "sel.ts": `import { pathToFileURL } from "node:url";\nexport function select() { return 1; }\nfunction main() { return process.env.X; }\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { main(); }\n`,
  });
  assert.deepEqual(guarded.analysis.unproven, []);
  assert.deepEqual(guarded.analysis.excludedEntrypointGuards, ["sel.ts"]);
  assert.deepEqual(names(guarded.analysis), ["sel.ts:select"]);
});

test("DEFINITION IDENTITY: an unreferenced value computed at module load is not the definition unless it can touch reached state", () => {
  const files = {
    "sel.ts": `import { LIMITS } from "./tiers";\nconst ARGS = process.argv.indexOf("--x");\nexport function select() { return LIMITS.length; }\n`,
    "tiers.ts": `export const LIMITS: number[] = [0.5];\n`,
  };
  const a = analyze(files);
  assert.deepEqual(a.analysis.unproven, []); // a CLI-argument constant nothing reached uses
  assert.deepEqual(names(a.analysis), ["sel.ts:select", "tiers.ts:LIMITS"]);
  // the same module-load call that mutates a reached object IS part of the definition, and so is its process-state access
  const mutating = analyze({ ...files, "sel.ts": files["sel.ts"].replace('const ARGS = process.argv.indexOf("--x");', "const WIDEN = LIMITS.push(0.6);") });
  assert.ok(names(mutating.analysis).includes("sel.ts:WIDEN"));
  assert.notEqual(mutating.digest, a.digest);
  const envWrite = analyze({ ...files, "sel.ts": files["sel.ts"].replace('const ARGS = process.argv.indexOf("--x");', 'process.env.TZ = "UTC";') });
  assert.ok(envWrite.analysis.unproven.some((r) => r.startsWith("ENVIRONMENT_ACCESS:")));
});

test("DEFINITION IDENTITY: module initialisation that can change reached state is part of the definition", () => {
  const files = {
    "sel.ts": `import "./reg";\nimport { LIMITS } from "./tiers";\nexport function select() { return LIMITS.length; }\n`,
    "tiers.ts": `export const LIMITS: number[] = [0.5];\n`,
    "reg.ts": `import { LIMITS } from "./tiers";\nLIMITS.push(0.52);\n`,
  };
  const a = analyze(files);
  assert.ok(a.analysis.statements.some((s) => s.file === "reg.ts" && s.via === "INIT_MUTATOR"));
  assert.notEqual(analyze({ ...files, "reg.ts": files["reg.ts"].replace("0.52", "0.6") }).digest, a.digest);
});

test("DEFINITION IDENTITY: packages are bound by lockfile version and integrity; an unlocked package is unproven", () => {
  const files = {
    "sel.ts": `import { f } from "fakepkg";\nexport function select() { return f(); }\n`,
    "node_modules/fakepkg/package.json": `{"name":"fakepkg","version":"1.2.3","types":"index.d.ts","main":"index.js"}`,
    "node_modules/fakepkg/index.d.ts": `export declare function f(): number;\n`,
    "node_modules/fakepkg/index.js": `exports.f = () => 1;\n`,
  };
  const lock = (version: string): Lockfile => ({ packages: { "node_modules/fakepkg": { version, integrity: `sha512-${version}` } } });
  const a = analyze(files, ROOTS, lock("1.2.3"));
  assert.deepEqual(a.analysis.packages, [{ name: "fakepkg", version: "1.2.3", integrity: "sha512-1.2.3" }]);
  assert.deepEqual(a.analysis.unproven, []);
  assert.notEqual(analyze(files, ROOTS, lock("1.2.4")).digest, a.digest);
  assert.deepEqual(analyze(files, ROOTS, { packages: {} }).analysis.unproven, ["EXTERNAL_PACKAGE_NOT_IN_LOCKFILE:fakepkg"]);
  assert.deepEqual(analyze(files, ROOTS, null).analysis.unproven, ["EXTERNAL_PACKAGE_NOT_IN_LOCKFILE:fakepkg"]);
});

const gitAt = (head: string | null, blobs: Record<string, string>): GitReader => ({ headCommit: () => head, blobAtHead: (p) => blobs[p] ?? null });

test("MANIFEST: PROVEN only when complete, deterministic and bound to the source commit; otherwise VERSION_AUTHORITY_UNPROVEN", () => {
  const { analysis } = analyze(FILES);
  const blobs = Object.fromEntries(analysis.files.map((f) => [f.path, f.blobSha1]));
  const proven = buildModelDefinitionManifest({ modelId: "M1", analysis, configuration: { cap: 30 }, git: gitAt("c0ffee", blobs), runtime: { node: "x" } });
  assert.equal(proven.state, "DEFINITION_DIGEST_PROVEN");
  assert.deepEqual(proven.unprovenReasons, []);
  assert.equal(proven.definitionDigest, proven.observedDigest);
  assert.equal(modelVersionOf(proven), `def-sha256:${proven.definitionDigest}`);
  assert.deepEqual(versionAuthorityOf(proven).state, "DEFINITION_DIGEST");
  assert.equal(proven.commitBinding.sourceCommit, "c0ffee");
  assert.deepEqual(proven.files.map((f) => f.path), ["sel.ts", "tiers.ts"]);
  // models of one shared selector share the shared digest and differ by model id and configuration
  const other = buildModelDefinitionManifest({ modelId: "M2", analysis, configuration: { cap: 30 }, git: gitAt("c0ffee", blobs), runtime: {} });
  const reconf = buildModelDefinitionManifest({ modelId: "M1", analysis, configuration: { cap: 31 }, git: gitAt("c0ffee", blobs), runtime: {} });
  assert.equal(other.sharedDefinitionDigest, proven.sharedDefinitionDigest);
  assert.notEqual(other.definitionDigest, proven.definitionDigest);
  assert.notEqual(reconf.definitionDigest, proven.definitionDigest);
  // the toolchain description and the commit SHA are provenance, not identity
  assert.equal(buildModelDefinitionManifest({ modelId: "M1", analysis, configuration: { cap: 30 }, git: gitAt("other", blobs), runtime: { node: "y" } }).definitionDigest, proven.definitionDigest);
  // a definition file that differs from its blob at the source commit cannot be proven
  const dirty = buildModelDefinitionManifest({ modelId: "M1", analysis, configuration: { cap: 30 }, git: gitAt("c0ffee", { ...blobs, "tiers.ts": "deadbeef" }), runtime: {} });
  assert.equal(dirty.state, "VERSION_AUTHORITY_UNPROVEN");
  assert.deepEqual([dirty.definitionDigest, modelVersionOf(dirty)], [null, VERSION_UNPROVEN]);
  assert.deepEqual(dirty.commitBinding.mismatchedFiles, ["tiers.ts"]);
  assert.ok(dirty.unprovenReasons[0].startsWith("COMMIT_BINDING:DEFINITION_FILES_DIFFER_FROM_SOURCE_COMMIT:tiers.ts"));
  assert.equal(versionAuthorityOf(dirty).state, "UNPROVEN");
  assert.equal(buildModelDefinitionManifest({ modelId: "M1", analysis, configuration: null, git: gitAt(null, blobs), runtime: {} }).commitBinding.reason, "NO_GIT_HEAD");
  assert.equal(verifyCommitBinding(analysis.files, gitAt("c", {})).state, "UNBOUND"); // untracked definition files
  // an analysis that found an unprovable edge is unproven even when committed
  const env = analyze({ ...FILES, "tiers.ts": FILES["tiers.ts"].replace("return v < LIMIT", "return process.env.X ? 0 : v < LIMIT") });
  const envBlobs = Object.fromEntries(env.analysis.files.map((f) => [f.path, f.blobSha1]));
  const envManifest = buildModelDefinitionManifest({ modelId: "M1", analysis: env.analysis, configuration: null, git: gitAt("c", envBlobs), runtime: {} });
  assert.equal(envManifest.state, "VERSION_AUTHORITY_UNPROVEN");
  assert.ok(envManifest.unprovenReasons.some((r) => r.startsWith("ENVIRONMENT_ACCESS:")));
});

test("MANIFEST: a definition that reached nothing is never proven by the absence of evidence", () => {
  const typeOnly = analyze({ ...FILES, "sel.ts": `${FILES["sel.ts"]}export interface Shape { a: number }\n` }, [{ file: "sel.ts", symbol: "Shape" }]);
  assert.equal(typeOnly.analysis.statements.length, 0);
  const m = buildModelDefinitionManifest({ modelId: "M1", analysis: typeOnly.analysis, configuration: null, git: gitAt("c0ffee", {}), runtime: {} });
  assert.equal(m.state, "VERSION_AUTHORITY_UNPROVEN");
  assert.deepEqual([m.definitionDigest, modelVersionOf(m)], [null, VERSION_UNPROVEN]);
  assert.ok(m.unprovenReasons.includes("EMPTY_DEFINITION:NO_REACHED_STATEMENT"));
});

test("CONFIGURATION DIGEST: data values bind the model; a function carries its name only (logic is bound by statements)", () => {
  assert.equal(configurationDigest({ a: 1, b: [2, 3] }), configurationDigest({ b: [2, 3], a: 1 }));
  assert.notEqual(configurationDigest({ a: 1 }), configurationDigest({ a: 2 }));
  assert.equal(configurationDigest({ p: function keep() { return 1; } }), configurationDigest({ p: function keep() { return 2; } }));
  assert.notEqual(configurationDigest({ p: function keep() { return 1; } }), configurationDigest({ p: function other() { return 1; } }));
  assert.notEqual(configurationDigest(new Map([["a", 1]])), configurationDigest(new Map([["a", 2]])));
  assert.equal(configurationDigest(new Set([1, 2])), configurationDigest(new Set([2, 1])));
  assert.equal(configurationDigest(undefined), configurationDigest(null));
});

test("REAL SAFE DEFINITION: the five models resolve to one deterministic, executor-free symbol closure with nothing unprovable", () => {
  const ctx = loadSafeDefinitionContext();
  const again = loadSafeDefinitionContext();
  assert.equal(sharedDefinitionDigest(ctx.analysis), sharedDefinitionDigest(again.analysis));
  assert.deepEqual(ctx.analysis.unproven, []);
  const files = ctx.analysis.files.map((f) => f.path);
  for (const f of ["scripts/modeling/prospective-selection-shadow.ts", "scripts/modeling/daily-portfolio-frontier.ts", "scripts/modeling/factor-atlas.ts", "scripts/modeling/tennis-safe-comparable-leaderboard.ts", "scripts/modeling/quality-fill-portfolio-test.ts", "lib/research-clone/modelReady.ts"]) assert.ok(files.includes(f), f);
  // the capital-replay / executor modules the owner merely imports are NOT part of the selector's definition
  for (const f of ["lib/executor/nightEventReservations.ts", "lib/executor/buildFireModelCandidates.ts", "lib/modeling/dynamicAwareVault.ts"]) assert.ok(!files.includes(f), f);
  assert.ok(ctx.analysis.excludedEntrypointGuards.includes("scripts/modeling/prospective-selection-shadow.ts"));
  const models = buildModels(ctx).filter((m) => m.family === "SAFE_PREMATCH");
  assert.equal(models.length, 5);
  assert.equal(new Set(models.map((m) => m.definition!.sharedDefinitionDigest)).size, 1);
  assert.equal(new Set(models.map((m) => m.definition!.observedDigest)).size, 5);
  // Either proven, or unproven ONLY because the working tree is not at the source commit (e.g. before the checkpoint commit).
  for (const m of models) assert.ok(m.definition!.state === "DEFINITION_DIGEST_PROVEN" || m.definition!.unprovenReasons.every((r) => r.startsWith("COMMIT_BINDING:")), m.modelId);
  for (const m of models) assert.equal(m.modelVersion === VERSION_UNPROVEN, m.versionAuthority.state === "UNPROVEN");
});
