import { loadEnvConfig } from "@next/env";
import { spawnSync } from "child_process";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

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

const BASE_MODELING_DIR = path.resolve(
  process.cwd(),
  "modeling",
  "ice1_modeling_20260617_0800_minsk",
);
const SOURCE_ANALYZER = path.resolve(
  BASE_MODELING_DIR,
  "scripts",
  "analyze_ice1_freeze.py",
);

const INPUT_NAME = "resolved_freeze.csv";
const ANALYZER_INPUT_NAME = INPUT_NAME;
const REPORT_ROOT = path.resolve(process.cwd(), "modeling", "morning_model_report");

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
  null;

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

async function ensureAnalyzerCopy(reportDir: string): Promise<string> {
  const scriptDir = path.join(reportDir, "scripts");
  const analyzerPath = path.join(scriptDir, "analyze_ice1_freeze.py");
  await mkdir(scriptDir, { recursive: true });
  const src = await readFile(SOURCE_ANALYZER, "utf8");
  const patched = src.replace(
    /INPUT = BASE \/ "input" \/ "ice1_resolved_now_freeze_2026_06_17_0800_minsk\.csv"/,
    `INPUT = BASE / "input" / "${ANALYZER_INPUT_NAME}"`,
  );
  await writeFile(analyzerPath, patched, "utf8");
  return analyzerPath;
}

async function runAnalyzer(analyzerPath: string): Promise<void> {
  const py = spawnSync("python", [analyzerPath], {
    cwd: path.dirname(path.dirname(analyzerPath)),
    encoding: "utf8",
    stdio: "pipe",
  });
  if (py.status !== 0) {
    throw new Error((py.stderr || py.stdout || "analyzer failed").slice(0, 800));
  }
}

function rowToReportLine(r: Record<string, string>, keys: string[]): string {
  return keys.map((k) => `${k}=${r[k] ?? ""}`).join(" | ");
}

