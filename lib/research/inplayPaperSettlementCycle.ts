// Autonomous, bounded, durable A/B/C paper settlement cycle. DBClone-only.
// Derives the UTC research days to (re)settle, materialises the existing daily report (lib/research/inplayPaperSettlement)
// and UPSERTS one bounded summary row per (UTC day, report version) into research_inplay_paper_settlement_reports.
// Never mutates a frozen decision, never reads production, never places an order. Failure of this cycle is isolated by
// the caller (separate `;` step after sync + decision cycle) and is always reported loudly, never as silent success.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GammaMarket } from "../feed/resolveSignalOutcome";
import { buildPaperSnapshot } from "./paperScorecardSnapshot";
import {
  buildDailyReport, collectInputs, readDecisionRows, utcDayWindow, type DecisionRow, type SellPathResult, SELL_MULTIPLES,
} from "./inplayPaperSettlement";

export const REPORT_TABLE = "research_inplay_paper_settlement_reports";
export const REPORT_VERSION = "INPLAY_PAPER_DAILY_ECONOMICS_V1";
export const SOURCE_PROVENANCE = "DBClone nppznoujvnyjargjkmnv: research_inplay_paper_decisions + research_inplay_core_path_observations; provider settlement via canonical resolver by condition id and exact token";
/** Completed UTC days looked back for reports that are missing or still OPEN. */
export const LOOKBACK_DAYS = 14;
/** Completed days that are reconciled even when no report exists yet (most recent first). */
export const RECONCILE_DAYS = 3;
export const MAX_DAYS_PER_RUN = 3;
/** A non-FAILED, not fully resolved report is refreshed at most this often (yesterday included). */
export const MIN_REVISIT_MS = 3 * 3_600_000;
/** The in-progress UTC day is re-checked on every hourly run (cron is 0 * * * *); this only guards against a double fire. */
export const SAME_DAY_MIN_REVISIT_MS = 45 * 60_000;
export const MAX_GAMMA_REQUESTS_PER_RUN = 400;
export const MAX_RUN_MS = 10 * 60_000;
export const MAX_HIT_ROWS = 100;
const DAY_MS = 86_400_000;

export type ReportStatus = "INCOMPLETE" | "PARTIALLY_SETTLED" | "FULLY_RESOLVED" | "FAILED";
export type ExistingReport = { utc_day: string; status: ReportStatus; settled_n: number; attempts_n: number; generated_at: string | null; first_generated_at: string | null; last_attempt_at: string | null; scorecard?: unknown };

export const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => utcDayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
const clip = (s: string, n = 900) => (s.length > n ? s.slice(0, n) : s);
const errMsg = (e: unknown) => clip(e instanceof Error ? e.message : "UNKNOWN");

/** Pure. INCOMPLETE while any decision is WAITING or nothing is settled yet; FULLY_RESOLVED only with no WAITING and no OPEN BET. */
export function classifyReportStatus(c: { waiting_n: number; bet_n: number; settled_n: number; open_n: number }): Exclude<ReportStatus, "FAILED"> {
  if (c.waiting_n > 0) return "INCOMPLETE";
  if (c.open_n === 0) return "FULLY_RESOLVED";
  return c.settled_n > 0 ? "PARTIALLY_SETTLED" : "INCOMPLETE";
}

/**
 * Pure. Which UTC days to settle in this run. Priority: (1) the most recently completed day, (2) previously
 * reported days that are not FULLY_RESOLVED (longest since last attempt first), (3) the bounded recent reconciliation
 * window of days that have no report yet; at most `maxDays` of those. The in-progress UTC day is additionally checked
 * first (same-day outcomes, Box B authority, eligible from start + 6h). A FULLY_RESOLVED report only counts as final when it
 * was generated after its day ended, so decisions admitted later in the same day are never missed.
 */
