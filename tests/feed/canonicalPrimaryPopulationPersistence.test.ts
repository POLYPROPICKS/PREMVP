import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { persistCanonicalPrimarySignalPopulation } from "../../lib/feed/persistPrimarySignalPopulation";
import { PRIMARY_SCORER_PROVEN_CAPACITY, PRIMARY_LOOP_DEFAULT_BUDGET_MS } from "../../lib/feed/buildLandingCards";
import type { LandingCardPair } from "../../lib/feed/types";
import { buildPrimaryEvidenceRows } from "../../lib/feed/primaryEvidenceServing";

function pair(n: number): LandingCardPair {
  return {
    id: `pair-${n}`,
    premiumSignal: { eventTitle: `Event ${n}`, winProbability: 70, profit: "+12%", metrics: [] },
    marketSource: { headline: `market ${n}` },
    marketSources: [],
    diagnostics: { conditionId: `cond-${n}`, selectedTokenId: `tok-${n}`, selectedOutcome: "A", currentPrice: 0.4 },
  } as unknown as LandingCardPair;
}

const observationId = "00000000-0000-4000-8000-000000000218";
const observedAt = "2026-09-07T20:00:00.000Z";

test("GSP-unavailable injection: exact primary evidence reaches direct Serving atomically", async () => {
  const qualified = Array.from({ length: 22 }, (_, i) => pair(i));
  let captured: unknown;
  const result = await persistCanonicalPrimarySignalPopulation({
    primaryQualifiedPairs: qualified,
    publicPairsToCache: qualified.slice(0, 15),
    source: "polymarket",
    formulaVersion: "v2-lite-growth-safe",
    expiresAt: "2026-09-08T20:00:00.000Z",
    observationId,
    observedAt,
    publish: async (args) => {
      captured = args;
      return { servingProjectedCount: args.input.pairs.length, primaryEvidenceCapturedCount: args.input.pairs.length, durationMs: 7 };
    },
    legacyGspProbe: async () => { throw new Error("generated_signal_pairs unavailable"); },
  });

  assert.equal(result.servingProjectedCount, 22);
  assert.equal(result.primaryEvidenceCapturedCount, 22);
  assert.equal(result.canonicalPersistedCount, 0, "no synchronous GSP prerequisite");
  assert.equal(result.gspWriteStatus, "FAILED_NON_FATAL");
  assert.equal((captured as { observationId: string }).observationId, observationId);
  assert.equal((captured as { observedAt: string }).observedAt, observedAt);
  assert.equal((captured as { input: { pairs: unknown[] } }).input.pairs.length, 22);
  assert.equal(PRIMARY_SCORER_PROVEN_CAPACITY, 254);
  assert.equal(PRIMARY_LOOP_DEFAULT_BUDGET_MS, 360_000);
});

test("schema contract removes GSP FK and enforces bounded idempotent durable publication", () => {
  const sql = readFileSync("supabase/migrations/20260908120000_make_current_money_state_gsp_independent.sql", "utf8");
  assert.match(sql, /primary_evidence_outbox/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS current_signal_pair_serving_source_generated_signal_pair_id_fkey/);
  assert.match(sql, /ALTER COLUMN source_generated_signal_pair_id DROP NOT NULL/);
  assert.match(sql, /observation id replay payload mismatch/);
  assert.match(sql, /row_n < 1 OR row_n > 300/);
  assert.match(sql, /EXCLUDED\.observed_at, EXCLUDED\.observation_id/);
  assert.match(sql, /evidence_rows IS DISTINCT FROM p_rows/);
  assert.match(sql, /item->>'observation_id'/);
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]+PUBLIC, anon, authenticated/);
});

test("row observation IDs are unique and stable for an idempotent envelope retry", () => {
  const qualified = [pair(1), pair(2)];
  const input = { pairs: qualified as never[], source: "polymarket", formulaVersion: "v2", expiresAt: "2026-09-08T20:00:00.000Z" };
  const first = buildPrimaryEvidenceRows(observationId, input);
  const retry = buildPrimaryEvidenceRows(observationId, input);
  assert.deepEqual(retry, first);
  assert.notEqual(first[0].observation_id, first[1].observation_id);
});
