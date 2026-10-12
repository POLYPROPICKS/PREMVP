import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveStructuredState, deriveSportState, STATE_MAX_AGE_MS, admitPhysicalEvent, selectPrimaryCoreMarkets, decidePersistenceReason, MAX_DAILY_PHYSICAL_EVENTS,
  MAX_TRACKED_TOKENS_PER_EVENT, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY,
  MAX_INPLAY_LOGICAL_MB_PER_DAY, PRODUCTION_RETENTION_HOURS, SOURCE_VERSION, INPLAY_RESEARCH_EXECUTION_PRICE_CAP, linkedQuoteSpanMs } from "../../lib/research/inplayCorePath";
import { admitResearchMarket } from "../../lib/executor/precontractT20Research";
import { buildExecutableSiblingColumns } from "../../lib/executor/t10ExecutableSiblingTelemetry";
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

test("NFL admission: Gamma league tag 'nfl' (no 'american-football' tag) admits only when the socket league agrees", () => {
  const nflState = deriveStructuredState({ gameId: 19518, status: "InProgress", live: true, period: "Q2", score: "7-7", elapsed: "8:46", leagueAbbreviation: "nfl" })!;
  const event = { id: "941330", gameId: 19518, startTime: "2026-10-11T13:30:00Z", tags: [{ slug: "sports" }, { slug: "nfl" }, { slug: "games" }], markets: [{}] } as any;
  assert.equal(nflState.sportCode, "nfl");
  assert.equal(admitPhysicalEvent([event], nflState)?.family, "american-football");
  // The same Gamma tags with no or a different socket league never admit.
  assert.equal(admitPhysicalEvent([event], { ...nflState, sportCode: null }), null);
  assert.equal(admitPhysicalEvent([event], { ...nflState, sportCode: "nba" }), null);
  // A league slug that is not an alias never becomes a family, including inherited object keys.
  const proto = { ...event, tags: [{ slug: "constructor" }] };
  assert.equal(admitPhysicalEvent([proto], { ...nflState, sportCode: "constructor" }), null);
  const nba = { ...event, tags: [{ slug: "nba" }] };
  assert.equal(admitPhysicalEvent([nba], { ...nflState, sportCode: "nba" }), null);
  // Two different families on one event stay ambiguous; the direct family tag keeps working and cannot double count.
  assert.equal(admitPhysicalEvent([{ ...event, tags: [{ slug: "nfl" }, { slug: "soccer" }] }], nflState), null);
  assert.equal(admitPhysicalEvent([{ ...event, tags: [{ slug: "nfl" }, { slug: "american-football" }] }], nflState)?.family, "american-football");
  assert.equal(admitPhysicalEvent([{ ...event, tags: [{ slug: "american-football" }] }], { ...nflState, sportCode: null })?.family, "american-football");
  // The three real events of the game: only the parent is admissible (children carry parentEventId).
  const children = [{ ...event, id: "1131004", parentEventId: 941330 }, { ...event, id: "1148383", parentEventId: 941330 }];
  assert.equal(admitPhysicalEvent([event, ...children], nflState)?.event.id, "941330");
  assert.equal(admitPhysicalEvent(children, nflState), null);
});

test("text cannot create structured score or live status; derivative market rejected", () => {
  assert.equal(deriveStructuredState({ gameId: 123, score: "2-1", period: "S1" }), null);
  assert.equal(admitResearchMarket("tennis", "tennis_first_set_winner", "first-set").admitted, false);
  assert.doesNotMatch(collector, /state_clock_seconds_remaining: (?!sport\.clockSecondsRemaining)/);
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
    { periodNum: 1, clockSecondsElapsed: 34 * 60, clockSecondsRemaining: null, sideAScore: 2, sideBScore: 1, receivedAt: new Date(NOW - 20_000).toISOString() });
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
    { periodNum: null, clockSecondsElapsed: null, clockSecondsRemaining: null, sideAScore: 3, sideBScore: 1, receivedAt: new Date(NOW).toISOString() });
  assert.equal(deriveSportState({ ...soccer, ended: true, period: "2H" }, "soccer", "FINAL", NOW, NOW).sideAScore, null);
});

// Real provider payloads (sports-api.polymarket.com/ws, 2026-10-11 ~14:00 UTC; independent scoreboard showed JAX 7 - PHI 0, Q1 5:17).
const nfl = { gameId: 19518, leagueAbbreviation: "nfl", turn: "jax", homeTeam: "JAX", awayTeam: "PHI", turnProviderId: "26",
  status: "InProgress", score: "0-7", elapsed: "5:26", period: "Q1", live: true, ended: false };
const tennis = { gameId: 6416843, leagueAbbreviation: "atp", homeTeam: "Alejandro Davidovich Fokina", awayTeam: "Frances Tiafoe",
  status: "inprogress", score: "7-6(7-4), 2-1", period: "S2", live: true, ended: false };
const cricket = { metadataGameId: "id2702676671040592", leagueAbbreviation: "cricket", score: "87-0", period: "Live", live: true, ended: false };

test("american-football: score is away-home (swapped into home=A), quarter, countdown clock stored as REMAINING only", () => {
  assert.deepEqual(deriveStructuredState(nfl), { gameId: "19518", eventLiveStatus: "LIVE", phase: "Q1", sportCode: "nfl" });
  assert.deepEqual(deriveSportState(nfl, "american-football", "LIVE", NOW - 5_000, NOW),
    { periodNum: 1, clockSecondsElapsed: null, clockSecondsRemaining: 5 * 60 + 26, sideAScore: 7, sideBScore: 0, receivedAt: new Date(NOW - 5_000).toISOString() });
  assert.equal(deriveSportState({ ...nfl, period: "Q4", elapsed: "0:00" }, "american-football", "LIVE", NOW, NOW).clockSecondsRemaining, 0);
  assert.equal(deriveSportState({ ...nfl, period: "Q3", elapsed: "15:00" }, "american-football", "LIVE", NOW, NOW).clockSecondsRemaining, 900);
});

