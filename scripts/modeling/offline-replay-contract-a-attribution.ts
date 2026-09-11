/**
 * ATTRIBUTE_CONTRACT_A_NEGATIVE_PNL_TO_EXACT_FILTERS_V1 — offline diagnostic.
 *
 * Uses the existing reusable offline replay plane (model-ready view, frozen
 * predicates, canonical Contract-A filter with its one-gate ablation switches).
 * NO production query, NO threshold search, NO policy change. Descriptive
 * attribution + one-gate ablations only.
 *
 *   npm run modeling:offline-replay:contract-a-attribution
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

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
function cmp(a: ModelReadyRow, b: ModelReadyRow): number {
  if (a.decision_at !== b.decision_at) return a.decision_at < b.decision_at ? -1 : 1;
  const as = a.event_start ?? "", bs = b.event_start ?? "";
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.physical_event_id !== b.physical_event_id) return a.physical_event_id < b.physical_event_id ? -1 : 1;
  return a.research_identity < b.research_identity ? -1 : a.research_identity > b.research_identity ? 1 : 0;
}

interface Bet {
  row: ModelReadyRow;
  pnl_u: number | null; // null = unresolved
}

/** one bet per physical event = chronologically-first passing identity */
function select(rows: ModelReadyRow[], predicate: (r: ModelReadyRow) => boolean): Bet[] {
  const ordered = [...rows].sort(cmp);
  const claimed = new Set<string>();
  const bets: Bet[] = [];
  for (const r of ordered) {
    if (!predicate(r)) continue;
    if (claimed.has(r.physical_event_id)) continue;
    claimed.add(r.physical_event_id);
    const pnl =
      r.terminal_status === "OPEN" || r.entry_price == null
        ? null
        : settleBetU(r.terminal_status === "WIN" ? "WIN" : "LOSS", r.entry_price);
    bets.push({ row: r, pnl_u: pnl });
  }
  return bets;
}

function econ(bets: Bet[]) {
  const term = bets.filter((b) => b.pnl_u != null) as (Bet & { pnl_u: number })[];
  const chrono = [...term].sort((a, b) => cmp(a.row, b.row));
  const wins = term.filter((b) => b.row.terminal_status === "WIN").length;
  const pnl = term.reduce((s, b) => s + b.pnl_u, 0);
  const dd = maxDrawdownU(
    chrono.map<SelectedBet>((b) => ({
      physicalEventKey: b.row.physical_event_id,
      decisionTimestamp: b.row.decision_at,
      eventStart: b.row.event_start ?? b.row.decision_at,
      leadTimeHours: b.row.lead_time_hours ?? 0,
      entryPrice: b.row.entry_price as number,
      sportFamily: b.row.sport,
      outcome: b.row.terminal_status === "WIN" ? "WIN" : "LOSS",
      pnlU: b.pnl_u,
    })),
  );
  return {
    BETS: bets.length,
    TERMINAL: term.length,
    UNRESOLVED: bets.length - term.length,
    WINS: wins,
    LOSSES: term.length - wins,
    PNL_U: round(pnl),
    ROI_PCT: term.length ? round((pnl / term.length) * 100, 4) : null,
    MAX_DD_U: round(dd),
    WIN_RATE_PCT: term.length ? round((wins / term.length) * 100, 2) : null,
  };
}

// bucket helpers (fixed, non-optimized)
const bEntry = (p: number | null) =>
  p == null ? "null" : p < 0.44 ? "<0.44" : p < 0.5 ? "0.44-0.50" : p < 0.54 ? "0.50-0.54" : p < 0.58 ? "0.54-0.58" : p < 0.6 ? "0.58-0.60" : ">=0.60";
const bLead = (h: number | null) =>
  h == null ? "null" : h < 2 ? "0-2h" : h < 6 ? "2-6h" : h < 24 ? "6-24h" : ">=24h";
const bScore = (s: number | null) =>
  s == null ? "null" : s < 60 ? "50-59" : s < 65 ? "60-64" : s < 72 ? "65-71" : ">=72";
