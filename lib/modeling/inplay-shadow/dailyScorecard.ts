// DAILY_INPLAY_COVERAGE_SCORECARD_V1. Pure, deterministic, read-only. No I/O, no clock (callers pass `nowIso`).
// Answers one question: has the live in-play corpus expanded beyond tennis/MONEYLINE? Natural persisted rows are
// the only authority; classifier or test readiness can never move a state.
import { runInplayShadowProbes, type InplayObservation } from "./inplayShadowProbes";

export const SCORECARD_TASK = "DAILY_INPLAY_COVERAGE_SCORECARD_V1";
export const MINSK_UTC_OFFSET_HOURS = 3; // Europe/Minsk is fixed UTC+3 (no DST since 2011)
export const SPORTS = ["soccer", "tennis", "basketball", "hockey", "baseball", "american-football", "cricket"] as const;
export const MARKETS = ["MONEYLINE", "SPREAD", "TOTAL", "TOTAL_CORNERS"] as const;
const EXCLUDED_SPORTS = new Set(["esports"]);
export const RAW_ROW_CAP = 200;
export const KEY_SCAN_CAP = 50_000;
export const CLONE_FRESH_MAX_MINUTES = 90;
export const MIN_EVENTS_PER_COMPLETE_DAY = 5;
export const THREE_DAY_GATE_DAYS = 3;
export const EARLY_ESTIMATE_HOURS = 6;
/** Contractual collector caps. Mirrors lib/research/inplayCorePath.ts; a test pins the two together. Never edited here. */
export const HARD_CAPS = Object.freeze({
  mb_per_day: 20, rows_per_day: 20_000, events_per_day: 100, rows_per_event: 192, tokens_per_event: 16, retention_hours: 48,
});
export const STORAGE_WARN_FRACTION = 0.5;

/** Narrow aggregate projection: the only columns the coverage scan reads. */
export const KEY_COLUMNS = ["physical_event_id", "token_id", "provider_sport_family", "canonical_market_type", "observed_at"] as const;
export type KeyRow = { physical_event_id: string; token_id: string; provider_sport_family: string; canonical_market_type: string; observed_at: string };

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
export function rowsInMinskDay<T extends { observed_at: string }>(rows: readonly T[], date: string): T[] {
  const { startUtc, endUtc } = minskDayBounds(date);
  const s = Date.parse(startUtc), e = Date.parse(endUtc);
  return rows.filter((r) => { const t = Date.parse(r.observed_at); return t >= s && t < e; });
}

// ---------------------------------------------------------------- coverage
export type MatrixCell = { row_n: number; event_n: number; token_n: number };

