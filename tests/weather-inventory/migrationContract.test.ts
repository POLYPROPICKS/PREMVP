import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = resolve(process.cwd(), "supabase/migrations/20260724_weather_inventory_foundation.sql");

test("weather migration declares only the minimal inventory contour and raw lineage", () => {
  const sql = readFileSync(migrationPath, "utf8");
  for (const table of ["weather_collector_runs", "weather_capture_cohorts", "weather_raw_objects", "weather_venue_markets", "weather_contracts"]) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, "i"));
  }
  assert.match(sql, /weather_venue_markets[\s\S]*raw_object_id uuid not null/i);
  assert.match(sql, /weather_contracts[\s\S]*raw_object_id uuid not null/i);
  assert.match(sql, /unique \(source_contract_id, condition_id\)/i);
  assert.match(sql, /unique \(weather_venue_market_id, token_id\)/i);
  assert.doesNotMatch(sql, /\b(alter|drop)\s+table\s+(?!public\.weather_)/i);
});

test("migration artifact explicitly records its non-proofs", () => {
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /POSTGRES_CONCURRENCY_NOT_PROVEN/);
  assert.match(sql, /MIGRATION_APPLY_NOT_PROVEN/);
});
