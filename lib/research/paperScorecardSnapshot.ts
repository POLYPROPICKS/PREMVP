// Sufficient statistics inside the EXISTING daily settlement report, never a second outcome engine.
import { createHash } from "node:crypto";
import type { DecisionRow, PositionSettlement } from "./inplayPaperSettlement";
import { buildPerformanceScorecard, type Cell, type EventCount, type ScorecardInput } from "./inplayPerformanceScorecard";

export const PAPER_SCORECARD_VERSION = "PAPER_SCORECARD_V1";
type SnapshotCell = Cell & { events: string[]; bet_events: string[]; condition_key?: string };
export type PaperSnapshot = {
  version: typeof PAPER_SCORECARD_VERSION; generated_at: string; from: string; to: string;
  first_admission: string; last_admission: string; last_created_at: string; cells: SnapshotCell[];
};
const eventKey = (id: string) => createHash("sha256").update(id).digest("hex");

export function buildPaperSnapshot(decisions: readonly DecisionRow[], positions: readonly PositionSettlement[], from: string, to: string, generatedAt: string): PaperSnapshot {
  const settled = new Map(positions.map(p => [p.decision_id, p]));
  if (settled.size !== positions.length || decisions.filter(d=>d.status==="BET").length!==settled.size) throw Error("SCORECARD_COHORT_MISMATCH");
  const groups = new Map<string, SnapshotCell>();
  for (const d of decisions) {
    if (!d.admission_observed_at || Date.parse(d.admission_observed_at) < Date.parse(from) || Date.parse(d.admission_observed_at) >= Date.parse(to)) throw Error("SCORECARD_COHORT_MISMATCH");
    const p = settled.get(d.decision_id);
    if (d.status === "BET" && !p) throw Error("SCORECARD_OUTCOME_MISSING");
    const cell: Cell = {
      strategy_id: d.strategy_id, strategy_version: d.strategy_version ?? "v1", status: d.status,
      sport: d.provider_sport_family ?? "UNKNOWN", market_family: d.market_family ?? null,
      // Current control admission requires canonical_market_type=MONEYLINE. No inference for skipped rows.
      market_type: d.status === "BET" && d.market_family === "MONEYLINE" ? "MONEYLINE" : "UNKNOWN",
      market_scope: d.market_scope ?? null, day: d.admission_observed_at.slice(0, 10),
      condition_id: null, token_id: null, entry_vwap: null, provenance_class: d.provenance_class,
      db_clock: !!d.frozen_db_at, event_start_iso: null, condition_events: 1, box: null, n: 0,
      settlement: p ? { outcome: p.outcome, reason: p.reason, gross_pnl_u: p.gross_pnl_u } : undefined,
    };
    const condition_key = p?.condition_id ? eventKey(p.condition_id.toLowerCase()) : undefined;
    const key = JSON.stringify([cell,condition_key]);
    const group = groups.get(key) ?? { ...cell, condition_key, events: [], bet_events: [] };
    const event = eventKey(d.physical_event_id);
    group.n++;
    if (!group.events.includes(event)) group.events.push(event);
    if (d.status === "BET" && !group.bet_events.includes(event)) group.bet_events.push(event);
    groups.set(key, group);
  }
  const admissions = decisions.map(d => d.admission_observed_at!).sort();
  return { version: PAPER_SCORECARD_VERSION, generated_at: generatedAt, from, to,
    first_admission: admissions[0], last_admission: admissions.at(-1)!,
    last_created_at: decisions.map(d => d.created_at ?? d.admission_observed_at!).sort().at(-1)!, cells: [...groups.values()] };
}

export function mergePaperSnapshots(snapshots: readonly PaperSnapshot[], from: string, to: string, readAt: string) {
  if (!snapshots.length || snapshots.length > 366) throw Error("REPORT_REFRESH_REQUIRED");
  for (const s of snapshots) {
    if (s.version !== PAPER_SCORECARD_VERSION || !Array.isArray(s.cells) || s.generated_at > readAt || s.from < from || s.to > to) throw Error("REPORT_REFRESH_REQUIRED");
    if (s.cells.length > 20_000) throw Error("REPORT_BUDGET_EXCEEDED");
  }
  const cells = snapshots.flatMap(s => s.cells).map(c=>({...c}));
  // Match Scorecard V2's full-cohort condition-to-game guard, even across UTC report days.
  const conditionEvents = new Map<string,Set<string>>();
  for (const c of cells) if (c.condition_key) {
    const events = conditionEvents.get(c.condition_key)??new Set<string>();
    for (const event of c.bet_events) events.add(event);
    conditionEvents.set(c.condition_key,events);
  }
  for (const c of cells) if (c.condition_key && conditionEvents.get(c.condition_key)!.size>1) {
    c.settlement={outcome:"OPEN",reason:"CONDITION_ATTRIBUTED_TO_MULTIPLE_PHYSICAL_EVENTS",gross_pnl_u:null};
  }
  if (cells.reduce((n,c) => n + c.n, 0) > 100_000) throw Error("REPORT_BUDGET_EXCEEDED");
  const events = new Set(cells.flatMap(c => c.events)), bets = new Set(cells.flatMap(c => c.bet_events));
  const event_counts: EventCount[] = [];
  for (const [gs, gm] of [[1,1],[0,1],[1,0],[0,0]]) {
    const groups = new Map<string, SnapshotCell[]>();
    for (const c of cells) {
      const k = JSON.stringify([c.strategy_id,c.strategy_version,gs ? null:c.sport,...(gm ? []:[c.market_family,c.market_scope,c.market_type])]);
      const group = groups.get(k) ?? []; group.push(c); groups.set(k, group);
    }
    for (const group of groups.values()) event_counts.push({ ...group[0], gs, gm,
      events: new Set(group.flatMap(c => c.events)).size, bet_events: new Set(group.flatMap(c => c.bet_events)).size });
  }
  const input: ScorecardInput = { scope: "RESEARCH_PAPER", from, to, read_at: readAt,
    first_admission: snapshots.map(s=>s.first_admission).sort()[0], last_admission: snapshots.map(s=>s.last_admission).sort().at(-1)!,
    last_created_at: snapshots.map(s=>s.last_created_at).sort().at(-1)!,
    independent_events: events.size, independent_bet_events: bets.size, cells, event_counts };
  const report = buildPerformanceScorecard(input);
  if (report.strategy_totals.some(r => !r.strategy_id.startsWith("CONTROL_") && r.bet > 0)) throw Error("ALPHA_EMISSION_FORBIDDEN");
  // Explicit public response allowlist: no member hashes, decision identities, project IDs or source summaries.
  return { report: report.report, reconciliation: report.reconciliation,
    period_from: from, period_to: to, read_at: readAt, last_admission: input.last_admission,
    last_created_at: input.last_created_at, independent_events: events.size, independent_bet_events: bets.size,
    strategy_totals: report.strategy_totals, strategy_sport: report.strategy_sport,
    strategy_market: report.strategy_market, strategy_sport_market: report.strategy_sport_market,
    source_refreshes: snapshots.map(s => ({ day: s.from.slice(0,10), refreshed_at: s.generated_at })),
    cacheStatus: "bypassed" as const };
}