function aggregate(rows: readonly KeyRow[]): MatrixCell {
  return { row_n: rows.length, event_n: new Set(rows.map((r) => r.physical_event_id)).size, token_n: new Set(rows.map((r) => r.token_id)).size };
}
function groupBy(rows: readonly KeyRow[], key: (r: KeyRow) => string): Map<string, KeyRow[]> {
  const m = new Map<string, KeyRow[]>();
  for (const r of rows) { const k = key(r); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
  return m;
}

export function buildCoverage(dayRows: readonly KeyRow[]) {
  const matrix: Record<string, MatrixCell> = {};
  for (const [k, v] of [...groupBy(dayRows, (r) => `${r.provider_sport_family}|${r.canonical_market_type}`).entries()].sort(([a], [b]) => cmp(a, b))) matrix[k] = aggregate(v);
  const eventN = (sport: string, market?: string) =>
    new Set(dayRows.filter((r) => r.provider_sport_family === sport && (market === undefined || r.canonical_market_type === market)).map((r) => r.physical_event_id)).size;
  const times = dayRows.map((r) => Date.parse(r.observed_at)).filter(Number.isFinite).sort((a, b) => a - b);
  const sportsWithRows = new Set(dayRows.map((r) => r.provider_sport_family).filter((s) => !EXCLUDED_SPORTS.has(s)));
  const marketsWithRows = new Set(dayRows.map((r) => r.canonical_market_type));
  const cornersN = eventN("soccer", "TOTAL_CORNERS");
  const coreTypes = new Set(["MONEYLINE", "SPREAD", "TOTAL"]);
  const byEvent = groupBy(dayRows, (r) => r.physical_event_id);
  const multiCandidates = [...byEvent.values()].filter((l) => new Set(l.filter((r) => coreTypes.has(r.canonical_market_type) || (r.canonical_market_type === "TOTAL_CORNERS" && r.provider_sport_family === "soccer")).map((r) => r.canonical_market_type)).size >= 2).length;
  return {
    ...aggregate(dayRows),
    observed_from_minsk: times.length ? toMinsk(new Date(times[0]).toISOString()) : null,
    observed_to_minsk: times.length ? toMinsk(new Date(times[times.length - 1]).toISOString()) : null,
    sport_market_matrix: matrix,
    SOCCER_EVENT_N: eventN("soccer"), SOCCER_MONEYLINE_EVENT_N: eventN("soccer", "MONEYLINE"), SOCCER_SPREAD_EVENT_N: eventN("soccer", "SPREAD"),
    SOCCER_TOTAL_EVENT_N: eventN("soccer", "TOTAL"), SOCCER_TOTAL_CORNERS_EVENT_N: cornersN,
    BASKETBALL_EVENT_N: eventN("basketball"), BASKETBALL_MONEYLINE_EVENT_N: eventN("basketball", "MONEYLINE"),
    BASKETBALL_SPREAD_EVENT_N: eventN("basketball", "SPREAD"), BASKETBALL_TOTAL_EVENT_N: eventN("basketball", "TOTAL"),
    HOCKEY_EVENT_N: eventN("hockey"), HOCKEY_MONEYLINE_EVENT_N: eventN("hockey", "MONEYLINE"),
    HOCKEY_SPREAD_EVENT_N: eventN("hockey", "SPREAD"), HOCKEY_TOTAL_EVENT_N: eventN("hockey", "TOTAL"),
    BASEBALL_EVENT_N: eventN("baseball"), AMERICAN_FOOTBALL_EVENT_N: eventN("american-football"), CRICKET_EVENT_N: eventN("cricket"), TENNIS_EVENT_N: eventN("tennis"),
    MULTISPORT_STATE: sportsWithRows.size >= 2 ? "READY" : "SINGLE_SPORT_ONLY",
    MULTIMARKET_STATE: marketsWithRows.size >= 2 ? "READY" : marketsWithRows.size === 1 && marketsWithRows.has("MONEYLINE") ? "MONEYLINE_ONLY" : "OTHER_INCOMPLETE",
    SOCCER_CORNERS_STATE: cornersN >= 1 ? "PROVEN" : "NO_SAMPLE",
    CORE_MULTI_FAMILY_EVENT_CANDIDATE_N: multiCandidates,
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
/** Only fully elapsed Minsk days count. The day containing `nowIso` is partial and never counted. */
export function threeDayReadiness(allRows: readonly KeyRow[], nowIso: string) {
  const today = minskDayOf(nowIso);
  const byDay = new Map<string, Set<string>>();
  for (const r of allRows) {
    if (!Number.isFinite(Date.parse(r.observed_at))) continue;
    const d = minskDayOf(r.observed_at);
    (byDay.get(d) ?? byDay.set(d, new Set()).get(d)!).add(r.physical_event_id);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => cmp(a, b));
  const complete = days.filter(([d]) => d < today);
  const qualifying = complete.filter(([, ev]) => ev.size >= MIN_EVENTS_PER_COMPLETE_DAY);
  return {
    TODAY_MINSK_PARTIAL: today,
    DAYS: Object.fromEntries(days.map(([d, ev]) => [d, { event_n: ev.size, status: d < today ? "COMPLETE" : "PARTIAL_NOT_COUNTED" }])),
    COMPLETE_DAYS_WITH_DATA: complete.length,
    COMPLETE_DAYS_WITH_MIN_5_EVENTS: qualifying.length,
    THREE_DAY_GATE_READY: qualifying.length >= THREE_DAY_GATE_DAYS ? "YES" : "NO",
    RETENTION_NOTE: `clone purges in-play telemetry beyond ${HARD_CAPS.retention_hours}h; the gate can only reach YES if completed days are retained elsewhere`,
  };
}
