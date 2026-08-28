import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPrimaryCandidateLoop,
  selectCanonicalPrimaryExtras,
  createPrimaryLoopBudgetGuard,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
  PRIMARY_SCORER_PROVEN_CAPACITY,
  type CandidateMarket,
  type PrimaryCandidateLoopParams,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair } from "../../lib/feed/types";

// MISSION: DECOUPLE_PRIMARY_SEMANTIC_EVALUATION_FROM_PUBLIC_FEED_CAP
//
// Invariant under test:
//   PUBLIC_FEED_COUNT <= 15   AND   SEMANTIC_QUALIFIED_COUNT can be > 15
//
// `evaluateFullPrimaryPopulation:false` must stay byte-identical to the legacy
// loop (public cap stops semantic evaluation, remaining candidates get
// PRIMARY_NOT_EVALUATED_PRODUCT_CAP_REACHED). `true` keeps the public feed
// bounded to `limit` but runs the full semantic gate chain for the whole bounded
// population, so a candidate beyond public rank `limit` receives a real terminal
// reason and lands in `canonicalPrimaryPairs`.
//
// Run: node --import tsx --test tests/feed/primaryPopulationDecoupling.test.ts

// ── Deterministic fakes — the injected deps make the loop pure ────────────────
type Outcome = "QUALIFY" | "PRE_REJECT" | "ENRICH_NULL" | "COVERAGE_FAIL" | "WINPROB_FAIL";

