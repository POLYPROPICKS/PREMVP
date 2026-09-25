/**
 * BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1 — ONE REPLAY RUNNER.
 *
 * IMMUTABLE RESEARCH EVIDENCE → MODEL-READY VIEW → POLICY REGISTRY → (this) →
 * STANDARD RESULT TABLES. Deterministic, offline, no production dependency.
 *
 * Economic invariant (reused from the frozen research engine):
 *   • one physical economic event → at most one simulated bet
 *     (the chronologically-first predicate-passing identity for that event);
 *   • flat 1u stake; WIN pnl_u = 1/entry - 1; LOSS pnl_u = -1 (settleBetU);
 *   • chronological max drawdown (maxDrawdownU);
 *   • UNRESOLVED bets are counted but NEVER enter WINS/LOSSES/PnL/ROI/DD.
 * All economics are GROSS_BEFORE_FEES.
 */
import { createHash } from "node:crypto";
import { settleBetU, maxDrawdownU, type SelectedBet } from "../research-engine";
import { loadModelReadyView } from "./modelReadyView";
import { resolvePolicies, type RegisteredPolicy } from "./policyRegistry";
import type {
  GroupedResult,
  ModelReadyRow,
  ReplayRun,
  SimulatedBet,
  StandardResult,
} from "./types";

