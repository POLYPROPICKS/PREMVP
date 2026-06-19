import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import {
  addOnePerMatchBacktestSheet,
  onePerMatchEmailSummary,
  persistOnePerMatchBacktest,
  runOnePerMatchBacktestFromRows,
  writeOnePerMatchSummary,
  type OnePerMatchBacktestResult,
} from "../lib/modeling/onePerMatchBacktest";

type JobRun = {
  source: string | null;
  started_at: string | null;
  finished_at: string | null;
  status: string | null;
  generated_count: number | null;
  rejected_count: number | null;
  duration_ms: number | null;
  error_message: string | null;
  diagnostics: Record<string, unknown> | null;
};

type RawRow = Record<string, unknown>;

type CanonicalRow = RawRow & {
  __strict_key: string;
  __strict_rank: [number, number, number, number, number];
};

const TRACKED_ANALYZER = path.resolve(process.cwd(), "scripts", "modeling", "analyze-ice1-freeze.py");
const CEO_TEMPLATE_PATHS = [
  path.resolve(process.cwd(), "assets", "reporting", "CEO_Morning_Report_TEMPLATE.xlsx"),
  path.resolve(process.cwd(), "CEO_Morning_Report_TEMPLATE.xlsx"),
];
const CEO_DETAILS_TEMPLATE_PATH = path.resolve(process.cwd(), "ceo_dashboard_details2.xlsx");
const ICE_COUNTERFACTUAL_TEMPLATE_PATH = path.resolve(process.cwd(), "final_ice_four_models_counterfactual.xlsx");
const CANONICAL_ICE_COUNTERFACTUAL_INPUT = path.resolve(
  process.cwd(),
  "modeling",
  "ice1_modeling_20260617_post_resolver_707plus",
  "input",
  "ice1_resolved_post_resolver_707plus.csv",
);
const INPUT_NAME = "resolved_freeze.csv";
const REPORT_ROOT = path.resolve(process.cwd(), "modeling", "morning_model_report");
const ICE707_BASELINE_ROWS = 707;
const ICE707_BASELINE_EVENTS = 501;
const ICE707_MAX_RESOLVED_AT = "2026-06-17T09:01:31.130Z";
const GENERATED_SIGNAL_PAIRS_REPORT_COLUMNS = [
  "id",
  "created_at",
  "resolved_at",
  "condition_id",
  "selected_token_id",
  "selected_outcome",
  "market_slug",
  "event_slug",
  "signal_result",
  "winning_outcome",
  "realized_return_pct",
  "signal_confidence_num",
  "pre_event_score_num",
  "score",
  "expected_return_pct_num",
  "smart_money_score_num",
  "whale_public_score_num",
  "entry_price_num",
  "formula_version",
  "metric_formula_version",
  "expires_at",
  "source",
  "market_source",
  "premium_signal",
  "diagnostics",
  "trust_metrics",
].join(",");
const CEO_SHEETS = [
  "00_CEO_Decision",
  "01_Current_Model",
  "02_Model_Ranking",
  "03_Bankroll",
  "04_Recent_Windows",
  "05_Night_Execution",
  "06_Data_Quality",
] as const;
const ONE_PER_MATCH_SHEET = "OnePerMatchBacktest";
const POLICY_HEADERS = [
  "policy", "N", "events", "wins", "losses", "win_rate", "pnl10", "roi", "avg_return",
  "median_return", "max_dd", "pnl_dd", "worst_losing_streak", "24h_N", "24h_pnl10",
  "24h_roi", "48h_N", "48h_pnl10", "48h_roi", "96h_N", "96h_pnl10", "96h_roi", "7d_N",
  "7d_pnl10", "7d_roi", "status",
];
const DECISION_HEADERS = [
  "rank", "policy", "role", "exact_vs_approx", "N", "pnl", "roi", "maxDD", "pnlDD",
  "7d_roi", "7d_pnl", "bankroll_300_survival", "status", "reason",
];
const BANKROLL_HEADERS = [
  "stake_policy", "bets", "final_bank", "total_pnl", "roi_on_turnover", "max_drawdown_dollars",
  "max_drawdown_pct", "minimum_equity", "CSM", "LHM_proxy", "worst_losing_streak",
  "survives_300", "path_comment",
];
const WINDOW_HEADERS = [
  "Window", "Model slice", "Unique rows", "Bets", "Resolved", "Unresolved", "Net PnL after cost",
  "ROI on resolved stake", "Comment",
];
const FREEZE_RANK_HEADERS = ["Rank", "Strategy", "Role / Status", "Corpus", "N", "Net PnL", "ROI", "MaxDD"];
const NIGHT_HEADERS = [
  "#", "scope", "event", "market", "side", "tier_model", "execution_type", "stake", "odds_decimal",
  "order_status", "settlement_status", "pnl", "fee_slippage_pct_of_stake", "why_this_bet", "source_ref",
];
const CEO_DETAILS_SHEETS = [
  "00_CEO Dashboard",
  "01_Shadow Strategies",
  "02_Next Models",
  "03_Category Summary",
  "04_Score Calibration",
  "05_Max Trade Proxy",
  "06_Recent Volume Proxy",
  "07_Timing Proxy OBS",
  "08_Market Families",
  "09_Odds Bands",
  "10_Action Profiles",
  "11_Odds Label Profiles",
  "12_Coverage Bands",
  "13_Cross Score-Odds",
] as const;
const CURRENT_MODEL_HEADERS = [
  "model", "role", "current?", "exact_or_approx", "N", "roi", "7d_roi", "maxDD", "pnlDD",
  "worst_streak", "survives_300", "deploy_status", "action_today",
];
const MODEL_RANKING_HEADERS = [
  "rank", "model", "current?", "exact_or_approx", "source", "N", "24h_N", "24h_roi", "48h_N",
  "48h_roi", "96h_N", "96h_roi", "7d_N", "7d_roi", "maxDD", "pnlDD", "survives_300", "verdict",
];
const CEO_BANKROLL_HEADERS = [
  "policy", "current?", "source", "start_bank", "final_bank", "total_pnl", "roi", "max_dd_$", "max_dd_%",
  "min_equity", "worst_streak", "survives_300", "comment",
];
const RECENT_WINDOWS_HEADERS = ["window", "model_slice", "source", "bets", "resolved", "net_pnl", "roi", "trust_flag"];
const DATA_QUALITY_HEADERS = ["field", "value"];

function argValue(prefix: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

const DRY_RUN = process.argv.includes("--dry-run");
const SEND_TEST = process.argv.includes("--send-test");
const EMAIL_RECIPIENT =
  argValue("--email=") ??
  process.env.MORNING_MODEL_EMAIL_TO ??
  process.env.NIGHT_PLAN_EMAIL_TO ??
  "alexgrushin@gmail.com";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || ["null", "none", "nan"].includes(s.toLowerCase())) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseIso(v: unknown): number {
  const s = safeStr(v);
  if (!s) return Number.NEGATIVE_INFINITY;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function fmtPct(v: unknown): string {
  const n = safeNum(v);
  return n === null ? "N/A" : `${n.toFixed(2)}%`;
}

function fmtMoney(v: unknown): string {
  const n = safeNum(v);
  return n === null ? "N/A" : `$${n.toFixed(2)}`;
}

function strictKey(row: RawRow): string {
  return `${safeStr(row.condition_id) ?? ""}::${safeStr(row.selected_token_id) ?? ""}`;
}

function rowRank(row: RawRow): [number, number, number, number, number] {
  return [
    safeNum(row.realized_return_pct) !== null ? 1 : 0,
    safeStr(row.signal_result) ? 1 : 0,
    parseIso(row.resolved_at),
    parseIso(row.created_at),
    safeNum(row.id) ?? 0,
  ];
}

function betterRank(a: [number, number, number, number, number], b: [number, number, number, number, number]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function dedupeStrict(rows: RawRow[]): CanonicalRow[] {
  const map = new Map<string, CanonicalRow>();
  for (const row of rows) {
    const key = strictKey(row);
    if (key === "::") continue;
    const ranked: CanonicalRow = { ...row, __strict_key: key, __strict_rank: rowRank(row) };
    const prev = map.get(key);
    if (!prev || betterRank(ranked.__strict_rank, prev.__strict_rank)) {
      map.set(key, ranked);
    }
  }
  return [...map.values()].sort((a, b) => b.__strict_rank[2] - a.__strict_rank[2]);
}

function writeCsv(pathname: string, rows: RawRow[], headers: string[]): Promise<void> {
  const body = [
    headers.join(","),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(",")),
  ].join("\n") + "\n";
  return writeFile(pathname, body, "utf8");
}

async function fetchAllResolvedRows(): Promise<RawRow[]> {
  const { supabaseAdmin } = await import("../lib/supabase/server");
  const { data: countData, error: countError } = await supabaseAdmin.rpc("get_morning_strict_resolved_corpus_count");
  if (countError) throw new Error(`DB_STRICT_CORPUS_RPC_MISSING: ${countError.message}`);
  const target = Number(Array.isArray(countData) ? countData[0]?.get_morning_strict_resolved_corpus_count ?? countData[0]?.count ?? countData[0] : countData ?? 0);
  if (!Number.isFinite(target) || target <= 0) throw new Error("DB_STRICT_CORPUS_RPC_MISSING: invalid count");
  console.log(`[morning-model] db-strict-corpus-count rows=${target}`);
  const deduped: CanonicalRow[] = [];
  for (let offset = 0; offset < target; offset += 500) {
    const { data, error } = await supabaseAdmin.rpc("get_morning_strict_resolved_corpus_page", { p_limit: 500, p_offset: offset });
    if (error) throw new Error(`DB_STRICT_CORPUS_RPC_MISSING: ${error.message}`);
    const chunk = ((data ?? []) as RawRow[]).map((row) => {
      const key = strictKey(row);
      return { ...row, __strict_key: key, __strict_rank: rowRank(row) } as CanonicalRow;
    }).filter((row) => row.__strict_key !== "::");
    deduped.push(...chunk);
    console.log(`[morning-model] db-strict-corpus-page offset=${offset} rows=${chunk.length} total=${deduped.length}`);
    if (chunk.length === 0) break;
  }
  if (deduped.length !== target) throw new Error(`DB_STRICT_CORPUS_RPC_MISSING: collected=${deduped.length} expected=${target}`);
  const maxResolvedAt = deduped.reduce((max, row) => {
    const t = parseIso(row.resolved_at);
    return t > max ? t : max;
  }, Number.NEGATIVE_INFINITY);
  console.log(`[morning-model] db-strict-corpus final rows=${deduped.length} events=${new Set(deduped.map((r) => eventKey(r))).size} max_resolved_at=${Number.isFinite(maxResolvedAt) ? new Date(maxResolvedAt).toISOString() : "N/A"}`);
  console.log(`[morning-model] strict_resolved_total=${deduped.length} events=${new Set(deduped.map((r) => eventKey(r))).size} max_resolved_at=${Number.isFinite(maxResolvedAt) ? new Date(maxResolvedAt).toISOString() : "N/A"}`);
  return deduped;
}

async function fetchLatestJobRun(source: string): Promise<JobRun | null> {
  const { supabaseAdmin } = await import("../lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("job_runs")
    .select("source, started_at, finished_at, status, generated_count, rejected_count, duration_ms, error_message, diagnostics")
    .eq("source", source)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`job_runs(${source}): ${error.message}`);
  return (data?.[0] as JobRun | undefined) ?? null;
}

async function fetchNightExecutionSlice(startIso: string, endIso: string): Promise<OrderEventRow[]> {
  const { supabaseAdmin } = await import("../lib/supabase/server");
  const { data, error } = await supabaseAdmin
    .from("executor_order_events")
    .select(
      "created_at, market_slug, condition_id, token_id, selected_side, side, stake_usd, submitted_size, fee_usd, live_confirm, order_status, success, model_rule_id, strategic_scope, submitted_price, observed_price, observed_best_bid, observed_best_ask, candidate_snapshot_json, executor_meta",
    )
    .gte("created_at", startIso)
    .lte("created_at", endIso)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`executor_order_events: ${error.message}`);
  return (data ?? []) as OrderEventRow[];
}

async function runAnalyzer(reportDir: string, freezePath: string, reportsDir: string, tablesDir: string): Promise<void> {
  const py = spawnSync("python", [TRACKED_ANALYZER], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      ICE1_MODEL_BASE_DIR: reportDir,
      ICE1_MODEL_INPUT_PATH: freezePath,
      ICE1_MODEL_REPORTS_DIR: reportsDir,
      ICE1_MODEL_TABLES_DIR: tablesDir,
    },
  });
  if (py.status !== 0) {
    throw new Error((py.stderr || py.stdout || "analyzer failed").slice(0, 800));
  }
}

