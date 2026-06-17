import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import ExcelJS from "exceljs";
import { mkdir, readFile, writeFile } from "fs/promises";
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
const CEO_TEMPLATE_PATH = path.resolve(process.cwd(), "CEO_Morning_Report_TEMPLATE.xlsx");
const INPUT_NAME = "resolved_freeze.csv";
const REPORT_ROOT = path.resolve(process.cwd(), "modeling", "morning_model_report");
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
  "#", "scope", "market_side", "tier_model", "live?", "stake", "odds_dec", "result_status",
  "pnl", "fee_slippage_pct_of_stake", "why_this_bet",
];
const CURRENT_MODEL_HEADERS = [
  "model", "role", "current?", "exact_or_approx", "N", "roi", "7d_roi", "maxDD", "pnlDD",
  "worst_streak", "survives_300", "deploy_status", "action_today",
];
const MODEL_RANKING_HEADERS = [
  "rank", "model", "current?", "exact_or_approx", "N", "24h_N", "24h_roi", "48h_N",
  "48h_roi", "96h_N", "96h_roi", "7d_N", "7d_roi", "maxDD", "pnlDD", "survives_300", "verdict",
];
const CEO_BANKROLL_HEADERS = [
  "policy", "current?", "start_bank", "final_bank", "total_pnl", "roi", "max_dd_$", "max_dd_%",
  "min_equity", "worst_streak", "survives_300", "comment",
];
const RECENT_WINDOWS_HEADERS = ["window", "model_slice", "bets", "resolved", "net_pnl", "roi", "trust_flag"];
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
  const pageSize = 1000;
  const rows: RawRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("generated_signal_pairs")
      .select("*")
      .not("signal_result", "is", null)
      .not("condition_id", "is", null)
      .not("selected_token_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`generated_signal_pairs: ${error.message}`);
    const chunk = (data ?? []) as RawRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
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

function buildNightExecutionRows(rows: OrderEventRow[]): CsvRow[] {
  const matched = rows.filter((row) => {
    const status = (safeStr(row.order_status) ?? "").toLowerCase();
    return row.success === true || ["matched", "filled", "success", "submitted"].includes(status);
  }).length;
  const skipped = rows.length - matched;
  const totalStake = rows.reduce((sum, row) => sum + (safeNum(row.submitted_size) ?? safeNum(row.stake_usd) ?? 0), 0);
  const dominantModel = safeStr(rows[0]?.model_rule_id) ?? safeStr(rows[0]?.strategic_scope) ?? "N/A";
  const weightedFee = rows.reduce((sum, row) => {
    const stake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
    const fee = safeNum(row.fee_usd);
    return stake !== null && stake > 0 && fee !== null ? sum + fee : sum;
  }, 0);
  const weightedFeePct = totalStake > 0 && weightedFee > 0 ? `${((weightedFee / totalStake) * 100).toFixed(2)}%` : "N/A";
  const summary: CsvRow = {
    "#": "—",
    scope: "NIGHT SUMMARY",
    market_side: rows.length ? `${matched} placed / ${skipped} skipped` : "0 placed / 0 skipped",
    tier_model: dominantModel,
    "live?": "—",
    stake: `$${totalStake.toFixed(2)}`,
    odds_dec: "—",
    result_status: rows.length ? `${matched} matched / ${skipped} skipped` : "NO_REAL_EXECUTION",
    pnl: "pending",
    fee_slippage_pct_of_stake: weightedFeePct,
    why_this_bet: rows.length
      ? "Real executor_order_events rows from the previous report window; PnL pending until resolution."
      : "No real executor order rows found for this window; alerts/plans are not execution.",
  };
  if (!rows.length) {
    return [
      summary,
      {
        "#": "1",
        scope: "NO_REAL_EXECUTOR_ORDERS",
        market_side: "alerts/plans only",
        tier_model: "N/A",
        "live?": "N/A",
        stake: "$0.00",
        odds_dec: "N/A",
        result_status: "NO_EXECUTED_BETS",
        pnl: "N/A",
        fee_slippage_pct_of_stake: "N/A",
        why_this_bet: "No real executor order rows found for this window; alerts/plans are not execution.",
      },
    ];
  }
  return [summary, ...rows.map((row, index) => {
    const snapshot = row.candidate_snapshot_json;
    const meta = row.executor_meta;
    const why = extractReason(snapshot) ?? extractReason(meta) ?? safeStr(row.model_rule_id) ?? "N/A";
    const finalStake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
    const status = safeStr(row.order_status) ?? (row.success === true ? "success" : row.success === false ? "failed" : "N/A");
    return {
      "#": String(index + 1),
      scope: safeStr(row.strategic_scope) ?? "UNKNOWN",
      market_side: `${safeStr(row.market_slug) ?? "N/A"} / ${safeStr(row.selected_side) ?? safeStr(row.side) ?? "N/A"}`,
      tier_model: safeStr(row.model_rule_id) ?? safeStr(row.strategic_scope) ?? "N/A",
      "live?": row.live_confirm === true ? "YES" : row.live_confirm === false ? "NO" : "N/A",
      stake: finalStake === null ? "N/A" : `$${finalStake.toFixed(2)}`,
      odds_dec: normalizeDealPrice(row),
      result_status: status,
      pnl: "pending",
      fee_slippage_pct_of_stake: feeSlippagePct(row),
      why_this_bet: feeSlippagePct(row) === "N/A" ? `${why}; estimated fee+slippage unavailable` : why,
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
  const approx = "APPROX_NEEDS_RECON";
  return [{
    model: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    role: "current primary / live candidate",
    "current?": "YES",
    exact_or_approx: approx,
    N: primary?.N ?? "0",
    roi: percentText(primary?.roi),
    "7d_roi": percentText(primary?.["7d_roi"]),
    maxDD: moneyText(primary?.max_dd),
    pnlDD: primary?.pnl_dd ?? "0",
    worst_streak: primary?.worst_losing_streak ?? "0",
    survives_300: "YES",
    deploy_status: reportStatus === "FULL_ANALYZER_OK" ? "HOLD_NOT_VERIFIED" : "HOLD_NOT_VERIFIED",
    action_today: reportStatus === "FULL_ANALYZER_OK" ? "REVIEW exact reconstruction before scaling" : "HOLD; analyzer fallback/recomputed",
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
  return windows.map(([window, nKey, pnlKey, roiKey]) => ({
    window,
    model_slice: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
    bets: primary?.[nKey] ?? "0",
    resolved: primary?.[nKey] ?? "0",
    net_pnl: moneyText(primary?.[pnlKey]),
    roi: percentText(primary?.[roiKey]),
    trust_flag: reportStatus === "FULL_ANALYZER_OK" ? "PARTIAL" : "PARTIAL",
  })).filter((row) => row.bets !== "0");
}

function buildRealizedLastNightRow(nightRows: CsvRow[]): CsvRow {
  const realRows = nightRows.filter((row) => row.scope !== "NIGHT SUMMARY" && row.scope !== "NO_REAL_EXECUTOR_ORDERS");
  const summary = nightRows.find((row) => row.scope === "NIGHT SUMMARY");
  const n = String(realRows.length);
  const verdict = realRows.length >= 5 ? "REVIEW" : "HOLD";
  return {
    rank: "—",
    model: "REALIZED_LAST_NIGHT (current model)",
    "current?": "—",
    exact_or_approx: "REAL_EXECUTED",
    N: n,
    "24h_N": n,
    "24h_roi": summary?.pnl && summary.pnl !== "pending" ? summary.pnl : "pending",
    "48h_N": "—",
    "48h_roi": "—",
    "96h_N": "—",
    "96h_roi": "—",
    "7d_N": "—",
    "7d_roi": "—",
    maxDD: "—",
    pnlDD: "—",
    survives_300: "n/a",
    verdict: realRows.length === 0 ? "HOLD: no real execution rows; plans/alerts are not execution" : verdict,
  };
}

function buildCeoModelRankingRows(policies: PolicyRow[], nightRows: CsvRow[]): { rows: CsvRow[]; duplicateNotes: string } {
  const specs = [
    { rank: "0", model: "BASELINE_V1_CONTROL", current: "NO", source: "FLAT_ALL", exact: "EXACT_SHADOW", verdict: "baseline / shadow" },
    { rank: "1", model: "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP", current: "YES", source: "SCORE_GE_72_AVOID_6_24H", exact: "APPROX_NEEDS_RECON", verdict: "CURRENT — hold, verify" },
    { rank: "2", model: "ALT1_ONE_PER_EVENT_BEST_COVERAGE", current: "NO", source: "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", exact: "APPROX_NEEDS_RECON", verdict: "observe" },
    { rank: "3", model: "ALT2_FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH", current: "NO", source: "FLOW_CLEAN_EXCLUDE_SMARTMONEY_HIGH_APPROX", exact: "APPROX_NEEDS_RECON", verdict: "observe, high DD" },
    { rank: "4", model: "ALT3_V1_AVOID_NBA_NHL", current: "NO", source: "ALT3_FLAT10_RAW_PROFIT_APPROX", exact: "APPROX_NEEDS_RECON", verdict: "observe" },
    { rank: "5", model: "ALT4_AVOID_NBA_NHL_PLUS_COV75", current: "NO", source: "COVERAGE_75_SCORE_GE_72", exact: "APPROX_NEEDS_RECON", verdict: "observe only if data exists" },
  ];
  const rows: CsvRow[] = [buildRealizedLastNightRow(nightRows)];
  const seen = new Map<string, string>();
  const duplicateNotes: string[] = [];
  for (const spec of specs) {
    const policy = pickPolicy(policies, [spec.source]);
    if (!policy) continue;
    if (spec.model !== "BASELINE_V1_CONTROL" && safeNum(policy.N) === 0) continue;
    const signature = metricSignature(policy);
    const previous = seen.get(signature);
    if (previous) {
      duplicateNotes.push(`${spec.model} collapsed into ${previous} because strict token set/metrics matched`);
      continue;
    }
    seen.set(signature, spec.model);
    rows.push({
      rank: spec.rank,
      model: spec.model,
      "current?": spec.current,
      exact_or_approx: spec.exact,
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
  const status = opts.reportStatus !== "FULL_ANALYZER_OK" || !opts.currentBankrollSurvives ? "RED" : "YELLOW";
  const realRows = opts.nightRows.filter((row) => row.scope !== "NIGHT SUMMARY" && row.scope !== "NO_REAL_EXECUTOR_ORDERS");
  const modelMetricState = "MODEL_METRICS_APPROX_NEEDS_RECON";
  const nightExecutionState = realRows.length === 0 ? "NO_REAL_EXECUTOR_ROWS" : "REAL_EXECUTOR_ROWS_FOUND";
  const topAction = !opts.currentBankrollSurvives
    ? "HOLD — current bankroll row fails $300 survival in reconstructed run; do not scale."
    : status === "RED"
    ? "REVIEW — analyzer/fallback state prevents model scaling; keep current executor settings unchanged."
    : "HOLD — keep current model while exact reconstruction is verified.";
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
    ["DATA TRUST", `analyzer_state=${opts.reportStatus === "FULL_ANALYZER_OK" ? "OK" : opts.reportStatus} | model_metric_state=${modelMetricState} | night_execution_state=${nightExecutionState} | freeze N=${opts.strictNow} | new 24h=${opts.strict24h}`],
    ["TONIGHT", !opts.currentBankrollSurvives ? "NO-GO FOR SCALING / HOLD SAFE MODE ONLY: current bankroll row fails $300 survival in this reconstructed run; reduce/hold until exact check." : status === "RED" ? "NO-GO FOR SCALING / HOLD SAFE MODE ONLY; 5 slots max, $300 bankroll cap, stop after 2 consecutive live losses." : "GO only at current size; hold slots, $300 bankroll cap, stop after 2 consecutive live losses."],
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
  const nightExecutionState = opts.nightRowsRaw.length === 0 ? "NO_REAL_EXECUTOR_ROWS" : "REAL_EXECUTOR_ROWS_FOUND";
  return [
    { field: "analyzer_state", value: opts.reportStatus === "FULL_ANALYZER_OK" ? "OK" : opts.reportStatus },
    { field: "model_metric_state", value: "APPROX_NEEDS_RECON" },
    { field: "night_execution_state", value: nightExecutionState },
    { field: "fallback_reason", value: opts.analyzerError ?? "none" },
    { field: "freeze_path", value: opts.freezePath },
    { field: "resolver_status", value: jobSummary(opts.latestResolver) },
    { field: "signal_cache_status", value: jobSummary(opts.latestSignalCache) },
    { field: "missing_fields", value: "coverage/timing may be partial; approximate rows marked APPROX_NEEDS_RECON" },
    { field: "duplicate_policies_collapsed", value: opts.duplicateNotes },
    { field: "night_execution_source", value: `executor_order_events rows=${opts.nightRowsRaw.length}` },
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
  if (!dataTrust.includes("model_metric_state=MODEL_METRICS_APPROX_NEEDS_RECON")) failures.push("DATA TRUST missing model metric approximate state");
  if (!dataTrust.includes("night_execution_state=")) failures.push("DATA TRUST missing night execution state");
  const currentExact = String(current?.getCell("D2").value ?? "");
  const warningText = current ? Array.from({ length: Math.max(6, current.rowCount) }, (_, i) => String(current.getRow(i + 1).getCell(1).value ?? "")).join(" ") : "";
  if (currentExact.includes("APPROX") && !warningText.includes("RED FLAG: current model is APPROX")) failures.push("01_Current_Model missing visible red warning");
  const deployStatus = String(current?.getCell("L2").value ?? "");
  if (currentExact.includes("APPROX") && /(LIVE_SAFE|SAFE_TO_DEPLOY|EXACT_VERIFIED)$/i.test(deployStatus)) failures.push("approx current model deploy_status presented as safe");
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
  const rankingHeaders = ranking ? [...ranking.getRow(1).values as unknown[]].slice(1).map(String) : [];
  for (const header of ["24h_N", "24h_roi", "48h_N", "48h_roi", "96h_N", "96h_roi", "7d_N", "7d_roi"]) {
    if (!rankingHeaders.includes(header)) failures.push(`02_Model_Ranking missing ${header}`);
  }
  const nightHeaders = night ? [...night.getRow(1).values as unknown[]].slice(1).map(String) : [];
  if (!nightHeaders.includes("tier_model")) failures.push("05_Night_Execution missing tier_model");
  if (!nightHeaders.includes("fee_slippage_pct_of_stake")) failures.push("05_Night_Execution missing fee_slippage_pct_of_stake");
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
  for (const model of rankingModels.slice(2).filter(Boolean)) {
    if (seenModels.has(model)) failures.push(`duplicate policy row in 02_Model_Ranking: ${model}`);
    seenModels.add(model);
  }
  const status = String(workbook.getWorksheet("00_CEO_Decision")?.getCell("B3").value ?? "");
  const dqFields = workbook.getWorksheet("06_Data_Quality")?.getColumn(1).values.map((v) => String(v ?? "")) ?? [];
  if (!dqFields.includes("model_metric_state")) failures.push("06_Data_Quality missing model_metric_state");
  if (!dqFields.includes("night_execution_state")) failures.push("06_Data_Quality missing night_execution_state");
  if (workbook.getWorksheet(ONE_PER_MATCH_SHEET) && workbook.getWorksheet(ONE_PER_MATCH_SHEET)!.rowCount < 10) {
    failures.push("OnePerMatchBacktest sheet missing expected rows");
  }
  const analyzerState = String(workbook.getWorksheet("06_Data_Quality")?.getCell("B2").value ?? "");
  if (analyzerState !== "OK" && status !== "RED") failures.push(`status light ${status} does not reflect analyzer_state=${analyzerState}`);
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
  nightRows: CsvRow[];
  nightRowsRaw: OrderEventRow[];
  validationFailures: string[];
  onePerMatchResult: OnePerMatchBacktestResult | null;
}): Promise<string[]> {
  const template = new ExcelJS.Workbook();
  await template.xlsx.readFile(CEO_TEMPLATE_PATH);
  assertTemplate(template);
  const workbook = template;
  const primary = pickPolicy(opts.policyRows, ["SCORE_GE_72_AVOID_6_24H", "SCORE_GE_72", "ONE_PER_EVENT_SCORE_GE_72"]);
  const currentRows = buildCeoCurrentModelRows(primary, opts.reportStatus);
  const ranking = buildCeoModelRankingRows(opts.policyRows, opts.nightRows);
  const bankrollRows = buildCeoBankrollRows(opts.policyRows);
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
    policyRows: opts.policyRows,
    nightRowsRaw: opts.nightRowsRaw,
    validationFailures: opts.validationFailures,
  });

  applyDecisionSheet(workbook.getWorksheet("00_CEO_Decision")!, decisionRows);
  applyCurrentModelSheet(workbook.getWorksheet("01_Current_Model")!, currentRows);
  applyTableSheet(workbook.getWorksheet("02_Model_Ranking")!, MODEL_RANKING_HEADERS, ranking.rows);
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
  const events = new Set(
    canonicalRows.map((r) => safeStr(r.event_key) ?? safeStr(r.event_slug) ?? safeStr(r.market_slug) ?? r.__strict_key),
  ).size;
  const formulaCounts = canonicalRows.reduce<Record<string, number>>((acc, r) => {
    const v = safeStr(r.formula_version) ?? 'UNKNOWN';
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  const newestResolvedAt = canonicalRows.reduce<string | null>((latest, r) => {
    if (!latest) return safeStr(r.resolved_at);
    return parseIso(r.resolved_at) > parseIso(latest) ? safeStr(r.resolved_at) : latest;
  }, null);
  const onePerMatchDir = path.resolve(process.cwd(), "reports", "modeling", "one_per_match_backtest");
  const onePerMatchResult = await runOnePerMatchBacktestFromRows(rawRows, onePerMatchDir);
  onePerMatchResult.dbStatus = await persistOnePerMatchBacktest(onePerMatchResult);
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
  const workbookPath = path.join(reportDir, `polypropicks_morning_model_report_${utcDate}_N${strictNow}.xlsx`);

  const latestResolver = await fetchLatestJobRun('resolver');
  const latestSignalCache = await fetchLatestJobRun('polymarket');
  const nightWindowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const nightRowsRaw = await fetchNightExecutionSlice(nightWindowStart, now.toISOString());

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
    nightRows,
    nightRowsRaw,
      validationFailures,
      onePerMatchResult,
  });
  if (workbookGateFailures.length > 0) {
    throw new Error(`CEO workbook quality gates failed: ${workbookGateFailures.join("; ")}`);
  }

  const bestCandidate = [...policyRows].sort((a, b) => (safeNum(b.pnl_dd) ?? -999) - (safeNum(a.pnl_dd) ?? -999))[0];
  const emailText = [
    `Status: ${reportStatus}`,
    `N / new 24h / events: ${strictNow} / ${strict24h} / ${events}`,
    `Best current candidate by PnL/DD: ${bestCandidate?.policy ?? "N/A"} | N=${bestCandidate?.N ?? "0"} | PnL=${bestCandidate?.pnl10 ?? "0"} | PnL/DD=${bestCandidate?.pnl_dd ?? "0"}`,
    `24h/48h/96h/7d: ${bestCandidate?.["24h_pnl10"] ?? "0"} / ${bestCandidate?.["48h_pnl10"] ?? "0"} / ${bestCandidate?.["96h_pnl10"] ?? "0"} / ${bestCandidate?.["7d_pnl10"] ?? "0"}`,
    onePerMatchSummaryText,
    reportStatus === "FALLBACK_RECOMPUTED" ? `Warning: fallback KPIs recomputed after analyzer issue: ${analyzerError ?? "unknown"}` : "",
    reportStatus === "FAIL_NO_DATA" ? `Failed gates: ${validationFailures.join("; ")}` : "",
    "Full details in attached XLSX workbook.",
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
      onePerMatchSummary: onePerMatchResult.artifactPaths.summaryJson,
      onePerMatchSelectedPicks: onePerMatchResult.artifactPaths.selectedPicksCsv,
      onePerMatchEventGroups: onePerMatchResult.artifactPaths.eventGroupsCsv,
      onePerMatchComparison: onePerMatchResult.artifactPaths.comparisonCsv,
    },
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
        subject,
        text: emailText,
        html: `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(emailText)}</pre>`,
        attachments: [
          { filename: path.basename(workbookPath), content: (await readFile(workbookPath)).toString('base64') },
        ],
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
