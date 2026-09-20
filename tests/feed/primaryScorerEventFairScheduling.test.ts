import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  orderPrimaryCandidatesEventFair,
  computeCandidateProviderEventKey,
  prioritizePinnedCandidates,
  runPrimaryCandidateLoop,
  createPrimaryLoopBudgetGuard,
  PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON,
  type CandidateMarket,
  type RequiredProviderEventPin,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair, ResearchFunnelCounters } from "../../lib/feed/types";

// MISSION: PRIMARY_SCORER_EVENT_FAIR_SCHEDULING_V1
//
// The production primary candidate loop is fully sequential under a fixed
// 360s wall-clock budget. sortCandidatesForProductRanking + (when active)
// prioritizePinnedCandidates decide WHICH physical event is highest priority
// -- that ranking is unchanged by this fix. What was structurally unsafe is
// that once a physical event is first in line, EVERY one of its identities
// (its full fanout) is attempted before the next-priority physical event
// gets even one attempt. orderPrimaryCandidatesEventFair() postpones deep
// identity fanout to later breadth passes while conserving candidate
// membership, per-event internal identity order, and first physical-event
// appearance order (i.e. existing priority, pins included).
//
// This test file proves the pure reordering function's semantics and its
// effect on primaryDistinctPhysicalEventsOpened under the SAME sequential
// runPrimaryCandidateLoop + wall-clock guard used in production. It does
// NOT claim any specific number of physical events fit in 360s -- only that
// event-fair ordering removes the single-event monopolization failure mode.
//
// Run: node --import tsx --test tests/feed/primaryScorerEventFairScheduling.test.ts

function candidateFor(eventSlug: string, identityIndex: number, startDate = "2026-09-20T12:00:00.000Z"): CandidateMarket {
  const id = `${eventSlug}-${identityIndex}`;
  const market = {
    id: `mkt-${id}`,
    conditionId: `cond-${id}`,
    question: `${id}?`,
    slug: `slug-${id}`,
  } as unknown as CandidateMarket["market"];
  (market as unknown as Record<string, unknown>)._parentMeta = {
    polymarketEventSlug: eventSlug,
    startDate,
  };
  return {
    event: { id: `evt-${eventSlug}`, title: eventSlug, markets: [] } as unknown as CandidateMarket["event"],
    market,
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
  };
}

/** No _parentMeta at all -> computeCandidateProviderEventKey() returns null. */
function unkeyedCandidate(tag: string): CandidateMarket {
  return {
    event: { id: `evt-null-${tag}`, title: tag, markets: [] } as unknown as CandidateMarket["event"],
    market: {
      id: `mkt-null-${tag}`,
      conditionId: `cond-null-${tag}`,
      question: `${tag}?`,
      slug: `slug-null-${tag}`,
    } as unknown as CandidateMarket["market"],
    rejectionReasons: [],
    warnings: [],
    isSportsRelated: true,
    isEnded: false,
  };
}

function conditionIdOf(c: CandidateMarket): string {
  return String(c.market.conditionId);
}

function group(eventSlug: string, n: number): CandidateMarket[] {
  return Array.from({ length: n }, (_, i) => candidateFor(eventSlug, i + 1));
}

// ── 1 & 2: high-fanout fixture, breadth-first pass + internal order preserved ──

test("orderPrimaryCandidatesEventFair: first breadth pass is exactly A1,B1,C1,D1, not A1,A2,A3,A4", () => {
  const input = [...group("evt-a", 100), ...group("evt-b", 3), ...group("evt-c", 1), ...group("evt-d", 2)];
  const fair = orderPrimaryCandidatesEventFair(input);
  const firstFour = fair.slice(0, 4).map((c) => conditionIdOf(c));
  assert.deepEqual(firstFour, ["cond-evt-a-1", "cond-evt-b-1", "cond-evt-c-1", "cond-evt-d-1"]);
});

test("orderPrimaryCandidatesEventFair: identity order inside event A is preserved across every round-robin pass", () => {
  const input = [...group("evt-a", 100), ...group("evt-b", 3), ...group("evt-c", 1), ...group("evt-d", 2)];
  const fair = orderPrimaryCandidatesEventFair(input);
  const aOnly = fair.filter((c) => computeCandidateProviderEventKey(c) === computeCandidateProviderEventKey(candidateFor("evt-a", 1)));
  const expected = group("evt-a", 100).map(conditionIdOf);
  assert.deepEqual(aOnly.map(conditionIdOf), expected);
});

// ── 3: candidate membership conserved as a multiset ────────────────────────────

