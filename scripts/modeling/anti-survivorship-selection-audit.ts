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
 * Two arms, over the exact same fetched rows:
 *
 *   CURRENT  — reuses toAtlasInput() (scripts/modeling/factor-atlas.ts)
 *              verbatim: labelAsOf filtered to WIN/LOSS BEFORE candidate
 *              rows are built, then runStandalone()/runPortfolio()
 *              (scripts/modeling/daily-portfolio-frontier.ts) select.
 *
 *   STRICT   — same qualification predicate, same chronological comparator
 *              (sortChronologically/compareChronologically, including the
 *              candidateRef tiebreak), same claimed-key/tier selection loop,
 *              but candidate rows are built from ALL decision-time-complete
 *              rows regardless of labelAsOf. Settlement status (labelAsOf)
 *              is read only AFTER a candidate has been selected, never used
 *              to qualify or order candidates.
 *
 * Both arms cap at 50/day through the exact same applyDailyCap() (imported
 * verbatim) — capacity ordering there is already feature/outcome-neutral
 * (tier, decisionTimestamp, physicalEventKey only), so reusing it on the
 * STRICT arm's pre-settlement candidates changes nothing about that
 * invariant; it only proves it also holds when settlement isn't known yet.
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

import type { CorpusLabel, ScorecardReadyRow } from "@/lib/modeling/research-corpus/rollingCorpus";
import { resolveSportFamily } from "@/lib/research-clone/modelReady";
import { evaluateEvent, sortChronologically, settleBetU, type Outcome } from "@/lib/modeling/research-engine";
import { toAtlasInput, type AtlasInputEvent } from "./factor-atlas";
import {
  runStandalone,
  runPortfolio,
  applyDailyCap,
  metricsFor,
  STANDALONE_STRATEGIES,
  PORTFOLIOS,
  type TieredBet,
} from "./daily-portfolio-frontier";
import { QUALITY_PORTFOLIOS } from "./quality-fill-portfolio-test";

const DEFAULT_START = "2026-08-04";
const DEFAULT_END = "2026-09-20";
const PAGE = 1000;
const CAP = 50;
const EVIDENCE_OUT_DIR = "modeling/evidence/anti-survivorship-selection-audit-v1";
const EXPECTED_CLONE_PROJECT_REF = "nppznoujvnyjargjkmnv";
const MINSK_OFFSET_MS = 3 * 3600_000;

const MODEL_IDS = ["P50_52", "PORTFOLIO_BROAD", "QUALITY_FILL_A", "QUALITY_FILL_D"] as const;