const bCov = (c: number | null) => (c == null ? "other/unknown" : c === 25 ? "25" : c === 50 ? "50" : c === 75 ? "75" : "other/unknown");

function groupEcon(bets: Bet[], key: (b: Bet) => string) {
  const g = new Map<string, Bet[]>();
  for (const b of bets) {
    const k = key(b);
    (g.get(k) ?? g.set(k, []).get(k)!).push(b);
  }
  const out: Record<string, ReturnType<typeof econ>> = {};
  for (const [k, arr] of [...g.entries()].sort()) out[k] = econ(arr);
  return out;
}

// ---------------------------------------------------------------------------
const view = loadModelReadyView(WINDOW);
const rows = view.rows;

const c0Pred = (r: ModelReadyRow) => POLICY_REGISTRY.C0.evaluate(r).pass;
const aPred = (abl: ContractAAblation = {}) => (r: ModelReadyRow) => contractAFilterVerdict(r, abl).pass;

const c0Bets = select(rows, c0Pred);
const aBets = select(rows, aPred());
const baseline = { C0: econ(c0Bets), CONTRACT_A_FILTER_SIM_CURRENT: econ(aBets) };

// ---- ANALYSIS 1: Contract A selected-bet economics by bucket -------------
const a1 = {
  by_entry_price: groupEcon(aBets, (b) => bEntry(b.row.entry_price)),
  by_lead_time: groupEcon(aBets, (b) => bLead(b.row.lead_time_hours)),
  by_score: groupEcon(aBets, (b) => bScore(b.row.signal_score)),
  by_data_coverage: groupEcon(aBets, (b) => bCov(b.row.coverage)),
  by_formula_version: groupEcon(aBets, (b) => b.row.formula_version ?? "null"),
  by_market_family: groupEcon(aBets, (b) => {
    const v = contractAFilterVerdict(b.row);
    return v.market_class ?? "unknown";
  }),
};

// ---- ANALYSIS 2 + 3: one-gate ablations ---------------------------------
function ablation(name: string, abl: ContractAAblation, researchOnlyNote = false) {
  const bets = select(rows, aPred(abl));
  const e = econ(bets);
  // events that pass ONLY because of this ablation (rejected by current, admitted now)
  const currentPassEvents = new Set(aBets.map((b) => b.row.physical_event_id));
  const newlyAdmitted = bets.filter((b) => !currentPassEvents.has(b.row.physical_event_id));
  return {
    name,
    ...e,
    DELTA_TERMINAL: e.TERMINAL - baseline.CONTRACT_A_FILTER_SIM_CURRENT.TERMINAL,
    DELTA_PNL_U: round(e.PNL_U - baseline.CONTRACT_A_FILTER_SIM_CURRENT.PNL_U),
    DELTA_ROI_PP:
      e.ROI_PCT != null && baseline.CONTRACT_A_FILTER_SIM_CURRENT.ROI_PCT != null
        ? round(e.ROI_PCT - baseline.CONTRACT_A_FILTER_SIM_CURRENT.ROI_PCT, 4)
        : null,
    NEWLY_ADMITTED_EVENT_ECON: econ(newlyAdmitted),
    ...(researchOnlyNote ? { NOTE: "RESEARCH_ONLY_COUNTERFACTUAL — admits classes current money policy rejects" } : {}),
  };
}
const a2_badBucket = ablation("CONTRACT_A_MINUS_BAD_BUCKET", { skipBadBucket: true });
const a3 = {
  A_minus_tier_admission: ablation("CONTRACT_A_MINUS_TIER_ADMISSION", { skipTierAdmission: true }),
  B_minus_score_floor: ablation("CONTRACT_A_MINUS_SCORE_FLOOR", { skipScoreFloor: true }),
  C_minus_executable_market_anchor: ablation(
    "CONTRACT_A_MINUS_EXECUTABLE_MARKET_ANCHOR",
    { skipExecutableMarketAnchor: true },
    true,
  ),
};

// ---- ANALYSIS 4: formula mix under unchanged filters --------------------
const a4 = groupEcon(aBets, (b) => b.row.formula_version ?? "null");

