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

// ── Linked soccer TOTALS co-capture (research-only; caps unchanged) ─────────────────────────────────────────
import { selectLinkedSoccerTotals, selectCoreCaptureMarkets, assessLinkedQuoteSynchronization } from "../../lib/research/inplayCorePath";

const START = "2026-10-10T09:00:00Z";
const mkt = (cond: string, type: string, slug: string | null, o: Record<string, unknown> = {}) => ({
  provider_event_id: "45", event_start_iso: START, condition_id: cond, clob_token_ids: JSON.stringify([`${cond}-a`, `${cond}-b`]),
  outcomes: JSON.stringify(type === "totals" ? ["Over", "Under"] : ["Yes", "No"]), sports_market_type: type,
  provider_market_slug: slug, sibling_market_count: 5, last_observed_at: START, provider_game_id: "123", ...o,
}) as any;
const tot = (cond: string, line: number, o: Record<string, unknown> = {}) => mkt(cond, "totals", `g-total-${String(line).replace(".", "pt")}`, o);
const rawTot = (cond: string, line: unknown, volume: number | undefined, o: Record<string, unknown> = {}) =>
  ({ conditionId: cond, sportsMarketType: "totals", line, ...(volume === undefined ? {} : { volume24hr: volume }), ...o });
const ev = (markets: unknown[], gameId: unknown = 123) => [{ id: "45", gameId, markets }] as any;
const base = () => ({
  universe: [mkt("ml", "moneyline", null), mkt("sp", "spreads", null), tot("t25", 2.5), tot("t35", 3.5), tot("t15", 1.5)],
  events: ev([{ conditionId: "ml", volume24hr: 9 }, { conditionId: "sp", volume24hr: 9 }, rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40), rawTot("t15", 1.5, 30)]),
});
const ids = (m: any[]) => m.map((x) => x.condition_id);

test("no valid sibling -> output identical to selectPrimaryCoreMarkets", () => {
  const { universe, events } = base();
  const solo = [universe[0], universe[1], universe[2]];
  const soloEvents = ev([{ conditionId: "ml", volume24hr: 9 }, { conditionId: "sp", volume24hr: 9 }, rawTot("t25", 2.5, 100)]);
  assert.deepEqual(ids(selectCoreCaptureMarkets(solo, soloEvents, "soccer")), ids(selectPrimaryCoreMarkets(solo, soloEvents, "soccer")));
  assert.equal(selectLinkedSoccerTotals(solo, soloEvents, "soccer", selectPrimaryCoreMarkets(solo, soloEvents, "soccer")), null);
  assert.equal(selectCoreCaptureMarkets(universe, events, "soccer").length, selectPrimaryCoreMarkets(universe, events, "soccer").length + 1);
});

test("one extra soccer TOTALS (nearest distinct line) is added; MONEYLINE/SPREADS primaries preserved; token budget respected", () => {
  const { universe, events } = base();
  const primary = selectPrimaryCoreMarkets(universe, events, "soccer");
  assert.deepEqual(ids(primary), ["ml", "sp", "t25"]);               // t25 wins on volume
  const out = selectCoreCaptureMarkets(universe, events, "soccer");
  assert.deepEqual(ids(out), ["ml", "sp", "t25", "t15"]);            // 1.5 and 3.5 tie on distance -> lower line, one extra only
  assert.deepEqual(ids(out.slice(0, 3)), ids(primary));
  const tokens = inventoryTokensOf(out);
  assert.equal(tokens, 8);
  assert.ok(tokens <= MAX_TRACKED_TOKENS_PER_EVENT);
});
import { inventoryTokens } from "../../lib/executor/reservationMarketBaseline";
const inventoryTokensOf = (m: any[]) => inventoryTokens(m).tokens.length;

test("different physical games are never mixed", () => {
  const { universe, events } = base();
  const other = universe.map((m: any) => m.condition_id === "t15" ? { ...m, provider_game_id: "999" } : m);
  assert.equal(selectCoreCaptureMarkets(other, events, "soccer").some((m: any) => m.condition_id === "t15"), false);
  assert.equal(selectCoreCaptureMarkets(other, events, "soccer").length, 4);   // t35 takes the slot instead
  const otherRawGame = [{ id: "46", gameId: 999, markets: [rawTot("t15", 1.5, 30), rawTot("t35", 3.5, 40)] }, { id: "45", gameId: 123, markets: events[0].markets.filter((r: any) => !["t15", "t35"].includes(r.conditionId)) }] as any;
  assert.deepEqual(ids(selectCoreCaptureMarkets(universe, otherRawGame, "soccer")), ["ml", "sp", "t25"]);
  const otherStart = universe.map((m: any) => m.condition_id === "t35" || m.condition_id === "t15" ? { ...m, event_start_iso: "2026-10-10T10:00:00Z" } : m);
  assert.deepEqual(ids(selectCoreCaptureMarkets(otherStart, events, "soccer")), ["ml", "sp", "t25"]);
});

