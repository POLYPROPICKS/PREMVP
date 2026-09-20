import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runPrimaryCandidateLoop,
  createPrimaryLoopBudgetGuard,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
  type CandidateMarket,
  type PrimaryCandidateLoopParams,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair, ResearchFunnelCounters } from "../../lib/feed/types";

// MISSION: EXPOSE_PRIMARY_LOOP_TERMINAL_ATTRIBUTION_IN_MONEY_PRODUCER_DIAGNOSTICS
//
// runPrimaryCandidateLoop() already computes primaryCandidatesEntered,
// primaryTerminalReasonCounts and primaryLoopBudgetExhausted on every run,
// unconditional on collectResearchSnapshots, and returns them on its own
// result object. buildLandingCards() copies those values onto its internal
// `rf` (ResearchFunnelCounters) after awaiting the loop, but used to attach
// `rf` to its OWN return value only when `collectResearchSnapshots` was
// true — the canonical money producer (scripts/generate-signals.ts) always
// calls buildLandingCards with `collectResearchSnapshots: producerMode ===
// "research"` (false for money runs), so `result.researchFunnel` — and
// therefore `diagnostics.researchFunnel` persisted to job_runs — was always
// null on the money path, even though the underlying counters were already
// correct.
//
// This test proves two things:
//   1. (behavioral, via the real runPrimaryCandidateLoop) the already-computed
//      attribution — including a real budget-exhausted fixture where
//      PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET > 0 and already-started
//      work is not interrupted — is correct and conserves exactly regardless
//      of collectResearchSnapshots, since the loop never reads that flag to
//      decide whether to compute these particular counters.
//   2. (source-guard) buildLandingCards()'s return sites attach `researchFunnel`
//      unconditionally (not gated behind `collectResearchSnapshots`), and
//      generate-signals.ts still reads it from the same canonical field into
//      job diagnostics — so the fix survives the money-producer boundary.
//
// No scoring, ranking, eligibility, budget value, discovery population,
// persistence, or serving semantics are touched by this test or the change
// it verifies.
//
// Run: node --import tsx --test tests/feed/primaryLoopDiagnosticsSurviveMoneyProducer.test.ts

function candidate(i: number): CandidateMarket {
  const id = `c-${String(i).padStart(4, "0")}`;
  return {
    event: { id: `evt-${id}`, title: id, markets: [] } as unknown as CandidateMarket["event"],
    market: {
      id: `mkt-${id}`,
      conditionId: `cond-${id}`,
      question: `${id}?`,
      slug: `slug-${id}`,
    } as unknown as CandidateMarket["market"],
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
  };
}

function freshResearchFunnel(): ResearchFunnelCounters {
  return {
    candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0,
    attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0,
    rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0,
    rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0,
    execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
  };
}

/** Deterministic fake clock, mirroring tests/feed/primaryLoopWallClockGuard.test.ts. */
function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

