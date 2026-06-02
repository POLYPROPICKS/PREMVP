// scripts/daily-ops-report.ts
// PolyProPicks Daily Operational Report
// Usage: npm run ops:report
// Prints human-readable Markdown to stdout.
// No DB writes. No UI changes. Read-only.

import { loadEnvConfig } from "@next/env";
import { execSync } from "child_process";

// ── Types ────────────────────────────────────────────────────────────────────

interface ResolvedRow {
  id: string;
  created_at: string;
  resolved_at: string | null;
  condition_id: string | null;
  selected_token_id: string | null;
  signal_result: string | null;
  signal_confidence_num: number | null;
  entry_price_num: number | null;
  realized_return_pct: number | null;
  metric_formula_version: string | null;
  event_slug: string | null;
  selected_outcome: string | null;
  premium_signal: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
}

interface WindowStats {
  total: number;
  won: number;
  lost: number;
  push: number;
  winRate: string;
  avgConf: string;
  avgReturn: string;
  confTotal: number;
  confWon: number;
  confLost: number;
  confWinRate: string;
  confMissing: number;
  totalReturn: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n =
    typeof v === "number"
      ? v
      : parseFloat(String(v).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function safeStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso;
  }
}

function fmtAge(iso: string | null | undefined): string {
  if (!iso) return "N/A";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} мин`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}ч ${remMins}мин`;
}

function winRateFmt(won: number, lost: number): string {
  if (won + lost === 0) return "N/A";
  return `${Math.round((won / (won + lost)) * 1000) / 10}%`;
}

function avgOrNA(vals: (number | null)[]): string {
  const nums = vals.filter((v): v is number => v !== null);
  if (nums.length === 0) return "N/A";
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  return `${Math.round(avg * 10) / 10}`;
}

function avgReturnFmt(vals: (number | null)[]): string {
  const s = avgOrNA(vals);
  return s === "N/A" ? "N/A" : `${s}%`;
}

function totalReturnFmt(vals: (number | null)[]): string {
  const nums = vals.filter((v): v is number => Number.isFinite(v));
  if (nums.length === 0) return "N/A";
  const total = nums.reduce((sum, value) => sum + value, 0);
  const rounded = Math.round(total * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

const PUSH_RESULTS = new Set([
  "push", "refund", "tie", "void", "cancelled", "no_contest",
]);

function inferLeague(
  eventSlug: string | null,
  ps: Record<string, unknown> | null,
): string {
  const league = safeStr(ps?.league);
  if (league) return league;
  const title = (safeStr(eventSlug) ?? "").toLowerCase();
  if (/\blol\b|lck|lpl|lec|league of legends/.test(title)) return "Esports";
  if (/valorant|cs2|dota|esport|gaming/.test(title)) return "Esports";
  if (/nba|wnba|basketball|bucks|lakers|celtics|warriors|heat|knicks|sixers|mystics|storm/.test(title)) return "NBA";
  if (/nhl|hockey|avalanche|rangers|bruins|flyers|capitals|panthers|hurricanes|canadiens/.test(title)) return "NHL";
  if (/nfl|super bowl|chiefs|eagles|packers|cowboys|patriots/.test(title)) return "NFL";
  if (/mlb|baseball|yankees|red sox|dodgers|mets|cubs|braves|rays|orioles|mariners|padres|phillies|marlins|reds|angels|twins|diamondbacks|giants|nationals|guardians|athletics|blue jays/.test(title)) return "MLB";
  if (/roland garros|wimbledon|us open|atp|wta|tennis|borges|kecman|davidovich/.test(title)) return "Tennis";
  if (/premier league|la liga|bundesliga|serie a|copa|champions|soccer|mls|world cup|wc26|independiente/.test(title)) return "Soccer";
  return "Unknown";
}

function extractConf(row: ResolvedRow): number | null {
  return (
    safeNum(row.signal_confidence_num) ??
    safeNum(row.premium_signal?.winProbability) ??
    safeNum(row.premium_signal?.signalConfidence) ??
    safeNum(row.premium_signal?.displaySignalConfidence)
  );
}

function getConfBand(conf: number | null): string {
  if (conf === null) return "Missing";
  if (conf >= 80) return "80+";
  if (conf >= 70) return "70–79";
  if (conf >= 60) return "60–69";
  return "<60";
}

function extractLabel(row: ResolvedRow): string {
  const ps = row.premium_signal;
  const confLabel = safeStr(ps?.confidenceLabel);
  if (confLabel) return confLabel;
  const oddsLabel = safeStr(ps?.oddsBandLabel);
  if (oddsLabel) return oddsLabel;
  const conf = extractConf(row);
  return conf !== null ? `Band:${getConfBand(conf)}` : "Unknown";
}

interface BreakdownRow {
  total: number;
  won: number;
  lost: number;
  push: number;
  returns: (number | null)[];
}

function computeBreakdown<K extends string>(
  rows: ResolvedRow[],
  keyFn: (r: ResolvedRow) => K,
): Map<K, BreakdownRow> {
  const map = new Map<K, BreakdownRow>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k))
      map.set(k, { total: 0, won: 0, lost: 0, push: 0, returns: [] });
    const b = map.get(k)!;
    b.total++;
    if (r.signal_result === "won") b.won++;
    else if (r.signal_result === "lost") b.lost++;
    else if (PUSH_RESULTS.has(r.signal_result ?? "")) b.push++;
    b.returns.push(safeNum(r.realized_return_pct));
  }
  return map;
}

function renderBreakdownTable(
  map: Map<string, BreakdownRow>,
  order: string[],
  out: (s: string) => void,
  minSample = 3,
): void {
  out(`| Группа | Resolved | Won | Lost | Win% | Avg Return | Примечание |`);
  out(`|--------|----------|-----|------|------|------------|------------|`);
  const allKeys = [...new Set([...order, ...map.keys()])];
  for (const key of allKeys) {
    const b = map.get(key);
    if (!b) continue;
    const wr = winRateFmt(b.won, b.lost);
    const avgRet = avgReturnFmt(b.returns);
    const note = b.total < minSample ? "⚠️ LOW SAMPLE" : "";
    out(
      `| ${key} | ${b.total} | ${b.won} | ${b.lost} | ${wr} | ${avgRet} | ${note} |`,
    );
  }
}

function computeWindow(rows: ResolvedRow[]): WindowStats {
  let won = 0,
    lost = 0,
    push = 0;
  let confTotal = 0,
    confWon = 0,
    confLost = 0,
    confMissing = 0;
  const confs: (number | null)[] = [];
  const returns: (number | null)[] = [];

  for (const r of rows) {
    const result = r.signal_result ?? "unknown";
    if (result === "won") won++;
    else if (result === "lost") lost++;
    else if (PUSH_RESULTS.has(result)) push++;

    const conf = extractConf(r);
    confs.push(conf);
    returns.push(safeNum(r.realized_return_pct));

    if (conf === null) {
      confMissing++;
    } else if (conf >= 70) {
      confTotal++;
      if (result === "won") confWon++;
      if (result === "lost") confLost++;
    }
  }

  return {
    total: rows.length,
    won,
    lost,
    push,
    winRate: winRateFmt(won, lost),
    avgConf: avgOrNA(confs),
    avgReturn: avgReturnFmt(returns),
    confTotal,
    confWon,
    confLost,
    confWinRate: winRateFmt(confWon, confLost),
    confMissing,
    totalReturn: totalReturnFmt(returns),
  };
}

function execGit(cmd: string): string {
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "N/A";
  }
}

// ── Observation-only timing / phase / exposure helpers ────────────────────────

interface TimingProxy {
  eventStartProxyIso: string | null;
  minutesToEventStartProxy: number | null;
  phaseProxy: "prematch_proxy" | "live_proxy" | "unknown";
  timingBasis:
    | "upcoming_candidate_resolved_game_time_proxy"
    | "ambiguous_game_start_or_close_proxy"
    | "missing";
  resolvedBeforeEventStartProxy: boolean;
}

function deriveTimingProxy(row: ResolvedRow): TimingProxy {
  const diag = row.diagnostics;
  const rawIso = diag ? safeStr(diag.gameStartIso as unknown) : null;
  const missing: TimingProxy = {
    eventStartProxyIso: null,
    minutesToEventStartProxy: null,
    phaseProxy: "unknown",
    timingBasis: "missing",
    resolvedBeforeEventStartProxy: false,
  };
  if (!rawIso) return missing;
  const gameMs = new Date(rawIso).getTime();
  if (!Number.isFinite(gameMs)) return missing;
  const snapshotMs = new Date(row.created_at).getTime();
  const mins = Math.round((gameMs - snapshotMs) / 60_000);
  const resolvedMs = row.resolved_at ? new Date(row.resolved_at).getTime() : null;
  const basis =
    diag && safeStr(diag.signalStatus as unknown) === "upcoming_candidate"
      ? "upcoming_candidate_resolved_game_time_proxy"
      : "ambiguous_game_start_or_close_proxy";
  return {
    eventStartProxyIso: rawIso,
    minutesToEventStartProxy: mins,
    phaseProxy: mins > 0 ? "prematch_proxy" : "live_proxy",
    timingBasis: basis,
    resolvedBeforeEventStartProxy: resolvedMs !== null ? resolvedMs < gameMs : false,
  };
}

interface ParentEventKeyProxy {
  parentEventKeyProxy: string;
  parentEventKeyBasis: "polymarket_url" | "event_slug_fallback" | "condition_id_fallback";
}

function deriveParentEventKeyProxy(row: ResolvedRow): ParentEventKeyProxy {
  const url = safeStr(row.premium_signal?.polymarketUrl);
  if (url) return { parentEventKeyProxy: url, parentEventKeyBasis: "polymarket_url" };
  const slug = safeStr(row.event_slug);
  if (slug) return { parentEventKeyProxy: slug, parentEventKeyBasis: "event_slug_fallback" };
  return {
    parentEventKeyProxy: row.condition_id ?? row.id,
    parentEventKeyBasis: "condition_id_fallback",
  };
}

