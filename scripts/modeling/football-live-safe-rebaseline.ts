/**
 * FOOTBALL_LIVE_SAFE_REBASELINE_V1 — one honest live-safe rebaseline.
 *
 * Adds ONE new deterministic strategy (FOOTBALL_LIVE_MLTS_ODDS_175_200: B's
 * 1.75-2.00 odds band restricted to moneyline/totals/spreads BEFORE selection)
 * and composes it with the already-codified live-compatible fallback
 * FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200 (LIVE_B first, fallback fills
 * unclaimed physical events). Reuses registry selectors/settlement, the
 * portfolio composition helpers and the structural market-type authority.
 * No thresholds searched, no settlement/outcome input to priority. Old strategy
 * IDs, registry evidence and metrics are untouched.
 *
 * Read-only against the research clone. No DB writes.
 *
 *   npx tsx scripts/modeling/football-live-safe-rebaseline.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DATASET_ID,
  buildRunContext,
  buildSafeUniverseV2,
  calendarDaysInclusive,
  evaluateSelection,
  selectFootballMoneylineTotalsSpreadsOdds185200,
  selectFootballOrdinaryStructuredOdds175200,
  type CommonMetrics,
  type RunContext,
  type StrategyDef,
} from "./football-strategy-registry";
import { composePriority, overlapStats, periodDiagnostics, chronological } from "./football-core-portfolio-composition";
import { ODDS_BUCKETS, connectClone, displayOdds, inBucket, marketBucketOf, MARKET_BUCKET_IDS } from "./football-structural-authority";
import type { StructuralCandidate } from "./football-structural-authority";
import { RANGE_START, RANGE_END } from "./build-football-denominator-reconciliation-v2";
import { loadFrozenFootballDenominatorV2 } from "./load-frozen-football-denominator-v2";
import { fetchTennisIdentityLookup } from "./tennis-safe-comparable-leaderboard";
import { runStandaloneStrict, type SelectedCandidate } from "./daily-portfolio-frontier";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

export const OUT_DIR = "modeling/evidence/football-live-safe-rebaseline-v1";
export const LIVE_B_ID = "FOOTBALL_LIVE_MLTS_ODDS_175_200";
export const FALLBACK_ID = "FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200";
export const HISTORICAL_B_ID = "FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200";
export const LIVE_SAFE_PORTFOLIO_ID = "FOOTBALL_LIVE_MLTS_175_200_THEN_MLTS_185_200";

export const HISTORICAL_B_REFERENCE = { selected_n: 726, settled_n: 566, pnl_u: 135.21 } as const;

/** Live execution supports exactly these market types. */
export const LIVE_MARKET_TYPES: ReadonlySet<string> = new Set(["moneyline", "totals", "spreads"]);

const oneSeventyFive = ODDS_BUCKETS.find((b) => b.id === "1_75_2_00")!;

/** Canonical/fail-closed market type (marketBucketOf) + decimal odds [1.75, 2.00). No title/slug inference. */
export function isLiveMltsOdds175200(c: Pick<StructuralCandidate, "marketTypeRaw" | "entryPrice">): boolean {
  return LIVE_MARKET_TYPES.has(marketBucketOf(c.marketTypeRaw)) && inBucket(displayOdds(c.entryPrice), oneSeventyFive);
}

/** Equivalent entry-price form: p > 0.50 and p <= 4/7. */
export const isEntryPriceEquivalent = (p: number): boolean => p > 0.5 && p <= 4 / 7;

export function selectFootballLiveMltsOdds175200(ctx: RunContext): SelectedCandidate[] {
  return runStandaloneStrict(ctx.structural, (e) => isLiveMltsOdds175200(e as unknown as StructuralCandidate));
}

const SEL = "SELECTION_BEFORE_SETTLEMENT_V1: predicate (canonical market type in moneyline/totals/spreads AND decimal odds [1.75, 2.00)) over canonical soccer candidates (denominator v2) -> chronological -> first qualifying row claims the physicalEventKey (runStandaloneStrict); settlement joined after selection";

