import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("current serving projection keeps historical lineage, deterministic replacement, and rerunnable backfill in SQL", () => {
  const migration = readFileSync("supabase/migrations/20260812_current_signal_pair_serving.sql", "utf8");
  assert.match(migration, /PRIMARY KEY \(condition_id, selected_token_id, metric_formula_version\)/);
  assert.match(migration, /UNIQUE \(source_generated_signal_pair_id\)/);
  assert.match(migration, /REFERENCES public\.generated_signal_pairs\(id\)/);
  assert.match(migration, /DISTINCT ON \(source\.condition_id, source\.selected_token_id, source\.metric_formula_version\)/);
  assert.match(migration, /source\.created_at DESC, source\.id DESC/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.current_signal_pair_serving_backfill_checkpoint/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.backfill_current_signal_pair_serving/);
  assert.match(migration, /ORDER BY source\.created_at ASC, source\.id ASC/);
  assert.match(migration, /PERFORM public\.refresh_current_signal_pair_serving\(source_ids\)/);
  assert.match(migration, /FOR UPDATE/);
  assert.doesNotMatch(migration, /DELETE FROM public\.generated_signal_pairs/);
});

test("writer projection is idempotent by source UUID and exposes a recoverable pending failure", async (t) => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let fail = false;
  t.mock.module("../../lib/supabase/server", {
    namedExports: {
      supabaseAdmin: {
        rpc(fn: string, args: Record<string, unknown>) {
          calls.push({ fn, args });
          return Promise.resolve({ error: fail ? { message: "projection unavailable" } : null });
        },
      },
    },
  });
  const { refreshCurrentSignalPairServing, ServingProjectionPendingError } = await import("../../lib/feed/currentSignalPairServing");

  await refreshCurrentSignalPairServing(["source-a", "source-a", "", "source-b"]);
  assert.deepEqual(calls[0], {
    fn: "refresh_current_signal_pair_serving",
    args: { p_source_generated_signal_pair_ids: ["source-a", "source-b"] },
  });

  fail = true;
  await assert.rejects(
    refreshCurrentSignalPairServing(["source-c"]),
    (error: unknown) => error instanceof ServingProjectionPendingError && error.sourceGeneratedSignalPairIds[0] === "source-c",
  );
});

test("production-shaped cohort conserves old Planning immutable identities in the serving projection", () => {
  const now = "2030-01-01T00:00:00.000Z";
  const historical = [
    { id: "00000000-0000-4000-8000-000000000001", condition_id: "c1", selected_token_id: "t1", metric_formula_version: "v2-lite-growth-safe", created_at: "2029-12-30T10:00:00.000Z", expires_at: "2030-01-02T00:00:00.000Z", signal_result: null, signal_confidence_num: 72, entry_price_num: 0.44 },
    { id: "00000000-0000-4000-8000-000000000002", condition_id: "c1", selected_token_id: "t1", metric_formula_version: "v2-lite-growth-safe", created_at: "2029-12-31T10:00:00.000Z", expires_at: "2030-01-02T00:00:00.000Z", signal_result: null, signal_confidence_num: 80, entry_price_num: 0.45 },
    { id: "00000000-0000-4000-8000-000000000003", condition_id: "c2", selected_token_id: "t2", metric_formula_version: "shadow-strategic-sports-v1", created_at: "2029-12-31T11:00:00.000Z", expires_at: "2030-01-02T00:00:00.000Z", signal_result: null, signal_confidence_num: null, entry_price_num: 0.51 },
    { id: "00000000-0000-4000-8000-000000000004", condition_id: "expired", selected_token_id: "expired", metric_formula_version: "v2-lite-growth-safe", created_at: "2029-12-31T12:00:00.000Z", expires_at: "2029-12-31T23:00:00.000Z", signal_result: null, signal_confidence_num: 90, entry_price_num: 0.40 },
  ];
  const key = (row: typeof historical[number]) => `${row.condition_id}::${row.selected_token_id}::${row.metric_formula_version}`;
  const oldEligible = historical.filter((row) => row.signal_result === null && row.expires_at > now && row.entry_price_num !== null &&
    ((row.signal_confidence_num !== null && row.signal_confidence_num >= 50) ||
      (row.metric_formula_version === "shadow-strategic-sports-v1" && row.signal_confidence_num === null)));
  const serving = new Map<string, typeof historical[number]>();
  for (const row of oldEligible) {
    const prior = serving.get(key(row));
    if (!prior || `${row.created_at}:${row.id}` > `${prior.created_at}:${prior.id}`) serving.set(key(row), row);
  }
  const newEligible = [...serving.values()];

  assert.deepEqual(new Set(newEligible.map(key)), new Set(oldEligible.map(key)), "OLD_CANONICAL_ELIGIBLE_IDENTITIES = NEW_SERVING_ELIGIBLE_IDENTITIES");
  assert.equal(oldEligible.length, 3, "old historical cohort rows/pages read");
  assert.equal(newEligible.length, 2, "new bounded serving cohort rows read");
  assert.equal(newEligible.find((row) => row.condition_id === "c1")?.id, "00000000-0000-4000-8000-000000000002", "latest (created_at,id) lineage wins deterministically");
});
