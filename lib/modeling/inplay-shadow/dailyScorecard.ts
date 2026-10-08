// DAILY_INPLAY_COVERAGE_SCORECARD_V1. Pure, deterministic, read-only. No I/O, no clock (callers pass `nowIso`).
// Answers one question: has the live in-play corpus expanded beyond tennis/MONEYLINE? Natural persisted rows are
// the only authority; classifier or test readiness can never move a state.
// AGGREGATE_FIRST: coverage, freshness and 3-day readiness come from ONE server-side read-only aggregate statement
// (COUNT / COUNT DISTINCT / MIN / MAX / GROUP BY); no history of raw rows is ever pulled into the process.
import { runInplayShadowProbes, type InplayObservation } from "./inplayShadowProbes";

export const SCORECARD_TASK = "DAILY_INPLAY_COVERAGE_SCORECARD_V1";
export const MINSK_UTC_OFFSET_HOURS = 3; // Europe/Minsk is fixed UTC+3 (no DST since 2011)
export const SPORTS = ["soccer", "tennis", "basketball", "hockey", "baseball", "american-football", "cricket"] as const;
export const MARKETS = ["MONEYLINE", "SPREAD", "TOTAL", "TOTAL_CORNERS"] as const;
const EXCLUDED_SPORTS = new Set(["esports"]);
export const RAW_ROW_CAP = 200;
export const CLONE_FRESH_MAX_MINUTES = 90;
export const MIN_EVENTS_PER_COMPLETE_DAY = 5;
export const THREE_DAY_GATE_DAYS = 3;
export const EARLY_ESTIMATE_HOURS = 6;
/** Contractual collector caps. Mirrors lib/research/inplayCorePath.ts; a test pins the two together. Never edited here. */
export const HARD_CAPS = Object.freeze({
  mb_per_day: 20, rows_per_day: 20_000, events_per_day: 100, rows_per_event: 192, tokens_per_event: 16, retention_hours: 48,
});
export const STORAGE_WARN_FRACTION = 0.5;
/** The retention window governs PRODUCTION (source) only. DBClone is the long-term research authority. */
export const RETENTION_SEMANTICS =
  `${HARD_CAPS.retention_hours}h retention deletes already-confirmed rows from PRODUCTION (source) after they are verified on DBClone; ` +
  "DBClone keeps the full history, so completed Minsk days older than that window still count toward the gate";
