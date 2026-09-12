import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrimaryEvidenceRows } from "../../lib/feed/primaryEvidenceServing";
import type { WritePairsInput } from "../../lib/feed/cacheGeneratedSignals";
import { persistCanonicalPrimarySignalPopulation } from "../../lib/feed/persistPrimarySignalPopulation";

const observationId = "00000000-0000-4000-8000-000000001524";

// RESERVATION_10AM_READINESS_AND_FIX_V1: live job_runs evidence on
// 2026-09-12 showed PRIMARY_QUALIFIED_N=570 and 585 -- both above the prior
// 508 cap -- causing publish_primary_signal_observation to reject the whole
// cycle and leave current_signal_pair_serving with zero ACTIVE
// v2-lite-growth-safe rows. The true bound is 254 sampled physical events *
// up to 3 authorized market families (moneyline/spread/total) * 2 sides =
// 1524 (see lib/feed/buildLandingCards.ts AUTHORIZED_RECOVERY_MARKET_TYPES
// and PRIMARY_SCORER_PROVEN_CAPACITY).

test("a 585-row observed population (the live overflow case) publishes as one envelope under the corrected cap", () => {
  const input = {
    pairs: Array.from({ length: 585 }, (_, n) => ({
      id: `pair-${n}`,
      premiumSignal: { eventTitle: `Event ${n}`, winProbability: 65, profit: "+1%", metrics: [] },
      marketSource: { headline: `Market ${n}` },
      marketSources: [],
      diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}`, currentPrice: 0.5 },
    })),
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
  } as unknown as WritePairsInput;
  const rows = buildPrimaryEvidenceRows(observationId, input);
  assert.equal(rows.length, 585);
  assert.equal(new Set(rows.map((r) => `${r.condition_id}::${r.selected_token_id}`)).size, 585);
});

test("the derived 1524 bound (254 samples * 3 market families * 2 sides) accepts a full-width population", async () => {
  const qualified = Array.from({ length: 1524 }, (_, n) => ({
    id: `pair-${n}`,
    premiumSignal: { eventTitle: `Event ${n}`, winProbability: 65, profit: "+1%", metrics: [] },
    marketSource: { headline: `Market ${n}` },
    marketSources: [],
    diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}`, currentPrice: 0.5 },
  })) as never[];
  let publishedRowCount = -1;
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified,
    source: "polymarket",
    formulaVersion: "v2",
    expiresAt: "2026-09-13T00:00:00.000Z",
    observationId,
    observedAt: "2026-09-12T06:00:00.000Z",
    publish: async (args) => {
      publishedRowCount = args.input.pairs.length;
      return { servingProjectedCount: publishedRowCount, primaryEvidenceCapturedCount: publishedRowCount, durationMs: 1 };
    },
  });
  assert.equal(publishedRowCount, 1524);
  assert.equal(result.primaryEvidenceCapturedCount, 1524);
  assert.equal(result.servingProjectedCount, 1524);
});

test("the 1524-row migration widens the cap in the same outbox-to-serving transaction, without loosening any other guard", () => {
  const sql = readFileSync("supabase/migrations/20260912061000_primary_evidence_1524_row_ceiling.sql", "utf8");
  assert.match(sql, /CHECK \(evidence_row_count BETWEEN 1 AND 1524\)/);
  assert.match(sql, /IF row_n < 1 OR row_n > 1524 THEN/);
  assert.match(sql, /between 1 and 1524/);
  assert.match(sql, /observation id replay payload mismatch/);
  assert.ok(
    sql.indexOf("INSERT INTO public.primary_evidence_outbox") < sql.indexOf("INSERT INTO public.current_signal_pair_serving"),
    "outbox and serving remain in the one RPC transaction",
  );
  // Same identity-completeness and replay-mismatch guards as the 508
  // migration -- only the numeric ceiling changed.
  assert.match(sql, /primary observation contains incomplete identity/);
});
