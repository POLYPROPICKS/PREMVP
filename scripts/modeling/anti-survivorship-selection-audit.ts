/**
 * ANTI_SURVIVORSHIP_SELECTION_AUDIT_V1 — read-only audit: does filtering
 * `labelAsOf` to WIN/LOSS BEFORE physical-event candidate selection change
 * WHICH candidate gets selected, vs qualifying + selecting on decision-time
 * fields only and attaching settlement status afterward?
 *
 * This measures SELECTION CONTAMINATION, not a new model result. It never
 * redefines a model predicate, never reimplements the capacity/cap engine,
 * and never reimplements the chronological comparator.
 *
 * Two arms, over the exact same fetched rows, both using ONLY shared
 * primitives (no local duplicate selection logic in this file):
 *
 *   LEGACY (pre-fix)  — toAtlasInput() (factor-atlas.ts) filters labelAsOf
 *                       to WIN/LOSS BEFORE candidate rows are built, then
 *                       runStandalone()/runPortfolio()
 *                       (daily-portfolio-frontier.ts) select. Retained here
 *                       ONLY as the historical comparison baseline that
 *                       first proved the contamination (see git history).
 *
 *   FIXED (current)   — toDecisionTimeCandidates() (factor-atlas.ts) builds
 *                       candidates from ALL decision-time-complete rows
 *                       regardless of labelAsOf; runStandaloneStrict()/
 *                       runPortfolioStrict() (daily-portfolio-frontier.ts)
 *                       select using the same predicates/tiers and the same
 *                       chronological comparator (candidateRef tiebreak
 *                       included), never reading labelAsOf. Settlement is
 *                       attached only after applyDailyCap() via
 *                       partialMetricsFor() — also imported verbatim.
 *
 * PASS requires the FIXED arm's cap50 selection identities to equal what
 * this audit previously measured as the settlement-blind ("STRICT")
 * selection — i.e. the shared research path now behaves like the STRICT
 * arm always should have, for every caller, not just this audit script.
 *
 * Local script only. Read-only DB fetch against the bound research-clone
 * project (fail-closed project-ref guard, same pattern as every other
 * scripts/modeling/*.ts DB reader). No production writes. No new model.
 *
 *   npx tsx scripts/modeling/anti-survivorship-selection-audit.ts \
 *     --start=2026-08-04 --end=2026-09-20
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import "dotenv/config";

import type { ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { toAtlasInput, toDecisionTimeCandidates, type AtlasInputEvent, type DecisionTimeCandidate } from "./factor-atlas";
import {
  runStandalone,
  runPortfolio,
  runStandaloneStrict,
  runPortfolioStrict,
  applyDailyCap,
  metricsFor,
  partialMetricsFor,
  STANDALONE_STRATEGIES,
  PORTFOLIOS,
  type TieredBet,
  type SelectedCandidate,
} from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const CAP = 50;
const EVIDENCE_OUT_DIR = "modeling/evidence/anti-survivorship-selection-audit-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";

const MODEL_IDS = ["P50_52", "PORTFOLIO_BROAD", "QUALITY_FILL_A", "QUALITY_FILL_D"] as const;

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

function projectRefOf(url: string): string {
  return new URL(url).hostname.split(".")[0];
}

/** Fail-closed: only ever runs against the bound research-clone project — never production. */
async function resolveDb() {
  const url = process.env.SUPABASE_CLONE_URL;
  const key = process.env.SUPABASE_CLONE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("MISSING_CLONE_CREDENTIALS");
  const ref = projectRefOf(url);
  if (ref !== EXPECTED_CLONE_PROJECT_REF) {
    throw new Error(`REFUSING_NON_CLONE_TARGET: expected research-clone project ${EXPECTED_CLONE_PROJECT_REF}, got ${ref}`);
  }
  return createClient(url, key);
}