export const AGGREGATE_AUTHORITY = "DBCLONE_READ_ONLY_SERVER_SIDE_AGGREGATE_V1";
const TABLE = "public.research_inplay_core_path_observations";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedObj = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- Minsk calendar
export function assertMinskDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error(`SCORECARD_BAD_DATE:${date}`);
}
/** [startUtc, endUtc) of the Europe/Minsk calendar day. */
export function minskDayBounds(date: string): { startUtc: string; endUtc: string } {
  assertMinskDate(date);
  const start = Date.parse(`${date}T00:00:00Z`) - MINSK_UTC_OFFSET_HOURS * 3_600_000;
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(start + 86_400_000).toISOString() };
}
export function minskDayOf(iso: string): string {
  return new Date(Date.parse(iso) + MINSK_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}
export function toMinsk(iso: string | null): string | null {
  return iso && Number.isFinite(Date.parse(iso)) ? `${new Date(Date.parse(iso) + MINSK_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 19).replace("T", " ")} Minsk` : null;
}

// ---------------------------------------------------------------- aggregate statements (read-only SELECT only)
const iso = (expr: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const MINSK_DAY_SQL = `to_char(((observed_at AT TIME ZONE 'UTC') + INTERVAL '${MINSK_UTC_OFFSET_HOURS} hours'), 'YYYY-MM-DD')`;

/** ONE compact aggregate row: selected-day matrix, multi-family candidates and the per-Minsk-day history. No raw observations. */
export function coverageAggregateSql(date: string): string {
  const { startUtc, endUtc } = minskDayBounds(date);
  return `WITH d AS (
  SELECT physical_event_id, token_id, provider_sport_family AS sport, canonical_market_type AS market, observed_at
  FROM ${TABLE}
  WHERE observed_at >= TIMESTAMPTZ '${startUtc}' AND observed_at < TIMESTAMPTZ '${endUtc}'
), g AS (
  SELECT sport, market, GROUPING(sport) AS gs, GROUPING(market) AS gm,
    count(*)::int AS row_n, count(DISTINCT physical_event_id)::int AS event_n, count(DISTINCT token_id)::int AS token_n,
    ${iso("min(observed_at)")} AS min_at, ${iso("max(observed_at)")} AS max_at
  FROM d GROUP BY GROUPING SETS ((), (sport), (sport, market))
), m AS (
  SELECT count(*)::int AS n FROM (
    SELECT 1 FROM d WHERE market IN ('MONEYLINE', 'SPREAD', 'TOTAL') OR (market = 'TOTAL_CORNERS' AND sport = 'soccer')
    GROUP BY physical_event_id HAVING count(DISTINCT market) >= 2
  ) x
), h AS (
  SELECT ${MINSK_DAY_SQL} AS minsk_date, count(*)::int AS row_n, count(DISTINCT physical_event_id)::int AS event_n, ${iso("max(observed_at)")} AS max_at
  FROM ${TABLE} GROUP BY 1
)
SELECT
  (SELECT coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) FROM g) AS cells,
  (SELECT n FROM m) AS multi_n,
  (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.minsk_date), '[]'::jsonb) FROM h) AS daily,
  (SELECT coalesce(sum(row_n), 0)::int FROM h) AS clone_row_n,
  (SELECT max(max_at) FROM h) AS clone_max_observed_at`;
}

/** Production storage aggregate over the trailing 24h (rows/events/per-event maxima/span) plus the real relation size. */
export function storageAggregateSql(sinceIso: string): string {
  if (!Number.isFinite(Date.parse(sinceIso))) throw new Error(`SCORECARD_BAD_TIMESTAMP:${sinceIso}`);
  const since = new Date(sinceIso).toISOString();
  return `WITH w AS (
  SELECT physical_event_id, token_id, observed_at FROM ${TABLE} WHERE observed_at >= TIMESTAMPTZ '${since}'
), pe AS (
  SELECT count(*)::int AS rows_n, count(DISTINCT token_id)::int AS tokens_n FROM w GROUP BY physical_event_id
)
SELECT
  (SELECT count(*)::int FROM ${TABLE}) AS row_n,
  (SELECT ${iso("max(observed_at)")} FROM ${TABLE}) AS max_observed_at,
  (SELECT count(*)::int FROM w) AS rows_24h,
  (SELECT count(*)::int FROM pe) AS events_24h,
  (SELECT coalesce(max(rows_n), 0)::int FROM pe) AS max_rows_per_event,
  (SELECT coalesce(max(tokens_n), 0)::int FROM pe) AS max_tokens_per_event,
  (SELECT coalesce(extract(epoch FROM (max(observed_at) - min(observed_at))) / 3600, 0)::float8 FROM w) AS span_hours,
  pg_total_relation_size('${TABLE}'::regclass)::float8 AS relation_bytes`;
}

/** Bounded raw read (hard LIMIT RAW_ROW_CAP) used only for mechanism evaluation of one selected day. Explicit columns, no SELECT *. */
export function boundedDayRowsSql(date: string, columns: readonly string[], numericColumns: ReadonlySet<string>, timestampColumns: ReadonlySet<string>): string {
  const { startUtc, endUtc } = minskDayBounds(date);
  if (!columns.every((c) => /^[a-z_]+$/.test(c))) throw new Error("SCORECARD_BAD_COLUMN");
  const list = columns.map((c) => (numericColumns.has(c) ? `${c}::float8 AS ${c}` : timestampColumns.has(c) ? `${iso(c)} AS ${c}` : c)).join(", ");
  return `SELECT ${list} FROM ${TABLE} WHERE observed_at >= TIMESTAMPTZ '${startUtc}' AND observed_at < TIMESTAMPTZ '${endUtc}' ORDER BY observed_at ASC, id ASC LIMIT ${RAW_ROW_CAP}`;
}

// ---------------------------------------------------------------- coverage
export type MatrixCell = { row_n: number; event_n: number; token_n: number };
export type CoverageAggregate = {
  day: MatrixCell & { min_observed_at: string | null; max_observed_at: string | null };
  sport_event_n: Record<string, number>;
  cells: Array<{ sport: string; market: string } & MatrixCell>;
  core_multi_family_event_candidate_n: number;
};
export type DailyRow = { minsk_date: string; event_n: number; row_n: number };
export type CloneAggregate = { coverage: CoverageAggregate; daily: DailyRow[]; cloneRowN: number; cloneMaxObservedAt: string | null };

const count = (v: unknown, what: string): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error(`SCORECARD_AGGREGATE_SHAPE:${what}`);
  return n;
};
const asJsonArray = (v: unknown, what: string): unknown[] => {
  const parsed = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(parsed)) throw new Error(`SCORECARD_AGGREGATE_SHAPE:${what}`);
  return parsed;
};