test("real runPrimaryCandidateLoop: primary attribution is populated and conserves with collectResearchSnapshots=false (the money-producer setting)", async () => {
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(i));
  const clock = fakeClock();
  // Budget wide enough that nothing is exhausted here — this run isolates the
  // "does the attribution survive with collectResearchSnapshots:false" question.
  const budgetGuard = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 60_000, now: clock.now });
  const researchFunnel = freshResearchFunnel();

  const params: PrimaryCandidateLoopParams = {
    candidates,
    limit: 15,
    minDataCoverage: 40,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard,
    collectResearchSnapshots: false, // <- exactly the canonical money-producer setting
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel,
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      // conditionId must match `candidate.market.conditionId` (`cond-<key>`) —
      // the loop's post-generation identity-match gate compares the two and
      // rejects on mismatch (PRIMARY_REJECTED_IDENTITY_MISMATCH), independent
      // of the attribution this test is verifying.
      enrichMarket: async (_event, market) => {
        const key = String(market.id).replace("mkt-", "");
        return {
          diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
        } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string };
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          marketSource: { headline: e.__key },
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}` },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };

  const r = await runPrimaryCandidateLoop(params);

  // These are exactly the values buildLandingCards() copies onto `rf`
  // (rf.primaryCandidatesEntered = primaryLoop.primaryCandidatesEntered, etc.,
  // see buildLandingCards.ts) immediately after awaiting this call — the
  // computation itself has never depended on collectResearchSnapshots.
  assert.equal(r.primaryCandidatesEntered, 30);
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 30);
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered, "conservation");
  assert.equal(r.primaryLoopBudgetExhausted, false);
  // researchFunnel itself is untouched by the loop (buildLandingCards copies
  // primaryLoop.* onto it afterward) — sanity-check it wasn't silently mutated.
  assert.equal(researchFunnel.primaryCandidatesEntered, undefined);
});

test("real runPrimaryCandidateLoop: budget-exhausted fixture attributes the tail to PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET, in-flight work is not interrupted, and it survives with collectResearchSnapshots=false", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate(i));
  const clock = fakeClock();
  // 5s/event against a 12s budget: 2 events open (0s and 5s elapsed, both start
  // before the 12s boundary), the 3rd check trips the guard at 10s-vs-later
  // check timing below. We assert on the resulting counts rather than hardcode
  // the exact opened count twice, to keep the fixture deterministic but not
  // over-specified.
  const perEventLatencyMs = 5_000;
  const budgetGuard = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 12_000, now: clock.now });
  const researchFunnel = freshResearchFunnel();

  const params: PrimaryCandidateLoopParams = {
    candidates,
    limit: 15,
    minDataCoverage: 40,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard,
    collectResearchSnapshots: false, // <- exactly the canonical money-producer setting
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel,
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async (_event, market) => {
        // Simulate real per-event wall-clock cost. Once a candidate's
        // enrichment has STARTED it always completes (already-started work is
        // never interrupted) — the guard is only consulted before opening the
        // NEXT candidate.
        clock.advance(perEventLatencyMs);
        const key = String(market.id).replace("mkt-", "");
        return {
          diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
        } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string };
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          marketSource: { headline: e.__key },
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}` },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: () => null,
      captureResearchSnapshot: async () => {},
    },
  };

  const r = await runPrimaryCandidateLoop(params);

  const budgetExcluded = r.primaryTerminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON] ?? 0;

  assert.equal(r.primaryCandidatesEntered, 20, "every candidate is attributed exactly once, evaluated or not");
  assert.ok(budgetExcluded > 0, "some candidates were excluded by the wall-clock budget");
  assert.ok(
    (r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED ?? 0) > 0,
    "at least one candidate that started before the budget tripped completed normally",
  );
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered, "conservation");
  assert.equal(r.primaryLoopBudgetExhausted, true);

  // researchFunnel itself is untouched by the loop (buildLandingCards copies
  // primaryLoop.* onto it afterward, unconditionally — see the source-guard
  // test below) — sanity-check it wasn't silently mutated here.
  assert.equal(researchFunnel.primaryCandidatesEntered, undefined);
  assert.equal(
    PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
    "PRIMARY_NOT_EVALUATED_DUE_TO_PRIMARY_LOOP_BUDGET",
  );
});

// ── Source-guard: the money-producer boundary itself ──────────────────────────

const BUILD_LANDING_CARDS_SRC = readFileSync(
  join(__dirname, "../../lib/feed/buildLandingCards.ts"),
  "utf8",
);
const GENERATE_SIGNALS_SRC = readFileSync(
  join(__dirname, "../../scripts/generate-signals.ts"),
  "utf8",
);

test("buildLandingCards() attaches researchFunnel unconditionally (not gated behind collectResearchSnapshots)", () => {
  // Every return site must contain a bare `researchFunnel: rf,` that is NOT
  // itself inside the `...(collectResearchSnapshots ? { ... } : {})` spread —
  // i.e. `researchFunnel` must not appear as a key inside any such ternary.
  const gatedSpreads = [
    ...BUILD_LANDING_CARDS_SRC.matchAll(/collectResearchSnapshots \? \{([^}]*)\} : \{\}/g),
  ];
  assert.ok(gatedSpreads.length >= 4, "expected the known collectResearchSnapshots-gated return spreads");
  for (const m of gatedSpreads) {
    assert.ok(
      !/researchFunnel/.test(m[1]),
      "researchFunnel must not be nested inside a collectResearchSnapshots-gated spread",
    );
  }

  const unconditionalOccurrences = BUILD_LANDING_CARDS_SRC.match(/^\s*researchFunnel: rf,\s*$/gm) ?? [];
  assert.ok(
    unconditionalOccurrences.length >= 4,
    `expected researchFunnel: rf, to appear unconditionally at every return site, found ${unconditionalOccurrences.length}`,
  );
});

