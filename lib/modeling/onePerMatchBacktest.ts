import ExcelJS from "exceljs";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { buildEventGroupKey } from "./eventGroupSelection";

export type BacktestRawRow = Record<string, unknown>;

type NormalizedPick = {
  signal_id: string;
  condition_id: string;
  token_id: string;
  market_slug: string;
  event_slug: string;
  event_title: string;
  match_family_key: string;
  event_group_key: string;
  event_group_key_source: string;
  sport: string;
  strategic_scope: string;
  market_family: string;
  side: string;
  selected_outcome: string;
  strategy: string;
  tier: string;
  score: number | null;
  coverage: number | null;
  smart_money: number | null;
  entry_price: number | null;
  max_entry_price: number | null;
  stake_usd: number;
  live_eligible: boolean | null;
  live_rejection_reason: string;
  created_at: string;
  resolved_at: string;
  won: boolean | null;
  outcome_status: string;
  return_pct: number | null;
  pnl10: number;
  actual_pnl: number;
  raw: BacktestRawRow;
};

export type OnePerMatchBacktestResult = {
  runId: string;
  runStartedAt: string;
  runCompletedAt: string;
  corpusHash: string;
  corpusFrom: string | null;
  corpusTo: string | null;
  rawRows: number;
  resolvedRows: number;
  unresolvedRows: number;
  uniqueStrictRows: number;
  uniqueEventGroups: number;
  selectedRows: number;
  groupKeyCoverage: Record<string, number>;
  topDuplicateGroups: Array<{ event_group_key: string; rows: number; selected_signal_id: string }>;
  comparisonRows: BacktestComparisonRow[];
  windowRows: BacktestComparisonRow[];
  selectedPicks: BacktestPickRow[];
  eventGroupRows: BacktestEventGroupRow[];
  dbStatus: {
    attempted: boolean;
    insertedRun: boolean;
    insertedPicks: number;
    error: string | null;
  };
  artifactPaths: {
    summaryJson: string;
    selectedPicksCsv: string;
    eventGroupsCsv: string;
    comparisonCsv: string;
  };
  notes: string[];
};

export type BacktestComparisonRow = {
  model_variant: string;
  raw_picks: number;
  unique_events: number;
  selected_bets: number;
  turnover: number;
  wins: number;
  losses: number;
  winrate: number;
  roi: number;
  pnl: number;
  max_drawdown: number;
  pnl_over_maxdd: number | null;
  notes: string;
};

export type BacktestPickRow = {
  run_id: string;
  event_group_key: string;
  selection_rank: number;
  selected: boolean;
  signal_id: string;
  condition_id: string;
  token_id: string;
  market_slug: string;
  event_slug: string;
  event_title: string;
  match_family_key: string;
  sport: string;
  strategic_scope: string;
  side: string;
  selected_outcome: string;
  strategy: string;
  tier: string;
  score: number | null;
  coverage: number | null;
  smart_money: number | null;
  entry_price: number | null;
  max_entry_price: number | null;
  stake_usd: number;
  created_at: string;
  resolved_at: string;
  outcome_status: string;
  won: boolean | null;
  pnl: number;
  roi: number;
  selection_reason: string;
  rejected_same_event_count: number;
  raw: BacktestRawRow;
};

export type BacktestEventGroupRow = {
  event_group_key: string;
  event_group_key_source: string;
  row_count: number;
  selected_signal_id: string;
  selected_market_slug: string;
  selected_side: string;
  rejected_same_event_count: number;
  selection_reason: string;
};

const COMPARISON_HEADERS = [
  "model_variant", "raw_picks", "unique_events", "selected_bets", "turnover", "wins", "losses",
  "winrate", "roi", "pnl", "max_drawdown", "pnl_over_maxdd", "notes",
];

