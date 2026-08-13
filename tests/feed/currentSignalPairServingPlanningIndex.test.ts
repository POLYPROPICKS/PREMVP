import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260813193000_current_signal_pair_serving_planning_scored_index.sql",
);

test("current-serving scored Planning query has an order-compatible partial index", () => {
  assert.equal(fs.existsSync(migrationPath), true, "planning index migration must exist");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_csps_planning_scored_rows/i);
  assert.match(
    sql,
    /ON public\.current_signal_pair_serving\s+\(source_created_at DESC, source_generated_signal_pair_id DESC\)/i,
  );
  assert.match(sql, /projection_status = 'ACTIVE'/i);
  assert.match(sql, /signal_result IS NULL/i);
  assert.match(sql, /entry_price_num IS NOT NULL/i);
  assert.match(sql, /signal_confidence_num >= 50/i);
  assert.match(
    sql,
    /metric_formula_version IN \('v2-lite-growth-safe', 'shadow-firemodel1_1_research_v0'\)/i,
  );
  assert.doesNotMatch(sql, /expires_at\s*>\s*now\(\)/i);
});
