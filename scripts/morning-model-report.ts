import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { writeWorkbookXlsx } from "./report-xlsx";

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
const INPUT_NAME = "resolved_freeze.csv";
const REPORT_ROOT = path.resolve(process.cwd(), "modeling", "morning_model_report");
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
  "Scope", "Рынок / сторона", "API stake", "Final stake / фактический объём", "Live?",
  "Коэффициент сделки", "Статус результата", "Комиссия", "Тир / модель", "Почему эта ставка сделана",
];

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
}): Promise<{ summaryMd: string; reportText: string; subject: string }> {
  await writeCsv(path.join(opts.tablesDir, "policy_kpis.csv"), [], POLICY_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "decision_board.csv"), [], DECISION_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "bankroll_simulations.csv"), [], BANKROLL_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "window_model_view.csv"), [], WINDOW_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "freeze_ranking_alt.csv"), [], FREEZE_RANK_HEADERS);
  await writeCsv(path.join(opts.tablesDir, "night_execution_detail.csv"), [], NIGHT_HEADERS);

  const latestResolverText = opts.latestResolver
    ? `- Resolver: ${opts.latestResolver.status} @ ${fmtDate(opts.latestResolver.started_at)} | selected=${safeNum(opts.latestResolver.diagnostics?.selected)} | generated=${opts.latestResolver.generated_count ?? "N/A"} | skipped=${opts.latestResolver.rejected_count ?? "N/A"}`
    : "- Resolver: N/A";
  const latestSignalCacheText = opts.latestSignalCache
    ? `- Signal-cache: ${opts.latestSignalCache.status} @ ${fmtDate(opts.latestSignalCache.started_at)} | generated=${opts.latestSignalCache.generated_count ?? "N/A"} | skipped=${opts.latestSignalCache.rejected_count ?? "N/A"}`
    : "- Signal-cache: N/A";
  const fallbackSummaryMd = [
    "# Ice1 Input Freeze Summary",
    "",
    "- WARNING: Analyzer failed, fallback report sent.",
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
    "WARNING: Analyzer failed, fallback report sent.",
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
    subject: `PolyProPicks Morning Model Report — FALLBACK — ${opts.now.toISOString().slice(0, 10)} — N=${opts.strictNow}`,
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

function parseSimpleCsv(text: string): CsvRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).filter((line) => line.trim().length > 0).map((line) => {
    const cells = line.split(",");
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
  const strict = pickPolicy(policies, ["ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", "SCORE_GE_72"]);
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
    { rank: 5, strategy: "ALT4_AVOID_NBA_NHL_PLUS_COV75", source: "EXCLUDE_BAD_BUCKET_SCORE_GE_72", roleStatus: "APPROX / NEEDS_EXACT_RECON" },
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

function buildNightExecutionRows(rows: OrderEventRow[]): CsvRow[] {
  if (!rows.length) {
    return [{
      Scope: "NO_EXECUTED_BETS_IN_WINDOW",
      "Рынок / сторона": "",
      "API stake": "",
      "Final stake / фактический объём": "",
      "Live?": "",
      "Коэффициент сделки": "",
      "Статус результата": "",
      "Комиссия": "",
      "Тир / модель": "",
      "Почему эта ставка сделана": "",
    }];
  }
  return rows.map((row) => {
    const snapshot = row.candidate_snapshot_json;
    const meta = row.executor_meta;
    const why = extractReason(snapshot) ?? extractReason(meta) ?? safeStr(row.model_rule_id) ?? "N/A";
    const finalStake = safeNum(row.submitted_size) ?? safeNum(row.stake_usd);
    const status = safeStr(row.order_status) ?? (row.success === true ? "success" : row.success === false ? "failed" : "N/A");
    return {
      Scope: safeStr(row.strategic_scope) ?? "UNKNOWN",
      "Рынок / сторона": `${safeStr(row.market_slug) ?? "N/A"} / ${safeStr(row.selected_side) ?? safeStr(row.side) ?? "N/A"}`,
      "API stake": safeNum(row.stake_usd) === null ? "N/A" : `$${safeNum(row.stake_usd)!.toFixed(2)}`,
      "Final stake / фактический объём": finalStake === null ? "N/A" : `$${finalStake.toFixed(2)}`,
      "Live?": row.live_confirm === true ? "YES" : row.live_confirm === false ? "NO" : "N/A",
      "Коэффициент сделки": normalizeDealPrice(row),
      "Статус результата": status,
      "Комиссия": safeNum(row.fee_usd) === null ? "N/A" : `$${safeNum(row.fee_usd)!.toFixed(2)}`,
      "Тир / модель": safeStr(row.model_rule_id) ?? safeStr(row.strategic_scope) ?? "N/A",
      "Почему эта ставка сделана": why,
    };
  });
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

  let reportText = '';
  let subject = '';
  let summaryMd = '';
  let analyzerError: string | null = null;
  let fallback = false;

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

    const nightWindowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const nightRowsRaw = await fetchNightExecutionSlice(nightWindowStart, now.toISOString());
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
    });
    reportText = fallbackArtifacts.reportText;
    subject = fallbackArtifacts.subject;
    summaryMd = fallbackArtifacts.summaryMd;
  }

  const policyRows = parseSimpleCsv(await readFile(policyCsvPath, 'utf8'));
  const decisionRows = parseSimpleCsv(await readFile(decisionCsvPath, 'utf8'));
  const bankrollRows = parseSimpleCsv(await readFile(bankrollCsvPath, 'utf8'));
  const windowRows = parseSimpleCsv(await readFile(windowViewPath, 'utf8'));
  const freezeRows = parseSimpleCsv(await readFile(freezeRankingPath, 'utf8'));
  const nightRows = parseSimpleCsv(await readFile(nightExecutionPath, 'utf8'));

  const summaryRows = [
    { Metric: 'Run time', Value: now.toISOString(), Notes: '' },
    { Metric: 'Freeze', Value: freezePath, Notes: '' },
    { Metric: 'Resolved strict tokens now', Value: strictNow, Notes: '' },
    { Metric: 'New resolved strict tokens last 24h', Value: strict24h, Notes: '' },
    { Metric: 'Events in freeze', Value: events, Notes: '' },
    { Metric: 'Newest resolved_at', Value: fmtDate(newestResolvedAt), Notes: '' },
    {
      Metric: 'Latest resolver',
      Value: latestResolver ? (latestResolver.status ?? 'N/A') : 'N/A',
      Notes: latestResolver
        ? `selected=${safeNum(latestResolver.diagnostics?.selected)} generated=${latestResolver.generated_count ?? 'N/A'} skipped=${latestResolver.rejected_count ?? 'N/A'}`
        : '',
    },
    {
      Metric: 'Latest signal-cache',
      Value: latestSignalCache ? (latestSignalCache.status ?? 'N/A') : 'N/A',
      Notes: latestSignalCache
        ? `generated=${latestSignalCache.generated_count ?? 'N/A'} skipped=${latestSignalCache.rejected_count ?? 'N/A'}`
        : '',
    },
    { Metric: 'Analyzer state', Value: fallback ? 'FALLBACK' : 'PASS', Notes: analyzerError ?? '' },
    { Metric: 'Email recipient', Value: EMAIL_RECIPIENT, Notes: '' },
    { Metric: 'Subject', Value: subject, Notes: '' },
    { Metric: 'Artifact', Value: reportPath, Notes: 'MORNING_REPORT.md' },
    { Metric: 'Artifact', Value: workbookPath, Notes: 'XLSX workbook with 6 analytical tabs' },
    { Metric: 'Notice', Value: 'Night-plan and alert emails are separate and should still send.', Notes: '' },
  ];

  await writeWorkbookXlsx(workbookPath, [
    { name: '00_Summary', headers: ['Metric', 'Value', 'Notes'], rows: summaryRows },
    { name: '01_Policy KPIs', headers: POLICY_HEADERS, rows: policyRows },
    { name: '02_Decision Board', headers: DECISION_HEADERS, rows: decisionRows },
    { name: '03_Bankroll', headers: BANKROLL_HEADERS, rows: bankrollRows },
    { name: '04_Window Models', headers: WINDOW_HEADERS, rows: windowRows },
    { name: '05_Freeze Ranking', headers: FREEZE_RANK_HEADERS, rows: freezeRows },
    { name: '06_Night Execution', headers: NIGHT_HEADERS, rows: nightRows },
  ]);

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
        text: reportText,
        html: `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(reportText)}</pre>`,
        attachments: [
          { filename: 'MORNING_REPORT.md', content: Buffer.from(reportText, 'utf8').toString('base64') },
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