test("orderPrimaryCandidatesEventFair: candidate membership is exactly conserved (multiset)", () => {
  const input = [...group("evt-a", 100), ...group("evt-b", 3), ...group("evt-c", 1), ...group("evt-d", 2)];
  const fair = orderPrimaryCandidatesEventFair(input);
  assert.equal(fair.length, input.length);
  assert.deepEqual(fair.map(conditionIdOf).sort(), input.map(conditionIdOf).sort());
});

// ── 4: first physical-event appearance order unchanged ─────────────────────────

test("orderPrimaryCandidatesEventFair: first physical-event appearance order is unchanged (existing priority preserved)", () => {
  const input = [...group("evt-a", 100), ...group("evt-b", 3), ...group("evt-c", 1), ...group("evt-d", 2)];
  const fair = orderPrimaryCandidatesEventFair(input);
  const firstAppearance = (list: CandidateMarket[]) => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of list) {
      const key = computeCandidateProviderEventKey(c);
      if (key !== null && !seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    return order;
  };
  assert.deepEqual(firstAppearance(fair), firstAppearance(input));
});

// ── 5: null-key candidates last, relative order preserved ──────────────────────

test("orderPrimaryCandidatesEventFair: null-key candidates are placed last, preserving their exact relative order", () => {
  const input = [
    unkeyedCandidate("u1"),
    ...group("evt-a", 2),
    unkeyedCandidate("u2"),
    ...group("evt-b", 1),
  ];
  const fair = orderPrimaryCandidatesEventFair(input);
  const tags = fair.map(conditionIdOf);
  assert.deepEqual(tags.slice(-2), ["cond-null-u1", "cond-null-u2"]);
  assert.deepEqual(tags.slice(0, -2), ["cond-evt-a-1", "cond-evt-b-1", "cond-evt-a-2"]);
});

// ── 6 & 7: pinned physical events stay ahead, breadth-first among themselves ───

test("orderPrimaryCandidatesEventFair composed with prioritizePinnedCandidates: pinned events remain ahead of normal events, breadth-first among pins first", () => {
  // Existing product ranking already put NORMAL_A, NORMAL_B first (e.g. by
  // volume); PIN_A and PIN_B are active reservations that must be promoted
  // ahead of them by prioritizePinnedCandidates -- exactly as production
  // composes it (sortCandidatesForProductRanking -> prioritizePinnedCandidates
  // -> orderPrimaryCandidatesEventFair, only when evaluateFullPrimaryPopulation).
  const sorted = [...group("normal-a", 3), ...group("normal-b", 2), ...group("pin-a", 3), ...group("pin-b", 2)];
  const pins: RequiredProviderEventPin[] = [
    { providerEventId: computeCandidateProviderEventKey(candidateFor("pin-a", 1))!, eventStartIso: "2026-09-20T12:00:00.000Z", reservationIds: ["r1"] },
    { providerEventId: computeCandidateProviderEventKey(candidateFor("pin-b", 1))!, eventStartIso: "2026-09-20T12:00:00.000Z", reservationIds: ["r2"] },
  ];
  const { ordered } = prioritizePinnedCandidates(sorted, pins);
  const fair = orderPrimaryCandidatesEventFair(ordered);

  const firstFour = fair.slice(0, 4).map(conditionIdOf);
  assert.deepEqual(firstFour, ["cond-pin-a-1", "cond-pin-b-1", "cond-normal-a-1", "cond-normal-b-1"]);

  // Pins are not deep-evaluated ahead of each other: PIN_B's first identity
  // appears before PIN_A's second identity.
  const pinB1Index = fair.findIndex((c) => conditionIdOf(c) === "cond-pin-b-1");
  const pinA2Index = fair.findIndex((c) => conditionIdOf(c) === "cond-pin-a-2");
  assert.ok(pinB1Index < pinA2Index, "PIN_B1 must be scheduled before PIN_A2 (breadth-first among pins)");
});

// ── 8: legacy/public ordering unchanged when evaluateFullPrimaryPopulation=false ─

const BUILD_LANDING_CARDS_SRC = readFileSync(join(__dirname, "../../lib/feed/buildLandingCards.ts"), "utf8");

test("buildLandingCards() only calls orderPrimaryCandidatesEventFair when evaluateFullPrimaryPopulation is true (legacy/public ordering untouched otherwise)", () => {
  assert.ok(
    /if \(evaluateFullPrimaryPopulation\) \{\s*candidates = orderPrimaryCandidatesEventFair\(candidates\);\s*\}/.test(
      BUILD_LANDING_CARDS_SRC,
    ),
    "expected the event-fair reorder to be strictly gated behind evaluateFullPrimaryPopulation",
  );
});

