// DAILY_INPLAY_COVERAGE_SCORECARD_V1: read-only. Prints deterministic JSON to stdout.
// Run: npx tsx scripts/modeling/inplay-daily-scorecard.ts [--date YYYY-MM-DD] [--prod-relation-bytes N]
// AGGREGATE_FIRST: DBClone (the long-term research authority) answers coverage, freshness and 3-day readiness through ONE
// server-side read-only aggregate statement; Production storage is ONE read-only aggregate statement. Transport is the
// Supabase Management API SQL endpoint with read_only=true (same pattern as scripts/diagnostics/t10EconomicActionPolicyReplay.ts;
// needs SUPABASE_ACCESS_TOKEN). The only raw observation read is the selected day's rows, hard-capped at RAW_ROW_CAP (200).
import { pathToFileURL } from "node:url";
import { PROBE_COLUMNS, type InplayObservation } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";
import {
  AGGREGATE_AUTHORITY, RAW_ROW_CAP, SCORECARD_TASK, boundedDayRowsSql, buildCoverage, cloneFreshness, coverageAggregateSql, mechanismReadiness,
  minskDayBounds, minskDayOf, parseCloneAggregate, storageAggregateSql, storageObservability, threeDayReadiness,
} from "../../lib/modeling/inplay-shadow/dailyScorecard";

/** Allowlisted research clone (pinned to lib `PREMVP_RESEARCH_CLONE_PROJECT_REFS` and live-d1 `EXPECTED_CLONE_REF` by a test). */
export const CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set([
  "side_a_score", "side_b_score", "mid_price", "spread_abs", "bid_depth_relevant_usd", "ask_depth_relevant_usd", "full_stake_executable_vwap", "full_stake_exit_vwap",
]);
const TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set(["observed_at"]);

let rawObservationRowsRead = 0;

function refFromUrl(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((url ?? "").trim());
  return m ? m[1] : null;
}

async function readOnlySql(ref: string, query: string): Promise<Array<Record<string, unknown>>> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    console.error("REQUIRED_AGGREGATE_READ_AUTHORIZATION_UNAVAILABLE");
    process.exit(3);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: true }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`SCORECARD_READ_ONLY_SQL_FAILED:${res.status}:${(await res.text()).slice(0, 160).replace(/\s+/g, " ")}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number));

async function productionStorage(nowMs: number, relationBytesOverride: number | null) {
  const ref = refFromUrl(process.env.SUPABASE_URL);
  if (!ref) return { available: false as const };
  if (ref === CLONE_PROJECT_REF) return { available: false as const, error: "PRODUCTION_URL_EQUALS_CLONE" };
  try {
    const since = new Date(nowMs - 86_400_000).toISOString();
    const row = (await readOnlySql(ref, storageAggregateSql(since)))[0];
    if (!row) throw new Error("PROD_AGGREGATE_EMPTY");
    const rowN = num(row.row_n), rows24h = num(row.rows_24h);
    return {
      available: true as const, rowN, maxAt: typeof row.max_observed_at === "string" ? row.max_observed_at : null,
      storage: storageObservability({
        relationBytes: relationBytesOverride ?? (Number.isFinite(num(row.relation_bytes)) ? num(row.relation_bytes) : null),
        productionRowN: rowN, rowsLast24h: rows24h, eventsLast24h: num(row.events_24h),
        maxRowsPerEvent24h: num(row.max_rows_per_event), maxTokensPerEvent24h: num(row.max_tokens_per_event), spanHours24h: num(row.span_hours),
      }),
    };
  } catch (e) {
    return { available: false as const, error: e instanceof Error ? e.message : "PROD_READ_FAILED" };
  }
}

async function main(): Promise<void> {
  const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
  const date = argValue("--date") ?? minskDayOf(nowIso);
  const { startUtc, endUtc } = minskDayBounds(date);
  const relArg = argValue("--prod-relation-bytes") ?? process.env.INPLAY_PROD_RELATION_BYTES;
  const relationBytes = relArg !== undefined && /^\d+$/.test(relArg) ? Number(relArg) : null;

  const agg = parseCloneAggregate((await readOnlySql(CLONE_PROJECT_REF, coverageAggregateSql(date)))[0]);
  const coverage = buildCoverage(agg.coverage);

  // Raw observations: only the selected day, only when the aggregate proves it fits the cap; never truncated.
  let fullRows: InplayObservation[] | null = null;
  if (coverage.row_n === 0) fullRows = [];
  else if (coverage.row_n <= RAW_ROW_CAP) {
    const rows = await readOnlySql(CLONE_PROJECT_REF, boundedDayRowsSql(date, PROBE_COLUMNS, NUMERIC_COLUMNS, TIMESTAMP_COLUMNS));
    rawObservationRowsRead += rows.length;
    fullRows = rows.length === coverage.row_n ? (rows as unknown as InplayObservation[]) : null; // day grew/shrank between statements => blocked, not truncated
  }

  const prod = await productionStorage(nowMs, relationBytes);
  const out = {
    task: SCORECARD_TASK,
    SCORECARD_DATE_MINSK: date,
    DAY_WINDOW_UTC: { start: startUtc, end: endUtc },
    GENERATED_AT_UTC: nowIso,
    AGGREGATE_AUTHORITY,
    COVERAGE_SOURCE: "SERVER_SIDE_AGGREGATE",
    RAW_OBSERVATIONS_READ: rawObservationRowsRead,
    RAW_OBSERVATION_MAX: RAW_ROW_CAP,
    PROD_ROW_N: prod.available ? prod.rowN : null,
    CLONE_ROW_N: agg.cloneRowN,
    PROD_MAX_OBSERVED_AT: prod.available ? prod.maxAt : null,
    CLONE_MAX_OBSERVED_AT: agg.cloneMaxObservedAt,
    ...cloneFreshness(prod.available ? prod.maxAt : null, agg.cloneMaxObservedAt),
    PROD_READ: prod.available ? "OK" : ("error" in prod ? `UNAVAILABLE:${prod.error}` : "UNAVAILABLE:PRODUCTION_DB_CONFIG_MISSING"),
    DAY_ROW_N: coverage.row_n, DAY_EVENT_N: coverage.event_n, DAY_TOKEN_N: coverage.token_n,
    COVERAGE: coverage,
    STORAGE: prod.available ? prod.storage : "UNAVAILABLE",
    MECHANISM_READINESS: mechanismReadiness(coverage.row_n, fullRows, coverage.CORE_MULTI_FAMILY_EVENT_CANDIDATE_N),
    THREE_DAY: threeDayReadiness(agg.daily, nowIso),
    claims: "COVERAGE_AND_READINESS_ONLY_NO_ALPHA_NO_THRESHOLD_FITTING",
  };
  if (rawObservationRowsRead > RAW_ROW_CAP) throw new Error("SCORECARD_RAW_ROW_BUDGET_EXCEEDED");
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : "INPLAY_SCORECARD_FAILED"); process.exit(1); });
}