function candidate(i: number, outcome: Outcome = "QUALIFY"): CandidateMarket {
  const id = `c-${String(i).padStart(3, "0")}`;
  return {
    event: { id: `evt-${id}`, title: id, markets: [] } as unknown as CandidateMarket["event"],
    market: {
      id: `mkt-${id}`,
      conditionId: `cond-${id}`,
      question: `${id}?`,
      slug: `slug-${id}`,
    } as unknown as CandidateMarket["market"],
    rejectionReasons: outcome === "PRE_REJECT" ? ["pre-enrichment reject"] : [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
    // stash the desired outcome so the fake enrich/generate deps can act on it
    sportsMatchedKeyword: outcome,
  };
}

function makeParams(
  candidates: CandidateMarket[],
  opts: {
    limit?: number;
    evaluateFullPrimaryPopulation: boolean;
    collectResearchSnapshots?: boolean;
    budgetGuard?: PrimaryCandidateLoopParams["budgetGuard"];
  },
): PrimaryCandidateLoopParams {
  const minDataCoverage = 40; // preserved threshold — unchanged in this mission
  return {
    candidates,
    limit: opts.limit ?? 15,
    minDataCoverage,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: opts.evaluateFullPrimaryPopulation,
    budgetGuard:
      opts.budgetGuard ??
      ({ isExhausted: () => false, elapsedMs: () => 0, budgetMs: PRIMARY_LOOP_DEFAULT_BUDGET_MS } as PrimaryCandidateLoopParams["budgetGuard"]),
    collectResearchSnapshots: opts.collectResearchSnapshots ?? true,
    // legacy loop continues past the public cap only while research is still
    // collecting — keep it "never full" so PRODUCT_CAP_REACHED is observable.
    isResearchCapReached: () => false,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel: {
      candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0,
      attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0,
      rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0,
      rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0,
      execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
    },
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async (_event, market) => {
        const key = String(market.id).replace("mkt-", "");
        const outcome = OUTCOME_BY_KEY.get(key) ?? "QUALIFY";
        if (outcome === "ENRICH_NULL") return null;
        const dataCoverage = outcome === "COVERAGE_FAIL" ? 10 : 80;
        return {
          diagnostics: { dataCoverage, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
          __outcome: outcome,
        } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string; __outcome: Outcome };
        const winProbability = e.__outcome === "WINPROB_FAIL" ? 40 : 70;
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability, time: "3h" },
          marketSource: { headline: e.__key },
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}` },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };
}

// Per-candidate desired outcome, keyed by the market id suffix.
const OUTCOME_BY_KEY = new Map<string, Outcome>();
function seedOutcomes(candidates: CandidateMarket[]) {
  OUTCOME_BY_KEY.clear();
  for (const c of candidates) {
    OUTCOME_BY_KEY.set(String(c.market.id).replace("mkt-", ""), (c.sportsMatchedKeyword as Outcome) ?? "QUALIFY");
  }
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

// ── A + C: legacy behaviour is unchanged (public cap DOES suppress evaluation) ─
test("legacy (flag off): public cap stops semantic evaluation — PRODUCT_CAP_REACHED past rank 15", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(i));
  seedOutcomes(candidates);
  const params = makeParams(candidates, { evaluateFullPrimaryPopulation: false });

  const r = await runPrimaryCandidateLoop(params);

  assert.equal(r.publicPairs.length, 15, "PUBLIC_OUTPUT_COUNT");
  assert.equal(r.canonicalPrimaryPairs.length, 15, "no canonical qualification beyond the public cap in legacy mode");
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 15);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_NOT_EVALUATED_PRODUCT_CAP_REACHED, 5);
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered, "conservation");
  assert.equal(r.primaryCandidatesEntered, 20);
});

// ── B + C: decoupled — public bounded, semantic population > 15, no cap reason ─
test("decoupled (flag on): PUBLIC_OUTPUT_COUNT <= 15 AND SEMANTIC_QUALIFIED_COUNT > 15", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(i));
  seedOutcomes(candidates);
  const params = makeParams(candidates, { evaluateFullPrimaryPopulation: true });

  const r = await runPrimaryCandidateLoop(params);

  const PUBLIC_OUTPUT_COUNT = r.publicPairs.length;
  const SEMANTIC_QUALIFIED_COUNT = r.canonicalPrimaryPairs.length;

  assert.equal(PUBLIC_OUTPUT_COUNT, 15, "public presentation limit preserved");
  assert.ok(PUBLIC_OUTPUT_COUNT <= 15);
  assert.equal(SEMANTIC_QUALIFIED_COUNT, 20, "every qualified candidate is materialized, not just the first 15");
  assert.ok(SEMANTIC_QUALIFIED_COUNT > 15);

  // C: PRODUCT_CAP_REACHED never stamped merely because the public feed is full.
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_NOT_EVALUATED_PRODUCT_CAP_REACHED, undefined);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 20);

  // a candidate beyond public rank 15 got a real qualification.
  const publicIds = new Set(r.publicPairs.map((p) => p.id));
  const beyond = r.canonicalPrimaryPairs.filter((p) => !publicIds.has(p.id));
  assert.equal(beyond.length, 5);
  assert.ok(beyond.every((p) => p.id.startsWith("pair-c-")));

  // conservation with a real, distinct qualification bucket.
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, 20);
});

// ── conservation with distinct terminal buckets, still public <= 15 ───────────
test("decoupled: mixed outcomes conserve into distinct buckets; public stays bounded", async () => {
  const plan: Outcome[] = [
    ...Array.from({ length: 18 }, () => "QUALIFY" as Outcome), // > 15 qualify
    "PRE_REJECT", "ENRICH_NULL", "COVERAGE_FAIL", "WINPROB_FAIL",
  ];
  const candidates = plan.map((o, i) => candidate(i, o));
  seedOutcomes(candidates);
  const r = await runPrimaryCandidateLoop(makeParams(candidates, { evaluateFullPrimaryPopulation: true }));

  assert.equal(r.publicPairs.length, 15);
  // COVERAGE_FAIL (dataCoverage 10) is now diagnostic-only: it continues to the
  // pair/model gates and qualifies here (fake pair passes) -> 19 qualified.
  assert.equal(r.canonicalPrimaryPairs.length, 19);
  const c = r.primaryTerminalReasonCounts;
  assert.equal(c.PRIMARY_QUALIFIED, 19);
  assert.equal(c.PRIMARY_PRE_ENRICHMENT_CANDIDATE_REJECTED, 1);   // enrichment/pre failure
  assert.equal(c.PRIMARY_ENRICHMENT_NULL, 1);                     // enrichment failure
  assert.equal(c.PRIMARY_REJECTED_DATA_COVERAGE_BELOW_THRESHOLD, undefined); // no longer a terminal reason
  assert.equal(c.PRIMARY_REJECTED_WIN_PROBABILITY_BELOW_52, 1);   // pair/model rejection
  assert.equal(c.PRIMARY_NOT_EVALUATED_PRODUCT_CAP_REACHED, undefined);
  assert.equal(sum(c), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, 22);
  // coverage value still observed / preserved for diagnostics
  assert.deepEqual(r.primaryCoverageRejectionValues, [10]);
});

// ── D: the wall-clock guard still fires inside the decoupled loop ─────────────
test("decoupled: wall-clock guard still bounds the loop; excluded candidates keep the budget reason", async () => {
  let calls = 0;
  const budgetGuard = {
    isExhausted: () => calls++ >= 5, // trips after opening 5 candidates
    elapsedMs: () => 0,
    budgetMs: PRIMARY_LOOP_DEFAULT_BUDGET_MS,
  } as PrimaryCandidateLoopParams["budgetGuard"];

  const candidates = Array.from({ length: 40 }, (_, i) => candidate(i));
  seedOutcomes(candidates);
  const r = await runPrimaryCandidateLoop(
    makeParams(candidates, { evaluateFullPrimaryPopulation: true, budgetGuard }),
  );

  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 5);
  assert.equal(
    r.primaryTerminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON],
    35,
  );
  assert.equal(PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON, "PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET");
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, 40);
});

// ── D: 360s budget + [1s,30min] clamp are untouched ──────────────────────────
test("wall-clock budget default is still 360s and the clamp window is unchanged", () => {
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, 6 * 60_000); // 360s
  assert.equal(createPrimaryLoopBudgetGuard({ startedAtMs: 0, budgetMs: 1 }).budgetMs, 1_000);
  assert.equal(
    createPrimaryLoopBudgetGuard({ startedAtMs: 0, budgetMs: 999 * 60_000 }).budgetMs,
    30 * 60_000,
  );
  assert.equal(PRIMARY_SCORER_PROVEN_CAPACITY, 254); // primary population ceiling preserved
});

// ── canonical persistence selection: rank > 15 rows are the ones to ADD ───────
test("selectCanonicalPrimaryExtras returns exactly the qualified outcomes beyond the public selection", () => {
  const pair = (n: number): LandingCardPair =>
    ({ id: `pair-${n}`, diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}` } } as unknown as LandingCardPair);

  const primaryQualified = Array.from({ length: 20 }, (_, i) => pair(i));
  const publicSelection = primaryQualified.slice(0, 15);

  const extras = selectCanonicalPrimaryExtras(primaryQualified, publicSelection);
  assert.equal(extras.length, 5);
  assert.deepEqual(extras.map((p) => p.id), ["pair-15", "pair-16", "pair-17", "pair-18", "pair-19"]);

  // idempotent identity dedupe + missing-identity rows are never dropped
  const noIdentity = { id: "pair-x", diagnostics: {} } as unknown as LandingCardPair;
  const extras2 = selectCanonicalPrimaryExtras(
    [...primaryQualified, primaryQualified[16], noIdentity],
    publicSelection,
  );
  assert.equal(extras2.filter((p) => p.id === "pair-16").length, 1);
  assert.ok(extras2.some((p) => p.id === "pair-x"));
});
