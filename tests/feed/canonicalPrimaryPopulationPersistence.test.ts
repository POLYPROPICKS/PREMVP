import { test } from "node:test";
import assert from "node:assert/strict";

import {
  persistCanonicalPrimarySignalPopulation,
} from "../../lib/feed/persistPrimarySignalPopulation";
import {
  PRIMARY_SCORER_PROVEN_CAPACITY,
  PRIMARY_LOOP_DEFAULT_BUDGET_MS,
} from "../../lib/feed/buildLandingCards";
import type { LandingCardPair } from "../../lib/feed/types";
import type { WritePairsInput } from "../../lib/feed/cacheGeneratedSignals";

// MISSION: WIRE_FULL_PRIMARY_QUALIFIED_POPULATION_INTO_CANONICAL_GSP_PERSISTENCE
//
// The producer (scripts/generate-signals.ts) now calls
// persistCanonicalPrimarySignalPopulation({ primaryQualifiedPairs, publicPairsToCache, ... }).
// This proves the producer boundary in one bounded fixture:
//   1. PUBLIC_OUTPUT_COUNT <= 15
//   2. CANONICAL_GSP_PERSISTENCE_COUNT > 15 when > 15 candidates qualify
//   3. >= 1 qualified candidate with semantic rank > 15 reaches the canonical writer
//   4. no duplicate canonical row across public + extra populations
//   5. thresholds / 254 ceiling / 360s guard unchanged
//
// The canonical writer itself (writeGeneratedSignalPairs -> generated_signal_pairs
// + current_signal_pair_serving projection) is UNCHANGED and already exercised by
// the existing suite; it is injected here so the proof stays deterministic and
// offline.
//
// Run: node --import tsx --test tests/feed/canonicalPrimaryPopulationPersistence.test.ts

function pair(n: number): LandingCardPair {
  return {
    id: `pair-${n}`,
    premiumSignal: {
      eventTitle: `Event ${n}`,
      winProbability: 70,
      profit: "+12%",
      metrics: [{ id: "smart-money", label: "Smart Money", value: 60 }],
    },
    marketSource: { headline: `market ${n}` },
    marketSources: [],
    diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}` },
  } as unknown as LandingCardPair;
}

const identityOf = (r: WritePairsInput["pairs"][number]): string => {
  const d = r.diagnostics as { conditionId?: string; selectedTokenId?: string };
  return `${d?.conditionId}::${d?.selectedTokenId}`;
};

test("full primary-qualified population reaches the canonical GSP writer; public feed stays <= 15", async () => {
  const PUBLIC_LIMIT = 15;

  // 22 semantically-qualified primary outcomes; the public selection is the
  // first 15 (produced upstream by buildLandingCards' bounded public `pairs`).
  const primaryQualifiedPairs = Array.from({ length: 22 }, (_, i) => pair(i));
  const publicPairsToCache = primaryQualifiedPairs.slice(0, PUBLIC_LIMIT);

  const batches: WritePairsInput[] = [];
  const fakeWrite = (async (input: WritePairsInput) => {
    batches.push(input);
    return input.pairs.length;
  }) as typeof import("../../lib/feed/cacheGeneratedSignals").writeGeneratedSignalPairs;

  const res = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs,
    publicPairsToCache,
    source: "polymarket",
    formulaVersion: "v2-lite-growth-safe",
    expiresAt: "2026-08-28T12:00:00.000Z",
    write: fakeWrite,
  });

  // 1. public output bounded
  const PUBLIC_OUTPUT_COUNT = res.publicPersistedCount;
  assert.equal(PUBLIC_OUTPUT_COUNT, 15);
  assert.ok(PUBLIC_OUTPUT_COUNT <= 15);

  // 2. canonical persistence exceeds the public cap
  const CANONICAL_PERSISTED_COUNT = res.canonicalPersistedCount;
  assert.equal(CANONICAL_PERSISTED_COUNT, 22);
  assert.ok(CANONICAL_PERSISTED_COUNT > 15);
  assert.equal(res.canonicalExtrasProposed, 7);
  assert.equal(res.canonicalExtrasPersistedCount, 7);

  // ordering: extras written FIRST (older created_at) so the public feed read
  // stays byte-identical.
  assert.equal(batches.length, 2);
  const [extrasBatch, publicBatch] = batches;
  assert.equal(extrasBatch.pairs.length, 7);
  assert.equal(publicBatch.pairs.length, 15);

  // 3. a rank > 15 qualified candidate reaches the canonical writer
  const extrasIdentities = new Set(extrasBatch.pairs.map(identityOf));
  assert.ok(extrasIdentities.has("cond-15::tok-15"), "rank 16 (index 15) persisted canonically");
  assert.ok(extrasIdentities.has("cond-21::tok-21"), "rank 22 (index 21) persisted canonically");
  for (let i = 15; i < 22; i++) {
    assert.ok(extrasIdentities.has(`cond-${i}::tok-${i}`), `rank ${i + 1} persisted`);
  }

  // 4. no duplicate canonical row across public + extras
  const allIdentities = [...publicBatch.pairs, ...extrasBatch.pairs].map(identityOf);
  assert.equal(new Set(allIdentities).size, allIdentities.length, "no duplicate canonical identity");
  assert.equal(new Set(allIdentities).size, 22);
  for (const id of extrasIdentities) {
    assert.ok(!publicBatch.pairs.map(identityOf).includes(id), `${id} not also in the public batch`);
  }

  // 5. thresholds / ceiling / guard untouched by this wiring
  assert.equal(PRIMARY_SCORER_PROVEN_CAPACITY, 254);
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, 6 * 60_000); // 360s
});

test("<= 15 qualified: no extra write, public path byte-identical (zero behaviour change)", async () => {
  const primaryQualifiedPairs = Array.from({ length: 11 }, (_, i) => pair(i));
  const publicPairsToCache = primaryQualifiedPairs.slice(0, 15); // all 11

  const batches: WritePairsInput[] = [];
  const fakeWrite = (async (input: WritePairsInput) => {
    batches.push(input);
    return input.pairs.length;
  }) as typeof import("../../lib/feed/cacheGeneratedSignals").writeGeneratedSignalPairs;

  const res = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs,
    publicPairsToCache,
    source: "polymarket",
    formulaVersion: "v2-lite-growth-safe",
    expiresAt: "2026-08-28T12:00:00.000Z",
    write: fakeWrite,
  });

  assert.equal(res.canonicalExtrasProposed, 0);
  assert.equal(batches.length, 1, "only the existing public write happens");
  assert.equal(batches[0].pairs.length, 11);
  assert.equal(res.canonicalPersistedCount, 11);
});
