// scripts/buildOpsReportXlsx.ts
// PolyProPicks — Daily Ops Report XLSX Builder (R1b: ExcelJS template approach)
// Loads approved CEO Dashboard v8 as template; updates dynamic cells only.
// Sheet 00: B6–B13, D17–G17 — live KPIs
// Sheet 01: rows 6–10 (C–K) FULL STRATEGIES + rows 14–22 (C–D) FEATURE BUILDING BLOCKS
// Sheet 02: fully static roadmap — no changes
// Sheets 03–13: clear and rebuild with live analytical data
// Export: buildOpsReportXlsx(input) → Promise<Buffer>

import ExcelJS from "exceljs";
import path from "path";

// ── Template path ──────────────────────────────────────────────────────────────

// ExcelJS-compatible version: namespace-normalized copy of the golden reference.
// Original: polypropicks_quant_ceo_dashboard_v8.xlsx (uses x: OOXML prefix).
// ExcelJS needs the default-namespace form; _exceljs.xlsx is generated with
// xmlns:x → xmlns and <x:element → <element normalization applied.
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../docs/ops-report-reference/polypropicks_quant_ceo_dashboard_v8_exceljs.xlsx",
);

// ── Exported types ─────────────────────────────────────────────────────────────

export interface XlsxWindowStats {
  total: number; won: number; lost: number; push: number;
  winRate: string; avgConf: string; avgReturn: string; totalReturn: string;
  confTotal: number; confWon: number; confLost: number; confWinRate: string; confMissing: number;
}

export interface XlsxSizingEntry {
  window: string; strategy: string;
  activeRows: number; pnl: string; roi: string; maxDD: string; worstDay: string; positiveDayShare: string;
}

export interface XlsxBenchmarkRow {
  window: string; score: string; n: number;
  spearman: string; q4roi: string; q1roi: string; spread: string;
}

export interface XlsxRow {
  id: string;
  created_at: string;
  resolved_at: string | null;
  signal_result: string | null;
  event_slug: string | null;
  selected_outcome: string | null;
  signal_confidence_num: number | null;
  realized_return_pct: number | null;
  premium_signal: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
}

export interface OpsReportXlsxInput {
  // Metadata
  reportDate: string;
  generatedAt: string;
  headShort: string;
  localMatchesOrigin: boolean;
  // Feed
  feedAgeMins: number | null;
  feedCacheStatus: string | null;
  feedPairsCount: number;
  feedConfGe70: number;
  // Cron
  cronAgeMins: number | null;
  cronStatus: string | null;
  resolverCronAgeMins: number | null;
  resolverCronStatus: string | null;
  // Dedup
  dedupRawCount: number;
  dedupUniqueCount: number;
  backlogUniqueCount: number | null;
  // Performance windows (pre-computed)
  stats24: XlsxWindowStats; stats48: XlsxWindowStats; stats72: XlsxWindowStats;
  stats7d: XlsxWindowStats; statsAllTime: XlsxWindowStats;
  // Raw rows (for analytical sheets)
  rows24: XlsxRow[]; rows72: XlsxRow[]; rows7d: XlsxRow[]; rowsAllTime: XlsxRow[];
  // Timing / family pre-computed lookups
  timingEntries: { rowId: string; phaseProxy: string; minutesUntil: number | null }[];
  familyEntries: { rowId: string; family: string }[];
  // M3-B sizing (pre-computed)
  sizingEntries: XlsxSizingEntry[];
  SCOREC_B25_LOCKED_Q25: number;
  m3bScoreCQ25: number | null;
  m3bTrainN: number;
  // Score benchmarks (pre-computed in daily-ops-report.ts)
  scoreBenchmarks: XlsxBenchmarkRow[];
  componentBenchmarks: XlsxBenchmarkRow[];
  // M3-B counters (pre-computed)
  m3bSmFallback: number; m3bPwFallback: number;
  m3bCovMissing: number; m3bCovNone: number; m3bCovLow: number;
  m3bCovMedium: number; m3bCovHigh: number; m3bCovUnexpected: number;
  m3bSelCashAvail: number; m3bSelCntAvail: number;
  m3bTotCntAvail: number; m3bOppCntDerivable: number;
  // Red flags
  redFlags: string[];
}

// ── Local helpers ─────────────────────────────────────────────────────────────

