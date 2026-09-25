/**
 * REFRESH_MODELING_DASHBOARD_V1 — Git-owned INCREMENTAL daily refresh for the
 * frozen Sep21 modeling dashboard. This is a LEGACY / DIAGNOSTIC daily-history
 * refresh only: it MUST NOT write CURRENT_MODELING_AUTHORITY.js, which is the
 * separate immutable current SAFE authority. This is a FREEZE / DAILY APPEND mission
 * script, not another modeling/search mission: it runs the already-accepted,
 * FROZEN model set through the existing capacity/economics engine for newly
 * closed MODEL_READY days only, and appends their aggregate results.
 *
 * SELECTION_BEFORE_SETTLEMENT_V1: model selection and the daily cap are
 * frozen using decision-time-only fields (toDecisionTimeSelectionInput /
 * runStandaloneStrict / runPortfolioStrict / applyDailyCap). Settlement is
 * joined in only AFTER selection+cap, via partialDailyResults(), so an OPEN
 * candidate still occupies its selected/capped slot and is never replaced by
 * a later-settled one. Appended pnl_u is SETTLED-PARTIAL only (never
 * fabricated for OPEN rows) — see pnl_semantic on each cap bucket below.
 *
 * ENGINE_REUSE (one capacity-selection authority, verbatim):
 *   toDecisionTimeSelectionInput <- scripts/modeling/factor-atlas.ts
 *   runStandaloneStrict / runPortfolioStrict / applyDailyCap /
 *   partialDailyResults        <- scripts/modeling/daily-portfolio-frontier.ts
 *   QUALITY_PORTFOLIOS (QUALITY_FILL_A / QUALITY_FILL_D tier definitions)
 *                <- scripts/modeling/quality-fill-portfolio-test.ts
 *   C5 predicate <- lib/modeling/research-engine/models.ts (FROZEN_MODELS.C5)
 * No second settlement/capacity implementation. No new score threshold. No
 * historical Sep21 decision is recomputed or optimized by this script.
 *
 * Normal usage (incremental, the only supported daily mode):
 *   npx tsx scripts/modeling/refresh-modeling-dashboard.ts
 *
 * Optional cheap verification mode (aggregate day-count check only, no row
 * fetch, never touches historical per-row economics):
 *   npx tsx scripts/modeling/refresh-modeling-dashboard.ts --verify-history
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import "dotenv/config";

import { enumerateMinskDates, type ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { FROZEN_MODELS } from "@/lib/modeling/research-engine/models";
import { toDecisionTimeSelectionInput, type DecisionTimeCandidate } from "./factor-atlas";
import {
  runStandaloneStrict,
  runPortfolioStrict,
  applyDailyCap,
  partialDailyResults,
  STANDALONE_STRATEGIES,
  PORTFOLIOS,
  type SelectedCandidate,
  type PartialDailyResultRow,
} from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";

const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";
const DATA_FILE = "modeling/evidence/modeling-dashboard-v1/MODELING_DAILY_DATA.js";
const CAPS = [30, 40, 50] as const;
const PAGE = 1000;
const FROZEN_PERIOD_START = "2026-08-04";
const FROZEN_PERIOD_END = "2026-09-20";
const FROZEN_CLOSED_DAYS = 48;

const MODEL_ORDER = ["QUALITY_FILL_A", "QUALITY_FILL_D", "P50_52", "PORTFOLIO_BROAD", "P50_54", "C5", "C0", "TENNIS_P50_52"] as const;
type ModelId = (typeof MODEL_ORDER)[number];

/**
 * Per-cap dashboard row. `n` is the SELECTED count (decision-time, before any
 * settlement filter) — never the settled-only count. `pnl_u` is SETTLED
 * candidates only (never fabricated for OPEN rows); `pnl_semantic` makes that
 * explicit so a reader can never mistake it for final daily P&L while
 * `open_n > 0`. Field name `pnl_u` is kept only for dashboard compatibility.
 */
interface CapBucket {
  n: number;
  settled_n: number;
  open_n: number;
  other_nonterminal_n: number;
  pnl_u: number;
  pnl_semantic: "settled_partial";
  settlement_coverage_pct: number;
}