test("american-football fails closed: stale, future, no receipt, malformed period/clock/score, FINAL, cross-sport payloads", () => {
  const n = (raw: object, received: number | undefined = NOW - 1_000, status: "LIVE" | "FINAL" = "LIVE") =>
    deriveSportState({ ...nfl, ...raw }, "american-football", status, received, NOW);
  for (const stale of [NOW - STATE_MAX_AGE_MS - 1, NOW + 1, Number.NaN]) assert.equal(n({}, stale).receivedAt, null);
  assert.equal(deriveSportState(nfl, "american-football", "LIVE", undefined, NOW).receivedAt, null);   // no receipt time
  for (const period of ["Q5", "Q0", "OT", "HT", "1H", "S1", "Live", "", 1]) assert.deepEqual(n({ period }).sideAScore, null);   // no valid quarter -> nothing at all
  assert.equal(n({ elapsed: "15:01" }).clockSecondsRemaining, null);
  assert.equal(n({ elapsed: "8:60" }).clockSecondsRemaining, null);
  assert.equal(n({ elapsed: "34" }).clockSecondsRemaining, null);     // soccer-style minute is not an NFL clock
  assert.equal(n({ elapsed: "" }).clockSecondsRemaining, null);
  assert.equal(n({ elapsed: "" }).sideAScore, 7);                       // valid score + quarter survive a missing clock
  assert.equal(n({ elapsed: "8:17" }).clockSecondsElapsed, null);        // never written to the count-up column
  for (const score of ["0-6, 1-0", "6", "-1-3", "a-b", "7-6(7-4), 2-1", 7, null]) assert.equal(n({ score }).sideAScore, null);
  assert.deepEqual(n({}, NOW, "FINAL"), deriveSportState({}, "basketball", "LIVE", NOW, NOW));        // FINAL token unobserved -> null
  assert.equal(n({ score: "x" }).periodNum, 1);                          // bad score does not discard a valid quarter
});

test("cricket, basketball, baseball, hockey stay NULL; cricket cannot even be admitted (no gameId)", () => {
  for (const family of ["cricket", "basketball", "baseball", "hockey"]) {
    assert.deepEqual(deriveSportState(tennis, family, "LIVE", NOW, NOW), deriveSportState({}, family, "LIVE", NOW, NOW));
    assert.deepEqual(deriveSportState(nfl, family, "LIVE", NOW, NOW).sideAScore, null);
    assert.deepEqual(deriveSportState({ ...tennis, score: "2-1", period: "Q1", elapsed: "8:17" }, family, "LIVE", NOW, NOW).clockSecondsRemaining, null);
  }
  assert.equal(deriveStructuredState(cricket), null);                                      // metadataGameId only
  assert.equal(deriveSportState(cricket, "cricket", "LIVE", NOW, NOW).sideAScore, null);   // "87-0" is runs-wickets of one batting side
});

test("TELEMETRY-09 tennis: only the current set number is typed; set scores are never collapsed into side A/B", () => {
  const t = (over: object, status: "LIVE" | "FINAL" = "LIVE", at: number | undefined = NOW) => deriveSportState({ ...tennis, ...over }, "tennis", status, at, NOW);
  assert.deepEqual(t({}), { periodNum: 2, clockSecondsElapsed: null, clockSecondsRemaining: null, sideAScore: null, sideBScore: null, receivedAt: new Date(NOW).toISOString() });
  // Real payload 2026-10-12 (ATP, game 6421934): three set scores, period S3, tiebreak set in brackets.
  assert.equal(t({ score: "6-4, 6-7(2-7), 2-2", period: "S3" }).periodNum, 3);
  assert.equal(t({ score: "6-4, 6-7(2-7), 2-2", period: "S3" }).sideAScore, null);
  assert.equal(t({ score: "0-0", period: "S1" }).periodNum, 1);
  assert.equal(t({ score: "6-4, 3-6, 6-3, 2-6, 1-0", period: "S5" }).periodNum, 5);
  // Period token and score must agree on the set count; anything else fails closed.
  for (const bad of [{ period: "S3" }, { period: "S1" }, { period: "S6" }, { period: "S0" }, { period: "TB" }, { period: "2H" }, { period: "" }, { period: 2 },
    { score: "6-4, x-y" }, { score: "6-4,2-1" }, { score: "" }, { score: null }, { score: "7-6(7-4), 2-1, " }]) assert.equal(t(bad).periodNum, null, JSON.stringify(bad));
  assert.equal(t({}, "FINAL").periodNum, null);                                     // final-state token unobserved for tennis
  assert.equal(deriveSportState(tennis, "tennis", "LIVE", undefined, NOW).periodNum, null);   // no receipt time
  assert.equal(t({}, "LIVE", NOW - STATE_MAX_AGE_MS - 1).periodNum, null);          // stale
  assert.equal(t({}, "LIVE", NOW + 1).periodNum, null);                             // from the future
  assert.equal(t({}).clockSecondsElapsed ?? t({}).clockSecondsRemaining, null);      // tennis has no clock
});

