import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildForwardBetColumns } from "../../lib/modeling/forwardBetContract";
import { runtimeRow, toDatabaseLedger } from "../../scripts/modeling/live-shadow-cycle";
import { selectedByModel, type V4EvidenceRow } from "../../scripts/modeling/prospective-selection-shadow";

const sql = readFileSync(new URL("../../ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql", import.meta.url), "utf8");
const addedColumns = new Set([...sql.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]));
const DB_COMPUTED = ["first_persisted_at", "timing_class", "timing_detail", "contract_status", "verification_status", "observation_lag_seconds", "lead_time_scheduled_seconds", "lead_time_authoritative_seconds"];

const source: V4EvidenceRow = {
  observation_id: "o1", observed_at: "2026-10-12T10:01:00.000Z", item_observation_id: "i1", condition_id: "0xc1", selected_token_id: "t1",
  entry_price_num: 0.505, pre_event_score_num: 64, provider_event_id: "EV1", provider_sport_family: "tennis", market_type: "moneyline",
  event_title: "W100: Player A vs Player B", market_question: "W100: Player A vs Player B", selected_outcome: "Player A",
  game_start_iso: "2026-10-12T17:00:00.000Z", data_coverage: 80,
};

test("every contract column the application writes exists in the reviewed SQL, and database-owned columns are never written", () => {
  const [candidate] = selectedByModel([source], "2026-10-12").capped.get("TENNIS_P50_52_SAFE")!;
  const columns = buildForwardBetColumns({ model: "TENNIS_P50_52_SAFE", source, candidate, decisionGeneratedAt: "2026-10-12T10:02:00.000Z" });
  for (const key of Object.keys(columns)) assert.equal(addedColumns.has(key), true, `payload column missing from migration: ${key}`);
  for (const key of DB_COMPUTED) {
    assert.equal(addedColumns.has(key) || key === "first_persisted_at", true, `computed column not in migration: ${key}`);
    assert.equal(key in columns, false, `application must not write ${key}`);
    assert.equal(key in toDatabaseLedger(runtimeRow("TENNIS_P50_52_SAFE", "2026-10-12", candidate, source, { scoreLevel: 64, dataCoverage: 80 }, "2026-10-12T10:02:00.000Z")), false, `payload must not write ${key}`);
  }
  // authoritative start and executable BUY price are never fabricated by the writer
  assert.deepEqual([columns.authoritative_start_at, columns.authoritative_start_source, columns.executable_buy_price, columns.executable_price_authority, columns.provider_root_game_id, columns.provider_root_game_source], [null, null, null, null, null, null]);
});

test("the SQL vocabulary equals the application vocabulary", () => {
  const timing = ["PRE_START_AUTHORITATIVE", "PRE_START_SCHEDULED_ONLY", "LATE_OR_REPLAY", "TIMING_UNPROVEN"];
  for (const value of timing) assert.match(sql, new RegExp(`'${value}'`), value);
  for (const value of ["PROVIDER_ROOT_CONFIRMED", "TEAM_PAIR_START_DEDUP", "PROVIDER_EVENT_ONLY", "POLYMARKET_GAMMA_GAME_ID", "OFFICIAL_SOURCE_CONFIRMED_START", "PROVIDER_PUBLISHED_ACTUAL_START", "STRUCTURED_MONEYLINE", "TEXT_HEURISTIC"]) assert.match(sql, new RegExp(`'${value}'`), value);
  assert.doesNotMatch(sql, /TEAM_PAIR_START_TEXT|HISTORICAL_REPLAY'\s*(then|when)\s*'PRE/);
  // a scheduled/Gamma time is not an accepted authoritative source
  assert.doesNotMatch(sql, /authoritative_start_source in \([^)]*(SCHEDULED|GAMMA|CLOB)/);
});