const PICK_HEADERS = [
  "run_id", "event_group_key", "selection_rank", "selected", "signal_id", "condition_id", "token_id",
  "market_slug", "event_slug", "event_title", "match_family_key", "sport", "strategic_scope", "side",
  "selected_outcome", "strategy", "tier", "score", "coverage", "smart_money", "entry_price",
  "max_entry_price", "stake_usd", "created_at", "resolved_at", "outcome_status", "won", "pnl", "roi",
  "selection_reason", "rejected_same_event_count",
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (["true", "yes", "1"].includes(s)) return true;
    if (["false", "no", "0"].includes(s)) return false;
  }
  return null;
}

function getPath(row: BacktestRawRow, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  const raw = row.raw_json;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") return obj[key];
    }
  }
  return null;
}

function tierOf(row: BacktestRawRow, score: number | null, coverage: number | null): string {
  const explicit = str(getPath(row, ["tier", "strategy"]));
  if (/TIER1/i.test(explicit)) return "TIER1";
  if (/TIER2/i.test(explicit)) return "TIER2";
  if (/TIER3/i.test(explicit)) return "TIER3";
  if ((score ?? 0) >= 72 && (coverage ?? 0) >= 50) return "TIER1";
  if ((score ?? 0) >= 60 && (coverage ?? 0) >= 50) return "TIER2";
  if ((score ?? 0) >= 50) return "TIER3";
  return "UNKNOWN";
}

function outcome(row: BacktestRawRow, entryPrice: number | null): { won: boolean | null; status: string; returnPct: number | null; pnl10: number } {
  const rp = num(getPath(row, ["realized_return_pct", "realizedReturnPct"]));
  const result = str(getPath(row, ["signal_result", "result", "outcome_status"])).toLowerCase();
  let won: boolean | null = null;
  if (["win", "won", "hit", "correct", "yes"].includes(result)) won = true;
  if (["loss", "lost", "miss", "incorrect", "no"].includes(result)) won = false;
  if (won === null && rp !== null) won = rp > 0;
  if (rp !== null) return { won, status: result || (won ? "win" : "loss"), returnPct: rp, pnl10: 10 * rp / 100 };
  if (won === true && entryPrice && entryPrice > 0) {
    const pct = (1 / entryPrice - 1) * 100;
    return { won, status: result || "win", returnPct: pct, pnl10: 10 * pct / 100 };
  }
  if (won === false) return { won, status: result || "loss", returnPct: -100, pnl10: -10 };
  return { won: null, status: result || "unknown", returnPct: null, pnl10: 0 };
}

function normalizePick(row: BacktestRawRow): NormalizedPick | null {
  const condition = str(getPath(row, ["condition_id", "conditionId"]));
  const token = str(getPath(row, ["selected_token_id", "token_id", "selectedTokenId", "tokenId"]));
  if (!condition || !token) return null;
  const score = num(getPath(row, ["signal_confidence_num", "score", "final_score", "confidence"]));
  const coverage = num(getPath(row, ["data_coverage_num", "coverage", "dataCoverage"]));
  const entryPrice = num(getPath(row, ["entry_price_num", "entry_price", "entryPrice"]));
  const out = outcome(row, entryPrice);
  if (out.won === null && out.returnPct === null) return null;
  const group = buildEventGroupKey(row);
  const stake = num(getPath(row, ["stake_usd", "stakeUsd"])) ?? 10;
  const tier = tierOf(row, score, coverage);
  return {
    signal_id: str(getPath(row, ["id", "row_id", "signal_id"])) || `${condition}:${token}`,
    condition_id: condition,
    token_id: token,
    market_slug: str(getPath(row, ["market_slug", "marketSlug"])),
    event_slug: str(getPath(row, ["event_slug", "event_key", "eventSlug"])),
    event_title: str(getPath(row, ["event_title", "title", "question"])),
    match_family_key: str(getPath(row, ["match_family_key", "matchFamilyKey"])),
    event_group_key: group.key,
    event_group_key_source: group.source,
    sport: str(getPath(row, ["sport", "inferred_sport", "sport_or_scope", "league"])),
    strategic_scope: str(getPath(row, ["strategic_scope", "scope", "sport_or_scope"])),
    market_family: str(getPath(row, ["market_family", "marketFamily"])),
    side: str(getPath(row, ["selected_side", "side", "selected_outcome"])),
    selected_outcome: str(getPath(row, ["selected_outcome", "selectedOutcome", "side"])),
    strategy: str(getPath(row, ["strategy", "metric_formula_version", "formula_version"])),
    tier,
    score,
    coverage,
    smart_money: num(getPath(row, ["smart_money", "smart_money_score_num", "smartMoney"])),
    entry_price: entryPrice,
    max_entry_price: num(getPath(row, ["max_entry_price", "maxEntryPrice"])),
    stake_usd: stake,
    live_eligible: bool(getPath(row, ["live_eligible", "liveEligible"])),
    live_rejection_reason: str(getPath(row, ["live_rejection_reason", "liveRejectionReason"])),
    created_at: str(getPath(row, ["created_at", "createdAt"])),
    resolved_at: str(getPath(row, ["resolved_at", "resolvedAt"])),
    won: out.won,
    outcome_status: out.status,
    return_pct: out.returnPct,
    pnl10: out.pnl10,
    actual_pnl: stake * (out.returnPct ?? 0) / 100,
    raw: row,
  };
}

