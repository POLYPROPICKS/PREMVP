import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HARD_CAPS, RAW_ROW_CAP, RETENTION_SEMANTICS, boundedDayRowsSql, buildCoverage, cloneFreshness, coverageAggregateSql, mechanismReadiness,
  minskDayBounds, minskDayOf, parseCloneAggregate, storageAggregateSql, storageObservability, threeDayReadiness,
  type CoverageAggregate, type DailyRow,
} from "../../lib/modeling/inplay-shadow/dailyScorecard";
import { PROBE_COLUMNS } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";
import { CLONE_PROJECT_REF } from "../../scripts/modeling/inplay-daily-scorecard";
import {
  MAX_DAILY_PHYSICAL_EVENTS, MAX_INPLAY_LOGICAL_MB_PER_DAY, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY, MAX_TRACKED_TOKENS_PER_EVENT,
  PRODUCTION_RETENTION_HOURS,
} from "../../lib/research/inplayCorePath";
import type { InplayObservation } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";

const DAY = "2026-10-08"; // Minsk day = 2026-10-07T21:00Z .. 2026-10-08T21:00Z
const SCRIPT = "scripts/modeling/inplay-daily-scorecard.ts";
const MODULE = "lib/modeling/inplay-shadow/dailyScorecard.ts";

type Cell = { sport: string; market: string; row_n?: number; event_n?: number; token_n?: number };
/** Builds the aggregate the server would return for a day whose (sport, market) cells are given. */
function agg(cells: Cell[], opts: { multi?: number } = {}): CoverageAggregate {
  const full = cells.map((c) => ({ sport: c.sport, market: c.market, row_n: c.row_n ?? 2, event_n: c.event_n ?? 1, token_n: c.token_n ?? 2 }));
  const sport_event_n: Record<string, number> = {};
  for (const c of full) sport_event_n[c.sport] = Math.max(sport_event_n[c.sport] ?? 0, c.event_n);
  const sum = (k: "row_n" | "event_n" | "token_n") => full.reduce((a, c) => a + c[k], 0);
  return {
    day: { row_n: sum("row_n"), event_n: Math.max(0, ...Object.values(sport_event_n)), token_n: sum("token_n"), min_observed_at: "2026-10-08T08:00:00.000Z", max_observed_at: "2026-10-08T10:00:00.000Z" },
    sport_event_n, cells: full, core_multi_family_event_candidate_n: opts.multi ?? 0,
  };
}
const tennisMl = (event_n = 2): Cell => ({ sport: "tennis", market: "MONEYLINE", event_n });

test("1 Minsk day boundaries are exact (UTC+3, [start,end)) in code and in the aggregate SQL", () => {
  assert.deepEqual(minskDayBounds(DAY), { startUtc: "2026-10-07T21:00:00.000Z", endUtc: "2026-10-08T21:00:00.000Z" });
  assert.equal(minskDayOf("2026-10-07T20:59:59.999Z"), "2026-10-07");
  assert.equal(minskDayOf("2026-10-07T21:00:00.000Z"), "2026-10-08");
  assert.equal(minskDayOf("2026-10-08T20:59:59Z"), "2026-10-08");
  assert.equal(minskDayOf("2026-10-08T21:00:00Z"), "2026-10-09");
  assert.throws(() => minskDayBounds("2026-13-40"));
  assert.throws(() => minskDayBounds("2026-10-8"));
  const sql = coverageAggregateSql(DAY);
  assert.match(sql, /observed_at >= TIMESTAMPTZ '2026-10-07T21:00:00\.000Z' AND observed_at < TIMESTAMPTZ '2026-10-08T21:00:00\.000Z'/);
  assert.match(sql, /\+ INTERVAL '3 hours'/); // fixed UTC+3, not a tz database lookup
  assert.match(boundedDayRowsSql(DAY, ["id", "observed_at"], new Set(), new Set(["observed_at"])), /observed_at >= TIMESTAMPTZ '2026-10-07T21:00:00\.000Z' AND observed_at < TIMESTAMPTZ '2026-10-08T21:00:00\.000Z'/);
});

