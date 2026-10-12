// Code <-> schema compatibility: the exact row the shadow cycle builds from an evidence row is inserted into the
// migrated schema on a throwaway Postgres (PREMVP_TEST_PSQL). Skipped when none is configured.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { minskDateNow, runtimeRow, toDatabaseLedger } from "../../scripts/modeling/live-shadow-cycle";
import { selectedByModel, type V4EvidenceRow } from "../../scripts/modeling/prospective-selection-shadow";

const PSQL = process.env.PREMVP_TEST_PSQL;
const skip = PSQL ? false : "PREMVP_TEST_PSQL not set";
const DB = `fwd_payload_${process.pid}_${Date.now()}`;

function psql(db: string, args: string[]) {
  const parts = PSQL!.split(" ");
  const r = spawnSync(parts[0], [...parts.slice(1), "-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", db, ...args], { encoding: "utf8" });
  return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
}
const file = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

before(() => {
  if (skip) return;
  assert.equal(psql("postgres", ["-c", `create database ${DB}`]).ok, true);
  for (const role of ["service_role", "anon", "authenticated"]) psql(DB, ["-c", `do $do$ begin if not exists (select 1 from pg_roles where rolname='${role}') then create role ${role}; end if; end $do$`]);
  for (const rel of ["ops/research-clone/prospective-selection-shadow-runtime-schema.sql", "ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql", "ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql"]) {
    const path = new URL(`../../.payload-compat-${process.pid}.sql`, import.meta.url);
    writeFileSync(path, `begin;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '45s';\n${file(rel)}\ncommit;\n`);
    try { const r = psql(DB, ["-f", path.pathname]); assert.equal(r.ok, true, r.err); } finally { rmSync(path); }
  }
});
after(() => { if (!skip) psql("postgres", ["-c", `drop database if exists ${DB}`]); });

const evidence = (i: number, over: Record<string, unknown> = {}): V4EvidenceRow => ({
  observation_id: `o${i}`, observed_at: new Date(Date.now() - 5 * 60_000).toISOString(), item_observation_id: `i${i}`,
  condition_id: `0xcond${i}`, selected_token_id: `tok${i}`, entry_price_num: 0.505, pre_event_score_num: 64,
  provider_event_id: `EV${i}`, provider_sport_family: "tennis", market_type: "moneyline",
  event_title: `W100 Edmond, OK: Player A${i} vs Player B${i}`, market_question: `W100 Edmond, OK: Player A${i} vs Player B${i}`,
  selected_outcome: `Player A${i}`, game_start_iso: new Date(Date.now() + 4 * 3600_000).toISOString(), data_coverage: 80, ...over,
});

function insertPayload(payload: Record<string, unknown>) {
  const json = JSON.stringify(payload).replaceAll("'", "''");
  return psql(DB, ["-c", `insert into prospective_selection_shadow_runtime select * from json_populate_record(null::prospective_selection_shadow_runtime, '${json}')`]);
}

test("the cycle's real payload satisfies the migrated schema and is classified by the database", { skip }, () => {
  const source = { ...evidence(1), observed_at: new Date(Date.now() - 5 * 60_000).toISOString() };
  const day = minskDateNow(new Date(source.observed_at));
  const [candidate] = selectedByModel([source], day).capped.get("TENNIS_P50_52_SAFE")!;
  assert.ok(candidate, "fixture must be selectable");
  const row = runtimeRow("TENNIS_P50_52_SAFE", day, candidate, source, { scoreLevel: 64, dataCoverage: 80 }, new Date().toISOString());
  const payload = toDatabaseLedger(row);
  const inserted = insertPayload(payload);
  assert.equal(inserted.ok, true, inserted.err);
  const got = psql(DB, ["-c", "select contract_status, timing_class, game_identity_basis, scope_basis, selected_outcome, reference_price, executable_buy_price is null, first_persisted_at is not null, lead_time_authoritative_seconds is null from prospective_selection_shadow_runtime where row_key like 'LEDGER:TENNIS%'"]);
  assert.equal(got.out, "COMPLETE|PRE_START_SCHEDULED_ONLY|TEAM_PAIR_START_TEXT|STRUCTURED_MONEYLINE|Player A1|0.505|t|t|t");
  // the same physical game via a second shard on the next day is refused by the database even if the cycle guard were bypassed
  const shard = { ...source, provider_event_id: "EV1-more-markets", condition_id: "0xcond1b", selected_token_id: "tok1b", observed_at: new Date(Date.now() - 4 * 60_000).toISOString() };
  const second = runtimeRow("TENNIS_P50_52_SAFE", "2026-10-13", { ...candidate, candidateIdentity: "0xcond1b::tok1b::x", physicalEventKey: "EV1-more-markets", decisionTimestamp: shard.observed_at }, shard, { scoreLevel: 64, dataCoverage: 80 }, new Date().toISOString());
  const refused = insertPayload(toDatabaseLedger(second));
  assert.equal(refused.ok, false);
  assert.match(refused.err, /DUPLICATE_ECONOMIC_UNIT/);
});

test("a replayed observation is stored but classified HISTORICAL_REPLAY and is never counted as a forward pre-match BET", { skip }, () => {
  const source = evidence(2, { observed_at: new Date(Date.now() - 6 * 3600_000).toISOString() });
  const day = minskDateNow(new Date(source.observed_at));
  const [candidate] = selectedByModel([source], day).capped.get("TENNIS_P50_52_SAFE")!;
  const row = runtimeRow("TENNIS_P50_52_SAFE", day, candidate, source, { scoreLevel: 64, dataCoverage: 80 }, new Date().toISOString());
  assert.equal(insertPayload(toDatabaseLedger(row)).ok, true);
  assert.equal(psql(DB, ["-c", "select timing_class from prospective_selection_shadow_runtime where physical_event_key='EV2'"]).out, "HISTORICAL_REPLAY");
});