function strictKey(p: NormalizedPick): string {
  return `${p.condition_id}::${p.token_id}`;
}

function tierRank(tier: string): number {
  if (tier === "TIER1") return 3;
  if (tier === "TIER2") return 2;
  if (tier === "TIER3") return 1;
  return 0;
}

function rankTuple(p: NormalizedPick): Array<number | string> {
  return [
    p.live_eligible === true ? 1 : 0,
    tierRank(p.tier),
    p.score ?? -1,
    p.coverage ?? -1,
    p.smart_money ?? -1,
    p.entry_price !== null && p.entry_price >= 0.25 && p.entry_price <= 0.65 ? 1 : 0,
    p.created_at ? -Date.parse(p.created_at) : 0,
    p.signal_id,
  ];
}

function comparePick(a: NormalizedPick, b: NormalizedPick): number {
  const ar = rankTuple(a);
  const br = rankTuple(b);
  for (let i = 0; i < ar.length; i++) {
    if (ar[i] === br[i]) continue;
    if (typeof ar[i] === "string" || typeof br[i] === "string") return String(ar[i]).localeCompare(String(br[i]));
    return (br[i] as number) - (ar[i] as number);
  }
  return 0;
}

function selectionReason(p: NormalizedPick): string {
  return [
    p.live_eligible === true ? "live_eligible" : "live_missing_or_false",
    p.tier,
    `score=${p.score ?? "NA"}`,
    `coverage=${p.coverage ?? "NA"}`,
    `created_at=${p.created_at || "NA"}`,
  ].join(" > ");
}