function roundPct(v: number): number {
  const r = Math.round((v + Number.EPSILON) * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function toCapBucket(row: PartialDailyResultRow): CapBucket {
  return {
    n: row.event_n,
    settled_n: row.settled_n,
    open_n: row.open_n,
    other_nonterminal_n: row.other_nonterminal_n,
    pnl_u: row.settled_pnl_u_partial,
    pnl_semantic: "settled_partial",
    settlement_coverage_pct: row.event_n ? roundPct((row.settled_n / row.event_n) * 100) : 0,
  };
}

// Decision-time-only predicate/tier types — same shape as the legacy
// AtlasEvaluatedEvent predicates (entryPrice/scoreLevel/sportFamily/
// leadTimeHours only, never outcome), reused verbatim via the same
// `as unknown as` structural cast pattern already used internally by
// runStandaloneStrict/runPortfolioStrict for the DecisionTimeCandidate shape.
type StandaloneStrictPredicate = Parameters<typeof runStandaloneStrict>[1];
type PortfolioStrictTiers = Parameters<typeof runPortfolioStrict>[1];

function findStrategy(id: string): StandaloneStrictPredicate {
  const s = STANDALONE_STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`STANDALONE_STRATEGY_MISSING:${id}`);
  return s.predicate as unknown as StandaloneStrictPredicate;
}
function findPortfolio(id: string): PortfolioStrictTiers {
  const p = PORTFOLIOS.find((x) => x.id === id);
  if (!p) throw new Error(`PORTFOLIO_MISSING:${id}`);
  return p.tiers as unknown as PortfolioStrictTiers;
}

/**
 * One frozen run spec per tracked model — reused verbatim from the accepted
 * definitions. SELECTION_BEFORE_SETTLEMENT_V1: this only ever selects/caps
 * DecisionTimeCandidate[] (no outcome/labelAsOf field exists on that shape);
 * settlement is joined in by the caller only after selection+cap.
 */
function runModel(modelId: ModelId, input: DecisionTimeCandidate[]): SelectedCandidate[] {
  switch (modelId) {
    case "QUALITY_FILL_A":
      return runPortfolioStrict(input, QUALITY_PORTFOLIOS.QUALITY_FILL_A as unknown as PortfolioStrictTiers);
    case "QUALITY_FILL_D":
      return runPortfolioStrict(input, QUALITY_PORTFOLIOS.QUALITY_FILL_D as unknown as PortfolioStrictTiers);
    case "P50_52":
      return runStandaloneStrict(input, findStrategy("P50_52"));
    case "PORTFOLIO_BROAD":
      return runPortfolioStrict(input, findPortfolio("PORTFOLIO_BROAD"));
    case "P50_54":
      return runStandaloneStrict(input, findStrategy("P50_54"));
    case "C5":
      return runStandaloneStrict(input, FROZEN_MODELS.C5.predicate as unknown as StandaloneStrictPredicate);
    case "C0":
      return runStandaloneStrict(input, findStrategy("C0"));
    case "TENNIS_P50_52":
      return runStandaloneStrict(input, findStrategy("TENNIS_P50_52"));
  }
}

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

function loadDashboardData(path: string): any {
  const src = readFileSync(path, "utf8");
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path });
  const data = sandbox.window.POLYPROPICKS_MODELING_DATA;
  if (!data) throw new Error(`DATA_FILE_MISSING_GLOBAL: ${path}`);
  return data;
}

function lastDashboardDate(data: any): string {
  const dailyDates: string[] = (data.daily ?? []).map((r: { date: string }) => r.date);
  const latest = dailyDates.length ? dailyDates.sort().at(-1)! : data.meta.latestDashboardDate;
  return latest > data.meta.latestDashboardDate ? latest : data.meta.latestDashboardDate;
}

