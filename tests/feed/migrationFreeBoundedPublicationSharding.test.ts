import assert from "node:assert/strict";
import { test } from "node:test";

import { persistCanonicalPrimarySignalPopulation } from "../../lib/feed/persistPrimarySignalPopulation";

// MIGRATION_FREE_BOUNDED_PRIMARY_PUBLICATION_V1
//
// The live DB ceiling (primary_evidence_outbox CHECK evidence_row_count
// BETWEEN 1 AND 508, and the matching guard inside
// publish_primary_signal_observation) is unchanged and NOT migrated. One
// logical producer cycle whose qualified population exceeds 508 now publishes
// as multiple bounded shards -- grouped by market family (moneyline/spread/
// total), each independently <=508 by the producer's own existing derivation
// (254 sampled physical events * 2 sides) -- instead of depending on a raised
// DB cap. No ranking, no filtering, no dropped identities: every input pair
// reaches serving in exactly one shard.

type FakePair = {
  id: string;
  premiumSignal: { eventTitle: string; winProbability: number; profit: string; metrics: never[] };
  marketSource: { headline: string };
  marketSources: never[];
  diagnostics: { conditionId: string; selectedTokenId: string; currentPrice: number; providerEventContext?: { marketType?: string }; score?: number };
};

function pair(n: number, marketType: string, opts?: { score?: number; price?: number }): FakePair {
  return {
    id: `pair-${marketType}-${n}`,
    premiumSignal: { eventTitle: `Event ${n}`, winProbability: opts?.score ?? 65, profit: "+1%", metrics: [] },
    marketSource: { headline: `Market ${n}` },
    marketSources: [],
    diagnostics: {
      conditionId: `cond-${marketType}-${n}`,
      selectedTokenId: `tok-${marketType}-${n}`,
      currentPrice: opts?.price ?? 0.5,
      providerEventContext: { marketType },
    },
  };
}

function fakePublishCapturing(calls: Array<{ observationId: string; rowCount: number; identities: string[] }>) {
  return async (args: { observationId: string; observedAt: string; input: { pairs: FakePair[] } }) => {
    const identities = args.input.pairs.map((p) => `${p.diagnostics.conditionId}::${p.diagnostics.selectedTokenId}`);
    calls.push({ observationId: args.observationId, rowCount: args.input.pairs.length, identities });
    return {
      servingProjectedCount: args.input.pairs.length,
      primaryEvidenceCapturedCount: args.input.pairs.length,
      durationMs: 1,
    };
  };
}

test("1. a 539-identity population (a live overflow value) publishes successfully through multiple <=508 shards", async () => {
  const qualified = [
    ...Array.from({ length: 300 }, (_, n) => pair(n, "moneyline")),
    ...Array.from({ length: 239 }, (_, n) => pair(n, "spread")),
  ] as never[];
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-000000000539",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  assert.ok(calls.every((c) => c.rowCount <= 508), "every shard call stays within the live 508 ceiling");
  assert.equal(result.servingProjectedCount, 539);
  assert.equal(result.primaryEvidenceCapturedCount, 539);
});

test("2. a synthetic 1524-identity population publishes as exactly bounded shards with no shard >508", async () => {
  const qualified = [
    ...Array.from({ length: 508 }, (_, n) => pair(n, "moneyline")),
    ...Array.from({ length: 508 }, (_, n) => pair(n, "spread")),
    ...Array.from({ length: 508 }, (_, n) => pair(n, "total")),
  ] as never[];
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-000000001524",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  assert.equal(calls.length, 3, "one shard per market family at exactly the 508 boundary");
  for (const c of calls) assert.ok(c.rowCount <= 508, `shard ${c.observationId} exceeds 508: ${c.rowCount}`);
  assert.equal(result.servingProjectedCount, 1524);
});

test("3+4. union of published identities equals the original qualified set, with no duplicate across shards", async () => {
  const qualified = [
    ...Array.from({ length: 520 }, (_, n) => pair(n, "moneyline")),
    ...Array.from({ length: 10 }, (_, n) => pair(n, "total")),
  ] as never[];
  const inputIdentities = new Set(
    qualified.map((p) => `${(p as unknown as FakePair).diagnostics.conditionId}::${(p as unknown as FakePair).diagnostics.selectedTokenId}`)
  );
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-000000000530",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  const allPublished = calls.flatMap((c) => c.identities);
  assert.equal(allPublished.length, new Set(allPublished).size, "no exact identity appears in more than one shard");
  assert.deepEqual(new Set(allPublished), inputIdentities, "union of shard identities equals the pre-shard qualified set");
});