/** Validates and normalises the single row returned by `coverageAggregateSql`. Fails closed on any shape drift. */
export function parseCloneAggregate(row: unknown): CloneAggregate {
  if (!row || typeof row !== "object") throw new Error("SCORECARD_AGGREGATE_SHAPE:row");
  const r = row as Record<string, unknown>;
  const day: CoverageAggregate["day"] = { row_n: 0, event_n: 0, token_n: 0, min_observed_at: null, max_observed_at: null };
  const sport_event_n: Record<string, number> = {};
  const cells: CoverageAggregate["cells"] = [];
  for (const c of asJsonArray(r.cells, "cells") as Array<Record<string, unknown>>) {
    const m = { row_n: count(c.row_n, "row_n"), event_n: count(c.event_n, "event_n"), token_n: count(c.token_n, "token_n") };
    if (c.gs === 1 && c.gm === 1) Object.assign(day, m, { min_observed_at: (c.min_at as string) ?? null, max_observed_at: (c.max_at as string) ?? null });
    else if (c.gs === 0 && c.gm === 1) sport_event_n[String(c.sport)] = m.event_n;
    else if (c.gs === 0 && c.gm === 0) cells.push({ sport: String(c.sport), market: String(c.market), ...m });
    else throw new Error("SCORECARD_AGGREGATE_SHAPE:grouping");
  }
  const daily = (asJsonArray(r.daily, "daily") as Array<Record<string, unknown>>).map((d) => {
    const minsk_date = String(d.minsk_date);
    assertMinskDate(minsk_date);
    return { minsk_date, event_n: count(d.event_n, "daily.event_n"), row_n: count(d.row_n, "daily.row_n") };
  });
  return {
    coverage: { day, sport_event_n, cells, core_multi_family_event_candidate_n: count(r.multi_n, "multi_n") },
    daily, cloneRowN: count(r.clone_row_n, "clone_row_n"), cloneMaxObservedAt: typeof r.clone_max_observed_at === "string" ? r.clone_max_observed_at : null,
  };
}

export function buildCoverage(a: CoverageAggregate) {
  const matrix: Record<string, MatrixCell> = {};
  for (const c of [...a.cells].sort((x, y) => cmp(`${x.sport}|${x.market}`, `${y.sport}|${y.market}`))) matrix[`${c.sport}|${c.market}`] = { row_n: c.row_n, event_n: c.event_n, token_n: c.token_n };
  const sportN = (sport: string) => a.sport_event_n[sport] ?? 0;
  const cellN = (sport: string, market: string) => a.cells.find((c) => c.sport === sport && c.market === market)?.event_n ?? 0;
  const sportsWithRows = new Set(Object.keys(a.sport_event_n).filter((s) => !EXCLUDED_SPORTS.has(s)));
  const marketsWithRows = new Set(a.cells.map((c) => c.market));
  const cornersN = cellN("soccer", "TOTAL_CORNERS");
  return {
    row_n: a.day.row_n, event_n: a.day.event_n, token_n: a.day.token_n,
    observed_from_minsk: toMinsk(a.day.min_observed_at),
    observed_to_minsk: toMinsk(a.day.max_observed_at),
    sport_market_matrix: matrix,
    SOCCER_EVENT_N: sportN("soccer"), SOCCER_MONEYLINE_EVENT_N: cellN("soccer", "MONEYLINE"), SOCCER_SPREAD_EVENT_N: cellN("soccer", "SPREAD"),
    SOCCER_TOTAL_EVENT_N: cellN("soccer", "TOTAL"), SOCCER_TOTAL_CORNERS_EVENT_N: cornersN,
    BASKETBALL_EVENT_N: sportN("basketball"), BASKETBALL_MONEYLINE_EVENT_N: cellN("basketball", "MONEYLINE"),
    BASKETBALL_SPREAD_EVENT_N: cellN("basketball", "SPREAD"), BASKETBALL_TOTAL_EVENT_N: cellN("basketball", "TOTAL"),
    HOCKEY_EVENT_N: sportN("hockey"), HOCKEY_MONEYLINE_EVENT_N: cellN("hockey", "MONEYLINE"),
    HOCKEY_SPREAD_EVENT_N: cellN("hockey", "SPREAD"), HOCKEY_TOTAL_EVENT_N: cellN("hockey", "TOTAL"),
    BASEBALL_EVENT_N: sportN("baseball"), AMERICAN_FOOTBALL_EVENT_N: sportN("american-football"), CRICKET_EVENT_N: sportN("cricket"), TENNIS_EVENT_N: sportN("tennis"),
    MULTISPORT_STATE: sportsWithRows.size >= 2 ? "READY" : "SINGLE_SPORT_ONLY",
    MULTIMARKET_STATE: marketsWithRows.size >= 2 ? "READY" : marketsWithRows.size === 1 && marketsWithRows.has("MONEYLINE") ? "MONEYLINE_ONLY" : "OTHER_INCOMPLETE",
    SOCCER_CORNERS_STATE: cornersN >= 1 ? "PROVEN" : "NO_SAMPLE",
    CORE_MULTI_FAMILY_EVENT_CANDIDATE_N: a.core_multi_family_event_candidate_n,
  };
}