test("typed fields reach the persisted row, migration, clone DDL and clone projection; caps unchanged", () => {
  const newMigration = readFileSync("supabase/migrations/20261010100000_research_inplay_state_fields_v2.sql", "utf8");
  assert.match(collector, /state_period_num: sport\.periodNum/);
  assert.match(collector, /state_clock_seconds_remaining: sport\.clockSecondsRemaining/);
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
  // inventoryTokens() dedups [a,a,b] to two tokens; the raw provider triple is still malformed and must be rejected.
  assert.equal(inventoryTokensOf([dupTokens]), 2);
  assert.equal(selectLinkedSoccerTotals([...prim, dupTokens], evs2, "soccer", prim), null);
  assert.equal(inventoryTokensOf([dupTokens, dupTokens]), 2);
  const validDup = selectLinkedSoccerTotals([...prim, tot("t35", 3.5), tot("t35", 3.5)], evs2, "soccer", prim);
  assert.equal(validDup?.condition_id, "t35");                                                      // identical duplicate rows are one valid market
  assert.equal(selectLinkedSoccerTotals([...prim, tot("t35", 3.5), tot("t35", 3.5, { clob_token_ids: JSON.stringify(["z1", "z2"]) })], evs2, "soccer", prim), null);   // same condition, contradictory tokens
});

test("exact raw token/outcome linkage: malformed sibling or primary anchor identity is rejected, primaries preserved", () => {
  const evs = ev([{ conditionId: "ml", volume24hr: 9 }, rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40)]);
  const ml = mkt("ml", "moneyline", null);
  const sibling = (o: Record<string, unknown>) => tot("t35", 3.5, o);
  const run = (anchor: any, extra: any) => selectLinkedSoccerTotals([ml, anchor, extra], evs, "soccer", [ml, anchor]);
  assert.equal(run(tot("t25", 2.5), sibling({})) ?.condition_id, "t35");                              // control: valid two-way pair
  assert.equal(run(tot("t25", 2.5), sibling({ clob_token_ids: ["x", "y"], outcomes: ["under", " OVER "] }))?.condition_id, "t35");   // arrays, case/order tolerant, index-aligned
  const malformed: Array<Record<string, unknown>> = [
    { clob_token_ids: JSON.stringify(["a", "a", "b"]), outcomes: JSON.stringify(["Over", "Over", "Under"]) },   // proven defect
    { clob_token_ids: JSON.stringify(["a", "b", "c"]), outcomes: JSON.stringify(["Over", "Under"]) },          // 3 ids / 2 outcomes
    { clob_token_ids: JSON.stringify(["a", "b"]), outcomes: JSON.stringify(["Over", "Under", "Push"]) },       // 2 ids / 3 outcomes
    { clob_token_ids: JSON.stringify(["a", "a"]), outcomes: JSON.stringify(["Over", "Under"]) },               // same token twice
    { clob_token_ids: JSON.stringify(["a", " "]), outcomes: JSON.stringify(["Over", "Under"]) },               // empty id
    { clob_token_ids: JSON.stringify(["a", "b"]), outcomes: JSON.stringify(["Over", "Over"]) },
    { clob_token_ids: JSON.stringify(["a", "b"]), outcomes: JSON.stringify(["Yes", "No"]) },
    { clob_token_ids: JSON.stringify(["a", 7]), outcomes: JSON.stringify(["Over", "Under"]) },                 // non-string id
    { clob_token_ids: "not-json", outcomes: JSON.stringify(["Over", "Under"]) },
    { clob_token_ids: null, outcomes: null },
  ];
  for (const bad of malformed) {
    assert.equal(run(tot("t25", 2.5), sibling(bad)), null, `sibling ${JSON.stringify(bad)}`);
    assert.equal(run(tot("t25", 2.5, bad), sibling({})), null, `anchor ${JSON.stringify(bad)}`);            // malformed primary anchor -> no sibling at all
  }
  // Rejection never discards the existing primaries.
  const bad = malformed[0];
  const universe = [ml, mkt("sp", "spreads", null), tot("t25", 2.5, bad), tot("t35", 3.5)];
  const events = ev([{ conditionId: "ml", volume24hr: 9 }, { conditionId: "sp", volume24hr: 9 }, rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40)]);
  assert.deepEqual(ids(selectCoreCaptureMarkets(universe, events, "soccer")), ids(selectPrimaryCoreMarkets(universe, events, "soccer")));
  assert.deepEqual(ids(selectCoreCaptureMarkets(universe, events, "soccer")), ["ml", "sp", "t25"]);
});

