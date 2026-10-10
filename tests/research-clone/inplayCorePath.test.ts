import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveStructuredState, deriveSportState, STATE_MAX_AGE_MS, admitPhysicalEvent, selectPrimaryCoreMarkets, decidePersistenceReason, MAX_DAILY_PHYSICAL_EVENTS,
  MAX_TRACKED_TOKENS_PER_EVENT, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY,
  MAX_INPLAY_LOGICAL_MB_PER_DAY, PRODUCTION_RETENTION_HOURS } from "../../lib/research/inplayCorePath";
import { admitResearchMarket } from "../../lib/executor/precontractT20Research";
import { purgeConfirmedTelemetry, type TelemetryPurgePort } from "../../lib/research-clone/dailySync";

const migration = readFileSync("supabase/migrations/20261008090000_research_inplay_core_path_v1.sql", "utf8");
const clone = readFileSync("ops/research-clone/inplay-core-path-schema.sql", "utf8");
const sync = readFileSync("scripts/research-clone-daily-sync.ts", "utf8");
const collector = readFileSync("lib/research/inplayCorePath.ts", "utf8");

test("structured live identity admits one exact event and core moneyline without model or Reservation input", () => {
  const state = deriveStructuredState({ gameId: 123, status: "inprogress", live: true, period: "S1", score: "6-3, 2-1" });
  assert.deepEqual(state, { gameId: "123", eventLiveStatus: "LIVE", phase: "S1", sportCode: null });
  const event = { id: "45", gameId: 123, startTime: "2026-10-08T10:00:00Z", tags: [{ slug: "tennis" }], markets: [{}] } as any;
  assert.equal(admitPhysicalEvent([event], state!)?.event.id, "45");
  assert.equal(admitPhysicalEvent([{ ...event, gameId: 124 }], state!), null);
  assert.equal(admitResearchMarket("tennis", "moneyline", null).admitted, true);
  assert.doesNotMatch(collector, /night_event_reservations|current_signal_pair_serving|model_score|planning_score/);
});

test("text cannot create structured score or live status; derivative market rejected", () => {
  assert.equal(deriveStructuredState({ gameId: 123, score: "2-1", period: "S1" }), null);
  assert.equal(admitResearchMarket("tennis", "tennis_first_set_winner", "first-set").admitted, false);
  assert.doesNotMatch(collector, /state_clock_seconds_remaining: (?!null)/);
  assert.equal(deriveSportState({ score: "6-3, 2-1", period: "S2" }, "tennis", "LIVE", NOW, NOW).sideAScore, null);
});

test("one primary structured condition per core family; tied lines fail closed", () => {
  const markets = [
    { condition_id: "ml", sports_market_type: "moneyline", provider_market_slug: null },
    { condition_id: "s1", sports_market_type: "spread", provider_market_slug: null },
    { condition_id: "s2", sports_market_type: "spread", provider_market_slug: null },
    { condition_id: "derivative", sports_market_type: "soccer_first_half_total", provider_market_slug: null },
  ];
  const raw = [{ markets: [{ conditionId: "s1", volume24hr: 5 }, { conditionId: "s2", volume24hr: 10 }] }] as any;
  assert.deepEqual(selectPrimaryCoreMarkets(markets, raw, "soccer").map((m) => m.condition_id), ["ml", "s2"]);
  raw[0].markets[0].volume24hr = 10;
  assert.deepEqual(selectPrimaryCoreMarkets(markets, raw, "soccer").map((m) => m.condition_id), ["ml"]);
});

const live = { gameId: "123", eventLiveStatus: "LIVE" as const, phase: "S1", sportCode: "atp" };
const prior = { observed_at: "2026-10-08T10:00:00Z", mid_price: 0.5, spread_abs: 0.02, state_phase: "S1", event_live_status: "LIVE" };
test("landmarks are sparse with deterministic reason priority", () => {
  const base = { previous: prior, nowMs: Date.parse(prior.observed_at) + 60_000, mid: 0.5, spread: 0.02, state: live };
  assert.equal(decidePersistenceReason(base), null);
  assert.equal(decidePersistenceReason({ ...base, mid: 0.52 }), "PRICE_MOVE");
  assert.equal(decidePersistenceReason({ ...base, spread: 0.03 }), "SPREAD_MOVE");
  assert.equal(decidePersistenceReason({ ...base, nowMs: Date.parse(prior.observed_at) + 299_999 }), null);
  assert.equal(decidePersistenceReason({ ...base, nowMs: Date.parse(prior.observed_at) + 300_000 }), "HEARTBEAT");
  assert.equal(decidePersistenceReason({ ...base, state: { ...live, phase: "S2" } }), "STATE_CHANGE");
  assert.equal(decidePersistenceReason({ ...base, previous: null }), "LIVE_OPEN");
  assert.equal(decidePersistenceReason({ ...base, state: { ...live, eventLiveStatus: "FINAL" } }), "FINAL_STATE");
});