// ---------------------------------------------------------------- clone freshness
export function cloneFreshness(prodMaxObservedAt: string | null, cloneMaxObservedAt: string | null) {
  const p = prodMaxObservedAt ? Date.parse(prodMaxObservedAt) : NaN, c = cloneMaxObservedAt ? Date.parse(cloneMaxObservedAt) : NaN;
  if (!Number.isFinite(p)) return { CLONE_LAG_MINUTES: null, CLONE_FRESHNESS: "UNKNOWN" as const };
  if (!Number.isFinite(c)) return { CLONE_LAG_MINUTES: null, CLONE_FRESHNESS: "STALE" as const };
  const lag = Math.max(0, r2((p - c) / 60_000));
  return { CLONE_LAG_MINUTES: lag, CLONE_FRESHNESS: lag <= CLONE_FRESH_MAX_MINUTES ? ("FRESH" as const) : ("STALE" as const) };
}

// ---------------------------------------------------------------- storage
export type StorageInput = {
  relationBytes: number | null; productionRowN: number; rowsLast24h: number; eventsLast24h: number;
  maxRowsPerEvent24h: number; maxTokensPerEvent24h: number; spanHours24h: number;
};
export function storageObservability(i: StorageInput) {
  const bytesPerRow = i.relationBytes !== null && i.productionRowN > 0 ? r2(i.relationBytes / i.productionRowN) : null;
  const rowsPerDay = i.spanHours24h >= 24 ? i.rowsLast24h : i.spanHours24h > 0 ? i.rowsLast24h * (24 / i.spanHours24h) : null;
  const mbDay = bytesPerRow !== null && rowsPerDay !== null ? r2((bytesPerRow * rowsPerDay) / 1e6) : null;
  const label = i.spanHours24h < EARLY_ESTIMATE_HOURS ? "EARLY_ESTIMATE" : i.spanHours24h < 24 ? "EXTRAPOLATED_ESTIMATE" : "OBSERVED_24H";
  const ratios: Record<string, number | null> = {
    rows_per_day: rowsPerDay === null ? null : rowsPerDay / HARD_CAPS.rows_per_day,
    events_per_day: i.eventsLast24h / HARD_CAPS.events_per_day,
    rows_per_event: i.maxRowsPerEvent24h / HARD_CAPS.rows_per_event,
    tokens_per_event: i.maxTokensPerEvent24h / HARD_CAPS.tokens_per_event,
    mb_per_day: mbDay === null ? null : mbDay / HARD_CAPS.mb_per_day,
  };
  const known = Object.values(ratios).filter((v): v is number => v !== null);
  const worst = known.length ? Math.max(...known) : 0;
  return {
    PRODUCTION_RELATION_BYTES: i.relationBytes, PRODUCTION_ROW_N: i.productionRowN, APPROX_BYTES_PER_ROW: bytesPerRow,
    ROWS_LAST_24H: i.rowsLast24h, EVENTS_LAST_24H: i.eventsLast24h, MAX_ROWS_PER_EVENT_24H: i.maxRowsPerEvent24h, MAX_TOKENS_PER_EVENT_24H: i.maxTokensPerEvent24h,
    OBSERVED_SPAN_HOURS_24H: r2(i.spanHours24h), ESTIMATED_MB_DAY: mbDay, ESTIMATE_LABEL: label,
    MB_DAY_NOTE: bytesPerRow === null ? "RELATION_BYTES_UNAVAILABLE" : "relation bytes include indexes/TOAST; GB/month not extrapolated",
    CAP_UTILISATION: sortedObj(Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, v === null ? null : r2(v)]))),
    HARD_CAPS,
    STORAGE_BUDGET_STATE: worst > 1 ? "FAIL" : worst > STORAGE_WARN_FRACTION ? "WARN" : "PASS",
  };
}

