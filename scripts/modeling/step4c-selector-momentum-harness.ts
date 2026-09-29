/** STEP 4C exact-selector binding. No database, labels, or policy mutation. */
import { compareCandidateQuality } from "@/lib/executor/nightPortfolioPlanner";
import type { FireModelCandidate } from "@/lib/executor/buildFireModelCandidates";
import { compareChronologically, settleBetU, type EvaluatedEvent, type SelectedBet } from "@/lib/modeling/research-engine";
import { metricsFor } from "./daily-portfolio-frontier";

export const FIXED_SNAPSHOT_RUN_ID = "f94429cb-eb8e-4607-a06d-701208b8ceb3";
export const SELECTOR_A = "CHRONOLOGICAL_FIRST";
export const SELECTOR_B = "compareCandidateQuality";

export interface Opportunity {
  physicalEventKey: string; // canonical snapshot event_id, never condition_id
  conditionId: string;
  selectedTokenId: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  marketFamily: string;
  /** An actual live FireModelCandidate, not a reconstructed research approximation. */
  liveCandidate: FireModelCandidate;
}

export interface Choice { physicalEventKey: string; exactIdentity: string; opportunity: Opportunity }
export const exactIdentity = (o: Pick<Opportunity, "conditionId" | "selectedTokenId">) => `${o.conditionId}::${o.selectedTokenId}`;

function requireComplete(o: Opportunity): void {
  if (!o.physicalEventKey || !o.conditionId || !o.selectedTokenId || !o.decisionTimestamp || !o.eventStart || !(o.entryPrice > 0 && o.entryPrice < 1)) {
    throw new Error("INCOMPLETE_OPPORTUNITY");
  }
  const c = o.liveCandidate;
  if (!c || c.condition_id !== o.conditionId || c.token_id !== o.selectedTokenId || typeof c.live_eligible !== "boolean"
    || !c.strategy || !c.match_family_key_source || !Number.isFinite(c.diagnostics?.score)
    || !Number.isFinite(c.diagnostics?.coverage) || !Number.isFinite(c.diagnostics?.hours_to_start_now)) {
    throw new Error(`LIVE_COMPARATOR_INPUT_UNAVAILABLE:${exactIdentity(o)}`);
  }
}

function asChronological(o: Opportunity): EvaluatedEvent {
  // compareChronologically reads only these decision-time fields. Settlement is
  // deliberately absent; it is joined after both selectors have chosen.
  return {
    physicalEventKey: o.physicalEventKey, decisionTimestamp: o.decisionTimestamp,
    eventStart: o.eventStart, entryPrice: o.entryPrice, sportFamily: "soccer",
    ref: o.conditionId, candidateRef: o.selectedTokenId,
    leadTimeHours: (Date.parse(o.eventStart) - Date.parse(o.decisionTimestamp)) / 3_600_000,
  } as EvaluatedEvent;
}

export function compareSiblingSelectors(input: Opportunity[]) {
  const groups = new Map<string, Opportunity[]>();
  const seen = new Set<string>();
  for (const o of input) {
    requireComplete(o);
    const key = `${o.physicalEventKey}::${exactIdentity(o)}`;
    if (seen.has(key)) throw new Error(`DUPLICATE_EXACT_IDENTITY:${key}`);
    seen.add(key);
    const group = groups.get(o.physicalEventKey) ?? [];
    group.push(o);
    groups.set(o.physicalEventKey, group);
  }
  const paired = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([physicalEventKey, siblings]) => {
    const chronological = [...siblings].sort((a, b) => compareChronologically(asChronological(a), asChronological(b)));
    const quality = [...siblings].sort((a, b) => compareCandidateQuality(a.liveCandidate, b.liveCandidate));
    if (quality.length > 1 && compareCandidateQuality(quality[0].liveCandidate, quality[1].liveCandidate) === 0) {
      throw new Error(`LIVE_COMPARATOR_TOP_TIE:${physicalEventKey}`);
    }
    const a = chronological[0];
    const b = quality[0];
    return { physicalEventKey, siblingN: siblings.length,
      A: { physicalEventKey, exactIdentity: exactIdentity(a), opportunity: a } as Choice,
      B: { physicalEventKey, exactIdentity: exactIdentity(b), opportunity: b } as Choice,
      differentIdentity: exactIdentity(a) !== exactIdentity(b) };
  });
  return {
    eventN: paired.length,
    differentIdentityN: paired.filter((p) => p.differentIdentity).length,
    differentIdentityPct: paired.length ? 100 * paired.filter((p) => p.differentIdentity).length / paired.length : 0,
    paired,
  };
}

