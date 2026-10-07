import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// R1_TWO_COMPLETE_RESEARCH_GENERATIONS_FRESHNESS_V1 — completion-marker proof.
// Only @/lib/supabase/server is replaced; chunking / marker ordering run as production code.
//
// Run with: node --experimental-test-module-mocks --import tsx --test \
//   tests/feed/researchSnapshotRunMarker.test.ts

import type { ResearchEligibleSignalSnapshot } from "../../lib/feed/types";
import { SHADOW_INSERT_CHUNK } from "../../lib/feed/writeBatching";

let upsertCalls = 0;
let failUpsertOnCall: number | null = null;
let markerInserts: Record<string, unknown>[] = [];
let failMarker = false;
const order: string[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        return {
          upsert(rows: Record<string, unknown>[]) {
            const call = upsertCalls++;
            if (failUpsertOnCall !== null && call === failUpsertOnCall) {
              return Promise.resolve({ error: { message: "db exploded" }, count: null });
            }
            order.push(`chunk:${table}`);
            return Promise.resolve({ error: null, count: rows.length });
          },
          insert(row: Record<string, unknown>) {
            order.push(`insert:${table}`);
            if (failMarker) return Promise.resolve({ error: { message: "marker down" } });
            markerInserts.push({ table, ...row });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  },
});

type CacheModule = typeof import("../../lib/feed/cacheResearchSnapshots");
let cacheModule: CacheModule | null = null;
async function cache(): Promise<CacheModule> {
  if (!cacheModule) cacheModule = await import("../../lib/feed/cacheResearchSnapshots");
  return cacheModule;
}

function reset() {
  upsertCalls = 0;
  failUpsertOnCall = null;
  markerInserts = [];
  failMarker = false;
  order.length = 0;
}

const RUN = "6f1c1f0e-0000-4000-8000-000000000001";
const AT = "2026-10-07T10:00:00.000Z";

function snapshot(n: number): ResearchEligibleSignalSnapshot {
  return {
    snapshotRunId: RUN,
    snapshotAt: AT,
    expiresAt: "2026-10-08T10:00:00.000Z",
    scope: "RESEARCH_ELIGIBLE_UNIVERSE",
    conditionId: `cond-${n}`,
    selectedTokenId: `tok-${n}`,
    opposingTokenId: `tok-${n}-opp`,
    productRejectionReasons: [],
    diagnostics: {},
    publicFeedExposed: false,
  } as unknown as ResearchEligibleSignalSnapshot;
}

test("1: marker is written once, after the last chunk, with exact run id / snapshot_at / row_count", async () => {
  reset();
  const { writeResearchSnapshotGeneration } = await cache();
  const total = SHADOW_INSERT_CHUNK * 2 + 7;
  const snapshots = Array.from({ length: total }, (_, i) => snapshot(i));
  const result = await writeResearchSnapshotGeneration({ snapshotRunId: RUN, snapshotAt: AT, snapshots });
  assert.equal(result.inserted, total);
  assert.deepEqual(markerInserts, [
    { table: "research_snapshot_runs", snapshot_run_id: RUN, snapshot_at: AT, row_count: total },
  ]);
  assert.deepEqual(order, [
    "chunk:generated_signal_research_snapshots",
    "chunk:generated_signal_research_snapshots",
    "chunk:generated_signal_research_snapshots",
    "insert:research_snapshot_runs",
  ]);
});

test("2: any chunk failure -> zero completion markers (marker write is never reached)", async () => {
  for (const failAt of [0, 1, 2]) {
    reset();
    failUpsertOnCall = failAt;
    const { writeResearchSnapshotGeneration } = await cache();
    const snapshots = Array.from({ length: SHADOW_INSERT_CHUNK * 2 + 7 }, (_, i) => snapshot(i));
    await assert.rejects(
      () => writeResearchSnapshotGeneration({ snapshotRunId: RUN, snapshotAt: AT, snapshots }),
      /db exploded/,
    );
    assert.equal(markerInserts.length, 0, `no marker when chunk ${failAt} fails`);
    assert.equal(order.includes("insert:research_snapshot_runs"), false);
  }
});

test("3: zero-row generation that reaches the persistence boundary is marked complete with row_count = 0", async () => {
  reset();
  const { writeResearchSnapshotGeneration } = await cache();
  const result = await writeResearchSnapshotGeneration({ snapshotRunId: RUN, snapshotAt: AT, snapshots: [] });
  assert.equal(result.inserted, 0);
  assert.equal(upsertCalls, 0, "no snapshot upsert for an empty generation");
  assert.deepEqual(markerInserts, [
    { table: "research_snapshot_runs", snapshot_run_id: RUN, snapshot_at: AT, row_count: 0 },
  ]);
});

test("marker-write failure surfaces as a bounded error and records nothing", async () => {
  reset();
  failMarker = true;
  const { writeResearchSnapshotGeneration } = await cache();
  await assert.rejects(
    () => writeResearchSnapshotGeneration({ snapshotRunId: RUN, snapshotAt: AT, snapshots: [snapshot(1)] }),
    /Failed to mark research snapshot run complete: marker down \(run .*, 1 rows\)/,
  );
  assert.equal(markerInserts.length, 0);
});

test("producer uses the generation writer for both the non-empty and the zero-row path, still non-fatal", () => {
  const src = readFileSync("scripts/generate-signals.ts", "utf8");
  assert.equal(src.includes("writeResearchEligibleSignalSnapshots"), false);
  assert.equal((src.match(/await writeResearchSnapshotGeneration\(/g) ?? []).length, 2);
  assert.match(src, /Research snapshot write failed \(non-fatal\)/);
  assert.match(src, /Research generation marker write failed \(non-fatal\)/);
});

test("9: safety surface unchanged - the T20 runtime never reads the marker table and the RPC body only gained the two run filters", () => {
  const runtime = readFileSync("lib/executor/precontractT20Research.ts", "utf8");
  assert.equal(runtime.includes("research_snapshot_runs"), false);
  const oldSql = readFileSync("supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql", "utf8");
  const newSql = readFileSync("supabase/migrations/20261007100000_research_snapshot_runs_two_generation_freshness_v1.sql", "utf8");
  const fn = (s: string) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION"), s.indexOf("$$;") + 3);
  const stripped = fn(newSql)
    .replace(/WITH completed_runs AS \([\s\S]*?LIMIT 2\n  \),\n  src AS \(/, "WITH src AS (")
    .replace(/\n      AND \(SELECT count\(\*\) FROM completed_runs\) = 2\n      AND g\.snapshot_run_id IN \(SELECT c\.snapshot_run_id FROM completed_runs c\)/, "");
  assert.equal(stripped, fn(oldSql), "RPC signature, columns, identity, ranking, ceiling are byte-identical outside the freshness filter");
  assert.match(newSql, /GRANT SELECT, INSERT ON public\.research_snapshot_runs TO service_role;/);
  assert.equal(/\bDELETE\b|\bUPDATE\b|\bjsonb?\b/i.test(newSql.replace(/--.*$/gm, "").replace(/'[^']*'/g, "").replace(fn(newSql), "")), false);
});
