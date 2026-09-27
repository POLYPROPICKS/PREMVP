import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Bounded research snapshot persistence ───────────────────────────────────
// Mirrors the fake-DB-boundary pattern used in producerIdentityConservation.test.ts:
// only @/lib/supabase/server is replaced; toResearchSnapshotRow / chunking / upsert
// call sites run as real production code.
//
// Run with: node --experimental-test-module-mocks --import tsx --test \
//   tests/feed/cacheResearchSnapshots.test.ts

import type { ResearchEligibleSignalSnapshot } from "../../lib/feed/types";
import { SHADOW_INSERT_CHUNK } from "../../lib/feed/writeBatching";

let upsertedChunks: Record<string, unknown>[][] = [];
let upsertOnConflict: string[] = [];
let failOnChunkIndex: number | null = null;
let upsertCallCount = 0;

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(_table: string) {
        return {
          upsert(rows: Record<string, unknown>[], opts: { onConflict: string }) {
            const callIndex = upsertCallCount++;
            upsertOnConflict.push(opts.onConflict);
            if (failOnChunkIndex !== null && callIndex === failOnChunkIndex) {
              return Promise.resolve({ error: { message: "db exploded" }, count: null });
            }
            upsertedChunks.push(rows);
            return Promise.resolve({ error: null, count: rows.length });
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
  upsertedChunks = [];
  upsertOnConflict = [];
  failOnChunkIndex = null;
  upsertCallCount = 0;
}

function snapshot(n: number): ResearchEligibleSignalSnapshot {
  return {
    snapshotRunId: "run-1",
    snapshotAt: "2026-09-27T00:00:00.000Z",
    expiresAt: "2026-09-28T00:00:00.000Z",
    scope: "RESEARCH_ELIGIBLE_UNIVERSE",
    conditionId: `cond-${n}`,
    selectedTokenId: `tok-${n}`,
    opposingTokenId: `tok-${n}-opp`,
    productRejectionReasons: [],
    diagnostics: {},
    publicFeedExposed: false,
  } as unknown as ResearchEligibleSignalSnapshot;
}

test("empty input never hits Supabase", async () => {
  reset();
  const { writeResearchEligibleSignalSnapshots } = await cache();
  const result = await writeResearchEligibleSignalSnapshots({ snapshots: [] });
  assert.deepEqual(result, { inserted: 0 });
  assert.equal(upsertCallCount, 0);
});

test("a batch under the bound is written in a single upsert", async () => {
  reset();
  const { writeResearchEligibleSignalSnapshots } = await cache();
  const snapshots = Array.from({ length: 10 }, (_, i) => snapshot(i));
  const result = await writeResearchEligibleSignalSnapshots({ snapshots });
  assert.equal(result.inserted, 10);
  assert.equal(upsertCallCount, 1);
});

test("a batch exceeding the bound is split into multiple upserts, none lost", async () => {
  reset();
  const { writeResearchEligibleSignalSnapshots } = await cache();
  const total = SHADOW_INSERT_CHUNK * 2 + 137;
  const snapshots = Array.from({ length: total }, (_, i) => snapshot(i));
  const result = await writeResearchEligibleSignalSnapshots({ snapshots });

  assert.equal(result.inserted, total, "total inserted accounting must equal every proposed row");
  assert.equal(upsertCallCount, 3, "three chunks: two full + one remainder");
  for (const chunk of upsertedChunks.slice(0, 2)) {
    assert.equal(chunk.length, SHADOW_INSERT_CHUNK);
  }
  assert.equal(upsertedChunks[2].length, 137);

  const allConditionIds = upsertedChunks.flat().map((r) => r.condition_id);
  assert.equal(new Set(allConditionIds).size, total, "no duplicate rows across chunks");
});

test("every chunk upserts with the exact conflict identity", async () => {
  reset();
  const { writeResearchEligibleSignalSnapshots } = await cache();
  const snapshots = Array.from({ length: SHADOW_INSERT_CHUNK + 5 }, (_, i) => snapshot(i));
  await writeResearchEligibleSignalSnapshots({ snapshots });
  assert.ok(upsertOnConflict.length >= 2);
  for (const onConflict of upsertOnConflict) {
    assert.equal(onConflict, "snapshot_run_id,condition_id,selected_token_id");
  }
});

test("a failed chunk is attributable and not reported as full success", async () => {
  reset();
  failOnChunkIndex = 1; // second chunk fails
  const { writeResearchEligibleSignalSnapshots } = await cache();
  const total = SHADOW_INSERT_CHUNK * 2 + 10;
  const snapshots = Array.from({ length: total }, (_, i) => snapshot(i));

  await assert.rejects(
    () => writeResearchEligibleSignalSnapshots({ snapshots }),
    (err: Error) => {
      assert.match(err.message, /db exploded/);
      assert.match(err.message, new RegExp(`after ${SHADOW_INSERT_CHUNK} of ${total} rows`));
      return true;
    },
  );
  // Only the first chunk actually persisted before the failure.
  assert.equal(upsertedChunks.length, 1);
  assert.equal(upsertedChunks[0].length, SHADOW_INSERT_CHUNK);
});