function arg(name: string, fallback: string): string {
  const eq = process.argv.find((v) => v.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const START = arg("start", DEFAULT_START);
const END = arg("end", DEFAULT_END);

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

function minskDate(iso: string): string {
  return new Date(Date.parse(iso) + MINSK_OFFSET_MS).toISOString().slice(0, 10);
}

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

// ── STRICT candidate input: same decision-time qualification as
// toAtlasInput() (scripts/modeling/factor-atlas.ts:107-134) MINUS the
// labelAsOf WIN/LOSS filter. Nothing here reads settlement status. ──
interface StrictInputEvent {
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  entryPrice: number;
  sportFamily: string;
  ref: string;
  candidateRef: string;
  scoreLevel: number | null;
  labelAsOf: CorpusLabel;
}

function toStrictInput(rows: ScorecardReadyRow[]): StrictInputEvent[] {
  return rows
    .filter(
      (r) =>
        r.providerEventId &&
        r.eventStart &&
        r.entryPrice !== null &&
        r.entryPrice > 0 &&
        r.entryPrice < 1,
      // NOTE: deliberately no `labelAsOf === WIN/LOSS` filter here — that is
      // the whole point of the STRICT arm.
    )
    .map((r) => ({
      physicalEventKey: r.providerEventId!,
      decisionTimestamp: r.decisionAt,
      eventStart: r.eventStart!,
      entryPrice: r.entryPrice!,
      sportFamily: resolveSportFamily(r) ?? "",
      ref: r.conditionId,
      candidateRef: r.selectedTokenId,
      scoreLevel: typeof r.scoreLevel === "number" ? r.scoreLevel : null,
      labelAsOf: r.labelAsOf,
    }));
}

interface StrictEvaluatedEvent extends StrictInputEvent {
  leadTimeHours: number;
}

interface StrictSelectedCandidate {
  physicalEventKey: string;
  decisionTimestamp: string;
  eventStart: string;
  leadTimeHours: number;
  entryPrice: number;
  sportFamily: string;
  candidateRef: string;
  labelAsOf: CorpusLabel;
  tier: number;
  day: string;
}

/** Settlement classification read ONLY after selection — never used to qualify/order. */
function classify(labelAsOf: CorpusLabel): "SETTLED" | "OPEN" | "OTHER_NONTERMINAL" {
  if (labelAsOf === "WIN" || labelAsOf === "LOSS") return "SETTLED";
  if (labelAsOf === "OPEN") return "OPEN";
  return "OTHER_NONTERMINAL"; // VOID, NO_MATCH, AMBIGUOUS
}

/**
 * STRICT standalone selection: identical shape to runStandalone()
 * (scripts/modeling/daily-portfolio-frontier.ts:145-156) — same
 * sortChronologically()/compareChronologically() comparator (candidateRef
 * tiebreak included), same claimed-physicalEventKey-first-qualifying-row
 * loop, same predicate function reused verbatim. The only difference is the
 * candidate pool (all labelAsOf values, not just WIN/LOSS) and that no
 * outcome/pnlU is computed for non-WIN/LOSS candidates.
 */
function strictRunStandalone(input: StrictInputEvent[], predicate: (e: StrictEvaluatedEvent) => boolean): StrictSelectedCandidate[] {
  const evaluated = input.map((e) => evaluateEvent(e as unknown as Parameters<typeof evaluateEvent>[0]) as unknown as StrictEvaluatedEvent);
  const ordered = sortChronologically(evaluated as unknown as Parameters<typeof sortChronologically>[0]) as unknown as StrictEvaluatedEvent[];
  const claimed = new Set<string>();
  const out: StrictSelectedCandidate[] = [];
  for (const event of ordered) {
    if (claimed.has(event.physicalEventKey)) continue;
    if (!predicate(event)) continue;
    claimed.add(event.physicalEventKey);
    out.push({
      physicalEventKey: event.physicalEventKey,
      decisionTimestamp: event.decisionTimestamp,
      eventStart: event.eventStart,
      leadTimeHours: event.leadTimeHours,
      entryPrice: event.entryPrice,
      sportFamily: event.sportFamily,
      candidateRef: event.candidateRef,
      labelAsOf: event.labelAsOf,
      tier: 1,
      day: minskDate(event.decisionTimestamp),
    });
  }
  return out;
}

/** STRICT portfolio selection — identical shape to runPortfolio() (daily-portfolio-frontier.ts:165-186). */
function strictRunPortfolio(input: StrictInputEvent[], tiers: Array<(e: StrictEvaluatedEvent) => boolean>): StrictSelectedCandidate[] {
  const evaluated = input.map((e) => evaluateEvent(e as unknown as Parameters<typeof evaluateEvent>[0]) as unknown as StrictEvaluatedEvent);
  const grouped = new Map<string, StrictEvaluatedEvent[]>();
  for (const event of evaluated) {
    const list = grouped.get(event.physicalEventKey);
    if (list) list.push(event);
    else grouped.set(event.physicalEventKey, [event]);
  }
  const out: StrictSelectedCandidate[] = [];
  for (const group of grouped.values()) {
    const sorted = sortChronologically(group as unknown as Parameters<typeof sortChronologically>[0]) as unknown as StrictEvaluatedEvent[];
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const winner = sorted.find(tiers[tierIndex]);
      if (winner) {
        out.push({
          physicalEventKey: winner.physicalEventKey,
          decisionTimestamp: winner.decisionTimestamp,
          eventStart: winner.eventStart,
          leadTimeHours: winner.leadTimeHours,
          entryPrice: winner.entryPrice,
          sportFamily: winner.sportFamily,
          candidateRef: winner.candidateRef,
          labelAsOf: winner.labelAsOf,
          tier: tierIndex + 1,
          day: minskDate(winner.decisionTimestamp),
        });
        break;
      }
    }
  }
  return out;
}

/** Cap STRICT candidates at 50/day through the exact same applyDailyCap() used by the CURRENT arm. */
function capStrict(candidates: StrictSelectedCandidate[], cap: number): StrictSelectedCandidate[] {
  const asTiered = candidates.map(
    (c) =>
      ({
        physicalEventKey: c.physicalEventKey,
        decisionTimestamp: c.decisionTimestamp,
        eventStart: c.eventStart,
        leadTimeHours: c.leadTimeHours,
        entryPrice: c.entryPrice,
        sportFamily: c.sportFamily,
        outcome: "LOSS" as Outcome, // placeholder: applyDailyCap's ordering never reads outcome/pnl
        pnlU: 0,
        candidateRef: c.candidateRef,
        tier: c.tier,
        day: c.day,
      }) as TieredBet,
  );
  const capped = applyDailyCap(asTiered, cap);
  const byIdentity = new Map(candidates.map((c) => [`${c.physicalEventKey}::${c.candidateRef}`, c]));
  return capped.map((b) => byIdentity.get(`${b.physicalEventKey}::${b.candidateRef}`)!);
}

function preEventViolationN(events: Array<{ leadTimeHours: number }>): number {
  return events.filter((e) => e.leadTimeHours <= 0).length;
}

interface ModelAudit {
  MODEL: string;
  CURRENT_SELECTED_N: number;
  CURRENT_PNL_U: number;
  STRICT_SELECTED_N: number;
  STRICT_SETTLED_N: number;
  STRICT_OPEN_N: number;
  STRICT_OTHER_NONTERMINAL_N: number;
  STRICT_SETTLED_PNL_U: number;
  SELECTION_ID_CHANGED_N: number;
  RECONCILES: boolean;
  CURRENT_PRE_EVENT_VIOLATION_N: number;
  STRICT_PRE_EVENT_VIOLATION_N: number;
}

async function main() {
  const rawRows = await fetchRows();

  // ── CURRENT arm inputs/predicates: reused verbatim, unmodified ──
  const currentInput: AtlasInputEvent[] = toAtlasInput(rawRows);
  const standaloneById = new Map(STANDALONE_STRATEGIES.map((s) => [s.id, s]));
  const portfolioById = new Map(PORTFOLIOS.map((p) => [p.id, p]));

  // ── STRICT arm inputs: same rows, no labelAsOf filter ──
  const strictInput = toStrictInput(rawRows);

  const results: ModelAudit[] = [];

  for (const modelId of MODEL_IDS) {
    // CURRENT
    let currentBets: TieredBet[];
    if (modelId === "P50_52") {
      currentBets = runStandalone(currentInput, standaloneById.get("P50_52")!.predicate);
    } else if (modelId === "PORTFOLIO_BROAD") {
      currentBets = runPortfolio(currentInput, portfolioById.get("PORTFOLIO_BROAD")!.tiers);
    } else {
      currentBets = runPortfolio(currentInput, QUALITY_PORTFOLIOS[modelId]);
    }
    const currentCapped = applyDailyCap(currentBets, CAP);
    const currentMetrics = metricsFor(currentCapped);

    // STRICT
    let strictCandidates: StrictSelectedCandidate[];
    if (modelId === "P50_52") {
      const p = standaloneById.get("P50_52")!.predicate as unknown as (e: StrictEvaluatedEvent) => boolean;
      strictCandidates = strictRunStandalone(strictInput, p);
    } else if (modelId === "PORTFOLIO_BROAD") {
      const tiers = portfolioById.get("PORTFOLIO_BROAD")!.tiers as unknown as Array<(e: StrictEvaluatedEvent) => boolean>;
      strictCandidates = strictRunPortfolio(strictInput, tiers);
    } else {
      const tiers = QUALITY_PORTFOLIOS[modelId] as unknown as Array<(e: StrictEvaluatedEvent) => boolean>;
      strictCandidates = strictRunPortfolio(strictInput, tiers);
    }
    const strictCapped = capStrict(strictCandidates, CAP);

    let settledN = 0;
    let openN = 0;
    let otherN = 0;
    let settledPnl = 0;
    for (const c of strictCapped) {
      const bucket = classify(c.labelAsOf);
      if (bucket === "SETTLED") {
        settledN += 1;
        settledPnl += settleBetU(c.labelAsOf as Outcome, c.entryPrice);
      } else if (bucket === "OPEN") {
        openN += 1;
      } else {
        otherN += 1;
      }
    }

    // SELECTION_ID_CHANGED_N: physicalEventKeys whose selected candidateRef
    // differs between the two cap50 selections (including selected-in-one-
    // only-N, treated as a change since the underlying identity differs).
    const currentByKey = new Map(currentCapped.map((b) => [b.physicalEventKey, b.candidateRef]));
    const strictByKey = new Map(strictCapped.map((c) => [c.physicalEventKey, c.candidateRef]));
    const allKeys = new Set<string>([...currentByKey.keys(), ...strictByKey.keys()]);
    let changedN = 0;
    for (const k of allKeys) {
      if (currentByKey.get(k) !== strictByKey.get(k)) changedN += 1;
    }

    results.push({
      MODEL: modelId,
      CURRENT_SELECTED_N: currentCapped.length,
      CURRENT_PNL_U: currentMetrics.pnl_u,
      STRICT_SELECTED_N: strictCapped.length,
      STRICT_SETTLED_N: settledN,
      STRICT_OPEN_N: openN,
      STRICT_OTHER_NONTERMINAL_N: otherN,
      STRICT_SETTLED_PNL_U: round(settledPnl, 2),
      SELECTION_ID_CHANGED_N: changedN,
      RECONCILES: settledN + openN + otherN === strictCapped.length,
      CURRENT_PRE_EVENT_VIOLATION_N: preEventViolationN(currentCapped),
      STRICT_PRE_EVENT_VIOLATION_N: preEventViolationN(strictCapped),
    });
  }

  const allReconcile = results.every((r) => r.RECONCILES);
  const allChangedZero = results.every((r) => r.SELECTION_ID_CHANGED_N === 0);
  const integrityResult = allChangedZero ? "PASS_SELECTION_INDEPENDENT" : "SETTLEMENT_FILTER_AFFECTS_SELECTION";

  const artifact = {
    MISSION: "ANTI_SURVIVORSHIP_SELECTION_AUDIT_V1",
    NOTE: "Selection-contamination audit only. STRICT_SETTLED_PNL_U is never a replacement headline ROI while STRICT_OPEN_N > 0.",
    ENGINE_REUSE:
      "CURRENT arm: toAtlasInput/runStandalone/runPortfolio/applyDailyCap/metricsFor imported verbatim. STRICT arm: same predicates/tiers, same evaluateEvent/sortChronologically/compareChronologically comparator (candidateRef tiebreak included), same applyDailyCap() capacity ordering — no new capacity engine, no new model predicate.",
    DATASET_RANGE: { start: START, end: END },
    SOURCE_ROW_N: rawRows.length,
    CAP: CAP,
    RECONCILIATION_RULE: "STRICT_SELECTED_N == STRICT_SETTLED_N + STRICT_OPEN_N + STRICT_OTHER_NONTERMINAL_N",
    ALL_RECONCILE: allReconcile,
    RESULTS: results,
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
