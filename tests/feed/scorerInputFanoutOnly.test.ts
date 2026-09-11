import { test } from "node:test";
import assert from "node:assert/strict";

import { sampleToCandidateMarket, sampleToCandidateMarkets } from "../../lib/feed/buildLandingCards";
import type { SportsDiscoverySample } from "../../lib/feed/types";

// MISSION: SCORER_INPUT_FANOUT_ONLY_V1
//
// `sampleToCandidateMarkets` expands ONE physical event (one discovery sample)
// into N independent `CandidateMarket`s — the pre-existing single primary
// representative PLUS every already-carried `sample.marketsRaw` sibling whose
// `sportsMarketType` is already authorized for recovery (moneyline / spread /
// total). No new source qualification, no new network fetch: this is strictly
// the EXISTING broad research carrier (`sample.marketsRaw`), the SAME
// `AUTHORIZED_RECOVERY_MARKET_TYPES` gate `selectRecoverablePrimaryMarket`
// already uses, now expressed as parallel scorer inputs instead of a
// single-pick enrichment fallback.
//
// Run: node --import tsx --test tests/feed/scorerInputFanoutOnly.test.ts

type SiblingRaw = NonNullable<SportsDiscoverySample["marketsRaw"]>[number];

function sib(conditionId: string, opts?: Partial<SiblingRaw>): SiblingRaw {
  return {
    outcomes: ["Team A", "Team B"],
    outcomePrices: [0.45, 0.55],
    clobTokenIds: [`${conditionId}-tokA`, `${conditionId}-tokB`],
    question: "Team A vs Team B",
    sportsMarketType: "moneyline",
    conditionId,
    ...opts,
  } as SiblingRaw;
}

function sample(marketsRaw: SiblingRaw[] | undefined, opts?: Partial<SportsDiscoverySample>): SportsDiscoverySample {
  return {
    title: "Team A vs Team B",
    slug: "team-a-vs-team-b",
    gameId: "game-1",
    eventVolumeUsd: 100000,
    resolvedGameTimeIso: "2026-09-11T18:00:00.000Z",
    gameTimeSource: "test",
    gameTimeConfidence: "high",
    marketCount: (marketsRaw?.length ?? 0) + 1,
    strategy: "markets-first",
    primaryMarketRaw: {
      outcomes: ["Team A", "Team B"],
      outcomePrices: [0.97, 0.03],
      clobTokenIds: ["cond-primary-tokA", "cond-primary-tokB"],
      question: "Team A vs Team B",
      sportsMarketType: "moneyline",
      conditionId: "cond-primary",
    },
    marketsRaw,
    ...opts,
  } as unknown as SportsDiscoverySample;
}

test("1. one physical event with a primary + two authorized siblings produces 3 distinct scorer inputs", () => {
  const s = sample([
    sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
    sib("cond-total", { sportsMarketType: "totals", outcomePrices: [0.44, 0.56] }),
  ]);

  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 3, "primary + 2 authorized siblings");

  const conditionIds = candidates.map((c) => c.market.conditionId);
  assert.deepEqual(new Set(conditionIds).size, 3, "all identities distinct");
  assert.ok(conditionIds.includes("cond-primary"));
  assert.ok(conditionIds.includes("cond-spread"));
  assert.ok(conditionIds.includes("cond-total"));
});

test("2. each fan-out candidate is keyed by its own distinct condition_id (identity, not a clone)", () => {
  const s = sample([sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] })]);
  const candidates = sampleToCandidateMarkets(s);
  const primary = candidates.find((c) => c.market.conditionId === "cond-primary")!;
  const spreadCandidate = candidates.find((c) => c.market.conditionId === "cond-spread")!;

  assert.ok(primary);
  assert.ok(spreadCandidate);
  // Distinct market objects, distinct outcome/price/token payloads — not the
  // same object reused for two identities.
  assert.notEqual(primary.market, spreadCandidate.market);
  assert.notEqual(primary.market.conditionId, spreadCandidate.market.conditionId);
  assert.deepEqual(spreadCandidate.market.outcomePrices, [0.47, 0.53]);
});

test("3. unauthorized market families (corners / halftime) are excluded from fan-out — no new eligibility corridor", () => {
  const s = sample([
    sib("cond-corners", { sportsMarketType: "total_corners", outcomePrices: [0.44, 0.56] }),
    sib("cond-ht", { sportsMarketType: "soccer_halftime_result", outcomePrices: [0.45, 0.55] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 1, "only the primary — unauthorized siblings never become scorer inputs");
  assert.equal(candidates[0].market.conditionId, "cond-primary");
});

test("4. malformed / non-binary siblings are excluded (fail-closed, same guards as recovery)", () => {
  const s = sample([
    { outcomes: ["A", "Draw", "B"], outcomePrices: [0.4, 0.3, 0.3], clobTokenIds: ["t1", "t2", "t3"], question: "3-way", sportsMarketType: "moneyline", conditionId: "cond-3way" } as SiblingRaw,
    sib("cond-notoken", { clobTokenIds: ["", ""] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 1, "only the primary — malformed siblings never become scorer inputs");
});

test("5. the primary's own conditionId is never duplicated even if it also appears in marketsRaw", () => {
  const s = sample([
    sib("cond-primary"), // duplicate of the primary identity — must not double-count
    sib("cond-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 2, "primary + the one genuinely distinct authorized sibling");
  const conditionIds = candidates.map((c) => c.market.conditionId);
  assert.equal(conditionIds.filter((id) => id === "cond-primary").length, 1);
});

test("6. no siblings -> fan-out degrades to exactly the legacy single representative (byte-parity with sampleToCandidateMarket)", () => {
  const s = sample(undefined);
  const candidates = sampleToCandidateMarkets(s);
  const legacy = sampleToCandidateMarket(s);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], legacy);
});

test("7. a sample whose primary cannot be built (no conditionId) still yields zero candidates — fail-closed, not widened", () => {
  const s = sample([sib("cond-spread", { sportsMarketType: "spreads" })], {
    primaryMarketRaw: { outcomes: [], outcomePrices: [], clobTokenIds: [], question: "x", conditionId: undefined },
  });
  const candidates = sampleToCandidateMarkets(s);
  assert.equal(candidates.length, 0, "no primary -> no fan-out; siblings are only ever considered alongside a real primary");
});

test("8. deterministic ordering — primary first, siblings lexicographic by conditionId", () => {
  const s = sample([
    sib("cond-z-total", { sportsMarketType: "totals", outcomePrices: [0.46, 0.54] }),
    sib("cond-a-spread", { sportsMarketType: "spreads", outcomePrices: [0.47, 0.53] }),
  ]);
  const candidates = sampleToCandidateMarkets(s);
  assert.deepEqual(
    candidates.map((c) => c.market.conditionId),
    ["cond-primary", "cond-a-spread", "cond-z-total"],
  );
});