function safeN(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function safeS(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function winR(won: number, lost: number): string {
  if (won + lost === 0) return "N/A";
  return `${Math.round((won / (won + lost)) * 1000) / 10}%`;
}

function avgR(vals: (number | null)[]): string {
  const nums = vals.filter((v): v is number => v !== null);
  if (!nums.length) return "N/A";
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return `${Math.round(avg * 10) / 10}%`;
}

function totR(vals: (number | null)[]): string {
  const nums = vals.filter((v): v is number => Number.isFinite(v));
  if (!nums.length) return "N/A";
  const t = nums.reduce((s, v) => s + v, 0);
  const r = Math.round(t * 10) / 10;
  return `${r > 0 ? "+" : ""}${r}%`;
}

const PUSH_SET = new Set(["push", "refund", "tie", "void", "cancelled", "no_contest"]);

function extractConf(row: XlsxRow): number | null {
  return (
    safeN(row.signal_confidence_num) ??
    safeN(row.premium_signal?.winProbability) ??
    safeN(row.premium_signal?.signalConfidence) ??
    safeN(row.premium_signal?.displaySignalConfidence)
  );
}

function getConfBand(conf: number | null): string {
  if (conf === null) return "Missing";
  if (conf >= 80) return "80+";
  if (conf >= 70) return "70–79";
  if (conf >= 60) return "60–69";
  return "<60";
}

function getOddsBand(row: XlsxRow): string {
  return safeS(row.premium_signal?.oddsBandLabel) ?? "ABSENT";
}

function getActionLbl(row: XlsxRow): string {
  const d = row.diagnostics;
  const audit = d ? (d.formulaAudit as Record<string, unknown> | undefined) : undefined;
  return safeS(audit?.action ?? row.premium_signal?.actionLabel) ?? "ABSENT";
}

function deriveLeague(row: XlsxRow): string {
  const lg = safeS(row.premium_signal?.league);
  if (lg) return lg;
  const t = (safeS(row.event_slug) ?? "").toLowerCase();
  if (/\blol\b|lck|lpl|league of legends/.test(t)) return "Esports";
  if (/valorant|cs2|dota|esport|gaming/.test(t)) return "Esports";
  if (/nba|wnba|basketball/.test(t)) return "NBA";
  if (/nhl|hockey/.test(t)) return "NHL";
  if (/nfl|super bowl/.test(t)) return "NFL";
  if (/mlb|baseball/.test(t)) return "MLB";
  if (/atp|wta|tennis/.test(t)) return "Tennis";
  if (/soccer|premier league|la liga|bundesliga|mls|copa|champions/.test(t)) return "Soccer";
  return "Other";
}

function getCovBand(cov: number | null): string {
  if (cov == null) return "missing";
  if (cov === 0) return "none";
  if (cov === 25) return "low";
  if (cov === 50) return "medium";
  if (cov >= 75) return "high";
  return "unexpected";
}

interface BdRow {
  total: number; won: number; lost: number; push: number; returns: (number | null)[];
}

function computeBd(rows: XlsxRow[], keyFn: (r: XlsxRow) => string): Map<string, BdRow> {
  const m = new Map<string, BdRow>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { total: 0, won: 0, lost: 0, push: 0, returns: [] });
    const b = m.get(k)!;
    b.total++;
    if (r.signal_result === "won") b.won++;
    else if (r.signal_result === "lost") b.lost++;
    else if (PUSH_SET.has(r.signal_result ?? "")) b.push++;
    b.returns.push(safeN(r.realized_return_pct));
  }
  return m;
}

// ── Strategy stats helper (for Sheet 01 live computation) ─────────────────────

interface StratStats {
  n: number; won: number; lost: number;
  wr: number;     // win rate (decimal, 3dp)
  roi: number;    // ROI on turnover (decimal, 3dp)
  pnl: number;    // PnL at $10/row (1dp)
  maxDD: number;  // Max drawdown in $ (negative or zero, 1dp)
  streak: number; // Worst consecutive loss streak
}

function computeStratStats(rows: XlsxRow[], stake = 10): StratStats {
  let won = 0, lost = 0;
  let totalPnl = 0;
  let maxDD = 0, peak = 0, cumPnl = 0;
  let worstStreak = 0, curStreak = 0;

  for (const r of rows) {
    const ret = safeN(r.realized_return_pct);

    if (r.signal_result === "won") { won++; curStreak = 0; }
    else if (r.signal_result === "lost") {
      lost++;
      curStreak++;
      if (curStreak > worstStreak) worstStreak = curStreak;
    } else { curStreak = 0; }

    if (ret !== null) {
      const p = (ret / 100) * stake;
      totalPnl += p;
      cumPnl += p;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }
  }

  const n = rows.length;
  const roi = n > 0 ? totalPnl / (n * stake) : 0;
  const wr = won + lost > 0 ? won / (won + lost) : 0;

  return {
    n,
    won,
    lost,
    wr: Math.round(wr * 1000) / 1000,
    roi: Math.round(roi * 1000) / 1000,
    pnl: Math.round(totalPnl * 10) / 10,
    maxDD: -Math.round(maxDD * 10) / 10,  // negative (drawdown is a loss)
    streak: worstStreak,
  };
}