test("generate-signals.ts (canonical money producer) still persists result.researchFunnel into job diagnostics under the existing field name", () => {
  assert.ok(
    /diagnostics\s*=\s*\{[\s\S]*?researchFunnel:\s*result\.researchFunnel\s*\?\?\s*null/.test(GENERATE_SIGNALS_SRC),
    "expected the existing diagnostics.researchFunnel = result.researchFunnel ?? null assignment to be reused, not duplicated",
  );
});

// ── Aggregate physical-event attribution under the loop budget ────────────────

test("real runPrimaryCandidateLoop: physical-event budget attribution (opened-only / straddling / fully skipped) conserves, identity count unchanged", async () => {
  // Physical events: A = c0,c1 (opened), B = c2,c3 (c2 opened, c3 skipped),
  // C = c4,c5 (every identity skipped). 5s/open vs 12s budget => c0,c1,c2 open.
  const eventOf = ["A", "A", "B", "B", "C", "C"];
  const candidates = eventOf.map((ev, i) => {
    const c = candidate(i);
    (c.event as unknown as { id: string }).id = `EV-${ev}`;
    return c;
  });
  const clock = fakeClock();
  const budgetGuard = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 12_000, now: clock.now });

  const r = await runPrimaryCandidateLoop({
    candidates,
    limit: 15,
    minDataCoverage: 40,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard,
    collectResearchSnapshots: false,
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel: freshResearchFunnel(),
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async (_event, market) => {
        clock.advance(5_000);
        const key = String(market.id).replace("mkt-", "");
        return {
          diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
        } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string };
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          marketSource: { headline: e.__key },
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}` },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: (c) => (c.event as unknown as { id: string }).id,
      captureResearchSnapshot: async () => {},
    },
  });

  // Identity level: unchanged meaning (3 opened, 3 skipped).
  assert.equal(r.primaryTerminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON], 3);
  assert.equal(r.primaryCandidatesEntered, 6);
  // Event level.
  assert.equal(r.primaryDistinctPhysicalEventsEntered, 3);
  assert.equal(r.primaryLoopBudgetExcludedPhysicalEvents, 2, "B (straddling) + C (fully skipped)");
  assert.equal(r.primaryLoopBudgetFullyExcludedPhysicalEvents, 1, "C");
  assert.equal(r.primaryLoopBudgetPartiallyExcludedPhysicalEvents, 1, "B");
  assert.equal(
    r.primaryLoopBudgetExcludedPhysicalEvents,
    r.primaryLoopBudgetFullyExcludedPhysicalEvents + r.primaryLoopBudgetPartiallyExcludedPhysicalEvents,
  );
});

test("buildLandingCards() publishes the physical-event budget counters onto rf unconditionally (money-producer boundary)", () => {
  for (const f of [
    "primaryDistinctPhysicalEventsEntered",
    "primaryLoopBudgetExcludedPhysicalEvents",
    "primaryLoopBudgetFullyExcludedPhysicalEvents",
    "primaryLoopBudgetPartiallyExcludedPhysicalEvents",
    "primaryDistinctPhysicalEventsOpened",
  ]) {
    assert.ok(new RegExp(String.raw`rf\.${f}\s*=\s*primaryLoop\.${f}`).test(BUILD_LANDING_CARDS_SRC), f);
  }
});

// ── PRIMARY_SCORER_EVENT_FAIR_SCHEDULING_V1: opened-events telemetry ──────────

test("real runPrimaryCandidateLoop: primaryDistinctPhysicalEventsOpened equals exactly the keyed physical events that started evaluation", async () => {
  // A = c0,c1 (opened), B = c2,c3 (c2 opened, c3 skipped), C = c4,c5 (skipped).
  const eventOf = ["A", "A", "B", "B", "C", "C"];
  const candidates = eventOf.map((ev, i) => {
    const c = candidate(i);
    (c.event as unknown as { id: string }).id = `EV-${ev}`;
    return c;
  });
  const clock = fakeClock();
  const budgetGuard = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 12_000, now: clock.now });

  const r = await runPrimaryCandidateLoop({
    candidates,
    limit: 15,
    minDataCoverage: 40,
    excludeEnded: true,
    evaluateFullPrimaryPopulation: true,
    budgetGuard,
    collectResearchSnapshots: false,
    isResearchCapReached: () => true,
    pinnedKeysForPersistCheck: new Set<string>(),
    rejected: [],
    researchFunnel: freshResearchFunnel(),
    seenPairIds: new Set<string>(),
    seenMarketKeys: new Set<string>(),
    deps: {
      enrichMarket: async (_event, market) => {
        clock.advance(5_000);
        const key = String(market.id).replace("mkt-", "");
        return {
          diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
        } as unknown as Awaited<ReturnType<PrimaryCandidateLoopParams["deps"]["enrichMarket"]>>;
      },
      selectRecoverablePrimaryMarket: () => null,
      generateLandingCardPair: (enriched) => {
        const e = enriched as unknown as { __key: string };
        return {
          id: `pair-${e.__key}`,
          premiumSignal: { winProbability: 70, time: "3h" },
          marketSource: { headline: e.__key },
          diagnostics: { conditionId: `cond-${e.__key}`, selectedTokenId: `tok-${e.__key}` },
        } as unknown as LandingCardPair;
      },
      computeCandidateProviderEventKey: (c) => (c.event as unknown as { id: string }).id,
      captureResearchSnapshot: async () => {},
    },
  });

  // Only A and B actually started evaluation (c0, c1, c2 open before the
  // budget trips); C never opens a single candidate.
  assert.equal(r.primaryDistinctPhysicalEventsOpened, 2);
});