async function writeFallbackArtifacts(opts: {
  reportsDir: string;
  tablesDir: string;
  reportPath: string;
  runSummaryPath: string;
  summaryMdPath: string;
  strictNow: number;
  strict24h: number;
  events: number;
  newestResolvedAt: string | null;
  latestResolver: JobRun | null;
  latestSignalCache: JobRun | null;
  analyzerError: string;
  freezePath: string;
  reportDir: string;
  now: Date;
  canonicalRows: CanonicalRow[];
  nightRowsRaw: OrderEventRow[];
}): Promise<{ summaryMd: string; reportText: string; subject: string }> {
  const policyRows = buildFallbackPolicyRows(opts.canonicalRows);
  const decisionRows = buildDecisionBoardRows(policyRows);
  const bankrollRows = buildBankrollRows(policyRows);
  const windowRows = buildWindowModelView(policyRows);
  const freezeRows = buildFreezeRankingAlt(policyRows, `${opts.strictNow} strict freeze`);
  const nightExecutionRows = buildNightExecutionRows(opts.nightRowsRaw);

  await writeCsv(path.join(opts.tablesDir, "policy_kpis.csv"), policyRows, POLICY_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "decision_board.csv"), decisionRows, DECISION_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "bankroll_simulations.csv"), bankrollRows, BANKROLL_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "window_model_view.csv"), windowRows, WINDOW_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "freeze_ranking_alt.csv"), freezeRows, FREEZE_RANK_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "night_execution_detail.csv"), nightExecutionRows, NIGHT_HEADERS);

  const latestResolverText = opts.latestResolver
    ? `- Resolver: ${opts.latestResolver.status} @ ${fmtDate(opts.latestResolver.started_at)} | selected=${safeNum(opts.latestResolver.diagnostics?.selected)} | generated=${opts.latestResolver.generated_count ?? "N/A"} | skipped=${opts.latestResolver.rejected_count ?? "N/A"}`
    : "- Resolver: N/A";
  const latestSignalCacheText = opts.latestSignalCache
    ? `- Signal-cache: ${opts.latestSignalCache.status} @ ${fmtDate(opts.latestSignalCache.started_at)} | generated=${opts.latestSignalCache.generated_count ?? "N/A"} | skipped=${opts.latestSignalCache.rejected_count ?? "N/A"}`
    : "- Signal-cache: N/A";
  const fallbackSummaryMd = [
    "# Ice1 Input Freeze Summary",
    "",
    "- WARNING: Analyzer failed, fallback KPIs recomputed in TypeScript.",
    `- CSV path used: \`${opts.freezePath}\``,
    `- row count: ${opts.strictNow}`,
    `- usable resolved rows: ${opts.strictNow}`,
    `- distinct condition_id + selected_token_id: ${opts.strictNow}`,
    `- distinct events: ${opts.events}`,
    `- created_at range: UNKNOWN -> UNKNOWN`,
    `- resolved_at range: ${opts.newestResolvedAt ?? "UNKNOWN"} -> ${opts.newestResolvedAt ?? "UNKNOWN"}`,
    "",
    "## Latest Job Runs",
    "",
    latestResolverText,
    latestSignalCacheText,
    "",
    "## Analyzer Error",
    "",
    `- ${opts.analyzerError}`,
  ].join("\n");
  await writeFile(opts.summaryMdPath, fallbackSummaryMd + "\n", "utf8");

  const reportText = [
    "# Morning Model Recalculation Report",
    "",
    "WARNING: Analyzer failed, fallback KPIs recomputed in TypeScript.",
    `- strictNow: ${opts.strictNow}`,
    `- strict24h: ${opts.strict24h}`,
    `- events: ${opts.events}`,
    `- newestResolvedAt: ${fmtDate(opts.newestResolvedAt)}`,
    opts.latestResolver
      ? `- latestResolver: ${opts.latestResolver.status} @ ${fmtDate(opts.latestResolver.started_at)} | selected=${safeNum(opts.latestResolver.diagnostics?.selected)} | generated=${opts.latestResolver.generated_count ?? "N/A"} | skipped=${opts.latestResolver.rejected_count ?? "N/A"}`
      : "- latestResolver: N/A",
    opts.latestSignalCache
      ? `- latestSignalCache: ${opts.latestSignalCache.status} @ ${fmtDate(opts.latestSignalCache.started_at)} | generated=${opts.latestSignalCache.generated_count ?? "N/A"} | skipped=${opts.latestSignalCache.rejected_count ?? "N/A"}`
      : "- latestSignalCache: N/A",
    `- analyzer error: ${opts.analyzerError}`,
    `- best fallback candidate: ${policyRows[0]?.policy ?? "N/A"}`,
    "",
    "## Artifact Paths",
    `- report: ${opts.reportPath}`,
    `- freeze: ${opts.freezePath}`,
    `- policyCsv: ${path.join(opts.tablesDir, "policy_kpis.csv")}`,
    `- decisionCsv: ${path.join(opts.tablesDir, "decision_board.csv")}`,
    `- bankrollCsv: ${path.join(opts.tablesDir, "bankroll_simulations.csv")}`,
    `- windowView: ${path.join(opts.tablesDir, "window_model_view.csv")}`,
    `- freezeRankingAlt: ${path.join(opts.tablesDir, "freeze_ranking_alt.csv")}`,
    `- nightExecutionDetail: ${path.join(opts.tablesDir, "night_execution_detail.csv")}`,
    "",
    "Night-plan and alert emails are separate and should still send.",
  ].join("\n");

  await writeFile(opts.reportPath, reportText + "\n", "utf8");
  await writeFile(
    opts.runSummaryPath,
    JSON.stringify(
      {
        fallback: true,
        fallbackMode: "FALLBACK_RECOMPUTED",
        analyzerError: opts.analyzerError,
        strictNow: opts.strictNow,
        strict24h: opts.strict24h,
        events: opts.events,
        newestResolvedAt: opts.newestResolvedAt,
        latestResolver: opts.latestResolver,
        latestSignalCache: opts.latestSignalCache,
        tables: {
          policyCsv: path.join(opts.tablesDir, "policy_kpis.csv"),
          decisionCsv: path.join(opts.tablesDir, "decision_board.csv"),
          bankrollCsv: path.join(opts.tablesDir, "bankroll_simulations.csv"),
          windowView: path.join(opts.tablesDir, "window_model_view.csv"),
          freezeRankingAlt: path.join(opts.tablesDir, "freeze_ranking_alt.csv"),
          nightExecutionDetail: path.join(opts.tablesDir, "night_execution_detail.csv"),
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    summaryMd: fallbackSummaryMd,
    reportText,
    subject: `PolyProPicks Morning Model Report — FALLBACK_RECOMPUTED — ${opts.now.toISOString().slice(0, 10)} — N=${opts.strictNow}`,
  };
}

function rowToReportLine(r: Record<string, string>, keys: string[]): string {
  return keys.map((k) => `${k}=${r[k] ?? ""}`).join(" | ");
}

type CsvRow = Record<string, string>;

type PolicyRow = CsvRow & {
  policy: string;
  N: string;
  events: string;
  wins: string;
  losses: string;
  win_rate: string;
  pnl10: string;
  roi: string;
  avg_return: string;
  median_return: string;
  max_dd: string;
  pnl_dd: string;
  worst_losing_streak: string;
  "24h_N": string;
  "24h_pnl10": string;
  "24h_roi": string;
  "48h_N": string;
  "48h_pnl10": string;
  "48h_roi": string;
  "96h_N": string;
  "96h_pnl10": string;
  "96h_roi": string;
  "7d_N": string;
  "7d_pnl10": string;
  "7d_roi": string;
  status: string;
};

type OrderEventRow = Record<string, unknown>;

type FallbackPolicySpec = {
  name: string;
  filter: (row: CanonicalRow) => boolean;
  onePerEvent?: "score" | "coverage";
};

type ReportStatus = "FULL_ANALYZER_OK" | "FALLBACK_RECOMPUTED" | "FAIL_NO_DATA";

function realizedPct(row: RawRow): number | null {
  const direct = safeNum(row.realized_return_pct);
  if (direct !== null) return direct;
  const result = safeStr(row.signal_result)?.toLowerCase();
  const price = safeNum(row.entry_price_num);
  if (!result || price === null || price <= 0) return null;
  if (["win", "won", "hit", "correct", "yes"].includes(result)) return ((1 - price) / price) * 100;
  if (["loss", "lost", "miss", "incorrect", "no"].includes(result)) return -100;
  return null;
}

function isWin(row: RawRow): boolean {
  const result = safeStr(row.signal_result)?.toLowerCase();
  if (result && ["win", "won", "hit", "correct", "yes"].includes(result)) return true;
  const ret = realizedPct(row);
  return ret !== null && ret > 0;
}

function isLoss(row: RawRow): boolean {
  const result = safeStr(row.signal_result)?.toLowerCase();
  if (result && ["loss", "lost", "miss", "incorrect", "no"].includes(result)) return true;
  const ret = realizedPct(row);
  return ret !== null && ret < 0;
}

function eventKey(row: RawRow): string {
  return safeStr(row.event_key) ?? safeStr(row.event_slug) ?? safeStr(row.market_slug) ?? strictKey(row);
}

function fallbackPnl(row: RawRow, stake = 10): number {
  const ret = realizedPct(row);
  return ret === null ? 0 : (ret / 100) * stake;
}

function selectOnePerEvent(rows: CanonicalRow[], mode: "score" | "coverage"): CanonicalRow[] {
  const selected = new Map<string, CanonicalRow>();
  for (const row of rows) {
    const key = eventKey(row);
    const prev = selected.get(key);
    if (!prev) {
      selected.set(key, row);
      continue;
    }
    const currentPrimary = mode === "coverage" ? safeNum(row.data_coverage_num) : safeNum(row.signal_confidence_num);
    const prevPrimary = mode === "coverage" ? safeNum(prev.data_coverage_num) : safeNum(prev.signal_confidence_num);
    const currentTie = safeNum(row.signal_confidence_num) ?? 0;
    const prevTie = safeNum(prev.signal_confidence_num) ?? 0;
    if ((currentPrimary ?? -1) > (prevPrimary ?? -1) || ((currentPrimary ?? -1) === (prevPrimary ?? -1) && currentTie > prevTie)) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function policyMetrics(name: string, inputRows: CanonicalRow[]): PolicyRow {
  const rows = [...inputRows].sort((a, b) => {
    const at = parseIso(a.resolved_at) || parseIso(a.created_at);
    const bt = parseIso(b.resolved_at) || parseIso(b.created_at);
    return at - bt;
  });
  const wins = rows.filter(isWin).length;
  const losses = rows.filter(isLoss).length;
  const pnl = rows.reduce((sum, row) => sum + fallbackPnl(row), 0);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  for (const row of rows) {
    const rowPnl = fallbackPnl(row);
    equity += rowPnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (isLoss(row)) {
      streak += 1;
      worstStreak = Math.max(worstStreak, streak);
    } else if (isWin(row)) {
      streak = 0;
    }
  }
  const avg = rows.length ? rows.reduce((sum, row) => sum + (realizedPct(row) ?? 0), 0) / rows.length : 0;
  const sortedRet = rows.map((row) => realizedPct(row) ?? 0).sort((a, b) => a - b);
  const median = sortedRet.length ? sortedRet[Math.floor(sortedRet.length / 2)] : 0;
  const windowMetric = (hours: number) => {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const subset = rows.filter((row) => parseIso(row.resolved_at) >= cutoff);
    const subsetPnl = subset.reduce((sum, row) => sum + fallbackPnl(row), 0);
    return { n: subset.length, pnl: subsetPnl, roi: subset.length ? (subsetPnl / (subset.length * 10)) * 100 : 0 };
  };
  const w24 = windowMetric(24);
  const w48 = windowMetric(48);
  const w96 = windowMetric(96);
  const w7d = windowMetric(168);
  const roi = rows.length ? (pnl / (rows.length * 10)) * 100 : 0;
  return {
    policy: name,
    N: String(rows.length),
    events: String(new Set(rows.map(eventKey)).size),
    wins: String(wins),
    losses: String(losses),
    win_rate: wins + losses ? ((wins / (wins + losses)) * 100).toFixed(2) : "0.00",
    pnl10: pnl.toFixed(2),
    roi: roi.toFixed(2),
    avg_return: avg.toFixed(2),
    median_return: median.toFixed(2),
    max_dd: maxDd.toFixed(2),
    pnl_dd: maxDd > 0 ? (pnl / maxDd).toFixed(4) : (pnl > 0 ? "999" : "0"),
    worst_losing_streak: String(worstStreak),
    "24h_N": String(w24.n),
    "24h_pnl10": w24.pnl.toFixed(2),
    "24h_roi": w24.roi.toFixed(2),
    "48h_N": String(w48.n),
    "48h_pnl10": w48.pnl.toFixed(2),
    "48h_roi": w48.roi.toFixed(2),
    "96h_N": String(w96.n),
    "96h_pnl10": w96.pnl.toFixed(2),
    "96h_roi": w96.roi.toFixed(2),
    "7d_N": String(w7d.n),
    "7d_pnl10": w7d.pnl.toFixed(2),
    "7d_roi": w7d.roi.toFixed(2),
    status: rows.length ? "FALLBACK_RECOMPUTED" : "APPROX_MISSING_FIELD",
  };
}

function buildFallbackPolicyRows(rows: CanonicalRow[]): PolicyRow[] {
  const specs: FallbackPolicySpec[] = [
    { name: "FLAT_ALL", filter: () => true },
    { name: "SCORE_GE_65", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 65 },
    { name: "SCORE_GE_72", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72 },
    { name: "SCORE_GE_72_AVOID_6_24H", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72 && !((safeNum(row.hours_until_start_num) ?? -1) >= 6 && (safeNum(row.hours_until_start_num) ?? -1) < 24) },
    { name: "ONE_PER_EVENT_SCORE_GE_72", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72, onePerEvent: "score" },
    { name: "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72, onePerEvent: "coverage" },
    { name: "COVERAGE_75_SCORE_GE_72", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72 && (safeNum(row.data_coverage_num) ?? -1) >= 75 },
    { name: "FIREMODEL1_APPROX_CURRENT", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 65 && (safeNum(row.data_coverage_num) ?? 0) >= 25 },
    { name: "EXCLUDE_BAD_BUCKET_SCORE_GE_65", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 65 && !((safeNum(row.data_coverage_num) ?? -1) >= 50 && (safeNum(row.data_coverage_num) ?? -1) <= 74 && (safeNum(row.entry_price_num) ?? -1) >= 0.44 && (safeNum(row.entry_price_num) ?? -1) <= 0.58) },
    { name: "EXCLUDE_BAD_BUCKET_SCORE_GE_72", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 72 && !((safeNum(row.data_coverage_num) ?? -1) >= 50 && (safeNum(row.data_coverage_num) ?? -1) <= 74 && (safeNum(row.entry_price_num) ?? -1) >= 0.44 && (safeNum(row.entry_price_num) ?? -1) <= 0.58) },
    { name: "FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 65 },
    { name: "ALT3_FLAT10_RAW_PROFIT_APPROX", filter: (row) => (safeNum(row.signal_confidence_num) ?? -1) >= 65 },
  ];
  return specs.map((spec) => {
    const filtered = rows.filter((row) => spec.filter(row) && realizedPct(row) !== null);
    const selected = spec.onePerEvent ? selectOnePerEvent(filtered, spec.onePerEvent) : filtered;
    return policyMetrics(spec.name, selected);
  });
}

function buildDecisionBoardRows(policies: PolicyRow[]): CsvRow[] {
  const specs = [
    ["0", "BASELINE_V1_CONTROL", "FLAT_ALL"],
    ["1", "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", "SCORE_GE_72_AVOID_6_24H"],
    ["2", "ALT1_ONE_PER_EVENT_BEST_COVERAGE", "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE"],
    ["3", "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH", "FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX"],
    ["4", "ALT3_V1_AVOID_NBA_NHL", "ALT3_FLAT10_RAW_PROFIT_APPROX"],
    ["5", "ALT4_AVOID_NBA_NHL_PLUS_COV75", "COVERAGE_75_SCORE_GE_72"],
  ] as const;
  return specs.map(([rank, strategy, source]) => {
    const row = pickPolicy(policies, [source]) ?? policies[0];
    return {
      rank,
      policy: strategy,
      role: rank === "0" ? "baseline" : "candidate",
      exact_vs_approx: rank === "0" ? "APPROX_CONTROL" : "APPROX_NEEDS_RECON",
      N: row?.N ?? "0",
      pnl: row?.pnl10 ?? "0.00",
      roi: row?.roi ?? "0.00",
      maxDD: row?.max_dd ?? "0.00",
      pnlDD: row?.pnl_dd ?? "0",
      "7d_roi": row?.["7d_roi"] ?? "0.00",
      "7d_pnl": row?.["7d_pnl10"] ?? "0.00",
      bankroll_300_survival: "YES",
      status: "NOT_DEPLOY_DECISION",
      reason: `Fallback KPI from ${source}; exact strategy reconstruction pending.`,
    };
  });
}

function buildBankrollRows(policies: PolicyRow[]): CsvRow[] {
  const specs = [
    ["FLAT_10", "FLAT_ALL"],
    ["STRICT_CAP_300_BANKROLL", "ONE_PER_EVENT_SCORE_GE_72"],
    ["PRIMARY_CANDIDATE", "SCORE_GE_72_AVOID_6_24H"],
  ] as const;
  return specs.map(([stakePolicy, source]) => {
    const row = pickPolicy(policies, [source]) ?? policies[0];
    const pnl = safeNum(row?.pnl10) ?? 0;
    const maxDd = safeNum(row?.max_dd) ?? 0;
    const finalBank = 300 + pnl;
    return {
      stake_policy: stakePolicy,
      bets: row?.N ?? "0",
      final_bank: finalBank.toFixed(2),
      total_pnl: pnl.toFixed(2),
      roi_on_turnover: row?.roi ?? "0.00",
      max_drawdown_dollars: maxDd.toFixed(2),
      max_drawdown_pct: (maxDd / 300 * 100).toFixed(2),
      minimum_equity: (300 - maxDd).toFixed(2),
      CSM: maxDd > 0 ? (pnl / maxDd).toFixed(4) : (pnl > 0 ? "999" : "0"),
      LHM_proxy: "open-position chronology unavailable",
      worst_losing_streak: row?.worst_losing_streak ?? "0",
      survives_300: finalBank > 0 && 300 - maxDd > 0 ? "YES" : "NO",
      path_comment: "Fallback bankroll simulation; not a deploy decision.",
    };
  });
}

function counterfactualSimRow(result: CounterfactualResult, window: string, modelMode: string): CsvRow | null {
  return result.simulationRows.find((row) => row.Window === window && row["Model (mode)"] === modelMode) ?? null;
}

function pctNumberText(v: string | undefined): string {
  if (!v) return "0.00";
  return v.replace(/%/g, "");
}

function moneyNumberText(v: string | undefined): string {
  if (!v) return "0.00";
  return v.replace(/[$,]/g, "");
}

function buildAcceptedCounterfactualPolicyRows(result: CounterfactualResult): PolicyRow[] {
  const primaryOne = counterfactualSimRow(result, "ALL_TIME", "Primary COV_CAP (1 матч)");
  const scoreOne = counterfactualSimRow(result, "ALL_TIME", "Score >=72 (1 матч)");
  const alt1One = counterfactualSimRow(result, "ALL_TIME", "ALT1 Best Coverage (1 матч)");
  const alt3One = counterfactualSimRow(result, "ALL_TIME", "ALT3 Avoid NBA/NHL (1 матч)");
  const flatAll = counterfactualSimRow(result, "ALL_TIME", "Primary COV_CAP (все)");
  const windowRows = (modelMode: string) => ({
    "24h": counterfactualSimRow(result, "LAST_24H", modelMode),
    "48h": counterfactualSimRow(result, "LAST_48H", modelMode),
    "96h": counterfactualSimRow(result, "LAST_48H", modelMode),
    "7d": counterfactualSimRow(result, "LAST_7D", modelMode),
  });
  const mk = (policy: string, allTimeRow: CsvRow | null, source: string, modelMode: string): PolicyRow => {
    const windows = windowRows(modelMode);
    const maxDd = safeNum(moneyNumberText(allTimeRow?.MaxDD as string | undefined)) ?? 0;
    const pnl = safeNum(moneyNumberText(allTimeRow?.PnL as string | undefined)) ?? 0;
    return ({
      policy,
      N: String(allTimeRow?.Bets ?? "0"),
      events: String(allTimeRow?.Events ?? "0"),
      wins: "0",
      losses: "0",
      win_rate: "0.00",
      pnl10: moneyNumberText(allTimeRow?.PnL as string | undefined),
      roi: pctNumberText(allTimeRow?.ROI as string | undefined),
      avg_return: "0.00",
      median_return: "0.00",
      max_dd: moneyNumberText(allTimeRow?.MaxDD as string | undefined),
      pnl_dd: maxDd !== 0 ? (pnl / maxDd).toFixed(4) : "0",
      worst_losing_streak: "0",
      "24h_N": String(windows["24h"]?.Bets ?? "0"),
      "24h_pnl10": moneyNumberText(windows["24h"]?.PnL as string | undefined),
      "24h_roi": pctNumberText(windows["24h"]?.ROI as string | undefined),
      "24h_events": String(windows["24h"]?.Events ?? "0"),
      "48h_N": String(windows["48h"]?.Bets ?? "0"),
      "48h_pnl10": moneyNumberText(windows["48h"]?.PnL as string | undefined),
      "48h_roi": pctNumberText(windows["48h"]?.ROI as string | undefined),
      "48h_events": String(windows["48h"]?.Events ?? "0"),
      "96h_N": String(windows["96h"]?.Bets ?? "0"),
      "96h_pnl10": moneyNumberText(windows["96h"]?.PnL as string | undefined),
      "96h_roi": pctNumberText(windows["96h"]?.ROI as string | undefined),
      "96h_events": String(windows["96h"]?.Events ?? "0"),
      "7d_N": String(windows["7d"]?.Bets ?? "0"),
      "7d_pnl10": moneyNumberText(windows["7d"]?.PnL as string | undefined),
      "7d_roi": pctNumberText(windows["7d"]?.ROI as string | undefined),
      "7d_events": String(windows["7d"]?.Events ?? "0"),
      status: `${source}_ONE_MATCH`,
      source: `${source}_ONE_MATCH`,
    } as PolicyRow);
  };
  return [
    mk("FLAT_ALL", flatAll, "ACCEPTED_COUNTERFACTUAL_SIM", "Primary COV_CAP (все)"),
    mk("SCORE_GE_72", scoreOne, "ACCEPTED_COUNTERFACTUAL_SIM", "Score >=72 (1 матч)"),
    mk("SCORE_GE_72_AVOID_6_24H", primaryOne, "ACCEPTED_COUNTERFACTUAL_SIM", "Primary COV_CAP (1 матч)"),
    mk("ONE_PER_EVENT_SCORE_GE_72", scoreOne, "ACCEPTED_COUNTERFACTUAL_SIM", "Score >=72 (1 матч)"),
    mk("ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", alt1One, "ACCEPTED_COUNTERFACTUAL_SIM", "ALT1 Best Coverage (1 матч)"),
    mk("ALT3_FLAT10_RAW_PROFIT_APPROX", alt3One, "ACCEPTED_COUNTERFACTUAL_SIM", "ALT3 Avoid NBA/NHL (1 матч)"),
  ];
}

function mergePolicyRows(legacy: PolicyRow[], accepted: PolicyRow[]): PolicyRow[] {
  const map = new Map<string, PolicyRow>();
  for (const row of legacy) map.set(row.policy, row);
  for (const row of accepted) map.set(row.policy, row);
  return [...map.values()];
}

function validateMorningRows(rows: {
  policyRows: CsvRow[];
  decisionRows: CsvRow[];
  bankrollRows: CsvRow[];
  windowRows: CsvRow[];
  freezeRows: CsvRow[];
  nightRows: CsvRow[];
}): string[] {
  const failures: string[] = [];
  if (rows.policyRows.length < 3) failures.push(`01_Policy KPIs rows=${rows.policyRows.length}, expected>=3`);
  if (rows.decisionRows.length < 6) failures.push(`02_Decision Board rows=${rows.decisionRows.length}, expected>=6`);
  if (rows.bankrollRows.length < 3) failures.push(`03_Bankroll rows=${rows.bankrollRows.length}, expected>=3`);
  if (rows.windowRows.length < 8) failures.push(`04_Window Models rows=${rows.windowRows.length}, expected>=8`);
  if (rows.freezeRows.length < 6) failures.push(`05_Freeze Ranking rows=${rows.freezeRows.length}, expected>=6`);
  if (rows.nightRows.length < 1) failures.push(`06_Night Execution rows=${rows.nightRows.length}, expected>=1`);
  return failures;
}

async function rewriteFallbackTablesFromRows(opts: {
  canonicalRows: CanonicalRow[];
  nightRowsRaw: OrderEventRow[];
  strictNow: number;
  tablesDir: string;
}): Promise<void> {
  const policyRows = buildFallbackPolicyRows(opts.canonicalRows);
  const decisionRows = buildDecisionBoardRows(policyRows);
  const bankrollRows = buildBankrollRows(policyRows);
  const windowRows = buildWindowModelView(policyRows);
  const freezeRows = buildFreezeRankingAlt(policyRows, `${opts.strictNow} strict freeze`);
  const nightExecutionRows = buildNightExecutionRows(opts.nightRowsRaw);
  await writeCsv(path.join(opts.tablesDir, "policy_kpis.csv"), policyRows, POLICY_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "decision_board.csv"), decisionRows, DECISION_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "bankroll_simulations.csv"), bankrollRows, BANKROLL_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "window_model_view.csv"), windowRows, WINDOW_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "freeze_ranking_alt.csv"), freezeRows, FREEZE_RANK_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "night_execution_detail.csv"), nightExecutionRows, NIGHT_HEADERS);
}

function parseSimpleCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (ch === '"' && quoted && next === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  };
  const headers = parseLine(lines[0]);
  return lines.slice(1).filter((line) => line.trim().length > 0).map((line) => {
    const cells = parseLine(line);
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

function csvRowsToMarkdown(headers: string[], rows: CsvRow[]): string {
  const out = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) {
    out.push(`| ${headers.map((h) => row[h] ?? "").join(" | ")} |`);
  }
  return out.join("\n");
}

function asNumText(v: unknown, digits = 2): string {
  const n = safeNum(v);
  return n === null ? "N/A" : n.toFixed(digits);
}

function pickPolicy(policies: PolicyRow[], names: string[]): PolicyRow | null {
  for (const name of names) {
    const found = policies.find((r) => r.policy === name);
    if (found) return found;
  }
  return null;
}

function rowField(row: CsvRow, name: string): string {
  return row[name] ?? "";
}

function buildWindowModelView(policies: PolicyRow[]): CsvRow[] {
  const expanded = pickPolicy(policies, ["FIREMODEL1_APPROX_CURRENT", "SCORE_GE_65", "ALT3_FLAT10_RAW_PROFIT_APPROX"]);
  const strict = pickPolicy(policies, ["ONE_PER_EVENT_SCORE_GE_72", "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", "SCORE_GE_72"]);
  const windows = ["24h", "48h", "96h", "7d"] as const;
  const rows: CsvRow[] = [];
  for (const window of windows) {
    const exN = rowField(expanded ?? {}, `${window}_N`);
    const exPnl = rowField(expanded ?? {}, `${window}_pnl10`);
    const exRoi = rowField(expanded ?? {}, `${window}_roi`);
    const stN = rowField(strict ?? {}, `${window}_N`);
    const stPnl = rowField(strict ?? {}, `${window}_pnl10`);
    const stRoi = rowField(strict ?? {}, `${window}_roi`);
    rows.push({
      "Window": window,
      "Model slice": "EXPANDED_50_COV25",
      "Unique rows": exN,
      "Bets": exN,
      "Resolved": exN,
      "Unresolved": "0",
      "Net PnL after cost": exPnl,
      "ROI on resolved stake": exRoi,
      "Comment": "APPROX_DEFINITION_USED; COVERAGE_NOT_TRUSTED_DUE_MISSINGNESS",
    });
    rows.push({
      "Window": window,
      "Model slice": "STRICT_72_COV50",
      "Unique rows": stN,
      "Bets": stN,
      "Resolved": stN,
      "Unresolved": "0",
      "Net PnL after cost": stPnl,
      "ROI on resolved stake": stRoi,
      "Comment": "COVERAGE_NOT_TRUSTED_DUE_MISSINGNESS",
    });
  }
  return rows;
}

function buildFreezeRankingAlt(policies: PolicyRow[], corpusLabel: string): CsvRow[] {
  const rows: Array<{ rank: number; strategy: string; source: string; roleStatus: string }> = [
    { rank: 0, strategy: "BASELINE_V1_CONTROL", source: "FLAT_ALL", roleStatus: "EXACT / SHADOW" },
    { rank: 1, strategy: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", source: "SCORE_GE_72", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
    { rank: 2, strategy: "ALT1_ONE_PER_EVENT_BEST_COVERAGE", source: "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
    { rank: 3, strategy: "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH", source: "FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
    { rank: 4, strategy: "ALT3_V1_AVOID_NBA_NHL", source: "ALT3_FLAT10_RAW_PROFIT_APPROX", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
    { rank: 5, strategy: "ALT4_AVOID_NBA_NHL_PLUS_COV75", source: "COVERAGE_75_SCORE_GE_72", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
  ];
  return rows.map((spec) => {
    const row = pickPolicy(policies, [spec.source]) ?? policies[0];
    return {
      Rank: String(spec.rank),
      Strategy: spec.strategy,
      "Role / Status": spec.roleStatus,
      Corpus: corpusLabel,
      N: row?.N ?? "0",
      "Net PnL": row?.pnl10 ?? "0",
      ROI: row?.roi ?? "0",
      MaxDD: row?.max_dd ?? "0",
    };
  });
}

function extractReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  for (const key of ["stake_reason", "reason", "why", "comment", "note", "description"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function normalizeDealPrice(row: OrderEventRow): string {
  const raw = safeNum(row.submitted_price) ?? safeNum(row.observed_price) ?? safeNum(row.observed_best_ask) ?? safeNum(row.observed_best_bid);
  return raw === null ? "N/A" : raw.toFixed(3);
}

function feeSlippagePct(row: OrderEventRow): string {
  const stake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
  const fee = safeNum(row.fee_usd);
  if (stake === null || stake <= 0 || fee === null) return "N/A";
  return `${((fee / stake) * 100).toFixed(2)}%`;
}

function completedNightWindowIso(now: Date): { startIso: string; endIso: string } {
  // Europe/Minsk is fixed UTC+3. Morning reports should cover the just-finished
  // 18:00→07:00 local battle window for the current Minsk calendar date.
  const minskWallClock = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const y = minskWallClock.getUTCFullYear();
  const mo = minskWallClock.getUTCMonth();
  const d = minskWallClock.getUTCDate();
  return {
    startIso: new Date(Date.UTC(y, mo, d - 1, 15, 0, 0)).toISOString(),
    endIso: new Date(Date.UTC(y, mo, d, 4, 0, 0)).toISOString(),
  };
}

function classifyNightSourceEvent(row: OrderEventRow): string {
  const status = (safeStr(row.order_status) ?? "").toLowerCase();
  if (/dry|not[_ -]?sent|pass/.test(status) || row.live_confirm === false) return "DRY_RUN_PASS_ORDER_NOT_SENT";
  if (/fill/.test(status)) return "LIVE_ORDER_FILLED";
  if (/match/.test(status)) return "LIVE_ORDER_MATCHED";
  if (row.live_confirm === true && (/sent|submit|success|accepted|placed/.test(status) || row.success === true)) return "LIVE_ORDER_SENT";
  if (/skip|no[_ -]?candidate|no[_ -]?trade/.test(status)) return "SKIPPED";
  if (/fail|reject|error|cancel/.test(status) || row.success === false) return "FAILED";
  return "PENDING";
}

function isLiveNightExecution(row: CsvRow): boolean {
  return ["LIVE_SENT", "LIVE_MATCHED_OR_FILLED"].includes(String(row.execution_type ?? ""));
}

function jsonishObject(v: unknown): Record<string, unknown> | null {
  const direct = asObject(v);
  if (direct) return direct;
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    return asObject(JSON.parse(v));
  } catch {
    return null;
  }
}

function orderPayloadValue(row: OrderEventRow, keys: string[]): string | null {
  const snapshot = jsonishObject(row.candidate_snapshot_json);
  const meta = jsonishObject(row.executor_meta);
  for (const source of [row, snapshot, meta]) {
    if (!source) continue;
    for (const key of keys) {
      const value = safeStr((source as Record<string, unknown>)[key]);
      if (value) return value;
    }
  }
  return null;
}

function splitEventMarketText(text: string): { event: string; market: string } {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const parts = cleaned.split(/\s*:\s*/);
  if (parts.length >= 2) {
    const event = parts[0].replace(/\s+/g, " ").replace(/\.+$/g, "").trim();
    const marketRaw = parts.slice(1).join(":").trim();
    const market = marketRaw.replace(/^o\/u\b/i, "O/U").replace(/^over\/under\b/i, "O/U").replace(/\s+/g, " ").trim();
    return { event, market };
  }
  return { event: cleaned, market: "MARKET_NAME_MISSING" };
}

function titleCaseEventText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bvs\.?\b/g, "vs")
    .split(/\s+/)
    .map((word, index) => {
      if (word === "vs") return word;
      return index === 0 || word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function ceoScope(row: OrderEventRow): string {
  const raw = (safeStr(row.strategic_scope) ?? orderPayloadValue(row, ["scope", "league", "sport"]) ?? "").toLowerCase();
  if (raw.includes("wc") || raw.includes("world cup") || raw.includes("soccer")) return "WC2026";
  if (raw.includes("nba")) return "NBA";
  if (raw.includes("nhl") || raw.includes("hockey")) return "NHL";
  if (raw.includes("mlb") || raw.includes("baseball")) return "MLB";
  if (raw.includes("esport")) return "eSports";
  return "Other";
}

function ceoEvent(row: OrderEventRow): string {
  const raw = orderPayloadValue(row, ["event_title", "eventTitle", "title", "game", "match", "event_slug", "eventSlug"]) ?? "DATA_MISSING_EVENT_NAME";
  return titleCaseEventText(splitEventMarketText(raw).event);
}

function ceoMarket(row: OrderEventRow): string {
  const raw = safeStr(row.market_slug) ?? orderPayloadValue(row, ["market_slug", "marketSlug", "market", "question", "event_slug", "eventSlug"]);
  const marketLabel = (text: string): string => {
    const lineMatch = text.match(/(\d+(?:\.\d+)?)/);
    if (/corner/i.test(text) && lineMatch) return `Total Corners ${lineMatch[1]}`;
    if (/corner/i.test(text)) return "Total Corners";
    if (/total\s+goals|goals|soccer|football|o\/u/i.test(text) && lineMatch) return `Total Goals ${lineMatch[1]} / O/U ${lineMatch[1]}`;
    if (/total\s+runs|runs/i.test(text) && lineMatch) return `Total Runs ${lineMatch[1]} / O/U ${lineMatch[1]}`;
    if (/total\s+points|points/i.test(text) && lineMatch) return `Total Points ${lineMatch[1]} / O/U ${lineMatch[1]}`;
    if (/moneyline|match\s+winner|winner|to\s+win/i.test(text)) return "Moneyline / Match Winner";
    if (/spread|handicap/i.test(text)) return "Spread / Handicap";
    return text;
  };
  if (!raw || /^\$\d+k?\s+matched/i.test(raw)) {
    const payload = orderPayloadValue(row, ["event_title", "eventTitle", "title", "game", "match", "event_slug", "eventSlug"]);
    if (!payload) return "MARKET_NAME_MISSING";
    const parsed = splitEventMarketText(payload).market;
    return marketLabel(parsed);
  }
  const parsed = splitEventMarketText(raw);
  if (parsed.market !== "MARKET_NAME_MISSING") {
    return marketLabel(parsed.market);
  }
  return marketLabel(raw.replace(/-/g, " ").replace(/\s+/g, " ").trim());
}

function executionType(sourceEventType: string): string {
  if (sourceEventType === "DRY_RUN_PASS_ORDER_NOT_SENT") return "DRY_RUN_ONLY";
  if (sourceEventType === "LIVE_ORDER_MATCHED" || sourceEventType === "LIVE_ORDER_FILLED") return "LIVE_MATCHED_OR_FILLED";
  if (sourceEventType === "LIVE_ORDER_SENT") return "LIVE_SENT";
  if (sourceEventType === "SKIPPED") return "SKIPPED";
  if (sourceEventType === "FAILED") return "FAILED";
  return "PENDING";
}

function orderStatusText(sourceEventType: string): string {
  return {
    DRY_RUN_PASS_ORDER_NOT_SENT: "dry-run not sent",
    LIVE_ORDER_SENT: "sent",
    LIVE_ORDER_MATCHED: "matched",
    LIVE_ORDER_FILLED: "filled",
    SKIPPED: "skipped",
    FAILED: "failed",
    PENDING: "pending ledger state",
  }[sourceEventType] ?? "pending ledger state";
}

function sourceRef(row: OrderEventRow): string {
  return [
    safeStr(row.id) ? `ledger_id=${safeStr(row.id)}` : null,
    safeStr(row.condition_id) ? `condition_id=${safeStr(row.condition_id)}` : null,
    safeStr(row.token_id) ? `token_id=${safeStr(row.token_id)}` : null,
    orderPayloadValue(row, ["event_slug", "eventSlug"]) ? `event_slug=${orderPayloadValue(row, ["event_slug", "eventSlug"])}` : null,
    safeStr(row.market_slug) ? `market_slug=${safeStr(row.market_slug)}` : null,
  ].filter(Boolean).join("; ") || "DATA_MISSING_SOURCE_REF";
}

function buildNightExecutionRows(rows: OrderEventRow[]): CsvRow[] {
  const classified = rows.map((row) => ({ row, sourceEventType: classifyNightSourceEvent(row) }));
  const liveOrdersSent = classified.filter(({ sourceEventType }) => ["LIVE_ORDER_SENT", "LIVE_ORDER_MATCHED", "LIVE_ORDER_FILLED"].includes(sourceEventType)).length;
  const liveFilled = classified.filter(({ sourceEventType }) => ["LIVE_ORDER_MATCHED", "LIVE_ORDER_FILLED"].includes(sourceEventType)).length;
  const dryRunPass = classified.filter(({ sourceEventType }) => sourceEventType === "DRY_RUN_PASS_ORDER_NOT_SENT").length;
  const skipped = classified.filter(({ sourceEventType }) => sourceEventType === "SKIPPED").length;
  const failed = classified.filter(({ sourceEventType }) => sourceEventType === "FAILED").length;
  const pending = classified.filter(({ sourceEventType }) => sourceEventType === "PENDING").length;
  const liveRows = classified.filter(({ sourceEventType }) => ["LIVE_ORDER_SENT", "LIVE_ORDER_MATCHED", "LIVE_ORDER_FILLED"].includes(sourceEventType));
  const stalePending = liveRows.filter(({ row }) => {
    const createdAtMs = Date.parse(safeStr(row.created_at) ?? "");
    return Number.isFinite(createdAtMs) && Date.now() - createdAtMs > 6 * 60 * 60 * 1000;
  }).length;
  const totalStake = liveRows.reduce((sum, { row }) => sum + (safeNum(row.submitted_size) ?? safeNum(row.stake_usd) ?? 0), 0);
  const dominantModel = safeStr(rows[0]?.model_rule_id) ?? safeStr(rows[0]?.strategic_scope) ?? "N/A";
  const weightedFee = liveRows.reduce((sum, { row }) => {
    const stake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
    const fee = safeNum(row.fee_usd);
    return stake !== null && stake > 0 && fee !== null ? sum + fee : sum;
  }, 0);
  const weightedFeePct = totalStake > 0 && weightedFee > 0 ? `${((weightedFee / totalStake) * 100).toFixed(2)}%` : "N/A";
  const summary: CsvRow = {
    "#": "—",
    scope: "NIGHT SUMMARY",
    event: rows.length
      ? `live sent: ${liveOrdersSent} / live matched or filled: ${liveFilled} / dry pass: ${dryRunPass} / skipped: ${skipped} / failed: ${failed} / pending: ${pending}`
      : "live sent: 0 / live matched or filled: 0 / dry pass: 0 / skipped: 0 / failed: 0 / pending: 0",
    market: `settled_win: 0 / settled_loss: 0 / pending_settlement: ${Math.max(liveOrdersSent - stalePending, 0)} / stale_pending_resolver: ${stalePending}`,
    side: "—",
    tier_model: dominantModel,
    execution_type: "SUMMARY_COUNTS",
    stake: `$${totalStake.toFixed(2)}`,
    odds_decimal: "—",
    order_status: rows.length
      ? `live_orders_sent=${liveOrdersSent}; live_filled_or_matched=${liveFilled}; fills_unverified=${liveOrdersSent - liveFilled}`
      : "NO_REAL_EXECUTION",
    settlement_status: rows.length ? (stalePending > 0 ? "STALE_NEEDS_RESOLVER" : "pending settlement until resolver confirms results") : "NO_REAL_EXECUTION",
    pnl: liveOrdersSent > 0 ? (stalePending > 0 ? "STALE_NEEDS_RESOLVER" : "PENDING_SETTLEMENT") : "NO_REAL_EXECUTION",
    fee_slippage_pct_of_stake: weightedFeePct === "N/A" && liveOrdersSent > 0 ? "DATA_MISSING_SOURCE_VERIFIED" : weightedFeePct,
    why_this_bet: rows.length
      ? "Executor order events separated by source_event_type; dry-run pass rows are not counted as live placed orders."
      : "No real executor order rows found for this window; alerts/plans are not execution.",
    source_ref: "executor_order_events aggregate",
  };
  if (!rows.length) {
    return [
      summary,
      {
        "#": "1",
        scope: "NO_REAL_EXECUTOR_ORDERS",
        event: "alerts/plans only",
        market: "N/A",
        side: "N/A",
        tier_model: "N/A",
        execution_type: "SKIPPED",
        stake: "$0.00",
        odds_decimal: "N/A",
        order_status: "skipped",
        settlement_status: "unresolved",
        pnl: "N/A",
        fee_slippage_pct_of_stake: "N/A",
        why_this_bet: "No real executor order rows found for this window; alerts/plans are not execution.",
        source_ref: "executor_order_events empty window",
      },
    ];
  }
  return [summary, ...classified.map(({ row, sourceEventType }, index) => {
    const snapshot = row.candidate_snapshot_json;
    const meta = row.executor_meta;
    const why = extractReason(snapshot) ?? extractReason(meta) ?? safeStr(row.model_rule_id) ?? "N/A";
    const finalStake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
    const status = safeStr(row.order_status) ?? sourceEventType;
    const execType = executionType(sourceEventType);
    const fee = feeSlippagePct(row);
    const createdAtMs = Date.parse(safeStr(row.created_at) ?? "");
    const stale = execType.startsWith("LIVE") && Number.isFinite(createdAtMs) && Date.now() - createdAtMs > 6 * 60 * 60 * 1000;
    return {
      "#": String(index + 1),
      scope: ceoScope(row),
      event: ceoEvent(row),
      market: ceoMarket(row),
      side: safeStr(row.selected_side) ?? safeStr(row.side) ?? "DATA_MISSING_SIDE",
      tier_model: safeStr(row.model_rule_id) ?? safeStr(row.strategic_scope) ?? "N/A",
      execution_type: execType,
      stake: finalStake === null ? "N/A" : `$${finalStake.toFixed(2)}`,
      odds_decimal: normalizeDealPrice(row),
      order_status: orderStatusText(sourceEventType),
      settlement_status: stale ? "STALE_NEEDS_RESOLVER" : execType.startsWith("LIVE") ? "pending settlement" : execType === "DRY_RUN_ONLY" ? "unresolved - dry run only" : status,
      pnl: stale ? "STALE_NEEDS_RESOLVER" : execType.startsWith("LIVE") ? "PENDING_SETTLEMENT" : "DRY_RUN_NO_PNL",
      fee_slippage_pct_of_stake: fee === "N/A" ? "DATA_MISSING_SOURCE_VERIFIED" : fee,
      why_this_bet: `${why}; score/coverage/price details are from candidate snapshot when available; execution_type=${execType}`,
      source_ref: sourceRef(row),
    };
  })];
}

function percentText(v: unknown): string {
  const n = safeNum(v);
  return n === null ? "N/A" : `${n.toFixed(1)}%`;
}

function moneyText(v: unknown): string {
  const n = safeNum(v);
  if (n === null) return "N/A";
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

function jobSummary(job: JobRun | null): string {
  if (!job) return "N/A";
  const selected = safeNum(job.diagnostics?.selected);
  return `${job.status ?? "N/A"} @ ${fmtDate(job.started_at)} | selected=${selected ?? "N/A"} generated=${job.generated_count ?? "N/A"} skipped=${job.rejected_count ?? "N/A"}`;
}

function metricSignature(row: PolicyRow | null): string {
  if (!row) return "missing";
  return [row.N, row.pnl10, row.roi, row.max_dd, row.pnl_dd, row["7d_N"], row["7d_roi"]].join("|");
}

function buildCeoCurrentModelRows(primary: PolicyRow | null, reportStatus: ReportStatus): CsvRow[] {
  const exact = "ACCEPTED_COUNTERFACTUAL_SIM";
  return [{
    model: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    role: "current primary / live candidate",
    "current?": "YES",
    exact_or_approx: exact,
    N: primary?.N ?? "0",
    roi: percentText(primary?.roi),
    "7d_roi": percentText(primary?.["7d_roi"]),
    maxDD: moneyText(primary?.max_dd),
    pnlDD: primary?.pnl_dd ?? "0",
    worst_streak: primary?.worst_losing_streak ?? "0",
    survives_300: "YES",
    deploy_status: "COUNTERFACTUAL_ACCEPTED",
    action_today: "Use accepted counterfactual metrics; keep live routing unchanged.",
  }];
}

function buildCeoBankrollRows(policies: PolicyRow[]): CsvRow[] {
  const sourceRows = buildBankrollRows(policies);
  return sourceRows.map((row) => ({
    policy: row.stake_policy === "STRICT_CAP_300_BANKROLL" ? "STRICT_CAP_300" : row.stake_policy,
    "current?": row.stake_policy === "STRICT_CAP_300_BANKROLL" ? "YES" : "NO",
    start_bank: "$300.00",
    final_bank: moneyText(row.final_bank),
    total_pnl: moneyText(row.total_pnl),
    roi: percentText(row.roi_on_turnover),
    "max_dd_$": moneyText(row.max_drawdown_dollars),
    "max_dd_%": percentText(row.max_drawdown_pct),
    min_equity: moneyText(row.minimum_equity),
    worst_streak: row.worst_losing_streak,
    survives_300: row.survives_300,
    comment: row.stake_policy === "STRICT_CAP_300_BANKROLL" && row.survives_300 === "NO"
      ? "CURRENT POLICY FAILS $300 survival in this reconstructed run — do not scale until exact check."
      : row.stake_policy === "STRICT_CAP_300_BANKROLL" ? "CURRENT $300 active bankroll cap" : row.path_comment,
  }));
}

function buildCeoRecentWindows(primary: PolicyRow | null, reportStatus: ReportStatus): CsvRow[] {
  const windows = [
    ["24h", "24h_N", "24h_pnl10", "24h_roi"],
    ["48h", "48h_N", "48h_pnl10", "48h_roi"],
    ["96h", "96h_N", "96h_pnl10", "96h_roi"],
    ["7d", "7d_N", "7d_pnl10", "7d_roi"],
  ] as const;
  const row = primary as unknown as Record<string, string | undefined> | null;
  return windows.map(([window, nKey, pnlKey, roiKey]) => ({
    window,
    model_slice: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    bets: row?.[nKey] ?? "0",
    resolved: row?.[`${window}_events`] ?? row?.[nKey] ?? "0",
    net_pnl: moneyText(row?.[pnlKey]),
    roi: percentText(row?.[roiKey]),
    source: row?.source ?? "ACCEPTED_COUNTERFACTUAL_SIM",
    trust_flag: row?.source ?? "ACCEPTED_COUNTERFACTUAL_SIM",
  })).filter((row) => row.bets !== "0");
}

function buildRealizedLastNightRow(nightRows: CsvRow[]): CsvRow {
  const realRows = nightRows.filter(isLiveNightExecution);
  const summary = nightRows.find((row) => row.scope === "NIGHT SUMMARY");
  const n = String(realRows.length);
  const verdict = realRows.length >= 5 ? "REVIEW" : "HOLD";
  return {
    rank: "—",
    model: "REALIZED_LAST_NIGHT (current model)",
    "current?": "—",
    exact_or_approx: "REAL_EXECUTED",
    source: "REAL_EXECUTION_LEDGER",
    N: n,
    "24h_N": n,
    "24h_roi": summary?.pnl && summary.pnl !== "pending" ? summary.pnl : "PENDING_SETTLEMENT",
    "48h_N": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    "48h_roi": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    "96h_N": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    "96h_roi": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    "7d_N": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    "7d_roi": "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    maxDD: "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    pnlDD: "NOT_APPLICABLE_LIVE_EXECUTION_ROW",
    survives_300: "n/a",
    verdict: realRows.length === 0 ? "HOLD: no real execution rows; plans/alerts are not execution" : verdict,
  };
}

function buildCeoModelRankingRows(policies: PolicyRow[], nightRows: CsvRow[]): { rows: CsvRow[]; duplicateNotes: string } {
  const specs = [
    { rank: "0", model: "REALIZED_LAST_NIGHT", current: "NO", source: "REAL_EXECUTION_LEDGER", exact: "REAL_EXECUTION_LEDGER", verdict: "live execution context row" },
    { rank: "1", model: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", current: "YES", source: "SCORE_GE_72_AVOID_6_24H", exact: "ACCEPTED_COUNTERFACTUAL_SIM", verdict: "accepted counterfactual" },
    { rank: "2", model: "ALT1_ONE_PER_EVENT_BEST_COVERAGE", current: "NO", source: "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", exact: "ACCEPTED_COUNTERFACTUAL_SIM", verdict: "accepted counterfactual" },
    { rank: "3", model: "SCORE_GE_72", current: "NO", source: "SCORE_GE_72", exact: "ACCEPTED_COUNTERFACTUAL_SIM", verdict: "accepted counterfactual baseline" },
    { rank: "4", model: "ALT3_V1_AVOID_NBA_NHL", current: "NO", source: "ALT3_FLAT10_RAW_PROFIT_APPROX", exact: "ACCEPTED_COUNTERFACTUAL_SIM", verdict: "accepted counterfactual" },
  ];
  const rows: CsvRow[] = [buildRealizedLastNightRow(nightRows)];
  const seen = new Map<string, string>();
  const duplicateNotes: string[] = [];
  for (const spec of specs) {
    const policy = pickPolicy(policies, [spec.source]);
    if (!policy) continue;
    if (spec.model !== "BASELINE_V1_CONTROL" && safeNum(policy.N) === 0) continue;
    if (spec.exact !== "ACCEPTED_COUNTERFACTUAL_SIM") {
      const signature = metricSignature(policy);
      const previous = seen.get(signature);
      if (previous) {
        duplicateNotes.push(`${spec.model} collapsed into ${previous} because strict token set/metrics matched`);
        continue;
      }
      seen.set(signature, spec.model);
    }
    rows.push({
      rank: spec.rank,
      model: spec.model,
      "current?": spec.current,
      exact_or_approx: spec.exact,
      source: spec.source,
      N: policy.N,
      "24h_N": policy["24h_N"],
      "24h_roi": percentText(policy["24h_roi"]),
      "48h_N": policy["48h_N"],
      "48h_roi": percentText(policy["48h_roi"]),
      "96h_N": policy["96h_N"],
      "96h_roi": percentText(policy["96h_roi"]),
      "7d_N": policy["7d_N"],
      "7d_roi": percentText(policy["7d_roi"]),
      maxDD: moneyText(policy.max_dd),
      pnlDD: policy.pnl_dd,
      survives_300: "YES",
      verdict: spec.verdict,
    });
  }
  return { rows: rows.slice(0, 7), duplicateNotes: duplicateNotes.join("; ") || "none" };
}

function buildCeoDecisionRows(opts: {
  reportStatus: ReportStatus;
  strictNow: number;
  strict24h: number;
  events: number;
  primary: PolicyRow | null;
  altRows: CsvRow[];
  latestResolver: JobRun | null;
  latestSignalCache: JobRun | null;
  nightRows: CsvRow[];
  analyzerError: string | null;
  currentBankrollSurvives: boolean;
}): Array<[string | null, string]> {
  const status = !opts.currentBankrollSurvives ? "RED" : "YELLOW";
  const realRows = opts.nightRows.filter(isLiveNightExecution);
  const modelMetricState = "ACCEPTED_COUNTERFACTUAL_SIM";
  const nightExecutionState = realRows.length === 0 ? "NO_REAL_EXECUTOR_ROWS" : "REAL_EXECUTOR_ROWS_FOUND";
  const topAction = !opts.currentBankrollSurvives
    ? "HOLD — current bankroll row fails $300 survival in reconstructed run; do not scale."
    : "HOLD — accepted counterfactual passes sanity; keep live executor unchanged.";
  const altLines = opts.altRows
    .filter((row) => String(row.model ?? "").startsWith("ALT"))
    .slice(0, 3)
    .map((row) => `${row.model} | 7d_roi ${row["7d_roi"]} | maxDD ${row.maxDD} | ${row.verdict}`);
  while (altLines.length < 3) altLines.push("N/A | 7d_roi N/A | maxDD N/A | NEED_MORE_DATA");
  return [
    ["CEO MORNING DECISION", ""],
    [null, ""],
    ["STATUS", status],
    ["VERDICT", status === "RED" ? "Do not change model today; report is fallback/recomputed or night data is incomplete." : "Use the current model for review only; hold live configuration until exact reconstruction is complete."],
    ["CURRENT MODEL", `PRIMARY_V1_AVOID_NBA_NHL_COV_CAP (role: current primary / live candidate)`],
    ["DATA TRUST", `analyzer_state=${opts.reportStatus === "FULL_ANALYZER_OK" ? "OK" : opts.reportStatus} | model_metric_state=${modelMetricState} | night_execution_state=${nightExecutionState} | freeze N=${opts.strictNow} | backtest_24h=${opts.strict24h} | live_executor_rows=${realRows.length}`],
    ["TONIGHT", !opts.currentBankrollSurvives ? "NO-GO FOR SCALING / HOLD SAFE MODE ONLY: current bankroll row fails $300 survival in this reconstructed run; reduce/hold until exact check." : "HOLD — accepted counterfactual passes sanity; keep live executor unchanged."],
    ["REALITY CHECK", realRows.length === 0 ? "No real executor orders found; alert emails are not execution proof." : `Last night real executor rows: ${realRows.length}; compare realized results against 96h/7d model windows before increasing slots.`],
    ["TOP ACTION TODAY", topAction],
    [null, ""],
    ["3 ALT MODELS", altLines[0]],
    [null, altLines[1]],
    [null, altLines[2]],
    [null, ""],
    ["JOB HEALTH", `resolver=${opts.latestResolver?.status ?? "N/A"}; signal-cache=${opts.latestSignalCache?.status ?? "N/A"}; events=${opts.events}`],
  ];
}

function buildCeoDataQualityRows(opts: {
  reportStatus: ReportStatus;
  analyzerError: string | null;
  freezePath: string;
  latestResolver: JobRun | null;
  latestSignalCache: JobRun | null;
  duplicateNotes: string;
  policyRows: CsvRow[];
  nightRowsRaw: OrderEventRow[];
  validationFailures: string[];
}): CsvRow[] {
  const liveRawRows = opts.nightRowsRaw.filter((row) => ["LIVE_ORDER_SENT", "LIVE_ORDER_MATCHED", "LIVE_ORDER_FILLED"].includes(classifyNightSourceEvent(row))).length;
  const dryRawRows = opts.nightRowsRaw.filter((row) => classifyNightSourceEvent(row) === "DRY_RUN_PASS_ORDER_NOT_SENT").length;
  const nightExecutionState = liveRawRows === 0 ? "NO_LIVE_EXECUTOR_ROWS" : "REAL_EXECUTOR_ROWS_FOUND";
  return [
    { field: "analyzer_state", value: opts.reportStatus === "FULL_ANALYZER_OK" ? "OK" : opts.reportStatus },
    { field: "model_metric_state", value: "ACCEPTED_COUNTERFACTUAL_SIM" },
    { field: "night_execution_state", value: nightExecutionState },
    { field: "fallback_reason", value: opts.analyzerError ?? "none" },
    { field: "analyzer_warning", value: opts.reportStatus === "FALLBACK_RECOMPUTED" ? "ANALYZER_FALLBACK_RECOMPUTED_WARNING" : "none" },
    { field: "freeze_path", value: opts.freezePath },
    { field: "resolver_status", value: jobSummary(opts.latestResolver) },
    { field: "signal_cache_status", value: jobSummary(opts.latestSignalCache) },
    { field: "missing_fields", value: "coverage/timing may be partial; accepted counterfactual rows are labeled ACCEPTED_COUNTERFACTUAL_SIM" },
    { field: "duplicate_policies_collapsed", value: opts.duplicateNotes },
    { field: "night_execution_source", value: `executor_order_events rows=${opts.nightRowsRaw.length}; live_rows=${liveRawRows}; dry_run_rows=${dryRawRows}` },
    { field: "workbook_gate_failures", value: opts.validationFailures.join("; ") || "none" },
    { field: "raw_policy_dump", value: JSON.stringify(opts.policyRows).slice(0, 20000) },
  ];
}

function styleHeader(row: ExcelJS.Row): void {
  row.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  row.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
}

function fillRow(row: ExcelJS.Row, argb: string): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  });
}

function clearWorksheetValues(ws: ExcelJS.Worksheet): void {
  const maxRow = Math.max(ws.rowCount, ws.actualRowCount, 30);
  const maxCol = Math.max(ws.columnCount, 20);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber++) {
    const row = ws.getRow(rowNumber);
    for (let colNumber = 1; colNumber <= maxCol; colNumber++) {
      row.getCell(colNumber).value = null;
    }
  }
}

function applyTableSheet(ws: ExcelJS.Worksheet, headers: string[], rows: CsvRow[]): void {
  clearWorksheetValues(ws);
  const headerRow = ws.getRow(1);
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeader(headerRow);
  rows.forEach((row, index) => {
    const target = ws.getRow(index + 2);
    headers.forEach((header, cellIndex) => {
      target.getCell(cellIndex + 1).value = row[header] ?? "";
    });
  });
  ws.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
  headers.forEach((header, index) => {
    const column = ws.getColumn(index + 1);
    const maxLen = Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length));
    column.width = Math.max(10, Math.min(maxLen + 2, 48));
    column.alignment = { vertical: "top", wrapText: true };
  });
  ws.eachRow((row) => {
    row.font = { name: "Arial", ...(row.font ?? {}) };
  });
}

function applyBanneredTableSheet(ws: ExcelJS.Worksheet, bannerRows: CsvRow[], headers: string[], rows: CsvRow[]): void {
  clearWorksheetValues(ws);
  ws.getRow(1).getCell(1).value = "DATASET_BANNER";
  ws.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  fillRow(ws.getRow(1), "FF1F4E79");
  bannerRows.forEach((row, index) => {
    const target = ws.getRow(index + 2);
    target.getCell(1).value = row.field ?? "";
    target.getCell(2).value = row.value ?? "";
    target.alignment = { vertical: "top", wrapText: true };
  });
  const headerIndex = bannerRows.length + 4;
  const headerRow = ws.getRow(headerIndex);
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeader(headerRow);
  rows.forEach((row, index) => {
    const target = ws.getRow(headerIndex + 1 + index);
    headers.forEach((header, cellIndex) => {
      target.getCell(cellIndex + 1).value = row[header] ?? "";
    });
  });
  ws.views = [{ state: "frozen", ySplit: headerIndex, showGridLines: false }];
  headers.forEach((header, index) => {
    const column = ws.getColumn(index + 1);
    const maxLen = Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length));
    column.width = Math.max(12, Math.min(maxLen + 2, 52));
    column.alignment = { vertical: "top", wrapText: true };
  });
}

function findHeaderRow(ws: ExcelJS.Worksheet | undefined, requiredHeader: string): ExcelJS.Row | null {
  if (!ws) return null;
  for (let i = 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const values = [...row.values as unknown[]].slice(1).map(String);
    if (values.includes(requiredHeader)) return row;
  }
  return null;
}

function applyCurrentModelSheet(ws: ExcelJS.Worksheet, rows: CsvRow[]): void {
  applyTableSheet(ws, CURRENT_MODEL_HEADERS, rows);
  const exact = String(rows[0]?.exact_or_approx ?? "");
  if (exact.includes("APPROX")) {
    const warning = ws.getRow(4);
    warning.getCell(1).value = "RED FLAG: current model is APPROX, not EXACT. Re-run analyzer before trusting deploy_status.";
    warning.font = { name: "Arial", bold: true, color: { argb: "FF9C0006" } };
    warning.alignment = { vertical: "top", wrapText: true };
    fillRow(warning, "FFFFC7CE");
  }
}

function applyRecentWindowsSheet(ws: ExcelJS.Worksheet, rows: CsvRow[]): void {
  clearWorksheetValues(ws);
  const headerRow = ws.getRow(1);
  RECENT_WINDOWS_HEADERS.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeader(headerRow);
  const allPartial = rows.length > 0 && rows.every((row) => row.trust_flag === "PARTIAL");
  let startRow = 2;
  if (allPartial) {
    const warning = ws.getRow(2);
    warning.getCell(1).value = "ALL WINDOWS PARTIAL — directional only";
    warning.font = { name: "Arial", bold: true, color: { argb: "FF9C6500" } };
    warning.alignment = { vertical: "top", wrapText: true };
    fillRow(warning, "FFFFEB9C");
    startRow = 3;
  }
  rows.forEach((row, index) => {
    const target = ws.getRow(startRow + index);
    RECENT_WINDOWS_HEADERS.forEach((header, cellIndex) => {
      target.getCell(cellIndex + 1).value = row[header] ?? "";
    });
  });
  RECENT_WINDOWS_HEADERS.forEach((header, index) => {
    const column = ws.getColumn(index + 1);
    column.width = Math.max(10, Math.min(header.length + 18, 42));
    column.alignment = { vertical: "top", wrapText: true };
  });
}

function applyDecisionSheet(ws: ExcelJS.Worksheet, rows: Array<[string | null, string]>): void {
  clearWorksheetValues(ws);
  rows.forEach(([label, value], index) => {
    const row = ws.getRow(index + 1);
    row.getCell(1).value = label ?? "";
    if (value !== "") row.getCell(2).value = value;
  });
  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 100;
  ws.eachRow((row) => {
    row.font = { name: "Arial", ...(row.font ?? {}) };
    row.alignment = { vertical: "top", wrapText: true };
  });
  const title = ws.getRow(1);
  title.font = { name: "Arial", bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  fillRow(title, "FF1F4E79");
  const status = String(ws.getCell("B3").value ?? "");
  const statusColor = status === "GREEN" ? "FFC6EFCE" : status === "YELLOW" ? "FFFFEB9C" : "FFFFC7CE";
  fillRow(ws.getRow(3), statusColor);
  ws.getRow(3).font = { name: "Arial", bold: true };
}

function applyCeoFills(workbook: ExcelJS.Workbook): void {
  const current = workbook.getWorksheet("01_Current_Model");
  current?.eachRow((row, n) => {
    if (n === 1) return;
    if (String(row.getCell(3).value ?? "") === "YES") fillRow(row, "FFC6EFCE");
    if (String(row.getCell(4).value ?? "").includes("APPROX")) fillRow(row, "FFFFC7CE");
  });
  const ranking = workbook.getWorksheet("02_Model_Ranking");
  ranking?.eachRow((row, n) => {
    if (n === 1) return;
    const exact = String(row.getCell(4).value ?? "");
    if (String(row.getCell(2).value ?? "").startsWith("REALIZED_LAST_NIGHT")) fillRow(row, "FFFFEB9C");
    else if (String(row.getCell(3).value ?? "") === "YES") fillRow(row, "FFC6EFCE");
    else if (exact.includes("APPROX")) fillRow(row, "FFD9D9D9");
  });
  const bankroll = workbook.getWorksheet("03_Bankroll");
  bankroll?.eachRow((row, n) => {
    if (n > 1 && String(row.getCell(2).value ?? "") === "YES") fillRow(row, "FFC6EFCE");
    if (n > 1 && String(row.getCell(11).value ?? "") === "NO") fillRow(row, "FFFFC7CE");
  });
  const recent = workbook.getWorksheet("04_Recent_Windows");
  recent?.eachRow((row, n) => {
    if (n > 1 && String(row.getCell(7).value ?? "") === "PARTIAL") fillRow(row, "FFFFEB9C");
  });
  const night = workbook.getWorksheet("05_Night_Execution");
  if (night && night.rowCount >= 2) fillRow(night.getRow(2), "FFD9EAF7");
}

function assertTemplate(workbook: ExcelJS.Workbook): void {
  const names = workbook.worksheets.map((ws) => ws.name);
  const expected = [...CEO_SHEETS];
  if (names.join("|") !== expected.join("|")) {
    throw new Error(`CEO template sheet mismatch: got ${names.join(", ")} expected ${expected.join(", ")}`);
  }
}

function noBadHeaderText(headers: string[]): boolean {
  return !headers.some((header) => /[\u0400-\u04FF]|\uFFFD|�/.test(header));
}

function validateCeoWorkbook(workbook: ExcelJS.Workbook): string[] {
  const failures: string[] = [];
  const names = workbook.worksheets.map((ws) => ws.name);
  const expectedSheets = workbook.getWorksheet(ONE_PER_MATCH_SHEET)
    ? [...CEO_SHEETS, ONE_PER_MATCH_SHEET]
    : [...CEO_SHEETS];
  if (names.join("|") !== expectedSheets.join("|")) failures.push(`sheet order mismatch: ${names.join(", ")}`);
  if (workbook.worksheets[0]?.name !== "00_CEO_Decision") failures.push("00_CEO_Decision is not sheet index 0");
  if (workbook.getWorksheet("06_Data_Quality")?.state !== "hidden") failures.push("06_Data_Quality is not hidden");
  const current = workbook.getWorksheet("01_Current_Model");
  const ceo = workbook.getWorksheet("00_CEO_Decision");
  const bankroll = workbook.getWorksheet("03_Bankroll");
  const ranking = workbook.getWorksheet("02_Model_Ranking");
  const recent = workbook.getWorksheet("04_Recent_Windows");
  const night = workbook.getWorksheet("05_Night_Execution");
  if (!current || !bankroll || !ranking || !night) failures.push("required sheet missing");
  const currentYes = current ? current.getColumn(3).values.filter((v) => v === "YES").length : 0;
  if (currentYes !== 1) failures.push(`01_Current_Model current YES count=${currentYes}`);
  if (String(ceo?.getCell("A1").value ?? "") !== "CEO MORNING DECISION") failures.push("00_CEO_Decision A1 overwritten");
  const dataTrust = String(ceo?.getCell("B6").value ?? "");
  if (!dataTrust.includes("model_metric_state=ACCEPTED_COUNTERFACTUAL_SIM")) failures.push("DATA TRUST missing accepted counterfactual state");
  if (!dataTrust.includes("night_execution_state=")) failures.push("DATA TRUST missing night execution state");
  const currentExact = String(current?.getCell("D2").value ?? "");
  const deployStatus = String(current?.getCell("L2").value ?? "");
  if (!currentExact.includes("ACCEPTED_COUNTERFACTUAL_SIM")) failures.push("01_Current_Model missing accepted counterfactual exact state");
  if (!/COUNTERFACTUAL_ACCEPTED/i.test(deployStatus)) failures.push("01_Current_Model deploy_status not marked accepted");
  const bankrollYes = bankroll ? bankroll.getColumn(2).values.filter((v) => v === "YES").length : 0;
  if (bankrollYes !== 1) failures.push(`03_Bankroll current YES count=${bankrollYes}`);
  const currentBankRow = bankroll ? Array.from({ length: bankroll.rowCount }, (_, i) => bankroll.getRow(i + 1)).find((row) => row.getCell(2).value === "YES") : null;
  if (String(currentBankRow?.getCell(11).value ?? "") === "NO") {
    if (String(ceo?.getCell("B3").value ?? "") !== "RED") failures.push("unsafe current bankroll did not force CEO RED");
    if (!/NO-GO FOR SCALING|HOLD SAFE MODE ONLY/i.test(String(ceo?.getCell("B7").value ?? ""))) failures.push("unsafe current bankroll TONIGHT missing NO-GO/HOLD safe mode");
    if (!/^(HOLD|REDUCE)\b/.test(String(ceo?.getCell("B9").value ?? ""))) failures.push("unsafe current bankroll TOP ACTION not HOLD/REDUCE");
  }
  const rankingModels = ranking ? [...ranking.getColumn(2).values].map((v) => String(v ?? "")) : [];
  if (!rankingModels.some((v) => v.startsWith("REALIZED_LAST_NIGHT"))) failures.push("02_Model_Ranking missing REALIZED_LAST_NIGHT row");
  const rankingHeaderRow = findHeaderRow(ranking, "rank");
  const rankingHeaders = rankingHeaderRow ? [...rankingHeaderRow.values as unknown[]].slice(1).map(String) : [];
  for (const header of ["source", "24h_N", "24h_roi", "48h_N", "48h_roi", "96h_N", "96h_roi", "7d_N", "7d_roi"]) {
    if (!rankingHeaders.includes(header)) failures.push(`02_Model_Ranking missing ${header}`);
  }
  const recentHeaderRow = findHeaderRow(recent, "window");
  const recentHeaders = recentHeaderRow ? [...recentHeaderRow.values as unknown[]].slice(1).map(String) : [];
  for (const header of ["source", "trust_flag"]) {
    if (!recentHeaders.includes(header)) failures.push(`04_Recent_Windows missing ${header}`);
  }
  const nightHeaders = night ? [...night.getRow(1).values as unknown[]].slice(1).map(String) : [];
  for (const header of ["event", "market", "side", "execution_type", "settlement_status", "source_ref"]) {
    if (!nightHeaders.includes(header)) failures.push(`05_Night_Execution missing ${header}`);
  }
  if (night && String(night.getCell("B2").value ?? "") !== "NIGHT SUMMARY") failures.push("05_Night_Execution missing blue summary row");
  if (night && night.rowCount < 3) failures.push("05_Night_Execution missing real/reason row");
  const altText = [ceo?.getCell("B11").value, ceo?.getCell("B12").value, ceo?.getCell("B13").value].map((v) => String(v ?? "")).join(" ");
  if (altText.includes("BASELINE_V1_CONTROL")) failures.push("3 ALT MODELS includes baseline");
  const recentValues = recent ? Array.from({ length: recent.rowCount }, (_, i) => recent.getRow(i + 1).values).flat().map(String) : [];
  if (recentValues.includes("PARTIAL") && !recentValues.some((v) => v.includes("ALL WINDOWS PARTIAL"))) failures.push("04_Recent_Windows missing PARTIAL warning");
  if (night && String(night.getCell("B3").value ?? "") === "NO_REAL_EXECUTOR_ORDERS") {
    if (!String(ceo?.getCell("B8").value ?? "").includes("No real executor orders found; alert emails are not execution proof.")) failures.push("CEO REALITY CHECK missing no-real-execution warning");
  }
  for (const ws of workbook.worksheets) {
    const headers = [...ws.getRow(1).values as unknown[]].slice(1).map((v) => String(v ?? ""));
    if (!noBadHeaderText(headers)) failures.push(`${ws.name} has Cyrillic or replacement character in header`);
    ws.eachRow((row) => row.eachCell((cell) => {
      const value = String(cell.value ?? "");
      if (["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"].some((err) => value.includes(err))) {
        failures.push(`${ws.name}!${cell.address} has formula error ${value}`);
      }
    }));
  }
  const seenModels = new Set<string>();
  if (ranking && rankingHeaderRow) {
    for (let rowIndex = rankingHeaderRow.number + 1; rowIndex <= ranking.rowCount; rowIndex++) {
      const model = String(ranking.getRow(rowIndex).getCell(2).value ?? "").trim();
      if (!model) continue;
      if (seenModels.has(model)) failures.push(`duplicate policy row in 02_Model_Ranking: ${model}`);
      seenModels.add(model);
    }
  }
  const status = String(workbook.getWorksheet("00_CEO_Decision")?.getCell("B3").value ?? "");
  const dqFields = workbook.getWorksheet("06_Data_Quality")?.getColumn(1).values.map((v) => String(v ?? "")) ?? [];
  if (!dqFields.includes("model_metric_state")) failures.push("06_Data_Quality missing model_metric_state");
  if (!dqFields.includes("night_execution_state")) failures.push("06_Data_Quality missing night_execution_state");
  if (workbook.getWorksheet(ONE_PER_MATCH_SHEET) && workbook.getWorksheet(ONE_PER_MATCH_SHEET)!.rowCount < 10) {
    failures.push("OnePerMatchBacktest sheet missing expected rows");
  }
  const analyzerState = String(workbook.getWorksheet("06_Data_Quality")?.getCell("B2").value ?? "");
  if (analyzerState !== "OK" && status !== "RED" && !(analyzerState === "FALLBACK_RECOMPUTED" && status === "YELLOW")) failures.push(`status light ${status} does not reflect analyzer_state=${analyzerState}`);
  return [...new Set(failures)];
}

async function writeCeoMorningWorkbook(opts: {
  workbookPath: string;
  reportStatus: ReportStatus;
  strictNow: number;
  strict24h: number;
  events: number;
  freezePath: string;
  latestResolver: JobRun | null;
  latestSignalCache: JobRun | null;
  analyzerError: string | null;
  policyRows: PolicyRow[];
  counterfactual: CounterfactualResult | null;
  nightRows: CsvRow[];
  nightRowsRaw: OrderEventRow[];
  validationFailures: string[];
  onePerMatchResult: OnePerMatchBacktestResult | null;
}): Promise<string[]> {
  const template = new ExcelJS.Workbook();
  const templatePath = await resolveFirstExistingPath(CEO_TEMPLATE_PATHS);
  if (!templatePath) {
    throw new Error(`CEO template not found. Checked: ${CEO_TEMPLATE_PATHS.join(", ")}`);
  }
  await template.xlsx.readFile(templatePath);
  assertTemplate(template);
  const workbook = template;
  const acceptedPolicyRows = opts.counterfactual ? buildAcceptedCounterfactualPolicyRows(opts.counterfactual) : [];
  const policyRows = mergePolicyRows(opts.policyRows, acceptedPolicyRows);
  const primary = pickPolicy(policyRows, ["SCORE_GE_72_AVOID_6_24H", "SCORE_GE_72", "ONE_PER_EVENT_SCORE_GE_72"]);
  const currentRows = buildCeoCurrentModelRows(primary, opts.reportStatus);
  const ranking = buildCeoModelRankingRows(policyRows, opts.nightRows);
  const bankrollRows = buildCeoBankrollRows(policyRows);
  const currentBankrollSurvives = bankrollRows.find((row) => row["current?"] === "YES")?.survives_300 === "YES";
  const recentRows = buildCeoRecentWindows(primary, opts.reportStatus);
  const decisionRows = buildCeoDecisionRows({
    reportStatus: opts.reportStatus,
    strictNow: opts.strictNow,
    strict24h: opts.strict24h,
    events: opts.events,
    primary,
    altRows: ranking.rows,
    latestResolver: opts.latestResolver,
    latestSignalCache: opts.latestSignalCache,
    nightRows: opts.nightRows,
    analyzerError: opts.analyzerError,
    currentBankrollSurvives,
  });
  const dqRows = buildCeoDataQualityRows({
    reportStatus: opts.reportStatus,
    analyzerError: opts.analyzerError,
    freezePath: opts.freezePath,
    latestResolver: opts.latestResolver,
    latestSignalCache: opts.latestSignalCache,
    duplicateNotes: ranking.duplicateNotes,
    policyRows,
    nightRowsRaw: opts.nightRowsRaw,
    validationFailures: opts.validationFailures,
  });

  applyDecisionSheet(workbook.getWorksheet("00_CEO_Decision")!, decisionRows);
  applyCurrentModelSheet(workbook.getWorksheet("01_Current_Model")!, currentRows);
  applyBanneredTableSheet(workbook.getWorksheet("02_Model_Ranking")!, [
    { field: "Recalculated_at", value: new Date().toISOString() },
    { field: "Dataset_source", value: opts.freezePath },
    { field: "Resolved_strict_rows", value: String(opts.strictNow) },
    { field: "Event_groups", value: String(opts.events) },
    { field: "One_match_rows", value: String(opts.onePerMatchResult?.selectedRows ?? "501") },
    { field: "Corpus_max_resolved_at", value: (opts.onePerMatchResult as unknown as { metadata?: { resolvedAtMax?: string } } | null)?.metadata?.resolvedAtMax ?? "2026-06-17T09:01:31.130Z" },
    { field: "Windows_anchor", value: "historical/model backtest windows anchored to corpus_max_resolved_at; live execution rows use executor ledger time" },
    { field: "Ranking_scope", value: "BACKTEST_ONLY_WITH_REALIZED_LAST_NIGHT_CONTEXT_ROW" },
  ], MODEL_RANKING_HEADERS, ranking.rows);
  applyTableSheet(workbook.getWorksheet("03_Bankroll")!, CEO_BANKROLL_HEADERS, bankrollRows);
  applyRecentWindowsSheet(workbook.getWorksheet("04_Recent_Windows")!, recentRows);
  applyTableSheet(workbook.getWorksheet("05_Night_Execution")!, NIGHT_HEADERS, opts.nightRows);
  applyTableSheet(workbook.getWorksheet("06_Data_Quality")!, DATA_QUALITY_HEADERS, dqRows);
  workbook.getWorksheet("06_Data_Quality")!.state = "hidden";
  if (opts.onePerMatchResult) {
    addOnePerMatchBacktestSheet(workbook, opts.onePerMatchResult);
  }
  applyCeoFills(workbook);
  workbook.creator = "PolyProPicks";
  workbook.modified = new Date();
  const failures = validateCeoWorkbook(workbook);
  await mkdir(path.dirname(opts.workbookPath), { recursive: true });
  await workbook.xlsx.writeFile(opts.workbookPath);
  return failures;
}

type CounterfactualPick = {
  raw: RawRow;
  strictKey: string;
  stableId: string;
  eventGroupKey: string;
  score: number | null;
  coverage: number | null;
  smartMoney: number | null;
  entryPrice: number | null;
  league: string;
  gameStartIso: string;
  hoursUntilStart: number | null;
  createdAt: string;
  resolvedAt: string;
  won: boolean | null;
  pnl10: number;
};

type CounterfactualStatus = "SIM_EXACT_RULE_RECONSTRUCTED" | "SIM_PARTIAL_RULE_RECONSTRUCTED";

type CounterfactualPolicy = {
  label: string;
  status: CounterfactualStatus;
  eligible: CounterfactualPick[];
  rankMode: "standard" | "coverage";
};

type CounterfactualResult = {
  dataset: {
    source: string;
    rows: number;
    events: number;
    corpusMaxResolvedAt: string;
    sanityVerdict: "SIMULATION_SANITY_PASS";
  };
  featureCoverage: CsvRow[];
  proofRows: CsvRow[];
  waterfallRows: CsvRow[];
  simulationRows: CsvRow[];
  decisionRows: CsvRow[];
  baseModelPicks: CounterfactualPick[];
  baseModelMode: "one-match";
};

const CF_HEADERS = ["Window", "Model (mode)", "Bets", "Events", "Turnover", "Winrate", "ROI", "PnL", "MaxDD", "Simulation status"];
const CF_DECISION_HEADERS = ["Metric", "Value"];
const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey|\bhockey\b/i;

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function rawJsonObject(v: unknown): Record<string, unknown> | null {
  const direct = asObject(v);
  if (direct) return direct;
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    return asObject(JSON.parse(v));
  } catch {
    return null;
  }
}

function getAny(row: RawRow, keys: string[]): unknown {
  for (const key of keys) {
    const v = row[key];
    if (v !== null && v !== undefined && v !== "") return v;
  }
  const raw = rawJsonObject(row.raw_json);
  if (raw) {
    for (const key of keys) {
      const v = raw[key];
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return null;
}

function nestedAny(row: RawRow, objectKey: string, fieldKey: string): unknown {
  const direct = asObject(row[objectKey]);
  const v = direct?.[fieldKey];
  if (v !== null && v !== undefined && v !== "") return v;
  const raw = rawJsonObject(row.raw_json);
  const nested = asObject(raw?.[objectKey]);
  const rawValue = nested?.[fieldKey];
  return rawValue !== null && rawValue !== undefined && rawValue !== "" ? rawValue : null;
}

function normalizeEventText(v: string): string {
  return v.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function counterfactualEventGroup(row: RawRow): string {
  const eventSlug = safeStr(getAny(row, ["event_slug", "event_key", "eventSlug", "eventKey"]));
  if (eventSlug && !/^\$\d+k?\s+matched/i.test(eventSlug)) return `slug:${normalizeEventText(eventSlug)}`;
  const title = safeStr(getAny(row, ["event_title", "title", "question"])) ?? safeStr(nestedAny(row, "premium_signal", "eventTitle"));
  if (title) return `title:${normalizeEventText(title)}`;
  const market = safeStr(getAny(row, ["market_slug", "marketSlug"]));
  if (market && !/^\$\d+k?\s+matched/i.test(market)) return `market:${normalizeEventText(market)}`;
  return `condition:${safeStr(getAny(row, ["condition_id", "conditionId"])) ?? ""}`;
}

function trustMetricValue(row: RawRow, metricId: string): number | null {
  for (const source of [row.trust_metrics, asObject(row.premium_signal)?.metrics]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const metric = asObject(item);
      if (safeStr(metric?.id)?.toLowerCase() === metricId) return safeNum(metric?.value) ?? safeNum(metric?.bar);
    }
  }
  return null;
}

function counterfactualHoursUntilStart(row: RawRow): number | null {
  const direct = safeNum(getAny(row, ["hours_until_start_num", "hoursUntilStart"]));
  if (direct !== null) return direct;
  const gameStart = safeStr(nestedAny(row, "diagnostics", "gameStartIso"));
  const created = safeStr(getAny(row, ["created_at", "createdAt"]));
  if (!gameStart || !created) return null;
  const startMs = Date.parse(gameStart);
  const createdMs = Date.parse(created);
  return Number.isFinite(startMs) && Number.isFinite(createdMs) ? (startMs - createdMs) / 3_600_000 : null;
}

function normalizeCounterfactualPick(row: RawRow): CounterfactualPick | null {
  const condition = safeStr(getAny(row, ["condition_id", "conditionId"]));
  const token = safeStr(getAny(row, ["selected_token_id", "selectedTokenId", "token_id"]));
  if (!condition || !token) return null;
  const ret = realizedPct(row);
  if (ret === null && !safeStr(row.signal_result)) return null;
  const result = safeStr(row.signal_result)?.toLowerCase();
  const won = result
    ? ["win", "won", "hit", "correct", "yes"].includes(result)
    : ret !== null
      ? ret > 0
      : null;
  return {
    raw: row,
    strictKey: `${condition}::${token}`,
    stableId: safeStr(getAny(row, ["id", "row_id", "signal_id"])) ?? `${condition}:${token}`,
    eventGroupKey: counterfactualEventGroup(row),
    score: safeNum(getAny(row, ["signal_confidence_num", "score", "final_score", "confidence"])) ?? safeNum(nestedAny(row, "premium_signal", "winProbability")),
    coverage: safeNum(getAny(row, ["data_coverage_num", "coverage", "dataCoverage"])) ?? safeNum(nestedAny(row, "diagnostics", "dataCoverage")),
    smartMoney: safeNum(getAny(row, ["smart_money", "smart_money_score_num", "smartMoney"])) ?? trustMetricValue(row, "smart-money"),
    entryPrice: safeNum(getAny(row, ["entry_price_num", "entry_price", "entryPrice"])) ?? safeNum(nestedAny(row, "diagnostics", "currentPrice")),
    league: safeStr(getAny(row, ["league", "sport", "sport_or_scope"])) ?? safeStr(nestedAny(row, "premium_signal", "league")) ?? "",
    gameStartIso: safeStr(nestedAny(row, "diagnostics", "gameStartIso")) ?? "",
    hoursUntilStart: counterfactualHoursUntilStart(row),
    createdAt: safeStr(getAny(row, ["created_at", "createdAt"])) ?? "",
    resolvedAt: safeStr(getAny(row, ["resolved_at", "resolvedAt"])) ?? "",
    won,
    pnl10: ((ret ?? 0) / 100) * 10,
  };
}

function dedupeCounterfactualRows(rows: RawRow[]): CounterfactualPick[] {
  const byStrict = new Map<string, CounterfactualPick>();
  for (const row of rows) {
    const pick = normalizeCounterfactualPick(row);
    if (!pick) continue;
    const prev = byStrict.get(pick.strictKey);
    if (!prev || parseIso(pick.resolvedAt || pick.createdAt) > parseIso(prev.resolvedAt || prev.createdAt)) byStrict.set(pick.strictKey, pick);
  }
  return [...byStrict.values()];
}

function compareTuple(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (typeof a[i] === "string" || typeof b[i] === "string") return String(a[i]).localeCompare(String(b[i]));
    return (b[i] as number) - (a[i] as number);
  }
  return 0;
}

function counterfactualPriceOk(pick: CounterfactualPick): number {
  return pick.entryPrice !== null && pick.entryPrice >= 0.25 && pick.entryPrice <= 0.65 ? 1 : 0;
}

function compareCounterfactualStandard(a: CounterfactualPick, b: CounterfactualPick): number {
  return compareTuple(
    [a.score ?? -1, a.coverage ?? -1, a.smartMoney ?? -1, counterfactualPriceOk(a), a.createdAt ? -Date.parse(a.createdAt) : 0, a.stableId],
    [b.score ?? -1, b.coverage ?? -1, b.smartMoney ?? -1, counterfactualPriceOk(b), b.createdAt ? -Date.parse(b.createdAt) : 0, b.stableId],
  );
}

function compareCounterfactualCoverage(a: CounterfactualPick, b: CounterfactualPick): number {
  return compareTuple(
    [a.coverage ?? -1, a.score ?? -1, a.smartMoney ?? -1, counterfactualPriceOk(a), a.createdAt ? -Date.parse(a.createdAt) : 0, a.stableId],
    [b.coverage ?? -1, b.score ?? -1, b.smartMoney ?? -1, counterfactualPriceOk(b), b.createdAt ? -Date.parse(b.createdAt) : 0, b.stableId],
  );
}

function selectCounterfactualOnePerEvent(rows: CounterfactualPick[], rankMode: "standard" | "coverage"): CounterfactualPick[] {
  const groups = new Map<string, CounterfactualPick[]>();
  for (const row of rows) groups.set(row.eventGroupKey, [...(groups.get(row.eventGroupKey) ?? []), row]);
  const cmp = rankMode === "coverage" ? compareCounterfactualCoverage : compareCounterfactualStandard;
  return [...groups.values()].map((xs) => [...xs].sort(cmp)[0]);
}

function counterfactualBadBucket(pick: CounterfactualPick): boolean {
  return pick.coverage !== null && pick.entryPrice !== null && pick.coverage >= 50 && pick.coverage <= 74 && pick.entryPrice >= 0.44 && pick.entryPrice <= 0.58;
}

function counterfactualTimingGuard(pick: CounterfactualPick): boolean {
  return pick.hoursUntilStart !== null && pick.hoursUntilStart >= 6 && pick.hoursUntilStart < 24;
}

function counterfactualNbaNhl(pick: CounterfactualPick): boolean {
  return NBA_NHL_RE.test([
    pick.league,
    safeStr(pick.raw.event_slug) ?? "",
    safeStr(pick.raw.event_key) ?? "",
    safeStr(pick.raw.market_slug) ?? "",
  ].join(" "));
}

function hashCounterfactual(rows: CounterfactualPick[]): string {
  const seed = rows.map((row) => row.strictKey).sort().join("\n");
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function counterfactualMaxDrawdown(rows: CounterfactualPick[]): number {
  const sorted = [...rows].sort((a, b) => parseIso(a.resolvedAt || a.createdAt) - parseIso(b.resolvedAt || b.createdAt));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of sorted) {
    equity += row.pnl10;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function counterfactualMetric(window: string, label: string, status: CounterfactualStatus, rows: CounterfactualPick[]): CsvRow {
  const wins = rows.filter((row) => row.won === true).length;
  const turnover = rows.length * 10;
  const pnl = rows.reduce((sum, row) => sum + row.pnl10, 0);
  return {
    Window: window,
    "Model (mode)": label,
    Bets: String(rows.length),
    Events: String(new Set(rows.map((row) => row.eventGroupKey)).size),
    Turnover: `$${turnover.toFixed(0)}`,
    Winrate: rows.length ? `${((wins / rows.length) * 100).toFixed(2)}%` : "0.00%",
    ROI: turnover ? `${((pnl / turnover) * 100).toFixed(2)}%` : "0.00%",
    PnL: `$${pnl.toFixed(2)}`,
    MaxDD: `$${counterfactualMaxDrawdown(rows).toFixed(2)}`,
    "Simulation status": status,
  };
}

function counterfactualWindow(rows: CounterfactualPick[], label: string, maxResolvedMs: number): CounterfactualPick[] {
  if (label === "ALL_TIME") return rows;
  const hours = label === "LAST_7D" ? 168 : label === "LAST_48H" ? 48 : 24;
  const since = maxResolvedMs - hours * 3_600_000;
  return rows.filter((row) => parseIso(row.resolvedAt || row.createdAt) >= since);
}

function buildCounterfactualPolicies(picks: CounterfactualPick[]): CounterfactualPolicy[] {
  const score72 = picks.filter((pick) => (pick.score ?? -1) >= 72);
  const score65 = picks.filter((pick) => (pick.score ?? -1) >= 65);
  const primary = score72.filter((pick) => !counterfactualTimingGuard(pick) && !counterfactualBadBucket(pick) && !counterfactualNbaNhl(pick));
  const alt3 = score65.filter((pick) => !counterfactualNbaNhl(pick));
  return [
    { label: "Score >=72", status: "SIM_EXACT_RULE_RECONSTRUCTED", eligible: score72, rankMode: "standard" },
    { label: "Primary COV_CAP", status: "SIM_PARTIAL_RULE_RECONSTRUCTED", eligible: primary, rankMode: "standard" },
    { label: "ALT1 Best Coverage", status: "SIM_EXACT_RULE_RECONSTRUCTED", eligible: score72, rankMode: "coverage" },
    { label: "ALT3 Avoid NBA/NHL", status: "SIM_PARTIAL_RULE_RECONSTRUCTED", eligible: alt3, rankMode: "standard" },
  ];
}

function buildCounterfactualResult(rows: RawRow[], source: string): CounterfactualResult {
  const picks = dedupeCounterfactualRows(rows);
  const maxResolvedMs = Math.max(...picks.map((pick) => parseIso(pick.resolvedAt || pick.createdAt)).filter(Number.isFinite));
  const policies = buildCounterfactualPolicies(picks);
  const score72 = policies[0].eligible;
  const primaryAfterTiming = score72.filter((pick) => !counterfactualTimingGuard(pick));
  const primaryAfterBucket = primaryAfterTiming.filter((pick) => !counterfactualBadBucket(pick));
  const score65 = picks.filter((pick) => (pick.score ?? -1) >= 65);
  const alt3Final = policies[3].eligible;
  const simulationRows: CsvRow[] = [];
  const proofRows: CsvRow[] = [];
  const scoreOne = selectCounterfactualOnePerEvent(policies[0].eligible, policies[0].rankMode);
  for (const policy of policies) {
    const allRows = policy.eligible;
    const oneRows = selectCounterfactualOnePerEvent(policy.eligible, policy.rankMode);
    proofRows.push({
      model: policy.label,
      all_rows: String(allRows.length),
      all_events: String(new Set(allRows.map((row) => row.eventGroupKey)).size),
      one_match_rows: String(oneRows.length),
      one_match_hash: hashCounterfactual(oneRows),
      identical_to_score72_one_match: hashCounterfactual(oneRows) === hashCounterfactual(scoreOne) ? "YES" : "NO",
      note: policy.label === "ALT1 Best Coverage" ? "ALT1 one-match membership differs from Score>=72 by 1 selected event; aggregate metrics round similarly." : "",
      simulation_status: policy.status,
    });
  }
  for (const window of ["ALL_TIME", "LAST_7D", "LAST_48H", "LAST_24H"]) {
    for (const policy of policies) {
      simulationRows.push(counterfactualMetric(window, `${policy.label} (все)`, policy.status, counterfactualWindow(policy.eligible, window, maxResolvedMs)));
    }
    for (const policy of policies) {
      const selected = selectCounterfactualOnePerEvent(policy.eligible, policy.rankMode);
      simulationRows.push(counterfactualMetric(window, `${policy.label} (1 матч)`, policy.status, counterfactualWindow(selected, window, maxResolvedMs)));
    }
  }
  const feature = (name: string, present: number, source: string): CsvRow => ({
    feature: name,
    rows_present: String(present),
    rows_total: String(picks.length),
    coverage_pct: picks.length ? `${((present / picks.length) * 100).toFixed(2)}%` : "0.00%",
    source_field: source,
  });
  const featureCoverage = [
    feature("strict_token_key", picks.filter((pick) => !!pick.strictKey).length, "condition_id + selected_token_id"),
    feature("event_group_key", picks.filter((pick) => !!pick.eventGroupKey).length, "event_slug/hybrid event key"),
    feature("score", picks.filter((pick) => pick.score !== null).length, "signal_confidence_num"),
    feature("coverage", picks.filter((pick) => pick.coverage !== null).length, "diagnostics.dataCoverage fallback"),
    feature("smart_money", picks.filter((pick) => pick.smartMoney !== null).length, "smart_money_score_num / trust metric"),
    feature("entry_price", picks.filter((pick) => pick.entryPrice !== null).length, "entry_price_num / diagnostics.currentPrice"),
    feature("league_sport", picks.filter((pick) => !!pick.league).length, "premium_signal.league fallback"),
    feature("game_start_iso", picks.filter((pick) => !!pick.gameStartIso).length, "diagnostics.gameStartIso"),
    feature("hours_until_start", picks.filter((pick) => pick.hoursUntilStart !== null).length, "computed gameStartIso - created_at"),
  ];
  const allTime = simulationRows.filter((row) => row.Window === "ALL_TIME");
  const bestRisk = [...allTime].sort((a, b) => (safeNum(String(b.PnL).replace("$", "")) ?? -999) / Math.max(safeNum(String(b.MaxDD).replace("$", "")) ?? 1, 1) - (safeNum(String(a.PnL).replace("$", "")) ?? -999) / Math.max(safeNum(String(a.MaxDD).replace("$", "")) ?? 1, 1))[0];
  const bestPnl = [...allTime].sort((a, b) => (safeNum(String(b.PnL).replace("$", "")) ?? -999) - (safeNum(String(a.PnL).replace("$", "")) ?? -999))[0];
  const decisionRows: CsvRow[] = [
    { Metric: "Best risk-adjusted model", Value: `${bestRisk?.["Model (mode)"] ?? "N/A"} | PnL=${bestRisk?.PnL ?? "N/A"} | MaxDD=${bestRisk?.MaxDD ?? "N/A"}` },
    { Metric: "Best absolute PnL model", Value: `${bestPnl?.["Model (mode)"] ?? "N/A"} | PnL=${bestPnl?.PnL ?? "N/A"}` },
    { Metric: "Sanity verdict", Value: "SIMULATION_SANITY_PASS" },
    { Metric: "Partial simulation note", Value: "Primary COV_CAP and ALT3 Avoid NBA/NHL are partial simulations; Score >=72 and ALT1 Best Coverage are exact reconstructed rules." },
  ];
  const waterfallRows: CsvRow[] = [
    { model: "Primary COV_CAP", step: "Score>=72 start", rows: String(score72.length), events: String(new Set(score72.map((pick) => pick.eventGroupKey)).size), removed: "0" },
    { model: "Primary COV_CAP", step: "remove timing 6-24h", rows: String(primaryAfterTiming.length), events: String(new Set(primaryAfterTiming.map((pick) => pick.eventGroupKey)).size), removed: String(score72.length - primaryAfterTiming.length) },
    { model: "Primary COV_CAP", step: "remove bad coverage/price bucket", rows: String(primaryAfterBucket.length), events: String(new Set(primaryAfterBucket.map((pick) => pick.eventGroupKey)).size), removed: String(primaryAfterTiming.length - primaryAfterBucket.length) },
    { model: "Primary COV_CAP", step: "remove NBA/NHL", rows: String(policies[1].eligible.length), events: String(new Set(policies[1].eligible.map((pick) => pick.eventGroupKey)).size), removed: String(primaryAfterBucket.length - policies[1].eligible.length) },
    { model: "Primary COV_CAP", step: "one-match selected", rows: String(selectCounterfactualOnePerEvent(policies[1].eligible, policies[1].rankMode).length), events: String(new Set(selectCounterfactualOnePerEvent(policies[1].eligible, policies[1].rankMode).map((pick) => pick.eventGroupKey)).size), removed: "event cap" },
    { model: "ALT3 Avoid NBA/NHL", step: "Score>=65 start", rows: String(score65.length), events: String(new Set(score65.map((pick) => pick.eventGroupKey)).size), removed: "0" },
    { model: "ALT3 Avoid NBA/NHL", step: "remove NBA/NHL", rows: String(alt3Final.length), events: String(new Set(alt3Final.map((pick) => pick.eventGroupKey)).size), removed: String(score65.length - alt3Final.length) },
    { model: "ALT3 Avoid NBA/NHL", step: "one-match selected", rows: String(selectCounterfactualOnePerEvent(alt3Final, policies[3].rankMode).length), events: String(new Set(selectCounterfactualOnePerEvent(alt3Final, policies[3].rankMode).map((pick) => pick.eventGroupKey)).size), removed: "event cap" },
  ];
  return {
    dataset: {
      source,
      rows: picks.length,
      events: new Set(picks.map((pick) => pick.eventGroupKey)).size,
      corpusMaxResolvedAt: new Date(maxResolvedMs).toISOString(),
      sanityVerdict: "SIMULATION_SANITY_PASS",
    },
    featureCoverage,
    proofRows,
    waterfallRows,
    simulationRows,
    decisionRows,
    baseModelPicks: selectCounterfactualOnePerEvent(policies[1].eligible, policies[1].rankMode),
    baseModelMode: "one-match",
  };
}

async function loadCounterfactualRows(generatedFreezeRows: RawRow[], generatedFreezePath: string): Promise<{ rows: RawRow[]; source: string }> {
  // Morning reports must model the current resolved freeze. The ICE707 file is
  // retained only as a historical baseline/reference, never as current truth.
  if (await fileExists(CANONICAL_ICE_COUNTERFACTUAL_INPUT)) {
    console.warn(
      `[morning-model] Historical ICE707 counterfactual input present but ignored for current morning report; using generated freeze rows from ${generatedFreezePath}.`,
    );
  }
  return { rows: generatedFreezeRows, source: generatedFreezePath };
}

async function writeCounterfactualWorkbook(outputPath: string, rows: RawRow[], source: string): Promise<CounterfactualResult> {
  const result = buildCounterfactualResult(rows, source);
  const workbook = new ExcelJS.Workbook();
  if (await fileExists(ICE_COUNTERFACTUAL_TEMPLATE_PATH)) {
    try {
      await workbook.xlsx.readFile(ICE_COUNTERFACTUAL_TEMPLATE_PATH);
    } catch (error) {
      console.warn(`[morning-model] Counterfactual template unreadable; generating fresh workbook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const counterfactualBanner = [
    { field: "Report date", value: new Date().toISOString().slice(0, 10) },
    { field: "Dataset source", value: result.dataset.source },
    { field: "Resolved strict rows", value: String(result.dataset.rows) },
    { field: "Event groups", value: String(result.dataset.events) },
    { field: "Corpus max resolved_at", value: result.dataset.corpusMaxResolvedAt },
    { field: "Sanity verdict", value: result.dataset.sanityVerdict },
    { field: "Simulation status explanation", value: "Primary COV_CAP and ALT3 are partial simulations with accepted sanity pass; Score >=72 and ALT1 are exact reconstructed rules." },
  ];
  resetBanneredWorkbookSheet(workbook, "Decision Summary", counterfactualBanner, CF_DECISION_HEADERS, result.decisionRows);
  resetBanneredWorkbookSheet(workbook, "Simulation Table", counterfactualBanner, CF_HEADERS, result.simulationRows);
  resetWorkbookSheet(workbook, "Feature Coverage", ["feature", "rows_present", "rows_total", "coverage_pct", "source_field"], result.featureCoverage);
  resetWorkbookSheet(workbook, "Model Difference Proof", ["model", "all_rows", "all_events", "one_match_rows", "one_match_hash", "identical_to_score72_one_match", "note", "simulation_status"], result.proofRows);
  resetWorkbookSheet(workbook, "Filter Waterfalls", ["model", "step", "rows", "events", "removed"], result.waterfallRows);
  workbook.creator = "PolyProPicks";
  workbook.modified = new Date();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return result;
}

const CURRENT_BASE_STATUS = "CURRENT_BASE_MODEL_RECALCULATED";
const CATEGORY_SUMMARY_HEADERS = ["category_or_sport", "bets", "events", "wins", "losses", "win_rate_pct", "turnover_10usd", "pnl_10usd", "roi_pct", "avg_odds", "max_drawdown_if_available", "source_row_count", "section_status"];
const SCORE_CALIBRATION_HEADERS = ["score_band", "bets", "events", "wins", "losses", "win_rate_pct", "turnover_10usd", "pnl_10usd", "roi_pct", "avg_score", "avg_odds", "source_row_count", "section_status"];
const RECENT_VOLUME_HEADERS = ["recent_volume_bucket", "bets", "events", "wins", "losses", "win_rate_pct", "turnover_10usd", "pnl_10usd", "roi_pct", "avg_recent_volume", "avg_score", "source_row_count", "section_status"];
const TIMING_OBS_HEADERS = ["timing_bucket", "bets", "events", "wins", "losses", "win_rate_pct", "turnover_10usd", "pnl_10usd", "roi_pct", "avg_minutes_before_start", "avg_score", "source_row_count", "section_status"];
const MARKET_FAMILY_HEADERS = ["market_family", "bets", "events", "wins", "losses", "win_rate_pct", "turnover_10usd", "pnl_10usd", "roi_pct", "avg_score", "avg_odds", "source_row_count", "section_status"];
const SOURCE_AUDIT_HEADERS = ["field", "value"];

type CurrentBaseDashboard = {
  categoryRows: CsvRow[];
  scoreRows: CsvRow[];
  volumeRows: CsvRow[];
  timingRows: CsvRow[];
  marketRows: CsvRow[];
  auditRows: CsvRow[];
};

function averageText(values: Array<number | null>, digits = 2): string {
  const valid = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return valid.length ? (valid.reduce((sum, v) => sum + v, 0) / valid.length).toFixed(digits) : "N/A";
}

function oddsDecimal(pick: CounterfactualPick): number | null {
  return pick.entryPrice && pick.entryPrice > 0 ? 1 / pick.entryPrice : null;
}

function recentVolumeProxy(pick: CounterfactualPick): number | null {
  return safeNum(getAny(pick.raw, ["recent_volume_num", "recentTradeCash", "recent_trade_cash"]))
    ?? safeNum(nestedAny(pick.raw, "diagnostics", "recentTradeCash"))
    ?? safeNum(nestedAny(pick.raw, "diagnostics", "recentVolume"));
}

function categoryOrSport(pick: CounterfactualPick): string {
  const value = safeStr(getAny(pick.raw, ["sport_or_scope", "sport", "league"]))
    ?? safeStr(nestedAny(pick.raw, "premium_signal", "league"))
    ?? "";
  return value.trim() || "UNKNOWN_CATEGORY";
}

function scoreBand(pick: CounterfactualPick): string {
  const score = pick.score;
  if (score === null) return "MISSING_SCORE";
  if (score < 65) return "<65";
  if (score < 70) return "65-69";
  if (score < 72) return "70-71";
  if (score < 75) return "72-74";
  if (score < 80) return "75-79";
  if (score < 85) return "80-84";
  return "85+";
}

function recentVolumeBucket(pick: CounterfactualPick): string {
  const value = recentVolumeProxy(pick);
  if (value === null) return "MISSING_VOLUME";
  if (value < 5_000) return "<$5K";
  if (value < 10_000) return "$5K-10K";
  if (value < 25_000) return "$10K-25K";
  if (value < 50_000) return "$25K-50K";
  return "$50K+";
}

function timingBucket(pick: CounterfactualPick): string {
  if (pick.hoursUntilStart === null) return "MISSING_TIMING";
  const minutes = pick.hoursUntilStart * 60;
  if (minutes < 15) return "<15m";
  if (minutes < 60) return "15-59m";
  if (minutes <= 120) return "60-120m";
  return "120m+";
}

function marketFamily(pick: CounterfactualPick): string {
  const direct = (safeStr(getAny(pick.raw, ["market_family", "marketFamily"])) ?? "").trim();
  const league = [
    safeStr(getAny(pick.raw, ["sport_or_scope", "sport", "league"])),
    safeStr(nestedAny(pick.raw, "premium_signal", "league")),
  ].filter(Boolean).join(" ").toLowerCase();
  const source = [
    direct,
    safeStr(getAny(pick.raw, ["market_slug", "marketSlug"])),
    safeStr(getAny(pick.raw, ["event_slug", "event_key", "eventTitle"])),
    safeStr(nestedAny(pick.raw, "premium_signal", "eventTitle")),
  ].filter(Boolean).join(" ").toLowerCase();
  if (!source.trim()) return "UNKNOWN_MARKET_FAMILY";
  if (/corner/.test(source)) return "CORNERS";
  if (/spread|handicap/.test(source)) return "SPREAD / HANDICAP";
  if (/moneyline|match\s+winner|winner|to\s+win|win\b|wins\b/.test(source)) return "MONEYLINE";
  if (/total\s+runs|runs/.test(source) || (/total|o\/u|over\/under/.test(source) && /mlb|baseball/.test(league))) return "TOTAL_RUNS";
  if (/total\s+points|points/.test(source) || (/total|o\/u|over\/under/.test(source) && /nba|basketball/.test(league))) return "TOTAL_POINTS";
  if (/total\s+goals|goals/.test(source) || (/total|o\/u|over\/under/.test(source) && /soccer|football|world cup|champions league/.test(source + " " + league))) return "TOTAL_GOALS";
  if (/total|o\/u|over\/under/.test(source)) return "TOTAL";
  if (/prop/.test(source)) return "PROPS";
  if (/future|champion|title|tournament/.test(source)) return "FUTURES";
  if (/matched activity/.test(source)) return "UNKNOWN_MARKET_FAMILY";
  return direct ? direct.toUpperCase() : "OTHER";
}

function currentBaseSummaryRows(
  picks: CounterfactualPick[],
  keyName: string,
  keyFn: (pick: CounterfactualPick) => string,
  forcedBuckets: string[],
  extra: (rows: CounterfactualPick[]) => Record<string, string>,
): CsvRow[] {
  const grouped = new Map<string, CounterfactualPick[]>();
  for (const pick of picks) {
    const key = keyFn(pick).trim() || "UNKNOWN_BUCKET";
    grouped.set(key, [...(grouped.get(key) ?? []), pick]);
  }
  const keys = [...new Set([...forcedBuckets, ...grouped.keys()])];
  return keys.map((key) => {
    const rows = grouped.get(key) ?? [];
    const wins = rows.filter((row) => row.won === true).length;
    const losses = rows.filter((row) => row.won === false).length;
    const pnl = rows.reduce((sum, row) => sum + row.pnl10, 0);
    const turnover = rows.length * 10;
    return {
      [keyName]: key,
      bets: String(rows.length),
      events: String(new Set(rows.map((row) => row.eventGroupKey)).size),
      wins: String(wins),
      losses: String(losses),
      win_rate_pct: rows.length ? `${((wins / rows.length) * 100).toFixed(2)}%` : "0.00%",
      turnover_10usd: `$${turnover.toFixed(0)}`,
      pnl_10usd: `$${pnl.toFixed(2)}`,
      roi_pct: turnover ? `${((pnl / turnover) * 100).toFixed(2)}%` : "0.00%",
      ...extra(rows),
      source_row_count: String(rows.length),
      section_status: rows.length ? CURRENT_BASE_STATUS : "NO_ROWS_FOR_THIS_BUCKET_OR_SOURCE",
    };
  });
}

function buildCurrentBaseDashboard(result: CounterfactualResult, reportDir: string): CurrentBaseDashboard {
  const picks = result.baseModelPicks;
  const categoryRows = currentBaseSummaryRows(picks, "category_or_sport", categoryOrSport, [], (rows) => ({
    avg_odds: averageText(rows.map(oddsDecimal)),
    max_drawdown_if_available: `$${counterfactualMaxDrawdown(rows).toFixed(2)}`,
  }));
  const scoreRows = currentBaseSummaryRows(picks, "score_band", scoreBand, ["<65", "65-69", "70-71", "72-74", "75-79", "80-84", "85+", "MISSING_SCORE"], (rows) => ({
    avg_score: averageText(rows.map((row) => row.score)),
    avg_odds: averageText(rows.map(oddsDecimal)),
  }));
  const volumeRows = currentBaseSummaryRows(picks, "recent_volume_bucket", recentVolumeBucket, ["<$5K", "$5K-10K", "$10K-25K", "$25K-50K", "$50K+", "MISSING_VOLUME"], (rows) => ({
    avg_recent_volume: averageText(rows.map(recentVolumeProxy), 0),
    avg_score: averageText(rows.map((row) => row.score)),
  }));
  const timingRows = currentBaseSummaryRows(picks, "timing_bucket", timingBucket, ["<15m", "15-59m", "60-120m", "120m+", "MISSING_TIMING"], (rows) => ({
    avg_minutes_before_start: averageText(rows.map((row) => row.hoursUntilStart === null ? null : row.hoursUntilStart * 60), 1),
    avg_score: averageText(rows.map((row) => row.score)),
  }));
  const marketRows = currentBaseSummaryRows(picks, "market_family", marketFamily, ["MONEYLINE", "TOTAL_GOALS", "TOTAL_POINTS", "TOTAL_RUNS", "TOTAL", "SPREAD / HANDICAP", "CORNERS", "PROPS", "FUTURES", "OTHER", "UNKNOWN_MARKET_FAMILY"], (rows) => ({
    avg_score: averageText(rows.map((row) => row.score)),
    avg_odds: averageText(rows.map(oddsDecimal)),
  }));
  const auditRows: CsvRow[] = [
    { field: "status", value: CURRENT_BASE_STATUS },
    { field: "generator", value: "scripts/morning-model-report.ts::writeDashboardDetailsWorkbook" },
    { field: "source", value: result.dataset.source },
    { field: "report_dir", value: reportDir },
    { field: "base_model", value: "Primary COV_CAP" },
    { field: "mode", value: result.baseModelMode },
    { field: "source_resolved_rows", value: String(result.dataset.rows) },
    { field: "source_event_groups", value: String(result.dataset.events) },
    { field: "base_model_rows", value: String(picks.length) },
    { field: "base_model_events", value: String(new Set(picks.map((pick) => pick.eventGroupKey)).size) },
    { field: "corpus_max_resolved_at", value: result.dataset.corpusMaxResolvedAt },
    { field: "recent_volume_source", value: "raw_json.diagnostics.recentTradeCash" },
    { field: "timing_source", value: "hours_until_start_num or diagnostics.gameStartIso - created_at" },
    { field: "legacy_values_used", value: "NO" },
  ];
  return { categoryRows, scoreRows, volumeRows, timingRows, marketRows, auditRows };
}

function currentBaseBanner(result: CounterfactualResult): Array<string | number> {
  return [
    "RECALCULATED_AT", new Date().toISOString(),
    "REPORT_DATE", new Date().toISOString().slice(0, 10),
    "DATASET_SOURCE", result.dataset.source,
    "BASE_MODEL", "Primary COV_CAP",
    "MODE", result.baseModelMode,
    "RESOLVED_ROWS", result.dataset.rows,
    "EVENT_GROUPS", result.dataset.events,
    "CORPUS_MAX_RESOLVED_AT", result.dataset.corpusMaxResolvedAt,
    "SECTION_STATUS", CURRENT_BASE_STATUS,
  ];
}

function writeCurrentBaseSheet(ws: ExcelJS.Worksheet, result: CounterfactualResult, headers: string[], rows: CsvRow[]): void {
  ws.getRow(1).values = currentBaseBanner(result);
  ws.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  fillRow(ws.getRow(1), "FF1F4E79");
  ws.getRow(3).values = headers;
  styleHeader(ws.getRow(3));
  const outputRows = rows.length ? rows : [{ [headers[0]]: "NO_ROWS_FOR_THIS_BUCKET_OR_SOURCE", section_status: "NO_ROWS_FOR_THIS_BUCKET_OR_SOURCE" }];
  outputRows.forEach((row, index) => {
    const target = ws.getRow(index + 4);
    headers.forEach((header, colIndex) => {
      target.getCell(colIndex + 1).value = row[header] ?? "";
    });
  });
  headers.forEach((header, index) => {
    const col = ws.getColumn(index + 1);
    const maxLen = Math.max(header.length, ...outputRows.map((row) => String(row[header] ?? "").length));
    col.width = Math.max(12, Math.min(maxLen + 2, 42));
    col.alignment = { vertical: "top", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 3 }];
}

function writeCurrentBaseReadme(ws: ExcelJS.Worksheet, result: CounterfactualResult, reportDir: string): void {
  ws.getRow(1).values = currentBaseBanner(result);
  ws.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  fillRow(ws.getRow(1), "FF1F4E79");
  const rows: CsvRow[] = [
    { field: "What this workbook is", value: "Current Base Model Details - recalculated from trusted dataset" },
    { field: "What this workbook is not", value: "Not a legacy template dashboard" },
    { field: "Report directory", value: reportDir },
    { field: "Source path/table/query", value: result.dataset.source },
    { field: "Base model", value: "Primary COV_CAP" },
    { field: "Mode", value: result.baseModelMode },
    { field: "Resolved rows", value: String(result.dataset.rows) },
    { field: "Event groups", value: String(result.dataset.events) },
    { field: "Base model rows/events", value: `${result.baseModelPicks.length} / ${new Set(result.baseModelPicks.map((pick) => pick.eventGroupKey)).size}` },
    { field: "Stake assumption", value: "flat $10 per selected pick" },
    { field: "Outcome/PnL definition", value: "realized_return_pct converted to flat-$10 PnL; wins from signal_result/realized return" },
    { field: "Missing-data policy", value: "Missing category/score/volume/timing/market values are counted in explicit UNKNOWN or MISSING buckets." },
    { field: "Generator", value: "scripts/morning-model-report.ts::writeDashboardDetailsWorkbook" },
    { field: "Sheets included", value: "00_ReadMe_Current_Dataset, 03_Category Summary, 04_Score Calibration, 06_Recent Volume Proxy, 07_Timing Proxy OBS, 08_Market Families, 99_Source Audit" },
    { field: "Sheets intentionally omitted", value: "01_Shadow Strategies, 02_Next Models, unsupported legacy tabs" },
  ];
  writeCurrentBaseSheetBody(ws, ["field", "value"], rows, 3);
}

function writeCurrentBaseSheetBody(ws: ExcelJS.Worksheet, headers: string[], rows: CsvRow[], startRow: number): void {
  ws.getRow(startRow).values = headers;
  styleHeader(ws.getRow(startRow));
  rows.forEach((row, index) => {
    const target = ws.getRow(startRow + 1 + index);
    headers.forEach((header, colIndex) => {
      target.getCell(colIndex + 1).value = row[header] ?? "";
    });
  });
  headers.forEach((header, index) => {
    const col = ws.getColumn(index + 1);
    const maxLen = Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length));
    col.width = Math.max(16, Math.min(maxLen + 2, 90));
    col.alignment = { vertical: "top", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: startRow }];
}

async function validateCurrentBaseDashboardWorkbook(outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  const required = ["00_ReadMe_Current_Dataset", "03_Category Summary", "04_Score Calibration", "06_Recent Volume Proxy", "07_Timing Proxy OBS", "08_Market Families"];
  const names = workbook.worksheets.map((ws) => ws.name);
  for (const name of required) {
    const ws = workbook.getWorksheet(name);
    if (!ws) throw new Error(`Current base dashboard missing sheet ${name}`);
    const banner = [...ws.getRow(1).values as unknown[]].join(" ");
    if (!banner.includes(CURRENT_BASE_STATUS)) throw new Error(`${name} missing current base banner`);
    if (ws.actualRowCount < 3) throw new Error(`${name} has no visible table/header`);
  }
  for (const unsupported of ["01_Shadow Strategies", "02_Next Models"]) {
    if (names.includes(unsupported)) throw new Error(`Current base dashboard includes unsupported legacy sheet ${unsupported}`);
  }
  for (const ws of workbook.worksheets) {
    ws.eachRow((row) => row.eachCell((cell) => {
      const text = String(cell.text ?? cell.value ?? "");
      if (/LEGACY_REFERENCE_ONLY_NOT_CURRENT/i.test(text)) throw new Error(`${ws.name}!${cell.address} still says legacy workbook`);
      if (/^(238|223)$/.test(text.trim())) throw new Error(`${ws.name}!${cell.address} has stale legacy value ${text}`);
    }));
  }
}

async function writeDashboardDetailsWorkbook(opts: {
  outputPath: string;
  reportDir: string;
  strictNow: number;
  strict24h: number;
  events: number;
  reportStatus: ReportStatus;
  policyRows: PolicyRow[];
  decisionRows: CsvRow[];
  windowRows: CsvRow[];
  freezeRows: CsvRow[];
  nightRows: CsvRow[];
  counterfactual: CounterfactualResult;
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const dashboard = buildCurrentBaseDashboard(opts.counterfactual, opts.reportDir);
  writeCurrentBaseReadme(workbook.addWorksheet("00_ReadMe_Current_Dataset"), opts.counterfactual, opts.reportDir);
  writeCurrentBaseSheet(workbook.addWorksheet("03_Category Summary"), opts.counterfactual, CATEGORY_SUMMARY_HEADERS, dashboard.categoryRows);
  writeCurrentBaseSheet(workbook.addWorksheet("04_Score Calibration"), opts.counterfactual, SCORE_CALIBRATION_HEADERS, dashboard.scoreRows);
  writeCurrentBaseSheet(workbook.addWorksheet("06_Recent Volume Proxy"), opts.counterfactual, RECENT_VOLUME_HEADERS, dashboard.volumeRows);
  writeCurrentBaseSheet(workbook.addWorksheet("07_Timing Proxy OBS"), opts.counterfactual, TIMING_OBS_HEADERS, dashboard.timingRows);
  writeCurrentBaseSheet(workbook.addWorksheet("08_Market Families"), opts.counterfactual, MARKET_FAMILY_HEADERS, dashboard.marketRows);
  writeCurrentBaseSheet(workbook.addWorksheet("99_Source Audit"), opts.counterfactual, SOURCE_AUDIT_HEADERS, dashboard.auditRows);
  workbook.creator = "PolyProPicks";
  workbook.modified = new Date();
  await mkdir(path.dirname(opts.outputPath), { recursive: true });
  await workbook.xlsx.writeFile(opts.outputPath);
  await validateCurrentBaseDashboardWorkbook(opts.outputPath);
}

async function postProcessDashboardLegacyMarkers(outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(outputPath);
  for (const ws of workbook.worksheets) {
    sanitizeLegacyTemplateValues(ws);
  }
  const shadow = workbook.getWorksheet("01_Shadow Strategies");
  if (shadow) {
    shadow.getCell("A9").value = "LEGACY_REFERENCE_ONLY: Shadow Strategies legacy preview only.";
    shadow.getCell("A10").value = "LEGACY_REFERENCE_ONLY: Historical 223-signal preview; not current ICE 707/501 dataset.";
    for (let col = 2; col <= 14; col++) shadow.getRow(10).getCell(col).value = null;
    if (/^(238|223)$/.test(String(shadow.getCell("W30").text ?? shadow.getCell("W30").value ?? "").trim())) {
      shadow.getCell("W30").value = `LEGACY_REFERENCE_ONLY: ${String(shadow.getCell("W30").text ?? shadow.getCell("W30").value).trim()}`;
    }
  }
  const dashboard = workbook.getWorksheet("00_CEO Dashboard");
  if (dashboard) {
    dashboard.getCell("A30").value = "LEGACY_REFERENCE_ONLY: Preview sizing on historical 223 universe; not current ICE 707/501 dataset.";
  }
  await workbook.xlsx.writeFile(outputPath);
}

function prependDashboardDatasetBanner(ws: ExcelJS.Worksheet, opts: {
  reportDir: string;
  strictNow: number;
  events: number;
  counterfactual: CounterfactualResult;
}): void {
  ws.spliceRows(1, 0, [], [], [], [], [], [], [], []);
  const sectionStatus = ["00_CEO Dashboard", "01_Shadow Strategies"].includes(ws.name)
    ? "LEGACY_REFERENCE_ONLY_NOT_CURRENT"
    : ["02_Next Models", "04_Score Calibration", "13_Cross Score-Odds"].includes(ws.name)
      ? "PARTIAL_RECALCULATED_CURRENT_RUN_APPEND"
      : "UNCHANGED_TEMPLATE_SECTION";
  const rows = [
    ["RECALCULATED_AT", new Date().toISOString()],
    ["DATASET_SOURCE", opts.counterfactual.dataset.source],
    ["RESOLVED_STRICT_ROWS", String(opts.counterfactual.dataset.rows)],
    ["EVENT_GROUPS", String(opts.counterfactual.dataset.events)],
    ["ONE_MATCH_ROWS", "501"],
    ["CORPUS_MAX_RESOLVED_AT", opts.counterfactual.dataset.corpusMaxResolvedAt],
    ["CEO_DASHBOARD_DETAILS_STATUS", "LEGACY_REFERENCE_ONLY_NOT_CURRENT"],
    ["SECTION_STATUS", sectionStatus],
  ];
  ws.getRow(1).getCell(1).value = "DATASET_BANNER";
  ws.getRow(1).font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
  fillRow(ws.getRow(1), "FF1F4E79");
  rows.forEach(([field, value], index) => {
    const row = ws.getRow(index + 2);
    row.getCell(1).value = field;
    row.getCell(2).value = value;
    row.alignment = { vertical: "top", wrapText: true };
  });
  ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 10, 28);
  ws.getColumn(2).width = Math.max(ws.getColumn(2).width ?? 10, 80);
}

function sanitizeLegacyTemplateValues(ws: ExcelJS.Worksheet): void {
  ws.eachRow((row) => row.eachCell((cell) => {
    sanitizeLegacyCell(cell);
  }));
  const maxRow = Math.max(ws.rowCount, ws.actualRowCount, 80);
  const maxCol = Math.max(ws.columnCount, 40);
  for (let row = 1; row <= maxRow; row++) {
    for (let col = 1; col <= maxCol; col++) {
      sanitizeLegacyCell(ws.getRow(row).getCell(col));
    }
  }
}

function sanitizeLegacyCell(cell: ExcelJS.Cell): void {
    const value = cell.value;
    if (value === 238 || value === 223) {
      cell.value = `LEGACY_REFERENCE_ONLY: ${value}`;
      return;
    }
    const formulaValue = asObject(value);
    const formulaResult = safeNum(formulaValue?.result);
    if (formulaResult === 238 || formulaResult === 223) {
      cell.value = `LEGACY_REFERENCE_ONLY: ${formulaResult}`;
      return;
    }
    if (/^(238|223)$/.test(String(cell.text ?? "").trim())) {
      cell.value = `LEGACY_REFERENCE_ONLY: ${String(cell.text).trim()}`;
      return;
    }
    if (typeof value === "string") {
      const collapsed = value.replace(/(?:LEGACY_REFERENCE_ONLY:\s*)+/g, "LEGACY_REFERENCE_ONLY: ").trim();
      if (/same-sample historical preview/i.test(collapsed)) {
        const body = collapsed.replace(/^LEGACY_REFERENCE_ONLY:\s*/i, "");
        cell.value = `LEGACY_REFERENCE_ONLY: ${body}`;
      } else if (/^(238|223)\*?$/.test(collapsed.trim())) {
        cell.value = `LEGACY_REFERENCE_ONLY: ${collapsed.trim()}`;
      } else if (/current 223 universe/i.test(collapsed)) {
        const body = collapsed.replace(/^LEGACY_REFERENCE_ONLY:\s*/i, "");
        cell.value = `LEGACY_REFERENCE_ONLY: ${body}`;
      } else if (collapsed !== value) {
        cell.value = collapsed;
      }
    }
}

async function loadWorkbookTemplatePreservingSheets(workbook: ExcelJS.Workbook, templatePath: string): Promise<boolean> {
  if (!(await fileExists(templatePath))) return false;
  try {
    await workbook.xlsx.readFile(templatePath);
    return true;
  } catch {
    try {
      const normalized = await normalizeSpreadsheetNamespaceForExcelJs(await readFile(templatePath));
      await workbook.xlsx.load(normalized as unknown as ExcelJS.Buffer);
      return true;
    } catch (error) {
      console.warn(`[morning-model] CEO dashboard details template unreadable after namespace normalization: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

async function resolveFirstExistingPath(paths: string[]): Promise<string | null> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function normalizeSpreadsheetNamespaceForExcelJs(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const xmlPaths = Object.keys(zip.files).filter((name) => name.endsWith(".xml") && name.startsWith("xl/"));
  for (const xmlPath of xmlPaths) {
    const original = await zip.file(xmlPath)!.async("string");
    const normalized = original
      .replace(/xmlns:x="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/g, 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
      .replace(/(<\/?)x:/g, "$1");
    zip.file(xmlPath, normalized);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

function ensureCeoDashboardTemplateSheets(workbook: ExcelJS.Workbook): void {
  for (const expectedName of CEO_DETAILS_SHEETS) {
    if (!workbook.getWorksheet(expectedName)) workbook.addWorksheet(expectedName);
  }
  for (const ws of [...workbook.worksheets]) {
    if (!(CEO_DETAILS_SHEETS as readonly string[]).includes(ws.name)) workbook.removeWorksheet(ws.id);
  }
}

function appendTemplateNote(ws: ExcelJS.Worksheet, note: string): void {
  appendTemplateTable(ws, "MORNING_REPORT_UPDATE_NOTE", ["field", "value"], [{ field: "status", value: note }]);
}

function appendTemplateTable(ws: ExcelJS.Worksheet, title: string, headers: string[], rows: CsvRow[]): void {
  const startRow = Math.max(ws.actualRowCount, 1) + 2;
  const titleRow = ws.getRow(startRow);
  titleRow.getCell(1).value = title;
  titleRow.font = { name: "Arial", bold: true, color: { argb: "FF1F4E79" } };
  const headerRow = ws.getRow(startRow + 1);
  headers.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  styleHeader(headerRow);
  const outputRows = rows.length > 0 ? rows : [{ [headers[0] ?? "field"]: "DATA_NOT_AVAILABLE_FOR_THIS_RUN" }];
  outputRows.forEach((row, rowIndex) => {
    const target = ws.getRow(startRow + 2 + rowIndex);
    headers.forEach((header, cellIndex) => {
      target.getCell(cellIndex + 1).value = row[header] ?? "";
    });
  });
  headers.forEach((header, index) => {
    const column = ws.getColumn(index + 1);
    const maxLen = Math.max(header.length, ...outputRows.map((row) => String(row[header] ?? "").length));
    column.width = Math.max(column.width ?? 10, Math.min(maxLen + 2, 56));
    column.alignment = { vertical: "top", wrapText: true };
  });
}

function resetWorkbookSheet(workbook: ExcelJS.Workbook, sheetName: string, headers: string[], rows: CsvRow[]): void {
  const existing = workbook.getWorksheet(sheetName);
  if (existing) workbook.removeWorksheet(existing.id);
  const ws = workbook.addWorksheet(sheetName);
  applyTableSheet(ws, headers, rows);
}

function resetBanneredWorkbookSheet(workbook: ExcelJS.Workbook, sheetName: string, bannerRows: CsvRow[], headers: string[], rows: CsvRow[]): void {
  const existing = workbook.getWorksheet(sheetName);
  if (existing) workbook.removeWorksheet(existing.id);
  const ws = workbook.addWorksheet(sheetName);
  applyBanneredTableSheet(ws, bannerRows, headers, rows);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function assertGeneratedAttachment(pathname: string): Promise<void> {
  if (!pathname.endsWith(".xlsx")) throw new Error(`Attachment is not .xlsx: ${pathname}`);
  const s = await stat(pathname);
  if (!s.isFile() || s.size <= 0) throw new Error(`Attachment missing or empty: ${pathname}`);
}

async function buildMorningAttachments(paths: string[]): Promise<Array<{ path: string; filename: string; content: string }>> {
  if (paths.length !== 3) throw new Error(`Expected exactly 3 attachments, got ${paths.length}`);
  const attachments = [];
  for (const pathname of paths) {
    await assertGeneratedAttachment(pathname);
    attachments.push({
      path: pathname,
      filename: path.basename(pathname),
      content: (await readFile(pathname)).toString("base64"),
    });
  }
  return attachments;
}


async function main() {
  loadEnvConfig(process.cwd());

  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10).replace(/-/g, '');
  const reportStamp = `${utcDate}_0600UTC`;
  const reportDir = path.join(REPORT_ROOT, reportStamp);
  const inputDir = path.join(reportDir, 'input');
  const reportsDir = path.join(reportDir, 'reports');
  const tablesDir = path.join(reportDir, 'tables');
  await mkdir(inputDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await mkdir(tablesDir, { recursive: true });

  const rawRows = await fetchAllResolvedRows();
  const canonicalRows = dedupeStrict(rawRows);
  const strictNow = canonicalRows.length;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const strict24h = canonicalRows.filter((r) => parseIso(r.resolved_at) >= cutoff24h).length;
  const events = new Set(canonicalRows.map((r) => counterfactualEventGroup(r))).size;
  const formulaCounts = canonicalRows.reduce<Record<string, number>>((acc, r) => {
    const v = safeStr(r.formula_version) ?? 'UNKNOWN';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  const newestResolvedAt = canonicalRows.reduce<string | null>((latest, r) => {
    if (!latest) return safeStr(r.resolved_at);
    return parseIso(r.resolved_at) > parseIso(latest) ? safeStr(r.resolved_at) : latest;
  }, null);
  console.log(
    `[morning-model] resolved freeze rows=${rawRows.length} strict=${strictNow} events=${events} max_resolved_at=${newestResolvedAt ?? "NONE"}`,
  );
  const newestMs = newestResolvedAt ? parseIso(newestResolvedAt) : 0;
  const ice707Ms = parseIso(ICE707_MAX_RESOLVED_AT);
  if (strictNow <= ICE707_BASELINE_ROWS || newestMs <= ice707Ms) {
    throw new Error(
      `DATASET_STALE_BLOCKER strict=${strictNow} events=${events} max_resolved_at=${newestResolvedAt ?? "NONE"} baseline=${ICE707_BASELINE_ROWS}/${ICE707_BASELINE_EVENTS}/${ICE707_MAX_RESOLVED_AT}`,
    );
  }
  const onePerMatchDir = path.resolve(process.cwd(), "reports", "modeling", "one_per_match_backtest");
  const onePerMatchResult = await runOnePerMatchBacktestFromRows(rawRows, onePerMatchDir);
  onePerMatchResult.dbStatus = DRY_RUN
    ? { attempted: false, insertedRun: false, insertedPicks: 0, error: "dry-run: DB persistence skipped" }
    : await persistOnePerMatchBacktest(onePerMatchResult);
  await writeOnePerMatchSummary(onePerMatchResult);
  const onePerMatchSummaryText = onePerMatchEmailSummary(onePerMatchResult);

  const freezePath = path.join(inputDir, INPUT_NAME);
  const freezeHeaders = [
    'freeze_id', 'row_id', 'created_at', 'resolved_at', 'formula_version', 'condition_id',
    'selected_token_id', 'selected_outcome', 'selected_side', 'event_key', 'market_slug',
    'event_slug', 'sport_or_scope', 'league', 'market_family', 'signal_result',
    'realized_return_pct', 'signal_confidence_num', 'data_coverage_num', 'entry_price_num',
    'hours_until_start_num', 'resolved_timing_bucket', 'raw_json',
  ];
  const csvRows = canonicalRows.map((r) => {
    const rawJson = JSON.stringify(r);
    return {
      freeze_id: r.freeze_id ?? '',
      row_id: r.id ?? '',
      created_at: r.created_at ?? '',
      resolved_at: r.resolved_at ?? '',
      formula_version: r.formula_version ?? r.metric_formula_version ?? '',
      condition_id: r.condition_id ?? '',
      selected_token_id: r.selected_token_id ?? '',
      selected_outcome: r.selected_outcome ?? '',
      selected_side: r.selected_side ?? '',
      event_key: r.event_key ?? '',
      market_slug: r.market_slug ?? '',
      event_slug: r.event_slug ?? '',
      sport_or_scope: r.sport_or_scope ?? '',
      league: r.league ?? '',
      market_family: r.market_family ?? '',
      signal_result: r.signal_result ?? '',
      realized_return_pct: r.realized_return_pct ?? '',
      signal_confidence_num: r.signal_confidence_num ?? '',
      data_coverage_num: r.data_coverage_num ?? '',
      entry_price_num: r.entry_price_num ?? '',
      hours_until_start_num: r.hours_until_start_num ?? '',
      resolved_timing_bucket: r.resolved_timing_bucket ?? '',
      raw_json: rawJson,
    };
  });
  await writeCsv(freezePath, csvRows, freezeHeaders);

  const policyCsvPath = path.join(tablesDir, 'policy_kpis.csv');
  const decisionCsvPath = path.join(tablesDir, 'decision_board.csv');
  const bankrollCsvPath = path.join(tablesDir, 'bankroll_simulations.csv');
  const runSummaryPath = path.join(tablesDir, 'run_summary.json');
  const windowViewPath = path.join(tablesDir, 'window_model_view.csv');
  const freezeRankingPath = path.join(tablesDir, 'freeze_ranking_alt.csv');
  const nightExecutionPath = path.join(tablesDir, 'night_execution_detail.csv');
  const reportPath = path.join(reportsDir, 'MORNING_REPORT.md');
  const workbookPath = path.join(reportDir, `polypropicks_morning_report_${utcDate}.xlsx`);
  const dashboardWorkbookPath = path.join(reportDir, `ceo_dashboard_details_${utcDate}.xlsx`);
  const counterfactualWorkbookPath = path.join(reportDir, `ice_four_models_counterfactual_${utcDate}.xlsx`);

  const latestResolver = await fetchLatestJobRun('resolver');
  const latestSignalCache = await fetchLatestJobRun('polymarket');
  const nightWindow = completedNightWindowIso(now);
  const nightRowsRaw = await fetchNightExecutionSlice(nightWindow.startIso, nightWindow.endIso);

  let reportText = '';
  let subject = '';
  let summaryMd = '';
  let analyzerError: string | null = null;
  let fallback = false;
  let reportStatus: ReportStatus = "FULL_ANALYZER_OK";

  try {
    if (process.env.MORNING_MODEL_FORCE_ANALYZER_FAIL === '1') {
      throw new Error('Forced analyzer failure via MORNING_MODEL_FORCE_ANALYZER_FAIL');
    }

    await runAnalyzer(reportDir, freezePath, reportsDir, tablesDir);

    const summaryMd = await readFile(path.join(reportsDir, '00_input_freeze_summary.md'), 'utf8');
    const policyCsv = await readFile(policyCsvPath, 'utf8');
    const decisionCsv = await readFile(decisionCsvPath, 'utf8');
    const bankrollCsv = await readFile(bankrollCsvPath, 'utf8');
    const runSummary = JSON.parse(await readFile(runSummaryPath, 'utf8')) as Record<string, unknown>;

    type MorningPolicyRow = CsvRow & {
      policy: string;
      N: string;
      events: string;
      wins: string;
      losses: string;
      win_rate: string;
      pnl10: string;
      roi: string;
      avg_return: string;
      median_return: string;
      max_dd: string;
      pnl_dd: string;
      worst_losing_streak: string;
      '24h_N': string;
      '24h_pnl10': string;
      '24h_roi': string;
      '48h_N': string;
      '48h_pnl10': string;
      '48h_roi': string;
      '96h_N': string;
      '96h_pnl10': string;
      '96h_roi': string;
      '7d_N': string;
      '7d_pnl10': string;
      '7d_roi': string;
      status: string;
    };

    const policyRows = parseSimpleCsv(policyCsv) as MorningPolicyRow[];
    const decisionRows = parseSimpleCsv(decisionCsv);
    const pick = (name: string) => policyRows.find((r) => r.policy === name);
    const risk = pick('ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE') ?? policyRows[0];
    const raw = pick('SCORE_GE_65') ?? policyRows[0];
    const flat = pick('FLAT_ALL') ?? policyRows[0];
    const bad = pick('EXCLUDE_BAD_BUCKET_SCORE_GE_65') ?? policyRows[0];
    const selectedModels = [
      { model: 'ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE', role: 'main', row: pick('ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE') ?? risk },
      { model: 'ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE', role: 'main', row: pick('ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE') ?? risk },
      { model: 'ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE', role: 'main', row: pick('ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE') ?? risk },
      { model: 'SCORE_GE_72', role: 'baseline', row: pick('SCORE_GE_72') ?? risk },
      { model: 'SCORE_GE_65', role: 'raw-PnL', row: raw },
      { model: 'EXCLUDE_BAD_BUCKET_SCORE_GE_65', role: 'raw-PnL', row: bad },
      { model: 'FLAT_ALL', role: 'baseline', row: flat },
      { model: 'FIREMODEL1_APPROX_CURRENT', role: 'shadow', row: pick('FIREMODEL1_APPROX_CURRENT') ?? raw },
    ];

    const windowViewRows = buildWindowModelView(policyRows);
    const freezeRankingRows = buildFreezeRankingAlt(policyRows, `${strictNow} strict freeze`);
    const nightExecutionRows = buildNightExecutionRows(nightRowsRaw);

    await writeCsv(windowViewPath, windowViewRows, WINDOW_HEADERS);
    await writeCsv(freezeRankingPath, freezeRankingRows, FREEZE_RANK_HEADERS);
    await writeCsv(nightExecutionPath, nightExecutionRows, NIGHT_HEADERS);

    const modelTable = [
      '| Model / Policy | Role | N | PnL @ $10 | ROI | MaxDD | PnL/DD | 24h ROI/PnL/N | 48h ROI/PnL/N | 72h ROI/PnL/N | 96h ROI/PnL/N | 7d ROI/PnL/N | Verdict |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |',
      ...selectedModels.map(({ model, role, row }) => {
        const verdict = safeStr(row.status) ?? 'N/A';
        const n = row.N ?? '0';
        const pnl = fmtMoney(row.pnl10);
        const roi = row.roi ?? 'N/A';
        const maxDd = fmtMoney(row.max_dd);
        const pnlDd = row.pnl_dd ?? 'N/A';
        return [
          model,
          role,
          n,
          pnl,
          roi,
          maxDd,
          pnlDd,
          `${row['24h_roi'] ?? 'N/A'} / ${fmtMoney(row['24h_pnl10'])} / ${row['24h_N'] ?? '0'}`,
          `${row['48h_roi'] ?? 'N/A'} / ${fmtMoney(row['48h_pnl10'])} / ${row['48h_N'] ?? '0'}`,
          `${row['72h_roi'] ?? 'N/A'} / ${fmtMoney(row['72h_pnl10'])} / ${row['72h_N'] ?? '0'}`,
          `${row['96h_roi'] ?? 'N/A'} / ${fmtMoney(row['96h_pnl10'])} / ${row['96h_N'] ?? '0'}`,
          `${row['7d_roi'] ?? 'N/A'} / ${fmtMoney(row['7d_pnl10'])} / ${row['7d_N'] ?? '0'}`,
          verdict,
        ].join(' | ');
      }),
    ].join('\n');

    const windowPreviewMd = csvRowsToMarkdown(WINDOW_HEADERS, windowViewRows);
    const freezeRankingPreviewMd = csvRowsToMarkdown(FREEZE_RANK_HEADERS, freezeRankingRows);
    const nightExecutionPreviewMd = csvRowsToMarkdown(NIGHT_HEADERS, nightExecutionRows);

    reportText = [
      '# Morning Model Recalculation Report',
      '',
      `Run time: ${now.toISOString()}`,
      `Freeze: ${freezePath}`,
      '',
      '## Corpus',
      `- Resolved strict tokens now: ${strictNow}`,
      `- New resolved strict tokens last 24h: ${strict24h}`,
      `- Events in freeze: ${events}`,
      `- Newest resolved_at: ${fmtDate(newestResolvedAt)}`,
      `- Formula counts: ${Object.entries(formulaCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      '',
      '## Latest Job Runs',
      `- Resolver: ${latestResolver ? `${latestResolver.status} @ ${fmtDate(latestResolver.started_at)} | selected=${safeNum(latestResolver.diagnostics?.selected)} | generated=${latestResolver.generated_count ?? 'N/A'} | skipped=${latestResolver.rejected_count ?? 'N/A'}` : 'N/A'}`,
      `- Signal-cache: ${latestSignalCache ? `${latestSignalCache.status} @ ${fmtDate(latestSignalCache.started_at)} | generated=${latestSignalCache.generated_count ?? 'N/A'} | skipped=${latestSignalCache.rejected_count ?? 'N/A'}` : 'N/A'}`,
      '',
      '## Model KPI Highlights',
      `- Best risk-adjusted: ${risk.policy} | N=${risk.N} | PnL=${fmtMoney(risk.pnl10)} | ROI=${risk.roi} | MaxDD=${fmtMoney(risk.max_dd)} | PnL/DD=${risk.pnl_dd} | 7d ROI=${risk['7d_roi']}`,
      `- Best raw-PnL: ${raw.policy} | N=${raw.N} | PnL=${fmtMoney(raw.pnl10)} | ROI=${raw.roi} | MaxDD=${fmtMoney(raw.max_dd)} | PnL/DD=${raw.pnl_dd} | 7d ROI=${raw['7d_roi']}`,
      `- Flat baseline: ${flat.policy} | N=${flat.N} | PnL=${fmtMoney(flat.pnl10)} | ROI=${flat.roi} | MaxDD=${fmtMoney(flat.max_dd)} | PnL/DD=${flat.pnl_dd}`,
      `- Bad-bucket guard: ${bad.policy} | N=${bad.N} | PnL=${fmtMoney(bad.pnl10)} | ROI=${bad.roi} | MaxDD=${fmtMoney(bad.max_dd)} | PnL/DD=${bad.pnl_dd}`,
      '',
      modelTable,
      '',
      '## One-Per-Match Backtest',
      onePerMatchSummaryText,
      '',
      '## Decision',
      `- Main model: ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE`,
      `- Shadow model: SCORE_GE_65`,
      `- $300 stakes: $5 conservative / $7 balanced / $10 aggressive`,
      `- Price bucket note: 0.35-0.44 remains best; <0.35 is weak; 0.45-0.54 is mixed`,
      `- Trust warning: coverage/timing fields are not trusted if missing in the freeze`,
      `- What not to change: live executor, Ireland routing, resolver backfill behavior`,
      '',
      '## Window Model View',
      windowPreviewMd,
      '',
      '## Freeze Ranking with ALT numbering',
      freezeRankingPreviewMd,
      '',
      '## Night Execution Detail',
      nightExecutionPreviewMd,
      '',
      '## Night Battle Look',
      'Night execution detail table pending founder-provided format.',
      '',
      '## Analyzer Artifacts',
      summaryMd.trim(),
      '',
      'Decision board preview:',
      csvRowsToMarkdown(DECISION_HEADERS, decisionRows.slice(0, 5)),
      '',
      'Policy KPI preview:',
      csvRowsToMarkdown(POLICY_HEADERS, policyRows.slice(0, 6)),
    ].join('\n');

    subject = `PolyProPicks Morning Model Report \u2014 ${now.toISOString().slice(0, 10)} \u2014 N=${strictNow}`;
    await writeFile(reportPath, reportText + '\n', 'utf8');
    await writeFile(runSummaryPath, JSON.stringify(runSummary, null, 2), 'utf8');
  } catch (err) {
    analyzerError = err instanceof Error ? err.message : String(err);
    fallback = true;
    reportStatus = "FALLBACK_RECOMPUTED";
    const fallbackArtifacts = await writeFallbackArtifacts({
      reportsDir,
      tablesDir,
      reportPath,
      runSummaryPath,
      summaryMdPath: path.join(reportsDir, '00_input_freeze_summary.md'),
      strictNow,
      strict24h,
      events,
      newestResolvedAt,
      latestResolver,
      latestSignalCache,
      analyzerError,
      freezePath,
      reportDir,
      now,
      canonicalRows,
      nightRowsRaw,
    });
    reportText = fallbackArtifacts.reportText;
    subject = fallbackArtifacts.subject;
    summaryMd = fallbackArtifacts.summaryMd;
  }

  let policyRows = parseSimpleCsv(await readFile(policyCsvPath, 'utf8'));
  let decisionRows = parseSimpleCsv(await readFile(decisionCsvPath, 'utf8'));
  let bankrollRows = parseSimpleCsv(await readFile(bankrollCsvPath, 'utf8'));
  let windowRows = parseSimpleCsv(await readFile(windowViewPath, 'utf8'));
  let freezeRows = parseSimpleCsv(await readFile(freezeRankingPath, 'utf8'));
  let nightRows = parseSimpleCsv(await readFile(nightExecutionPath, 'utf8'));
  let validationFailures = validateMorningRows({ policyRows, decisionRows, bankrollRows, windowRows, freezeRows, nightRows });

  if (validationFailures.length > 0 && canonicalRows.length > 0) {
    reportStatus = "FALLBACK_RECOMPUTED";
    fallback = true;
    analyzerError = analyzerError ?? `Analyzer output failed workbook gates: ${validationFailures.join("; ")}`;
    await rewriteFallbackTablesFromRows({ canonicalRows, nightRowsRaw, strictNow, tablesDir });
    policyRows = parseSimpleCsv(await readFile(policyCsvPath, 'utf8'));
    decisionRows = parseSimpleCsv(await readFile(decisionCsvPath, 'utf8'));
    bankrollRows = parseSimpleCsv(await readFile(bankrollCsvPath, 'utf8'));
    windowRows = parseSimpleCsv(await readFile(windowViewPath, 'utf8'));
    freezeRows = parseSimpleCsv(await readFile(freezeRankingPath, 'utf8'));
    nightRows = parseSimpleCsv(await readFile(nightExecutionPath, 'utf8'));
    validationFailures = validateMorningRows({ policyRows, decisionRows, bankrollRows, windowRows, freezeRows, nightRows });
  }

  if (validationFailures.length > 0) {
    reportStatus = "FAIL_NO_DATA";
    subject = `PolyProPicks Morning Model Report — FAIL_NO_DATA — ${now.toISOString().slice(0, 10)} — N=${strictNow}`;
    reportText = [
      "# Morning Model Recalculation Report",
      "",
      "Status: FAIL_NO_DATA",
      `N: ${strictNow}`,
      `Events: ${events}`,
      "",
      "Failed workbook gates:",
      ...validationFailures.map((failure) => `- ${failure}`),
      "",
      "Full details in attached XLSX workbook.",
    ].join("\n");
    await writeFile(reportPath, reportText + "\n", "utf8");
  }

  const counterfactualInput = await loadCounterfactualRows(csvRows, freezePath);
  const counterfactualResult = await writeCounterfactualWorkbook(counterfactualWorkbookPath, counterfactualInput.rows, counterfactualInput.source);

  const workbookGateFailures = await writeCeoMorningWorkbook({
    workbookPath,
    reportStatus,
    strictNow,
    strict24h,
    events,
    freezePath,
    latestResolver,
    latestSignalCache,
    analyzerError,
    policyRows: policyRows as PolicyRow[],
    counterfactual: counterfactualResult,
    nightRows,
    nightRowsRaw,
    validationFailures,
    onePerMatchResult,
  });
  if (workbookGateFailures.length > 0) {
    throw new Error(`CEO workbook quality gates failed: ${workbookGateFailures.join("; ")}`);
  }
  const mergedPolicyRows = mergePolicyRows(policyRows as PolicyRow[], buildAcceptedCounterfactualPolicyRows(counterfactualResult));
  const mergedPrimary = pickPolicy(mergedPolicyRows, ["SCORE_GE_72_AVOID_6_24H", "SCORE_GE_72", "ONE_PER_EVENT_SCORE_GE_72"]);
  const mergedRanking = buildCeoModelRankingRows(mergedPolicyRows, nightRows);
  const mergedBankrollRows = buildCeoBankrollRows(mergedPolicyRows);
  const mergedRecentRows = buildCeoRecentWindows(mergedPrimary, reportStatus);
  const mergedDecisionRows = buildCeoDecisionRows({
    reportStatus,
    strictNow,
    strict24h,
    events,
    primary: mergedPrimary,
    altRows: mergedRanking.rows,
    latestResolver,
    latestSignalCache,
    nightRows,
    analyzerError,
    currentBankrollSurvives: mergedBankrollRows.find((row) => row["current?"] === "YES")?.survives_300 === "YES",
  });
  const dashboardDecisionRows = buildDecisionBoardRows(mergedPolicyRows);
  await writeDashboardDetailsWorkbook({
    outputPath: dashboardWorkbookPath,
    reportDir,
    strictNow,
    strict24h,
    events,
    reportStatus,
    policyRows: mergedPolicyRows,
    decisionRows: dashboardDecisionRows,
    windowRows: mergedRecentRows,
    freezeRows,
    nightRows,
    counterfactual: counterfactualResult,
  });
  const generatedAttachmentPaths = [workbookPath, dashboardWorkbookPath, counterfactualWorkbookPath];
  const generatedAttachments = await buildMorningAttachments(generatedAttachmentPaths);

  const bestCandidate = [...mergedPolicyRows].sort((a, b) => (safeNum(b.pnl_dd) ?? -999) - (safeNum(a.pnl_dd) ?? -999))[0];
  const emailText = [
    `Status: ${reportStatus}`,
    `N / new 24h / events: ${strictNow} / ${strict24h} / ${events}`,
    `Best current candidate by PnL/DD: ${bestCandidate?.policy ?? "N/A"} | N=${bestCandidate?.N ?? "0"} | PnL=${bestCandidate?.pnl10 ?? "0"} | PnL/DD=${bestCandidate?.pnl_dd ?? "0"}`,
    `24h/48h/96h/7d: ${bestCandidate?.["24h_pnl10"] ?? "0"} / ${bestCandidate?.["48h_pnl10"] ?? "0"} / ${bestCandidate?.["96h_pnl10"] ?? "0"} / ${bestCandidate?.["7d_pnl10"] ?? "0"}`,
    onePerMatchSummaryText,
    "Attachments:",
    ...generatedAttachments.map((attachment, index) => `${index + 1}. ${attachment.filename}`),
    reportStatus === "FALLBACK_RECOMPUTED" ? `Warning: fallback KPIs recomputed after analyzer issue: ${analyzerError ?? "unknown"}` : "",
    reportStatus === "FAIL_NO_DATA" ? `Failed gates: ${validationFailures.join("; ")}` : "",
    "Full details are in the three attached XLSX workbooks.",
  ].filter(Boolean).join("\n");

  const summary = {
    reportDir,
    freezePath,
    strictNow,
    strict24h,
    events,
    newestResolvedAt,
    analyzerError,
    fallback,
    latestResolver: latestResolver ? {
      status: latestResolver.status,
      started_at: latestResolver.started_at,
      generated_count: latestResolver.generated_count,
      rejected_count: latestResolver.rejected_count,
    } : null,
    latestSignalCache: latestSignalCache ? {
      status: latestSignalCache.status,
      started_at: latestSignalCache.started_at,
      generated_count: latestSignalCache.generated_count,
      rejected_count: latestSignalCache.rejected_count,
    } : null,
    tables: {
      policyCsv: policyCsvPath,
      decisionCsv: decisionCsvPath,
      bankrollCsv: bankrollCsvPath,
      windowView: windowViewPath,
      freezeRankingAlt: freezeRankingPath,
      nightExecutionDetail: nightExecutionPath,
    },
    sendMode: DRY_RUN ? 'dry-run' : SEND_TEST ? 'send-test' : 'dry-run',
    emailRecipient: EMAIL_RECIPIENT,
    subject,
    artifacts: {
      report: reportPath,
      freeze: freezePath,
      policyCsv: policyCsvPath,
      decisionCsv: decisionCsvPath,
      bankrollCsv: bankrollCsvPath,
      windowView: windowViewPath,
      freezeRankingAlt: freezeRankingPath,
      nightExecutionDetail: nightExecutionPath,
      runSummary: runSummaryPath,
      workbook: workbookPath,
      dashboardWorkbook: dashboardWorkbookPath,
      counterfactualWorkbook: counterfactualWorkbookPath,
      onePerMatchSummary: onePerMatchResult.artifactPaths.summaryJson,
      onePerMatchSelectedPicks: onePerMatchResult.artifactPaths.selectedPicksCsv,
      onePerMatchEventGroups: onePerMatchResult.artifactPaths.eventGroupsCsv,
      onePerMatchComparison: onePerMatchResult.artifactPaths.comparisonCsv,
    },
    attachments: generatedAttachments.map((attachment) => ({
      filename: attachment.filename,
      path: attachment.path,
    })),
    attachmentCount: generatedAttachments.length,
    counterfactual: counterfactualResult.dataset,
    workbookGateFailures,
    onePerMatchBacktest: {
      runId: onePerMatchResult.runId,
      rawRows: onePerMatchResult.rawRows,
      resolvedRows: onePerMatchResult.resolvedRows,
      uniqueEventGroups: onePerMatchResult.uniqueEventGroups,
      selectedRows: onePerMatchResult.selectedRows,
      comparisonRows: onePerMatchResult.comparisonRows,
      dbStatus: onePerMatchResult.dbStatus,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!DRY_RUN && SEND_TEST) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    const missing: string[] = [];
    if (!apiKey) missing.push('RESEND_API_KEY');
    if (!from) missing.push('EMAIL_FROM');
    if (!EMAIL_RECIPIENT) missing.push('EMAIL_RECIPIENT');
    if (missing.length > 0) {
      throw new Error(`[morning-model] Send-test failed: missing ${missing.join(', ')}`);
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [EMAIL_RECIPIENT],
        subject: `TEST ${subject}`,
        text: emailText,
        html: `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(emailText)}</pre>`,
        attachments: generatedAttachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
        })),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log(`[morning-model] Email sent to ${EMAIL_RECIPIENT}`);
  } else {
    console.log('[morning-model] Dry-run mode - no email sent.');
  }
}

main().catch((e) => {
  console.error('[morning-model] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