function deriveMarketFamilyProxy(row: ResolvedRow): "handicap_spread" | "totals" | "primary_outcome" {
  const text = [
    safeStr(row.event_slug) ?? "",
    safeStr(row.premium_signal?.id) ?? "",
    safeStr(row.selected_outcome) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  if (/handicap|spread|-1\.5|\+1\.5|\bats\b/.test(text)) return "handicap_spread";
  if (/total|o\/u|\bover\b|\bunder\b/.test(text)) return "totals";
  return "primary_outcome";
}

interface ObsStats {
  total: number;
  won: number;
  lost: number;
  push: number;
  winRate: string;
  avgReturn: string;
  totalReturn: string;
}

function computeObsStats(rows: ResolvedRow[]): ObsStats {
  let won = 0, lost = 0, push = 0;
  const returns: (number | null)[] = [];
  for (const r of rows) {
    const res = r.signal_result ?? "";
    if (res === "won") won++;
    else if (res === "lost") lost++;
    else if (PUSH_RESULTS.has(res)) push++;
    returns.push(safeNum(r.realized_return_pct));
  }
  return {
    total: rows.length,
    won,
    lost,
    push,
    winRate: winRateFmt(won, lost),
    avgReturn: avgReturnFmt(returns),
    totalReturn: totalReturnFmt(returns),
  };
}

// ── M3-B shadow helpers (observation only, no production impact) ─────────────

type M3bCoverageState = "missing" | "none" | "low" | "medium" | "high" | "unexpected";

// Exact discrete mapping — dataCoverage takes values: null / 0 / 25 / 50 / 75 / 100
function deriveM3bCoverageState(dataCoverage: number | null | undefined): M3bCoverageState {
  if (dataCoverage == null) return "missing";
  if (dataCoverage === 0) return "none";
  if (dataCoverage === 25) return "low";
  if (dataCoverage === 50) return "medium";
  if (dataCoverage === 75 || dataCoverage === 100) return "high";
  return "unexpected";
}

interface M3bEvidenceState {
  smartMoneyFallback: boolean;
  pubWhaleFallback: boolean;
  coverageValue: number | null;
  coverageState: M3bCoverageState;
  selectedCashAvailable: boolean;
  selectedCountAvailable: boolean;
  totalCountAvailable: boolean;
  opposingCountDerivable: boolean;
  opposingCashAvailable: false;
}

function deriveM3bEvidenceState(row: ResolvedRow): M3bEvidenceState {
  const diag = row.diagnostics;
  const maxTC  = diag ? safeNum(diag.maxTradeCash)       : null;
  const recTC  = diag ? safeNum(diag.recentTradeCash)    : null;
  const selCnt = diag ? safeNum(diag.selectedTradeCount) : null;
  const totCnt = diag ? safeNum(diag.totalTradeCount)    : null;
  const cov    = diag ? safeNum(diag.dataCoverage)       : null;
  const smFall = maxTC === null && recTC === null;
  const pwFall = selCnt === null || selCnt === 0 || recTC === null;
  return {
    smartMoneyFallback: smFall,
    pubWhaleFallback: pwFall,
    coverageValue: cov,
    coverageState: deriveM3bCoverageState(cov),
    selectedCashAvailable: recTC !== null,
    selectedCountAvailable: selCnt !== null,
    totalCountAvailable: totCnt !== null,
    opposingCountDerivable: totCnt !== null && selCnt !== null,
    opposingCashAvailable: false,
  };
}

const ODDS_ALPHA_MAP: Record<string, number> = {
  "Core Signal":     0.7,
  "Value Lean":      0.7,
  "Underdog Value":  1.0,
  "Longshot Value":  0.2,
  "ABSENT":          0.0,
};
const ACTION_MAP: Record<string, number> = {
  "ENTER":       1.0,
  "SMALL":       0.5,
  "LIGHT ENTRY": 0.5,
  "WATCH":       0.0,
  "ABSENT":      0.0,
};
// FIXED train-only sigmoid anchors (immutable after training cutoff 2026-05-29)
const P50_LOG_FLOW = 9.7840;
const P75_LOG_FLOW = 10.4841;
const M3B_SIGMOID_DENOM = P75_LOG_FLOW - P50_LOG_FLOW + 0.01;
// SCOREC_B25_LOCKED_Q25: frozen constant — never re-derived from post-cutoff data
// Source: train-only Q25 from created_at < 2026-05-29, known-action rows (n=84)
// Exact float: 0.569196028392123  |  toFixed(6): 0.569196
const SCOREC_B25_LOCKED_Q25 = 0.569196028392123;

function computeScoreCMetaRisk(row: ResolvedRow): number | null {
  const ps    = row.premium_signal;
  const diag  = row.diagnostics;
  const audit = diag ? (diag.formulaAudit as Record<string, unknown> | undefined) : undefined;
  const bandLabel   = safeStr(ps?.oddsBandLabel)              ?? "ABSENT";
  const actionLabel = safeStr(audit?.action ?? ps?.actionLabel) ?? "ABSENT";
  const oddsQ  = ODDS_ALPHA_MAP[bandLabel]   ?? 0.5;
  const actionQ = ACTION_MAP[actionLabel]    ?? 0.5;
  const cov    = diag ? safeNum(diag.dataCoverage) : null;
  const covNorm = cov !== null ? Math.max(0, Math.min(1, cov / 100)) : 0.5;
  const recTC  = diag ? safeNum(diag.recentTradeCash) : null;
  const logRec = Math.log1p(recTC ?? 0);
  const flowSig = 1 / (1 + Math.exp(-(logRec - P75_LOG_FLOW) / M3B_SIGMOID_DENOM));
  return 0.30 * oddsQ + 0.30 * flowSig + 0.25 * actionQ + 0.15 * covNorm;
}

function computeDedupeConservative(row: ResolvedRow): number | null {
  const diag  = row.diagnostics;
  if (!diag) return null;
  const audit = diag.formulaAudit as Record<string, unknown> | undefined;
  if (!audit) return null;
  const oF = safeNum(audit.oddsFit);
  const sm = safeNum(audit.smartMoneyVal);
  const pw = safeNum(audit.pubWhaleVal);
  const pe = safeNum(audit.preEventVal);
  if (oF === null || sm === null || pw === null || pe === null) return null;
  const cov = safeNum(diag.dataCoverage) ?? 0;
  const flowAvg = (sm + pw) / 2;
  return 0.35 * oF + 0.20 * flowAvg + 0.25 * pe + 0.20 * cov;
}

function getActionLabel(row: ResolvedRow): string {
  const diag  = row.diagnostics;
  const audit = diag ? (diag.formulaAudit as Record<string, unknown> | undefined) : undefined;
  return safeStr(audit?.action ?? row.premium_signal?.actionLabel) ?? "ABSENT";
}
function getOddsBandLabel(row: ResolvedRow): string {
  return safeStr(row.premium_signal?.oddsBandLabel) ?? "ABSENT";
}

function deriveSizingStakes(
  row: ResolvedRow,
  scoreCQ25: number | null,
): { flat: number | null; a1: number | null; f2: number | null; f2b25: number | null } {
  const act = getActionLabel(row);
  if (act === "ABSENT") return { flat: null, a1: null, f2: null, f2b25: null };
  const band = getOddsBandLabel(row);
  const mf   = deriveMarketFamilyProxy(row);
  const flat = 10;
  const a1   = act === "ENTER" ? 10 : (act === "SMALL" || act === "LIGHT ENTRY") ? 5 : 0;
  let f2 = a1;
  if (band === "Longshot Value") f2 = Math.min(f2, 2.5);
  if (mf === "totals" && (act === "SMALL" || act === "LIGHT ENTRY")) f2 = Math.min(f2, 2.5);
  let f2b25 = f2;
  if (scoreCQ25 !== null) {
    const sc = computeScoreCMetaRisk(row);
    if (sc !== null && sc < scoreCQ25) f2b25 = f2 * 0.5;
  }
  return { flat, a1, f2, f2b25 };
}

interface SizingStats {
  activeRows: number; pnl: string; roi: string;
  maxDD: string; worstDay: string; positiveDayShare: string;
}

function computeSizingStats(rows: ResolvedRow[], stakeGet: (r: ResolvedRow) => number | null): SizingStats {
  type R = { date: string; rAt: string; stake: number; ret: number | null };
  const active: R[] = [];
  for (const r of rows) {
    const s = stakeGet(r);
    if (s === null || s <= 0) continue;
    const rAt  = r.resolved_at ?? r.created_at;
    active.push({ date: rAt.slice(0, 10), rAt, stake: s, ret: safeNum(r.realized_return_pct) });
  }
  if (active.length === 0) return { activeRows: 0, pnl: "N/A", roi: "N/A", maxDD: "N/A", worstDay: "N/A", positiveDayShare: "N/A" };
  active.sort((a, b) => a.rAt.localeCompare(b.rAt));
  const totalStaked = active.reduce((s, r) => s + r.stake, 0);
  let pnl = 0, runPnl = 0, peak = 0, maxDD = 0;
  const dayPnl: Record<string, number> = {};
  for (const r of active) {
    const rp = r.ret !== null ? r.stake * (r.ret / 100) : 0;
    pnl += rp; runPnl += rp;
    if (runPnl > peak) peak = runPnl;
    const dd = peak - runPnl;
    if (dd > maxDD) maxDD = dd;
    dayPnl[r.date] = (dayPnl[r.date] ?? 0) + rp;
  }
  const days = Object.values(dayPnl);
  const posDays = days.filter(d => d > 0).length;
  const fmt = (v: number) => `$${Math.round(v * 10) / 10}`;
  return {
    activeRows: active.length,
    pnl: fmt(pnl),
    roi: totalStaked > 0 ? `${Math.round(pnl / totalStaked * 1000) / 10}%` : "N/A",
    maxDD: fmt(maxDD),
    worstDay: fmt(Math.min(...days, 0)),
    positiveDayShare: days.length ? `${Math.round(posDays / days.length * 100)}%` : "N/A",
  };
}

function spearmanVsReturn(rows: ResolvedRow[], scoreGet: (r: ResolvedRow) => number | null): string {
  const pairs = rows
    .map(r => [scoreGet(r), safeNum(r.realized_return_pct)] as [number | null, number | null])
    .filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
  const n = pairs.length;
  if (n < 3) return "N/A";
  const rankOf = (vals: number[]) => {
    const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    idx.forEach(([, i], pos) => { r[i] = pos + 1; });
    return r;
  };
  const rx = rankOf(pairs.map(p => p[0]));
  const ry = rankOf(pairs.map(p => p[1]));
  const dSq = rx.reduce((s, r, i) => s + (r - ry[i]) ** 2, 0);
  const sp = 1 - (6 * dSq) / (n * (n * n - 1));
  return `${Math.round(sp * 1000) / 1000}`;
}

function quartileROI(rows: ResolvedRow[], scoreGet: (r: ResolvedRow) => number | null): {
  q4roi: string; q1roi: string; spread: string; n: number; uniqueVals: number;
} {
  const scored = rows
    .map(r => ({ s: scoreGet(r), ret: safeNum(r.realized_return_pct) }))
    .filter((x): x is { s: number; ret: number } => x.s !== null && x.ret !== null)
    .sort((a, b) => a.s - b.s);
  const n = scored.length;
  const uniqueVals = new Set(scored.map(x => x.s)).size;
  if (n < 4) return { q4roi: "N/A", q1roi: "N/A", spread: "N/A", n, uniqueVals };
  const q1e = Math.floor(n * 0.25);
  const q4s = Math.floor(n * 0.75);
  // Tie-safe: if Q1 upper boundary == Q4 lower boundary, splitting is arbitrary
  if (uniqueVals < 4 || scored[q1e - 1].s === scored[q4s].s) {
    const tag = `N/A (DISCRETE_TIES, uv=${uniqueVals})`;
    return { q4roi: "N/A (DISCRETE_TIES)", q1roi: "N/A (DISCRETE_TIES)", spread: tag, n, uniqueVals };
  }
  const avg = (arr: { ret: number }[]) => arr.reduce((s, x) => s + x.ret, 0) / arr.length;
  const q1a = avg(scored.slice(0, q1e));
  const q4a = avg(scored.slice(q4s));
  const f = (v: number) => `${Math.round(v * 10) / 10}%`;
  return { q4roi: f(q4a), q1roi: f(q1a), spread: f(q4a - q1a), n, uniqueVals };
}

// ── Deduplication ─────────────────────────────────────────────────────────────
// Each market/outcome pair is cached repeatedly by signal-cache-cron (~30 min).
// Resolver writes signal_result to ALL rows in the group simultaneously.
// Canonical key: condition_id + selected_token_id (both 100% populated in prod).
// Fallback: event_slug + selected_outcome → id.
// Representative row: earliest created_at (first signal snapshot).

interface DedupResult {
  rows: ResolvedRow[];
  rawCount: number;
  uniqueCount: number;
  duplicateGroups: number;
  maxDuplicatesInGroup: number;
}

function deduplicateRows(rawRows: ResolvedRow[]): DedupResult {
  const groups = new Map<string, ResolvedRow[]>();
  for (const r of rawRows) {
    const key =
      r.condition_id && r.selected_token_id
        ? `ct::${r.condition_id}::${r.selected_token_id}`
        : r.event_slug && r.selected_outcome
          ? `so::${r.event_slug}::${r.selected_outcome}`
          : `id::${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  let duplicateGroups = 0;
  let maxDuplicatesInGroup = 0;
  const rows: ResolvedRow[] = [];
  for (const group of groups.values()) {
    // Earliest created_at = first signal snapshot (pre-cron-amplification)
    group.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    rows.push(group[0]);
    if (group.length > 1) duplicateGroups++;
    if (group.length > maxDuplicatesInGroup) maxDuplicatesInGroup = group.length;
  }
  return {
    rows,
    rawCount: rawRows.length,
    uniqueCount: rows.length,
    duplicateGroups,
    maxDuplicatesInGroup,
  };
}

// ── Unresolved backlog dedup ──────────────────────────────────────────────────
// Same canonical key as resolved dedup. Earliest created_at = representative row.

interface UnresolvedRow {
  id: string;
  created_at: string;
  condition_id: string | null;
  selected_token_id: string | null;
  event_slug: string | null;
  selected_outcome: string | null;
}

interface UnresolvedDedupResult {
  rows: UnresolvedRow[];
  rawCount: number;
  uniqueCount: number;
  duplicateGroups: number;
  maxDuplicatesInGroup: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

function deduplicateUnresolvedRows(
  rawRows: UnresolvedRow[],
): UnresolvedDedupResult {
  const groups = new Map<string, UnresolvedRow[]>();
  for (const r of rawRows) {
    const key =
      r.condition_id && r.selected_token_id
        ? `ct::${r.condition_id}::${r.selected_token_id}`
        : r.event_slug && r.selected_outcome
          ? `so::${r.event_slug}::${r.selected_outcome}`
          : `id::${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  let duplicateGroups = 0;
  let maxDuplicatesInGroup = 0;
  const rows: UnresolvedRow[] = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    rows.push(group[0]);
    if (group.length > 1) duplicateGroups++;
    if (group.length > maxDuplicatesInGroup)
      maxDuplicatesInGroup = group.length;
  }
  const byAge = [...rows].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  return {
    rows,
    rawCount: rawRows.length,
    uniqueCount: rows.length,
    duplicateGroups,
    maxDuplicatesInGroup,
    oldestCreatedAt: byAge.length > 0 ? byAge[0].created_at : null,
    newestCreatedAt:
      byAge.length > 0 ? byAge[byAge.length - 1].created_at : null,
  };
}

// ── Email mode ───────────────────────────────────────────────────────────────

const EMAIL_MODE_RECIPIENT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--email="));
  return arg ? arg.split("=").slice(1).join("=") : null;
})();

