/**
 * FOOTBALL_VERIFICATION_REVIEW_A_V1 — aggregate-only football verification note
 * for the Review A SAFE authority repair. NOT a new modeling authority: reuses
 * the repaired runner's own canonical primitives verbatim —
 * fetchRows/resolveDb/fetchTennisIdentityLookup, loadReconciledClassificationMap,
 * applyReconciledAuthority, buildSafeUniverse, runStandaloneStrict,
 * referenceEconomics — all imported from
 * scripts/modeling/tennis-safe-comparable-leaderboard.ts and
 * scripts/modeling/daily-portfolio-frontier.ts. No new predicate, no new
 * economics formula, no model ranking.
 *
 * Reports UNCAPPED P50_52_SAFE / P50_54_SAFE restricted to the reconciled
 * football (soccer) population only, split Aug/Sep/combined — a denominator-
 * style report, not an operational capped selection.
 *
 *   npx tsx scripts/modeling/football-verification-review-a.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { toDecisionTimeSelectionInput } from "./factor-atlas";
import { runStandaloneStrict } from "./daily-portfolio-frontier";
import { SOCCER_FAMILY } from "@/lib/modeling/research-engine/models";
import {
  fetchRows,
  resolveDb,
  fetchTennisIdentityLookup,
  loadReconciledClassificationMap,
  applyReconciledAuthority,
  buildSafeUniverse,
  referenceEconomics,
  PNL_CLASS,
  PNL_AUTHORITY,
  round,
  type ReferenceEconomics,
} from "./tennis-safe-comparable-leaderboard";

const EVIDENCE_OUT_DIR = "modeling/evidence/safe-authority-review-a-repair-v1";
const AUG_END = "2026-08-31";
const FROZEN_FOOTBALL_DENOMINATOR_N = 4694; // modeling/evidence/football-denominator-reconciliation-v1/FINDINGS.md — combined canonical soccer denominator, unchanged here.

interface FootballBand {
  N: number;
  TERMINAL_N: number;
  UNRESOLVED_N: number;
  UNRESOLVED_BY_STATUS: Record<string, number>;
  REFERENCE_PNL_U: number;
  REFERENCE_ROI_PCT: number;
  MAX_DD_U: number;
}

function toBand(r: ReferenceEconomics): FootballBand {
  return {
    N: r.SELECTED_N,
    TERMINAL_N: r.TERMINAL_N,
    UNRESOLVED_N: r.UNRESOLVED_N,
    UNRESOLVED_BY_STATUS: r.UNRESOLVED_BY_STATUS,
    REFERENCE_PNL_U: r.REFERENCE_PNL_U,
    REFERENCE_ROI_PCT: r.REFERENCE_ROI_PCT,
    MAX_DD_U: r.MAX_DD_U,
  };
}

async function main() {
  const rawRows = await fetchRows();
  const { candidates: rawDecisionTimeCandidates, settlementByCandidateIdentity } = toDecisionTimeSelectionInput(rawRows);

  const overlay = loadReconciledClassificationMap();
  const reconciled = applyReconciledAuthority(rawDecisionTimeCandidates, overlay);
  const decisionTimeCandidates = reconciled.eligible;

  const tennisConditionIds = decisionTimeCandidates.filter((e) => e.sportFamily === "tennis").map((e) => e.ref).filter((v): v is string => !!v);
  const db = await resolveDb();
  const identityLookup = await fetchTennisIdentityLookup(db, tennisConditionIds);
  const { safeUniverse } = buildSafeUniverse(decisionTimeCandidates, identityLookup);

  const p5052 = runStandaloneStrict(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.52);
  const p5054 = runStandaloneStrict(safeUniverse, (e) => e.entryPrice >= 0.5 && e.entryPrice < 0.54);

  const footballOnly = (bets: typeof p5052) => bets.filter((b) => b.sportFamily === SOCCER_FAMILY);
  const byPeriod = (bets: typeof p5052) => ({
    AUG: bets.filter((b) => b.day <= AUG_END),
    SEP: bets.filter((b) => b.day > AUG_END),
    COMBINED: bets,
  });

  const p5052Football = footballOnly(p5052);
  const p5054Football = footballOnly(p5054);
  const p5052Periods = byPeriod(p5052Football);
  const p5054Periods = byPeriod(p5054Football);

  const P50_52_FOOTBALL = {
    AUG: toBand(referenceEconomics(p5052Periods.AUG, settlementByCandidateIdentity)),
    SEP: toBand(referenceEconomics(p5052Periods.SEP, settlementByCandidateIdentity)),
    COMBINED: toBand(referenceEconomics(p5052Periods.COMBINED, settlementByCandidateIdentity)),
  };
  const P50_54_FOOTBALL = {
    AUG: toBand(referenceEconomics(p5054Periods.AUG, settlementByCandidateIdentity)),
    SEP: toBand(referenceEconomics(p5054Periods.SEP, settlementByCandidateIdentity)),
    COMBINED: toBand(referenceEconomics(p5054Periods.COMBINED, settlementByCandidateIdentity)),
  };

  const artifact = {
    MISSION: "FOOTBALL_VERIFICATION_REVIEW_A_V1",
    NOTE:
      "Denominator-style verification only: UNCAPPED P50_52_SAFE/P50_54_SAFE selections restricted to the reconciled football (soccer) population. No cap, no live-mix allocation, no model ranking. REFERENCE_PNL at display price, NOT_EXECUTION_AUTHORITY. Unresolved rows mean final realised historical PnL is not yet closed.",
    PNL_CLASS,
    PNL_AUTHORITY,
    FROZEN_FOOTBALL_DENOMINATOR_N,
    EXACT_SCORE_EXCLUDED_BEFORE_SELECTION_N: reconciled.exactScoreExcludedIdentities.size,
    EXACT_SCORE_SELECTED_N: 0,
    P50_52_FOOTBALL,
    P50_54_FOOTBALL,
    PRICE_INDEPENDENT_ALPHA_PROVEN: "NO",
    ARCHITECT_DB_CROSS_CHECK_DISCREPANCY_NOTE:
      "An independent architect DB cross-check reported P50_52 combined N=1016/terminal=671/unresolved=345/PnL~+122.89u/ROI~+18.31%/MaxDD~-13.55u and P50_54 combined N=1225/terminal=824/unresolved=401/PnL~+144.65u/ROI~+17.55%/MaxDD~-12.65u. This canonical repaired-runner output is the authority per mission instruction; N is close but terminal/unresolved/PnL/MaxDD diverge. Unresolved by this mission (evidence-persistence-only) — flagged for Review A2.",
  };

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  writeFileSync(`${EVIDENCE_OUT_DIR}/FOOTBALL_VERIFICATION_DATA.json`, JSON.stringify(artifact, null, 2));

  const fmtBand = (label: string, b: FootballBand) =>
    `| ${label} | ${b.N} | ${b.TERMINAL_N} | ${b.UNRESOLVED_N} (${Object.entries(b.UNRESOLVED_BY_STATUS).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}) | ${round(b.REFERENCE_PNL_U, 2)}u | ${round(b.REFERENCE_ROI_PCT, 2)}% | ${round(b.MAX_DD_U, 2)}u |`;

  const md = `# Football Verification — Review A Repair V1

PNL_CLASS: \`REFERENCE_PNL\` (display price) — \`NOT_EXECUTION_AUTHORITY\`.
Unresolved rows mean final realised historical PnL is **not yet closed**.
\`PRICE_INDEPENDENT_ALPHA_PROVEN=NO\` (no execution-price evidence exists here — display-price reference only).

Frozen football denominator (canonical, combined Aug+Sep, unchanged by this note): **${FROZEN_FOOTBALL_DENOMINATOR_N}** physical events (modeling/evidence/football-denominator-reconciliation-v1).

Exact Score excluded before physical-event selection and cap: ${reconciled.exactScoreExcludedIdentities.size} candidates. EXACT_SCORE_SELECTED_N = **0**.

Football-only subset of the SAFE UNCAPPED price-band selection (reconciled fail-closed sport; denominator-style, no cap):

## P50_52_SAFE (football only)
| Period | N | Terminal | Unresolved (by status) | Reference PnL | Terminal ROI | MaxDD |
|---|---|---|---|---|---|---|
${fmtBand("Aug", P50_52_FOOTBALL.AUG)}
${fmtBand("Sep", P50_52_FOOTBALL.SEP)}
${fmtBand("Combined", P50_52_FOOTBALL.COMBINED)}

## P50_54_SAFE (football only)
| Period | N | Terminal | Unresolved (by status) | Reference PnL | Terminal ROI | MaxDD |
|---|---|---|---|---|---|---|
${fmtBand("Aug", P50_54_FOOTBALL.AUG)}
${fmtBand("Sep", P50_54_FOOTBALL.SEP)}
${fmtBand("Combined", P50_54_FOOTBALL.COMBINED)}

## Discrepancy vs. independent DB cross-check

An independent architect DB cross-check reported P50_52 combined N=1016, terminal=671, unresolved=345, reference PnL ~+122.89u, terminal ROI ~+18.31%, MaxDD ~-13.55u; P50_54 combined N=1225, terminal=824, unresolved=401, reference PnL ~+144.65u, terminal ROI ~+17.55%, MaxDD ~-12.65u. The canonical repaired-runner output above (P50_52 combined N=${P50_52_FOOTBALL.COMBINED.N}, terminal=${P50_52_FOOTBALL.COMBINED.TERMINAL_N}, unresolved=${P50_52_FOOTBALL.COMBINED.UNRESOLVED_N}; P50_54 combined N=${P50_54_FOOTBALL.COMBINED.N}, terminal=${P50_54_FOOTBALL.COMBINED.TERMINAL_N}, unresolved=${P50_54_FOOTBALL.COMBINED.UNRESOLVED_N}) is the authority for this note — N matches within 1-2 events but terminal/unresolved and PnL/MaxDD diverge (runner shows materially fewer terminal, more unresolved). This divergence is unexplained and unresolved by this mission (evidence persistence only, no new hypothesis search); it is flagged here for Review A2, not adjudicated.

Source: scripts/modeling/football-verification-review-a.ts (canonical repaired runner primitives, reused verbatim). Raw data: FOOTBALL_VERIFICATION_DATA.json.
`;
  writeFileSync(`${EVIDENCE_OUT_DIR}/FOOTBALL_VERIFICATION.md`, md);
  console.log(md);
  console.log(`Wrote ${EVIDENCE_OUT_DIR}/FOOTBALL_VERIFICATION.md and FOOTBALL_VERIFICATION_DATA.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