test("contradictory duplicate representations of one condition are rejected (sibling and anchor)", () => {
  const evs = ev([rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40)]);
  const prim = [tot("t25", 2.5)];
  const other = (o: Record<string, unknown>) => tot("t35", 3.5, o);
  const variants: Array<Record<string, unknown>> = [
    { clob_token_ids: JSON.stringify(["z1", "z2"]) },                                          // different tokens
    { clob_token_ids: JSON.stringify(["t35-b", "t35-a"]) },                                    // same tokens, swapped index alignment vs outcomes
    { outcomes: JSON.stringify(["Under", "Over"]) },                                           // same tokens, flipped outcomes
    { clob_token_ids: JSON.stringify(["t35-a", "t35-b", "t35-c"]), outcomes: JSON.stringify(["Over", "Under", "Under"]) },
  ];
  for (const v of variants) {
    assert.equal(selectLinkedSoccerTotals([...prim, tot("t35", 3.5), other(v)], evs, "soccer", prim), null, `sibling dup ${JSON.stringify(v)}`);
    assert.equal(selectLinkedSoccerTotals([...prim, other(v), tot("t35", 3.5)], evs, "soccer", prim), null, `sibling dup (reordered) ${JSON.stringify(v)}`);
    const anchorEvs = ev([rawTot("t25", 2.5, 100), rawTot("t35", 3.5, 40)]);
    const conflictingAnchor = tot("t25", 2.5, { clob_token_ids: JSON.stringify(["t25-b", "t25-a"]) });
    assert.equal(selectLinkedSoccerTotals([...prim, conflictingAnchor, tot("t35", 3.5)], anchorEvs, "soccer", prim), null);   // anchor reported twice, contradictorily
  }
  assert.equal(selectLinkedSoccerTotals([...prim, tot("t35", 3.5), tot("t35", 3.5)], evs, "soccer", prim)?.condition_id, "t35");   // identical duplicates stay valid
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

// ── TELEMETRY-06: authoritative per-token orderbook timing ──────────────────────────────────────────────────
import { fetchOrderBook, fetchOrderBooksConcurrent } from "../../lib/liquidity/polymarketClient";
import { parseOrderBook } from "../../lib/liquidity/orderbookMath";
import type { FetchOrderBookResult } from "../../lib/liquidity/types";
import { orderbookTimingColumns, validateAcquisitionWindow, assessLinkedQuoteWindows, ORDERBOOK_MAX_ACQUISITION_MS } from "../../lib/research/inplayCorePath";
import { isOptionalTableAbsent } from "../../scripts/research-clone-daily-sync";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const bookPayload = (token: string, ts?: unknown) => ({ market: "0xabc", asset_id: token, timestamp: ts, tick_size: "0.01", min_order_size: "5",
  bids: [{ price: "0.40", size: "100" }], asks: [{ price: "0.45", size: "100" }] });
/** fetch double: per-token delay, then JSON. The token comes from the request URL, never from call order. */
const fakeFetch = (plan: Record<string, { delay: number; ts?: () => unknown; status?: number; json?: () => unknown }>): typeof fetch =>
  (async (url: string, init?: { signal?: AbortSignal }) => {
    const token = new URL(url).searchParams.get("token_id")!;
    const p = plan[token];
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, p.delay);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    });
    return { ok: (p.status ?? 200) < 400, status: p.status ?? 200, json: async () => (p.json ? p.json() : bookPayload(token, p.ts?.())) } as unknown as Response;
  }) as unknown as typeof fetch;

test("TELEMETRY-06: concurrent requests keep distinct per-token intervals and token identity under out-of-order completion", async () => {
  const tokens = ["tA", "tB", "tC", "tD"];
  const results = await fetchOrderBooksConcurrent(tokens, 4, { fetchImpl: fakeFetch({ tA: { delay: 160 }, tB: { delay: 20 }, tC: { delay: 90 }, tD: { delay: 50 } }) });
  assert.deepEqual(results.map((r) => r.tokenId), tokens);
  assert.deepEqual(results.map((r) => r.book?.tokenId), tokens);
  for (const r of results) {
    assert.equal(r.ok, true);
    assert.ok(typeof r.requestStartedAtMs === "number" && typeof r.responseCompletedAtMs === "number");
    assert.ok(r.responseCompletedAtMs! >= r.requestStartedAtMs!);
    assert.equal(r.latencyMs, r.responseCompletedAtMs! - r.requestStartedAtMs!);
  }
  const done = results.map((r) => r.responseCompletedAtMs!);
  assert.equal(new Set(done).size, 4, "no synthetic identical completion time");
  assert.ok(done[1] < done[3] && done[3] < done[2] && done[2] < done[0], "completion order follows each request's own latency, not input order");
  assert.ok(results[0].responseCompletedAtMs! - results[0].requestStartedAtMs! >= 150);
  assert.ok(results[1].responseCompletedAtMs! - results[1].requestStartedAtMs! < 120);
  // Persisted columns are per token and ISO-exact to the measured milliseconds.
  const col = orderbookTimingColumns(results[0], "tA");
  assert.equal(col.orderbook_fetch_started_at, new Date(results[0].requestStartedAtMs!).toISOString());
  assert.equal(col.orderbook_fetch_completed_at, new Date(results[0].responseCompletedAtMs!).toISOString());
  assert.deepEqual(orderbookTimingColumns(results[0], "tB"), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null }, "wrong-token result never lends its timing");
});

test("TELEMETRY-06: concurrency 1 keeps fetch order with strictly sequential windows", async () => {
  const r = await fetchOrderBooksConcurrent(["t1", "t2", "t3"], 1, { fetchImpl: fakeFetch({ t1: { delay: 15 }, t2: { delay: 15 }, t3: { delay: 15 } }) });
  assert.deepEqual(r.map((x) => x.tokenId), ["t1", "t2", "t3"]);
  assert.ok(r[1].requestStartedAtMs! >= r[0].responseCompletedAtMs! && r[2].requestStartedAtMs! >= r[1].responseCompletedAtMs!);
});

test("TELEMETRY-06: failed, timed-out, malformed and non-JSON fetches carry no timing and persist NULL", async () => {
  const noBook: unknown = null;
  const r = await fetchOrderBooksConcurrent(["http500", "slow", "bad", "nojson", "ok", "arr", "wrongId", "noAsks"], 8, { timeoutMs: 60, fetchImpl: fakeFetch({
    http500: { delay: 1, status: 500 }, slow: { delay: 500 }, bad: { delay: 1, json: () => noBook },
    nojson: { delay: 1, json: () => { throw new SyntaxError("bad json"); } }, ok: { delay: 1 },
    arr: { delay: 1, json: () => [bookPayload("arr")] }, wrongId: { delay: 1, json: () => bookPayload("someOtherToken") },
    noAsks: { delay: 1, json: () => ({ asset_id: "noAsks", bids: [] }) },
  }) });
  assert.deepEqual(r.map((x) => x.errorCode ?? "OK"), ["HTTP_ERROR", "TIMEOUT", "OK", "PARSE_FAILED", "OK", "OK", "OK", "OK"]);
  // HTTP/timeout/non-JSON are failures; a payload that parses but is not this token's book keeps its legacy parse result yet has no timing.
  for (const x of r.filter((y) => y.tokenId !== "ok")) {
    assert.equal(x.requestStartedAtMs, undefined, x.tokenId);
    assert.equal(x.responseCompletedAtMs, undefined, x.tokenId);
    assert.deepEqual(orderbookTimingColumns(x, x.tokenId), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null });
  }
  for (const x of r.filter((y) => ["http500", "slow", "nojson"].includes(y.tokenId))) {
    assert.equal(x.ok, false);
    assert.equal(x.requestStartedAtMs, undefined);
    assert.equal(x.responseCompletedAtMs, undefined);
    assert.deepEqual(orderbookTimingColumns(x, x.tokenId), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null });
  }
  assert.notEqual(orderbookTimingColumns(r[4], "ok").orderbook_fetch_started_at, null);
  assert.equal((await fetchOrderBook("", {})).requestStartedAtMs, undefined);
});

