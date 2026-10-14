// Research-only runner for EXECUTABLE_LIQUIDITY_COHORT_T90_V2. Reads the Research DBClone with GET requests and explicit
// projections only, reads Polymarket Gamma/CLOB (public, unauthenticated, no orders), and writes ONE local JSON receipt
// produced by buildCohortReceipt (the same pure function the tests verify). It never writes to any database, never places
// orders and never touches Production. The receipt is a local research artifact, NOT immutable DB persistence.
//   npm run research-clone:t90-liquidity-cohort -- --out <dir>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "dotenv/config";
import {
  APPROVED_SCORED_FORMULA, buildCohortReceipt, buildExecutableLiquidityCohort, COHORT_HORIZON_HOURS, T90_MINUTES,
  type SourceRow, type SourceSnapshot,
} from "../lib/research/executableLiquidityCohortT90";

const CLONE_REF = "nppznoujvnyjargjkmnv";
const TABLE = "research_evidence_page_rows";
const COLUMNS = "observation_id,item_observation_id,observed_at,ingested_at,condition_id,selected_token_id,selected_outcome,metric_formula_version,provider_event_id,provider_sport_family,market_type,game_start_iso,entry_price_num,pre_event_score_num";
const PAGE = 1000;
const SLICE_HOURS = 3;
/** Bounded deterministic universe: observations older than this cannot be the newest causal row of a horizon event. */
const LOOKBACK_HOURS = 72;
/** Runner guard only (not a freshness or economic rule): local clock vs the gateway HTTP Date proxy. */
const MAX_CLOCK_SKEW_MS = 5_000;

function cloneTarget() {
  const url = process.env.SUPABASE_CLONE_URL; const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== CLONE_REF) throw new Error(`REFUSING_NON_CLONE_TARGET: expected ${CLONE_REF}`);
  return { base: url.replace(/\/$/, ""), key };
}

async function get<T>(target: { base: string; key: string }, query: string, offset: number) {
  const res = await fetch(`${target.base}/rest/v1/${TABLE}?${query}`, {
    method: "GET",
    headers: { apikey: target.key, Authorization: `Bearer ${target.key}`, Range: `${offset}-${offset + PAGE - 1}`, "Range-Unit": "items" },
  });
  if (!res.ok) throw new Error(`CLONE_READ_${res.status}`);
  const date = res.headers.get("date");
  return { rows: (await res.json()) as T[], httpDateMs: date ? Date.parse(date) : NaN, localMs: Date.now() };
}

async function readSource(): Promise<SourceSnapshot> {
  const target = cloneTarget();
  const startLocal = Date.now();
  const from = new Date(startLocal - LOOKBACK_HOURS * 3_600_000).toISOString();
  // DB-owned snapshot bound: the newest `ingested_at` (column default now()) inside the read universe. Every page below is
  // pinned to ingested_at <= W, so rows ingested while paging cannot enter. W is NOT a statement timestamp/decision_at.
  const wm = await get<{ ingested_at: string }>(target, `select=ingested_at&observed_at=gte.${from}&order=ingested_at.desc&limit=1`, 0);
  const watermark = wm.rows[0] ? Date.parse(wm.rows[0].ingested_at) : NaN;
  if (!Number.isFinite(watermark)) throw new Error("DB_INGEST_WATERMARK_UNAVAILABLE");
  if (!Number.isFinite(wm.httpDateMs)) throw new Error("HTTP_DATE_PROXY_UNAVAILABLE");
  if (Math.abs(wm.httpDateMs - wm.localMs) > MAX_CLOCK_SKEW_MS) throw new Error("CLOCK_SKEW_EXCEEDS_GUARD");
  const wIso = new Date(watermark).toISOString();
  const startMin = new Date(startLocal + T90_MINUTES * 60_000).toISOString();
  const startMax = new Date(startLocal + COHORT_HORIZON_HOURS * 3_600_000 + 3_600_000).toISOString();
  const rows: SourceRow[] = [];
  for (let t = Date.parse(from); t <= watermark; t += SLICE_HOURS * 3_600_000) {
    const lo = new Date(t).toISOString(); const hi = new Date(t + SLICE_HOURS * 3_600_000).toISOString();
    for (let offset = 0; ; offset += PAGE) {
      const q = `select=${COLUMNS}&metric_formula_version=eq.${APPROVED_SCORED_FORMULA}&observed_at=gte.${lo}&observed_at=lt.${hi}&ingested_at=lte.${wIso}`
        + `&game_start_iso=gt.${startMin}&game_start_iso=lte.${startMax}&order=observed_at.asc,observation_id.asc,item_observation_id.asc`;
      const page = await get<SourceRow>(target, q, offset);
      rows.push(...page.rows);
      if (page.rows.length < PAGE) break;
    }
  }
  const done = Date.now();
  return { rows, timing: { dbIngestWatermarkMs: watermark, referenceMs: done, httpDateProxyMs: wm.httpDateMs, snapshotReadCompletedLocalMs: done } };
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  if (!outDir) throw new Error("--out <dir> is required (receipt contains live prospective identities; never commit it)");
  const run = await buildExecutableLiquidityCohort({ readSource });
  const receipt = buildCohortReceipt(run, Date.now(), { max_clock_skew_ms_vs_http_date_proxy: MAX_CLOCK_SKEW_MS, lookback_hours: LOOKBACK_HOURS });
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `t90-liquidity-cohort-${receipt.generated_local.replace(/[:.]/g, "")}.json`);
  writeFileSync(file, JSON.stringify(receipt, null, 2));
  // Terminal output: aggregates only (no identities, no credentials, no raw provider payloads).
  console.log(JSON.stringify({
    file, status: receipt.status, timing: { ...receipt.timing, guards: undefined }, funnel: receipt.funnel, diagnostics: receipt.diagnostics,
    rejection_reasons: receipt.rejection_reasons, cohort_digest: receipt.cohort_digest,
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