test("first-half, team, corner and non-totals scopes are rejected", () => {
  const { events } = base();
  const prim = [mkt("t25", "totals", "g-total-2pt5")];
  const only = (extra: any, rawExtra: any = rawTot(extra.condition_id, 3.5, 40)) =>
    selectLinkedSoccerTotals([...prim, extra], ev([rawTot("t25", 2.5, 100), rawExtra]), "soccer", prim);
  assert.equal(only(mkt("fh", "soccer_first_half_total", "g-total-3pt5")), null);
  assert.equal(only(mkt("fh", "totals", "g-1h-total-3pt5")), null);
  assert.equal(only(mkt("tm", "totals", "g-team-total-3pt5")), null);
  assert.equal(only(mkt("co", "total_corners", "g-total-corners-3pt5")), null);
  assert.equal(only(mkt("ml2", "moneyline", null)), null);
  assert.equal(only(mkt("x", "totals", "g-total-3pt5"), { ...rawTot("x", 3.5, 40), sportsMarketType: "soccer_first_half_total" }), null);
  assert.equal(only(mkt("x", "totals", "g-total-3pt5")) !== null, true);       // control: genuine full-game sibling is accepted
  assert.ok(events);
});

test("same-condition duplicate tokens/rows are one market; not a second line", () => {
  const prim = [tot("t25", 2.5)];
  const evs = ev([rawTot("t25", 2.5, 100)]);
  assert.equal(selectLinkedSoccerTotals([...prim, tot("t25", 2.5)], evs, "soccer", prim), null);   // duplicate of the anchor
  const dupTokens = tot("t35", 3.5, { clob_token_ids: JSON.stringify(["a", "a", "b"]), outcomes: JSON.stringify(["Over", "Over", "Under"]) });
  const evs2 = ev([rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40)]);
  assert.equal(selectLinkedSoccerTotals([...prim, dupTokens], evs2, "soccer", prim)?.condition_id, "t35");
  assert.equal(inventoryTokensOf([dupTokens, dupTokens]), 2);
  assert.equal(selectLinkedSoccerTotals([...prim, tot("t35", 3.5), tot("t35", 3.5, { clob_token_ids: JSON.stringify(["z1", "z2"]) })], evs2, "soccer", prim), null);   // same condition, contradictory tokens
});

test("ambiguous or missing structured line is rejected; the slug never supplies a line", () => {
  const prim = [tot("t25", 2.5)];
  const run = (rawLine: unknown, slug = "g-total-3pt5") =>
    selectLinkedSoccerTotals([...prim, mkt("x", "totals", slug)], ev([rawTot("t25", 2.5, 100), rawTot("x", rawLine, 40)]), "soccer", prim);
  assert.equal(run(undefined), null);            // no structured line, slug says 3.5 -> still rejected
  assert.equal(run(null), null);
  assert.equal(run("3.5"), null);
  assert.equal(run(3), null);                    // integer line is not a half-goal covering line
  assert.equal(run(3.25), null);
  assert.equal(run(3.5, "g-total-4pt5"), null);  // slug contradicts structured line
  assert.equal(run(2.5), null);                  // same line is not a different line
  assert.equal(run(3.5)?.condition_id, "x");
  assert.equal(selectLinkedSoccerTotals([...prim, tot("x", 3.5)], ev([rawTot("t25", undefined, 100), rawTot("x", 3.5, 40)]), "soccer", prim), null);   // anchor without structured line
  assert.equal(selectLinkedSoccerTotals([...prim, tot("x", 3.5)], ev([rawTot("t25", 2.5, 100), rawTot("x", 3.5, 40), rawTot("x", 4.5, 40)]), "soccer", prim), null);   // provider reports two lines for one condition
  const noAnchorLine = [tot("t25", 2.5)];
  assert.equal(selectLinkedSoccerTotals([...noAnchorLine, tot("x", 3.5)], ev([rawTot("t25", null, 100), rawTot("x", 3.5, 40)]), "soccer", noAnchorLine), null);
});