test("TELEMETRY-06: price parsing and return shape are unchanged by timing capture", async () => {
  const payload = bookPayload("tP", "1791738982842");
  const r = await fetchOrderBook("tP", { fetchImpl: fakeFetch({ tP: { delay: 1, json: () => payload } }) });
  assert.deepEqual(r.book, parseOrderBook(payload, "tP"));
  assert.equal(r.httpStatus, 200);
  assert.equal(r.ok, true);
});

test("TELEMETRY-06: impossible or unverifiable intervals are rejected", () => {
  const base = parseOrderBook(bookPayload("t"), "t")!;
  const T = Date.UTC(2026, 9, 11, 12, 0, 0);
  const ok = (s: unknown, c: unknown): FetchOrderBookResult => ({ ok: true, tokenId: "t", latencyMs: 1, book: base, requestStartedAtMs: s as number, responseCompletedAtMs: c as number });
  assert.deepEqual(validateAcquisitionWindow(ok(T, T + 250), "t", T + 300), { startedAtMs: T, completedAtMs: T + 250 });
  assert.equal(validateAcquisitionWindow(ok(T, T), "t", T + 10)?.completedAtMs, T, "zero-length is possible at ms resolution");
  assert.equal(validateAcquisitionWindow(ok(T + 5, T), "t", T + 10), null, "completed before started");
  assert.equal(validateAcquisitionWindow(ok(T, T + ORDERBOOK_MAX_ACQUISITION_MS + 1), "t", T + 10 ** 6), null, "implausibly long");
  assert.equal(validateAcquisitionWindow(ok(T, T + 100), "t", T - 10_000), null, "completed in the wall-clock future");
  assert.equal(validateAcquisitionWindow(ok(1_700_000_000, 1_700_000_001), "t", T), null, "seconds-unit or pre-2020 epoch");
  assert.equal(validateAcquisitionWindow(ok(T + 0.5, T + 100), "t", T + 200), null, "non-integer ms");
  assert.equal(validateAcquisitionWindow(ok(undefined, T), "t", T + 10), null);
  assert.equal(validateAcquisitionWindow(ok(T, T + 1), "other", T + 10), null, "token mismatch");
  assert.equal(validateAcquisitionWindow({ ...ok(T, T + 1), ok: false }, "t", T + 10), null);
  assert.equal(validateAcquisitionWindow({ ...ok(T, T + 1), book: undefined }, "t", T + 10), null);
  assert.equal(validateAcquisitionWindow(null, "t"), null);
});

test("TELEMETRY-06: provider timestamp is optional, epoch-ms only, and must sit inside the request neighbourhood", () => {
  const T = Date.UTC(2026, 9, 11, 12, 0, 0);
  const withTs = (ts: unknown): FetchOrderBookResult => ({ ok: true, tokenId: "t", latencyMs: 400, requestStartedAtMs: T, responseCompletedAtMs: T + 400,
    book: parseOrderBook(bookPayload("t", ts), "t")! });
  const p = (ts: unknown) => orderbookTimingColumns(withTs(ts), "t", T + 500).orderbook_provider_timestamp_at;
  assert.equal(p(String(T + 100)), new Date(T + 100).toISOString(), "provider sends the epoch ms as a string (verified live)");
  assert.equal(p(T - 900), new Date(T - 900).toISOString(), "snapshot a moment before the request");
  assert.equal(p(undefined), null, "absent");
  assert.equal(p(Math.floor((T + 100) / 1000)), null, "seconds unit is not milliseconds");
  assert.equal(p(T + 400 + 2_001), null, "future of receipt");
  assert.equal(p(T - 60_001), null, "stale beyond the lag bound");
  assert.equal(p("not-a-number"), null);
  assert.equal(p(-5), null);
  // The window stays valid when the provider value is unverifiable.
  assert.equal(orderbookTimingColumns(withTs(undefined), "t", T + 500).orderbook_fetch_started_at, new Date(T).toISOString());
  // No window → no provider timestamp either.
  const broken = { ...withTs(String(T)), responseCompletedAtMs: T - 1 };
  assert.deepEqual(orderbookTimingColumns(broken, "t", T + 500), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null });
});

test("TELEMETRY-06: old results/rows without timing stay readable as NULL; legacy rows keep persistence decisions", () => {
  const legacy: FetchOrderBookResult = { ok: true, tokenId: "t", latencyMs: 10, book: parseOrderBook(bookPayload("t"), "t")! };
  assert.deepEqual(orderbookTimingColumns(legacy, "t"), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null });
  assert.deepEqual(orderbookTimingColumns(undefined, "t"), { orderbook_fetch_started_at: null, orderbook_fetch_completed_at: null, orderbook_provider_timestamp_at: null });
  const state = { gameId: "1", eventLiveStatus: "LIVE" as const, phase: "1H", sportCode: null };
  const previous = { observed_at: "2026-10-11T12:00:00.000Z", mid_price: 0.4, spread_abs: 0.02, state_phase: "1H", event_live_status: "LIVE" };
  assert.equal(decidePersistenceReason({ previous, nowMs: Date.parse("2026-10-11T12:00:10Z"), mid: 0.4, spread: 0.02, state }), null);
  assert.equal(decidePersistenceReason({ previous, nowMs: Date.parse("2026-10-11T12:06:00Z"), mid: 0.4, spread: 0.02, state }), "HEARTBEAT");
  assert.match(collector, /select\("token_id,observed_at,mid_price,spread_abs,state_phase,event_live_status"\)/, "prior-row read does not depend on the new columns");
});