// Shorten a dollar string: "$92.36" → "+$92", "$159.6" → "$160" (full precision trimmed)
function shortDollar(s: string | undefined): string {
  if (!s || s === "N/A") return "N/A";
  const m = s.match(/^([^\d]*)([\d.]+)/);
  if (!m) return s;
  const prefix = m[1]; // e.g. "$" or "+$"
  return `${prefix}${Math.round(parseFloat(m[2]))}`;
}

// Add "+" sign to a numeric string if it's positive (e.g. "10%" → "+10%", "$240" → "+$240")
function addPlusSign(s: string | undefined): string {
  if (!s || s === "N/A") return s ?? "N/A";
  // Already has sign: starts with "+" or "−" or "-"
  if (s.startsWith("+") || s.startsWith("−") || s.startsWith("-")) return s;
  // Has dollar sign first: "$240" → "+$240"
  if (s.startsWith("$")) return `+${s}`;
  // Plain number or percent: "10%" → "+10%"
  return `+${s}`;
}

// Format MaxDD as negative dollar: "159.6" → "−$159.6", "$159.6" → "−$159.6"
function negDollar(s: string | undefined): string {
  if (!s || s === "N/A") return s ?? "N/A";
  // Strip leading "$" if present
  const num = s.replace(/^\$/, "");
  return `−$${num}`; // Unicode minus + dollar + value
}

// ── Style constants (for analytical sheets 03–13) ────────────────────────────

const H_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF1F4E79" } };
const S_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FF2E75B6" } };
const A_FILL = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFDAE3F3" } };
const H_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
const S_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
const D_FONT = { size: 9 };

type CellVal = string | number | null | undefined;

function hdrRow(ws: ExcelJS.Worksheet, values: CellVal[], colWidths?: number[]): void {
  const row = ws.addRow(values);
  row.font = H_FONT;
  row.fill = H_FILL as ExcelJS.Fill;
  if (colWidths) colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: "frozen", ySplit: 1, showGridLines: false, workbookViewId: 0 }];
}

function secRow(ws: ExcelJS.Worksheet, label: string, cols: number): void {
  ws.addRow([]);
  const r = ws.addRow([label]);
  r.font = S_FONT;
  r.fill = S_FILL as ExcelJS.Fill;
  if (cols > 1) ws.mergeCells(r.number, 1, r.number, cols);
}

function dataRow(ws: ExcelJS.Worksheet, values: CellVal[], alt: boolean): void {
  const r = ws.addRow(values);
  if (alt) r.fill = A_FILL as ExcelJS.Fill;
  r.font = D_FONT;
}

// ── Sheet 00: update live KPI cells ───────────────────────────────────────────

function updateSheet00(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  // Find Flat-$10 All-time sizing entry (FLAT-KNOWN strategy)
  const flatAll = i.sizingEntries.find(
    e => e.window === "All time" && e.strategy.includes("FLAT-KNOWN"),
  );

  // B6–B13: live KPIs (set as strings to match template inlineStr type)
  // computeSizingStats formats: roi = "10%", pnl = "$240.3", maxDD = "$159.6" (all unsigned)
  ws.getCell("B6").value = String(i.statsAllTime.total);
  ws.getCell("B7").value = String(i.dedupUniqueCount);
  ws.getCell("B8").value = addPlusSign(flatAll?.roi ?? i.statsAllTime.totalReturn); // "+10%"
  ws.getCell("B9").value = addPlusSign(flatAll?.pnl ?? "N/A");                      // "+$240.3"
  ws.getCell("B10").value = negDollar(flatAll?.maxDD ?? "N/A");                     // "−$159.6"

  // B11: Score ↔ Return Spearman ρ (from pre-computed scoreBenchmarks)
  const spRow = i.scoreBenchmarks.find(
    b => b.window === "All time" && b.score.includes("PROD-RAW"),
  );
  ws.getCell("B11").value = spRow?.spearman ?? "N/A";

  // B12: 24h additive return (already formatted by statsWindowFmt with sign)
  ws.getCell("B12").value = i.stats24.totalReturn;

  // B13: P0 blockers — compact summary from red flags
  ws.getCell("B13").value =
    i.redFlags.length === 0
      ? "✅ No P0 blockers"
      : i.redFlags.slice(0, 2).join(" · ");

  // D17/E17/F17/G17: PROD v1.1 row — N, ROI (with sign), PnL (short, signed), MaxDD (short, neg)
  ws.getCell("D17").value = String(i.dedupUniqueCount);
  ws.getCell("E17").value = addPlusSign(flatAll?.roi ?? i.statsAllTime.totalReturn); // "+10%"
  ws.getCell("F17").value = addPlusSign(shortDollar(flatAll?.pnl));                  // "+$240"
  ws.getCell("G17").value = negDollar(shortDollar(flatAll?.maxDD));                  // "−$160"
}

// ── Sheet 01: update FULL STRATEGIES rows 6–10 and FEATURE BLOCKS rows 14–22 ──

