// DAILY_INPLAY_COVERAGE_SCORECARD_V1: read-only. Prints deterministic JSON to stdout.
// Run: npx tsx scripts/modeling/inplay-daily-scorecard.ts [--date YYYY-MM-DD] [--prod-relation-bytes N]
// DBClone is the research authority (explicit narrow projections, no SELECT *). Production is read aggregate-only
// (head counts, max timestamp, a narrow 24h key scan); it is skipped (UNKNOWN) when its config is absent. No writes.
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { resolveCloneClient } from "./live-d1-research-corpus";
import { PROBE_COLUMNS, type InplayObservation } from "../../lib/modeling/inplay-shadow/inplayShadowProbes";
import {
  KEY_COLUMNS, KEY_SCAN_CAP, RAW_ROW_CAP, SCORECARD_TASK, buildCoverage, cloneFreshness, mechanismReadiness, minskDayBounds, minskDayOf,
  rowsInMinskDay, storageObservability, threeDayReadiness, type KeyRow,
} from "../../lib/modeling/inplay-shadow/dailyScorecard";

const TABLE = "research_inplay_core_path_observations";
const PAGE = 1000;
type ReadClient = { from: (t: string) => any };

async function headCount(db: ReadClient, gteIso?: string): Promise<number> {
  let q = db.from(TABLE).select("id", { count: "exact", head: true });
  if (gteIso) q = q.gte("observed_at", gteIso);
  const r = await q;
  if (r.error) throw new Error(`SCORECARD_COUNT:${r.error.message}`);
  return r.count ?? 0;
}
async function maxObservedAt(db: ReadClient): Promise<string | null> {
  const r = await db.from(TABLE).select("observed_at").order("observed_at", { ascending: false }).limit(1);
  if (r.error) throw new Error(`SCORECARD_MAX:${r.error.message}`);
  return r.data?.[0]?.observed_at ?? null;
}
/** Paged narrow key scan. Returns null rows when the table exceeds the scan cap (never a silent truncation). */
async function keyScan<T>(db: ReadClient, columns: readonly string[], total: number, gteIso?: string): Promise<{ rows: T[]; capBlocked: boolean }> {
  if (total > KEY_SCAN_CAP) return { rows: [], capBlocked: true };
  const rows: T[] = [];
  for (let from = 0; from < total; from += PAGE) {
    let q = db.from(TABLE).select(columns.join(","));
    if (gteIso) q = q.gte("observed_at", gteIso);
    const r = await q.order("observed_at", { ascending: true }).order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (r.error) throw new Error(`SCORECARD_SCAN:${r.error.message}`);
    rows.push(...((r.data ?? []) as T[]));
    if ((r.data ?? []).length < PAGE) break;
  }
  return { rows, capBlocked: false };
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function productionStorage(nowMs: number, relationBytes: number | null) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { available: false as const };
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const since = new Date(nowMs - 86_400_000).toISOString();
    const [rowN, maxAt, rows24h] = [await headCount(db), await maxObservedAt(db), await headCount(db, since)];
    const scan = await keyScan<{ physical_event_id: string; token_id: string; observed_at: string }>(db, ["physical_event_id", "token_id", "observed_at"], rows24h, since);
    const perEventRows = new Map<string, number>(), perEventTokens = new Map<string, Set<string>>();
    let minT = Infinity, maxT = -Infinity;
    for (const r of scan.rows) {
      perEventRows.set(r.physical_event_id, (perEventRows.get(r.physical_event_id) ?? 0) + 1);
      (perEventTokens.get(r.physical_event_id) ?? perEventTokens.set(r.physical_event_id, new Set()).get(r.physical_event_id)!).add(r.token_id);
      const t = Date.parse(r.observed_at); if (t < minT) minT = t; if (t > maxT) maxT = t;
    }
    return {
      available: true as const, rowN, maxAt,
      storage: storageObservability({
        relationBytes, productionRowN: rowN, rowsLast24h: rows24h,
        eventsLast24h: scan.capBlocked ? 0 : perEventRows.size,
        maxRowsPerEvent24h: Math.max(0, ...perEventRows.values()), maxTokensPerEvent24h: Math.max(0, ...[...perEventTokens.values()].map((s) => s.size)),
        spanHours24h: scan.rows.length ? (maxT - minT) / 3_600_000 : 0,
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

  const { client } = resolveCloneClient();
  const cloneRowN = await headCount(client);
  const cloneMax = await maxObservedAt(client);
  const scan = await keyScan<KeyRow>(client, KEY_COLUMNS, cloneRowN);
  const dayRows = rowsInMinskDay(scan.rows, date);
  const coverage = buildCoverage(dayRows);

  let fullRows: InplayObservation[] | null = null;
  if (!scan.capBlocked && dayRows.length > 0 && dayRows.length <= RAW_ROW_CAP) {
    const r = await client.from(TABLE).select(PROBE_COLUMNS.join(",")).gte("observed_at", startUtc).lt("observed_at", endUtc)
      .order("observed_at", { ascending: true }).order("id", { ascending: true }).limit(RAW_ROW_CAP + 1);
    if (r.error) throw new Error(`SCORECARD_FULL:${r.error.message}`);
    fullRows = (r.data ?? []) as unknown as InplayObservation[];
    if (fullRows.length > RAW_ROW_CAP) fullRows = null;
  } else if (dayRows.length === 0) fullRows = [];

  const prod = await productionStorage(nowMs, relationBytes);
  const out = {
    task: SCORECARD_TASK,
    SCORECARD_DATE_MINSK: date,
    DAY_WINDOW_UTC: { start: startUtc, end: endUtc },
    GENERATED_AT_UTC: nowIso,
    KEY_SCAN_STATUS: scan.capBlocked ? "KEY_SCAN_CAP_BLOCKED" : "COMPLETE",
    PROD_ROW_N: prod.available ? prod.rowN : null,
    CLONE_ROW_N: cloneRowN,
    PROD_MAX_OBSERVED_AT: prod.available ? prod.maxAt : null,
    CLONE_MAX_OBSERVED_AT: cloneMax,
    ...cloneFreshness(prod.available ? prod.maxAt : null, cloneMax),
    PROD_READ: prod.available ? "OK" : ("error" in prod ? `UNAVAILABLE:${prod.error}` : "UNAVAILABLE:PRODUCTION_DB_CONFIG_MISSING"),
    DAY_ROW_N: coverage.row_n, DAY_EVENT_N: coverage.event_n, DAY_TOKEN_N: coverage.token_n,
    COVERAGE: coverage,
    STORAGE: prod.available ? prod.storage : "UNAVAILABLE",
    MECHANISM_READINESS: mechanismReadiness(coverage.row_n, fullRows, coverage.CORE_MULTI_FAMILY_EVENT_CANDIDATE_N),
    THREE_DAY: threeDayReadiness(scan.rows, nowIso),
    claims: "COVERAGE_AND_READINESS_ONLY_NO_ALPHA_NO_THRESHOLD_FITTING",
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : "INPLAY_SCORECARD_FAILED"); process.exit(1); });
}