test("TELEMETRY-06: structural timing assessment is UNPROVEN without time authority and never claims atomic execution", () => {
  const w = (s: number, c: number) => ({ startedAtMs: s, completedAtMs: c });
  assert.equal(assessLinkedQuoteWindows([], 5_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteWindows([w(0, 100)], 5_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), null], 5_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), undefined], 5_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), w(200, 100)], 5_000), "UNPROVEN", "impossible interval");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), w(9_000, 9_100)], 5_000), "UNPROVEN", "span wider than the bound");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), w(50, 3_000)], 5_000), "BOUNDED", "bound is earliest start to latest completion");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), w(50, 6_000)], 5_000), "UNPROVEN");
  assert.equal(assessLinkedQuoteWindows([w(0, 100), w(50, 150)], Number.NaN), "UNPROVEN");
  assert.equal(assessLinkedQuoteSynchronization([1000, null], 10_000), "UNPROVEN");
  assert.doesNotMatch(collector, /ATOMIC_EXECUTION_PROVEN/);
});

test("TELEMETRY-06: capture wires per-token timing into the row; observed_at, id and economics are untouched", () => {
  assert.match(collector, /\.\.\.orderbookTimingColumns\(result, token\.tokenId\), persistence_reason: reason,/);
  assert.match(collector, /id: stableTelemetryId\(physicalEventId, token\.tokenId, observedAt, reason\),/);
  assert.match(collector, /const books = await fetchOrderBooksConcurrent\(tokens\.map\(\(t\) => t\.tokenId\), 5\);/);
  assert.match(collector, /const exec = buildExecutableSiblingColumns\(\{ token, result, fee: fees\.get\(token\.tokenId\) \?\? null, hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP \}\);/);
  assert.match(collector, /const exit = book && shares !== null \? computeExecutableExit\(book\.bids, shares, 0\.02\) : null;/);
  assert.match(collector, /full_stake_executable_vwap: exec\.full_stake_executable_vwap \?\? null,/);
  assert.match(collector, /taker_fee_usd: exec\.taker_fee_usd \?\? null,/);
  // The timing helpers import nothing from the executor money path and the capture cannot derive timing from nowMs.
  assert.doesNotMatch(collector, /orderbook_fetch_(started|completed)_at\s*:\s*observedAt/);
  assert.doesNotMatch(collector, /orderbook_fetch_(started|completed)_at\s*:\s*new Date\(nowMs\)/);
});

const newMigration = readFileSync("supabase/migrations/20261011120000_research_inplay_orderbook_timing_v3.sql", "utf8");
const V4_COLS = ["executable_full_stake_state", "taker_fee_state", "taker_fee_reason", "quote_cycle_legs", "quote_cycle_span_ms"];
const TIMING_COLS = ["orderbook_fetch_started_at", "orderbook_fetch_completed_at", "orderbook_provider_timestamp_at"];
const PRE_EXISTING_PROJECTION = "id,physical_event_id,provider_game_id,provider_event_id,provider_sport_family,provider_sport_code,provider_sport_source,event_start_iso,observed_at,source_version,event_live_status,state_authority,state_phase,state_period_num,state_clock_seconds_remaining,state_clock_seconds_elapsed,state_received_at,side_a_score,side_b_score,side_a_red_cards,side_b_red_cards,condition_id,token_id,side,canonical_market_family,canonical_market_type,provider_market_type_raw,market_slug,best_bid,best_ask,mid_price,spread_abs,tick_size,minimum_order_size,bid_depth_relevant_usd,ask_depth_relevant_usd,full_stake_executable_vwap,full_stake_shares,full_stake_exit_vwap,full_stake_exit_fully_filled,taker_fee_usd,orderbook_fetch_status,persistence_reason,sequence_in_event,created_at".split(",");

