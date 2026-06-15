// Shared data access for FireModel1 modeling scripts.
// Read-only. No writes. No live executor.

import { supabaseAdmin } from "@/lib/supabase/server";

export const ALLOWED_VERSIONS = ["v2-lite-growth-safe", "shadow-firemodel1_1_research_v0"] as const;
export const OLD_SHADOW = "shadow-strategic-sports-v1";

export type ModelRow = {
  id: string;
  created_at: string;
  condition_id: string | null;
  selected_token_id: string | null;
  selected_outcome: string | null;
  event_slug: string | null;
  market_slug: string | null;
  entry_price_num: number | null;
  signal_confidence_num: number | null;
  smart_money_score_num: number | null;
  metric_formula_version: string | null;
  formula_version: string | null;
  signal_result: string | null;
  realized_return_pct: number | null;
  expires_at: string;
  diagnostics: {
    dataCoverage?: number;
    gameStartIso?: string | null;
    fireModelAlias?: string;
    isResearchCandidate?: boolean;
    [k: string]: unknown;
  };
};

export async function fetchModelRows(
  sinceIso: string,
  limit = 2000,
): Promise<ModelRow[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, created_at, condition_id, selected_token_id, selected_outcome, " +
        "event_slug, market_slug, entry_price_num, signal_confidence_num, " +
        "smart_money_score_num, metric_formula_version, formula_version, " +
        "signal_result, realized_return_pct, expires_at, diagnostics",
    )
    .in("metric_formula_version", [...ALLOWED_VERSIONS, OLD_SHADOW])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`DB error: ${error.message}`);
  return (data ?? []) as unknown as ModelRow[];
}

export async function fetchAllResolvedRows(): Promise<ModelRow[]> {
  const { data, error } = await supabaseAdmin
    .from("generated_signal_pairs")
    .select(
      "id, created_at, condition_id, selected_token_id, selected_outcome, " +
        "event_slug, market_slug, entry_price_num, signal_confidence_num, " +
        "smart_money_score_num, metric_formula_version, formula_version, " +
        "signal_result, realized_return_pct, expires_at, diagnostics",
    )
    .in("metric_formula_version", [...ALLOWED_VERSIONS])
    .not("signal_result", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`DB error: ${error.message}`);
  return (data ?? []) as unknown as ModelRow[];
}

// ── classification helpers ──────────────────────────────────
export const NBA_NHL_RE = /\bnba\b|basketball|\bnhl\b|ice[\s-]?hockey/i;
export const ESPORTS_RE = /esport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i;
export const WC_RE = /world[\s-]?cup|wc2026|fifa|cabo|belgium|egypt|spain/i;
export const SPREAD_RE = /spread|handicap|\-\d+\.5|\+\d+\.5/i;
export const TOTALS_RE = /over|under|total|o\/u/i;
export const BTTS_RE = /both teams? to score|btts/i;

export function mref(r: ModelRow): string {
  return ((r.market_slug ?? "") + " " + (r.event_slug ?? "")).toLowerCase();
}

export function isNbaOrNhl(r: ModelRow): boolean { return NBA_NHL_RE.test(mref(r)); }
export function isEsports(r: ModelRow): boolean { return ESPORTS_RE.test(mref(r)); }
export function isWC(r: ModelRow): boolean { return WC_RE.test(mref(r)); }
export function isSpread(r: ModelRow): boolean { return SPREAD_RE.test(mref(r)); }
export function isTotals(r: ModelRow): boolean { return TOTALS_RE.test(mref(r)); }
export function isBTTS(r: ModelRow): boolean { return BTTS_RE.test(mref(r)); }

export function isBadBucket(r: ModelRow): boolean {
  const cov = r.diagnostics?.dataCoverage;
  const ep = r.entry_price_num;
  return cov != null && ep != null && cov >= 50 && cov <= 74 && ep >= 0.44 && ep <= 0.58;
}

export function isAllowed(r: ModelRow): boolean {
  return ALLOWED_VERSIONS.includes(r.metric_formula_version as typeof ALLOWED_VERSIONS[number]);
}

export function getScore(r: ModelRow): number { return r.signal_confidence_num ?? 0; }
export function getCov(r: ModelRow): number { return r.diagnostics?.dataCoverage ?? 0; }
export function getEp(r: ModelRow): number | null { return r.entry_price_num; }
export function getSm(r: ModelRow): number | null { return r.smart_money_score_num; }

export function getTier(r: ModelRow): "T1" | "T2" | "T3" | "BELOW" {
  const sc = getScore(r); const cov = getCov(r);
  if (sc >= 72 && cov >= 50) return "T1";
  if (sc >= 60 && cov >= 50) return "T2";
  if (sc >= 50 && cov >= 25) return "T3";
  return "BELOW";
}