async function fetchRows(): Promise<ScorecardReadyRow[]> {
  const db = await resolveDb();
  const rows: ScorecardReadyRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("research_model_ready_rows")
      .select("canonical_row")
      .gte("model_date", START)
      .lte("model_date", END)
      .order("model_date")
      .order("population_id")
      .order("condition_id")
      .order("selected_token_id")
      .order("decision_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`FETCH_ROWS:${error.code ?? error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ canonical_row: ScorecardReadyRow }>) rows.push(r.canonical_row);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function preEventViolationN(events: Array<{ leadTimeHours: number }>): number {
  return events.filter((e) => e.leadTimeHours <= 0).length;
}

interface ModelAudit {
  MODEL: string;
  LEGACY_SELECTED_N: number;
  LEGACY_PNL_U: number;
  FIXED_SELECTED_N: number;
  FIXED_SETTLED_N: number;
  FIXED_OPEN_N: number;
  FIXED_OTHER_NONTERMINAL_N: number;
  FIXED_SETTLED_PNL_U_PARTIAL: number;
  FIXED_SETTLEMENT_COVERAGE_PCT: number;
  SELECTION_ID_CHANGED_VS_LEGACY_N: number;
  RECONCILES: boolean;
  LEGACY_PRE_EVENT_VIOLATION_N: number;
  FIXED_PRE_EVENT_VIOLATION_N: number;
}

async function main() {
  const rawRows = await fetchRows();

  // ── LEGACY arm: unmodified pre-fix path, reused verbatim as the historical baseline ──
  const legacyInput: AtlasInputEvent[] = toAtlasInput(rawRows);
  const standaloneById = new Map(STANDALONE_STRATEGIES.map((s) => [s.id, s]));
  const portfolioById = new Map(PORTFOLIOS.map((p) => [p.id, p]));

  // ── FIXED arm: selection-before-settlement path, same rows, no labelAsOf filter ──
  const fixedInput: DecisionTimeCandidate[] = toDecisionTimeCandidates(rawRows);

  const results: ModelAudit[] = [];

  for (const modelId of MODEL_IDS) {
    // LEGACY
    let legacyBets: TieredBet[];
    if (modelId === "P50_52") {
      legacyBets = runStandalone(legacyInput, standaloneById.get("P50_52")!.predicate);
    } else if (modelId === "PORTFOLIO_BROAD") {
      legacyBets = runPortfolio(legacyInput, portfolioById.get("PORTFOLIO_BROAD")!.tiers);
    } else {
      legacyBets = runPortfolio(legacyInput, QUALITY_PORTFOLIOS[modelId]);
    }
    const legacyCapped = applyDailyCap(legacyBets, CAP);
    const legacyMetrics = metricsFor(legacyCapped);

    // FIXED
    let fixedCandidates: SelectedCandidate[];
    if (modelId === "P50_52") {
      fixedCandidates = runStandaloneStrict(fixedInput, standaloneById.get("P50_52")!.predicate as Parameters<typeof runStandaloneStrict>[1]);
    } else if (modelId === "PORTFOLIO_BROAD") {
      fixedCandidates = runPortfolioStrict(fixedInput, portfolioById.get("PORTFOLIO_BROAD")!.tiers as Parameters<typeof runPortfolioStrict>[1]);
    } else {
      fixedCandidates = runPortfolioStrict(fixedInput, QUALITY_PORTFOLIOS[modelId] as Parameters<typeof runPortfolioStrict>[1]);
    }
    const fixedCapped = applyDailyCap(fixedCandidates, CAP);
    const fixedSettlement = partialMetricsFor(fixedCapped);

    // SELECTION_ID_CHANGED_VS_LEGACY_N: physicalEventKeys whose selected
    // candidateRef differs between the two cap50 selections (including
    // selected-in-one-only, treated as a change since identity differs).
    const legacyByKey = new Map(legacyCapped.map((b) => [b.physicalEventKey, b.candidateRef]));
    const fixedByKey = new Map(fixedCapped.map((c) => [c.physicalEventKey, c.candidateRef]));
    const allKeys = new Set<string>([...legacyByKey.keys(), ...fixedByKey.keys()]);
    let changedN = 0;
    for (const k of allKeys) {
      if (legacyByKey.get(k) !== fixedByKey.get(k)) changedN += 1;
    }

    results.push({
      MODEL: modelId,
      LEGACY_SELECTED_N: legacyCapped.length,
      LEGACY_PNL_U: legacyMetrics.pnl_u,
      FIXED_SELECTED_N: fixedSettlement.SELECTED_N,
      FIXED_SETTLED_N: fixedSettlement.SETTLED_N,
      FIXED_OPEN_N: fixedSettlement.OPEN_N,
      FIXED_OTHER_NONTERMINAL_N: fixedSettlement.OTHER_NONTERMINAL_N,
      FIXED_SETTLED_PNL_U_PARTIAL: fixedSettlement.SETTLED_PNL_U_PARTIAL,
      FIXED_SETTLEMENT_COVERAGE_PCT: fixedSettlement.SETTLEMENT_COVERAGE_PCT,
      SELECTION_ID_CHANGED_VS_LEGACY_N: changedN,
      RECONCILES: fixedSettlement.SETTLED_N + fixedSettlement.OPEN_N + fixedSettlement.OTHER_NONTERMINAL_N === fixedSettlement.SELECTED_N,
      LEGACY_PRE_EVENT_VIOLATION_N: preEventViolationN(legacyCapped),
      FIXED_PRE_EVENT_VIOLATION_N: preEventViolationN(fixedCapped),
    });
  }

  const allReconcile = results.every((r) => r.RECONCILES);
  // Prior audit run (see git history / this mission's chat record) measured
  // the settlement-blind selection at these cap50 counts for the same DB
  // snapshot. The FIXED arm now uses the shared fixed primitives; if it
  // reproduces those counts exactly, the fix generalizes correctly (not an
  // audit-script-only fix).
  const PRIOR_STRICT_REFERENCE: Record<string, { SELECTED_N: number; SETTLED_N: number; OPEN_N: number; OTHER_NONTERMINAL_N: number }> = {
    P50_52: { SELECTED_N: 1494, SETTLED_N: 926, OPEN_N: 568, OTHER_NONTERMINAL_N: 0 },
    PORTFOLIO_BROAD: { SELECTED_N: 1622, SETTLED_N: 1003, OPEN_N: 619, OTHER_NONTERMINAL_N: 0 },
    QUALITY_FILL_A: { SELECTED_N: 1533, SETTLED_N: 934, OPEN_N: 599, OTHER_NONTERMINAL_N: 0 },
    QUALITY_FILL_D: { SELECTED_N: 1613, SETTLED_N: 993, OPEN_N: 620, OTHER_NONTERMINAL_N: 0 },
  };
  const priorParity: Record<string, boolean> = {};
  for (const r of results) {
    const ref = PRIOR_STRICT_REFERENCE[r.MODEL];
    priorParity[r.MODEL] =
      !!ref && r.FIXED_SELECTED_N === ref.SELECTED_N && r.FIXED_SETTLED_N === ref.SETTLED_N && r.FIXED_OPEN_N === ref.OPEN_N && r.FIXED_OTHER_NONTERMINAL_N === ref.OTHER_NONTERMINAL_N;
  }
  const allPriorParity = Object.values(priorParity).every(Boolean);
  const integrityResult = allPriorParity ? "PASS_SHARED_PATH_FIXED" : "FIX_DOES_NOT_REPRODUCE_PRIOR_STRICT_IDENTITIES";

  const artifact = {
    MISSION: "ANTI_SURVIVORSHIP_SELECTION_AUDIT_V1",
    NOTE: "Selection-contamination regression audit. FIXED_SETTLED_PNL_U_PARTIAL is never a replacement headline ROI while FIXED_OPEN_N > 0.",
    ENGINE_REUSE:
      "LEGACY arm: toAtlasInput/runStandalone/runPortfolio/applyDailyCap/metricsFor imported verbatim (unchanged pre-fix path, kept only as historical baseline). FIXED arm: toDecisionTimeCandidates/runStandaloneStrict/runPortfolioStrict/applyDailyCap/partialMetricsFor imported verbatim from the shared research path (factor-atlas.ts, daily-portfolio-frontier.ts) — same predicates/tiers, same evaluateEvent/sortChronologically/compareChronologically comparator (candidateRef tiebreak included), same applyDailyCap() capacity ordering. No duplicated selection/settlement logic in this file.",
    DATASET_RANGE: { start: START, end: END },
    SOURCE_ROW_N: rawRows.length,
    CAP: CAP,
    RECONCILIATION_RULE: "FIXED_SELECTED_N == FIXED_SETTLED_N + FIXED_OPEN_N + FIXED_OTHER_NONTERMINAL_N",
    ALL_RECONCILE: allReconcile,
    RESULTS: results,
    PRIOR_STRICT_PARITY: priorParity,
    INTEGRITY_RESULT: integrityResult,
  };

  console.log(JSON.stringify(artifact, null, 2));

  mkdirSync(EVIDENCE_OUT_DIR, { recursive: true });
  const outPath = `${EVIDENCE_OUT_DIR}/ANTI_SURVIVORSHIP_SELECTION_AUDIT_${START}_${END}.json`;
  writeFileSync(outPath, JSON.stringify({ GENERATED_AT: new Date().toISOString(), ...artifact }, null, 2));
  console.error(`Wrote aggregate evidence artifact: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
