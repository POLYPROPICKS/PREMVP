import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HARD_CAPS, RAW_ROW_CAP, buildCoverage, cloneFreshness, mechanismReadiness, minskDayBounds, minskDayOf, rowsInMinskDay,
  storageObservability, threeDayReadiness, type KeyRow,
} from "../../lib/modeling/inplay-shadow/dailyScorecard";
import {
  MAX_DAILY_PHYSICAL_EVENTS, MAX_INPLAY_LOGICAL_MB_PER_DAY, MAX_PERSISTED_OBSERVATIONS_PER_EVENT, MAX_TOTAL_ROWS_PER_DAY, MAX_TRACKED_TOKENS_PER_EVENT,
  PRODUCTION_RETENTION_HOURS,
} from "../../lib/research/inplayCorePath";
import type { InplayObservation } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";

const DAY = "2026-10-08"; // Minsk day = 2026-10-07T21:00Z .. 2026-10-08T21:00Z
let n = 0;
function k(o: Partial<KeyRow> & { at?: string }): KeyRow {
  n++;
  const { at, ...rest } = o;
  return { physical_event_id: "E1", token_id: `T${n}`, provider_sport_family: "tennis", canonical_market_type: "MONEYLINE", observed_at: at ?? "2026-10-08T10:00:00Z", ...rest };
}

test("1 Minsk day boundaries are exact (UTC+3, [start,end))", () => {
  assert.deepEqual(minskDayBounds(DAY), { startUtc: "2026-10-07T21:00:00.000Z", endUtc: "2026-10-08T21:00:00.000Z" });
  const rows = [k({ at: "2026-10-07T20:59:59.999Z" }), k({ at: "2026-10-07T21:00:00.000Z" }), k({ at: "2026-10-08T20:59:59.999Z" }), k({ at: "2026-10-08T21:00:00.000Z" })];
  assert.deepEqual(rowsInMinskDay(rows, DAY).map((r) => r.observed_at), ["2026-10-07T21:00:00.000Z", "2026-10-08T20:59:59.999Z"]);
  assert.equal(minskDayOf("2026-10-08T20:59:59Z"), "2026-10-08");
  assert.equal(minskDayOf("2026-10-08T21:00:00Z"), "2026-10-09");
  assert.throws(() => minskDayBounds("2026-13-40"));
  assert.throws(() => minskDayBounds("2026-10-8"));
});

