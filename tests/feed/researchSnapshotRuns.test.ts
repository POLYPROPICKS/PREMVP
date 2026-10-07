import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// R1_TWO_COMPLETE_GENERATION_EVENT_UNIVERSE_V1 — completion marker + RPC freshness contract.
// Run with: node --experimental-test-module-mocks --import tsx --test tests/feed/researchSnapshotRuns.test.ts

import type { ResearchEligibleSignalSnapshot } from "../../lib/feed/types";
import { SHADOW_INSERT_CHUNK } from "../../lib/feed/writeBatching";

let upserts = 0;
let failOnChunkIndex: number | null = null;
let markerInserts: { table: string; row: Record<string, unknown> }[] = [];
let markerError: { message: string } | null = null;

mock.module("@/lib/supabase/server", {
  namedExports: {
    supabaseAdmin: {
      from(table: string) {
        return {
          upsert(rows: unknown[]) {
            const i = upserts++;
            if (failOnChunkIndex !== null && i === failOnChunkIndex) return Promise.resolve({ error: { message: "db exploded" }, count: null });
            return Promise.resolve({ error: null, count: rows.length });
          },
          insert(row: Record<string, unknown>) {
            if (markerError) return Promise.resolve({ error: markerError });
            markerInserts.push({ table, row });
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  },
});

const cache = () => import("../../lib/feed/cacheResearchSnapshots");

function reset() {
  upserts = 0;
  failOnChunkIndex = null;
  markerInserts = [];
  markerError = null;
}

function snap(n: number): ResearchEligibleSignalSnapshot {
  return {
    snapshotRunId: "run-1", snapshotAt: "2026-10-07T00:00:00.000Z", expiresAt: "2026-10-08T00:00:00.000Z",
    scope: "RESEARCH_ELIGIBLE_UNIVERSE", conditionId: `c${n}`, selectedTokenId: `t${n}`, opposingTokenId: `t${n}o`,
    productRejectionReasons: [], diagnostics: {}, publicFeedExposed: false,
  } as unknown as ResearchEligibleSignalSnapshot;
}

const RUN = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-07T00:00:00.000Z";

// Mirrors the producer sequence in scripts/generate-signals.ts: marker only after the writer resolved.
async function producerSequence(snapshots: ResearchEligibleSignalSnapshot[]) {
  const { writeResearchEligibleSignalSnapshots, markResearchSnapshotRunComplete } = await cache();
  try {
    const r = await writeResearchEligibleSignalSnapshots({ snapshots });
    await markResearchSnapshotRunComplete({ snapshotRunId: RUN, snapshotAt: AT, rowCount: r.inserted });
    return "COMPLETE";
  } catch {
    return "FAILED";
  }
}

test("A: marker written once, after every chunk persisted, with run id / snapshot_at / row_count", async () => {
  reset();
  const total = SHADOW_INSERT_CHUNK * 2 + 7;
  assert.equal(await producerSequence(Array.from({ length: total }, (_, i) => snap(i))), "COMPLETE");
  assert.equal(upserts, 3);
  assert.equal(markerInserts.length, 1);
  assert.deepEqual(markerInserts[0], { table: "research_snapshot_runs", row: { snapshot_run_id: RUN, snapshot_at: AT, row_count: total } });
});

test("B: any chunk failure -> no completion marker", async () => {
  reset();
  failOnChunkIndex = 1;
  assert.equal(await producerSequence(Array.from({ length: SHADOW_INSERT_CHUNK * 2 + 7 }, (_, i) => snap(i))), "FAILED");
  assert.equal(markerInserts.length, 0);
});

test("B2: marker write failure throws (never a false completion)", async () => {
  reset();
  markerError = { message: "relation missing" };
  const { markResearchSnapshotRunComplete } = await cache();
  await assert.rejects(markResearchSnapshotRunComplete({ snapshotRunId: RUN, snapshotAt: AT, rowCount: 1 }), /Failed to mark research snapshot run complete/);
  assert.equal(markerInserts.length, 0);
});

test("C: zero-row generation writes a marker with row_count=0", async () => {
  reset();
  assert.equal(await producerSequence([]), "COMPLETE");
  assert.equal(upserts, 0);
  assert.equal(markerInserts.length, 1);
  assert.equal(markerInserts[0].row.row_count, 0);
});

test("producer wiring: marker only after the writer succeeds; zero-row boundary marks 0; failure stays non-fatal", () => {
  const src = readFileSync("scripts/generate-signals.ts", "utf8");
  const w = src.indexOf("await writeResearchEligibleSignalSnapshots(");
  const m = src.indexOf("await markResearchRunComplete(researchInserted)");
  const c = src.indexOf("} catch (researchError)");
  assert.ok(w > 0 && m > w && c > m, "marker call sits between the successful write and the catch");
  assert.equal(src.includes("await markResearchRunComplete(0)"), true);
  assert.match(src, /Research run completion marker failed \(non-fatal\)/);
});

const MIG = "supabase/migrations/20261007100000_research_snapshot_runs_two_generation_universe_v1.sql";
const sql = () => readFileSync(MIG, "utf8");
const code = (s: string) => s.replace(/--.*$/gm, "").replace(/COMMENT ON[\s\S]*?;\n/g, "");

test("migration: marker table is insert-only service_role research authority", () => {
  const s = sql();
  assert.equal(s.split("\n")[0], "-- PREMVP_APPLICATION_MIGRATION_V1");
  assert.match(s, /snapshot_run_id uuid PRIMARY KEY/);
  assert.match(s, /completed_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(s, /row_count\s+integer NOT NULL CHECK \(row_count >= 0\)/);
  assert.match(s, /\(completed_at DESC, snapshot_at DESC, snapshot_run_id DESC\)/);
  assert.match(s, /ALTER TABLE public\.research_snapshot_runs ENABLE ROW LEVEL SECURITY/);
  assert.match(s, /REVOKE ALL ON public\.research_snapshot_runs FROM anon, authenticated/);
  assert.match(s, /GRANT SELECT, INSERT ON public\.research_snapshot_runs TO service_role/);
  assert.equal(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b|GRANT[^;]*UPDATE/i.test(code(s)), false);
});

test("D/E/G: RPC takes exactly the two latest completed runs, requires both, and filters GSRS before aggregation", () => {
  const s = sql();
  assert.match(s, /completed_runs AS \(\s*SELECT r\.snapshot_run_id\s+FROM public\.research_snapshot_runs r\s+ORDER BY r\.completed_at DESC, r\.snapshot_at DESC, r\.snapshot_run_id DESC\s+LIMIT 2\s*\)/);
  assert.match(s, /SELECT count\(\*\) = 2 AS ok FROM completed_runs/);
  const src = s.slice(s.indexOf("src AS ("), s.indexOf("keyed AS ("));
  assert.match(src, /g\.snapshot_run_id IN \(SELECT c\.snapshot_run_id FROM completed_runs c\)/);
  assert.match(src, /\(SELECT ok FROM run_gate\)/);
  assert.equal(/age|interval|now\(\)/i.test(src), false, "no wall-clock age heuristic, no daily fallback");
});

test("F/H: carry-forward inside the window; newest snapshot_at owns the physical event; identity semantics untouched", () => {
  const s = sql();
  assert.match(s, /SELECT DISTINCT ON \(k\.physical_key\) k\.physical_key, k\.snapshot_run_id, k\.snapshot_at\s+FROM keyed k\s+ORDER BY k\.physical_key, k\.snapshot_at DESC, k\.snapshot_run_id DESC/);
  assert.match(s, /CASE WHEN s\.game_id IS NOT NULL THEN 'g:' \|\| lower\(s\.game_id\) ELSE 'e:' \|\| lower\(s\.event_id\) END/);
  assert.match(s, /to_char\(s\.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'\)/);
  assert.match(s, /ORDER BY a\.parent_event_volume_24h DESC NULLS LAST, a\.event_start_iso ASC, a\.physical_key ASC/);
  assert.match(s, /LIMIT least\(greatest\(p_ceiling, 1\), 900\) \+ 1/);
  assert.match(s, /g\.game_start_iso >= p_from AND g\.game_start_iso < p_to/);
});

test("I: safety gate and money path untouched; original RPC migration not modified", () => {
  const baseline = readFileSync("lib/executor/reservationMarketBaseline.ts", "utf8");
  assert.match(baseline, /if \(!eventStartMatches\(event, eventStartIso\)\) throw new Error\("RESERVED_EVENT_START_MISMATCH"\)/);
  const original = readFileSync("supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql", "utf8");
  assert.equal(original.includes("research_snapshot_runs"), false);
  assert.equal(/Contract A|reservation|queue|execution/i.test(code(sql())), false);
});
