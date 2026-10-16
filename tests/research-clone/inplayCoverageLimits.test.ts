import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIVE_INPLAY_COVERAGE_STAGE, INPLAY_COVERAGE_STAGES, INPLAY_SYNC_MAX_PAGES } from "../../lib/research/inplayCoverageLimits";

const original = readFileSync("supabase/migrations/20261008090000_research_inplay_core_path_v1.sql", "utf8");
const migration = readFileSync("supabase/migrations/20261016071238_research_inplay_coverage_200_v1.sql", "utf8");
test("stage-200 writer changes only daily counts, preserving every existing writer guard", () => {
  const expected = original.slice(original.indexOf("CREATE FUNCTION public.research_insert_inplay_core_path"))
    .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace("v_rows >= 20000", "v_rows >= 40000").replace("v_events >= 100", "v_events >= 200");
  assert.equal(migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION")).replace(/\r\n/g, "\n"), expected.replace(/\r\n/g, "\n"));
  assert.equal(ACTIVE_INPLAY_COVERAGE_STAGE, 200);
});
test("all authorized stages fit the logical-byte envelope without relaxing per-match bounds", () => {
  for (const stage of [100, 200, 300] as const) {
    const cap = INPLAY_COVERAGE_STAGES[stage];
    assert.equal(cap.events, stage);
    assert.equal(cap.rows, stage * 200);
    assert.equal(cap.logicalMb, stage / 5);
    assert.ok(cap.events * 192 * 1000 <= cap.logicalMb * 1e6);
    assert.ok(cap.rows * 1000 <= cap.logicalMb * 1e6);
    assert.ok(INPLAY_SYNC_MAX_PAGES * 200 * 24 > cap.rows);
  }
});
test("only in-play transport receives the expanded page allowance", () => {
  const sync = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
  assert.match(sync, /spec\.table === "research_inplay_core_path_observations" \? INPLAY_SYNC_MAX_PAGES : spec\.telemetry \? TELEMETRY_MAX_PAGES : MAX_APPEND_PAGES/);
  assert.match(sync, /const TELEMETRY_MAX_PAGES = 8/);
  const listener = readFileSync("scripts/research-inplay-core-path.ts", "utf8");
  assert.match(listener, /latest\.size > INPLAY_COVERAGE_LIMITS.events \|\| pending.length > INPLAY_COVERAGE_LIMITS.events/);
});
