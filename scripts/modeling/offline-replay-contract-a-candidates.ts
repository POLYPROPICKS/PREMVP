/**
 * COMPARE_TWO_FIXED_CONTRACT_A_CORRECTIONS_V1 — offline evaluation of two
 * PREDEFINED Contract A correction candidates against the current baseline,
 * using the existing offline replay plane.
 *
 * NO threshold search · NO production query · NO executable-market expansion.
 * The only parameters used are the ones the candidates specify:
 *   C1: entry_price >= 0.50  +  BAD_BUCKET off
 *   C2: C1  +  admitted market class restricted to allowed_fullmatch_total only
 *
 *   npm run modeling:offline-replay:contract-a-candidates
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { settleBetU, maxDrawdownU, type SelectedBet } from "../../lib/modeling/research-engine";
import { loadModelReadyView } from "../../lib/modeling/offline-replay/modelReadyView";
import { POLICY_REGISTRY } from "../../lib/modeling/offline-replay/policyRegistry";
import {
  contractAFilterVerdict,
  type ContractAAblation,
} from "../../lib/modeling/offline-replay/contractAFilterSim";
import type { ModelReadyRow } from "../../lib/modeling/offline-replay/types";

const WINDOW = { from: "2026-09-01", to: "2026-09-10", asOf: "2026-09-10T14:04:29.586Z" };
const CANDIDATE_1: ContractAAblation = { minEntryPrice: 0.5, skipBadBucket: true };
const CANDIDATE_2: ContractAAblation = {
  minEntryPrice: 0.5,
  skipBadBucket: true,
  restrictToMarketClasses: ["allowed_fullmatch_total"],
};

const round = (v: number, dp = 2) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};
function cmp(a: ModelReadyRow, b: ModelReadyRow): number {
  if (a.decision_at !== b.decision_at) return a.decision_at < b.decision_at ? -1 : 1;
  const as = a.event_start ?? "", bs = b.event_start ?? "";
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.physical_event_id !== b.physical_event_id) return a.physical_event_id < b.physical_event_id ? -1 : 1;
  return a.research_identity < b.research_identity ? -1 : a.research_identity > b.research_identity ? 1 : 0;
}
interface Bet { row: ModelReadyRow; pnl_u: number | null }
function select(rows: ModelReadyRow[], pred: (r: ModelReadyRow) => boolean): Bet[] {
  const ordered = [...rows].sort(cmp);
  const claimed = new Set<string>();
  const bets: Bet[] = [];
  for (const r of ordered) {
    if (!pred(r) || claimed.has(r.physical_event_id)) continue;
    claimed.add(r.physical_event_id);
    const pnl =
      r.terminal_status === "OPEN" || r.entry_price == null
        ? null
        : settleBetU(r.terminal_status === "WIN" ? "WIN" : "LOSS", r.entry_price);
    bets.push({ row: r, pnl_u: pnl });
  }
  return bets;
}
function econ(bets: Bet[], filterPassEvents?: number) {
  const term = bets.filter((b) => b.pnl_u != null) as (Bet & { pnl_u: number })[];
  const chrono = [...term].sort((a, b) => cmp(a.row, b.row));
  const wins = term.filter((b) => b.row.terminal_status === "WIN").length;
  const pnl = term.reduce((s, b) => s + b.pnl_u, 0);
  const dd = maxDrawdownU(
    chrono.map<SelectedBet>((b) => ({
      physicalEventKey: b.row.physical_event_id, decisionTimestamp: b.row.decision_at,
      eventStart: b.row.event_start ?? b.row.decision_at, leadTimeHours: b.row.lead_time_hours ?? 0,
      entryPrice: b.row.entry_price as number, sportFamily: b.row.sport,
      outcome: b.row.terminal_status === "WIN" ? "WIN" : "LOSS", pnlU: b.pnl_u,
    })),
  );
  return {
    ...(filterPassEvents != null ? { FILTER_PASS_EVENTS: filterPassEvents } : {}),
    BETS: bets.length, TERMINAL: term.length, UNRESOLVED: bets.length - term.length,
    WINS: wins, LOSSES: term.length - wins, PNL_U: round(pnl),
    ROI_PCT: term.length ? round((pnl / term.length) * 100, 4) : null,
    MAX_DD_U: round(dd), WIN_RATE_PCT: term.length ? round((wins / term.length) * 100, 2) : null,
  };
}
function mc(row: ModelReadyRow): string {
  return contractAFilterVerdict(row).market_class ?? "unknown";
}
function group(bets: Bet[], key: (b: Bet) => string) {
  const g = new Map<string, Bet[]>();
  for (const b of bets) { const k = key(b); if (!g.has(k)) g.set(k, []); g.get(k)!.push(b); }
  const out: Record<string, ReturnType<typeof econ>> = {};
  for (const [k, arr] of [...g.entries()].sort()) out[k] = econ(arr);
  return out;
}

// ---------------------------------------------------------------------------
const view = loadModelReadyView(WINDOW);
const rows = view.rows;
const passEvents = (abl: ContractAAblation | null) =>
  new Set(rows.filter((r) => (abl ? contractAFilterVerdict(r, abl).pass : POLICY_REGISTRY.C0.evaluate(r).pass)).map((r) => r.physical_event_id)).size;

const c0Bets = select(rows, (r) => POLICY_REGISTRY.C0.evaluate(r).pass);
const aBets = select(rows, (r) => contractAFilterVerdict(r).pass);
const c1Bets = select(rows, (r) => contractAFilterVerdict(r, CANDIDATE_1).pass);
const c2Bets = select(rows, (r) => contractAFilterVerdict(r, CANDIDATE_2).pass);

// research-only guard: assert NO candidate bet is a research-only counterfactual
// (neither candidate sets skipExecutableMarketAnchor, so this must be 0).
const researchOnlyLeak =
  c1Bets.filter((b) => contractAFilterVerdict(b.row, CANDIDATE_1).research_only_counterfactual).length +
  c2Bets.filter((b) => contractAFilterVerdict(b.row, CANDIDATE_2).research_only_counterfactual).length;

const comparison = [
  { MODEL: "CONTRACT_A_FILTER_SIM_CURRENT", ...econ(aBets, passEvents({})) },
  { MODEL: "CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF", ...econ(c1Bets, passEvents(CANDIDATE_1)) },
  { MODEL: "CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF", ...econ(c2Bets, passEvents(CANDIDATE_2)) },
  { MODEL: "C0_REFERENCE", ...econ(c0Bets, passEvents(null)) },
];

const sportTable = {
  CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF: group(c1Bets, (b) => b.row.sport || "unknown"),
  CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF: group(c2Bets, (b) => b.row.sport || "unknown"),
};
const marketTable = {
  CONTRACT_A_PRICE_FLOOR_050_BAD_BUCKET_OFF: group(c1Bets, (b) => mc(b.row)),
  CONTRACT_A_TOTALS_PRICE_FLOOR_050_BAD_BUCKET_OFF: group(c2Bets, (b) => mc(b.row)),
};

// ---- ATTRIBUTION ------------------------------------------------------------
const aEvents = new Map(aBets.map((b) => [b.row.physical_event_id, b]));
const c1Events = new Map(c1Bets.map((b) => [b.row.physical_event_id, b]));
const c2Events = new Set(c2Bets.map((b) => b.row.physical_event_id));

// Candidate 1
const removedByFloor = aBets.filter(
  (b) => !c1Events.has(b.row.physical_event_id) && (b.row.entry_price ?? 1) < 0.5,
);
const restoredByBadBucketOff = c1Bets.filter((b) => !aEvents.has(b.row.physical_event_id));
function sumTerm(bets: Bet[]) {
  const t = bets.filter((b) => b.pnl_u != null) as (Bet & { pnl_u: number })[];
  return { TERMINAL_N: t.length, PNL_U: round(t.reduce((s, b) => s + b.pnl_u, 0)) };
}
const attr1 = {
  REMOVED_SUB_050: sumTerm(removedByFloor),
  RESTORED_BY_BAD_BUCKET_OFF: sumTerm(restoredByBadBucketOff),
};

// Candidate 2 (starts from Candidate 1)
const removedFromC1 = c1Bets.filter((b) => !c2Events.has(b.row.physical_event_id));
const removedMoneyline = removedFromC1.filter((b) => mc(b.row) === "allowed_fullmatch_moneyline");
const removedSpread = removedFromC1.filter((b) => mc(b.row) === "allowed_fullmatch_spread");
const retainedTotal = c2Bets;
const attr2 = {
  REMOVED_MONEYLINE: sumTerm(removedMoneyline),
  REMOVED_SPREAD: sumTerm(removedSpread),
  REMOVED_OTHER_FROM_C1: sumTerm(removedFromC1.filter((b) => !["allowed_fullmatch_moneyline", "allowed_fullmatch_spread"].includes(mc(b.row)))),
  RETAINED_TOTAL: sumTerm(retainedTotal),
};

// ---- DECISION -------------------------------------------------------------
const A = comparison[0], C1 = comparison[1], C2 = comparison[2];
const c1Improves = (C1.PNL_U as number) - (A.PNL_U as number) >= 40 && C1.TERMINAL >= 30;
const c2Improves = (C2.PNL_U as number) - (A.PNL_U as number) >= 40 && C2.TERMINAL >= 30;
const c1Positive = (C1.PNL_U as number) > 0;
const c2Positive = (C2.PNL_U as number) > 0;
let decision: string;
if (!c1Improves && !c2Improves) decision = "NO_FIXED_CORRECTION_SUPPORTED";
else if (c1Improves && c2Improves) {
  decision =
    (C2.ROI_PCT ?? -999) > (C1.ROI_PCT ?? -999) || (c2Positive && !c1Positive)
      ? "BOTH_SUPPORTED_CANDIDATE_2_STRONGER"
      : "CANDIDATE_1_SUPPORTED";
} else decision = c1Improves ? "CANDIDATE_1_SUPPORTED" : "CANDIDATE_2_SUPPORTED";

const payload = {
  mission: "COMPARE_TWO_FIXED_CONTRACT_A_CORRECTIONS_V1",
  window: WINDOW,
  economics_basis: "GROSS_BEFORE_FEES",
  baseline_reproduced: {
    value: comparison[0],
    // CURRENT origin/main Contract A authority (PRODUCTION_SCORED_PLANNING_VERSIONS, planning mode).
    // The old 545 / -86.91 / -15.95 was NON_CANONICAL_LOCAL_WIP_SEMANTICS (3-version unreleased list).
    expected: { TERMINAL: 251, WINS: 71, LOSSES: 180, PNL_U: -50.29, ROI: -20.04 },
    match:
      comparison[0].TERMINAL === 251 &&
      comparison[0].WINS === 71 &&
      comparison[0].LOSSES === 180 &&
      comparison[0].PNL_U === -50.29,
    superseded_non_canonical: { TERMINAL: 545, PNL_U: -86.91, ROI: -15.95, authority: "NON_CANONICAL_LOCAL_WIP_SEMANTICS" },
  },
  candidate_1_definition: CANDIDATE_1,
  candidate_2_definition: CANDIDATE_2,
  NO_RESEARCH_ONLY_MARKET_ADMISSION: researchOnlyLeak === 0,
  comparison_table: comparison,
  sport_table: sportTable,
  market_table: marketTable,
  attribution_candidate_1: attr1,
  attribution_candidate_2: attr2,
  decision,
};

const dir = join("modeling", "evidence", "offline-replay-plane-v1");
writeFileSync(join(dir, "CONTRACT_A_CANDIDATES_V1.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