// ---- ANALYSIS 5: C0 vs Contract A physical-event overlap ---------------
const c0EventBet = new Map(c0Bets.map((b) => [b.row.physical_event_id, b]));
const aEventBet = new Map(aBets.map((b) => [b.row.physical_event_id, b]));
const allEvents = new Set(rows.map((r) => r.physical_event_id));
let A_AND_C0 = 0, A_ONLY = 0, C0_ONLY = 0, NEITHER = 0;
let sameIdentity = 0, diffIdentity = 0;
const sharedA: Bet[] = [], sharedC0: Bet[] = [];
const sameIdBets: Bet[] = [], diffIdBets_A: Bet[] = [], diffIdBets_C0: Bet[] = [];
for (const ev of allEvents) {
  const a = aEventBet.get(ev), c = c0EventBet.get(ev);
  if (a && c) {
    A_AND_C0++;
    sharedA.push(a);
    sharedC0.push(c);
    if (a.row.research_identity === c.row.research_identity) {
      sameIdentity++;
      sameIdBets.push(a);
    } else {
      diffIdentity++;
      diffIdBets_A.push(a);
      diffIdBets_C0.push(c);
    }
  } else if (a) A_ONLY++;
  else if (c) C0_ONLY++;
  else NEITHER++;
}
const a5 = {
  event_counts: { A_AND_C0, A_ONLY, C0_ONLY, NEITHER, TOTAL: allEvents.size },
  shared_events: {
    SAME_SELECTED_MARKET_OUTCOME_N: sameIdentity,
    DIFFERENT_SELECTED_MARKET_OUTCOME_N: diffIdentity,
  },
  A_SELECTED_ON_SHARED_EVENTS: econ(sharedA),
  C0_SELECTED_ON_SHARED_EVENTS: econ(sharedC0),
  SAME_EVENT_SAME_IDENTITY: econ(sameIdBets),
  SAME_EVENT_DIFFERENT_IDENTITY_A: econ(diffIdBets_A),
  SAME_EVENT_DIFFERENT_IDENTITY_C0: econ(diffIdBets_C0),
  A_ONLY_EVENTS_ECON: econ(aBets.filter((b) => !c0EventBet.has(b.row.physical_event_id))),
  C0_ONLY_EVENTS_ECON: econ(c0Bets.filter((b) => !aEventBet.has(b.row.physical_event_id))),
};

// ---- ANALYSIS 6: soccer/tennis same-market-family control --------------
function familyControl(sport: string) {
  const aFam = new Set(aBets.filter((b) => b.row.sport === sport).map((b) => contractAFilterVerdict(b.row).market_class));
  const out: Record<string, { A: ReturnType<typeof econ>; C0: ReturnType<typeof econ> }> = {};
  for (const fam of [...aFam].sort()) {
    const aIn = aBets.filter((b) => b.row.sport === sport && contractAFilterVerdict(b.row).market_class === fam);
    // C0 has no market-family filter — classify its bets with the same canonical classifier
    const c0In = c0Bets.filter(
      (b) => b.row.sport === sport && contractAFilterVerdict(b.row, { skipExecutableMarketAnchor: true, skipScoreFloor: true, skipTierAdmission: true, skipBadBucket: true }).market_class === fam,
    );
    out[fam] = { A: econ(aIn), C0: econ(c0In) };
  }
  return out;
}
const a6 = { soccer: familyControl("soccer"), tennis: familyControl("tennis") };