function updateSheet01(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  const fLookup = new Map(i.familyEntries.map(e => [e.rowId, e.family]));
  const tLookup = new Map(i.timingEntries.map(e => [e.rowId, e]));

  // ── A. FULL STRATEGIES: rows 6–10 (cols C–K) ──────────────────────────────

  // Row 10 (Baseline: all rowsAllTime) — computed first for Δ ROI
  const baseStats = computeStratStats(i.rowsAllTime);

  // [rowNumber, filteredRows | null (null = skip, leave template values)]
  const stratDefs: Array<[number, XlsxRow[] | null]> = [
    // Row 6: Exclude Longshot Value + legacy ABSENT labels
    [6, i.rowsAllTime.filter(r =>
      getOddsBand(r) !== "Longshot Value" &&
      getOddsBand(r) !== "High-Upside Longshot" &&
      getActionLbl(r) !== "ABSENT")],
    // Row 7: One-per-event dedup — cannot compute live; keep template values
    [7, null],
    // Row 8: Score ≥ 68
    [8, i.rowsAllTime.filter(r => { const c = extractConf(r); return c !== null && c >= 68; })],
    // Row 9: Score ≥ 72
    [9, i.rowsAllTime.filter(r => { const c = extractConf(r); return c !== null && c >= 72; })],
    // Row 10: Baseline (all rowsAllTime)
    [10, i.rowsAllTime],
  ];

  for (const [rowNum, rows] of stratDefs) {
    if (rows === null) continue; // Row 7: leave golden-reference values intact

    const s = computeStratStats(rows);
    const delta = rowNum === 10 ? 0 : Math.round((s.roi - baseStats.roi) * 1000) / 1000;

    ws.getCell(`C${rowNum}`).value = s.n;
    ws.getCell(`D${rowNum}`).value = s.won;
    ws.getCell(`E${rowNum}`).value = s.lost;
    ws.getCell(`F${rowNum}`).value = s.wr;
    ws.getCell(`G${rowNum}`).value = s.roi;
    ws.getCell(`H${rowNum}`).value = s.pnl;
    ws.getCell(`I${rowNum}`).value = s.maxDD;
    ws.getCell(`J${rowNum}`).value = s.streak;
    ws.getCell(`K${rowNum}`).value = delta;
  }

  // ── B. FEATURE BUILDING BLOCKS: rows 14–22 (cols C & D) ──────────────────

  // Returns { n, roi } from rows
  const fb = (rows: XlsxRow[]) => {
    const s = computeStratStats(rows);
    return { n: s.n, roi: s.roi };
  };

  // Row 14: Action profile / ENTER only
  const r14 = fb(i.rowsAllTime.filter(r => getActionLbl(r) === "ENTER"));
  ws.getCell("C14").value = r14.n;
  ws.getCell("D14").value = r14.roi;

  // Row 15: Odds label risk / Longshot Value only
  const r15 = fb(i.rowsAllTime.filter(r => getOddsBand(r) === "Longshot Value"));
  ws.getCell("C15").value = r15.n;
  ws.getCell("D15").value = r15.roi;

  // Row 16: Market-family risk / totals family
  const r16 = fb(i.rowsAllTime.filter(r =>
    (fLookup.get(r.id) ?? "unknown") === "totals"));
  ws.getCell("C16").value = r16.n;
  ws.getCell("D16").value = r16.roi;

  // Row 17: Odds sweet spot / entry price 0.35–0.44
  const r17 = fb(i.rowsAllTime.filter(r => {
    const p = safeN(r.premium_signal?.winProbability) ??
              safeN(r.premium_signal?.selectedPrice) ??
              safeN(r.premium_signal?.price);
    return p !== null && p >= 0.35 && p <= 0.44;
  }));
  ws.getCell("C17").value = r17.n;
  ws.getCell("D17").value = r17.roi;

  // Row 18: Flow top-tail / Max Trade ≥ $25K
  const r18 = fb(i.rowsAllTime.filter(r =>
    (safeN(r.diagnostics?.maxTradeCash) ?? 0) >= 25000));
  ws.getCell("C18").value = r18.n;
  ws.getCell("D18").value = r18.roi;

  // Row 19: Flow top-tail / Recent Volume ≥ $50K
  const r19 = fb(i.rowsAllTime.filter(r =>
    (safeN(r.diagnostics?.recentTradeCash) ?? 0) >= 50000));
  ws.getCell("C19").value = r19.n;
  ws.getCell("D19").value = r19.roi;

  // Row 20: Timing proxy / prematch 15–59m before event
  const r20 = fb(i.rowsAllTime.filter(r => {
    const e = tLookup.get(r.id);
    return (
      e?.phaseProxy === "prematch_proxy" &&
      e?.minutesUntil !== null &&
      e.minutesUntil >= 15 &&
      e.minutesUntil <= 59
    );
  }));
  ws.getCell("C20").value = r20.n;
  ws.getCell("D20").value = r20.roi;

  // Row 21: Coverage reliability / Coverage ≥ 75
  const r21 = fb(i.rowsAllTime.filter(r =>
    (safeN(r.diagnostics?.dataCoverage) ?? -1) >= 75));
  ws.getCell("C21").value = r21.n;
  ws.getCell("D21").value = r21.roi;

  // Row 22: Cross interaction / Score 80+ × price 0.45–0.54
  const r22 = fb(i.rowsAllTime.filter(r => {
    const conf = extractConf(r);
    const p = safeN(r.premium_signal?.winProbability) ??
              safeN(r.premium_signal?.selectedPrice) ??
              safeN(r.premium_signal?.price);
    return conf !== null && conf >= 80 && p !== null && p >= 0.45 && p <= 0.54;
  }));
  ws.getCell("C22").value = r22.n;
  ws.getCell("D22").value = r22.roi;
}