test("buildLandingCards() applies event-fair scheduling after sortCandidatesForProductRanking/prioritizePinnedCandidates/excludeEnded and before the primary loop", () => {
  const sortIdx = BUILD_LANDING_CARDS_SRC.indexOf("candidates = sortCandidatesForProductRanking(candidates);");
  const pinIdx = BUILD_LANDING_CARDS_SRC.indexOf("prioritizePinnedCandidates(candidates, requiredProviderEvents)");
  const fairIdx = BUILD_LANDING_CARDS_SRC.indexOf("candidates = orderPrimaryCandidatesEventFair(candidates);");
  const loopIdx = BUILD_LANDING_CARDS_SRC.indexOf("await runPrimaryCandidateLoop({");
  assert.ok(sortIdx > -1 && pinIdx > -1 && fairIdx > -1 && loopIdx > -1, "all four anchors must be present");
  assert.ok(sortIdx < pinIdx && pinIdx < fairIdx && fairIdx < loopIdx, "expected strict ordering: sort -> pin -> event-fair -> loop");
});

// ── 9-13: fake-clock composition through the real sequential loop ─────────────

function freshResearchFunnel(): ResearchFunnelCounters {
  return {
    candidatesSeen: 0, rejectedPreResearchCandidateReasons: 0, enrichmentNull: 0,
    attempted: 0, rejectedMissingConditionOrSelectedToken: 0, rejectedNoBinaryGuard: 0,
    rejectedMissingOpposingToken: 0, rejectedInvalidPrice: 0, rejectedOddsBelowMin: 0,
    rejectedOddsAboveMax: 0, eligible: 0, execFetchAttempted: 0,
    execFetchOk: 0, execFetchEmptyBook: 0, execFetchFailed: 0,
  };
}

function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return { now: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

test("event-fair ordering lets 4 distinct physical events (A,B,C,D) each open before a deep-fanout event consumes the remaining budget", async () => {
  // Production current order for a high-fanout leader is identity-major:
  // A's 5 identities, then B, C, D's single identities each.
  const currentOrder = [...group("evt-a", 5), ...group("evt-b", 1), ...group("evt-c", 1), ...group("evt-d", 1)];
  const fairOrder = orderPrimaryCandidatesEventFair(currentOrder);
  // Sanity: fair order opens A1,B1,C1,D1 before A2..A5.
  assert.deepEqual(fairOrder.slice(0, 4).map(conditionIdOf), ["cond-evt-a-1", "cond-evt-b-1", "cond-evt-c-1", "cond-evt-d-1"]);

  const clock = fakeClock();
  const perCandidateLatencyMs = 5_000;
  // Budget wide enough for exactly 4 opens (0,5,10,15s all < 20s boundary),
  // the 5th check (at 20s elapsed) trips the guard.
  const budgetGuard = createPrimaryLoopBudgetGuard({ startedAtMs: clock.now(), budgetMs: 20_000, now: clock.now });

  const r = await runPrimaryCandidateLoop({
    candidates: fairOrder,
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
        // Already-started work always completes (guard is only consulted
        // before opening the NEXT candidate) -- advance happens inside.
        clock.advance(perCandidateLatencyMs);
        const key = String(market.id).replace("mkt-", "");
        return {
          diagnostics: { dataCoverage: 80, rejectionReasons: [], conditionId: `cond-${key}` },
          __key: key,
        } as unknown as Awaited<ReturnType<Parameters<typeof runPrimaryCandidateLoop>[0]["deps"]["enrichMarket"]>>;
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
      computeCandidateProviderEventKey,
      captureResearchSnapshot: async () => {},
    },
  });

  const budgetExcluded = r.primaryTerminalReasonCounts[PRIMARY_LOOP_BUDGET_EXHAUSTED_TERMINAL_REASON] ?? 0;

  // 13: distinct physical events actually opened -- all four (A,B,C,D), not
  // just A as identity-major current ordering would have produced.
  assert.equal(r.primaryDistinctPhysicalEventsOpened, 4);
  // 10 & 11: already-opened candidates complete and qualify; the remainder is
  // attributed to the budget-exhausted terminal reason, never interrupted mid-flight.
  assert.equal(r.primaryTerminalReasonCounts.PRIMARY_QUALIFIED, 4);
  assert.equal(budgetExcluded, currentOrder.length - 4);
  // 12: terminal-reason conservation is exact.
  assert.equal(sum(r.primaryTerminalReasonCounts), r.primaryCandidatesEntered);
  assert.equal(r.primaryCandidatesEntered, currentOrder.length);
  assert.equal(r.primaryLoopBudgetExhausted, true);
  // Not the identity-major counterfactual: under the ORIGINAL (non-fair)
  // order, the same budget would have opened only event A's first 4
  // identities -- i.e. 1 distinct physical event, not 4.
  assert.notEqual(r.primaryDistinctPhysicalEventsOpened, 1);
});