// ---------------------------------------------------------------- mechanism readiness
/** `fullRows` must be the complete day (<= RAW_ROW_CAP); otherwise the verdicts are SAMPLE_CAP_BLOCKED, never truncated. */
export function mechanismReadiness(dayRowN: number, fullRows: readonly InplayObservation[] | null, coreMultiCandidateN: number) {
  if (dayRowN > RAW_ROW_CAP || fullRows === null) {
    return {
      SHOCK_REVERSION: "BLOCKED_NO_NUMERIC_STATE_AUTHORITY", TAIL_SAMPLE: "SAMPLE_CAP_BLOCKED", LATE_LOCK_SAMPLE: "SAMPLE_CAP_BLOCKED",
      CORE_MULTI_FAMILY_SAMPLE: "SAMPLE_CAP_BLOCKED", CORE_MULTI_FAMILY_EVENT_CANDIDATE_N: coreMultiCandidateN,
      SAMPLE_CAP: { day_row_n: dayRowN, raw_row_cap: RAW_ROW_CAP, note: "aggregate counts only; no mechanism verdict computed on a truncated sample" },
    };
  }
  const p = runInplayShadowProbes(fullRows).probes;
  return {
    SHOCK_REVERSION: p.SHOCK_REVERSION_V1.state,
    TAIL_SAMPLE: { status: p.TAIL_PATH_OPTIONALITY_V1.status, decision_n: p.TAIL_PATH_OPTIONALITY_V1.eligible_n, event_n: p.TAIL_PATH_OPTIONALITY_V1.event_n },
    LATE_LOCK_SAMPLE: { status: p.LATE_LOCK_V1.status, transition_n: p.LATE_LOCK_V1.eligible_n, event_n: p.LATE_LOCK_V1.event_n },
    CORE_MULTI_FAMILY_SAMPLE: { status: p.CORE_RELATIVE_VALUE_V1.status, synchronized_group_n: p.CORE_RELATIVE_VALUE_V1.eligible_n, multi_family_group_n: p.CORE_RELATIVE_VALUE_V1.metrics.MULTI_FAMILY_SAMPLE_N },
    CORE_MULTI_FAMILY_EVENT_CANDIDATE_N: coreMultiCandidateN,
    SAMPLE_CAP: null,
  };
}

// ---------------------------------------------------------------- three-day readiness
/** DBClone history (not the 48h Production window). Only fully elapsed Minsk days count; the day containing `nowIso` is partial and never counted. */
export function threeDayReadiness(daily: readonly DailyRow[], nowIso: string) {
  const today = minskDayOf(nowIso);
  const days = [...daily].sort((a, b) => cmp(a.minsk_date, b.minsk_date));
  const complete = days.filter((d) => d.minsk_date < today);
  const qualifying = complete.filter((d) => d.event_n >= MIN_EVENTS_PER_COMPLETE_DAY);
  return {
    TODAY_MINSK_PARTIAL: today,
    DAYS: Object.fromEntries(days.map((d) => [d.minsk_date, { event_n: d.event_n, row_n: d.row_n, status: d.minsk_date < today ? "COMPLETE" : "PARTIAL_NOT_COUNTED" }])) as Record<string, { event_n: number; row_n: number; status: string }>,
    COMPLETE_DAYS_WITH_DATA: complete.length,
    COMPLETE_DAYS_WITH_MIN_5_EVENTS: qualifying.length,
    THREE_DAY_GATE_READY: qualifying.length >= THREE_DAY_GATE_DAYS ? "YES" : "NO",
    RETENTION_NOTE: RETENTION_SEMANTICS,
  };
}