/** Exact identity labels are joined only after A and B membership is frozen. */
export function settlePairedChoices(
  compared: ReturnType<typeof compareSiblingSelectors>,
  labels: ReadonlyMap<string, "WIN" | "LOSS" | "OPEN">,
) {
  const result = (arm: "A" | "B") => {
    const bets: SelectedBet[] = [];
    let openN = 0; let unlabeledN = 0;
    for (const pair of compared.paired) {
      const { exactIdentity: identity, opportunity: o } = pair[arm];
      const label = labels.get(identity);
      if (label === undefined) { unlabeledN++; continue; }
      if (label === "OPEN") { openN++; continue; }
      bets.push({ physicalEventKey: o.physicalEventKey, decisionTimestamp: o.decisionTimestamp,
        eventStart: o.eventStart, leadTimeHours: (Date.parse(o.eventStart) - Date.parse(o.decisionTimestamp)) / 3_600_000,
        entryPrice: o.entryPrice, sportFamily: "soccer", outcome: label, pnlU: settleBetU(label, o.entryPrice),
        ref: o.conditionId, candidateRef: o.selectedTokenId });
    }
    return { selectedN: compared.eventN, settledN: bets.length, openN, unlabeledN, ...metricsFor(bets) };
  };
  let aWinBLoss = 0; let aLossBWin = 0;
  for (const p of compared.paired) {
    if (!p.differentIdentity) continue;
    const a = labels.get(p.A.exactIdentity); const b = labels.get(p.B.exactIdentity);
    if (a === "WIN" && b === "LOSS") aWinBLoss++;
    if (a === "LOSS" && b === "WIN") aLossBWin++;
  }
  const A = result("A"); const B = result("B");
  return { A, B, aWinBLoss, aLossBWin, pairedPnlAMinusB: A.pnl_u - B.pnl_u };
}

export const MOMENTUM_CONTRACT = Object.freeze({
  snapshotRunId: FIXED_SNAPSHOT_RUN_ID,
  target: "canonical exact condition_id + selected_token_id WIN/LOSS, joined after sibling selection; OPEN retained",
  cohort: "S2_WIDE_SCORER soccer, snapshot_at < game_start_iso, fixed snapshot run",
  split: { train: "game_start_iso < 2026-09-29T00:00:00Z", heldOut: "game_start_iso >= 2026-09-29T00:00:00Z", unit: "physical event_id" },
  M0: ["selected_price_num", "researchContext.marketType"],
  M1: ["selected_price_num", "researchContext.marketType", "scoreObservation.scoreValue", "data_coverage_num", "game_start_iso - snapshot_at"],
  M2: ["selected_price_num", "researchContext.marketType", "scoreObservation.scoreValue", "data_coverage_num", "game_start_iso - snapshot_at", "price1hAgo", "price6hAgo", "delta1hPp", "delta6hPp"],
  missingFeature: "fail closed for M1/M2 paired comparison; never impute from future observations",
  selection: "one exact identity per event; compareChronologically versus actual compareCandidateQuality; no outcome in selector",
  metrics: ["selected", "settled", "open", "W", "L", "hit_rate", "Brier", "log_loss", "reference_pnl_u", "reference_roi_pct", "max_dd_u", "paired_M2_minus_M1"],
  modelMethodStatus: "NO_CANONICAL_M0_M1_M2_ESTIMATOR_IDENTIFIED; no arbitrary fitted model introduced",
});