test("all four hard counters and 20 MB bound are enforced by locked writer", () => {
  assert.deepEqual([MAX_DAILY_PHYSICAL_EVENTS, MAX_TRACKED_TOKENS_PER_EVENT, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY, MAX_INPLAY_LOGICAL_MB_PER_DAY, PRODUCTION_RETENTION_HOURS], [100,16,192,20000,20,48]);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /v_events >= 100/);
  assert.match(migration, /v_tokens >= 16/);
  assert.match(migration, /v_event_rows >= 192/);
  assert.match(migration, /v_rows >= 20000/);
  assert.match(migration, /pg_column_size\(p_row\) > 1000/);
  assert.ok(100 * 192 * 1000 <= 20_000_000);
});

test("scalar-only table and clone projection", () => {
  assert.doesNotMatch(migration, /\bjsonb?\b/i);
  assert.doesNotMatch(clone, /\bjsonb?\b/i);
  assert.doesNotMatch(collector, /raw_provider_json|raw_orderbook_json|diagnostics:/);
  assert.match(sync, /INPLAY_CORE_PATH_PROJECTION = "id,physical_event_id,/);
  assert.match(sync, /projection: INPLAY_CORE_PATH_PROJECTION/);
  assert.match(sync, /bootstrapSince: INPLAY_CORE_PATH_BOOTSTRAP_SINCE/);
  assert.match(migration, /full_stake_exit_vwap numeric/);
  assert.match(collector, /computeExecutableExit\(book\.bids, shares, 0\.02\)/);
  assert.match(migration, /CREATE INDEX research_inplay_core_path_event_time_idx.*physical_event_id, observed_at/);
  assert.match(migration, /CREATE INDEX research_inplay_core_path_retention_idx.*observed_at, id/);
});

test("48-hour purge deletes only an exact confirmed clone ID", async () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const stale = { id: "a", timestamp: "2026-10-06T11:59:59Z" };
  const deleted: string[] = [];
  const port: TelemetryPurgePort = {
    readCursor: async () => null,
    fetchStalePage: async (_table, _cutoff, after) => after ? [] : [stale],
    exactCloneIds: async () => ["a"],
    withoutProductionChildren: async (_table, ids) => ids,
    deleteProductionIds: async (_table, ids) => { deleted.push(...ids); },
    writeCursor: async () => {},
  };
  await purgeConfirmedTelemetry(now, port, 200, 1, { tables: ["research_inplay_core_path_observations"], retentionHours: 48 });
  assert.deepEqual(deleted, ["a"]);
  assert.match(sync, /table === "research_inplay_core_path_observations"[\s\S]*?deletion\.lte\("observed_at", new Date\(nowMs - 48/);
});

test("clone failure makes zero production deletes", async () => {
  let deleted = 0;
  const port: TelemetryPurgePort = {
    readCursor: async () => null,
    fetchStalePage: async () => [{ id: "a", timestamp: "2026-10-06T11:00:00Z" }],
    exactCloneIds: async () => { throw new Error("CLONE_UNREACHABLE"); },
    withoutProductionChildren: async (_table, ids) => ids,
    deleteProductionIds: async () => { deleted++; },
    writeCursor: async () => {},
  };
  await assert.rejects(purgeConfirmedTelemetry(Date.parse("2026-10-08T12:00:00Z"), port, 200, 1,
    { tables: ["research_inplay_core_path_observations"], retentionHours: 48 }), /CLONE_UNREACHABLE/);
  assert.equal(deleted, 0);
});

const NOW = Date.parse("2026-10-10T09:25:30Z");
// Real provider payload (sports-api.polymarket.com/ws, 2026-10-10 09:25 UTC, game 90123180).
const soccer = { gameId: 90123180, leagueAbbreviation: "auc", homeTeam: "South Melbourne FC", awayTeam: "Melbourne Victory FC",
  status: "InProgress", score: "2-1", elapsed: "34", period: "1H", live: true, ended: false };

test("soccer socket payload -> typed state with receipt provenance (home=side A, away=side B, count-up clock)", () => {
  const state = deriveStructuredState(soccer);
  assert.deepEqual(state, { gameId: "90123180", eventLiveStatus: "LIVE", phase: "1H", sportCode: "auc" });
  assert.deepEqual(deriveSportState(soccer, "soccer", "LIVE", NOW - 20_000, NOW),
    { periodNum: 1, clockSecondsElapsed: 34 * 60, sideAScore: 2, sideBScore: 1, receivedAt: new Date(NOW - 20_000).toISOString() });
  assert.equal(deriveSportState({ ...soccer, period: "2H", elapsed: "47" }, "soccer", "LIVE", NOW, NOW).periodNum, 2);
});

test("invalid, inconsistent, stale and non-soccer state never fabricates fields", () => {
  const s = (raw: object, family = "soccer", received: number | undefined = NOW - 1_000) =>
    deriveSportState({ ...soccer, ...raw }, family, "LIVE", received, NOW);
  assert.equal(s({ elapsed: "" }).clockSecondsElapsed, null);          // empty clock keeps the valid score/period
  assert.equal(s({ elapsed: "" }).sideAScore, 2);
  assert.equal(s({ elapsed: "34+2" }).clockSecondsElapsed, null);
  assert.equal(s({ elapsed: "70" }).clockSecondsElapsed, null);        // 1H cannot be minute 70
  assert.equal(s({ period: "2H", elapsed: "20" }).clockSecondsElapsed, null);
  assert.equal(s({ period: "HT" }).periodNum, null);
  assert.equal(s({ score: "2-1, 3-0" }).sideAScore, null);
  assert.equal(s({ score: "-1" }).sideBScore, null);
  assert.equal(s({ score: 3 }).sideAScore, null);
  assert.deepEqual(s({}, "soccer", NOW - STATE_MAX_AGE_MS - 1).receivedAt, null);   // stale
  assert.equal(s({}, "soccer", NOW + 1).receivedAt, null);                            // from the future
  assert.equal(deriveSportState(soccer, "soccer", "LIVE", undefined, NOW).sideAScore, null);                         // no receipt time
  assert.equal(s({}, "tennis").sideAScore, null);
  assert.equal(s({ score: "bad", period: "ET", elapsed: "x" }).receivedAt, null);     // nothing valid -> no provenance either
  assert.deepEqual(deriveSportState({ ...soccer, status: "Final", period: "FT", elapsed: "", live: false, ended: true, score: "3-1" }, "soccer", "FINAL", NOW, NOW),
    { periodNum: null, clockSecondsElapsed: null, sideAScore: 3, sideBScore: 1, receivedAt: new Date(NOW).toISOString() });
  assert.equal(deriveSportState({ ...soccer, ended: true, period: "2H" }, "soccer", "FINAL", NOW, NOW).sideAScore, null);
});

test("typed fields reach the persisted row, migration, clone DDL and clone projection; caps unchanged", () => {
  const newMigration = readFileSync("supabase/migrations/20261010100000_research_inplay_state_fields_v2.sql", "utf8");
  assert.match(collector, /state_period_num: sport\.periodNum/);
  assert.match(collector, /state_clock_seconds_elapsed: sport\.clockSecondsElapsed/);
  assert.match(collector, /side_a_score: sport\.sideAScore, side_b_score: sport\.sideBScore, state_received_at: sport\.receivedAt/);
  assert.match(newMigration, /ADD COLUMN IF NOT EXISTS state_clock_seconds_elapsed integer/);
  assert.match(newMigration, /ADD COLUMN IF NOT EXISTS state_received_at timestamptz/);
  assert.doesNotMatch(newMigration, /\bjsonb?\b|CREATE INDEX|DROP|DELETE/i);
  assert.match(clone, /state_clock_seconds_elapsed integer/);
  assert.match(clone, /state_received_at timestamptz/);
  assert.match(sync, /INPLAY_CORE_PATH_PROJECTION = "[^"]*state_clock_seconds_elapsed,state_received_at,side_a_score,side_b_score/);
  assert.match(readFileSync("scripts/research-inplay-core-path.ts", "utf8"), /receivedAtMs\);/);
});