export function getStake_primary(r: ModelRow): number {
  const sc = getScore(r); const cov = getCov(r); const sm = getSm(r);
  const esports = isEsports(r);
  let base = 0;
  if (sc >= 72 && cov >= 75) base = 10;
  else if (sc >= 72 && cov >= 50) base = 7;
  else if (sc >= 60 && cov >= 50) base = 7;
  else if (sc >= 50 && cov >= 25) base = 3;
  let stake = sm != null && sm >= 75 ? Math.floor(base / 2) : base;
  if (esports) stake = Math.min(stake, 5);
  return Math.min(stake, 10);
}

export function priceBucket(ep: number | null): string {
  if (ep == null) return "unknown";
  if (ep < 0.25) return "<0.25";
  if (ep < 0.44) return "0.25-0.44";
  if (ep <= 0.58) return "0.44-0.58";
  if (ep <= 0.75) return "0.58-0.75";
  return ">0.75";
}

export function covBucket(cov: number): string {
  if (cov < 25) return "<25";
  if (cov < 50) return "25-49";
  if (cov < 75) return "50-74";
  return ">=75";
}

export function smBucket(sm: number | null): string {
  if (sm == null) return "unknown";
  if (sm < 50) return "sm<50";
  if (sm < 75) return "sm50-74";
  return "sm>=75";
}

export function hoursToStart(r: ModelRow): number | null {
  const g = r.diagnostics?.gameStartIso;
  if (!g || g === "null") return null;
  return (new Date(g).getTime() - Date.now()) / 3_600_000;
}

export function timingBucket(r: ModelRow): string {
  const h = hoursToStart(r);
  if (h == null) return "unknown";
  if (h < 0) return "live/started";
  if (h <= 1) return "0-1h";
  if (h <= 2) return "1-2h";
  if (h <= 3) return "2-3h";
  if (h <= 6) return "3-6h";
  if (h <= 24) return "6-24h";
  return ">24h";
}

export function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── cohort stats ────────────────────────────────────────────
export interface CohortResult {
  n: number;
  resolved: number;
  unresolved: number;
  wins: number;
  losses: number;
  roiPct: number | null;
  grossPnl: number | null;
  missingFields: string[];
  avgEntry: number | null;
  avgCov: number | null;
  avgScore: number | null;
  totalStake: number;
  winRate: number | null;
}

export function cohortStats(rows: ModelRow[], stakeFunc = getStake_primary): CohortResult {
  const resolved = rows.filter((r) => r.signal_result != null);
  const unresolved = rows.filter((r) => r.signal_result == null);
  const missing: string[] = [];
  const hasPnl = resolved.length > 0 && resolved.every((r) => r.realized_return_pct != null);
  if (resolved.length > 0 && !hasPnl) missing.push("realized_return_pct");

  const wins = resolved.filter((r) => r.signal_result === "WIN").length;
  const losses = resolved.filter((r) => r.signal_result === "LOSS").length;
  const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 1000) / 10 : null;

  let roiPct: number | null = null;
  let grossPnl: number | null = null;
  if (hasPnl && resolved.length > 0) {
    const sumReturn = resolved.reduce((s, r) => s + (r.realized_return_pct ?? 0), 0);
    roiPct = Math.round((sumReturn / resolved.length) * 10) / 10;
    // gross PnL estimate: realized_return_pct treated as % of stake
    const stakeSum = resolved.reduce((s, r) => s + stakeFunc(r), 0);
    grossPnl = Math.round((stakeSum * (sumReturn / resolved.length)) / 100 * 100) / 100;
  }

  const eps = rows.map((r) => r.entry_price_num).filter((v): v is number => v != null);
  const covs = rows.map((r) => r.diagnostics?.dataCoverage).filter((v): v is number => v != null);
  const scores = rows.map((r) => r.signal_confidence_num).filter((v): v is number => v != null);
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length * 100) / 100 : null;

  return {
    n: rows.length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    wins,
    losses,
    roiPct,
    grossPnl,
    missingFields: missing,
    avgEntry: avg(eps),
    avgCov: avg(covs),
    avgScore: avg(scores),
    totalStake: rows.reduce((s, r) => s + stakeFunc(r), 0),
    winRate,
  };
}

export function printCohort(label: string, c: CohortResult) {
  const roi = c.roiPct != null
    ? `ROI=${c.roiPct > 0 ? "+" : ""}${c.roiPct}%`
    : `ROI_N/A(${c.missingFields.join(",")})`;
  const pnl = c.grossPnl != null ? ` PnL=${c.grossPnl > 0 ? "+" : ""}$${c.grossPnl}` : "";
  const wr = c.winRate != null ? ` WR=${c.winRate}%` : "";
  const warn = c.resolved < 10 ? " ⚠N<10" : "";
  console.log(
    `  ${label.padEnd(30)} n=${String(c.n).padStart(4)} res=${c.resolved} W=${c.wins} L=${c.losses}${wr} ${roi}${pnl}${warn}`,
  );
}

export const LINE = "─".repeat(72);