export const LIVE_B_STRATEGY: StrategyDef = {
  strategy_id: LIVE_B_ID,
  semantic_version: "1.0.0",
  plain_language_rule: "ставим только на победителя/тоталы/форы при коэффициенте 1.75–2.00",
  plain_language_rule_en: "Soccer moneyline/totals/spreads only (canonical market type), decimal odds 1.75-2.00 (0.50 < p <= 4/7). Live-executable subset of FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200.",
  sport: "soccer",
  market_scope: ["moneyline", "totals", "spreads"],
  price_min: 0.5, price_min_inclusive: false, price_max: Math.round((4 / 7) * 1e6) / 1e6, price_max_inclusive: true,
  decimal_odds_min: 1.75, decimal_odds_max: 2, decimal_odds_bounds: "[1.75, 2.00)",
  selector_semantics: SEL,
  one_physical_event_max: true,
  legacy_aliases: [],
  implementation_symbol: "selectFootballLiveMltsOdds175200",
  implementation_file: "scripts/modeling/football-live-safe-rebaseline.ts",
  source_provenance: ["scripts/modeling/football-strategy-registry.ts selectFootballOrdinaryStructuredOdds175200", "scripts/modeling/football-structural-authority.ts marketBucketOf"],
  legacy_reported_metrics: [],
  status: "CANDIDATE",
  executable: true,
};

// ── Analysis ────────────────────────────────────────────────────────────────

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

export const CLASS_IDS = ["MONEYLINE", "TOTALS", "SPREADS", "TOTAL_CORNERS", "OTHER_STRUCTURED"] as const;
export type ClassId = (typeof CLASS_IDS)[number];
const CLASS_OF: Record<string, ClassId | undefined> = {
  moneyline: "MONEYLINE", totals: "TOTALS", spreads: "SPREADS", total_corners: "TOTAL_CORNERS", other_structured: "OTHER_STRUCTURED",
};

export interface ClassRow { SELECTED_N: number; SETTLED_N: number; OPEN_N: number; WINS: number; PNL_U: number; ROI_PCT: number }

/** Historical-B selected membership by canonical market class (diagnostic only). */
export function marketComposition(
  selected: SelectedCandidate[],
  structural: StructuralCandidate[],
  settlement: Map<string, CorpusLabel>,
): Record<ClassId, ClassRow> {
  const byIdentity = new Map(structural.map((c) => [c.candidateIdentity, c] as const));
  const out = Object.fromEntries(CLASS_IDS.map((k) => [k, [] as SelectedCandidate[]])) as Record<ClassId, SelectedCandidate[]>;
  for (const s of selected) {
    const c = byIdentity.get(s.candidateIdentity);
    if (!c) throw new Error(`SELECTED_IDENTITY_NOT_IN_STRUCTURAL ${s.candidateIdentity}`);
    const cls = CLASS_OF[marketBucketOf(c.marketTypeRaw)];
    if (!cls) throw new Error(`NON_ORDINARY_CLASS_IN_SELECTION ${marketBucketOf(c.marketTypeRaw)}`);
    out[cls].push(s);
  }
  return Object.fromEntries(
    CLASS_IDS.map((k) => {
      const m = evaluateSelection(out[k], settlement, 1);
      return [k, { SELECTED_N: m.selected_n, SETTLED_N: m.settled_n, OPEN_N: m.open_n, WINS: m.wins, PNL_U: m.pnl_u, ROI_PCT: m.roi_pct }];
    }),
  ) as Record<ClassId, ClassRow>;
}

export interface ExcludedClassEvents {
  SELECTED_EVENT_N: number;
  SETTLED_N: number;
  WINNING_SELECTED_IDENTITY_N: number;
  LOSING_SELECTED_IDENTITY_N: number;
  OPEN_N: number;
  /** Of these historical-B events, how many are re-claimed by LIVE_B with a different (ML/T/S) identity. */
  RECLAIMED_BY_LIVE_B_DIFFERENT_IDENTITY_N: number;
  NOT_CLAIMED_BY_LIVE_B_N: number;
}

