import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPECS } from "../../scripts/research-clone-daily-sync";
import { runAppendSync, TELEMETRY_PURGE_ORDER, type Watermark } from "../../lib/research-clone/dailySync";

const TABLE = "research_precontract_t20_observations";

// Every persisted column of the production carrier (migration 20261007090000).
const PRODUCTION_CARRIER_COLUMNS = [
  "id", "physical_event_id", "provider_game_id", "provider_event_id", "source_id", "source_version",
  "event_start_iso", "observed_at", "observation_phase",
  "parent_event_volume_24h", "daily_volume_rank", "sampling_bucket",
  "provider_sport_family", "provider_sport_code", "provider_sport_source",
  "condition_id", "token_id", "side",
  "canonical_market_family", "canonical_market_type", "provider_market_type_raw", "market_slug",
  "best_bid", "best_ask", "tick_size", "minimum_order_size", "orderbook_fetch_status",
  "requested_stake_usd", "execution_price_cap", "ask_depth_relevant_usd", "full_stake_executable_vwap",
  "full_stake_shares", "executable_full_stake", "executable_full_stake_state",
  "taker_fee_state", "taker_fee_usd",
] as const;

const spec = () => SPECS.find((entry) => entry.table === TABLE);

test("R2: T20 carrier SPEC is an append-only, narrow, bounded watermark keyset", () => {
  const s = spec();
  assert.ok(s);
  assert.deepEqual(s.fields, ["observed_at", "id"]);
  assert.equal(s.appendOnly, true);
  assert.equal(s.telemetry, true);
  assert.equal(s.optional, true);
  assert.equal(s.bootstrapSince, "2026-10-07T00:00:00.000Z");
  const projection = s.projection ?? "";
  assert.notEqual(projection, "");
  assert.doesNotMatch(projection, /\*|json|diagnostic|payload|raw_|book_levels/i);
});

test("R2: projection is exactly the production carrier columns and the migration declares them all", () => {
  const projected = (spec()?.projection ?? "").split(",");
  assert.deepEqual([...projected].sort(), [...PRODUCTION_CARRIER_COLUMNS].sort());
  const migration = readFileSync("supabase/migrations/20261007090000_precontract_t20_research_observations_v1.sql", "utf8");
  const migrationTable = migration.slice(migration.indexOf(`public.${TABLE} (`), migration.indexOf("CONSTRAINT uq_rp_t20_obs_identity"));
  for (const column of PRODUCTION_CARRIER_COLUMNS) {
    assert.match(migrationTable, new RegExp(`^\\s+${column}\\s`, "m"), `production ${column}`);
  }
});

test("R2: clone schema is clone-only, carries every projected column, identity, watermark index, RLS and grants", () => {
  const sql = readFileSync("ops/research-clone/precontract-t20-research-schema.sql", "utf8");
  for (const column of PRODUCTION_CARRIER_COLUMNS) {
    assert.match(sql, new RegExp(`^\\s+${column}\\s`, "m"), `clone ${column}`);
  }
  assert.match(sql, /id\s+uuid PRIMARY KEY/);
  assert.match(sql, /UNIQUE \(physical_event_id, condition_id, token_id, side\)/);
  assert.match(sql, /ON public\.research_precontract_t20_observations \(observed_at, id\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\.research_precontract_t20_observations FROM anon, authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.research_precontract_t20_observations TO service_role/);
  assert.doesNotMatch(sql, /CREATE (OR REPLACE )?FUNCTION/i);
});

test("R2: repeated append sync of the carrier keyset is idempotent", async () => {
  const s = spec();
  assert.ok(s);
  const row = { id: "22222222-2222-4222-8222-222222222222", observed_at: "2026-10-07T12:00:00.000Z" };
  const target = new Map<string, typeof row>();
  let checkpoint: Watermark | null = null;
  const sync = () => runAppendSync(s.fields, 2, {
    async sourceMaxWatermark() { return { observed_at: row.observed_at, id: row.id }; },
    async targetMaxWatermark() { return target.size ? { observed_at: row.observed_at, id: row.id } : null; },
    async readCheckpoint() { return checkpoint; },
    async fetchSourcePage(after) { return !after || after.observed_at < row.observed_at ? [row] : []; },
    async upsertTargetRows(rows) { for (const item of rows) target.set(item.id, item); return { newRows: rows.length, updatedRows: 0, duplicateN: 0 }; },
    async writeCheckpoint(value) { checkpoint = value; },
  }, s.bootstrapSince ?? null);
  assert.equal((await sync()).newRows, 1);
  assert.equal((await sync()).newRows, 0);
  assert.equal(target.size, 1);
});

test("R2 wall: carrier is transport-only — not in TELEMETRY_PURGE_ORDER and no production delete path names it", () => {
  assert.equal((TELEMETRY_PURGE_ORDER as readonly string[]).includes(TABLE), false);
  const script = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
  const deletes = script.match(/\.delete\(\)/g) ?? [];
  assert.equal(deletes.length, 1, "only the pre-existing confirmed-telemetry purge delete exists");
  const purgeOrder = readFileSync("lib/research-clone/dailySync.ts", "utf8");
  assert.doesNotMatch(purgeOrder, new RegExp(TABLE));
});