async function fetchRowsForDates(db: Awaited<ReturnType<typeof resolveDb>>, dates: string[]): Promise<ScorecardReadyRow[]> {
  const start = dates[0];
  const end = dates[dates.length - 1];
  const dateSet = new Set(dates);
  const rows: ScorecardReadyRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select("model_date,canonical_row")
      .gte("model_date", start)
      .lte("model_date", end)
      .order("model_date")
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ model_date: string; canonical_row: ScorecardReadyRow }>) {
      if (dateSet.has(r.model_date)) rows.push(r.canonical_row);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function verifyHistory(db: Awaited<ReturnType<typeof resolveDb>>): Promise<void> {
  // Cheap aggregate-count-only check: never fetches rows, never recomputes historical economics.
  const { count, error } = await db
    .from("research_model_ready_days")
    .select("model_date", { count: "exact", head: true })
    .eq("status", "MODEL_READY")
    .gte("model_date", FROZEN_PERIOD_START)
    .lte("model_date", FROZEN_PERIOD_END);
  if (error) throw new Error(`VERIFY_HISTORY_COUNT:${error.code ?? error.message}`);
  const pass = count === FROZEN_CLOSED_DAYS;
  console.log(
    JSON.stringify(
      {
        MODE: "VERIFY_HISTORY",
        FROZEN_PERIOD: { start: FROZEN_PERIOD_START, end: FROZEN_PERIOD_END },
        EXPECTED_MODEL_READY_DAYS: FROZEN_CLOSED_DAYS,
        ACTUAL_MODEL_READY_DAYS: count,
        PASS: pass,
      },
      null,
      2,
    ),
  );
  if (!pass) process.exitCode = 1;
}

async function main(): Promise<void> {
  const db = await resolveDb();

  if (process.argv.includes("--verify-history")) {
    await verifyHistory(db);
    return;
  }

  const data = loadDashboardData(DATA_FILE);
  const lastDate = lastDashboardDate(data);
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data: dayRows, error: dayErr } = await db
    .from("research_model_ready_days")
    .select("model_date,status")
    .gt("model_date", lastDate)
    .lt("model_date", todayIso) // never include a partial current day
    .order("model_date");
  if (dayErr) throw new Error(`FETCH_DAYS:${dayErr.code ?? dayErr.message}`);

  const newDates = (dayRows ?? [])
    .filter((r: { status: string }) => r.status === "MODEL_READY")
    .map((r: { model_date: string }) => r.model_date)
    .sort();

  if (newDates.length === 0) {
    console.log("NO_NEW_CLOSED_DAYS");
    process.exitCode = 0;
    return;
  }

  const rawRows = await fetchRowsForDates(db, newDates);
  // SELECTION_BEFORE_SETTLEMENT_V1: candidates carry no outcome/labelAsOf field at
  // all — settlement is looked up only after selection+cap, via settlementByCandidateIdentity.
  const { candidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);

  const appended: Array<{ date: string; model: ModelId; cap30: CapBucket; cap40: CapBucket; cap50: CapBucket }> = [];
  for (const modelId of MODEL_ORDER) {
    const selected = runModel(modelId, candidates);
    const perCapDaily = CAPS.map((cap) => partialDailyResults(applyDailyCap(selected, cap), settlementByCandidateIdentity, newDates));
    for (let i = 0; i < newDates.length; i++) {
      const date = newDates[i];
      appended.push({
        date,
        model: modelId,
        cap30: toCapBucket(perCapDaily[0][i]),
        cap40: toCapBucket(perCapDaily[1][i]),
        cap50: toCapBucket(perCapDaily[2][i]),
      });
    }
  }

  // Deterministic order: date ASC, then MODEL_ORDER. Frozen Aug04-Sep20 daily[] entries (none seeded — see
  // MODELING_DAILY_DATA.js header) plus prior appended entries are preserved verbatim ahead of the new ones.
  const existingDaily = (data.daily ?? []) as typeof appended;
  const mergedDaily = [...existingDaily, ...appended].sort((a, b) => a.date.localeCompare(b.date) || MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model));

  data.daily = mergedDaily;
  data.meta.latestDashboardDate = newDates[newDates.length - 1];
  data.GENERATED_AT = new Date().toISOString();

  const header = readFileSync(DATA_FILE, "utf8").split("window.POLYPROPICKS_MODELING_DATA")[0];
  const rewritten = `${header}window.POLYPROPICKS_MODELING_DATA = ${JSON.stringify(data, null, 2)};\n`;
  writeFileSync(DATA_FILE, rewritten, "utf8");

  console.log(
    JSON.stringify(
      {
        MODE: "INCREMENTAL_REFRESH",
        APPENDED_DATES: newDates,
        APPENDED_ROW_N: appended.length,
        NEW_DASHBOARD_ENDPOINT_DATE: data.meta.latestDashboardDate,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ STATUS: "FAILED", ERROR: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