export function excludedClassEvents(
  histB: SelectedCandidate[],
  liveB: SelectedCandidate[],
  structural: StructuralCandidate[],
  settlement: Map<string, CorpusLabel>,
  cls: ClassId,
): ExcludedClassEvents {
  const byIdentity = new Map(structural.map((c) => [c.candidateIdentity, c] as const));
  const liveBy = new Map(liveB.map((x) => [x.physicalEventKey, x] as const));
  const r: ExcludedClassEvents = { SELECTED_EVENT_N: 0, SETTLED_N: 0, WINNING_SELECTED_IDENTITY_N: 0, LOSING_SELECTED_IDENTITY_N: 0, OPEN_N: 0, RECLAIMED_BY_LIVE_B_DIFFERENT_IDENTITY_N: 0, NOT_CLAIMED_BY_LIVE_B_N: 0 };
  for (const s of histB) {
    if (CLASS_OF[marketBucketOf(byIdentity.get(s.candidateIdentity)!.marketTypeRaw)] !== cls) continue;
    r.SELECTED_EVENT_N += 1;
    const label = settlement.get(s.candidateIdentity);
    if (label === "WIN") { r.WINNING_SELECTED_IDENTITY_N += 1; r.SETTLED_N += 1; }
    else if (label === "LOSS") { r.LOSING_SELECTED_IDENTITY_N += 1; r.SETTLED_N += 1; }
    else if (label === "OPEN") r.OPEN_N += 1;
    const lv = liveBy.get(s.physicalEventKey);
    if (lv) r.RECLAIMED_BY_LIVE_B_DIFFERENT_IDENTITY_N += 1;
    else r.NOT_CLAIMED_BY_LIVE_B_N += 1;
  }
  return r;
}

export interface Analysis {
  histB: CommonMetrics;
  histBComposition: Record<ClassId, ClassRow>;
  liveB: CommonMetrics;
  fallback: CommonMetrics;
  portfolio: CommonMetrics;
  overlap: ReturnType<typeof overlapStats>;
  fallbackIncremental: CommonMetrics;
  fallbackDropped_n: number;
  retention: { LIVE_B_PNL_U: number; DELTA_PNL_U: number; PNL_RETENTION_PCT: number; LIVE_B_SELECTED_N: number; SELECTED_RETENTION_PCT: number };
  excluded: { TOTAL_CORNERS: ExcludedClassEvents; OTHER_STRUCTURED: ExcludedClassEvents };
  periods: Record<string, Record<string, ReturnType<typeof periodDiagnostics>[string][string]>>;
  price_form_mismatch_n: number;
  selectedSets: { liveB: SelectedCandidate[]; portfolio: SelectedCandidate[] };
}

