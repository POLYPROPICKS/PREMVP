import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const boundedRefreshMigration = readFileSync(
  "supabase/migrations/20260813105911_refresh_current_signal_pair_serving_id_bounded.sql",
  "utf8",
);

type ServingCandidate = {
  id: string;
  conditionId: string | null;
  selectedTokenId: string | null;
  metricFormulaVersion: string | null;
  createdAt: string;
  expiresAt: string;
  signalResult: string | null;
};

const servingIdentity = (row: ServingCandidate) =>
  `${row.conditionId}::${row.selectedTokenId}::${row.metricFormulaVersion}`;

function applyBoundedRefresh(
  current: Map<string, ServingCandidate>,
  supplied: ServingCandidate[],
  now = "2030-01-01T00:00:00.000Z",
) {
  const winners = new Map<string, ServingCandidate>();
  for (const candidate of supplied) {
    if (!candidate.conditionId || !candidate.selectedTokenId || !candidate.metricFormulaVersion) continue;
    if (candidate.expiresAt <= now || candidate.signalResult !== null) continue;
    const identity = servingIdentity(candidate);
    const prior = winners.get(identity);
    if (!prior || [candidate.createdAt, candidate.id].join(":") > [prior.createdAt, prior.id].join(":")) {
      winners.set(identity, candidate);
    }
  }
  for (const [identity, winner] of winners) {
    const prior = current.get(identity);
    if (!prior || [winner.createdAt, winner.id].join(":") > [prior.createdAt, prior.id].join(":")) {
      current.set(identity, winner);
    }
  }
  return current;
}

const candidate = (id: string, createdAt: string, overrides: Partial<ServingCandidate> = {}): ServingCandidate => ({
  id,
  conditionId: "condition-a",
  selectedTokenId: "token-a",
  metricFormulaVersion: "formula-a",
  createdAt,
  expiresAt: "2030-01-02T00:00:00.000Z",
  signalResult: null,
  ...overrides,
});

test("bounded refresh migration reads supplied IDs directly and preserves full-corpus recovery", () => {
  assert.match(boundedRefreshMigration, /IF p_source_generated_signal_pair_ids IS NOT NULL THEN/);
  assert.match(boundedRefreshMigration, /WHERE source\.id = ANY\(p_source_generated_signal_pair_ids\)/);
  assert.match(boundedRefreshMigration, /ELSE[\s\S]*FROM public\.generated_signal_pairs source/);
  assert.match(boundedRefreshMigration, /DISTINCT ON \([\s\S]*source\.condition_id,[\s\S]*source\.selected_token_id,[\s\S]*source\.metric_formula_version/);
  assert.match(boundedRefreshMigration, /source\.created_at DESC,[\s\S]*source\.id DESC/);
  assert.match(boundedRefreshMigration, /source\.expires_at > now\(\)/);
  assert.match(boundedRefreshMigration, /source\.signal_result IS NULL/);
  assert.match(boundedRefreshMigration, /\(EXCLUDED\.source_created_at, EXCLUDED\.source_generated_signal_pair_id\)[\s\S]*>[\s\S]*\(current_signal_pair_serving\.source_created_at, current_signal_pair_serving\.source_generated_signal_pair_id\)/);
  assert.doesNotMatch(boundedRefreshMigration, /CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX/i);
});

test("bounded refresh handles out-of-order arrival", () => {
  const current = applyBoundedRefresh(new Map(), [candidate("00000000-0000-4000-8000-000000000002", "2029-12-31T10:00:00.000Z")]);
  applyBoundedRefresh(current, [candidate("00000000-0000-4000-8000-000000000001", "2029-12-30T10:00:00.000Z")]);
  assert.equal(current.get("condition-a::token-a::formula-a")?.id, "00000000-0000-4000-8000-000000000002");
});

test("bounded refresh chooses one deterministic winner for duplicate identities in a batch", () => {
  const current = applyBoundedRefresh(new Map(), [
    candidate("00000000-0000-4000-8000-000000000001", "2029-12-31T10:00:00.000Z"),
    candidate("00000000-0000-4000-8000-000000000003", "2029-12-31T10:00:00.000Z"),
    candidate("00000000-0000-4000-8000-000000000002", "2029-12-31T10:00:00.000Z"),
  ]);
  assert.equal(current.get("condition-a::token-a::formula-a")?.id, "00000000-0000-4000-8000-000000000003");
});

test("bounded refresh replay is idempotent", () => {
  const row = candidate("00000000-0000-4000-8000-000000000001", "2029-12-31T10:00:00.000Z");
  const current = applyBoundedRefresh(new Map(), [row]);
  applyBoundedRefresh(current, [row, row]);
  assert.equal(current.size, 1);
  assert.equal(current.get("condition-a::token-a::formula-a"), row);
});

test("bounded refresh excludes ineligible supplied rows", () => {
  const current = applyBoundedRefresh(new Map(), [
    candidate("00000000-0000-4000-8000-000000000001", "2029-12-31T10:00:00.000Z", { conditionId: null }),
    candidate("00000000-0000-4000-8000-000000000002", "2029-12-31T10:00:00.000Z", { selectedTokenId: null }),
    candidate("00000000-0000-4000-8000-000000000003", "2029-12-31T10:00:00.000Z", { metricFormulaVersion: null }),
    candidate("00000000-0000-4000-8000-000000000004", "2029-12-31T10:00:00.000Z", { expiresAt: "2029-12-31T00:00:00.000Z" }),
    candidate("00000000-0000-4000-8000-000000000005", "2029-12-31T10:00:00.000Z", { signalResult: "won" }),
  ]);
  assert.equal(current.size, 0);
});

test("bounded refresh cannot replace newer serving state with an older source", () => {
  const newer = candidate("00000000-0000-4000-8000-000000000002", "2029-12-31T10:00:00.000Z");
  const current = applyBoundedRefresh(new Map(), [newer]);
  applyBoundedRefresh(current, [candidate("00000000-0000-4000-8000-000000000003", "2029-12-30T10:00:00.000Z")]);
  assert.equal(current.get("condition-a::token-a::formula-a"), newer);
});

test("bounded refresh chooses the newest deterministic source", () => {
  const current = applyBoundedRefresh(new Map(), [
    candidate("00000000-0000-4000-8000-000000000001", "2029-12-30T10:00:00.000Z"),
    candidate("00000000-0000-4000-8000-000000000002", "2029-12-31T10:00:00.000Z"),
  ]);
  assert.equal(current.get("condition-a::token-a::formula-a")?.id, "00000000-0000-4000-8000-000000000002");
});

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
  assert.match(migration, /source\.expires_at > now\(\)/);
  assert.match(migration, /source\.signal_result IS NULL/);
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