test("5. both independently scored sides of the same condition survive across shards", async () => {
  const conditionId = "cond-shared";
  const qualified = [
    { id: "a", premiumSignal: { eventTitle: "E", winProbability: 70, profit: "+1%", metrics: [] }, marketSource: { headline: "M" }, marketSources: [], diagnostics: { conditionId, selectedTokenId: "tok-A", currentPrice: 0.4, providerEventContext: { marketType: "moneyline" }, score: 70 } },
    { id: "b", premiumSignal: { eventTitle: "E", winProbability: 55, profit: "+1%", metrics: [] }, marketSource: { headline: "M" }, marketSources: [], diagnostics: { conditionId, selectedTokenId: "tok-B", currentPrice: 0.6, providerEventContext: { marketType: "moneyline" }, score: 55 } },
  ] as never[];
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-00000000000a",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  const all = calls.flatMap((c) => c.identities);
  assert.ok(all.includes(`${conditionId}::tok-A`));
  assert.ok(all.includes(`${conditionId}::tok-B`));
});

test("6+7. score, price, and diagnostics remain identity-specific through sharding (no copy)", async () => {
  const qualified = [
    pair(0, "moneyline", { score: 91, price: 0.11 }),
    pair(1, "moneyline", { score: 22, price: 0.88 }),
  ] as never[];
  let captured: FakePair[] = [];
  await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-00000000000b",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: (async (args: { input: { pairs: FakePair[] } }) => {
      captured = captured.concat(args.input.pairs);
      return { servingProjectedCount: args.input.pairs.length, primaryEvidenceCapturedCount: args.input.pairs.length, durationMs: 1 };
    }) as never,
  });
  const p0 = captured.find((p) => p.diagnostics.selectedTokenId === "tok-moneyline-0")!;
  const p1 = captured.find((p) => p.diagnostics.selectedTokenId === "tok-moneyline-1")!;
  assert.equal(p0.premiumSignal.winProbability, 91);
  assert.equal(p0.diagnostics.currentPrice, 0.11);
  assert.equal(p1.premiumSignal.winProbability, 22);
  assert.equal(p1.diagnostics.currentPrice, 0.88);
});

test("8. a failing shard does not falsely present the partial cycle as a complete authoritative success", async () => {
  // Population exceeds the 508 whole-cycle threshold so this genuinely
  // shards by market family (a population this size would NOT be split
  // into per-family envelopes if it fit in one call -- see test 9).
  const qualified = [
    ...Array.from({ length: 400 }, (_, n) => pair(n, "moneyline")),
    ...Array.from({ length: 200 }, (_, n) => pair(n, "total")),
  ] as never[];
  let moneylineCallCount = 0;
  let totalCallCount = 0;
  await assert.rejects(
    persistCanonicalPrimarySignalPopulation({
      primaryQualifiedPairs: qualified,
      publicPairsToCache: qualified,
      source: "polymarket",
      formulaVersion: "v2",
      expiresAt: "2026-09-13T00:00:00.000Z",
      observationId: "00000000-0000-4000-8000-00000000000c",
      observedAt: "2026-09-12T06:00:00.000Z",
      publish: (async (args: { input: { pairs: FakePair[] } }) => {
        const family = args.input.pairs[0]?.diagnostics.providerEventContext?.marketType;
        if (family === "total") {
          totalCallCount += 1;
          throw new Error("simulated shard failure");
        }
        moneylineCallCount += 1;
        return { servingProjectedCount: args.input.pairs.length, primaryEvidenceCapturedCount: args.input.pairs.length, durationMs: 1 };
      }) as never,
    }),
    /MoneyPersistenceBoundaryError|simulated shard failure/,
  );
  assert.equal(moneylineCallCount, 1, "the unaffected family shard is still attempted");
  assert.equal(totalCallCount, 1, "the failing shard was attempted exactly once, not retried into a false success");
});

test("9. the un-migrated 508 cap still behaves correctly for a population within one shard", async () => {
  const qualified = Array.from({ length: 300 }, (_, n) => pair(n, "moneyline")) as never[];
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId: "00000000-0000-4000-8000-00000000000d",
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  assert.equal(calls.length, 1, "a population within the cap stays a single publication call, unchanged from before sharding");
  assert.equal(result.servingProjectedCount, 300);
});

test("10. a typical multi-family population under the cap (moneyline+spread+total together) is still ONE atomic call with the original observationId", async () => {
  // A realistic small cycle spans all three families simultaneously. Sharding
  // by family unconditionally would split this into 3 envelopes and lose the
  // caller's observationId -- exactly the regression this test guards.
  const qualified = [
    ...Array.from({ length: 20 }, (_, n) => pair(n, "moneyline")),
    ...Array.from({ length: 12 }, (_, n) => pair(n, "spread")),
    ...Array.from({ length: 8 }, (_, n) => pair(n, "total")),
  ] as never[];
  const calls: Array<{ observationId: string; rowCount: number; identities: string[] }> = [];
  const observationId = "00000000-0000-4000-8000-00000000000e";
  await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId,
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: fakePublishCapturing(calls) as never,
  });
  assert.equal(calls.length, 1, "a multi-family cycle under the cap is one call, not one call per family");
  assert.equal(calls[0].rowCount, 40);
  assert.equal(calls[0].observationId, observationId, "the caller's own producer-cycle observationId is preserved unchanged (job_runs run_id correlation)");
});