export interface ReplayParams {
  models: string[] | "all";
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  asOf: string; // ISO instant
  groupBy?: "sport" | "market_family" | "none";
  evidenceDir?: string;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Stable chronological order with a total tiebreak (mirrors research-engine metrics.ts). */
function cmp(a: ModelReadyRow, b: ModelReadyRow): number {
  if (a.decision_at !== b.decision_at) return a.decision_at < b.decision_at ? -1 : 1;
  const aStart = a.event_start ?? "";
  const bStart = b.event_start ?? "";
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  if (a.physical_event_id !== b.physical_event_id)
    return a.physical_event_id < b.physical_event_id ? -1 : 1;
  if (a.research_identity !== b.research_identity)
    return a.research_identity < b.research_identity ? -1 : 1;
  return 0;
}

interface PolicySelection {
  bets: SimulatedBet[];
  availableIdentities: ModelReadyRow[];
  passIdentities: ModelReadyRow[];
  rejectReasons: Record<string, number>;
}

function selectBets(policy: RegisteredPolicy, rows: ModelReadyRow[]): PolicySelection {
  const ordered = [...rows].sort(cmp);
  const passIdentities: ModelReadyRow[] = [];
  const claimed = new Set<string>();
  const bets: SimulatedBet[] = [];
  const rejectReasons: Record<string, number> = {};
  for (const row of ordered) {
    const verdict = policy.evaluate(row);
    if (!verdict.pass) {
      rejectReasons[verdict.reason] = (rejectReasons[verdict.reason] ?? 0) + 1;
      continue;
    }
    passIdentities.push(row);
    if (claimed.has(row.physical_event_id)) continue;
    claimed.add(row.physical_event_id);
    const terminal = row.terminal_status;
    const pnl =
      terminal === "OPEN" || row.entry_price == null
        ? null
        : settleBetU(terminal === "WIN" ? "WIN" : "LOSS", row.entry_price);
    bets.push({
      physical_event_id: row.physical_event_id,
      research_identity: row.research_identity,
      decision_at: row.decision_at,
      event_start: row.event_start,
      sport: row.sport,
      market_family: row.market_family,
      entry_price: row.entry_price as number,
      lead_time_hours: row.lead_time_hours,
      signal_score: row.signal_score,
      terminal_status: terminal,
      pnl_u: pnl,
    });
  }
  return { bets, availableIdentities: rows, passIdentities, rejectReasons };
}

function topReasons(dist: Record<string, number>, n = 6): Record<string, number> {
  return Object.fromEntries(
    Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  );
}

function economics(model: string, sel: PolicySelection): StandardResult {
  const terminalBets = sel.bets.filter((b) => b.pnl_u != null) as (SimulatedBet & { pnl_u: number })[];
  // chronological order for DD
  const chrono = [...terminalBets].sort((a, b) =>
    a.decision_at === b.decision_at
      ? a.physical_event_id < b.physical_event_id
        ? -1
        : 1
      : a.decision_at < b.decision_at
        ? -1
        : 1,
  );
  const wins = terminalBets.filter((b) => b.terminal_status === "WIN").length;
  const losses = terminalBets.length - wins;
  const pnl = terminalBets.reduce((s, b) => s + b.pnl_u, 0);
  const asSelected: SelectedBet[] = chrono.map((b) => ({
    physicalEventKey: b.physical_event_id,
    decisionTimestamp: b.decision_at,
    eventStart: b.event_start ?? b.decision_at,
    leadTimeHours: b.lead_time_hours ?? 0,
    entryPrice: b.entry_price,
    sportFamily: b.sport,
    outcome: b.terminal_status === "WIN" ? "WIN" : "LOSS",
    pnlU: b.pnl_u,
  }));
  const dd = maxDrawdownU(asSelected);

  const byDay: Record<string, number> = {};
  for (const b of terminalBets) {
    const d = b.decision_at.slice(0, 10);
    byDay[d] = (byDay[d] ?? 0) + b.pnl_u;
  }
  const dayAbs = Object.values(byDay).map((v) => Math.abs(v));
  const totalAbs = dayAbs.reduce((s, v) => s + v, 0);
  const concentration = totalAbs > 0 ? round(Math.max(...dayAbs) / totalAbs, 4) : null;

  const passEventN = new Set(sel.passIdentities.map((r) => r.physical_event_id)).size;

  return {
    MODEL: model,
    AVAILABLE_PHYSICAL_EVENT_N: new Set(sel.availableIdentities.map((r) => r.physical_event_id)).size,
    AVAILABLE_IDENTITY_N: sel.availableIdentities.length,
    FILTER_PASS_EVENT_N: passEventN,
    FILTER_PASS_IDENTITY_N: sel.passIdentities.length,
    SIMULATED_BET_N: sel.bets.length,
    TERMINAL_BET_N: terminalBets.length,
    UNRESOLVED_BET_N: sel.bets.length - terminalBets.length,
    WINS: wins,
    LOSSES: losses,
    GROSS_PNL_U: round(pnl, 2),
    GROSS_ROI_PCT: terminalBets.length ? round((pnl / terminalBets.length) * 100, 4) : null,
    MAX_DD_U: round(dd, 2),
    WIN_RATE_PCT: terminalBets.length ? round((wins / terminalBets.length) * 100, 2) : null,
    CONCENTRATION: concentration,
    REJECT_REASONS: topReasons(sel.rejectReasons),
  };
}

function groupKey(row: ModelReadyRow, groupBy: "sport" | "market_family"): string {
  if (groupBy === "sport") return row.sport || "unknown";
  return row.market_family ?? "unknown";
}

export function runReplay(params: ReplayParams): ReplayRun {
  const started = Date.now();
  const groupBy = params.groupBy ?? "none";
  const view = loadModelReadyView({
    evidenceDir: params.evidenceDir,
    from: params.from,
    to: params.to,
    asOf: params.asOf,
  });
  const policies = resolvePolicies(params.models);

  const overall: StandardResult[] = [];
  const grouped: Record<string, GroupedResult[]> = {};

  for (const policy of policies) {
    const sel = selectBets(policy, view.rows);
    overall.push(economics(policy.id, sel));

    if (groupBy !== "none") {
      const keys = new Set(view.rows.map((r) => groupKey(r, groupBy)));
      const rowsByKey = new Map<string, ModelReadyRow[]>();
      for (const r of view.rows) {
        const k = groupKey(r, groupBy);
        const arr = rowsByKey.get(k) ?? [];
        arr.push(r);
        rowsByKey.set(k, arr);
      }
      grouped[policy.id] = [...keys]
        .sort()
        .map((k) => {
          const subSel = selectBets(policy, rowsByKey.get(k) ?? []);
          return { GROUP_KEY: k, ...economics(policy.id, subSel) };
        });
    }
  }

  const deterministicPayload = { params: { ...params, groupBy }, overall, grouped };
  const determinismHash = createHash("sha256")
    .update(JSON.stringify(deterministicPayload))
    .digest("hex");

  return {
    mission: "BUILD_REUSABLE_OFFLINE_POLICY_REPLAY_PLANE_V1",
    params: {
      models: policies.map((p) => p.id),
      from: params.from,
      to: params.to,
      as_of: params.asOf,
      group_by: groupBy,
      evidence_dir: view.meta.evidence_dir,
    },
    economics_basis: "GROSS_BEFORE_FEES",
    view_meta: view.meta,
    overall,
    grouped,
    determinism_hash: determinismHash,
    wall_clock_ms: Date.now() - started,
  };
}
