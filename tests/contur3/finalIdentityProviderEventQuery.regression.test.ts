// Regression for EXACT_PROVIDER_EVENT_QUERY_FAILED_57014 (node:test via tsx):
//   node --import tsx --test tests/contur3/*.test.ts
//
// Proven production evidence (2026-08-10 Europe/Minsk cohort): 15/15 natural
// Reservations reached T-70, 15/15 ended SKIPPED with
// selection_reason=EXACT_PROVIDER_EVENT_QUERY_FAILED_57014, 0 Queue rows
// created. Root cause: the sibling lookup in
// lib/executor/eventExecutionQueue.ts (loadFinalIdentitySourceRows) used
// `.contains("diagnostics", { providerEventContext: {...} })` -- a JSONB
// containment predicate Postgres can only serve with a full sequential scan
// over public.generated_signal_pairs, which this repo has already proven
// (idx_gsp_shadow_dedup, idx_gsp_pending_resolution) exceeds the statement
// timeout at production row counts.
//
// This file proves two things without a live database:
//   1. The production query no longer emits the pathological `.contains(...)`
//      shape -- it filters on extracted providerEventContext fields instead.
//   2. Reproduced against a production-shaped in-memory row set (many
//      unrelated rows + a true sibling universe + near-miss rows), the new
//      bounded filter shape returns the EXACT SAME sibling universe the old
//      `.contains(...)` shape would have returned, and still returns nothing
//      for a wrong provider event id / start / identity shape (fail-closed
//      preserved).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Row = { id: string; diagnostics: Record<string, unknown> };

// Mirrors what Postgres `diagnostics @> {"providerEventContext": {...}}`
// (the OLD, now-removed query shape) actually matches: every key in the
// probe object must be present with an equal value inside
// diagnostics.providerEventContext. This is the baseline the new bounded
// filters must reproduce exactly.
function oldContainsShapeMatch(row: Row, probe: Record<string, string>): boolean {
  const ctx = row.diagnostics?.providerEventContext as Record<string, unknown> | undefined;
  if (!ctx || typeof ctx !== "object") return false;
  return Object.entries(probe).every(([k, v]) => ctx[k] === v);
}

// Mirrors the NEW query shape: four `.eq("diagnostics->providerEventContext->>field", value)`
// filters, i.e. PostgREST/Postgres `->>'field'` text extraction compared by
// exact string equality -- the same field set, applied as flat equality
// instead of nested containment.
function newBoundedShapeMatch(row: Row, probe: Record<string, string>): boolean {
  const ctx = row.diagnostics?.providerEventContext as Record<string, unknown> | undefined;
  if (!ctx || typeof ctx !== "object") return false;
  return Object.entries(probe).every(([k, v]) => String((ctx as Record<string, unknown>)[k] ?? "") === v);
}

function makeRow(id: string, ctx: Record<string, unknown> | null): Row {
  return { id, diagnostics: ctx ? { providerEventContext: ctx } : {} };
}

