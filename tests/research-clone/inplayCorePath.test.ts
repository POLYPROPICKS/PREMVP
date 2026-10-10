import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveStructuredState, deriveSportState, STATE_MAX_AGE_MS, admitPhysicalEvent, selectPrimaryCoreMarkets, decidePersistenceReason, MAX_DAILY_PHYSICAL_EVENTS,
  MAX_TRACKED_TOKENS_PER_EVENT, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY,
  MAX_INPLAY_LOGICAL_MB_PER_DAY, PRODUCTION_RETENTION_HOURS, captureInplayCorePath, decideInplayAdmission, resetInplayAdmissionCache,
  type InplayAdmissionReason } from "../../lib/research/inplayCorePath";
import { admitResearchMarket, buildResearchEvents, selectResearchCohort, type ResearchEventCandidateRow } from "../../lib/executor/precontractT20Research";
import { physicalMatchId } from "../../lib/executor/contractADecisions";
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
  assert.match(readFileSync("scripts/research-inplay-core-path.ts", "utf8"), /receivedAtMs, countAdmission\);/);
});

// ---- TOP-100 cohort alignment: in-play admission follows the persisted Founder 40/20/40 liquidity cohort, never arrival order.
const DAY = "2026-10-10";
const cand = (n: number, family: string, volume: number | null, over: Partial<ResearchEventCandidateRow> = {}): ResearchEventCandidateRow => ({
  provider_event_id: String(5000 + n), provider_game_id: String(9000 + n), event_start_iso: `${DAY}T15:00:00.000Z`,
  snapshot_run_id: `run-${n}`, snapshot_at: `${DAY}T14:00:00Z`, provider_sport_family: family, provider_sport_family_n: 1,
  provider_sport_code: family, provider_sport_code_n: 1, provider_sport_source: "structured_sports_tag", provider_sport_source_n: 1,
  parent_event_volume_24h: volume, volume_contradiction: false, ...over });
let n = 0;
const supply = (family: string, count: number, base: number) => Array.from({ length: count }, (_, i) => cand(++n, family, base + i));

test("admission verdict: prior rows stay admitted; membership admits; absence rejects; unreadable cohort fails closed", () => {
  const id = "provider:polymarket:game:1:2026-10-10";
  assert.deepEqual(decideInplayAdmission({ priorRowCount: 3, membership: null, physicalEventId: id }), { admitted: true, reason: "ALREADY_ADMITTED" });
  assert.deepEqual(decideInplayAdmission({ priorRowCount: 0, membership: [{ physical_event_id: id }], physicalEventId: id }), { admitted: true, reason: "T20_COHORT_MEMBER" });
  assert.deepEqual(decideInplayAdmission({ priorRowCount: 0, membership: [], physicalEventId: id }), { admitted: false, reason: "NOT_IN_T20_COHORT" });
  assert.deepEqual(decideInplayAdmission({ priorRowCount: 0, membership: [{ physical_event_id: "other" }], physicalEventId: id }), { admitted: false, reason: "NOT_IN_T20_COHORT" });
  assert.deepEqual(decideInplayAdmission({ priorRowCount: 0, membership: null, physicalEventId: id }), { admitted: false, reason: "COHORT_READ_FAILED" });
});

test("sufficient supply: the admitted in-play set is exactly the 40/20/40 liquidity cohort, independent of arrival order", () => {
  const candidates = [...supply("soccer", 70, 1000), ...supply("tennis", 40, 500), ...supply("basketball", 30, 300), ...supply("baseball", 20, 200),
    ...supply("hockey", 10, 100), ...supply("cricket", 10, 50),
    ...Array.from({ length: 10 }, (_, i) => cand(++n, "nfl-code-only", 400 + i, { provider_sport_family: null, provider_sport_family_n: 0, provider_sport_code: "nfl" }))];
  const { selected, diagnostics } = selectResearchCohort(buildResearchEvents(candidates));
  const persisted = new Set(selected.map((s) => s.event.physicalEventId));    // what T20 persists
  assert.equal(persisted.size, 100);
  assert.equal(diagnostics.soccer_selected_n, 40);
  assert.equal(diagnostics.tennis_selected_n, 20);
  assert.equal(diagnostics.american_football_selected_n >= 4, true, "structured NFL code counts toward the diversity floor");
  assert.equal(diagnostics.global_backfill_n, 0);
  // In-play arrival order = ascending volume (worst case for first-come): lowest-liquidity events arrive first.
  const arrival = buildResearchEvents(candidates).sort((a, b) => (a.volume ?? 0) - (b.volume ?? 0));
  const admitted = arrival.filter((e) => decideInplayAdmission({ priorRowCount: 0, physicalEventId: e.physicalEventId,
    membership: persisted.has(e.physicalEventId) ? [{ physical_event_id: e.physicalEventId }] : [] }).admitted);
  assert.deepEqual(new Set(admitted.map((e) => e.physicalEventId)), persisted);
  assert.equal(admitted.length, 100);
  const rank101 = selectResearchCohort(buildResearchEvents(candidates)).selected.length;
  assert.equal(rank101, 100, "daily cap holds; arrival order cannot admit a 101st or a low-volume event");
});