// ── Analytical sheet builders (accept existing ws, called after spliceRows) ───

function buildSheet03(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws, ["League", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [18, 10, 8, 8, 8, 10, 14, 14]);

  for (const [wlbl, wrows] of [
    ["24h", i.rows24], ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `LEAGUE BREAKDOWN — ${wlbl}`, 8);
    const lgMap = computeBd(wrows, deriveLeague);
    let alt = false;
    [...lgMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([lg, b]) => {
      dataRow(ws, [lg, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    });
  }
}

function buildSheet04(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws, ["Band", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [14, 10, 8, 8, 8, 10, 14, 14]);

  const BAND_ORDER = ["80+", "70–79", "60–69", "<60", "Missing"];

  for (const [wlbl, wrows] of [
    ["24h", i.rows24], ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `CONFIDENCE BAND — ${wlbl}`, 8);
    const bMap = computeBd(wrows, r => getConfBand(extractConf(r)));
    let alt = false;
    const allKeys = [...new Set([...BAND_ORDER, ...bMap.keys()])];
    for (const band of allKeys) {
      const b = bMap.get(band);
      if (!b) continue;
      dataRow(ws, [band, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    }
  }
}

function buildSheet05(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  const tot = i.rowsAllTime.length;
  const pct = (n: number) => tot > 0 ? `${Math.round((n / tot) * 100)}%` : "N/A";

  hdrRow(ws, ["Evidence Dimension", "Count", "%"], [48, 10, 10]);
  secRow(ws, "M3-B SOURCE TRUTH COUNTERS — ALL TIME", 3);

  const counters: [string, number][] = [
    ["Total resolved (deduped)", tot],
    ["SmartMoney fallback (maxTC+recTC both null)", i.m3bSmFallback],
    ["PubWhale fallback (selCnt=0 or recTC null)", i.m3bPwFallback],
    ["Coverage missing", i.m3bCovMissing],
    ["Coverage none (=0)", i.m3bCovNone],
    ["Coverage low (=25)", i.m3bCovLow],
    ["Coverage medium (=50)", i.m3bCovMedium],
    ["Coverage high (=75 or 100)", i.m3bCovHigh],
    ["Coverage unexpected", i.m3bCovUnexpected],
    ["Selected cash available (recentTradeCash non-null)", i.m3bSelCashAvail],
    ["Selected count available (selectedTradeCount non-null)", i.m3bSelCntAvail],
    ["Total count available (totalTradeCount non-null)", i.m3bTotCntAvail],
    ["Opposing count derivable", i.m3bOppCntDerivable],
    ["Opposing cash available", 0],
  ];
  counters.forEach(([dim, cnt], idx) => {
    dataRow(ws, [dim, cnt, idx === 0 ? "100%" : pct(cnt)], idx % 2 === 0);
  });

  secRow(ws, "MAX TRADE CASH DISTRIBUTION — all-time non-null rows", 3);
  const mtcVals = i.rowsAllTime
    .map(r => safeN(r.diagnostics?.maxTradeCash))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (mtcVals.length > 0) {
    const n = mtcVals.length;
    const mean = mtcVals.reduce((s, v) => s + v, 0) / n;
    const med = n % 2 === 0 ? (mtcVals[n / 2 - 1] + mtcVals[n / 2]) / 2 : mtcVals[Math.floor(n / 2)];
    const distRows: [string, number][] = [
      ["N (non-null)", n],
      ["Mean", Math.round(mean)],
      ["Median", Math.round(med)],
      ["P25", Math.round(mtcVals[Math.floor(n * 0.25)])],
      ["P75", Math.round(mtcVals[Math.floor(n * 0.75)])],
      ["Max", Math.round(mtcVals[n - 1])],
    ];
    distRows.forEach(([k, v], idx) => dataRow(ws, [k, v, ""], idx % 2 === 0));
  } else {
    dataRow(ws, ["No non-null maxTradeCash rows", 0, ""], false);
  }
}

function buildSheet06(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws, ["Metric", "Value", "Notes"], [48, 28, 28]);
  secRow(ws, "M3-C DIRECTIONAL FLOW COUNTERS — ALL TIME (derived from raw diagnostics)", 3);

  let versionN = 0, exact = 0, partial = 0, absent = 0, nonBin = 0;
  let selCashN = 0, oppCashN = 0, bothCashN = 0;
  const cashImb: number[] = [];
  const countImb: number[] = [];

  for (const r of i.rowsAllTime) {
    const d = r.diagnostics;
    if (!d) continue;
    if (!safeS(d.directionalFlowVersion as unknown)) continue;
    versionN++;
    const state = safeS(d.directionalFlowEvidenceState as unknown) ?? "";
    if (state === "exact") exact++;
    else if (state === "partial") partial++;
    else if (state === "absent") absent++;
    else if (state === "non_binary") nonBin++;
    const selC = safeN(d.selectedSideExactRecentCash as unknown);
    const oppC = safeN(d.opposingSideExactRecentCash as unknown);
    const selCnt = safeN(d.selectedSideExactTradeCount as unknown);
    const oppCnt = safeN(d.opposingSideExactTradeCount as unknown);
    if (selC !== null) selCashN++;
    if (oppC !== null) oppCashN++;
    if (selC !== null && oppC !== null) {
      bothCashN++;
      cashImb.push((selC - oppC) / Math.max(selC + oppC, 1e-9));
    }
    if (selCnt !== null && oppCnt !== null)
      countImb.push((selCnt - oppCnt) / Math.max(selCnt + oppCnt, 1));
  }

  const statStr = (arr: number[]) => {
    if (!arr.length) return "N=0";
    const s = [...arr].sort((a, b) => a - b);
    const n = s.length;
    const mean = s.reduce((x, v) => x + v, 0) / n;
    const med = n % 2 === 0 ? (s[n / 2 - 1] + s[n / 2]) / 2 : s[Math.floor(n / 2)];
    const f = (v: number) => `${Math.round(v * 1000) / 1000}`;
    return `N=${n} mean=${f(mean)} median=${f(med)}`;
  };

  const m3cRows: [string, string | number][] = [
    ["Rows with directionalFlowVersion", versionN],
    ["State: exact", exact],
    ["State: partial", partial],
    ["State: absent", absent],
    ["State: non_binary", nonBin],
    ["Selected-side exact cash available", selCashN],
    ["Opposing-side exact cash available", oppCashN],
    ["Both-side exact cash available", bothCashN],
    ["CashImbalance stats", statStr(cashImb)],
    ["CountImbalance stats", statStr(countImb)],
  ];
  m3cRows.forEach(([k, v], idx) => dataRow(ws, [k, v, ""], idx % 2 === 0));

  secRow(ws, "RECENT TRADE CASH DISTRIBUTION — all-time non-null rows", 3);
  const rtcVals = i.rowsAllTime
    .map(r => safeN(r.diagnostics?.recentTradeCash))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (rtcVals.length > 0) {
    const n = rtcVals.length;
    const mean = rtcVals.reduce((s, v) => s + v, 0) / n;
    const med = n % 2 === 0 ? (rtcVals[n / 2 - 1] + rtcVals[n / 2]) / 2 : rtcVals[Math.floor(n / 2)];
    const distRows: [string, number][] = [
      ["N (non-null)", n],
      ["Mean", Math.round(mean)],
      ["Median", Math.round(med)],
      ["P25", Math.round(rtcVals[Math.floor(n * 0.25)])],
      ["P75", Math.round(rtcVals[Math.floor(n * 0.75)])],
      ["Max", Math.round(rtcVals[n - 1])],
    ];
    distRows.forEach(([k, v], idx) => dataRow(ws, [k, v, ""], idx % 2 === 0));
  } else {
    dataRow(ws, ["No non-null recentTradeCash rows", 0, ""], false);
  }
}

function buildSheet07(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Phase / Cohort", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 20, 10, 8, 8, 8, 10, 14, 14]);

  const tLookup = new Map(i.timingEntries.map(e => [e.rowId, e]));

  const filterPhase = (rows: XlsxRow[], phase: string) =>
    rows.filter(r => (tLookup.get(r.id)?.phaseProxy ?? "unknown") === phase);

  const filterCohort = (rows: XlsxRow[], minM: number, maxM: number) =>
    rows.filter(r => {
      const e = tLookup.get(r.id);
      if (!e || e.phaseProxy !== "prematch_proxy" || e.minutesUntil === null) return false;
      return e.minutesUntil >= minM && e.minutesUntil <= maxM;
    });

  const compS = (rows: XlsxRow[]) => {
    let won = 0, lost = 0, push = 0;
    const rets: (number | null)[] = [];
    for (const r of rows) {
      if (r.signal_result === "won") won++;
      else if (r.signal_result === "lost") lost++;
      else if (PUSH_SET.has(r.signal_result ?? "")) push++;
      rets.push(safeN(r.realized_return_pct));
    }
    return { total: rows.length, won, lost, push, wR: winR(won, lost), aR: avgR(rets), tR: totR(rets) };
  };

  for (const [wlbl, wrows] of [
    ["24h", i.rows24], ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `PHASE PROXY — ${wlbl}`, 9);
    for (const phase of ["prematch_proxy", "live_proxy", "unknown"]) {
      const s = compS(filterPhase(wrows, phase));
      dataRow(ws, [wlbl, phase, s.total, s.won, s.lost, s.push, s.wR, s.aR, s.tR], phase === "live_proxy");
    }
    secRow(ws, `TIMING COHORTS (prematch only) — ${wlbl}`, 9);
    const cohorts: [string, XlsxRow[]][] = [
      ["<15m", filterCohort(wrows, 0, 14)],
      ["15–59m", filterCohort(wrows, 15, 59)],
      ["60–119m", filterCohort(wrows, 60, 119)],
      ["120m+", filterCohort(wrows, 120, 999_999)],
    ];
    cohorts.forEach(([lbl, crows], idx) => {
      const s = compS(crows);
      dataRow(ws, [wlbl, lbl, s.total, s.won, s.lost, s.push, s.wR, s.aR, s.tR], idx % 2 === 0);
    });
  }
}

function buildSheet08(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Family", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 22, 10, 8, 8, 8, 10, 14, 14]);

  const fLookup = new Map(i.familyEntries.map(e => [e.rowId, e.family]));

  for (const [wlbl, wrows] of [
    ["24h", i.rows24], ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `MARKET FAMILY — ${wlbl}`, 9);
    const fMap = computeBd(wrows, r => fLookup.get(r.id) ?? "unknown");
    let alt = false;
    [...fMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([fam, b]) => {
      dataRow(ws, [wlbl, fam, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    });
  }
}

function buildSheet09(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Odds Band", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 24, 10, 8, 8, 8, 10, 14, 14]);

  const BAND_ORDER = ["Strong Favorite", "Favorite Edge", "Core Signal", "Value Lean",
    "Underdog Value", "Longshot Value", "High-Upside Longshot", "ABSENT"];

  for (const [wlbl, wrows] of [
    ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `ODDS BAND — ${wlbl}`, 9);
    const bMap = computeBd(wrows, getOddsBand);
    let alt = false;
    const allKeys = [...new Set([...BAND_ORDER, ...bMap.keys()])];
    for (const band of allKeys) {
      const b = bMap.get(band);
      if (!b) continue;
      dataRow(ws, [wlbl, band, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    }
  }
}

function buildSheet10(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Action", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 22, 10, 8, 8, 8, 10, 14, 14]);

  const ACT_ORDER = ["ENTER", "SMALL", "LIGHT ENTRY", "WATCH", "ABSENT"];

  for (const [wlbl, wrows] of [
    ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `ACTION LABEL — ${wlbl}`, 9);
    const aMap = computeBd(wrows, getActionLbl);
    let alt = false;
    const allKeys = [...new Set([...ACT_ORDER, ...aMap.keys()])];
    for (const act of allKeys) {
      const b = aMap.get(act);
      if (!b) continue;
      dataRow(ws, [wlbl, act, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    }
  }
}

function buildSheet11(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Label", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 28, 10, 8, 8, 8, 10, 14, 14]);

  const extractLabel = (row: XlsxRow): string => {
    const cl = safeS(row.premium_signal?.confidenceLabel);
    if (cl) return cl;
    const ol = safeS(row.premium_signal?.oddsBandLabel);
    if (ol) return ol;
    const conf = extractConf(row);
    return conf !== null ? `Band:${getConfBand(conf)}` : "Unknown";
  };

  for (const [wlbl, wrows] of [
    ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `SIGNAL LABEL — ${wlbl}`, 9);
    const lMap = computeBd(wrows, extractLabel);
    let alt = false;
    [...lMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([lbl, b]) => {
      dataRow(ws, [wlbl, lbl, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    });
  }
}

function buildSheet12(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Window", "Coverage Band", "Total", "Won", "Lost", "Push", "Win%", "AvgReturn", "TotalReturn"],
    [12, 18, 10, 8, 8, 8, 10, 14, 14]);

  const COV_ORDER = ["missing", "none", "low", "medium", "high", "unexpected"];

  for (const [wlbl, wrows] of [
    ["72h", i.rows72], ["7d", i.rows7d], ["All time", i.rowsAllTime],
  ] as [string, XlsxRow[]][]) {
    secRow(ws, `COVERAGE BAND — ${wlbl}`, 9);
    const cMap = computeBd(wrows, r => getCovBand(safeN(r.diagnostics?.dataCoverage)));
    let alt = false;
    const allKeys = [...new Set([...COV_ORDER, ...cMap.keys()])];
    for (const band of allKeys) {
      const b = cMap.get(band);
      if (!b) continue;
      dataRow(ws, [wlbl, band, b.total, b.won, b.lost, b.push, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
      alt = !alt;
    }
  }
}

function buildSheet13(ws: ExcelJS.Worksheet, i: OpsReportXlsxInput): void {
  hdrRow(ws,
    ["Odds Band", "Conf Band", "Total", "Won", "Lost", "Win%", "AvgReturn", "TotalReturn"],
    [24, 14, 10, 8, 8, 10, 14, 14]);

  secRow(ws, "CROSS: ODDS BAND × CONFIDENCE BAND — All time", 8);
  const crossMap = computeBd(i.rowsAllTime, r => `${getOddsBand(r)}||${getConfBand(extractConf(r))}`);
  let alt = false;
  [...crossMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([k, b]) => {
    const [ob, cb] = k.split("||");
    dataRow(ws, [ob, cb, b.total, b.won, b.lost, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
    alt = !alt;
  });

  secRow(ws, "CROSS: ACTION × ODDS BAND — All time", 8);
  const actMap = computeBd(i.rowsAllTime, r => `${getActionLbl(r)}||${getOddsBand(r)}`);
  alt = false;
  [...actMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([k, b]) => {
    const [act, ob] = k.split("||");
    dataRow(ws, [ob, act, b.total, b.won, b.lost, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
    alt = !alt;
  });

  secRow(ws, "CROSS: ACTION × CONFIDENCE BAND — All time", 8);
  const actConfMap = computeBd(i.rowsAllTime, r => `${getActionLbl(r)}||${getConfBand(extractConf(r))}`);
  alt = false;
  [...actConfMap.entries()].sort((a, b) => b[1].total - a[1].total).forEach(([k, b]) => {
    const [act, cb] = k.split("||");
    dataRow(ws, [act, cb, b.total, b.won, b.lost, winR(b.won, b.lost), avgR(b.returns), totR(b.returns)], alt);
    alt = !alt;
  });
}

// ── Score benchmarks sheet (new sheet 02-style data — now inside sheet 02 of the template) ──
// Note: Sheet 02 ("02_Next Models") is fully static in the template — NO changes applied.
// Score benchmark data is available for analytical review on sheets 03–13.

// ── Main export ────────────────────────────────────────────────────────────────

export async function buildOpsReportXlsx(input: OpsReportXlsxInput): Promise<Buffer> {
  // Load approved v8 golden reference as ExcelJS template
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  // ── Sheet 00: update live KPI cells (B6–B13, D17–G17) ──────────────────────
  const ws00 = wb.getWorksheet("00_CEO Dashboard");
  if (ws00) {
    updateSheet00(ws00, input);
  } else {
    console.error("[ops-xlsx] ⚠️  Sheet '00_CEO Dashboard' not found in template");
  }

  // ── Sheet 01: update FULL STRATEGIES + FEATURE BUILDING BLOCKS cells ────────
  const ws01 = wb.getWorksheet("01_Shadow Strategies");
  if (ws01) {
    updateSheet01(ws01, input);
  } else {
    console.error("[ops-xlsx] ⚠️  Sheet '01_Shadow Strategies' not found in template");
  }

  // ── Sheet 02: fully static — no changes ────────────────────────────────────

  // ── Sheets 03–13: clear existing content and rebuild with live data ─────────
  const analyticalDefs: Array<[string, (ws: ExcelJS.Worksheet, i: OpsReportXlsxInput) => void]> = [
    ["03_Category Summary",    buildSheet03],
    ["04_Score Calibration",   buildSheet04],
    ["05_Max Trade Proxy",     buildSheet05],
    ["06_Recent Volume Proxy", buildSheet06],
    ["07_Timing Proxy OBS",    buildSheet07],
    ["08_Market Families",     buildSheet08],
    ["09_Odds Bands",          buildSheet09],
    ["10_Action Profiles",     buildSheet10],
    ["11_Odds Label Profiles", buildSheet11],
    ["12_Coverage Bands",      buildSheet12],
    ["13_Cross Score-Odds",    buildSheet13],
  ];

  for (const [name, buildFn] of analyticalDefs) {
    const ws = wb.getWorksheet(name);
    if (ws) {
      // Clear all rows (column widths and views preserved by ExcelJS)
      const lastRow = ws.lastRow?.number ?? 0;
      if (lastRow > 0) ws.spliceRows(1, lastRow);
      // Rebuild with live data
      buildFn(ws, input);
    } else {
      console.error(`[ops-xlsx] ⚠️  Sheet '${name}' not found in template`);
    }
  }

  const raw = await wb.xlsx.writeBuffer();
  return Buffer.from(raw);
}