test("production Final Identity sibling lookup no longer uses the pathological broad diagnostics scan", () => {
  const source = readFileSync(path.join(root, "lib/executor/eventExecutionQueue.ts"), "utf8");
  const start = source.indexOf("async loadFinalIdentitySourceRows(reservation)");
  const end = source.indexOf("async findQueueRowsByRebalanceRunId", start);
  assert.ok(start >= 0 && end > start, "expected the production Final Identity source loader");
  const loader = source.slice(start, end);

  assert.doesNotMatch(
    loader,
    /\.contains\(\s*"diagnostics"/,
    "the broad, unindexed diagnostics containment scan must be gone"
  );
  assert.match(
    loader,
    /\.eq\("diagnostics->providerEventContext->>eventId",\s*eventId\)/,
    "the sibling lookup must filter on the exact provider_event_id (eventId)"
  );
  assert.match(
    loader,
    /\.eq\("diagnostics->providerEventContext->>eventStartIso",\s*eventStartIso\)/,
    "the sibling lookup must filter on the exact authoritative event start (eventStartIso)"
  );
  assert.match(
    loader,
    /\.eq\("diagnostics->providerEventContext->>v",\s*"v1"\)/,
    "the identity-shape version guard must be preserved"
  );
  assert.match(
    loader,
    /\.eq\("diagnostics->providerEventContext->>provider",\s*"polymarket"\)/,
    "the provider guard must be preserved"
  );
});

test("a supporting expression index exists for the new bounded filter shape", () => {
  const migration = readFileSync(
    path.join(root, "supabase/migrations/20260811_generated_signal_pairs_provider_event_context_index.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gsp_provider_event_context/);
  assert.match(migration, /diagnostics\s*->\s*'providerEventContext'\s*->>\s*'eventId'/);
  assert.match(migration, /diagnostics\s*->\s*'providerEventContext'\s*->>\s*'eventStartIso'/);
  assert.doesNotMatch(migration, /ALTER TABLE|DROP COLUMN|ADD COLUMN/i, "index-only: no table/column schema change");
});

test("production-shaped regression: new bounded filters return the identical sibling universe the old broad scan would have, and stay fail-closed for wrong identity", () => {
  const trueContext = { v: "v1", provider: "polymarket", eventId: "826073", eventStartIso: "2026-08-10T18:00:00.000Z" };

  // Production-shaped noise: many unrelated rows across other physical
  // events, none matching the target identity.
  const noise: Row[] = [];
  for (let i = 0; i < 2000; i++) {
    noise.push(
      makeRow(`noise-${i}`, {
        v: "v1",
        provider: "polymarket",
        eventId: `unrelated-${i}`,
        eventStartIso: "2026-08-09T12:00:00.000Z",
      })
    );
  }

  // The true sibling universe: same physical event (same eventId +
  // eventStartIso), three different markets/condition_ids -- exactly what
  // Contract A's exact sibling selection must see.
  const siblings: Row[] = [
    makeRow("sib-1", { ...trueContext, market: "moneyline-team-a" }),
    makeRow("sib-2", { ...trueContext, market: "moneyline-team-b" }),
    makeRow("sib-3", { ...trueContext, market: "spread-team-a" }),
  ];

  // Near-miss rows that must NOT be returned: right eventId, wrong start;
  // right start, wrong eventId; right identity but wrong provider/version.
  const nearMisses: Row[] = [
    makeRow("miss-start", { ...trueContext, eventStartIso: "2026-08-10T18:05:00.000Z" }),
    makeRow("miss-event", { ...trueContext, eventId: "826074" }),
    makeRow("miss-provider", { ...trueContext, provider: "kalshi" }),
    makeRow("miss-version", { ...trueContext, v: "v2" }),
    makeRow("no-context", null as unknown as Record<string, unknown>),
  ];

  const table = [...noise, ...siblings, ...nearMisses];

  const oldMatches = table.filter((r) => oldContainsShapeMatch(r, trueContext)).map((r) => r.id).sort();
  const newMatches = table.filter((r) => newBoundedShapeMatch(r, trueContext)).map((r) => r.id).sort();

  assert.deepEqual(newMatches, oldMatches, "the bounded filter shape must select the exact same row set as the old containment shape");
  assert.deepEqual(newMatches, ["sib-1", "sib-2", "sib-3"], "the exact sibling universe must be returned, nothing else");

  // Fail-closed: wrong identity (e.g. Contract A lineage pointing at the
  // wrong provider event) must still return zero rows under both shapes.
  const wrongContext = { v: "v1", provider: "polymarket", eventId: "does-not-exist", eventStartIso: "2026-08-10T18:00:00.000Z" };
  assert.equal(table.filter((r) => oldContainsShapeMatch(r, wrongContext)).length, 0);
  assert.equal(table.filter((r) => newBoundedShapeMatch(r, wrongContext)).length, 0);
});