export function selectTargetDays(input: { nowMs: number; existing: readonly ExistingReport[]; lookbackDays?: number; reconcileDays?: number; maxDays?: number; minRevisitMs?: number }): string[] {
  const { nowMs, existing } = input;
  const lookback = input.lookbackDays ?? LOOKBACK_DAYS, reconcile = input.reconcileDays ?? RECONCILE_DAYS, maxDays = input.maxDays ?? MAX_DAYS_PER_RUN, minRevisit = input.minRevisitMs ?? MIN_REVISIT_MS;
  const today = utcDayOf(nowMs), yesterday = addDays(today, -1);
  const byDay = new Map(existing.map((r) => [r.utc_day, r]));
  const due = (d: string) => {
    const r = byDay.get(d);
    if (!r) return true;
    const generated = r.generated_at ? Date.parse(r.generated_at) : NaN;
    if (r.scorecard === null) return true; // Enrich existing JSON on the same bounded cadence; no new job/backfill.
    if (r.status === "FULLY_RESOLVED" && Number.isFinite(generated) && generated >= Date.parse(`${addDays(d, 1)}T00:00:00Z`)) return false;
    if (r.status === "FAILED") return true; // retried on every scheduled run
    const last = r.last_attempt_at ? Date.parse(r.last_attempt_at) : NaN;
    return !Number.isFinite(last) || nowMs - last >= (d === today ? SAME_DAY_MIN_REVISIT_MS : minRevisit);
  };
  const picked: string[] = [];
  if (due(yesterday)) picked.push(yesterday);
  const reopen = existing
    .filter((r) => r.utc_day < yesterday && r.utc_day >= addDays(yesterday, -(lookback - 1)) && due(r.utc_day))
    .sort((a, b) => (Date.parse(a.last_attempt_at ?? "") || 0) - (Date.parse(b.last_attempt_at ?? "") || 0) || (a.utc_day < b.utc_day ? 1 : -1))
    .map((r) => r.utc_day);
  picked.push(...reopen);
  for (let i = 1; i < reconcile; i++) { const d = addDays(yesterday, -i); if (!byDay.has(d)) picked.push(d); }
  const completed = [...new Set(picked)].slice(0, maxDays);
  return due(today) ? [today, ...completed] : completed;
}

type DailyReport = ReturnType<typeof buildDailyReport>;

/** Bounded executable-exit hits (descriptive x2/x3/x5 opportunities, never realized profit). */
function executableHits(sell: readonly SellPathResult[]) {
  const out: { decision_id: string; multiple: string; first_hit_at: string | null; time_to_hit_s: number | null }[] = [];
  for (const s of sell) for (const n of SELL_MULTIPLES) {
    const m = s.multiples[`x${n}`];
    if (m.status === "HIT") out.push({ decision_id: s.decision_id, multiple: `x${n}`, first_hit_at: m.first_hit_at, time_to_hit_s: m.time_to_hit_s });
  }
  return out.slice(0, MAX_HIT_ROWS);
}

/** Dominant OPEN reason (`edge:reason`) or null when nothing is OPEN. */
function dominantOpenReason(reasons: Record<string, number>): string | null {
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return top ? clip(top[0], 200) : null;
}

/** Delayed-paper outcomes are historical diagnostics: no prospective profitability claim without settled LIVE_PROSPECTIVE decisions. */
export function prospectiveClaim(byProvenance: Record<string, { settled_n: number }>) {
  const live = byProvenance["LIVE_PROSPECTIVE"]?.settled_n ?? 0;
  return {
    live_prospective_settled_n: live, delayed_paper_settled_n: byProvenance["DELAYED_PAPER"]?.settled_n ?? 0,
    claim: live > 0 ? "LIVE_PROSPECTIVE_SETTLED_PRESENT_SEE_SETTLEMENT_BY_PROVENANCE" : "NO_PROSPECTIVE_PROFITABILITY_CLAIM_DELAYED_OR_UNPROVEN_ONLY",
  };
}

export type ProviderStats = { calls: number; non_null: number; budget_exhausted: boolean };