export function analyze(ctx: RunContext, days: number): Analysis {
  const histBsel = selectFootballOrdinaryStructuredOdds175200(ctx);
  const liveBsel = selectFootballLiveMltsOdds175200(ctx);
  const fbSel = selectFootballMoneylineTotalsSpreadsOdds185200(ctx);
  const ev = (rows: SelectedCandidate[]) => evaluateSelection(rows, ctx.settlement, days);
  const comp = composePriority(liveBsel, fbSel);
  const histB = ev(histBsel);
  const liveB = ev(liveBsel);
  const portfolio = ev(comp.portfolio);
  const ratio = (a: number, b: number) => round((100 * a) / b, 2);
  return {
    histB,
    histBComposition: marketComposition(histBsel, ctx.structural, ctx.settlement),
    liveB,
    fallback: ev(fbSel),
    portfolio,
    overlap: overlapStats(liveBsel, fbSel),
    fallbackIncremental: ev(comp.incremental),
    fallbackDropped_n: comp.dropped.length,
    retention: {
      LIVE_B_PNL_U: liveB.pnl_u,
      DELTA_PNL_U: round(liveB.pnl_u - histB.pnl_u, 2),
      PNL_RETENTION_PCT: ratio(liveB.pnl_u, histB.pnl_u),
      LIVE_B_SELECTED_N: liveB.selected_n,
      SELECTED_RETENTION_PCT: ratio(liveB.selected_n, histB.selected_n),
    },
    excluded: {
      TOTAL_CORNERS: excludedClassEvents(histBsel, liveBsel, ctx.structural, ctx.settlement, "TOTAL_CORNERS"),
      OTHER_STRUCTURED: excludedClassEvents(histBsel, liveBsel, ctx.structural, ctx.settlement, "OTHER_STRUCTURED"),
    },
    periods: periodDiagnostics({ LIVE_B: liveBsel, LIVE_SAFE_PORTFOLIO: comp.portfolio }, ctx.settlement),
    price_form_mismatch_n: ctx.structural.filter((c) => inBucket(displayOdds(c.entryPrice), oneSeventyFive) !== isEntryPriceEquivalent(c.entryPrice)).length,
    selectedSets: { liveB: chronological(liveBsel), portfolio: comp.portfolio },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const f2 = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

export function renderCeoMd(a: Analysis, days: number): string {
  const mrow = (name: string, m: CommonMetrics) =>
    `| ${name} | ${m.selected_n} | ${m.settled_n} | ${m.open_n} | ${m.wins} | ${m.losses} | ${f2(m.pnl_u)} | ${m.roi_pct.toFixed(2)} | ${m.max_dd_u.toFixed(2)} | ${m.bets_per_calendar_day.toFixed(2)} |`;
  const crow = (k: ClassId) => {
    const r = a.histBComposition[k];
    return `| ${k} | ${r.SELECTED_N} | ${r.SETTLED_N} | ${r.OPEN_N} | ${f2(r.PNL_U)} | ${r.ROI_PCT.toFixed(2)} |`;
  };
  const per = Object.entries(a.periods)
    .flatMap(([n, ps]) => Object.entries(ps).map(([p, m]) => `| ${n} | ${p} | ${m.SETTLED_N} | ${f2(m.PNL_U)} | ${m.ROI_PCT.toFixed(2)} | ${m.MAX_DD_U.toFixed(2)} |`))
    .join("\n");
  const ex = (k: "TOTAL_CORNERS" | "OTHER_STRUCTURED") => {
    const e = a.excluded[k];
    return `| ${k} | ${e.SELECTED_EVENT_N} | ${e.SETTLED_N} | ${e.WINNING_SELECTED_IDENTITY_N} | ${e.LOSING_SELECTED_IDENTITY_N} | ${e.OPEN_N} | ${e.RECLAIMED_BY_LIVE_B_DIFFERENT_IDENTITY_N} | ${e.NOT_CLAIMED_BY_LIVE_B_N} |`;
  };
  const o = a.overlap;
  const r = a.retention;
  return `# Football live-safe rebaseline (${DATASET_ID}, ${days} days)

Flat 1u. WIN = 1/entry_price - 1, LOSS = -1, OPEN = no PnL. One bet per physical event. Priority applied before settlement. Market class = canonical \`marketBucketOf\` (no title/slug inference). Historical B and the research portfolio B_THEN_A remain RESEARCH authority and are not overwritten.

## Historical B market composition (${HISTORICAL_B_ID}; diagnostic)
| Class | Selected | Settled | Open | PnL u | ROI % |
|---|---|---|---|---|---|
${CLASS_IDS.map(crow).join("\n")}

Total selected ${a.histB.selected_n}, PnL ${f2(a.histB.pnl_u)}u. (The 118 total-corners figure belongs to FOOTBALL_TOTAL_CORNERS_ODDS_225_250 at odds 2.25-2.50, not to B.)

## Strategies
| Strategy | Selected | Settled | Open | Wins | Losses | PnL u | ROI % | MaxDD u | Bets/day |
|---|---|---|---|---|---|---|---|---|---|
${mrow("HISTORICAL_B (research)", a.histB)}
${mrow(LIVE_B_ID, a.liveB)}
${mrow(FALLBACK_ID, a.fallback)}
${mrow(LIVE_SAFE_PORTFOLIO_ID, a.portfolio)}

## Overlap and fallback increment
LIVE_B ${o.CORE_A_SELECTED_N} / fallback ${o.CORE_B_SELECTED_N}; OVERLAP_PHYSICAL_EVENT_N ${o.OVERLAP_PHYSICAL_EVENT_N} (SAME_IDENTITY_N ${o.SAME_SELECTED_IDENTITY_N}, DIFFERENT_IDENTITY_N ${o.DIFFERENT_SELECTED_IDENTITY_N}); fallback dropped ${a.fallbackDropped_n}.
FALLBACK_INCREMENTAL: selected ${a.fallbackIncremental.selected_n}, settled ${a.fallbackIncremental.settled_n}, open ${a.fallbackIncremental.open_n}, PnL ${f2(a.fallbackIncremental.pnl_u)}u.

## Value loss / retention (LIVE_B vs historical B)
HISTORICAL_B_PNL_U ${HISTORICAL_B_REFERENCE.pnl_u}; LIVE_B_PNL_U ${f2(r.LIVE_B_PNL_U)}; DELTA_PNL_U ${f2(r.DELTA_PNL_U)}; PNL_RETENTION_PCT ${r.PNL_RETENTION_PCT}.
HISTORICAL_B_SELECTED_N ${HISTORICAL_B_REFERENCE.selected_n}; LIVE_B_SELECTED_N ${r.LIVE_B_SELECTED_N}; SELECTED_RETENTION_PCT ${r.SELECTED_RETENTION_PCT}.

Historical-B events whose selected identity was in a non-live class:
| Class | Events | Settled | Winning identities | Losing identities | Open | Re-claimed by LIVE_B (other identity) | Not claimed by LIVE_B |
|---|---|---|---|---|---|---|---|
${ex("TOTAL_CORNERS")}
${ex("OTHER_STRUCTURED")}

## Period diagnostics (fixed strategies, no optimization)
| Set | Period | Settled | PnL u | ROI % | MaxDD u |
|---|---|---|---|---|---|
${per}

Predicate parity: decimal-odds form vs (0.50 < p <= 4/7) mismatches on the structural corpus: ${a.price_form_mismatch_n}.
`;
}

async function main() {
  const db = await connectClone();
  const frozen = await loadFrozenFootballDenominatorV2(db);
  const preliminary = buildSafeUniverseV2(frozen.sourceRows, frozen.overlay, () => null);
  const identityLookup = await fetchTennisIdentityLookup(db, preliminary.tennisConditionIds);
  const ctx = buildRunContext(frozen.sourceRows, frozen.overlay, identityLookup);
  const days = calendarDaysInclusive(RANGE_START, RANGE_END);
  const a = analyze(ctx, days);

  const b = a.histB;
  const f = a.fallback;
  const okB = b.selected_n === 726 && b.settled_n === 566 && b.pnl_u === 135.21 && b.max_dd_u === -8.65;
  const okF = f.selected_n === 514 && f.settled_n === 438 && f.open_n === 76 && f.pnl_u === 117.05 && f.max_dd_u === -10.46;
  const sanity = { HISTORICAL_B_REPRODUCED: okB, FALLBACK_REPRODUCED: okF, PRICE_FORM_EQUIVALENT: a.price_form_mismatch_n === 0, PHYSICAL_EVENTS_CANONICAL: 5030 };
  if (!okB || !okF) throw new Error(`REPRODUCTION_FAILED ${JSON.stringify({ b, f })}`);

  const { selectedSets: _omit, ...evidence } = a;
  void _omit;
  const json = JSON.stringify({
    MISSION: "FOOTBALL_LIVE_SAFE_REBASELINE_V1", DATASET_ID, RANGE: `${RANGE_START}..${RANGE_END}`, CALENDAR_DAYS: days,
    STRATEGY: LIVE_B_STRATEGY, PORTFOLIO_ID: LIVE_SAFE_PORTFOLIO_ID, FALLBACK_ID, SANITY: sanity, ...evidence,
    MARKET_BUCKETS: MARKET_BUCKET_IDS, DB_WRITES: 0, PRODUCTION_WRITES: 0,
  }, null, 2) + "\n";
  const md = renderCeoMd(a, days);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "LIVE_SAFE_REBASELINE.json"), json);
  writeFileSync(join(OUT_DIR, "CEO_LIVE_SAFE_REBASELINE.md"), md);
  writeFileSync(join(OUT_DIR, "SHA256SUMS.txt"), `${sha256(md)}  CEO_LIVE_SAFE_REBASELINE.md\n${sha256(json)}  LIVE_SAFE_REBASELINE.json\n`);
  console.log(JSON.stringify({ STATUS: "SUCCESS", SANITY: sanity, LIVE_B: a.liveB, PORTFOLIO: a.portfolio, DB_WRITES: 0 }));
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