function maxDrawdown(pnls: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function metrics(name: string, rows: NormalizedPick[], rawRows: number, uniqueEvents: number, notes: string): BacktestComparisonRow {
  const sorted = [...rows].sort((a, b) => Date.parse(a.resolved_at || a.created_at || "0") - Date.parse(b.resolved_at || b.created_at || "0"));
  const wins = rows.filter((r) => r.won === true).length;
  const losses = rows.filter((r) => r.won === false).length;
  const turnover = rows.length * 10;
  const pnl = rows.reduce((s, r) => s + r.pnl10, 0);
  const dd = maxDrawdown(sorted.map((r) => r.pnl10));
  return {
    model_variant: name,
    raw_picks: rawRows,
    unique_events: uniqueEvents,
    selected_bets: rows.length,
    turnover,
    wins,
    losses,
    winrate: rows.length ? wins / rows.length * 100 : 0,
    roi: turnover ? pnl / turnover * 100 : 0,
    pnl,
    max_drawdown: dd,
    pnl_over_maxdd: dd > 0 ? pnl / dd : null,
    notes,
  };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function uuidFromHash(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function writeCsv(file: string, rows: Record<string, unknown>[], headers: string[]) {
  await writeFile(file, [headers.join(","), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n") + "\n", "utf8");
}

export async function runOnePerMatchBacktestFromRows(rows: BacktestRawRow[], outDir: string): Promise<OnePerMatchBacktestResult> {
  console.log("ONE_PER_MATCH_BACKTEST_START");
  const runStartedAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });
  const corpusHash = createHash("sha256").update(JSON.stringify(rows.map((r) => [r.id, r.condition_id, r.selected_token_id, r.resolved_at, r.signal_result, r.realized_return_pct]))).digest("hex");
  const byStrict = new Map<string, NormalizedPick>();
  let unresolvedRows = 0;
  for (const row of rows) {
    const pick = normalizePick(row);
    if (!pick) {
      unresolvedRows += 1;
      continue;
    }
    const key = strictKey(pick);
    const prev = byStrict.get(key);
    if (!prev || Date.parse(pick.resolved_at || pick.created_at || "0") > Date.parse(prev.resolved_at || prev.created_at || "0")) byStrict.set(key, pick);
  }
  const picks = [...byStrict.values()];
  const groups = new Map<string, NormalizedPick[]>();
  for (const pick of picks) {
    const arr = groups.get(pick.event_group_key) ?? [];
    arr.push(pick);
    groups.set(pick.event_group_key, arr);
  }
  const selected: NormalizedPick[] = [];
  const pickRows: BacktestPickRow[] = [];
  const eventGroupRows: BacktestEventGroupRow[] = [];
  const groupCoverage: Record<string, number> = {};
  for (const [key, arr] of groups.entries()) {
    const ranked = [...arr].sort(comparePick);
    const chosen = ranked[0];
    selected.push(chosen);
    groupCoverage[chosen.event_group_key_source] = (groupCoverage[chosen.event_group_key_source] ?? 0) + 1;
    eventGroupRows.push({
      event_group_key: key,
      event_group_key_source: chosen.event_group_key_source,
      row_count: arr.length,
      selected_signal_id: chosen.signal_id,
      selected_market_slug: chosen.market_slug,
      selected_side: chosen.side || chosen.selected_outcome,
      rejected_same_event_count: arr.length - 1,
      selection_reason: selectionReason(chosen),
    });
    ranked.forEach((pick, index) => {
      pickRows.push({
        run_id: "",
        event_group_key: key,
        selection_rank: index + 1,
        selected: index === 0,
        signal_id: pick.signal_id,
        condition_id: pick.condition_id,
        token_id: pick.token_id,
        market_slug: pick.market_slug,
        event_slug: pick.event_slug,
        event_title: pick.event_title,
        match_family_key: pick.match_family_key,
        sport: pick.sport,
        strategic_scope: pick.strategic_scope,
        side: pick.side,
        selected_outcome: pick.selected_outcome,
        strategy: pick.strategy,
        tier: pick.tier,
        score: pick.score,
        coverage: pick.coverage,
        smart_money: pick.smart_money,
        entry_price: pick.entry_price,
        max_entry_price: pick.max_entry_price,
        stake_usd: pick.stake_usd,
        created_at: pick.created_at,
        resolved_at: pick.resolved_at,
        outcome_status: pick.outcome_status,
        won: pick.won,
        pnl: pick.pnl10,
        roi: pick.return_pct ?? 0,
        selection_reason: index === 0 ? selectionReason(pick) : "REJECTED_SAME_EVENT_LOWER_EX_ANTE_RANK",
        rejected_same_event_count: index === 0 ? arr.length - 1 : 0,
        raw: pick.raw,
      });
    });
  }
  const corpusFrom = picks.reduce<string | null>((m, r) => !m || Date.parse(r.created_at) < Date.parse(m) ? r.created_at : m, null);
  const corpusTo = picks.reduce<string | null>((m, r) => !m || Date.parse(r.resolved_at || r.created_at) > Date.parse(m) ? (r.resolved_at || r.created_at) : m, null);
  const comparisonRows = [
    metrics("BASELINE_ALL_RESOLVED_PICKS", picks, rows.length, groups.size, "All strict-dedup resolved picks."),
    metrics("ONE_PER_MATCH_EX_ANTE_V1", selected, rows.length, groups.size, "One selected row per event group; ex-ante ranking only."),
  ];
  const nowMs = Date.now();
  const windowRows = [
    ...comparisonRows,
    metrics("ONE_PER_MATCH_RECENT_7D", selected.filter((r) => Date.parse(r.resolved_at || r.created_at) >= nowMs - 7 * 86400_000), rows.length, groups.size, "Recent 7d by resolved_at."),
    metrics("ONE_PER_MATCH_RECENT_96H", selected.filter((r) => Date.parse(r.resolved_at || r.created_at) >= nowMs - 96 * 3600_000), rows.length, groups.size, "Recent 96h by resolved_at."),
    metrics("ONE_PER_MATCH_RECENT_48H", selected.filter((r) => Date.parse(r.resolved_at || r.created_at) >= nowMs - 48 * 3600_000), rows.length, groups.size, "Recent 48h by resolved_at."),
  ];
  const runCompletedAt = new Date().toISOString();
  const runId = uuidFromHash(`${corpusHash}:${runCompletedAt}`);
  for (const row of pickRows) row.run_id = runId;
  const artifactPaths = {
    summaryJson: path.join(outDir, "latest_summary.json"),
    selectedPicksCsv: path.join(outDir, "latest_selected_picks.csv"),
    eventGroupsCsv: path.join(outDir, "latest_event_groups.csv"),
    comparisonCsv: path.join(outDir, "latest_comparison.csv"),
  };
  await writeCsv(artifactPaths.comparisonCsv, comparisonRows, COMPARISON_HEADERS);
  await writeCsv(artifactPaths.selectedPicksCsv, pickRows.filter((r) => r.selected), PICK_HEADERS);
  await writeCsv(artifactPaths.eventGroupsCsv, eventGroupRows as unknown as Record<string, unknown>[], [
    "event_group_key", "event_group_key_source", "row_count", "selected_signal_id", "selected_market_slug", "selected_side", "rejected_same_event_count", "selection_reason",
  ]);
  const result: OnePerMatchBacktestResult = {
    runId,
    runStartedAt,
    runCompletedAt,
    corpusHash,
    corpusFrom,
    corpusTo,
    rawRows: rows.length,
    resolvedRows: picks.length,
    unresolvedRows,
    uniqueStrictRows: picks.length,
    uniqueEventGroups: groups.size,
    selectedRows: selected.length,
    groupKeyCoverage: groupCoverage,
    topDuplicateGroups: eventGroupRows.sort((a, b) => b.row_count - a.row_count).slice(0, 10).map((g) => ({
      event_group_key: g.event_group_key,
      rows: g.row_count,
      selected_signal_id: g.selected_signal_id,
    })),
    comparisonRows,
    windowRows,
    selectedPicks: pickRows.filter((r) => r.selected),
    eventGroupRows,
    dbStatus: { attempted: false, insertedRun: false, insertedPicks: 0, error: null },
    artifactPaths,
    notes: [
      "Selection policy ONE_PER_MATCH_EX_ANTE_V1 does not use realized outcome, realized return, or PnL.",
      Object.keys(groupCoverage).some((k) => k.includes("fallback")) ? "LOW_CONFIDENCE_EVENT_GROUPING: fallback keys were used for some rows." : "Event grouping used available event metadata.",
    ],
  };
  await writeFile(artifactPaths.summaryJson, JSON.stringify(result, null, 2), "utf8");
  console.log(`ONE_PER_MATCH_BACKTEST_COMPLETE raw=${result.rawRows} resolved=${result.resolvedRows} events=${result.uniqueEventGroups} selected=${result.selectedRows} baseline_roi=${comparisonRows[0].roi.toFixed(2)} one_roi=${comparisonRows[1].roi.toFixed(2)}`);
  return result;
}

export async function persistOnePerMatchBacktest(result: OnePerMatchBacktestResult): Promise<OnePerMatchBacktestResult["dbStatus"]> {
  try {
    const { supabaseAdmin } = await import("../supabase/server");
    const baseline = result.comparisonRows[0];
    const one = result.comparisonRows[1];
    const { error: runError } = await supabaseAdmin.from("model_one_per_match_backtest_runs").insert({
      id: result.runId,
      run_started_at: result.runStartedAt,
      run_completed_at: result.runCompletedAt,
      corpus_from: result.corpusFrom,
      corpus_to: result.corpusTo,
      raw_rows: result.rawRows,
      resolved_rows: result.resolvedRows,
      unique_event_groups: result.uniqueEventGroups,
      selected_rows: result.selectedRows,
      baseline_roi: baseline.roi,
      baseline_pnl: baseline.pnl,
      one_per_match_roi: one.roi,
      one_per_match_pnl: one.pnl,
      baseline_winrate: baseline.winrate,
      one_per_match_winrate: one.winrate,
      baseline_max_drawdown: baseline.max_drawdown,
      one_per_match_max_drawdown: one.max_drawdown,
      selection_policy: "ONE_PER_MATCH_EX_ANTE_V1",
      corpus_hash: result.corpusHash,
      status: "success",
      notes: { groupKeyCoverage: result.groupKeyCoverage, notes: result.notes },
    });
    if (runError) throw runError;
    const chunkSize = 500;
    let inserted = 0;
    for (let i = 0; i < result.selectedPicks.length; i += chunkSize) {
      const chunk = result.selectedPicks.slice(i, i + chunkSize).map((row) => ({
        run_id: result.runId,
        event_group_key: row.event_group_key,
        selection_rank: row.selection_rank,
        selected: row.selected,
        signal_id: row.signal_id,
        condition_id: row.condition_id,
        token_id: row.token_id,
        market_slug: row.market_slug,
        event_slug: row.event_slug,
        event_title: row.event_title,
        match_family_key: row.match_family_key,
        sport: row.sport,
        strategic_scope: row.strategic_scope,
        side: row.side,
        selected_outcome: row.selected_outcome,
        strategy: row.strategy,
        tier: row.tier,
        score: row.score,
        coverage: row.coverage,
        smart_money: row.smart_money,
        entry_price: row.entry_price,
        max_entry_price: row.max_entry_price,
        stake_usd: row.stake_usd,
        created_at: row.created_at || null,
        resolved_at: row.resolved_at || null,
        outcome_status: row.outcome_status,
        won: row.won,
        pnl: row.pnl,
        roi: row.roi,
        selection_reason: row.selection_reason,
        rejected_same_event_count: row.rejected_same_event_count,
        raw: row.raw,
      }));
      const { error } = await supabaseAdmin.from("model_one_per_match_backtest_picks").insert(chunk);
      if (error) throw error;
      inserted += chunk.length;
    }
    return { attempted: true, insertedRun: true, insertedPicks: inserted, error: null };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message)
        : JSON.stringify(error);
    return { attempted: true, insertedRun: false, insertedPicks: 0, error: message };
  }
}

export async function writeOnePerMatchSummary(result: OnePerMatchBacktestResult): Promise<void> {
  await writeFile(result.artifactPaths.summaryJson, JSON.stringify(result, null, 2), "utf8");
}

export function onePerMatchEmailSummary(result: OnePerMatchBacktestResult): string {
  const base = result.comparisonRows[0];
  const one = result.comparisonRows[1];
  const verdict = one.roi > base.roi ? "improved" : one.roi < base.roi ? "degraded" : "inconclusive";
  return [
    "One-Per-Match Backtest:",
    `Historical all-pick baseline used ${result.resolvedRows} resolved picks across ${result.uniqueEventGroups} event groups.`,
    `The one-per-match policy selected ${result.selectedRows} bets, one per event, using ex-ante ranking only.`,
    `ROI changed from ${base.roi.toFixed(2)}% to ${one.roi.toFixed(2)}%.`,
    `PnL changed from $${base.pnl.toFixed(2)} to $${one.pnl.toFixed(2)}.`,
    `Max drawdown changed from $${base.max_drawdown.toFixed(2)} to $${one.max_drawdown.toFixed(2)}.`,
    `Interpretation: ${verdict}. This is a retrospective deployment-shape diagnostic, not a live model promotion.`,
  ].join("\n");
}

export function addOnePerMatchBacktestSheet(workbook: ExcelJS.Workbook, result: OnePerMatchBacktestResult): number {
  const existing = workbook.getWorksheet("OnePerMatchBacktest");
  if (existing) workbook.removeWorksheet(existing.id);
  const ws = workbook.addWorksheet("OnePerMatchBacktest");
  let row = 1;
  const title = ws.getRow(row++);
  title.getCell(1).value = "One-Per-Match Backtest";
  title.font = { name: "Arial", bold: true, size: 15, color: { argb: "FFFFFFFF" } };
  title.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } }; });
  row++;
  const writeSection = (name: string, headers: string[], rows: Record<string, unknown>[]) => {
    ws.getRow(row++).getCell(1).value = name;
    ws.getRow(row - 1).font = { name: "Arial", bold: true };
    const headerRow = ws.getRow(row++);
    headers.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
    headerRow.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF5B677A" } }; });
    rows.forEach((data) => {
      const r = ws.getRow(row++);
      headers.forEach((h, i) => { r.getCell(i + 1).value = data[h] as ExcelJS.CellValue; });
    });
    row++;
  };
  const base = result.comparisonRows[0];
  const one = result.comparisonRows[1];
  writeSection("Executive comparison", COMPARISON_HEADERS, result.comparisonRows as unknown as Record<string, unknown>[]);
  writeSection("Summary metrics", ["metric", "value"], [
    { metric: "raw rows", value: result.rawRows },
    { metric: "unique events", value: result.uniqueEventGroups },
    { metric: "selected bets", value: result.selectedRows },
    { metric: "reduction ratio", value: result.resolvedRows ? `${((1 - result.selectedRows / result.resolvedRows) * 100).toFixed(2)}%` : "N/A" },
    { metric: "ROI delta", value: `${(one.roi - base.roi).toFixed(2)} pp` },
    { metric: "PnL delta", value: (one.pnl - base.pnl).toFixed(2) },
    { metric: "winrate delta", value: `${(one.winrate - base.winrate).toFixed(2)} pp` },
    { metric: "maxDD delta", value: (one.max_drawdown - base.max_drawdown).toFixed(2) },
  ]);
  writeSection("Recent windows", COMPARISON_HEADERS, result.windowRows as unknown as Record<string, unknown>[]);
  writeSection("Selected event rows", [
    "event_group_key", "event_slug", "event_title", "market_slug", "side", "strategy", "tier", "score",
    "coverage", "entry_price", "max_entry_price", "stake_usd", "outcome_status", "pnl", "selection_reason",
    "rejected_same_event_count",
  ], result.selectedPicks.slice(0, 300).map((r) => ({
    event_group_key: r.event_group_key,
    event_slug: r.event_slug,
    event_title: r.event_title,
    market_slug: r.market_slug,
    side: r.side || r.selected_outcome,
    strategy: r.strategy,
    tier: r.tier,
    score: r.score,
    coverage: r.coverage,
    entry_price: r.entry_price,
    max_entry_price: r.max_entry_price,
    stake_usd: r.stake_usd,
    outcome_status: r.outcome_status,
    pnl: r.pnl,
    selection_reason: r.selection_reason,
    rejected_same_event_count: r.rejected_same_event_count,
  })));
  writeSection("Diagnostics", ["field", "value"], [
    { field: "group key coverage", value: JSON.stringify(result.groupKeyCoverage) },
    { field: "unresolved rows", value: result.unresolvedRows },
    { field: "top duplicate groups", value: JSON.stringify(result.topDuplicateGroups) },
    { field: "db status", value: JSON.stringify(result.dbStatus) },
    { field: "notes", value: result.notes.join("; ") },
  ]);
  ws.views = [{ state: "frozen", ySplit: 3 }];
  for (let i = 1; i <= 16; i++) {
    ws.getColumn(i).width = i === 1 ? 34 : 18;
    ws.getColumn(i).alignment = { vertical: "top", wrapText: true };
  }
  return row - 1;
}