/** Pure. Bounded row for one UTC day: no per-position rows, no credentials. */
export function buildReportRow(day: string, d: { decisions: readonly DecisionRow[]; report: DailyReport; provider: ProviderStats }, prev: ExistingReport | null, nowIso: string) {
  const w = utcDayWindow(day)!;
  const r = d.report, s = r.settlement;
  const waiting = d.decisions.filter((x) => x.status === "WAITING").length;
  const skip = d.decisions.filter((x) => x.status === "SKIP").length;
  const status = classifyReportStatus({ waiting_n: waiting, bet_n: s.positions_n, settled_n: s.settled_n, open_n: s.open_n });
  return {
    utc_day: day, report_version: REPORT_VERSION, status, generated_at: nowIso, first_generated_at: prev?.first_generated_at ?? nowIso,
    source_provenance: SOURCE_PROVENANCE, window_from: w.from, window_to: w.to,
    decisions_n: new Set(d.decisions.map((x) => x.decision_id)).size, bet_n: s.positions_n, skip_n: skip, waiting_n: waiting,
    distinct_games_n: new Set(d.decisions.map((x) => x.physical_event_id)).size, independent_bet_games_n: r.independence.unique_physical_games,
    settled_n: s.settled_n, open_n: s.open_n, win_n: s.win_n, loss_n: s.loss_n, void_n: s.void_n,
    settled_gross_pnl_u: s.gross_pnl_u, settled_roi: s.settled_roi, net_pnl_status: s.net_pnl_status,
    executable_x2_n: r.executable_exits.executable_x2_n, executable_x3_n: r.executable_exits.executable_x3_n, executable_x5_n: r.executable_exits.executable_x5_n,
    summary: {
      paper_scorecard: buildPaperSnapshot(d.decisions, r.positions, w.from, w.to, nowIso),
      report: r.report, strategies: r.strategies, settlement: s, settlement_by_strategy: r.settlement_by_strategy, settlement_by_provenance: r.settlement_by_provenance,
      independence: r.independence, executable_exits: r.executable_exits, executable_hits: executableHits(r.sell_paths),
      missing_outcome_reasons: r.missing_outcome_reasons, provider: d.provider, disclaimer: r.disclaimer,
      outcome_authority: r.outcome_authority, prospective_claim: prospectiveClaim(r.settlement_by_provenance), pending_n: s.open_n,
    },
    missing_authority: { ...r.missing_evidence, net_pnl_status: s.net_pnl_status, exit_fee_authority: "UNKNOWN_PROCEEDS_GROSS_OF_EXIT_FEE" },
    attempts_n: (prev?.attempts_n ?? 0) + 1, last_attempt_at: nowIso, last_attempt_status: "SUCCESS" as const, last_error: null as string | null,
    first_broken_edge: dominantOpenReason(r.missing_outcome_reasons),
  };
}

const EXISTING_COLUMNS = "utc_day,status,settled_n,attempts_n,generated_at,first_generated_at,last_attempt_at,scorecard:summary->paper_scorecard->version";
const isMissingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /could not find the table|does not exist/i.test(e.message ?? ""));

export async function readExistingReports(db: SupabaseClient, fromDay: string): Promise<ExistingReport[]> {
  const q = await db.from(REPORT_TABLE).select(EXISTING_COLUMNS).eq("report_version", REPORT_VERSION).gte("utc_day", fromDay).order("utc_day", { ascending: false }).limit(LOOKBACK_DAYS + 7);
  if (q.error) throw new Error(isMissingTable(q.error) ? "SETTLEMENT_REPORT_TABLE_MISSING:apply ops/research-clone/inplay-paper-settlement-reports-schema.sql to DBClone" : `SETTLEMENT_REPORT_READ:${q.error.message}`);
  return ((q.data ?? []) as unknown as ExistingReport[]).map((r) => ({ ...r, settled_n: Number(r.settled_n), attempts_n: Number(r.attempts_n) }));
}

export type DayResult = { day: string; outcome: "WRITTEN" | "NO_DECISIONS" | "REGRESSION_REFUSED" | "FAILED" | "DEFERRED_RUNTIME_BUDGET"; status?: ReportStatus; error?: string; bet_n?: number; settled_n?: number; open_n?: number };
export type CycleResult = { ok: boolean; first_broken_edge: string | null; days: DayResult[]; gamma_requests: number; budget_exhausted: boolean };

/** Failed day: keep any prior successful report untouched (attempt columns only); otherwise record a FAILED row with bounded diagnostics. */
async function recordFailure(db: SupabaseClient, day: string, prev: ExistingReport | null, nowIso: string, error: string, status: "FAILED" | "REGRESSION_REFUSED", edge: string | null) {
  const attempt = { attempts_n: (prev?.attempts_n ?? 0) + 1, last_attempt_at: nowIso, last_attempt_status: status, last_error: clip(error), first_broken_edge: edge };
  if (prev) {
    const u = await db.from(REPORT_TABLE).update(attempt).eq("utc_day", day).eq("report_version", REPORT_VERSION);
    if (u.error) throw new Error(`SETTLEMENT_REPORT_WRITE:${u.error.message}`);
    return;
  }
  const w = utcDayWindow(day)!;
  const i = await db.from(REPORT_TABLE).upsert({ utc_day: day, report_version: REPORT_VERSION, status: "FAILED", source_provenance: SOURCE_PROVENANCE, window_from: w.from, window_to: w.to, ...attempt }, { onConflict: "utc_day,report_version" });
  if (i.error) throw new Error(`SETTLEMENT_REPORT_WRITE:${i.error.message}`);
}