async function main() {
  loadEnvConfig(process.cwd());

  const now = new Date();
  const utcDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  const reportStamp = `${utcDate}_0600UTC`;
  const reportDir = path.join(REPORT_ROOT, reportStamp);
  const inputDir = path.join(reportDir, "input");
  const reportsDir = path.join(reportDir, "reports");
  const tablesDir = path.join(reportDir, "tables");
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
    const v = safeStr(r.formula_version) ?? "UNKNOWN";
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  const newestResolvedAt = canonicalRows.reduce<string | null>((latest, r) => {
    if (!latest) return safeStr(r.resolved_at);
    return parseIso(r.resolved_at) > parseIso(latest) ? safeStr(r.resolved_at) : latest;
  }, null);

  const freezePath = path.join(inputDir, INPUT_NAME);
  const headers = [
    "freeze_id", "row_id", "created_at", "resolved_at", "formula_version", "condition_id",
    "selected_token_id", "selected_outcome", "selected_side", "event_key", "market_slug",
    "event_slug", "sport_or_scope", "league", "market_family", "signal_result",
    "realized_return_pct", "signal_confidence_num", "data_coverage_num", "entry_price_num",
    "hours_until_start_num", "resolved_timing_bucket", "raw_json",
  ];
  const csvRows = canonicalRows.map((r) => {
    const rawJson = JSON.stringify(r);
    return {
      freeze_id: r.freeze_id ?? "",
      row_id: r.id ?? "",
      created_at: r.created_at ?? "",
      resolved_at: r.resolved_at ?? "",
      formula_version: r.formula_version ?? r.metric_formula_version ?? "",
      condition_id: r.condition_id ?? "",
      selected_token_id: r.selected_token_id ?? "",
      selected_outcome: r.selected_outcome ?? "",
      selected_side: r.selected_side ?? "",
      event_key: r.event_key ?? "",
      market_slug: r.market_slug ?? "",
      event_slug: r.event_slug ?? "",
      sport_or_scope: r.sport_or_scope ?? "",
      league: r.league ?? "",
      market_family: r.market_family ?? "",
      signal_result: r.signal_result ?? "",
      realized_return_pct: r.realized_return_pct ?? "",
      signal_confidence_num: r.signal_confidence_num ?? "",
      data_coverage_num: r.data_coverage_num ?? "",
      entry_price_num: r.entry_price_num ?? "",
      hours_until_start_num: r.hours_until_start_num ?? "",
      resolved_timing_bucket: r.resolved_timing_bucket ?? "",
      raw_json: rawJson,
    };
  });
  await writeCsv(freezePath, csvRows, headers);

  const analyzerPath = await ensureAnalyzerCopy(reportDir);
  await runAnalyzer(analyzerPath);

  const summaryMd = await readFile(path.join(reportsDir, "00_input_freeze_summary.md"), "utf8");
  const decisionCsv = await readFile(path.join(tablesDir, "decision_board.csv"), "utf8");
  const policyCsv = await readFile(path.join(tablesDir, "policy_kpis.csv"), "utf8");
  const bankrollCsv = await readFile(path.join(tablesDir, "bankroll_simulations.csv"), "utf8");
  const runSummary = JSON.parse(await readFile(path.join(tablesDir, "run_summary.json"), "utf8")) as Record<string, unknown>;

  const latestResolver = await fetchLatestJobRun("resolver");
  const latestSignalCache = await fetchLatestJobRun("polymarket");

  type PolicyRow = Record<string, string> & {
    policy: string;
    N: string;
    events: string;
    pnl10: string;
    roi: string;
    max_dd: string;
    pnl_dd: string;
    "7d_pnl10": string;
    "7d_roi": string;
    status: string;
  };

  const policyRows: PolicyRow[] = policyCsv.trim().split("\n").slice(1).map((line) => {
    const cols = line.split(",");
    return {
      policy: cols[0],
      N: cols[1],
      events: cols[2],
      pnl10: cols[6],
      roi: cols[7],
      max_dd: cols[10],
      pnl_dd: cols[11],
      "7d_pnl10": cols[23],
      "7d_roi": cols[24],
      status: cols[25],
    } as PolicyRow;
  });
  const pick = (name: string) => policyRows.find((r) => r.policy === name);
  const risk = pick("ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE") ?? policyRows[0];
  const raw = pick("SCORE_GE_65") ?? policyRows[0];
  const flat = pick("FLAT_ALL") ?? policyRows[0];
  const bad = pick("EXCLUDE_BAD_BUCKET_SCORE_GE_65") ?? policyRows[0];
  const selectedModels = [
    { model: "ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE", role: "main", row: pick("ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE") ?? risk },
    { model: "ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE", role: "main", row: pick("ONE_PER_EVENT_SCORE_GE_72_BEST_COVERAGE") ?? risk },
    { model: "ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE", role: "main", row: pick("ONE_PER_EVENT_SCORE_GE_72_AVOID_6_24H_BEST_COVERAGE") ?? risk },
    { model: "SCORE_GE_72", role: "baseline", row: pick("SCORE_GE_72") ?? risk },
    { model: "SCORE_GE_65", role: "raw-PnL", row: raw },
    { model: "EXCLUDE_BAD_BUCKET_SCORE_GE_65", role: "raw-PnL", row: bad },
    { model: "FLAT_ALL", role: "baseline", row: flat },
    { model: "FIREMODEL1_APPROX_CURRENT", role: "shadow", row: pick("FIREMODEL1_APPROX_CURRENT") ?? raw },
  ];

  const modelTable = [
    "| Model / Policy | Role | N | PnL @ $10 | ROI | MaxDD | PnL/DD | 24h ROI/PnL/N | 48h ROI/PnL/N | 72h ROI/PnL/N | 96h ROI/PnL/N | 7d ROI/PnL/N | Verdict |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |",
    ...selectedModels.map(({ model, role, row }) => {
      const verdict = safeStr(row.status) ?? "N/A";
      const n = row.N ?? "0";
      const pnl = fmtMoney(row.pnl10);
      const roi = row.roi ?? "N/A";
      const maxDd = fmtMoney(row.max_dd);
      const pnlDd = row.pnl_dd ?? "N/A";
      return [
        model,
        role,
        n,
        pnl,
        roi,
        maxDd,
        pnlDd,
        `${row["24h_roi"] ?? "N/A"} / ${fmtMoney(row["24h_pnl10"])} / ${row["24h_N"] ?? "0"}`,
        `${row["48h_roi"] ?? "N/A"} / ${fmtMoney(row["48h_pnl10"])} / ${row["48h_N"] ?? "0"}`,
        `${row["72h_roi"] ?? "N/A"} / ${fmtMoney(row["72h_pnl10"])} / ${row["72h_N"] ?? "0"}`,
        `${row["96h_roi"] ?? "N/A"} / ${fmtMoney(row["96h_pnl10"])} / ${row["96h_N"] ?? "0"}`,
        `${row["7d_roi"] ?? "N/A"} / ${fmtMoney(row["7d_pnl10"])} / ${row["7d_N"] ?? "0"}`,
        verdict,
      ].join(" | ");
    }),
  ].join("\n");

  const reportText = [
    "# Morning Model Recalculation Report",
    "",
    `Run time: ${now.toISOString()}`,
    `Freeze: ${freezePath}`,
    "",
    "## Corpus",
    `- Resolved strict tokens now: ${strictNow}`,
    `- New resolved strict tokens last 24h: ${strict24h}`,
    `- Events in freeze: ${events}`,
    `- Newest resolved_at: ${fmtDate(newestResolvedAt)}`,
    `- Formula counts: ${Object.entries(formulaCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    "",
    "## Latest Job Runs",
    `- Resolver: ${latestResolver ? `${latestResolver.status} @ ${fmtDate(latestResolver.started_at)} | selected=${safeNum(latestResolver.diagnostics?.selected)} | generated=${latestResolver.generated_count ?? "N/A"} | skipped=${latestResolver.rejected_count ?? "N/A"}` : "N/A"}`,
    `- Signal-cache: ${latestSignalCache ? `${latestSignalCache.status} @ ${fmtDate(latestSignalCache.started_at)} | generated=${latestSignalCache.generated_count ?? "N/A"} | skipped=${latestSignalCache.rejected_count ?? "N/A"}` : "N/A"}`,
    "",
    "## Model KPI Highlights",
    `- Best risk-adjusted: ${risk.policy} | N=${risk.N} | PnL=${fmtMoney(risk.pnl10)} | ROI=${risk.roi} | MaxDD=${fmtMoney(risk.max_dd)} | PnL/DD=${risk.pnl_dd} | 7d ROI=${risk["7d_roi"]}`,
    `- Best raw-PnL: ${raw.policy} | N=${raw.N} | PnL=${fmtMoney(raw.pnl10)} | ROI=${raw.roi} | MaxDD=${fmtMoney(raw.max_dd)} | PnL/DD=${raw.pnl_dd} | 7d ROI=${raw["7d_roi"]}`,
    `- Flat baseline: ${flat.policy} | N=${flat.N} | PnL=${fmtMoney(flat.pnl10)} | ROI=${flat.roi} | MaxDD=${fmtMoney(flat.max_dd)} | PnL/DD=${flat.pnl_dd}`,
    `- Bad-bucket guard: ${bad.policy} | N=${bad.N} | PnL=${fmtMoney(bad.pnl10)} | ROI=${bad.roi} | MaxDD=${fmtMoney(bad.max_dd)} | PnL/DD=${bad.pnl_dd}`,
    "",
    modelTable,
    "",
    "## Decision",
    `- Main model: ONE_PER_EVENT_SCORE_GE_72_BEST_SCORE`,
    `- Shadow model: SCORE_GE_65`,
    `- $300 stakes: $5 conservative / $7 balanced / $10 aggressive`,
    `- Price bucket note: 0.35-0.44 remains best; <0.35 is weak; 0.45-0.54 is mixed`,
    `- Trust warning: coverage/timing fields are not trusted if missing in the freeze`,
    `- What not to change: live executor, Ireland routing, resolver backfill behavior`,
    "",
    "## Night Battle Look",
    "Night execution detail table pending founder-provided format.",
    "",
    "## Analyzer Artifacts",
    summaryMd.trim(),
    "",
    "Decision board preview:",
    decisionCsv.split("\n").slice(0, 6).join("\n"),
  ].join("\n");

  const reportPath = path.join(reportsDir, "MORNING_REPORT.md");
  await writeFile(reportPath, reportText + "\n", "utf8");

  const html = `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5">${escapeHtml(
    reportText,
  )}</pre>`;
  const subject = `PolyProPicks Morning Model Report — ${now.toISOString().slice(0, 10)} — N=${strictNow}`;

  const summary = {
    reportDir,
    freezePath,
    strictNow,
    strict24h,
    events,
    newestResolvedAt,
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
    sendMode: DRY_RUN ? "dry-run" : SEND_TEST ? "send-test" : "dry-run",
    emailRecipient: EMAIL_RECIPIENT,
    subject,
    artifacts: {
      report: reportPath,
      freeze: freezePath,
      policyCsv: path.join(tablesDir, "policy_kpis.csv"),
      decisionCsv: path.join(tablesDir, "decision_board.csv"),
      bankrollCsv: path.join(tablesDir, "bankroll_simulations.csv"),
      runSummary: path.join(tablesDir, "run_summary.json"),
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!DRY_RUN && SEND_TEST) {
    if (!EMAIL_RECIPIENT) {
      throw new Error("No email recipient available. Pass --email=... or set NIGHT_PLAN_EMAIL_TO.");
    }
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey) throw new Error("RESEND_API_KEY missing");
    if (!from) throw new Error("EMAIL_FROM missing");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [EMAIL_RECIPIENT],
        subject,
        text: reportText,
        html,
        attachments: [
          { filename: "Morning_Model_Report.md", content: Buffer.from(reportText, "utf8").toString("base64") },
          {
            filename: "policy_kpis.csv",
            content: (await readFile(path.join(tablesDir, "policy_kpis.csv"))).toString("base64"),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
    }
    console.log(`[morning-model] Email sent to ${EMAIL_RECIPIENT}`);
  } else {
    console.log("[morning-model] Dry-run mode — no email sent.");
  }
}

main().catch((e) => {
  console.error("[morning-model] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