test("capacity overflow fails closed without raising the 16-token budget", () => {
  assert.equal(MAX_TRACKED_TOKENS_PER_EVENT, 16);
  const heavy = [0, 1, 2, 3, 4, 5, 6].map((i) => mkt(`p${i}`, "spreads", null)); // 7 markets -> 14 tokens
  const prim = [...heavy, tot("t25", 2.5)];                                         // 16 tokens
  const evs = ev([rawTot("t25", 2.5, 100), rawTot("x", 3.5, 40)]);
  assert.equal(inventoryTokensOf(prim), 16);
  assert.equal(selectLinkedSoccerTotals([...prim, tot("x", 3.5)], evs, "soccer", prim), null);
  const room = prim.slice(1);                                                       // 14 tokens -> exactly 16 with sibling
  const got = selectLinkedSoccerTotals([...room, tot("x", 3.5)], evs, "soccer", room);
  assert.equal(inventoryTokensOf([...room, got]), 16);
  const bad = tot("x", 3.5, { outcomes: JSON.stringify(["Over", ""]) });             // incomplete Over/Under linkage
  assert.equal(selectLinkedSoccerTotals([...room, bad], evs, "soccer", room), null);
  const one = tot("x", 3.5, { clob_token_ids: JSON.stringify(["only"]), outcomes: JSON.stringify(["Over"]) });
  assert.equal(selectLinkedSoccerTotals([...room, one], evs, "soccer", room), null);
  const overUnderTwice = tot("x", 3.5, { outcomes: JSON.stringify(["Over", "Over"]) });
  assert.equal(selectLinkedSoccerTotals([...room, overUnderTwice], evs, "soccer", room), null);
});

test("selection is deterministic across input and event ordering", () => {
  const { universe, events } = base();
  const expected = ids(selectCoreCaptureMarkets(universe, events, "soccer")).sort();
  const perms = [[4, 3, 2, 1, 0], [2, 4, 0, 3, 1], [3, 0, 4, 1, 2]];
  for (const p of perms) {
    const u = p.map((i) => universe[i]);
    const e = ev([...events[0].markets].reverse());
    assert.deepEqual(ids(selectCoreCaptureMarkets(u, e, "soccer")).sort(), expected);
  }
});

test("non-soccer and absent anchor behaviour is unchanged", () => {
  const { universe, events } = base();
  for (const family of ["tennis", "basketball", "hockey", "baseball"]) {
    assert.deepEqual(ids(selectCoreCaptureMarkets(universe, events, family)), ids(selectPrimaryCoreMarkets(universe, events, family)));
  }
  const tied = ev([...events[0].markets.map((r: any) => r.conditionId === "t35" ? { ...r, volume24hr: 100 } : r)]);
  const tiedUniverse = universe.filter((m: any) => m.condition_id !== "t15");
  assert.deepEqual(ids(selectPrimaryCoreMarkets(tiedUniverse, tied, "soccer")), ["ml", "sp"]);      // 2.5 vs 3.5 tie -> no primary total
  assert.deepEqual(ids(selectCoreCaptureMarkets(tiedUniverse, tied, "soccer")), ["ml", "sp"]);      // no anchor -> no arbitrary sibling
});

test("missing or contradictory volume/identity authority never yields an arbitrary sibling", () => {
  const prim = [tot("t25", 2.5)];
  const noVol = ev([rawTot("t25", 2.5, 100), rawTot("x", 3.5, undefined)]);
  assert.equal(selectLinkedSoccerTotals([...prim, tot("x", 3.5)], noVol, "soccer", prim), null);
  const noCond = { ...tot("x", 3.5), condition_id: null };
  assert.equal(selectLinkedSoccerTotals([...prim, noCond], ev([rawTot("t25", 2.5, 100)]), "soccer", prim), null);
  const wrongGame = ev([rawTot("t25", 2.5, 100), rawTot("x", 3.5, 40)], null);
  assert.equal(selectLinkedSoccerTotals([...prim, tot("x", 3.5)], wrongGame, "soccer", prim), null);   // no structured game id on payload
  const twoAnchors = [tot("t25", 2.5), tot("t35", 3.5)];
  assert.equal(selectLinkedSoccerTotals([...twoAnchors, tot("x", 4.5)], ev([rawTot("t25", 2.5, 1), rawTot("t35", 3.5, 1), rawTot("x", 4.5, 1)]), "soccer", twoAnchors), null);
  const missingTokens = { ...tot("t25", 2.5), clob_token_ids: null };
  assert.equal(selectLinkedSoccerTotals([missingTokens, tot("x", 3.5)], ev([rawTot("t25", 2.5, 1), rawTot("x", 3.5, 1)]), "soccer", [missingTokens]), null);
});

test("quote synchronization is never claimed without per-leg acquisition timing; caps and persistence untouched", () => {
  assert.equal(assessLinkedQuoteSynchronization([], 10_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000], 10_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000, null], 10_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000, undefined, 1500], 10_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000, 90_000], 10_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000, 1500], 10_000), "BOUNDED");
  assert.deepEqual([MAX_DAILY_PHYSICAL_EVENTS, MAX_TRACKED_TOKENS_PER_EVENT, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY], [100, 16, 192, 20000]);
  assert.match(collector, /const markets = selectCoreCaptureMarkets\(universe\.markets, events, family\);/);
  assert.match(collector, /const observedAt = new Date\(nowMs\)\.toISOString\(\);/);   // one poll-cycle instant, not a per-leg time
  assert.doesNotMatch(collector, /synchron\w*\s*[:=]\s*["']?(BOUNDED|PROVEN)/i);
});