export async function runSettlementCycle(db: SupabaseClient, fetchMarket: (conditionId: string) => Promise<GammaMarket | null>, opts: { nowMs?: number; maxRunMs?: number; maxGammaRequests?: number } = {}): Promise<CycleResult> {
  const nowMs = opts.nowMs ?? Date.now(), deadline = Date.now() + (opts.maxRunMs ?? MAX_RUN_MS), gammaCap = opts.maxGammaRequests ?? MAX_GAMMA_REQUESTS_PER_RUN;
  const existing = await readExistingReports(db, addDays(utcDayOf(nowMs), -LOOKBACK_DAYS));
  const targets = selectTargetDays({ nowMs, existing });
  const days: DayResult[] = [];
  let totalCalls = 0, exhausted = false;
  for (const day of targets) {
    if (Date.now() >= deadline) { days.push({ day, outcome: "DEFERRED_RUNTIME_BUDGET" }); continue; }
    const prev = existing.find((r) => r.utc_day === day) ?? null;
    const nowIso = new Date(nowMs).toISOString();
    const stats: ProviderStats = { calls: 0, non_null: 0, budget_exhausted: false };
    const budgeted = async (id: string) => {
      if (totalCalls >= gammaCap) { stats.budget_exhausted = exhausted = true; return null; }
      totalCalls++; stats.calls++;
      const m = await fetchMarket(id);
      if (m) stats.non_null++;
      return m;
    };
    try {
      const window = utcDayWindow(day);
      const decisions = await readDecisionRows(db, window);
      if (!decisions.length) { days.push({ day, outcome: "NO_DECISIONS" }); continue; }
      const inputs = await collectInputs(db, budgeted, 4, window, { boxB: true, sameDayNowMs: day === utcDayOf(nowMs) ? nowMs : undefined });
      const report = buildDailyReport({ window, decisions, ...inputs });
      // Provider fully unavailable: every lookup came back empty. Not a settlement result, a failure to retry.
      if (stats.calls > 0 && stats.non_null === 0) {
        await recordFailure(db, day, prev, nowIso, "PROVIDER_ALL_LOOKUPS_EMPTY", "FAILED", "GAME_TO_MARKET:LOOKUP_FAILED");
        days.push({ day, outcome: "FAILED", error: "PROVIDER_ALL_LOOKUPS_EMPTY", status: prev?.status }); continue;
      }
      const row = buildReportRow(day, { decisions, report, provider: stats }, prev, nowIso);
      // Settled outcomes are authoritative and never regress to OPEN because a later provider read was partial.
      if (prev && row.settled_n < prev.settled_n) {
        const why = `SETTLED_REGRESSION_REFUSED:prev=${prev.settled_n},new=${row.settled_n}${stats.budget_exhausted ? ",gamma_budget_exhausted" : ""}`;
        await recordFailure(db, day, prev, nowIso, why, "REGRESSION_REFUSED", row.first_broken_edge);
        days.push({ day, outcome: "REGRESSION_REFUSED", error: why, status: prev.status }); continue;
      }
      const up = await db.from(REPORT_TABLE).upsert(row, { onConflict: "utc_day,report_version" });
      if (up.error) throw new Error(`SETTLEMENT_REPORT_WRITE:${up.error.message}`);
      days.push({ day, outcome: "WRITTEN", status: row.status, bet_n: row.bet_n, settled_n: row.settled_n, open_n: row.open_n });
    } catch (e) {
      const msg = errMsg(e);
      try { await recordFailure(db, day, prev, nowIso, msg, "FAILED", msg.split(":")[0]); } catch { /* diagnostics are best-effort; the failure is still returned */ }
      days.push({ day, outcome: "FAILED", error: msg });
    }
  }
  const failed = days.filter((d) => d.outcome === "FAILED" || d.outcome === "REGRESSION_REFUSED");
  return { ok: failed.length === 0, first_broken_edge: failed[0]?.error?.split(":")[0] ?? null, days, gamma_requests: totalCalls, budget_exhausted: exhausted };
}