test("2 single tennis/MONEYLINE aggregate => SINGLE_SPORT_ONLY + MONEYLINE_ONLY, zeroes present", () => {
  const c = buildCoverage(agg([tennisMl()]));
  assert.equal(c.MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
  assert.equal(c.MULTIMARKET_STATE, "MONEYLINE_ONLY");
  assert.equal(c.SOCCER_CORNERS_STATE, "NO_SAMPLE");
  assert.equal(c.TENNIS_EVENT_N, 2);
  for (const f of ["SOCCER_EVENT_N", "SOCCER_MONEYLINE_EVENT_N", "SOCCER_SPREAD_EVENT_N", "SOCCER_TOTAL_EVENT_N", "SOCCER_TOTAL_CORNERS_EVENT_N", "BASKETBALL_EVENT_N",
    "BASKETBALL_MONEYLINE_EVENT_N", "BASKETBALL_SPREAD_EVENT_N", "BASKETBALL_TOTAL_EVENT_N", "HOCKEY_EVENT_N", "HOCKEY_MONEYLINE_EVENT_N", "HOCKEY_SPREAD_EVENT_N",
    "HOCKEY_TOTAL_EVENT_N", "BASEBALL_EVENT_N", "AMERICAN_FOOTBALL_EVENT_N"] as const) assert.equal(c[f], 0, f);
  assert.deepEqual(c.sport_market_matrix, { "tennis|MONEYLINE": { row_n: 2, event_n: 2, token_n: 2 } });
  assert.equal(buildCoverage(agg([])).MULTIMARKET_STATE, "OTHER_INCOMPLETE");
  assert.equal(buildCoverage(agg([{ sport: "tennis", market: "TOTAL" }])).MULTIMARKET_STATE, "OTHER_INCOMPLETE");
});

test("3 two distinct non-esports sports => MULTISPORT READY; esports excluded", () => {
  assert.equal(buildCoverage(agg([tennisMl(), { sport: "basketball", market: "MONEYLINE" }])).MULTISPORT_STATE, "READY");
  assert.equal(buildCoverage(agg([tennisMl(), { sport: "esports", market: "MONEYLINE" }])).MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
});

test("4 two market types => MULTIMARKET READY with per-sport/market event counts", () => {
  const c = buildCoverage(agg([{ sport: "soccer", market: "MONEYLINE" }, { sport: "soccer", market: "TOTAL" }], { multi: 1 }));
  assert.equal(c.MULTIMARKET_STATE, "READY");
  assert.equal(c.SOCCER_EVENT_N, 1);
  assert.equal(c.SOCCER_MONEYLINE_EVENT_N, 1);
  assert.equal(c.SOCCER_TOTAL_EVENT_N, 1);
  assert.equal(c.CORE_MULTI_FAMILY_EVENT_CANDIDATE_N, 1);
  assert.equal(c.MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
});

test("5 soccer TOTAL_CORNERS aggregate => SOCCER_CORNERS_STATE PROVEN; tennis corners does not", () => {
  const c = buildCoverage(agg([{ sport: "soccer", market: "TOTAL_CORNERS", event_n: 3 }]));
  assert.equal(c.SOCCER_CORNERS_STATE, "PROVEN");
  assert.equal(c.SOCCER_TOTAL_CORNERS_EVENT_N, 3);
  assert.equal(buildCoverage(agg([{ sport: "tennis", market: "TOTAL_CORNERS" }])).SOCCER_CORNERS_STATE, "NO_SAMPLE");
  assert.equal(buildCoverage(agg([{ sport: "soccer", market: "MONEYLINE" }])).SOCCER_CORNERS_STATE, "NO_SAMPLE");
  // classifier/test readiness cannot feed a state: the module imports only the probes
  const imports = [...readFileSync(MODULE, "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./inplayShadowProbes"]);
});

test("6 clone lag > 90m => STALE; <= 90 FRESH; no production read => UNKNOWN", () => {
  assert.deepEqual(cloneFreshness("2026-10-08T12:00:00Z", "2026-10-08T10:29:00Z"), { CLONE_LAG_MINUTES: 91, CLONE_FRESHNESS: "STALE" });
  assert.equal(cloneFreshness("2026-10-08T12:00:00Z", "2026-10-08T10:30:00Z").CLONE_FRESHNESS, "FRESH");
  assert.equal(cloneFreshness(null, "2026-10-08T10:30:00Z").CLONE_FRESHNESS, "UNKNOWN");
  assert.equal(cloneFreshness("2026-10-08T12:00:00Z", null).CLONE_FRESHNESS, "STALE");
});

test("7 48h retention applies to PRODUCTION, never DBClone history", () => {
  assert.equal(HARD_CAPS.retention_hours, PRODUCTION_RETENTION_HOURS);
  assert.match(RETENTION_SEMANTICS, /PRODUCTION \(source\)/);
  assert.match(RETENTION_SEMANTICS, /DBClone keeps the full history/);
  assert.doesNotMatch(RETENTION_SEMANTICS, /clone purges/i);
  assert.equal(threeDayReadiness([], "2026-10-08T12:00:00Z").RETENTION_NOTE, RETENTION_SEMANTICS);
  assert.doesNotMatch(readFileSync(MODULE, "utf8"), /clone purges/i);
});

test("8 three complete clone days older than 48h produce THREE_DAY_GATE_READY = YES", () => {
  const daily: DailyRow[] = [
    { minsk_date: "2026-10-01", event_n: 5, row_n: 400 }, { minsk_date: "2026-10-02", event_n: 9, row_n: 900 }, { minsk_date: "2026-10-03", event_n: 6, row_n: 650 },
  ];
  const now = "2026-10-08T12:00:00Z"; // every qualifying day is far older than the 48h Production window
  assert.ok(Date.parse(now) - Date.parse("2026-10-03T21:00:00Z") > HARD_CAPS.retention_hours * 3_600_000);
  const t = threeDayReadiness(daily, now);
  assert.equal(t.COMPLETE_DAYS_WITH_MIN_5_EVENTS, 3);
  assert.equal(t.THREE_DAY_GATE_READY, "YES");
  assert.equal(t.DAYS["2026-10-02"].row_n, 900);
});

test("9 partial current day and sub-5-event days cannot count toward the 3-day gate", () => {
  const rows: DailyRow[] = [
    { minsk_date: "2026-10-05", event_n: 5, row_n: 1 }, { minsk_date: "2026-10-06", event_n: 5, row_n: 1 },
    { minsk_date: "2026-10-07", event_n: 4, row_n: 1 }, { minsk_date: "2026-10-08", event_n: 50, row_n: 1 },
  ];
  const t = threeDayReadiness(rows, "2026-10-08T12:00:00Z");
  assert.equal(t.COMPLETE_DAYS_WITH_DATA, 3);
  assert.equal(t.COMPLETE_DAYS_WITH_MIN_5_EVENTS, 2);
  assert.equal(t.THREE_DAY_GATE_READY, "NO");
  assert.equal(t.DAYS["2026-10-08"].status, "PARTIAL_NOT_COUNTED");
  assert.equal(threeDayReadiness([...rows.slice(0, 2), { minsk_date: "2026-10-07", event_n: 5, row_n: 1 }, rows[3]], "2026-10-08T12:00:00Z").THREE_DAY_GATE_READY, "YES");
  assert.equal(threeDayReadiness(rows, "2026-10-07T20:59:00Z").COMPLETE_DAYS_WITH_DATA, 2); // 23:59 Minsk on 10-07: only 10-05 and 10-06 are complete
});

test("10 coverage/day-readiness come from ONE server-side aggregate, not a raw-row scan", () => {
  const sql = coverageAggregateSql(DAY);
  assert.match(sql, /GROUPING SETS/);
  assert.match(sql, /count\(DISTINCT physical_event_id\)/);
  assert.match(sql, /min\(observed_at\)/);
  assert.match(sql, /max\(observed_at\)/);
  assert.match(sql, /GROUP BY 1/); // per-Minsk-day history aggregated in SQL
  assert.doesNotMatch(sql, /select\s+\*/i);
  assert.doesNotMatch(sql, /\bLIMIT\b/i); // no raw rows in the aggregate statement at all
  const src = readFileSync(SCRIPT, "utf8") + readFileSync(MODULE, "utf8");
  assert.doesNotMatch(src, /KEY_SCAN|keyScan|KEY_COLUMNS|KeyRow|rowsInMinskDay|\.range\(|PAGE\b/);
  // the shape the server returns round-trips (jsonb may arrive parsed or as strings)
  const row = {
    cells: JSON.stringify([
      { sport: null, market: null, gs: 1, gm: 1, row_n: 616, event_n: 20, token_n: 40, min_at: "2026-10-08T07:00:00.000Z", max_at: "2026-10-08T11:00:00.000Z" },
      { sport: "tennis", market: null, gs: 0, gm: 1, row_n: 616, event_n: 20, token_n: 40, min_at: null, max_at: null },
      { sport: "tennis", market: "MONEYLINE", gs: 0, gm: 0, row_n: 616, event_n: 20, token_n: 40, min_at: null, max_at: null },
    ]),
    multi_n: "0", daily: [{ minsk_date: "2026-10-08", event_n: 20, row_n: 616 }], clone_row_n: 616, clone_max_observed_at: "2026-10-08T11:00:00.000Z",
  };
  const parsed = parseCloneAggregate(row);
  assert.equal(parsed.cloneRowN, 616);
  const c = buildCoverage(parsed.coverage);
  assert.deepEqual([c.row_n, c.event_n, c.token_n, c.TENNIS_EVENT_N, c.MULTISPORT_STATE, c.MULTIMARKET_STATE], [616, 20, 40, 20, "SINGLE_SPORT_ONLY", "MONEYLINE_ONLY"]);
  assert.equal(c.observed_from_minsk, "2026-10-08 10:00:00 Minsk");
  assert.throws(() => parseCloneAggregate({ ...row, multi_n: -1 }), /SCORECARD_AGGREGATE_SHAPE/);
  assert.throws(() => parseCloneAggregate(undefined), /SCORECARD_AGGREGATE_SHAPE/);
});

test("11 no path can request more than 200 raw observation rows", () => {
  assert.equal(RAW_ROW_CAP, 200);
  const raw = boundedDayRowsSql(DAY, PROBE_COLUMNS, new Set(["mid_price"]), new Set(["observed_at"]));
  assert.match(raw, /LIMIT 200$/);
  assert.doesNotMatch(raw, /select\s+\*/i);
  assert.match(raw, /mid_price::float8 AS mid_price/);
  const script = readFileSync(SCRIPT, "utf8");
  assert.equal([...script.matchAll(/boundedDayRowsSql\(/g)].length, 1); // the single raw-read site
  assert.match(script, /coverage\.row_n <= RAW_ROW_CAP/); // only when the aggregate proves the day fits
  assert.match(script, /rawObservationRowsRead > RAW_ROW_CAP/);
  assert.equal(mechanismReadiness(RAW_ROW_CAP + 1, null, 3).TAIL_SAMPLE, "SAMPLE_CAP_BLOCKED");
  // the aggregate statements never project a raw observation row
  for (const sql of [coverageAggregateSql(DAY), storageAggregateSql("2026-10-08T00:00:00Z")]) assert.doesNotMatch(sql, /\bLIMIT\b|select\s+\*/i);
  assert.throws(() => boundedDayRowsSql(DAY, ["id; DROP TABLE x"], new Set(), new Set()));
});

test("12 storage hard caps unchanged and pinned to the collector", () => {
  assert.deepEqual({ ...HARD_CAPS }, { mb_per_day: 20, rows_per_day: 20000, events_per_day: 100, rows_per_event: 192, tokens_per_event: 16, retention_hours: 48 });
  assert.equal(HARD_CAPS.mb_per_day, MAX_INPLAY_LOGICAL_MB_PER_DAY);
  assert.equal(HARD_CAPS.rows_per_day, MAX_TOTAL_ROWS_PER_DAY);
  assert.equal(HARD_CAPS.events_per_day, MAX_DAILY_PHYSICAL_EVENTS);
  assert.equal(HARD_CAPS.rows_per_event, MAX_PERSISTED_OBSERVATIONS_PER_EVENT);
  assert.equal(HARD_CAPS.tokens_per_event, MAX_TRACKED_TOKENS_PER_EVENT);
  assert.equal(HARD_CAPS.retention_hours, PRODUCTION_RETENTION_HOURS);
  assert.throws(() => { (HARD_CAPS as any).rows_per_day = 1; });
  const base = { relationBytes: 1_000_000, productionRowN: 1000, rowsLast24h: 1000, eventsLast24h: 24, maxRowsPerEvent24h: 60, maxTokensPerEvent24h: 2, spanHours24h: 24 };
  const pass = storageObservability(base);
  assert.equal(pass.APPROX_BYTES_PER_ROW, 1000);
  assert.equal(pass.ESTIMATED_MB_DAY, 1);
  assert.equal(pass.ESTIMATE_LABEL, "OBSERVED_24H");
  assert.equal(pass.STORAGE_BUDGET_STATE, "PASS");
  assert.equal(storageObservability({ ...base, eventsLast24h: 60 }).STORAGE_BUDGET_STATE, "WARN");
  assert.equal(storageObservability({ ...base, maxRowsPerEvent24h: 193 }).STORAGE_BUDGET_STATE, "FAIL");
  assert.equal(storageObservability({ ...base, spanHours24h: 3 }).ESTIMATE_LABEL, "EARLY_ESTIMATE");
  assert.equal(storageObservability({ ...base, relationBytes: null }).ESTIMATED_MB_DAY, null); // unavailable bytes are never faked
});

test("13 output is deterministic and independent of cell order", () => {
  const cells: Cell[] = [tennisMl(), { sport: "soccer", market: "TOTAL" }, { sport: "hockey", market: "MONEYLINE" }];
  const a = JSON.stringify(buildCoverage(agg(cells)));
  assert.equal(JSON.stringify(buildCoverage(agg([...cells].reverse()))), a);
});

test("14 mechanism readiness: >200 rows is SAMPLE_CAP_BLOCKED, never truncated; shock stays blocked", () => {
  const blocked = mechanismReadiness(RAW_ROW_CAP + 1, null, 3);
  assert.equal(blocked.CORE_MULTI_FAMILY_SAMPLE, "SAMPLE_CAP_BLOCKED");
  assert.equal(blocked.SHOCK_REVERSION, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  const empty = mechanismReadiness(0, [] as InplayObservation[], 0);
  assert.equal(empty.SHOCK_REVERSION, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  assert.equal((empty.CORE_MULTI_FAMILY_SAMPLE as any).status, "NO_SAMPLE");
});

test("15 read-only: SELECT-only statements, read_only transport, allowlisted clone ref, no write path", () => {
  for (const sql of [coverageAggregateSql(DAY), storageAggregateSql("2026-10-08T00:00:00Z"), boundedDayRowsSql(DAY, PROBE_COLUMNS, new Set(), new Set())]) {
    assert.match(sql, /^(WITH|SELECT)\b/);
    assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge)\b/i);
  }
  for (const f of [SCRIPT, MODULE]) assert.doesNotMatch(readFileSync(f, "utf8"), /\.(insert|update|upsert|delete|rpc)\(|select\(\s*["'`]\*["'`]/);
  assert.match(readFileSync(SCRIPT, "utf8"), /read_only: true/);
  assert.match(readFileSync("scripts/control-plane/lib/premvp-migration-https-transport.mjs", "utf8"), new RegExp(`PREMVP_RESEARCH_CLONE_PROJECT_REFS = Object\\.freeze\\(\\['${CLONE_PROJECT_REF}'\\]\\)`));
  assert.match(readFileSync("scripts/modeling/live-d1-research-corpus.ts", "utf8"), new RegExp(`EXPECTED_CLONE_REF = "${CLONE_PROJECT_REF}"`));
});