// ---- RANKED FOUNDER TABLE ----------------------------------------------
const A = baseline.CONTRACT_A_FILTER_SIM_CURRENT;
const rankRows = [
  { CONTRACT_A_SEMANTIC: "BAD_BUCKET", CURRENT_RULE: "reject coverage∈[50,74] ∧ price∈[0.44,0.58]", abl: a2_badBucket },
  { CONTRACT_A_SEMANTIC: "TIER_ADMISSION", CURRENT_RULE: "computeTier(score,cov) must be non-null (T1/T2/T3)", abl: a3.A_minus_tier_admission },
  { CONTRACT_A_SEMANTIC: "SCORE_FLOOR", CURRENT_RULE: "score ≥ 50", abl: a3.B_minus_score_floor },
  { CONTRACT_A_SEMANTIC: "EXECUTABLE_MARKET_ANCHOR", CURRENT_RULE: "resolveMarketAnchorDecision().allowed (fullmatch money/spread/total only)", abl: a3.C_minus_executable_market_anchor },
].map((x) => {
  const deltaPnl = round(x.abl.PNL_U - A.PNL_U);
  const deltaRoi = x.abl.ROI_PCT != null && A.ROI_PCT != null ? round(x.abl.ROI_PCT - A.ROI_PCT, 2) : null;
  // VERDICT: does REMOVING the gate improve economics? if yes → the gate is damaging.
  let verdict = "INSUFFICIENT_EVIDENCE";
  if (x.abl.TERMINAL >= 30 && deltaPnl != null) {
    if (deltaPnl > 40) verdict = "LIKELY_MAJOR_DAMAGE";
    else if (deltaPnl > 10) verdict = "LIKELY_DAMAGE";
    else verdict = "NEUTRAL_OR_PROTECTIVE";
  } else if (x.abl.TERMINAL < 30) {
    verdict = "INSUFFICIENT_EVIDENCE";
  }
  return {
    CONTRACT_A_SEMANTIC: x.CONTRACT_A_SEMANTIC,
    CURRENT_RULE: x.CURRENT_RULE,
    EVIDENCE: `ablation TERMINAL=${x.abl.TERMINAL}, newly-admitted-only TERMINAL=${x.abl.NEWLY_ADMITTED_EVENT_ECON.TERMINAL} PnL=${x.abl.NEWLY_ADMITTED_EVENT_ECON.PNL_U}`,
    CURRENT_A_PNL: A.PNL_U,
    ABLATION_PNL: x.abl.PNL_U,
    DELTA_PNL: deltaPnl,
    CURRENT_A_ROI: A.ROI_PCT,
    ABLATION_ROI: x.abl.ROI_PCT,
    DELTA_ROI_PP: deltaRoi,
    VERDICT: verdict,
  };
});
rankRows.sort((a, b) => (b.DELTA_PNL ?? -1e9) - (a.DELTA_PNL ?? -1e9));
const ranked = rankRows.map((r, i) => ({ RANK: i + 1, ...r }));

const payload = {
  mission: "ATTRIBUTE_CONTRACT_A_NEGATIVE_PNL_TO_EXACT_FILTERS_V1",
  window: WINDOW,
  economics_basis: "GROSS_BEFORE_FEES",
  baseline_reproduced: {
    C0: baseline.C0,
    CONTRACT_A_FILTER_SIM_CURRENT: baseline.CONTRACT_A_FILTER_SIM_CURRENT,
    // CURRENT origin/main Contract A authority. Old A 545 / -86.91 = NON_CANONICAL_LOCAL_WIP_SEMANTICS.
    expected: { C0_TERMINAL: 1578, C0_PNL_U: 241.6, A_TERMINAL: 251, A_PNL_U: -50.29 },
    match:
      baseline.C0.TERMINAL === 1578 &&
      baseline.C0.PNL_U === 241.6 &&
      baseline.CONTRACT_A_FILTER_SIM_CURRENT.TERMINAL === 251 &&
      baseline.CONTRACT_A_FILTER_SIM_CURRENT.PNL_U === -50.29,
    superseded_non_canonical: { A_TERMINAL: 545, A_PNL_U: -86.91, A_ROI: -15.95, authority: "NON_CANONICAL_LOCAL_WIP_SEMANTICS" },
  },
  analysis_1_selected_bet_economics: a1,
  analysis_2_bad_bucket_ablation: a2_badBucket,
  analysis_3_other_ablations: a3,
  analysis_4_formula_mix: a4,
  analysis_5_c0_contract_a_overlap: a5,
  analysis_6_soccer_tennis_shared_family_control: a6,
  ranked_founder_table: ranked,
};

const outDir = join("modeling", "evidence", "offline-replay-plane-v1");
writeFileSync(join(outDir, "CONTRACT_A_ATTRIBUTION_V1.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload, null, 2));
