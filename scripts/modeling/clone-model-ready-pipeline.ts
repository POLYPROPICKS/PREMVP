/** Clone-backed durable daily model readiness. Runs after successful clone sync. */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEGRADED_MODEL_DATES, MODEL_READY_VERSION, evaluateRows, toStoredModelRow } from "../../lib/research-clone/modelReady";
import type { ScorecardReadyRow } from "../../lib/modeling/research-corpus/rollingCorpus";

const OUT = "modeling/evidence/research-corpus-factory-live-v1";
const EXPECTED_CLONE_REF = "nppznoujvnyjargjkmnv";
const DAY_MS = 86_400_000;
const ROLLING_READ_PAGE_SIZE = 1_000;
const ROLLING_READ_MAX_ROWS = 100_000;

function projectRef(url: string) { return new URL(url).hostname.split(".")[0]; }
function arg(name: string) { const p = process.argv.find((v) => v.startsWith(`${name}=`)); return p?.slice(name.length + 1); }
function latestClosedMinskDay() {
  const shifted = new Date(Date.now() + 3 * 3_600_000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - DAY_MS).toISOString().slice(0, 10);
}
function datesRequested() { return (arg("--dates")?.split(",").filter(Boolean) ?? [latestClosedMinskDay()]).sort(); }
function corpusPath(d: string) { return join(OUT, `CORPUS_${d}.jsonl.gz`); }
function manifestPath(d: string) { return join(OUT, `MANIFEST_${d}.json`); }
function loadRows(d: string): ScorecardReadyRow[] {
  const lines = gunzipSync(readFileSync(corpusPath(d))).toString("utf8").split("\n").filter(Boolean);
  return lines.map((line) => { const r = JSON.parse(line); return { ...r, frozenLabel: r.label, labelAsOf: r.label } as ScorecardReadyRow; });
}
function dateMinus(end: string, days: number) { return new Date(Date.parse(`${end}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10); }
export function isInModelDateWindow(row: { model_date: string }, start: string, end: string) {
  return row.model_date >= start && row.model_date <= end;
}
async function readRollingRows(db: any, floor: string, asOf: string) {
  const rows: Array<{ model_date: string; population_id: string; canonical_row: ScorecardReadyRow }> = [];
  for (let from = 0; ; from += ROLLING_READ_PAGE_SIZE) {
    const { data, error } = await db.from("research_model_ready_rows")
      .select("model_date,population_id,canonical_row")
      .gte("model_date", floor).lte("model_date", asOf)
      .order("model_date").order("population_id").order("condition_id").order("selected_token_id").order("decision_at")
      .range(from, from + ROLLING_READ_PAGE_SIZE - 1);
    if (error) throw new Error(`CLONE_MODEL_READY_READ:${error.code ?? error.message}`);
    rows.push(...(data ?? []));
    if (rows.length > ROLLING_READ_MAX_ROWS) throw new Error("CLONE_MODEL_READY_READ_LIMIT_REACHED");
    if ((data?.length ?? 0) < ROLLING_READ_PAGE_SIZE) return rows;
  }
}
export function isSchemaPendingError(error: unknown): boolean {
  return error instanceof Error && /CLONE_MODEL_(?:DAY_READ|ROW_WRITE|ECONOMICS_WRITE|READY_READ|ROLLING_WRITE):PGRST205/.test(error.message);
}

async function main() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("REQUIRED_CLONE_WRITE_AUTHORIZATION_UNAVAILABLE");
  if (projectRef(url) !== EXPECTED_CLONE_REF || (process.env.SUPABASE_URL && projectRef(process.env.SUPABASE_URL) === projectRef(url))) throw new Error("RESEARCH_CLONE_RUNTIME_TARGET_MISMATCH");
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const dates = datesRequested();

  for (const d of dates) {
    const accepted = await db.from("research_model_ready_days").select("status").eq("model_date", d).maybeSingle();
    if (accepted.error) throw new Error(`CLONE_MODEL_DAY_READ:${accepted.error.code ?? accepted.error.message}`);
    // Once accepted, the clone row-set and its label AS-OF remain immutable.
    // Routine reruns skip the day and only refresh rolling projections below.
    if (accepted.data?.status === "MODEL_READY" || accepted.data?.status === "DEGRADED_EXCLUDED") continue;
    if (DEGRADED_MODEL_DATES.has(d)) {
      const { error } = await db.from("research_model_ready_days").upsert({ model_date:d, status:"DEGRADED_EXCLUDED", row_n:0, source_kind:"RESEARCH_CLONE", completed_at:new Date().toISOString() });
      if (error) throw new Error(`CLONE_MODEL_DAY_WRITE:${error.code ?? error.message}`);
      continue;
    }
    if (!existsSync(corpusPath(d)) || !existsSync(manifestPath(d))) {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/modeling/live-d1-research-corpus.ts", "--d1", d], { stdio:"inherit", env:process.env });
    }
    const rows = loadRows(d);
    for (let i=0; i<rows.length; i+=500) {
      const payload = rows.slice(i,i+500).map((r) => toStoredModelRow(d,r));
      const { error } = await db.from("research_model_ready_rows").upsert(payload, { onConflict:"model_date,population_id,condition_id,selected_token_id,decision_at" });
      if (error) throw new Error(`CLONE_MODEL_ROW_WRITE:${error.code ?? error.message}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath(d),"utf8"));
    const computedAt = new Date().toISOString();
    const economics: Record<string, unknown>[] = [];
    for (const populationId of [...new Set(rows.map((r) => r.populationId))].sort()) {
      const models = evaluateRows(rows.filter((r) => r.populationId === populationId));
      for (const [modelId,m] of Object.entries(models)) economics.push({ as_of_date:d, period_kind:"DAILY", period_start:d, period_end:d, population_id:populationId, model_id:modelId, event_n:m.SELECTED_PHYSICAL_EVENT_N, wins:m.WINS, losses:m.LOSSES, pnl_u:m.PNL_U, roi_pct:m.ROI_PCT, max_drawdown_u:m.MAX_DRAWDOWN_U, model_version:MODEL_READY_VERSION, source_kind:"RESEARCH_CLONE", computed_at:computedAt });
    }
    let write = await db.from("research_model_economics").upsert(economics, { onConflict:"as_of_date,period_kind,population_id,model_id" });
    if (write.error) throw new Error(`CLONE_MODEL_ECONOMICS_WRITE:${write.error.code ?? write.error.message}`);
    write = await db.from("research_model_ready_days").upsert({ model_date:d, status:"MODEL_READY", row_n:rows.length, canonical_content_sha256:manifest.CANONICAL_CONTENT_SHA256 ?? null, source_kind:"RESEARCH_CLONE", completed_at:computedAt });
    if (write.error) throw new Error(`CLONE_MODEL_DAY_WRITE:${write.error.code ?? write.error.message}`);
  }

  const asOf = dates.filter((d) => !DEGRADED_MODEL_DATES.has(d)).at(-1) ?? latestClosedMinskDay();
  const floor = dateMinus(asOf,30);
  const all = (await readRollingRows(db, floor, asOf)).filter((r) => !DEGRADED_MODEL_DATES.has(r.model_date));
  const computedAt = new Date().toISOString();
  const rolling: Record<string, unknown>[] = [];
  for (const days of [7,14,30] as const) {
    const start = dateMinus(asOf,days);
    const windowRows = all.filter((r:any) => isInModelDateWindow(r, start, asOf));
    for (const populationId of [...new Set(windowRows.map((r:any) => r.population_id))].sort()) {
      const models = evaluateRows(windowRows.filter((r:any) => r.population_id === populationId).map((r:any) => r.canonical_row as ScorecardReadyRow));
      for (const [modelId,m] of Object.entries(models)) rolling.push({ as_of_date:asOf, period_kind:`${days}D`, period_start:start, period_end:asOf, population_id:populationId, model_id:modelId, event_n:m.SELECTED_PHYSICAL_EVENT_N, wins:m.WINS, losses:m.LOSSES, pnl_u:m.PNL_U, roi_pct:m.ROI_PCT, max_drawdown_u:m.MAX_DRAWDOWN_U, model_version:MODEL_READY_VERSION, source_kind:"RESEARCH_CLONE", computed_at:computedAt });
    }
  }
  const w = await db.from("research_model_economics").upsert(rolling, { onConflict:"as_of_date,period_kind,population_id,model_id" });
  if (w.error) throw new Error(`CLONE_MODEL_ROLLING_WRITE:${w.error.code ?? w.error.message}`);
  console.log(JSON.stringify({ STATUS:"SUCCESS", SOURCE:"RESEARCH_CLONE", MODEL_READY_DATES:dates, LATEST_MODEL_READY_DATE:asOf, MODEL_IDS:["C0","C1","C4","C5"], PRODUCTION_PRIMARY_READS:0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => {
  // Schema activation is intentionally a separate clone-only operation. Until
  // then raw sync is still successful; a missing table is a safe no-op, not a
  // cron failure. Any other downstream error remains visible and fails closed.
  if (isSchemaPendingError(e)) {
    console.log(JSON.stringify({ STATUS:"MODEL_READY_SCHEMA_PENDING", SOURCE:"RESEARCH_CLONE", RAW_SYNC_PRESERVED:true }));
    return;
  }
  console.error(JSON.stringify({STATUS:"FAILED",ERROR:e instanceof Error?e.message:String(e)})); process.exitCode=1;
});
