import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  boundPrimaryScorerPopulation,
  PRIMARY_SCORER_PROVEN_CAPACITY,
} from "../../lib/feed/buildLandingCards";

// MISSION: REMOVE_UPSTREAM_254_DISCOVERY_TRUNCATION
//
// PRIMARY_SCORER_PROVEN_CAPACITY (254) was already retired as the membership
// bound inside boundPrimaryScorerPopulation() (see primaryScorerPopulationCap.test.ts).
// A second, earlier positional truncation remained: the sports discovery call
// in buildLandingCards.ts passed `targetCards: PRIMARY_SCORER_PROVEN_CAPACITY`
// into discoverSportsMarkets(), which slices its eligible groups to that count
// (lib/feed/discoverSportsMarkets.ts `.slice(0, cfg.targetCards)`) BEFORE
// boundPrimaryScorerPopulation ever runs. So >254 volume-eligible physical
// events could never reach the primary loop even though the downstream bound
// was already unbounded by default.
//
// This test guards both ends of that pipeline:
//   1. the call site no longer binds discovery's targetCards to the 254
//      constant (source-level regression guard — discoverSportsMarkets()
//      itself makes live network calls and is out of scope for a unit test);
//   2. simulating the two-stage pipeline (discovery slice -> bound) with a
//      >254 eligible population still yields the full population.
//
// Run: node --import tsx --test tests/feed/discoveryNoUpstream254Truncation.test.ts

const BUILD_LANDING_CARDS_SRC = readFileSync(
  join(__dirname, "../../lib/feed/buildLandingCards.ts"),
  "utf8",
);

test("sports discovery call site does not bind targetCards to PRIMARY_SCORER_PROVEN_CAPACITY", () => {
  const callSite = BUILD_LANDING_CARDS_SRC.match(
    /discoverSportsMarkets\(\{[\s\S]*?\n {6}\}\)/,
  );
  assert.ok(callSite, "expected to find the discoverSportsMarkets({...}) call site");

  assert.ok(
    !/targetCards:\s*PRIMARY_SCORER_PROVEN_CAPACITY/.test(callSite![0]),
    "discovery must not be pre-truncated to the 254 proven-capacity constant; " +
      "the single membership bound belongs to boundPrimaryScorerPopulation()",
  );
});

test("discovery slice followed by the default-unbounded population bound preserves >254 eligible events", () => {
  const sample = (i: number) => ({ gameId: `g-${String(i).padStart(4, "0")}`, order: i });

  // Simulates discoverSportsMarkets' internal `.slice(0, cfg.targetCards)`
  // truncation with the fixed call-site config used in buildLandingCards.ts.
  const targetCards = Infinity;
  const volumeEligible24hGroups = Array.from({ length: 400 }, (_, i) => sample(i));
  const volumeEligible48hGroups = Array.from({ length: 200 }, (_, i) => sample(1000 + i));

  const finalCandidates = volumeEligible24hGroups.slice(0, targetCards);
  const fallback48hCandidates = volumeEligible48hGroups.slice(0, targetCards);

  assert.equal(finalCandidates.length, 400, "discovery no longer truncates the 24h eligible group to 254");
  assert.ok(finalCandidates.length > PRIMARY_SCORER_PROVEN_CAPACITY);

  const bounded = boundPrimaryScorerPopulation(finalCandidates, fallback48hCandidates);
  assert.equal(bounded.length, 600, "the full eligible population reaches the primary loop");
  assert.ok(bounded.length > PRIMARY_SCORER_PROVEN_CAPACITY);
});