// ── Email helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey) throw new Error("RESEND_API_KEY missing — set in Railway env");
  if (!from) throw new Error("EMAIL_FROM missing — set in Railway env");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Must be first: load .env.local before any import reads process.env
  loadEnvConfig(process.cwd());

  const now = new Date();
  const nowISO = now.toISOString();
  // Report header timestamp in GMT+3
  const gmt3 = new Date(now.getTime() + 3 * 3_600_000);
  const reportDate =
    gmt3.toISOString().replace("T", " ").slice(0, 16) + " GMT+3";

  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  const redFlags: string[] = [];

  // ── 1. Git / Deploy state ─────────────────────────────────────────────────
  const headShort = execGit("git rev-parse --short HEAD");
  const headMsg = execGit("git log -1 --format=%s");
  const originShort = execGit("git rev-parse --short origin/main");
  const gitStatus = execGit("git status --short");
  const localMatchesOrigin =
    headShort !== "N/A" && headShort === originShort;
  const dirtyTracked = gitStatus
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("??"));

  if (!localMatchesOrigin)
    redFlags.push(
      `⚠️ local HEAD (${headShort}) ≠ origin/main (${originShort})`,
    );
  if (dirtyTracked.length > 0)
    redFlags.push(
      `⚠️ Git: tracked dirty файлы: ${dirtyTracked.join(", ")}`,
    );

  // ── 2. Feed freshness ─────────────────────────────────────────────────────
  type FeedPair = Record<string, unknown>;
  let feedGeneratedAt: string | null = null;
  let feedCacheStatus: string | null = null;
  let feedFormula: string | null = null;
  let feedPairs: FeedPair[] = [];
  let feedError: string | null = null;

  try {
    const res = await fetch(
      "https://polypropicks.com/api/feed/landing-cards?limit=15",
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    feedGeneratedAt = safeStr(d.generatedAt);
    feedCacheStatus = safeStr(d.cacheStatus);
    feedFormula = safeStr(d.formulaVersion);
    feedPairs = Array.isArray(d.pairs) ? (d.pairs as FeedPair[]) : [];
  } catch (e) {
    feedError = e instanceof Error ? e.message : String(e);
    redFlags.push(`❌ Feed API недоступен: ${feedError}`);
  }

  const feedAgeMs = feedGeneratedAt
    ? Date.now() - new Date(feedGeneratedAt).getTime()
    : null;
  const feedAgeMins =
    feedAgeMs !== null ? Math.round(feedAgeMs / 60_000) : null;
  if (feedAgeMins !== null && feedAgeMins > 90)
    redFlags.push(`❌ Feed кэш старше 90 мин (${feedAgeMins} мин)`);

  // Feed composition: leagues and confidence
  const leagueCounts: Record<string, number> = {};
  const feedConfCounts = { total: 0, ge70: 0 };
  const topTitles: string[] = [];

  for (const p of feedPairs) {
    const ps = p.premiumSignal as Record<string, unknown> | null | undefined;
    const league = safeStr(ps?.league) ?? "Unknown";
    leagueCounts[league] = (leagueCounts[league] ?? 0) + 1;
    feedConfCounts.total++;
    const conf =
      safeNum(ps?.displaySignalConfidence) ?? safeNum(ps?.winProbability);
    if (conf !== null && conf >= 70) feedConfCounts.ge70++;
    const title =
      safeStr(ps?.eventTitle) ?? safeStr(ps?.title) ?? safeStr(ps?.market);
    if (title && topTitles.length < 5) topTitles.push(title);
  }

  // ── 3. Supabase ───────────────────────────────────────────────────────────
  // Dynamic import ensures loadEnvConfig ran first
  type SupabaseClient = Awaited<
    typeof import("../lib/supabase/server")
  >["supabaseAdmin"];
  let supabase: SupabaseClient | null = null;
  let dbConnectError: string | null = null;

  try {
    const mod = await import("../lib/supabase/server");
    supabase = mod.supabaseAdmin;
  } catch (e) {
    dbConnectError = e instanceof Error ? e.message : String(e);
    redFlags.push(`❌ Supabase init failed: ${dbConnectError}`);
  }

  // ── 3a. Cache-cron health via job_runs ────────────────────────────────────
  let lastJobRun: Record<string, unknown> | null = null;
  let jobRunError: string | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("job_runs")
        .select(
          "source, started_at, finished_at, status, generated_count, rejected_count, duration_ms, error_message",
        )
        .eq("source", "polymarket")
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      lastJobRun =
        data && data.length > 0
          ? (data[0] as Record<string, unknown>)
          : null;
    } catch (e) {
      jobRunError = e instanceof Error ? e.message : String(e);
      redFlags.push(`⚠️ job_runs недоступен: ${jobRunError}`);
    }
  }

  const cronLastAt = lastJobRun ? safeStr(lastJobRun.started_at) : null;
  const cronAgeMs = cronLastAt
    ? Date.now() - new Date(cronLastAt).getTime()
    : null;
  const cronAgeMins =
    cronAgeMs !== null ? Math.round(cronAgeMs / 60_000) : null;
  if (cronAgeMins !== null && cronAgeMins > 120)
    redFlags.push(
      `❌ Cache-cron: последний запуск ${cronAgeMins} мин назад (порог 120 мин)`,
    );
  if (!cronLastAt && !jobRunError)
    redFlags.push(`⚠️ job_runs: нет записей для source=polymarket`);

  // ── 3a-ii. Resolver cron health via job_runs ──────────────────────────────
  let lastResolverJobRun: Record<string, unknown> | null = null;
  let resolverJobRunError: string | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("job_runs")
        .select(
          "source, started_at, finished_at, status, generated_count, rejected_count, duration_ms, error_message, diagnostics",
        )
        .eq("source", "resolver")
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      lastResolverJobRun =
        data && data.length > 0
          ? (data[0] as Record<string, unknown>)
          : null;
    } catch (e) {
      resolverJobRunError = e instanceof Error ? e.message : String(e);
    }
  }

  const resolverCronLastAt = lastResolverJobRun
    ? safeStr(lastResolverJobRun.started_at)
    : null;
  const resolverCronAgeMs = resolverCronLastAt
    ? Date.now() - new Date(resolverCronLastAt).getTime()
    : null;
  const resolverCronAgeMins =
    resolverCronAgeMs !== null ? Math.round(resolverCronAgeMs / 60_000) : null;
  const resolverCronStatus = safeStr(lastResolverJobRun?.status);
  const resolverCronUpdated =
    (lastResolverJobRun?.generated_count as number | null) ?? null;
  const resolverCronSkipped =
    (lastResolverJobRun?.rejected_count as number | null) ?? null;
  const resolverCronDur =
    (lastResolverJobRun?.duration_ms as number | null) ?? null;
  const resolverCronDiag =
    (lastResolverJobRun?.diagnostics as Record<string, unknown> | null) ?? null;
  const resolverCronSelected = safeNum(resolverCronDiag?.selected);

  // ── 3b. Resolved performance (all-time paginated fetch) ──────────────────
  const cutoff72 = new Date(now.getTime() - 72 * 3_600_000).toISOString();
  const cutoff48 = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const cutoff24 = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();

  let resolvedRows: ResolvedRow[] = [];
  let resolvedError: string | null = null;
  let dedupDiag = {
    rawCount: 0,
    uniqueCount: 0,
    duplicateGroups: 0,
    maxDuplicatesInGroup: 0,
  };

  if (supabase) {
    try {
      const RESOLVED_PAGE_SIZE = 1000;
      const RESOLVED_MAX_PAGES = 20;
      const rawRowsAll: ResolvedRow[] = [];
      const RESOLVED_FIELDS =
        "id, created_at, resolved_at, condition_id, selected_token_id, " +
        "signal_result, signal_confidence_num, " +
        "entry_price_num, realized_return_pct, metric_formula_version, " +
        "event_slug, selected_outcome, premium_signal, diagnostics";

      for (let page = 0; page < RESOLVED_MAX_PAGES; page += 1) {
        const from = page * RESOLVED_PAGE_SIZE;
        const to = from + RESOLVED_PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from("generated_signal_pairs")
          .select(RESOLVED_FIELDS)
          .not("signal_result", "is", null)
          .order("resolved_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to);
        if (error) throw new Error(error.message);
        const pageRows = (data ?? []) as unknown as ResolvedRow[];
        rawRowsAll.push(...pageRows);
        if (pageRows.length < RESOLVED_PAGE_SIZE) break;
        if (page === RESOLVED_MAX_PAGES - 1) {
          throw new Error("Resolved rows pagination safety cap reached");
        }
      }

      const deduped = deduplicateRows(rawRowsAll);
      dedupDiag = {
        rawCount: deduped.rawCount,
        uniqueCount: deduped.uniqueCount,
        duplicateGroups: deduped.duplicateGroups,
        maxDuplicatesInGroup: deduped.maxDuplicatesInGroup,
      };
      resolvedRows = deduped.rows;
      // Re-sort deduped rows by resolved_at DESC for display and latestResolvedAt
      resolvedRows.sort((a, b) =>
        (b.resolved_at ?? "").localeCompare(a.resolved_at ?? ""),
      );
      // Informational note — expected behaviour, not a failure
      if (deduped.rawCount > 0 && deduped.rawCount / deduped.uniqueCount >= 2) {
        redFlags.push(
          `ℹ️ Dedup: ${deduped.rawCount} raw строк → ${deduped.uniqueCount} уникальных сигналов (ожидаемо — cache-cron вставляет повторные снимки)`,
        );
      }
    } catch (e) {
      resolvedError = e instanceof Error ? e.message : String(e);
      redFlags.push(`❌ Resolved stats: ${resolvedError}`);
    }
  }

  const rows72 = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff72,
  );
  const rows48 = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff48,
  );
  const rows24 = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff24,
  );
  const rows7d = resolvedRows.filter(
    (r) => r.resolved_at != null && r.resolved_at >= cutoff7d,
  );
  const rowsAllTime = resolvedRows;

  const stats72 = computeWindow(rows72);
  const stats48 = computeWindow(rows48);
  const stats24 = computeWindow(rows24);
  const stats7d = computeWindow(rows7d);
  const statsAllTime = computeWindow(rowsAllTime);

  // ── OBS: pre-compute timing proxies (observation only, no production impact) ─
  const obsWindowDefs: [string, ResolvedRow[]][] = [
    ["24h", rows24],
    ["48h", rows48],
    ["72h", rows72],
    ["7d", rows7d],
    ["All time", rowsAllTime],
  ];

  // Data quality counters (all-time)
  let obsDiagMissing = 0;
  let obsGameIsoMissing = 0;
  let obsUpcomingBasis = 0;
  let obsAmbiguousBasis = 0;
  let obsResolvedBeforeProxy = 0;
  let obsPrematch = 0;
  let obsLiveProxy = 0;
  let obsUnknown = 0;
  let obsParentUrlBasis = 0;
  let obsParentFallbackBasis = 0;
  const obsParentKeyMap = new Map<string, Set<string>>(); // parentKey → condition_ids
  const obsParentFamilyMap = new Map<string, Set<string>>(); // parentKey → market families
  const obsFamilyCounts: Record<string, number> = {
    primary_outcome: 0,
    totals: 0,
    handicap_spread: 0,
  };
  const obsLeagueCounts: Record<string, number> = {};

  const obsTimingCache = new Map<string, TimingProxy>();
  const obsFamilyCache = new Map<string, ReturnType<typeof deriveMarketFamilyProxy>>();

  for (const r of rowsAllTime) {
    if (!r.diagnostics) obsDiagMissing++;
    const tp = deriveTimingProxy(r);
    obsTimingCache.set(r.id, tp);
    if (tp.timingBasis === "missing") obsGameIsoMissing++;
    else if (tp.timingBasis === "upcoming_candidate_resolved_game_time_proxy") obsUpcomingBasis++;
    else obsAmbiguousBasis++;
    if (tp.resolvedBeforeEventStartProxy) obsResolvedBeforeProxy++;
    if (tp.phaseProxy === "prematch_proxy") obsPrematch++;
    else if (tp.phaseProxy === "live_proxy") obsLiveProxy++;
    else obsUnknown++;

    const pk = deriveParentEventKeyProxy(r);
    if (pk.parentEventKeyBasis === "polymarket_url") obsParentUrlBasis++;
    else obsParentFallbackBasis++;
    if (!obsParentKeyMap.has(pk.parentEventKeyProxy))
      obsParentKeyMap.set(pk.parentEventKeyProxy, new Set());
    if (!obsParentFamilyMap.has(pk.parentEventKeyProxy))
      obsParentFamilyMap.set(pk.parentEventKeyProxy, new Set());
    if (r.condition_id)
      obsParentKeyMap.get(pk.parentEventKeyProxy)!.add(r.condition_id);

    const mf = deriveMarketFamilyProxy(r);
    obsFamilyCache.set(r.id, mf);
    obsParentFamilyMap.get(pk.parentEventKeyProxy)!.add(mf);
    obsFamilyCounts[mf] = (obsFamilyCounts[mf] ?? 0) + 1;

    const league = safeStr(r.premium_signal?.league) ?? "Unknown";
    obsLeagueCounts[league] = (obsLeagueCounts[league] ?? 0) + 1;
  }

  const obsMultiConditionParents = [...obsParentKeyMap.values()].filter(
    (s) => s.size > 1,
  ).length;
  const obsMultiFamilyParents = [...obsParentFamilyMap.values()].filter(
    (s) => s.size > 1,
  ).length;
  const obsMaxCondPerParent = Math.max(
    0,
    ...[...obsParentKeyMap.values()].map((s) => s.size),
  );

  // Helper: filter rows by timing cohort (uses cache)
  function obsPhaseFilter(
    rows: ResolvedRow[],
    phase: "prematch_proxy" | "live_proxy" | "unknown",
  ): ResolvedRow[] {
    return rows.filter((r) => (obsTimingCache.get(r.id) ?? deriveTimingProxy(r)).phaseProxy === phase);
  }
  function obsTimingCohortFilter(rows: ResolvedRow[], minM: number, maxM: number): ResolvedRow[] {
    return rows.filter((r) => {
      const tp = obsTimingCache.get(r.id) ?? deriveTimingProxy(r);
      if (tp.phaseProxy !== "prematch_proxy" || tp.minutesToEventStartProxy === null) return false;
      return tp.minutesToEventStartProxy >= minM && tp.minutesToEventStartProxy <= maxM;
    });
  }
  function obsFamilyFilter(rows: ResolvedRow[], family: string): ResolvedRow[] {
    return rows.filter(
      (r) => (obsFamilyCache.get(r.id) ?? deriveMarketFamilyProxy(r)) === family,
    );
  }
  // ── END OBS pre-compute ─────────────────────────────────────────────────────

  // ── OBS: M3-B pre-compute (shadow tracking — no production impact) ───────────

  // Evidence state counters (all-time)
  let m3bSmFallback = 0, m3bPwFallback = 0;
  let m3bCovMissing = 0, m3bCovNone = 0, m3bCovLow = 0, m3bCovMedium = 0, m3bCovHigh = 0, m3bCovUnexpected = 0;
  let m3bSelCashAvail = 0, m3bSelCntAvail = 0, m3bTotCntAvail = 0, m3bOppCntDerivable = 0;

  for (const r of rowsAllTime) {
    const ev = deriveM3bEvidenceState(r);
    if (ev.smartMoneyFallback) m3bSmFallback++;
    if (ev.pubWhaleFallback) m3bPwFallback++;
    if (ev.coverageState === "missing") m3bCovMissing++;
    else if (ev.coverageState === "none") m3bCovNone++;
    else if (ev.coverageState === "low") m3bCovLow++;
    else if (ev.coverageState === "medium") m3bCovMedium++;
    else if (ev.coverageState === "high") m3bCovHigh++;
    else if (ev.coverageState === "unexpected") m3bCovUnexpected++;
    if (ev.selectedCashAvailable) m3bSelCashAvail++;
    if (ev.selectedCountAvailable) m3bSelCntAvail++;
    if (ev.totalCountAvailable) m3bTotCntAvail++;
    if (ev.opposingCountDerivable) m3bOppCntDerivable++;
  }

  // Locked Q25 threshold for ScoreC
  // Training rows: created_at < TRAIN_CUTOFF, action label != ABSENT
  // Anchors are frozen after 2026-05-29 — never re-derived from post-cutoff data
  const TRAIN_CUTOFF = "2026-05-29";
  const m3bTrainRows = rowsAllTime.filter(
    (r) => r.created_at.slice(0, 10) < TRAIN_CUTOFF && getActionLabel(r) !== "ABSENT",
  );
  const m3bTrainScores = m3bTrainRows
    .map((r) => computeScoreCMetaRisk(r))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  const m3bScoreCQ25: number | null =
    m3bTrainScores.length >= 4
      ? m3bTrainScores[Math.floor(m3bTrainScores.length * 0.25)]
      : null;
  const m3bTrainScoreCN = m3bTrainScores.length;

  // Sizing stats per window (FLAT-KNOWN / ACTION-1 / FAMILY-2 / FAMILY-2+SCOREC-B25-HALF)
  type M3bSizingKey = "flat" | "a1" | "f2" | "f2b25";
  const M3B_SIZING_DEFS: [string, ResolvedRow[]][] = [
    ["72h", rows72],
    ["7d", rows7d],
    ["All time", rowsAllTime],
  ];
  // Drift monitoring: compare locked constant against recomputed train-only Q25
  const m3bScoreCDrift =
    m3bScoreCQ25 !== null ? Math.abs(SCOREC_B25_LOCKED_Q25 - m3bScoreCQ25) : null;

  // f2b25 MUST use only SCOREC_B25_LOCKED_Q25 — never the dynamically recomputed value
  const m3bSizingStats: Record<string, Record<M3bSizingKey, SizingStats>> = {};
  for (const [lbl, wr] of M3B_SIZING_DEFS) {
    m3bSizingStats[lbl] = {
      flat:  computeSizingStats(wr, (r) => deriveSizingStakes(r, m3bScoreCQ25).flat),
      a1:    computeSizingStats(wr, (r) => deriveSizingStakes(r, m3bScoreCQ25).a1),
      f2:    computeSizingStats(wr, (r) => deriveSizingStakes(r, m3bScoreCQ25).f2),
      f2b25: computeSizingStats(wr, (r) => deriveSizingStakes(r, SCOREC_B25_LOCKED_Q25).f2b25),
    };
  }

  // Score / component getter functions (read-only, no side effects)
  function getProdRawScore(r: ResolvedRow): number | null {
    const diag = r.diagnostics;
    if (!diag) return null;
    const audit = diag.formulaAudit as Record<string, unknown> | undefined;
    if (!audit) return null;
    return safeNum(audit.finalSignalV2) ?? safeNum(audit.signalV2Raw);
  }
  function getOddsQualityComponent(r: ResolvedRow): number | null {
    const band = getOddsBandLabel(r);
    if (band === "ABSENT") return null;
    return ODDS_ALPHA_MAP[band] ?? null;
  }
  function getActionQualityComponent(r: ResolvedRow): number | null {
    const act = getActionLabel(r);
    if (act === "ABSENT") return null;
    return ACTION_MAP[act] ?? null;
  }
  function getFlowSigmoidComponent(r: ResolvedRow): number | null {
    const diag = r.diagnostics;
    const recTC = diag ? safeNum(diag.recentTradeCash) : null;
    if (recTC === null) return null; // absent → exclude from correlation (not zero)
    const logRec = Math.log1p(recTC);
    return 1 / (1 + Math.exp(-(logRec - P75_LOG_FLOW) / M3B_SIGMOID_DENOM));
  }
  function getCoverageNormComponent(r: ResolvedRow): number | null {
    const diag = r.diagnostics;
    const cov = diag ? safeNum(diag.dataCoverage) : null;
    return cov !== null ? Math.max(0, Math.min(1, cov / 100)) : null;
  }

  // ── END OBS M3-B pre-compute ──────────────────────────────────────────────────

  if (stats24.total === 0)
    redFlags.push(`⚠️ За 24h нет resolved сигналов`);
  if (stats24.total >= 10) {
    const wr =
      stats24.won + stats24.lost > 0
        ? stats24.won / (stats24.won + stats24.lost)
        : null;
    if (wr !== null && wr < 0.45)
      redFlags.push(
        `⚠️ Win rate за 24h ниже 45% (${stats24.winRate} при ${stats24.total} сигналах)`,
      );
  }
  if (stats24.confTotal === 0 && stats24.total > 0)
    redFlags.push(`⚠️ Нет resolved с confidence≥70 за 24h`);

  // ── 3c. Resolver health + unresolved backlog (deduped) ───────────────────
  let latestResolvedAt: string | null =
    resolvedRows.length > 0 ? (resolvedRows[0].resolved_at ?? null) : null;
  let unresolvedError: string | null = null;
  let backlogDedup: UnresolvedDedupResult | null = null;

  if (supabase) {
    // latestResolvedAt fallback if no rows in 72h window
    if (!latestResolvedAt) {
      try {
        const { data } = await supabase
          .from("generated_signal_pairs")
          .select("resolved_at")
          .not("signal_result", "is", null)
          .order("resolved_at", { ascending: false })
          .limit(1);
        latestResolvedAt =
          (data?.[0] as { resolved_at?: string } | undefined)?.resolved_at ??
          null;
      } catch { /* non-fatal */ }
    }

    // Unresolved backlog — fetch rows for dedup (limit 2000 covers current backlog)
    try {
      const { data: unresolvedData, error: unresolvedErr } = await supabase
        .from("generated_signal_pairs")
        .select(
          "id, created_at, condition_id, selected_token_id, event_slug, selected_outcome",
        )
        .is("signal_result", null)
        .not("metric_formula_version", "is", null)
        .order("created_at", { ascending: true })
        .limit(2000);
      if (unresolvedErr) throw new Error(unresolvedErr.message);
      backlogDedup = deduplicateUnresolvedRows(
        (unresolvedData ?? []) as unknown as UnresolvedRow[],
      );
    } catch (e) {
      unresolvedError = e instanceof Error ? e.message : String(e);
    }
  }

  const resolverAgeMs = latestResolvedAt
    ? Date.now() - new Date(latestResolvedAt).getTime()
    : null;
  const resolverAgeMins =
    resolverAgeMs !== null ? Math.round(resolverAgeMs / 60_000) : null;

  // Resolver cron red flags — from job_runs (authoritative), not approximation
  if (resolverJobRunError) {
    redFlags.push(
      `⚠️ Resolver job_runs query failed: ${resolverJobRunError}`,
    );
  } else if (!lastResolverJobRun) {
    redFlags.push(
      `⚠️ Resolver job_runs: нет записей (resolver не запускался или не задеплоен)`,
    );
  } else if (resolverCronStatus === "error") {
    const errMsg =
      safeStr(lastResolverJobRun.error_message) ?? "unknown error";
    redFlags.push(`❌ Resolver cron error: ${errMsg.slice(0, 120)}`);
  } else if (resolverCronAgeMins !== null && resolverCronAgeMins > 480) {
    redFlags.push(
      `⚠️ Resolver cron stale: последний запуск ${resolverCronAgeMins} мин назад (>8h)`,
    );
  }
  // Fallback approximate stale warning only if no job_run data at all
  if (
    !lastResolverJobRun &&
    resolverAgeMins !== null &&
    resolverAgeMins > 480
  ) {
    redFlags.push(
      `⚠️ Resolver (approx fallback): последний resolved_at ${resolverAgeMins} мин назад (>8h)`,
    );
  }

  // Backlog red flags — unique count, not raw rows
  if (unresolvedError) {
    redFlags.push(`⚠️ Backlog query failed: ${unresolvedError}`);
  } else if (backlogDedup) {
    if (
      backlogDedup.rawCount > 0 &&
      backlogDedup.rawCount / backlogDedup.uniqueCount >= 2
    ) {
      redFlags.push(
        `ℹ️ Backlog dedup: ${backlogDedup.rawCount} raw → ${backlogDedup.uniqueCount} уникальных (ожидаемо — cache-cron дублирует)`,
      );
    }
    if (backlogDedup.uniqueCount > 200) {
      redFlags.push(
        `⚠️ Backlog: ${backlogDedup.uniqueCount} уникальных unresolved сигналов (порог 200)`,
      );
    }
    if (backlogDedup.oldestCreatedAt) {
      const oldestAgeHrs = Math.round(
        (Date.now() - new Date(backlogDedup.oldestCreatedAt).getTime()) /
          3_600_000,
      );
      if (oldestAgeHrs > 72) {
        redFlags.push(
          `⚠️ Backlog: старейший unresolved сигнал ${oldestAgeHrs}ч (порог 72h)`,
        );
      }
    }
  }

  // ── 3d. League split (24h) ────────────────────────────────────────────────
  const leagueStats24: Record<
    string,
    { total: number; won: number; lost: number; confs: (number | null)[] }
  > = {};
  for (const r of rows24) {
    const league = inferLeague(r.event_slug, r.premium_signal);
    if (!leagueStats24[league])
      leagueStats24[league] = { total: 0, won: 0, lost: 0, confs: [] };
    const s = leagueStats24[league];
    s.total++;
    if (r.signal_result === "won") s.won++;
    if (r.signal_result === "lost") s.lost++;
    s.confs.push(extractConf(r));
  }

  // ── 3e. Confidence band + label breakdowns ────────────────────────────────
  const BAND_ORDER = ["80+", "70–79", "60–69", "<60", "Missing"];

  const bandMap72 = computeBreakdown(rows72, (r) =>
    getConfBand(extractConf(r)),
  ) as Map<string, BreakdownRow>;
  const bandMap24 = computeBreakdown(rows24, (r) =>
    getConfBand(extractConf(r)),
  ) as Map<string, BreakdownRow>;
  const labelMap72 = computeBreakdown(rows72, (r) =>
    extractLabel(r),
  ) as Map<string, BreakdownRow>;

  // League × Confidence ≥70 (24h and 72h)
  const leagueConf70_24: Record<
    string,
    { total: number; won: number; lost: number }
  > = {};
  for (const r of rows24) {
    const conf = extractConf(r) ?? 0;
    if (conf >= 70) {
      const league = inferLeague(r.event_slug, r.premium_signal);
      if (!leagueConf70_24[league])
        leagueConf70_24[league] = { total: 0, won: 0, lost: 0 };
      leagueConf70_24[league].total++;
      if (r.signal_result === "won") leagueConf70_24[league].won++;
      if (r.signal_result === "lost") leagueConf70_24[league].lost++;
    }
  }
  const leagueConf70_72: Record<
    string,
    { total: number; won: number; lost: number }
  > = {};
  for (const r of rows72) {
    const conf = extractConf(r) ?? 0;
    if (conf >= 70) {
      const league = inferLeague(r.event_slug, r.premium_signal);
      if (!leagueConf70_72[league])
        leagueConf70_72[league] = { total: 0, won: 0, lost: 0 };
      leagueConf70_72[league].total++;
      if (r.signal_result === "won") leagueConf70_72[league].won++;
      if (r.signal_result === "lost") leagueConf70_72[league].lost++;
    }
  }

  // Integrity checks
  const bandTotal72 = [...bandMap72.values()].reduce(
    (s, b) => s + b.total,
    0,
  );
  const integrityBandOk = bandTotal72 === stats72.total;
  const leagueTotalCheck = Object.values(leagueStats24).reduce(
    (s, v) => s + v.total,
    0,
  );
  const integrityLeagueOk = leagueTotalCheck === stats24.total;
  const missingConf72 = bandMap72.get("Missing")?.total ?? 0;
  const missingLabel72 = labelMap72.get("Unknown")?.total ?? 0;

  // ── Build Markdown ─────────────────────────────────────────────────────────

  const feedEmoji =
    feedError ? "❌" : feedAgeMins !== null && feedAgeMins <= 90 ? "✅" : "⚠️";
  const cronEmoji = jobRunError
    ? "⚠️"
    : !cronLastAt
      ? "⚠️"
      : cronAgeMins !== null && cronAgeMins <= 120
        ? "✅"
        : "❌";
  const resolverEmoji = !lastResolverJobRun
    ? "❓"
    : resolverCronStatus === "error"
      ? "❌"
      : resolverCronAgeMins !== null && resolverCronAgeMins <= 480
        ? "✅"
        : "⚠️";

  out(`# PolyProPicks Daily Ops Report — ${reportDate}`);
  out(``);
  out(
    `> Generated: ${fmtDate(nowISO)} | Run: \`npm run ops:report\``,
  );
  out(``);

  // Executive Summary
  out(`## 📋 Executive Summary`);
  out(``);
  out(`| Компонент | Статус | Детали |`);
  out(`|-----------|--------|--------|`);
  out(
    `| Feed | ${feedEmoji} | ${
      feedError
        ? feedError
        : `Возраст кэша: ${feedAgeMins} мин, status: ${feedCacheStatus}`
    } |`,
  );
  out(
    `| Cache-cron | ${cronEmoji} | ${
      jobRunError
        ? "job_runs недоступен"
        : !cronLastAt
          ? "Нет записей в job_runs"
          : `Последний: ${fmtAge(cronLastAt)} назад (${safeStr(lastJobRun?.status) ?? "?"})`
    } |`,
  );
  out(
    `| Resolver cron | ${resolverEmoji} | ${
      !lastResolverJobRun
        ? `❓ нет job_run; fallback: latest resolved_at ${fmtAge(latestResolvedAt)} назад`
        : `Последний: ${fmtAge(resolverCronLastAt)} назад (${resolverCronStatus}), updated=${resolverCronUpdated ?? "?"}, selected=${resolverCronSelected ?? "N/A"}`
    } |`,
  );
  out(
    `| 24h Win rate | ${stats24.total > 0 ? stats24.winRate : "N/A"} | ${stats24.won}W / ${stats24.lost}L / ${stats24.total} total |`,
  );
  out(
    `| 24h Conf≥70 Win rate | ${stats24.confTotal > 0 ? stats24.confWinRate : "N/A"} | ${stats24.confWon}W / ${stats24.confLost}L / ${stats24.confTotal} сигналов |`,
  );
  out(
    `| Red flags | ${redFlags.length === 0 ? "✅ 0" : `⚠️ ${redFlags.length}`} | Смотри секцию Red Flags |`,
  );
  out(``);

  // Counting Method
  out(`## 📊 Counting Method`);
  out(``);
  out(`| Поле | Значение |`);
  out(`|------|----------|`);
  out(`| Метод | Unique signals (deduplicated) |`);
  out(`| Dedup key | condition_id + selected_token_id |`);
  out(`| Fallback key | event_slug + selected_outcome → id |`);
  out(`| Snapshot | earliest created_at per group |`);
  out(`| Raw rows 72h | ${dedupDiag.rawCount} |`);
  out(`| Unique signals 72h | ${dedupDiag.uniqueCount} |`);
  out(`| Duplicate groups | ${dedupDiag.duplicateGroups} |`);
  out(`| Max duplicates/group | ${dedupDiag.maxDuplicatesInGroup} |`);
  out(``);

  // Deploy State
  out(`## 🚀 Deploy State`);
  out(``);
  out(`| Поле | Значение |`);
  out(`|------|----------|`);
  out(`| Local HEAD | \`${headShort}\` |`);
  out(`| Commit | ${headMsg} |`);
  out(`| origin/main | \`${originShort}\` |`);
  out(
    `| Синхронизирован? | ${localMatchesOrigin ? "✅ Да" : "❌ Нет — проверь push"} |`,
  );
  out(
    `| Git working tree | ${dirtyTracked.length === 0 ? "✅ Чистый" : `⚠️ Dirty: ${dirtyTracked.join("; ")}`} |`,
  );
  out(
    `| Railway deploy | ⚠️ Не верифицирован (нет /api/health, нет NEXT_PUBLIC_COMMIT_SHA) |`,
  );
  out(``);

  // Feed Freshness
  out(`## 📡 Feed Freshness`);
  out(``);
  if (feedError) {
    out(`> ❌ Feed API недоступен: ${feedError}`);
  } else {
    out(`| Поле | Значение |`);
    out(`|------|----------|`);
    out(`| generatedAt | ${fmtDate(feedGeneratedAt)} |`);
    out(`| Возраст кэша | ${feedAgeMins} мин |`);
    out(`| cacheStatus | ${feedCacheStatus ?? "N/A"} |`);
    out(`| formulaVersion | ${feedFormula ?? "N/A"} |`);
    out(`| Пар в feed | ${feedPairs.length} |`);
    out(
      `| Confidence≥70 пар | ${feedConfCounts.ge70} / ${feedConfCounts.total} |`,
    );
  }
  out(``);

  // Feed Composition
  out(`## 🃏 Current Feed Composition`);
  out(``);
  if (feedPairs.length === 0) {
    out(`> ⚠️ Feed пустой или недоступен`);
  } else {
    out(`| Лига | Карт |`);
    out(`|------|------|`);
    for (const [league, count] of Object.entries(leagueCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      out(`| ${league} | ${count} |`);
    }
    if (topTitles.length > 0) {
      out(``);
      out(`**Топ событий:**`);
      for (const t of topTitles) out(`- ${t}`);
    }
  }
  out(``);

  // Cron Health
  out(`## ⏰ Cron Health`);
  out(``);
  out(`| Сервис | Статус | Последний запуск | Сгенерировано | Длительность |`);
  out(
    `|--------|--------|-----------------|---------------|--------------|`,
  );
  if (jobRunError) {
    out(
      `| signal-cache-cron | ⚠️ WARNING | job_runs недоступен | — | — |`,
    );
  } else if (!lastJobRun) {
    out(`| signal-cache-cron | ⚠️ Нет записей | — | — | — |`);
  } else {
    const status = safeStr(lastJobRun.status);
    const emoji =
      status === "success" ? "✅" : status === "error" ? "❌" : "⚠️";
    const genCount = lastJobRun.generated_count ?? "?";
    const dur = lastJobRun.duration_ms ?? "?";
    out(
      `| signal-cache-cron | ${emoji} ${status ?? "?"} | ${fmtDate(safeStr(lastJobRun.started_at))} (${fmtAge(safeStr(lastJobRun.started_at))} назад) | ${genCount} пар | ${dur}ms |`,
    );
  }
  if (resolverJobRunError) {
    out(
      `| signal-resolve-cron | ⚠️ query error | ${resolverJobRunError.slice(0, 60)} | — | — |`,
    );
  } else if (!lastResolverJobRun) {
    out(
      `| signal-resolve-cron | ❓ нет записей | — | — | — |`,
    );
  } else {
    const rEmoji =
      resolverCronStatus === "success"
        ? "✅"
        : resolverCronStatus === "error"
          ? "❌"
          : "⚠️";
    const durSec =
      resolverCronDur !== null
        ? `${(resolverCronDur / 1000).toFixed(1)}s`
        : "?";
    out(
      `| signal-resolve-cron | ${rEmoji} ${resolverCronStatus ?? "?"} | ${fmtDate(resolverCronLastAt)} (${fmtAge(resolverCronLastAt)} назад) | updated=${resolverCronUpdated ?? "?"} / selected=${resolverCronSelected ?? "N/A"} / skipped=${resolverCronSkipped ?? "?"} | ${durSec} |`,
    );
  }
  out(``);

  // Performance
  out(`## 📊 Performance: Resolved 24h / 48h / 72h / 7d / All time`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен: ${resolvedError}`);
  } else {
    out(`| Окно | Всего | Won | Lost | Push | Win% | Avg Conf | Avg Return | Total Return |`);
    out(
      `|------|-------|-----|------|------|------|----------|------------|--------------|`,
    );
    for (const [label, s] of [
      ["24h", stats24],
      ["48h", stats48],
      ["72h", stats72],
      ["7d", stats7d],
      ["All time", statsAllTime],
    ] as [string, WindowStats][]) {
      out(
        `| ${label} | ${s.total} | ${s.won} | ${s.lost} | ${s.push} | ${s.winRate} | ${s.avgConf} | ${s.avgReturn} | ${s.totalReturn} |`,
      );
    }
  }
  out(``);

  // Confidence >=70
  out(`## 🎯 Confidence ≥70 Performance`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен`);
  } else {
    out(
      `| Окно | Conf≥70 total | Won | Lost | Win% | Conf null (пропущено) |`,
    );
    out(
      `|------|--------------|-----|------|------|-----------------------|`,
    );
    for (const [label, s] of [
      ["24h", stats24],
      ["48h", stats48],
      ["72h", stats72],
    ] as [string, WindowStats][]) {
      out(
        `| ${label} | ${s.confTotal} | ${s.confWon} | ${s.confLost} | ${s.confWinRate} | ${s.confMissing} |`,
      );
    }
  }
  out(``);

  // League split
  out(`## 🏟️ League Split (24h)`);
  out(``);
  if (resolvedError || rows24.length === 0) {
    out(`> ⚠️ Нет данных за 24h`);
  } else {
    out(`| Лига | Resolved | Won | Lost | Win% | Avg Conf |`);
    out(`|------|----------|-----|------|------|----------|`);
    for (const [league, s] of Object.entries(leagueStats24).sort(
      (a, b) => b[1].total - a[1].total,
    )) {
      out(
        `| ${league} | ${s.total} | ${s.won} | ${s.lost} | ${winRateFmt(s.won, s.lost)} | ${avgOrNA(s.confs)} |`,
      );
    }
  }
  out(``);

  // Latest resolved
  out(`## 🔎 Latest Resolved Signals (max 10)`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен`);
  } else if (resolvedRows.length === 0) {
    out(`> Нет resolved сигналов за 72h`);
  } else {
    out(`| # | Матч | Pick | Result | Conf | Return | Resolved |`);
    out(`|---|------|------|--------|------|--------|----------|`);
    for (const [i, r] of resolvedRows.slice(0, 10).entries()) {
      const title = (
        safeStr(r.event_slug) ??
        safeStr(r.premium_signal?.eventTitle) ??
        safeStr(r.premium_signal?.title) ??
        "?"
      ).slice(0, 38);
      const pick = (safeStr(r.selected_outcome) ?? "?").slice(0, 22);
      const resEmoji =
        r.signal_result === "won"
          ? "✅ WON"
          : r.signal_result === "lost"
            ? "❌ LOST"
            : (r.signal_result ?? "?");
      const conf = extractConf(r);
      const ret =
        r.realized_return_pct !== null
          ? `${r.realized_return_pct > 0 ? "+" : ""}${Math.round(r.realized_return_pct)}%`
          : "N/A";
      out(
        `| ${i + 1} | ${title} | ${pick} | ${resEmoji} | ${conf ?? "?"} | ${ret} | ${fmtDate(r.resolved_at)} |`,
      );
    }
  }
  out(``);

  // Unresolved backlog
  out(`## 📦 Unresolved Backlog`);
  out(``);
  if (unresolvedError) {
    out(`> ⚠️ Backlog query failed: ${unresolvedError}`);
  } else if (!backlogDedup) {
    out(`> ⚠️ Backlog data unavailable (DB not connected)`);
  } else {
    out(`| Метрика | Значение |`);
    out(`|---------|----------|`);
    out(`| Raw unresolved rows | ${backlogDedup.rawCount} |`);
    out(
      `| **Unique unresolved signals** | **${backlogDedup.uniqueCount}** |`,
    );
    out(`| Duplicate groups | ${backlogDedup.duplicateGroups} |`);
    out(`| Max duplicates/group | ${backlogDedup.maxDuplicatesInGroup} |`);
    out(
      `| Oldest unique unresolved | ${fmtDate(backlogDedup.oldestCreatedAt)} (${fmtAge(backlogDedup.oldestCreatedAt)} назад) |`,
    );
    out(
      `| Newest unique unresolved | ${fmtDate(backlogDedup.newestCreatedAt)} (${fmtAge(backlogDedup.newestCreatedAt)} назад) |`,
    );
    out(`| Latest resolved_at (global) | ${fmtDate(latestResolvedAt)} |`);
    out(
      `| Resolver health | ${
        !lastResolverJobRun
          ? "❓ нет job_runs строки (fallback: approx)"
          : `${resolverEmoji} run: ${fmtAge(resolverCronLastAt)} назад, status=${resolverCronStatus}, updated=${resolverCronUpdated ?? "?"}`
      } |`,
    );
  }
  out(``);

  // Confidence Band Performance
  out(`## 📊 Confidence Band Performance (72h)`);
  out(``);
  if (resolvedError || rows72.length === 0) {
    out(`> ⚠️ Нет данных за 72h`);
  } else {
    renderBreakdownTable(bandMap72, BAND_ORDER, out);
    out(``);
    out(`**24h разбивка:**`);
    out(``);
    if (rows24.length === 0) {
      out(`> ⚠️ Нет данных за 24h`);
    } else {
      renderBreakdownTable(bandMap24, BAND_ORDER, out);
    }
  }
  out(``);

  // Signal Label / Action Performance
  out(`## 🧭 Signal Label / Action Performance (72h)`);
  out(``);
  if (resolvedError || rows72.length === 0) {
    out(`> ⚠️ Нет данных за 72h`);
  } else {
    const labelOrder = ["Core Signal", "Value Lean", "Unknown"];
    renderBreakdownTable(labelMap72, labelOrder, out);
    out(``);
    out(
      `> ℹ️ Label источник: \`premium_signal.confidenceLabel\` → \`oddsBandLabel\` → \`Band:XX\`. \`formulaAudit\` не заполнен в БД — action breakdown недоступен.`,
    );
  }
  out(``);

  // League × Confidence ≥70
  out(`## 🏟️ League × Confidence ≥70`);
  out(``);
  if (resolvedError) {
    out(`> ❌ DB недоступен`);
  } else {
    out(`**24h (conf≥70 only):**`);
    out(``);
    if (Object.keys(leagueConf70_24).length === 0) {
      out(`> ⚠️ Нет сигналов с confidence≥70 за 24h`);
    } else {
      out(`| Лига | Conf≥70 | Won | Lost | Win% |`);
      out(`|------|---------|-----|------|------|`);
      for (const [league, s] of Object.entries(leagueConf70_24).sort(
        (a, b) => b[1].total - a[1].total,
      )) {
        out(
          `| ${league} | ${s.total} | ${s.won} | ${s.lost} | ${winRateFmt(s.won, s.lost)} |`,
        );
      }
    }
    out(``);
    out(`**72h (conf≥70 only):**`);
    out(``);
    if (Object.keys(leagueConf70_72).length === 0) {
      out(`> ⚠️ Нет сигналов с confidence≥70 за 72h`);
    } else {
      out(`| Лига | Conf≥70 | Won | Lost | Win% |`);
      out(`|------|---------|-----|------|------|`);
      for (const [league, s] of Object.entries(leagueConf70_72).sort(
        (a, b) => b[1].total - a[1].total,
      )) {
        out(
          `| ${league} | ${s.total} | ${s.won} | ${s.lost} | ${winRateFmt(s.won, s.lost)} |`,
        );
      }
    }
  }
  out(``);

  // ── OBS Sections ─────────────────────────────────────────────────────────────

  // SECTION A: Timing Data Quality
  out(`## 🔬 OBS: Timing Data Quality — All time [observation only]`);
  out(``);
  out(`| Counter | Value |`);
  out(`|---------|-------|`);
  out(`| Deduplicated resolved rows | ${rowsAllTime.length} |`);
  out(`| diagnostics missing | ${obsDiagMissing} |`);
  out(`| gameStartIso missing or invalid | ${obsGameIsoMissing} |`);
  out(`| timing basis: upcoming_candidate_resolved_game_time_proxy | ${obsUpcomingBasis} |`);
  out(`| timing basis: ambiguous_game_start_or_close_proxy | ${obsAmbiguousBasis} |`);
  out(`| resolved before event-start proxy | ${obsResolvedBeforeProxy} |`);
  out(`| derived prematch_proxy | ${obsPrematch} |`);
  out(`| derived live_proxy | ${obsLiveProxy} |`);
  out(`| unknown phase | ${obsUnknown} |`);
  out(`| parent event URL basis | ${obsParentUrlBasis} |`);
  out(`| parent event fallback basis | ${obsParentFallbackBasis} |`);
  out(`| market_close_iso | ABSENT FROM RESOLVED SNAPSHOTS |`);
  out(``);
  out(`> ℹ️ Counters are observation-only. gameStartIso semantics are mixed (kickoff for sports-discovery, market endDate for others). Do not use as a production filter.`);
  out(``);

  // SECTION B: Derived Phase Proxy
  out(`## 🔬 OBS: Derived Phase Proxy — observation only`);
  out(``);
  out(`| Window | Phase proxy | Total | Won | Lost | Push | Win% | Avg Return | Total Return |`);
  out(`|--------|-------------|-------|-----|------|------|------|------------|--------------|`);
  for (const [label, wrows] of obsWindowDefs) {
    for (const phase of ["prematch_proxy", "live_proxy", "unknown"] as const) {
      const s = computeObsStats(obsPhaseFilter(wrows, phase));
      out(`| ${label} | ${phase} | ${s.total} | ${s.won} | ${s.lost} | ${s.push} | ${s.winRate} | ${s.avgReturn} | ${s.totalReturn} |`);
    }
  }
  out(``);

  // SECTION C: Prematch Timing Proxy Cohorts
  out(`## 🔬 OBS: Prematch Timing Proxy Cohorts — observation only`);
  out(``);
  out(`| Window | Timing proxy cohort | Total | Won | Lost | Push | Win% | Avg Return | Total Return |`);
  out(`|--------|---------------------|-------|-----|------|------|------|------------|--------------|`);
  for (const [label, wrows] of obsWindowDefs) {
    const cohorts: [string, ResolvedRow[]][] = [
      ["<15m", obsTimingCohortFilter(wrows, 0, 14)],
      ["15–59m", obsTimingCohortFilter(wrows, 15, 59)],
      ["60–119m", obsTimingCohortFilter(wrows, 60, 119)],
      ["120m+", obsTimingCohortFilter(wrows, 120, 999_999)],
      ["live_proxy", obsPhaseFilter(wrows, "live_proxy")],
      ["unknown", obsPhaseFilter(wrows, "unknown")],
    ];
    for (const [cohort, crows] of cohorts) {
      const s = computeObsStats(crows);
      out(`| ${label} | ${cohort} | ${s.total} | ${s.won} | ${s.lost} | ${s.push} | ${s.winRate} | ${s.avgReturn} | ${s.totalReturn} |`);
    }
  }
  out(``);

  // SECTION D: Simulated What-If Formulas
  out(`## 🔬 OBS: Simulated What-If Formulas — NOT DEPLOYED`);
  out(``);
  out(`| Window | Formula | Total | Won | Lost | Push | Win% | Avg Return | Total Return |`);
  out(`|--------|---------|-------|-----|------|------|------|------------|--------------|`);
  for (const [label, wrows] of [["72h", rows72], ["7d", rows7d], ["All time", rowsAllTime]] as [string, ResolvedRow[]][]) {
    const base = computeObsStats(wrows);
    const excl1to2h = computeObsStats(
      wrows.filter((r) => {
        const tp = obsTimingCache.get(r.id) ?? deriveTimingProxy(r);
        if (tp.phaseProxy !== "prematch_proxy" || tp.minutesToEventStartProxy === null) return true;
        return !(tp.minutesToEventStartProxy >= 60 && tp.minutesToEventStartProxy <= 119);
      }),
    );
    const only15to59 = computeObsStats(obsTimingCohortFilter(wrows, 15, 59));
    const exclTotals = computeObsStats(
      wrows.filter((r) => (obsFamilyCache.get(r.id) ?? deriveMarketFamilyProxy(r)) !== "totals"),
    );
    for (const [formula, s] of [
      ["OBS-BASE", base],
      ["OBS-EXCLUDE-1TO2H", excl1to2h],
      ["OBS-ONLY-15TO59M", only15to59],
      ["OBS-EXCLUDE-TOTALS", exclTotals],
    ] as [string, ObsStats][]) {
      out(`| ${label} | ${formula} | ${s.total} | ${s.won} | ${s.lost} | ${s.push} | ${s.winRate} | ${s.avgReturn} | ${s.totalReturn} |`);
    }
  }
  out(``);
  out(`> ⚠️ These rows are observation-only historical simulations. Production feed is unchanged. Do not interpret as approved filters.`);
  out(``);

  // SECTION E: Correlated Exposure Proxy
  out(`## 🔬 OBS: Correlated Exposure Proxy — All time [observation only]`);
  out(``);
  out(`| Metric | Value |`);
  out(`|--------|-------|`);
  out(`| Unique parent-event proxies | ${obsParentKeyMap.size} |`);
  out(`| Parent-event proxies with multiple condition_ids | ${obsMultiConditionParents} |`);
  out(`| Parent-event proxies with multiple market-family proxies | ${obsMultiFamilyParents} |`);
  out(`| Max condition_id count within one parent-event proxy | ${obsMaxCondPerParent} |`);
  out(``);
  out(`**Market-family proxy counts:**`);
  out(``);
  out(`| Family | Count |`);
  out(`|--------|-------|`);
  for (const [fam, cnt] of Object.entries(obsFamilyCounts).sort((a, b) => b[1] - a[1])) {
    out(`| ${fam} | ${cnt} |`);
  }
  out(``);
  out(`**League counts (all-time, explicit premium_signal.league):**`);
  out(``);
  out(`| League | Count |`);
  out(`|--------|-------|`);
  for (const [lg, cnt] of Object.entries(obsLeagueCounts).sort((a, b) => b[1] - a[1])) {
    out(`| ${lg} | ${cnt} |`);
  }
  out(``);

  // SECTION F: M3-B Source Truth Counters
  out(`## 🔬 OBS: M3-B Source Truth Counters — All time [proxy only]`);
  out(``);
  {
    const tot = rowsAllTime.length;
    const pct = (n: number) => tot > 0 ? `${Math.round(n / tot * 100)}%` : "N/A";
    out(`| Evidence Dimension | Count | % |`);
    out(`|--------------------|-------|---|`);
    out(`| Total resolved rows | ${tot} | 100% |`);
    out(`| SmartMoney fallback (maxTC + recTC both null) | ${m3bSmFallback} | ${pct(m3bSmFallback)} |`);
    out(`| PubWhale fallback (selCnt=0 or recTC null) | ${m3bPwFallback} | ${pct(m3bPwFallback)} |`);
    out(`| coverage missing | ${m3bCovMissing} | ${pct(m3bCovMissing)} |`);
    out(`| coverage none (=0) | ${m3bCovNone} | ${pct(m3bCovNone)} |`);
    out(`| coverage low (=25) | ${m3bCovLow} | ${pct(m3bCovLow)} |`);
    out(`| coverage medium (=50) | ${m3bCovMedium} | ${pct(m3bCovMedium)} |`);
    out(`| coverage high (=75 or 100) | ${m3bCovHigh} | ${pct(m3bCovHigh)} |`);
    out(`| coverage unexpected | ${m3bCovUnexpected} | ${pct(m3bCovUnexpected)} |`);
    if (m3bCovUnexpected > 0) {
      out(``);
      out(`> ⚠️ WARNING: UNEXPECTED DATA COVERAGE VALUE DETECTED`);
    }
    out(`| selectedCashAvailable (recentTradeCash non-null) | ${m3bSelCashAvail} | ${pct(m3bSelCashAvail)} |`);
    out(`| selectedCountAvailable (selectedTradeCount non-null) | ${m3bSelCntAvail} | ${pct(m3bSelCntAvail)} |`);
    out(`| totalCountAvailable (totalTradeCount non-null) | ${m3bTotCntAvail} | ${pct(m3bTotCntAvail)} |`);
    out(`| opposingCountDerivable (totCnt + selCnt non-null) | ${m3bOppCntDerivable} | ${pct(m3bOppCntDerivable)} |`);
    out(`| opposingCashAvailable | 0 | ABSENT FROM RESOLVED SNAPSHOTS |`);
  }
  out(``);
  out(`> ℹ️ Proxy only. These counters reflect evidence available at signal-creation time. Do not use as independent evidence.`);
  out(``);

  // SECTION G: M3-B Sizing Shadows
  out(`## 🔬 OBS: M3-B Sizing Shadows — NOT DEPLOYED`);
  out(``);
  out(`**ScoreC B25 sizing threshold:**`);
  out(`- Locked (SCOREC_B25_LOCKED_Q25): \`${SCOREC_B25_LOCKED_Q25.toFixed(6)}\` (frozen — never re-derived)`);
  out(`- Recomputed train-only Q25 (cutoff ${TRAIN_CUTOFF}, n=${m3bTrainScoreCN}): ${m3bScoreCQ25 !== null ? m3bScoreCQ25.toFixed(6) : "N/A"}`);
  out(`- Threshold drift: ${m3bScoreCDrift !== null ? m3bScoreCDrift.toFixed(6) : "N/A"}${m3bScoreCDrift !== null && m3bScoreCDrift > 0.000001 ? " ⚠️ WARNING: LOCKED SCOREC Q25 DRIFT DETECTED" : " (within tolerance)"}`);
  out(``);
  out(`| Window | Strategy | Active Rows | P&L | ROI | Max DD | Worst Day | +Day% |`);
  out(`|--------|----------|-------------|-----|-----|--------|-----------|-------|`);
  {
    const sizingEntries: Array<[string, string]> = [
      ["flat",  "FLAT-KNOWN ($10 if action≠ABSENT)"],
      ["a1",    "ACTION-1 (ENTER=$10, SMALL=$5, WATCH=$0)"],
      ["f2",    "FAMILY-2 (A1 + Longshot≤$2.50 + totals+SMALL≤$2.50)"],
      ["f2b25", "FAMILY-2+SCOREC-B25-HALF (F2×0.5 if ScoreC<Q25)"],
    ];
    for (const [lbl] of M3B_SIZING_DEFS) {
      const sz = m3bSizingStats[lbl];
      for (const [key, label] of sizingEntries) {
        const s = sz[key as M3bSizingKey];
        out(`| ${lbl} | ${label} | ${s.activeRows} | ${s.pnl} | ${s.roi} | ${s.maxDD} | ${s.worstDay} | ${s.positiveDayShare} |`);
      }
    }
  }
  out(``);
  out(`> ⚠️ Shadow only. No sizing changes are deployed. Historical simulation on proxy data.`);
  out(``);

  // SECTION H: M3-B Score Benchmarks
  out(`## 🔬 OBS: M3-B Score Benchmarks — SHADOW ONLY`);
  out(``);
  {
    // Known-action ranking universe: exclude legacy ABSENT rows (no action label)
    const m3bKaAll = rowsAllTime.filter(r => getActionLabel(r) !== "ABSENT");
    const m3bKa7d  = rows7d.filter(r => getActionLabel(r) !== "ABSENT");
    const m3bExclAll = rowsAllTime.length - m3bKaAll.length;
    const m3bExcl7d  = rows7d.length - m3bKa7d.length;
    out(`benchmark universe: KNOWN_ACTION_ONLY`);
    out(`- All time: included=${m3bKaAll.length}, excluded legacy ABSENT=${m3bExclAll}`);
    out(`- 7d:       included=${m3bKa7d.length}, excluded legacy ABSENT=${m3bExcl7d}`);
    out(`> ℹ️ LEGACY_ABSENT rows remain visible in overall performance reporting but are excluded from ranking-quality evaluation.`);
    out(``);
    out(`| Window | Score | N | Spearman | Q4 ROI | Q1 ROI | Spread (uv) |`);
    out(`|--------|-------|---|----------|--------|--------|-------------|`);
    const m3bBenchDefs: [string, ResolvedRow[]][] = [["7d", m3bKa7d], ["All time", m3bKaAll]];
    const m3bScoreDefs: Array<[string, (r: ResolvedRow) => number | null]> = [
      ["PROD-RAW (finalSignalV2)", getProdRawScore],
      ["DEDUPE-CONSERVATIVE", computeDedupeConservative],
      ["SCOREC-META-RISK-PROXY", computeScoreCMetaRisk],
    ];
    for (const [wlbl, wrows] of m3bBenchDefs) {
      for (const [slbl, scoreFn] of m3bScoreDefs) {
        const q = quartileROI(wrows, scoreFn);
        const sp = spearmanVsReturn(wrows, scoreFn);
        out(`| ${wlbl} | ${slbl} | ${q.n} | ${sp} | ${q.q4roi} | ${q.q1roi} | ${q.spread} |`);
      }
    }

    // SECTION I: M3-B Component Diagnostics
    out(``);
    out(`## 🔬 OBS: M3-B Component Diagnostics — PROXY ONLY`);
    out(``);
    out(`benchmark universe: KNOWN_ACTION_ONLY (same filter as Score Benchmarks)`);
    out(``);
    out(`| Window | Component | N | Spearman | Q4 ROI | Q1 ROI | Spread (uv) |`);
    out(`|--------|-----------|---|----------|--------|--------|-------------|`);
    const m3bCompDefs: Array<[string, (r: ResolvedRow) => number | null]> = [
      ["OddsQuality (ODDS_ALPHA_MAP[band])", getOddsQualityComponent],
      ["ActionQuality (ACTION_MAP[action])", getActionQualityComponent],
      ["FlowSigmoid (log-sigmoid recentTradeCash, PROXY ONLY)", getFlowSigmoidComponent],
      ["CoverageNorm (dataCoverage/100)", getCoverageNormComponent],
    ];
    for (const [wlbl, wrows] of m3bBenchDefs) {
      for (const [clbl, compFn] of m3bCompDefs) {
        const q = quartileROI(wrows, compFn);
        const sp = spearmanVsReturn(wrows, compFn);
        out(`| ${wlbl} | ${clbl} | ${q.n} | ${sp} | ${q.q4roi} | ${q.q1roi} | ${q.spread} |`);
      }
    }
  }
  out(``);
  out(`> ℹ️ FlowSigmoid: recentTradeCash selected-side proxy. Null rows excluded from N. Opposing-side cash ABSENT from all resolved snapshots.`);
  out(``);

  // M3-B methodology warning (FIX 5)
  out(`---`);
  out(`> **⚠️ M3-B Methodology Notice**`);
  out(`> All M3-B metrics are observation-only.`);
  out(`> Primary ranking-quality universe excludes legacy ABSENT rows.`);
  out(`> Discrete components use tie-safe reporting; quartile ROI is N/A when equal-value splitting would be arbitrary.`);
  out(`> Score-C is a meta-risk proxy overlay, not Independent Evidence v2.`);
  out(`> Production feed, confidence, ranking and sizing are unchanged.`);
  out(``);

  // ── END OBS Sections ──────────────────────────────────────────────────────────

  // Report Integrity Checks
  out(`## ✅ Report Integrity Checks`);
  out(``);
  out(`| Проверка | Статус | Детали |`);
  out(`|----------|--------|--------|`);
  out(
    `| Band total == unique 72h | ${integrityBandOk ? "✅ OK" : "❌ MISMATCH"} | bandTotal=${bandTotal72}, unique72=${stats72.total} |`,
  );
  out(
    `| League total == unique 24h | ${integrityLeagueOk ? "✅ OK" : "❌ MISMATCH"} | leagueTotal=${leagueTotalCheck}, unique24=${stats24.total} |`,
  );
  out(
    `| Missing confidence 72h | ${missingConf72 === 0 ? "✅ 0" : `⚠️ ${missingConf72}`} | строк без confidence |`,
  );
  out(
    `| Missing label 72h | ${missingLabel72 === 0 ? "✅ 0" : `⚠️ ${missingLabel72}`} | строк без confidenceLabel/oddsBandLabel |`,
  );
  out(``);

  // Red Flags
  out(`## 🔴 Red Flags / Action Items`);
  out(``);
  if (redFlags.length === 0) {
    out(`✅ Все системы в норме. Критических нарушений нет.`);
  } else {
    for (const f of redFlags) out(`- ${f}`);
  }
  out(``);
  out(`---`);
  out(
    `*Отчёт сформирован: ${fmtDate(nowISO)} | PolyProPicks Ops Report v1.4*`,
  );

  const reportText = lines.join("\n");

  if (EMAIL_MODE_RECIPIENT) {
    const subject = `PolyProPicks Daily Ops Report — ${reportDate}`;
    const html = `<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px">${escapeHtml(reportText)}</pre>`;
    try {
      await sendEmail({ to: EMAIL_MODE_RECIPIENT, subject, text: reportText, html });
      console.log(`[ops-report] ✅ Email sent to ${EMAIL_MODE_RECIPIENT}`);
      console.log(`[ops-report] Subject: ${subject}`);
    } catch (e) {
      console.error(
        "[ops-report] ❌ Email failed:",
        e instanceof Error ? e.message : String(e),
      );
      process.exit(1);
    }
  } else {
    // Print to stdout
    console.log(reportText);
  }

  // Exit 1 only if no data at all could be gathered
  if (dbConnectError && feedError) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(
    "[ops-report] Fatal:",
    e instanceof Error ? e.message : String(e),
  );
  process.exit(1);
});