test("2 single tennis/MONEYLINE corpus => SINGLE_SPORT_ONLY + MONEYLINE_ONLY, zeroes present", () => {
  const c = buildCoverage([k({}), k({ physical_event_id: "E2" })]);
  assert.equal(c.MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
  assert.equal(c.MULTIMARKET_STATE, "MONEYLINE_ONLY");
  assert.equal(c.SOCCER_CORNERS_STATE, "NO_SAMPLE");
  assert.equal(c.TENNIS_EVENT_N, 2);
  for (const f of ["SOCCER_EVENT_N", "SOCCER_MONEYLINE_EVENT_N", "SOCCER_SPREAD_EVENT_N", "SOCCER_TOTAL_EVENT_N", "SOCCER_TOTAL_CORNERS_EVENT_N", "BASKETBALL_EVENT_N",
    "BASKETBALL_MONEYLINE_EVENT_N", "BASKETBALL_SPREAD_EVENT_N", "BASKETBALL_TOTAL_EVENT_N", "HOCKEY_EVENT_N", "HOCKEY_MONEYLINE_EVENT_N", "HOCKEY_SPREAD_EVENT_N",
    "HOCKEY_TOTAL_EVENT_N", "BASEBALL_EVENT_N", "AMERICAN_FOOTBALL_EVENT_N"] as const) assert.equal(c[f], 0, f);
  assert.deepEqual(c.sport_market_matrix, { "tennis|MONEYLINE": { row_n: 2, event_n: 2, token_n: 2 } });
  assert.equal(buildCoverage([]).MULTIMARKET_STATE, "OTHER_INCOMPLETE");
  assert.equal(buildCoverage([k({ canonical_market_type: "TOTAL" })]).MULTIMARKET_STATE, "OTHER_INCOMPLETE");
});

test("3 soccer MONEYLINE + TOTAL => MULTIMARKET READY", () => {
  const c = buildCoverage([k({ provider_sport_family: "soccer" }), k({ provider_sport_family: "soccer", canonical_market_type: "TOTAL" })]);
  assert.equal(c.MULTIMARKET_STATE, "READY");
  assert.equal(c.SOCCER_TOTAL_EVENT_N, 1);
  assert.equal(c.CORE_MULTI_FAMILY_EVENT_CANDIDATE_N, 1);
  assert.equal(c.MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
});

test("4 natural soccer TOTAL_CORNERS row => PROVEN; tennis corners does not", () => {
  const c = buildCoverage([k({ provider_sport_family: "soccer", canonical_market_type: "TOTAL_CORNERS" })]);
  assert.equal(c.SOCCER_CORNERS_STATE, "PROVEN");
  assert.equal(c.SOCCER_TOTAL_CORNERS_EVENT_N, 1);
  assert.equal(buildCoverage([k({ canonical_market_type: "TOTAL_CORNERS" })]).SOCCER_CORNERS_STATE, "NO_SAMPLE");
});

test("5 classifier/test readiness cannot make corners PROVEN", () => {
  const src = readFileSync("lib/modeling/inplay-shadow/dailyScorecard.ts", "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./inplayShadowProbes"]); // no classifier/registry/fixture import can feed a state
  assert.equal(buildCoverage([]).SOCCER_CORNERS_STATE, "NO_SAMPLE");
  assert.equal(buildCoverage([k({ provider_sport_family: "soccer" })]).SOCCER_CORNERS_STATE, "NO_SAMPLE");
});

test("6 two distinct non-esports families => MULTISPORT READY; esports excluded", () => {
  assert.equal(buildCoverage([k({}), k({ provider_sport_family: "basketball" })]).MULTISPORT_STATE, "READY");
  assert.equal(buildCoverage([k({}), k({ provider_sport_family: "esports" })]).MULTISPORT_STATE, "SINGLE_SPORT_ONLY");
});

test("7 clone lag > 90m => STALE; <= 90 FRESH; no production read => UNKNOWN", () => {
  assert.deepEqual(cloneFreshness("2026-10-08T12:00:00Z", "2026-10-08T10:29:00Z"), { CLONE_LAG_MINUTES: 91, CLONE_FRESHNESS: "STALE" });
  assert.equal(cloneFreshness("2026-10-08T12:00:00Z", "2026-10-08T10:30:00Z").CLONE_FRESHNESS, "FRESH");
  assert.equal(cloneFreshness(null, "2026-10-08T10:30:00Z").CLONE_FRESHNESS, "UNKNOWN");
  assert.equal(cloneFreshness("2026-10-08T12:00:00Z", null).CLONE_FRESHNESS, "STALE");
});

test("8 partial current day cannot count toward the 3-day gate", () => {
  const events = (day: string, count: number) => Array.from({ length: count }, (_, i) => k({ physical_event_id: `${day}-${i}`, at: `${day}T10:00:00Z` }));
  const rows = [...events("2026-10-05", 5), ...events("2026-10-06", 5), ...events("2026-10-07", 4), ...events("2026-10-08", 50)];
  const t = threeDayReadiness(rows, "2026-10-08T12:00:00Z");
  assert.equal(t.COMPLETE_DAYS_WITH_DATA, 3);
  assert.equal(t.COMPLETE_DAYS_WITH_MIN_5_EVENTS, 2);
  assert.equal(t.THREE_DAY_GATE_READY, "NO");
  assert.equal(t.DAYS["2026-10-08"].status, "PARTIAL_NOT_COUNTED");
  const ok = threeDayReadiness([...rows, k({ physical_event_id: "extra", at: "2026-10-07T11:00:00Z" })], "2026-10-08T12:00:00Z");
  assert.equal(ok.THREE_DAY_GATE_READY, "YES");
  assert.equal(threeDayReadiness(rows, "2026-10-07T20:59:00Z").COMPLETE_DAYS_WITH_DATA, 2); // 23:59 Minsk on 10-07: only 10-05 and 10-06 are complete
});

test("9 storage hard caps unchanged and pinned to the collector", () => {
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
  const early = storageObservability({ ...base, spanHours24h: 3 });
  assert.equal(early.ESTIMATE_LABEL, "EARLY_ESTIMATE");
  assert.equal(storageObservability({ ...base, relationBytes: null }).ESTIMATED_MB_DAY, null);
});

test("10 output is deterministic and independent of input order", () => {
  const rows = [k({}), k({ provider_sport_family: "soccer", canonical_market_type: "TOTAL" }), k({ physical_event_id: "E2", provider_sport_family: "hockey" })];
  const a = JSON.stringify(buildCoverage(rows));
  assert.equal(JSON.stringify(buildCoverage([...rows].reverse())), a);
  assert.equal(JSON.stringify(buildCoverage(rows)), a);
});

test("11 mechanism readiness: >200 rows is SAMPLE_CAP_BLOCKED, never truncated; shock stays blocked", () => {
  const blocked = mechanismReadiness(RAW_ROW_CAP + 1, null, 3);
  assert.equal(blocked.TAIL_SAMPLE, "SAMPLE_CAP_BLOCKED");
  assert.equal(blocked.CORE_MULTI_FAMILY_SAMPLE, "SAMPLE_CAP_BLOCKED");
  assert.equal(blocked.SHOCK_REVERSION, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  const empty = mechanismReadiness(0, [] as InplayObservation[], 0);
  assert.equal(empty.SHOCK_REVERSION, "BLOCKED_NO_NUMERIC_STATE_AUTHORITY");
  assert.equal((empty.CORE_MULTI_FAMILY_SAMPLE as any).status, "NO_SAMPLE");
});

test("12 script and module hold no write path and no SELECT *", () => {
  for (const f of ["scripts/modeling/inplay-daily-scorecard.ts", "lib/modeling/inplay-shadow/dailyScorecard.ts"]) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, /\.(insert|update|upsert|delete|rpc)\(|select\(\s*["'`]\*["'`]/);
  }
});