test("underfill is reallocated by GLOBAL_BACKFILL, never invented; contradictory/missing volume and duplicates are not admitted", () => {
  const candidates = [...supply("soccer", 10, 1000), ...supply("tennis", 60, 500), ...supply("basketball", 5, 300),
    cand(++n, "soccer", null), cand(++n, "soccer", 9999, { volume_contradiction: true }),
    cand(900, "tennis", 777, { provider_game_id: "DUP" }), cand(901, "tennis", 778, { provider_game_id: "dup", snapshot_at: `${DAY}T14:30:00Z` })];
  const { selected, diagnostics } = selectResearchCohort(buildResearchEvents(candidates));
  assert.equal(diagnostics.soccer_quota_underfill_n, 30);
  assert.ok(diagnostics.global_backfill_n > 0 && selected.some((s) => s.bucket === "GLOBAL_BACKFILL"));
  assert.ok(selected.length < 100, "no invented events to fill the cap");
  const ids = selected.map((s) => s.event.physicalEventId);
  assert.equal(new Set(ids).size, ids.length, "one slot per physical event");
  assert.equal(diagnostics.volume_unknown_event_n, 1);
  assert.equal(diagnostics.volume_contradiction_event_n, 1);
});

type Row = Record<string, unknown>;
function fakeDb(opts: { inplay?: Row[]; cohort?: Row[] | "ERROR" }) {
  const reads: string[] = [];
  let rpcCalls = 0;
  const chain = (table: string) => {
    const result = table === "research_inplay_core_path_observations" ? { data: opts.inplay ?? [], error: null }
      : opts.cohort === "ERROR" ? { data: null, error: { message: "boom" } } : { data: opts.cohort ?? [], error: null };
    const q: any = { select: () => q, eq: () => q, order: () => q, limit: () => { reads.push(table); return Promise.resolve(result); } };
    return q;
  };
  return { db: { from: chain, rpc: () => { rpcCalls++; return Promise.resolve({ data: true, error: null }); } } as any, reads, rpcCalls: () => rpcCalls };
}
const T = Date.parse("2026-10-10T15:01:00Z");
const gammaEvent = { id: "45", gameId: 123, startTime: "2026-10-10T15:00:00Z", tags: [{ slug: "tennis" }], markets: [{}] };
const socketState = { gameId: 123, status: "InProgress", live: true, period: "S1" };
const memberId = physicalMatchId({ gameId: "123", eventId: "45", eventStartIso: "2026-10-10T15:00:00.000Z" });

async function runCapture(db: any, calls: string[]): Promise<{ n: number; reasons: InplayAdmissionReason[] }> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).includes("game_id=123") ? [gammaEvent] : []), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const reasons: InplayAdmissionReason[] = [];
  try { return { n: await captureInplayCorePath(socketState, db, T, () => true, T, (r) => reasons.push(r)).catch(() => 0), reasons }; }
  finally { globalThis.fetch = original; }
}

test("capture gate: non-cohort game is rejected before any market/orderbook read or write and is not retried within the TTL", async () => {
  resetInplayAdmissionCache();
  const f = fakeDb({ cohort: [] });
  const calls: string[] = [];
  const first = await runCapture(f.db, calls);
  assert.deepEqual(first, { n: 0, reasons: ["NOT_IN_T20_COHORT"] });
  assert.equal(calls.length, 1, "only the structured Gamma identity read happened");
  assert.equal(f.rpcCalls(), 0);
  const second = await runCapture(f.db, calls);
  assert.deepEqual(second.reasons, ["NOT_IN_T20_COHORT"]);
  assert.equal(calls.length, 1, "cached verdict: no further provider request for a rejected game");
});

test("capture gate: unreadable cohort fails closed, is not cached, and never degrades to first-come", async () => {
  resetInplayAdmissionCache();
  const f = fakeDb({ cohort: "ERROR" });
  const calls: string[] = [];
  assert.deepEqual(await runCapture(f.db, calls), { n: 0, reasons: ["COHORT_READ_FAILED"] });
  assert.equal(f.rpcCalls(), 0);
  const healthy = fakeDb({ cohort: [{ physical_event_id: memberId }] });
  assert.deepEqual((await runCapture(healthy.db, calls)).reasons, ["T20_COHORT_MEMBER"]);
});

test("capture gate: cohort member proceeds past the gate; already-admitted event never re-queries the cohort (no retrospective mutation)", async () => {
  resetInplayAdmissionCache();
  const member = fakeDb({ cohort: [{ physical_event_id: memberId }] });
  const calls: string[] = [];
  const out = await runCapture(member.db, calls);
  assert.deepEqual(out.reasons, ["T20_COHORT_MEMBER"]);
  assert.ok(calls.length > 1, "market reads continue after admission");
  resetInplayAdmissionCache();
  const prior = { token_id: "t", observed_at: "2026-10-10T15:00:30Z", mid_price: 0.5, spread_abs: 0.02, state_phase: "S1", event_live_status: "LIVE" };
  const admitted = fakeDb({ inplay: [prior], cohort: [] });
  assert.deepEqual((await runCapture(admitted.db, [])).reasons, ["ALREADY_ADMITTED"]);
  assert.ok(!admitted.reads.includes("research_precontract_t20_observations"));
});

test("no second ranking algorithm, no new budgets: gate precedes provider market reads; caps, cadence and SQL writer untouched", () => {
  assert.ok(collector.indexOf("decideInplayAdmission({") < collector.indexOf("defaultExactEventReader(String"));
  assert.doesNotMatch(collector, /import[^;]*selectResearchCohort|OTHER_QUOTA|SOCCER_QUOTA|TENNIS_QUOTA/);
  assert.match(collector, /MAX_DAILY_PHYSICAL_EVENTS = 100/);
  assert.match(collector, /HEARTBEAT_MS = 5 \* 60_000/);
  assert.match(migration, /v_events >= 100/);
});