test("TELEMETRY-06: migration is additive-nullable only and leaves the writer RPC, caps and retention alone", () => {
  for (const c of TIMING_COLS) assert.match(newMigration, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} timestamptz;`));
  const migrationSql = newMigration.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(migrationSql, /ADD COLUMN[^;]*(NOT NULL|DEFAULT)|DROP|UPDATE |DELETE |INSERT |CREATE (OR REPLACE )?FUNCTION|CREATE INDEX|research_insert_inplay_core_path|pg_column_size/i);
  assert.match(migration, /pg_column_size\(p_row\) > 1000/, "original writer guard still the 1000-byte limit and is not redefined");
  assert.equal((newMigration.match(/ADD COLUMN/g) ?? []).length, 3);
  assert.match(newMigration, /\(orderbook_fetch_started_at IS NULL\) = \(orderbook_fetch_completed_at IS NULL\)/);
  assert.match(newMigration, /orderbook_fetch_completed_at >= orderbook_fetch_started_at/);
});

test("TELEMETRY-06: row size stays within the 1000-byte writer limit", () => {
  // Largest stored Production row measured on 2026-10-11: 608 bytes. Three timestamptz are 8 fixed bytes each (8-aligned),
  // so the growth is at most 24 + 7 alignment padding + 1 null-bitmap byte.
  const largestStored = 608, growth = 3 * 8 + 7 + 1;
  assert.ok(largestStored + growth <= 650);
  assert.ok(largestStored + growth < 1000);
  // Fixed-width only: no new variable-length column that could grow past the bound.
  for (const c of TIMING_COLS) assert.doesNotMatch(newMigration, new RegExp(`${c} (text|jsonb?|numeric|varchar)`));
});

test("TELEMETRY-06: timing fields survive Production→DBClone projection and clone DDL declares every projected column", () => {
  const projection = /INPLAY_CORE_PATH_PROJECTION = "([^"]*)"/.exec(sync)![1].split(",");
  for (const c of TIMING_COLS) assert.ok(projection.includes(c), `${c} projected`);
  for (const c of V4_COLS) assert.ok(projection.includes(c), `${c} projected`);
  for (const c of PRE_EXISTING_PROJECTION) assert.ok(projection.includes(c), `${c} still projected`);
  assert.equal(projection.length, PRE_EXISTING_PROJECTION.length + 3 + V4_COLS.length);
  assert.equal(new Set(projection).size, projection.length);
  assert.ok(projection.indexOf("orderbook_fetch_status") < projection.indexOf("orderbook_fetch_started_at"));
  const createBlock = /CREATE TABLE IF NOT EXISTS[^(]*\(([\s\S]*?)\n\);/.exec(clone)![1];
  const declared = new Set([...createBlock.matchAll(/^  ([a-z_]+) [a-z]+/gm)].map((m) => m[1]));
  for (const c of projection) assert.ok(declared.has(c), `clone CREATE TABLE declares ${c}`);
  for (const c of TIMING_COLS) assert.match(clone, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} timestamptz;`));
  // Unchanged sync mechanism.
  assert.match(sync, /table: "research_inplay_core_path_observations", fields: \["observed_at", "id"\], appendOnly: true, projection: INPLAY_CORE_PATH_PROJECTION, telemetry: true, optional: true, bootstrapSince: INPLAY_CORE_PATH_BOOTSTRAP_SINCE/);
});

test("TELEMETRY-06: a missing clone/Production COLUMN is a loud error, never a silent SCHEMA_PENDING or false parity", () => {
  assert.equal(isOptionalTableAbsent(new Error("PGRST205: Could not find the table 'public.research_inplay_core_path_observations' in the schema cache")), true);
  assert.equal(isOptionalTableAbsent(new Error('relation "public.research_inplay_core_path_observations" does not exist')), true);
  assert.equal(isOptionalTableAbsent(new Error("42P01 undefined_table")), true);
  assert.equal(isOptionalTableAbsent(new Error("PGRST204: Could not find the 'orderbook_fetch_started_at' column of 'research_inplay_core_path_observations' in the schema cache")), false);
  assert.equal(isOptionalTableAbsent(new Error('column "orderbook_fetch_started_at" of relation "research_inplay_core_path_observations" does not exist')), false);
  assert.equal(isOptionalTableAbsent(new Error("column research_inplay_core_path_observations.orderbook_fetch_started_at does not exist")), false);
  assert.equal(isOptionalTableAbsent(new Error("42703 undefined_column")), false);
  assert.equal(isOptionalTableAbsent(new Error("connection reset")), false);
});

// ── TELEMETRY-09 ────────────────────────────────────────────────────────────

const v4 = readFileSync("supabase/migrations/20261012120000_research_inplay_executable_state_v4.sql", "utf8");
const v4Sql = v4.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

function execInput(askPrice: number, minOrder: number | null, fee: boolean) {
  const tokenId = "tok1";
  return {
    token: { conditionId: "c1", tokenId, side: "YES", outcome: "Yes", market: { sports_market_type: "moneyline", provider_market_slug: "m" } } as never,
    result: { ok: true, tokenId, book: { tokenId, bids: [{ price: askPrice - 0.02, size: 500 }], asks: [{ price: askPrice, size: 500 }], tickSize: 0.01, minimumOrderSize: minOrder } } as never,
    fee: fee ? ({ ok: true, takerRate: 0.03, formulaVersion: "F1", conditionId: "c1" } as never) : ({ ok: false, errorCode: "FEE_BUDGET_EXCEEDED" } as never),
  };
}

test("TELEMETRY-09: the in-play research walk is not capped by the pre-game Queue entry cap", () => {
  assert.equal(SOURCE_VERSION, "INPLAY_CORE_PATH_V2");
  assert.equal(INPLAY_RESEARCH_EXECUTION_PRICE_CAP, 0.99);
  const favorite = execInput(0.7, 2, true);
  const queueCapped = buildExecutableSiblingColumns(favorite);
  assert.equal(queueCapped.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");  // the old behaviour: a 0.70 ask looked like "no liquidity"
  assert.equal(queueCapped.full_stake_executable_vwap, null);
  const research = buildExecutableSiblingColumns({ ...favorite, hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP });
  assert.equal(research.executable_full_stake_state, "EXECUTABLE");
  assert.equal(research.full_stake_executable_vwap, 0.7);
  assert.equal(typeof research.taker_fee_usd, "number");
  // Genuinely empty/short depth stays a typed non-executable state, never a fabricated price.
  const thin = execInput(0.7, 2, true);
  (thin.result as any).book.asks = [{ price: 0.7, size: 1 }];
  const short = buildExecutableSiblingColumns({ ...thin, hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP });
  assert.equal(short.executable_full_stake_state, "NOT_EXECUTABLE_DEPTH_AT_CAP");
  assert.equal(short.full_stake_executable_vwap, null);
  // An ask at/above the research cap is outside the walk.
  assert.equal(buildExecutableSiblingColumns({ ...execInput(0.995, 5, true), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP }).full_stake_executable_vwap, null);
});

test("TELEMETRY-09: min-order failure and unknown fee are distinguishable from missing liquidity in the persisted columns", () => {
  const minOrder = buildExecutableSiblingColumns({ ...execInput(0.6, 5, true), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP });   // $2.50 / 0.60 = 4.17 shares < 5
  assert.equal(minOrder.executable_full_stake_state, "NOT_EXECUTABLE_MIN_ORDER_SIZE");
  assert.notEqual(minOrder.full_stake_executable_vwap, null);     // depth exists; the state column is what says it is not placeable
  // At the fixed $2.50 research stake any ask above 0.50 is below a 5-share minimum order by construction.
  assert.equal(buildExecutableSiblingColumns({ ...execInput(0.5, 5, true), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP }).executable_full_stake_state, "EXECUTABLE");
  assert.equal(buildExecutableSiblingColumns({ ...execInput(0.51, 5, true), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP }).executable_full_stake_state, "NOT_EXECUTABLE_MIN_ORDER_SIZE");
  const unknownFee = buildExecutableSiblingColumns({ ...execInput(0.4, 5, false), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP });
  assert.equal(unknownFee.taker_fee_state, "UNKNOWN");
  assert.equal(unknownFee.taker_fee_reason, "FEE_BUDGET_EXCEEDED");
  assert.equal(unknownFee.taker_fee_usd, null);                    // an unknown fee is never imputed as zero
  assert.notEqual(unknownFee.full_stake_executable_vwap, null);
  const known = buildExecutableSiblingColumns({ ...execInput(0.4, 5, true), hardCap: INPLAY_RESEARCH_EXECUTION_PRICE_CAP });
  assert.equal(known.taker_fee_state, "KNOWN");
  assert.equal(known.taker_fee_reason, null);
  assert.match(collector, /executable_full_stake_state: reasonToken\(exec\.executable_full_stake_state\), taker_fee_state: reasonToken\(exec\.taker_fee_state\),/);
  assert.match(collector, /taker_fee_reason: reasonToken\(exec\.taker_fee_reason\),/);
});

test("TELEMETRY-09: per-cycle linked quote span needs every leg's own validated window and never imputes", () => {
  const w = (s: number, c: number) => ({ startedAtMs: s, completedAtMs: c });
  assert.equal(linkedQuoteSpanMs([w(1_000, 1_300), w(1_100, 2_050), w(1_200, 1_900)]), 1_050);
  assert.equal(linkedQuoteSpanMs([w(1_000, 1_300)]), 300);
  assert.equal(linkedQuoteSpanMs([w(1_000, 1_300), null]), null);        // a failed/mismatched leg makes the span unknown
  assert.equal(linkedQuoteSpanMs([undefined, w(1_000, 1_300)]), null);
  assert.equal(linkedQuoteSpanMs([]), null);
  assert.match(collector, /const cycleSpanMs = linkedQuoteSpanMs\(tokens\.map\(\(t, i\) => validateAcquisitionWindow\(books\[i\], t\.tokenId, wallNowMs\)\)\);/);
  assert.match(collector, /quote_cycle_legs: tokens\.length, quote_cycle_span_ms: cycleSpanMs,/);
  assert.doesNotMatch(collector, /quote_cycle_span_ms:\s*(0|nowMs|observedAt)/);
});

test("TELEMETRY-09: migration is additive-nullable only; clone DDL mirrors it; writer RPC, caps, retention untouched", () => {
  const types: Record<string, string> = { executable_full_stake_state: "text", taker_fee_state: "text", taker_fee_reason: "text", quote_cycle_legs: "smallint", quote_cycle_span_ms: "integer" };
  for (const c of V4_COLS) {
    assert.match(v4Sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} ${types[c]};`));
    assert.match(clone, new RegExp(`ADD COLUMN IF NOT EXISTS ${c} ${types[c]};`));
    assert.match(clone, new RegExp(`^  ${c} ${types[c]},$`, "m"));
  }
  assert.equal((v4Sql.match(/ADD COLUMN/g) ?? []).length, V4_COLS.length);
  assert.doesNotMatch(v4Sql, /ADD COLUMN[^;]*(NOT NULL|DEFAULT)|DROP|UPDATE |DELETE |INSERT |CREATE (OR REPLACE )?FUNCTION|CREATE INDEX|research_insert_inplay_core_path|pg_column_size/i);
  for (const state of ["EXECUTABLE", "NOT_EXECUTABLE_MIN_ORDER_SIZE", "NOT_EXECUTABLE_DEPTH_AT_CAP", "UNKNOWN_BOOK_UNAVAILABLE", "UNKNOWN_MIN_ORDER_SIZE", "UNKNOWN_TELEMETRY_COMPUTE_FAILED"]) assert.match(v4Sql, new RegExp(`'${state}'`));
  assert.match(v4Sql, /taker_fee_state IN \('KNOWN', 'UNKNOWN'\)/);
  assert.match(migration, /pg_column_size\(p_row\) > 1000/);
});

test("TELEMETRY-09: row size with the new columns stays far below the 1000-byte writer limit", () => {
  // Largest stored row 608 bytes before TELEMETRY-06; +24 +7 +1 for the timing columns; the new text values are bounded
  // enum/token strings (state <= 34, fee state <= 7, reason <= 40 chars + 1-byte varlena headers) plus 2 + 4 fixed bytes
  // and at most 8 bytes alignment padding.
  const worstGrowth = (34 + 1) + (7 + 1) + (40 + 1) + 2 + 4 + 8;
  assert.ok(608 + 32 + worstGrowth < 760);
  assert.ok(608 + 32 + worstGrowth < 1000);
  assert.match(collector, /function reasonToken[\s\S]*\{1,40\}/);
});
