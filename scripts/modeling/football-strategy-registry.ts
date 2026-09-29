/**
 * FOOTBALL_STRATEGY_REGISTRY_V1 — every approved football strategy encoded as
 * a stable, deterministic business function, evaluated on ONE common corpus
 * (frozen football denominator v2, 2026-08-04..2026-09-24) with ONE uniform
 * settlement attachment. Historical figures are preserved separately as
 * LEGACY_REPORTED_METRICS and never replace COMMON_CORPUS_METRICS.
 *
 * Reuses, by import, without changing any economics/selection rule:
 *   - frozen denominator v2 overlay loader (SHA-verified)
 *   - buildStructuralCandidates / isOrdinaryHold / marketBucketOf / inBucket /
 *     displayOdds / ODDS_BUCKETS (football-structural-authority)
 *   - runStandaloneStrict / settledBetsOnly / metricsFor (daily-portfolio-frontier):
 *     predicate BEFORE settlement, chronological order, one physicalEventKey
 *     -> at most one bet, OPEN never a loss, flat 1u
 *   - SAFE contract (tennis-safe-comparable-leaderboard): applyReconciledAuthority,
 *     buildSafeUniverse, fetchTennisIdentityLookup, buildReconciledClassificationMap
 *
 * Read-only against the research clone. No DB writes.
 *
 *   npx tsx scripts/modeling/football-strategy-registry.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RANGE_START, RANGE_END } from "./build-football-denominator-reconciliation-v2";
import type { OverlayRecord, SourceRow } from "./build-football-denominator-reconciliation";
import {
  FROZEN_OVERLAY_COMPRESSED_SHA256,
  FROZEN_OVERLAY_CONTENT_SHA256,
  FROZEN_OVERLAY_ROW_N,
  loadFrozenFootballDenominatorV2,
} from "./load-frozen-football-denominator-v2";
import {
  ODDS_BUCKETS,
  buildStructuralCandidates,
  connectClone,
  displayOdds,
  inBucket,
  isOrdinaryHold,
  marketBucketOf,
  type StructuralCandidate,
} from "./football-structural-authority";
import { runStandaloneStrict, settledBetsOnly, metricsFor, type SelectedCandidate } from "./daily-portfolio-frontier";
import {
  applyReconciledAuthority,
  buildReconciledClassificationMap,
  buildSafeUniverse,
  fetchTennisIdentityLookup,
  type IdentityLookup,
} from "./tennis-safe-comparable-leaderboard";
import type { DecisionTimeCandidate } from "./factor-atlas";
import type { CorpusLabel } from "@/lib/modeling/research-corpus/rollingCorpus";

export const OUT_DIR = "modeling/evidence/football-strategy-registry-v1";
export const REGISTRY_VERSION = "1.0.0";
export const DATASET_ID = `FOOTBALL_DENOMINATOR_V2_${RANGE_START}_${RANGE_END}`;
export const SCRIPT_PATH = "scripts/modeling/football-strategy-registry.ts";
export const LEGACY_SAFE_WINDOW_END = "2026-09-20";
const DENOMINATOR_DIR = "modeling/evidence/football-denominator-reconciliation-v2";
const DENOMINATOR_SOURCE_COMMIT = "0ff47c9c9d486c78af27cec1224c79d4cdb0f441";

// ── Frozen economics (single source: BETTING_ECONOMICS_CONTRACT_V2) ─────────

/** decimal_odds = 1 / entry_price */
export const decimalOdds = (entryPrice: number): number => 1 / entryPrice;
/** Flat 1u stake. WIN = 1/p - 1, LOSS = -1. Nonterminal has NO settled PnL. */
export const settledPnlU = (outcome: "WIN" | "LOSS", entryPrice: number): number =>
  outcome === "WIN" ? 1 / entryPrice - 1 : -1;
/** ROI over SETTLED_N (= WINS + LOSSES) because every settled bet stakes 1u. */
export const roiPct = (pnlU: number, settledN: number): number => (settledN === 0 ? 0 : (100 * pnlU) / settledN);

const round = (v: number, dp: number): number => {
  const f = 10 ** dp;
  const r = Math.round((v + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

// ── Run context ─────────────────────────────────────────────────────────────

export interface SafeCandidate extends DecisionTimeCandidate {
  modelDate: string;
}

export interface RunContext {
  /** Canonical soccer candidates (frozen denominator v2), football-first. */
  structural: StructuralCandidate[];
  /** All-sport SAFE universe (reconciled authority + safe tennis gate applied). */
  safeUniverse: SafeCandidate[];
  /** ONE common settlement authority: research_model_ready_rows.settlement_label by exact identity. */
  settlement: Map<string, CorpusLabel>;
}

const EMPTY_SERIES = {
  observationCount: 0,
  firstEligibleValue: null,
  firstEligibleObservedAt: null,
  lastEligibleValue: null,
  lastEligibleObservedAt: null,
  delta: null,
};

function identityOf(row: { condition_id: string; selected_token_id: string; decision_at: string }): string {
  return `${row.condition_id}::${row.selected_token_id}::${row.decision_at}`;
}

/** Common settlement authority. Every strategy joins this same map. */
export function buildCommonSettlement(sourceRows: SourceRow[]): Map<string, CorpusLabel> {
  const valid = new Set(["WIN", "LOSS", "OPEN", "VOID", "NO_MATCH", "AMBIGUOUS"]);
  const map = new Map<string, CorpusLabel>();
  for (const row of sourceRows) {
    if (row.settlement_label === null || !valid.has(row.settlement_label)) continue;
    map.set(identityOf(row), row.settlement_label as CorpusLabel);
  }
  return map;
}

/** Decision-time all-sport candidates (mirrors toDecisionTimeCandidate filters) from the frozen source rows. */
export function buildAllSportCandidates(sourceRows: SourceRow[]): SafeCandidate[] {
  const out: SafeCandidate[] = [];
  for (const row of sourceRows) {
    const cr = row.canonical_row as Record<string, unknown>;
    const eventStart = typeof cr.eventStart === "string" ? cr.eventStart : null;
    const p = row.entry_price_num;
    if (!row.provider_event_id || !eventStart || p === null || !(p > 0 && p < 1)) continue;
    out.push({
      physicalEventKey: row.provider_event_id,
      decisionTimestamp: row.decision_at,
      eventStart,
      entryPrice: p,
      sportFamily: typeof cr.sportFamily === "string" ? cr.sportFamily : "",
      ref: row.condition_id,
      candidateRef: row.selected_token_id,
      scoreLevel: typeof cr.scoreLevel === "number" ? cr.scoreLevel : null,
      score: EMPTY_SERIES,
      selectedPrice: EMPTY_SERIES,
      volumeUsd: typeof cr.volumeUsd === "number" ? cr.volumeUsd : null,
      rowLeadTimeHours: typeof cr.leadTimeHours === "number" ? cr.leadTimeHours : null,
      marketTypeRaw: typeof cr.marketTypeRaw === "string" ? cr.marketTypeRaw : null,
      candidateIdentity: identityOf(row),
      modelDate: row.model_date,
    });
  }
  return out;
}

/** SAFE contract on the v2 canonical classification: reconciled authority -> exact-score exclusion -> safe-tennis gate. */
export function buildSafeUniverseV2(
  sourceRows: SourceRow[],
  overlay: OverlayRecord[],
  identityLookup: IdentityLookup,
): { safeUniverse: SafeCandidate[]; tennisConditionIds: string[] } {
  const all = buildAllSportCandidates(sourceRows);
  const classification = buildReconciledClassificationMap(overlay);
  const reconciled = applyReconciledAuthority(all, classification);
  const tennisConditionIds = reconciled.eligible.filter((e) => e.sportFamily === "tennis").map((e) => e.ref).filter((v): v is string => !!v);
  const modelDateByIdentity = new Map(all.map((c) => [c.candidateIdentity, c.modelDate] as const));
  const { safeUniverse } = buildSafeUniverse(reconciled.eligible, identityLookup);
  return {
    safeUniverse: safeUniverse.map((c) => ({ ...c, modelDate: modelDateByIdentity.get(c.candidateIdentity)! })),
    tennisConditionIds,
  };
}

export function buildRunContext(sourceRows: SourceRow[], overlay: OverlayRecord[], identityLookup: IdentityLookup): RunContext {
  const { candidates } = buildStructuralCandidates(sourceRows, overlay);
  return {
    structural: candidates,
    safeUniverse: buildSafeUniverseV2(sourceRows, overlay, identityLookup).safeUniverse,
    settlement: buildCommonSettlement(sourceRows),
  };
}

// ── Strategy predicates and implementations (deterministic business functions) ──

const ML_TOTALS_SPREADS = new Set(["moneyline", "totals", "spreads"]);
const oddsBucket = (id: string) => ODDS_BUCKETS.find((b) => b.id === id)!;

type Pred = (c: StructuralCandidate) => boolean;
const selectStructural = (ctx: RunContext, pred: Pred): SelectedCandidate[] =>
  runStandaloneStrict(ctx.structural, (e) => pred(e as unknown as StructuralCandidate));
/** All-sport SAFE selection happens BEFORE the football subset is taken. */
const selectSafeThenFootball = (ctx: RunContext, hi: number, universe: SafeCandidate[] = ctx.safeUniverse): SelectedCandidate[] =>
  runStandaloneStrict(universe, (e) => e.entryPrice >= 0.5 && e.entryPrice < hi).filter((b) => b.sportFamily === "soccer");

export const inEntryBand = (p: number, lo: number, hi: number): boolean => p >= lo && p < hi;

export function selectFootballOdds192200RepairedSafe(ctx: RunContext, universe?: SafeCandidate[]): SelectedCandidate[] {
  return selectSafeThenFootball(ctx, 0.52, universe);
}
export function selectFootballOdds185200Repaired(ctx: RunContext, universe?: SafeCandidate[]): SelectedCandidate[] {
  return selectSafeThenFootball(ctx, 0.54, universe);
}
export function selectFootballOrdinaryStructuredOdds175200(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => isOrdinaryHold(c.marketTypeRaw) && inBucket(displayOdds(c.entryPrice), oddsBucket("1_75_2_00")));
}
export function selectFootballMoneylineTotalsSpreadsOdds185200(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => inEntryBand(c.entryPrice, 0.5, 0.54) && ML_TOTALS_SPREADS.has(marketBucketOf(c.marketTypeRaw)));
}
export function selectFootballOdds192200PriceBand(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => isOrdinaryHold(c.marketTypeRaw) && inEntryBand(c.entryPrice, 0.5, 0.52));
}
export function selectFootballOdds185200PriceBand(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => isOrdinaryHold(c.marketTypeRaw) && inEntryBand(c.entryPrice, 0.5, 0.54));
}
export function selectFootballOrdinaryStructuredNoOddsFilter(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => isOrdinaryHold(c.marketTypeRaw));
}
export function selectFootballTotalCornersOdds225250(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => isOrdinaryHold(c.marketTypeRaw) && inBucket(displayOdds(c.entryPrice), oddsBucket("2_25_2_50")) && marketBucketOf(c.marketTypeRaw) === "total_corners");
}
export function selectFootballSpreadsOdds185200AuditRequired(ctx: RunContext): SelectedCandidate[] {
  return selectStructural(ctx, (c) => inEntryBand(c.entryPrice, 0.5, 0.54) && marketBucketOf(c.marketTypeRaw) === "spreads");
}

// ── Registry ────────────────────────────────────────────────────────────────

export type StrategyStatus = "CANDIDATE" | "BASELINE" | "SLEEVE_CANDIDATE" | "AUDIT_REQUIRED_NOT_LIVE_AUTHORITY";

export interface LegacyMetric {
  label: string;
  selected: number;
  settled: number;
  open: number;
  pnl_u: number;
  roi_pct: number;
  max_dd_u: number | null;
  date_from: string;
  date_to: string;
  source_path: string;
  source_commit: string;
  formula_version: string;
  note?: string;
}

export interface StrategyDef {
  strategy_id: string;
  semantic_version: string;
  plain_language_rule: string;
  plain_language_rule_en: string;
  sport: "soccer";
  market_scope: string[];
  price_min: number;
  price_min_inclusive: boolean;
  price_max: number;
  price_max_inclusive: boolean;
  decimal_odds_min: number;
  decimal_odds_max: number;
  decimal_odds_bounds: string;
  selector_semantics: string;
  one_physical_event_max: true;
  legacy_aliases: string[];
  implementation_symbol: string;
  implementation_file: string;
  source_provenance: string[];
  legacy_reported_metrics: LegacyMetric[];
  status: StrategyStatus;
  executable: true;
}

const FORMULA_V = "BETTING_ECONOMICS_CONTRACT_V2/flat-1u/SELECTION_BEFORE_SETTLEMENT_V1";
const SEL_FOOTBALL_FIRST = "SELECTION_BEFORE_SETTLEMENT_V1: predicate over canonical soccer candidates (denominator v2) -> chronological -> first qualifying row claims the physicalEventKey (runStandaloneStrict); settlement joined after selection";
const SEL_SAFE = "SELECTION_BEFORE_SETTLEMENT_V1 on the ALL-SPORT SAFE universe (v2 reconciled authority, exact-score excluded, safe-tennis gate) -> runStandaloneStrict -> THEN football subset; settlement joined after selection";
const AUTH_STRUCT = "modeling/evidence/football-structural-authority-v2/FOOTBALL_STRUCTURAL_AUTHORITY_2026-08-04_2026-09-24.json";
const AUTH_AUDIT = "modeling/evidence/p5052-p5054-c1-restored-lineage-audit-v2/AUDIT_REPORT.json";
const AUTH_VERIF = "modeling/evidence/safe-authority-review-a-repair-v1/FOOTBALL_VERIFICATION.md";
const AUTH_BACKFILL = "modeling/evidence/safe-authority-review-a-repair-v1/POLYMARKET_RESOLUTION_BACKFILL_299.md";
const C_STRUCT = "f2a9e3fe9b38881102b97f546814662f8c9b0a01";
const C_AUDIT = "992348be4818f0214c677fed1637b51b504da40e";
const C_SAFE = "ebe3383c505ffe33c0ef3de1375131a37c2b0e11";

const legacyCommon = (label: string, source_path: string, source_commit: string, m: { selected: number; settled: number; open: number; pnl_u: number; roi_pct: number; max_dd_u: number }, note?: string): LegacyMetric => ({
  label, ...m, date_from: RANGE_START, date_to: RANGE_END, source_path, source_commit, formula_version: FORMULA_V, ...(note ? { note } : {}),
});

const common = { sport: "soccer" as const, one_physical_event_max: true as const, implementation_file: SCRIPT_PATH, executable: true as const, semantic_version: "1.0.0" };

export const STRATEGY_REGISTRY: StrategyDef[] = [
  {
    ...common, strategy_id: "FOOTBALL_ODDS_192_200_REPAIRED_SAFE",
    plain_language_rule: "ставим на футбольные рынки при коэффициенте примерно 1.92–2.00 (исторический «SAFE» отбор: сначала все виды спорта, потом футбол)",
    plain_language_rule_en: "Football bets at decimal odds about 1.92-2.00 using the repaired SAFE selection (all-sport SAFE selection first, football subset after).",
    market_scope: ["all reconciled soccer markets (exact score excluded)"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.52, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.52, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.9231, 2.00]",
    selector_semantics: SEL_SAFE, legacy_aliases: ["P50_52_SAFE"],
    implementation_symbol: "selectFootballOdds192200RepairedSafe",
    source_provenance: ["scripts/modeling/football-verification-review-a.ts", "scripts/modeling/tennis-safe-comparable-leaderboard.ts", "modeling/evidence/safe-authority-review-a-repair-v1/CANONICAL_RECONCILIATION_P50_52.md"],
    legacy_reported_metrics: [
      { label: "LEGACY_FROZEN_RUNNER_PRE_BACKFILL", selected: 1015, settled: 716, open: 299, pnl_u: 131.79, roi_pct: 18.41, max_dd_u: -14.69, date_from: RANGE_START, date_to: LEGACY_SAFE_WINDOW_END, source_path: AUTH_VERIF, source_commit: C_SAFE, formula_version: FORMULA_V, note: "v1 overlay, Aug04..Sep20" },
      { label: "LEGACY_WITH_POLYMARKET_299_BACKFILL", selected: 1015, settled: 953, open: 62, pnl_u: 182.8, roi_pct: 19.1815, max_dd_u: null, date_from: RANGE_START, date_to: LEGACY_SAFE_WINDOW_END, source_path: AUTH_BACKFILL, source_commit: C_SAFE, formula_version: FORMULA_V, note: "Valid LEGACY_REPORTED result: special 237-of-299 Polymarket backfill applied to this strategy only. NOT the common-corpus metric." },
    ],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_ODDS_185_200_REPAIRED",
    plain_language_rule: "ставим на футбольные рынки при коэффициенте примерно 1.85–2.00 (исторический «SAFE» отбор: сначала все виды спорта, потом футбол)",
    plain_language_rule_en: "Football bets at decimal odds about 1.85-2.00 using the repaired SAFE selection (all-sport SAFE selection first, football subset after).",
    market_scope: ["all reconciled soccer markets (exact score excluded)"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.54, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.54, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.8519, 2.00]",
    selector_semantics: SEL_SAFE, legacy_aliases: ["P50_54_SAFE"],
    implementation_symbol: "selectFootballOdds185200Repaired",
    source_provenance: ["scripts/modeling/football-verification-review-a.ts", "scripts/modeling/tennis-safe-comparable-leaderboard.ts"],
    legacy_reported_metrics: [
      { label: "LEGACY_FROZEN_RUNNER", selected: 1223, settled: 881, open: 342, pnl_u: 143.61, roi_pct: 16.3008, max_dd_u: -12.48, date_from: RANGE_START, date_to: LEGACY_SAFE_WINDOW_END, source_path: AUTH_VERIF, source_commit: C_SAFE, formula_version: FORMULA_V, note: "v1 overlay, Aug04..Sep20" },
    ],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_ORDINARY_STRUCTURED_ODDS_175_200",
    plain_language_rule: "ставим на обычные футбольные рынки при коэффициенте 1.75–2.00",
    plain_language_rule_en: "Ordinary structured soccer markets at decimal odds 1.75-2.00 (exact score and unresolved market types excluded).",
    market_scope: ["moneyline", "totals", "spreads", "total_corners", "other structured (exact score and unresolved excluded)"],
    price_min: 0.5, price_min_inclusive: false, price_max: round(1 / 1.75, 6), price_max_inclusive: true,
    decimal_odds_min: 1.75, decimal_odds_max: 2, decimal_odds_bounds: "[1.75, 2.00)",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["ODDS_1_75_2_00"],
    implementation_symbol: "selectFootballOrdinaryStructuredOdds175200",
    source_provenance: [AUTH_STRUCT + " ODDS_GRID.COMBINED.1_75_2_00", "scripts/modeling/football-structural-authority.ts"],
    legacy_reported_metrics: [legacyCommon("STRUCTURAL_AUTHORITY_V2_COMBINED", AUTH_STRUCT, C_STRUCT, { selected: 726, settled: 566, open: 160, pnl_u: 135.21, roi_pct: 23.8889, max_dd_u: -8.65 })],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_MONEYLINE_TOTALS_SPREADS_ODDS_185_200",
    plain_language_rule: "ставим только на победителя/тоталы/форы при коэффициенте примерно 1.85–2.00",
    plain_language_rule_en: "Soccer moneyline/totals/spreads only, entry price 0.50 <= p < 0.54 (decimal odds about 1.85-2.00).",
    market_scope: ["moneyline", "totals", "spreads"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.54, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.54, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.8519, 2.00]",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["CURRENT_LIVE_FOOTBALL_REFERENCE"],
    implementation_symbol: "selectFootballMoneylineTotalsSpreadsOdds185200",
    source_provenance: [AUTH_AUDIT + " LIVE_POLICY_REPLAY.TOTAL", "scripts/modeling/audit-p5052-p5054-c1-restored-lineage-v2.ts"],
    legacy_reported_metrics: [legacyCommon("RESTORED_LINEAGE_AUDIT_V2_LIVE_POLICY_REPLAY", AUTH_AUDIT, C_AUDIT, { selected: 514, settled: 438, open: 76, pnl_u: 117.05, roi_pct: 26.72, max_dd_u: -10.46 })],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_ODDS_192_200_PRICE_BAND",
    plain_language_rule: "ставим на обычные футбольные рынки при коэффициенте примерно 1.92–2.00 (цена входа 0.50–0.52)",
    plain_language_rule_en: "Ordinary soccer markets, entry price 0.50 <= p < 0.52 (decimal odds about 1.923-2.00), football-first selection.",
    market_scope: ["ordinary structured soccer markets (exact score and unresolved excluded)"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.52, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.52, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.9231, 2.00]",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["P50_52"],
    implementation_symbol: "selectFootballOdds192200PriceBand",
    source_provenance: [AUTH_AUDIT + " MODELS.P50_52.COMBINED_FULL_AUG04_SEP24", "scripts/modeling/audit-p5052-p5054-c1-restored-lineage-v2.ts"],
    legacy_reported_metrics: [legacyCommon("RESTORED_LINEAGE_AUDIT_V2_COMBINED", AUTH_AUDIT, C_AUDIT, { selected: 476, settled: 416, open: 60, pnl_u: 110.05, roi_pct: 26.45, max_dd_u: -14.57 })],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_ODDS_185_200_PRICE_BAND",
    plain_language_rule: "ставим на обычные футбольные рынки при коэффициенте примерно 1.85–2.00 (цена входа 0.50–0.54)",
    plain_language_rule_en: "Ordinary soccer markets, entry price 0.50 <= p < 0.54 (decimal odds about 1.852-2.00), football-first selection.",
    market_scope: ["ordinary structured soccer markets (exact score and unresolved excluded)"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.54, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.54, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.8519, 2.00]",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["P50_54"],
    implementation_symbol: "selectFootballOdds185200PriceBand",
    source_provenance: [AUTH_AUDIT + " MODELS.P50_54.COMBINED_FULL_AUG04_SEP24", "scripts/modeling/audit-p5052-p5054-c1-restored-lineage-v2.ts"],
    legacy_reported_metrics: [legacyCommon("RESTORED_LINEAGE_AUDIT_V2_COMBINED", AUTH_AUDIT, C_AUDIT, { selected: 637, settled: 554, open: 83, pnl_u: 100.25, roi_pct: 18.1, max_dd_u: -11.46 })],
    status: "CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER",
    plain_language_rule: "ставим на все обычные футбольные рынки БЕЗ ограничения по коэффициенту (базовая линия)",
    plain_language_rule_en: "All canonically resolved ordinary structured soccer markets with NO odds filter (exact score, unresolved and conflicting market types excluded). Baseline, not a money recommendation.",
    market_scope: ["ordinary structured soccer markets (exact score and unresolved excluded)"],
    price_min: 0, price_min_inclusive: false, price_max: 1, price_max_inclusive: false,
    decimal_odds_min: 1, decimal_odds_max: Infinity, decimal_odds_bounds: "no odds filter (0 < p < 1)",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["FOOTBALL_ALL_BASELINE"],
    implementation_symbol: "selectFootballOrdinaryStructuredNoOddsFilter",
    source_provenance: ["isOrdinaryHold in scripts/modeling/football-structural-authority.ts (Founder/Architect decision: existing canonical ordinary universe as baseline)"],
    legacy_reported_metrics: [],
    status: "BASELINE",
  },
  {
    ...common, strategy_id: "FOOTBALL_TOTAL_CORNERS_ODDS_225_250",
    plain_language_rule: "ставим только на тотал угловых при коэффициенте 2.25–2.50",
    plain_language_rule_en: "Soccer total-corners markets only at decimal odds 2.25-2.50.",
    market_scope: ["total_corners"],
    price_min: round(1 / 2.5, 6), price_min_inclusive: false, price_max: round(1 / 2.25, 6), price_max_inclusive: true,
    decimal_odds_min: 2.25, decimal_odds_max: 2.5, decimal_odds_bounds: "[2.25, 2.50)",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["2_25_2_50__TOTAL_CORNERS"],
    implementation_symbol: "selectFootballTotalCornersOdds225250",
    source_provenance: [AUTH_STRUCT + " STRUCTURAL_INTERACTION_CELLS.2_25_2_50__TOTAL_CORNERS", "scripts/modeling/football-structural-authority.ts buildStructuralInteractionCells"],
    legacy_reported_metrics: [legacyCommon("STRUCTURAL_AUTHORITY_V2_INTERACTION_CELL", AUTH_STRUCT, C_STRUCT, { selected: 118, settled: 77, open: 41, pnl_u: 22.78, roi_pct: 29.5894, max_dd_u: -7 })],
    status: "SLEEVE_CANDIDATE",
  },
  {
    ...common, strategy_id: "FOOTBALL_SPREADS_ODDS_185_200_AUDIT_REQUIRED",
    plain_language_rule: "ставим только на форы (гандикапы) при коэффициенте примерно 1.85–2.00",
    plain_language_rule_en: "Soccer spreads/handicaps only, entry price 0.50 <= p < 0.54 (decimal odds about 1.85-2.00). AUDIT_REQUIRED, not live authority.",
    market_scope: ["spreads"],
    price_min: 0.5, price_min_inclusive: true, price_max: 0.54, price_max_inclusive: false,
    decimal_odds_min: round(1 / 0.54, 4), decimal_odds_max: 2, decimal_odds_bounds: "(1.8519, 2.00]",
    selector_semantics: SEL_FOOTBALL_FIRST, legacy_aliases: ["LIVE_POLICY_REPLAY.spreads"],
    implementation_symbol: "selectFootballSpreadsOdds185200AuditRequired",
    source_provenance: [AUTH_AUDIT + " LIVE_POLICY_REPLAY.BY_FAMILY.spreads", "scripts/modeling/audit-p5052-p5054-c1-restored-lineage-v2.ts"],
    legacy_reported_metrics: [legacyCommon("RESTORED_LINEAGE_AUDIT_V2_LIVE_POLICY_REPLAY_SPREADS", AUTH_AUDIT, C_AUDIT, { selected: 250, settled: 201, open: 49, pnl_u: 122.14, roi_pct: 60.77, max_dd_u: -6 })],
    status: "AUDIT_REQUIRED_NOT_LIVE_AUTHORITY",
  },
];

/** Metadata-only legacy row. NEVER executable, NEVER model authority. */
export const LEGACY_UNREPRODUCIBLE_REFERENCES = [
  {
    id: "LEGACY_UNREPRODUCIBLE_REFERENCE_ALL_FOOTBALL_3835",
    legacy_reference: { selected: 3835, settled: 2522, open: 1313, pnl_u: -0.73, status: "LEGACY_UNREPRODUCIBLE_REFERENCE", executable: false },
    status: "NOT_EXECUTABLE / NOT_MODEL_AUTHORITY",
    executable: false,
    replaced_by: "FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER",
    note: "No reproducible implementation exists in Git or evidence. Founder/Architect decision: preserved as metadata only; never blocks the registry.",
  },
] as const;

export const IMPLEMENTATIONS: Record<string, (ctx: RunContext) => SelectedCandidate[]> = {
  selectFootballOdds192200RepairedSafe,
  selectFootballOdds185200Repaired,
  selectFootballOrdinaryStructuredOdds175200,
  selectFootballMoneylineTotalsSpreadsOdds185200,
  selectFootballOdds192200PriceBand,
  selectFootballOdds185200PriceBand,
  selectFootballOrdinaryStructuredNoOddsFilter,
  selectFootballTotalCornersOdds225250,
  selectFootballSpreadsOdds185200AuditRequired,
};

// ── Evaluation ──────────────────────────────────────────────────────────────

export interface CommonMetrics {
  selected_n: number;
  settled_n: number;
  open_n: number;
  other_nonterminal_n: number;
  wins: number;
  losses: number;
  pnl_u: number;
  roi_pct: number;
  max_dd_u: number;
  bets_per_calendar_day: number;
  distinct_physical_events_selected: number;
}

export function evaluateSelection(selected: SelectedCandidate[], settlement: Map<string, CorpusLabel>, calendarDays: number): CommonMetrics {
  const { settledBets, openN, otherNonterminalN } = settledBetsOnly(selected, settlement);
  const m = metricsFor(settledBets);
  return {
    selected_n: selected.length,
    settled_n: settledBets.length,
    open_n: openN,
    other_nonterminal_n: otherNonterminalN,
    wins: m.wins,
    losses: m.losses,
    pnl_u: m.pnl_u,
    roi_pct: m.roi_pct,
    max_dd_u: m.max_drawdown_u,
    bets_per_calendar_day: round(selected.length / calendarDays, 2),
    distinct_physical_events_selected: new Set(selected.map((s) => s.physicalEventKey)).size,
  };
}

export const calendarDaysInclusive = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export interface DatasetManifest {
  DATASET_ID: string;
  DATE_FROM: string;
  DATE_TO: string;
  CALENDAR_DAY_N: number;
  SOURCE_ROW_N: number;
  UNIQUE_PHYSICAL_EVENT_N: number;
  MANIFEST_FILE_SHA256: string;
  MANIFEST_OVERLAY_CONTENT_SHA256: string;
  OVERLAY_SHA256: string;
  OVERLAY_CONTENT_SHA256: string;
  SOURCE_COMMIT_SHA: string;
  DENOMINATOR_MANIFEST_PATH: string;
  DENOMINATOR_OVERLAY_PATH: string;
}

export interface ScorecardRow {
  strategy_id: string;
  dataset_id: string;
  dataset_manifest_sha256: string;
  dataset_overlay_sha256: string;
  date_from: string;
  date_to: string;
  total_unique_football_matches: number;
  metrics: CommonMetrics;
}

export function scoreStrategies(ctx: RunContext, dataset: DatasetManifest): ScorecardRow[] {
  return STRATEGY_REGISTRY.map((def) => {
    const fn = IMPLEMENTATIONS[def.implementation_symbol];
    if (!fn) throw new Error(`REGISTRY_IMPLEMENTATION_MISSING:${def.strategy_id}`);
    return {
      strategy_id: def.strategy_id,
      dataset_id: dataset.DATASET_ID,
      dataset_manifest_sha256: dataset.MANIFEST_FILE_SHA256,
      dataset_overlay_sha256: dataset.OVERLAY_SHA256,
      date_from: dataset.DATE_FROM,
      date_to: dataset.DATE_TO,
      total_unique_football_matches: dataset.UNIQUE_PHYSICAL_EVENT_N,
      metrics: evaluateSelection(fn(ctx), ctx.settlement, dataset.CALENDAR_DAY_N),
    };
  });
}

/** PRIMARY CEO ORDER: COMMON_CORPUS PnL descending; ties broken by ROI then ID for determinism. */
export function rankByPnl(rows: ScorecardRow[]): ScorecardRow[] {
  return [...rows].sort((a, b) => b.metrics.pnl_u - a.metrics.pnl_u || b.metrics.roi_pct - a.metrics.roi_pct || a.strategy_id.localeCompare(b.strategy_id));
}

// ── Rendering ───────────────────────────────────────────────────────────────

const fmt = (v: number, dp = 2) => (Object.is(round(v, dp), -0) ? 0 : round(v, dp)).toFixed(dp);
const signed = (v: number, dp = 2) => `${v >= 0 ? "+" : ""}${fmt(v, dp)}`;

function headlineLegacy(def: StrategyDef): LegacyMetric | null {
  return def.legacy_reported_metrics.length ? def.legacy_reported_metrics[def.legacy_reported_metrics.length - 1] : null;
}
const oddsLabel = (v: number) => (Number.isFinite(v) ? fmt(v, 3) : "—");

export function renderCeoTable(rows: ScorecardRow[], dataset: DatasetManifest): string {
  const ranked = rankByPnl(rows);
  const byId = new Map(STRATEGY_REGISTRY.map((d) => [d.strategy_id, d]));
  const header = "| P&L rank | Strategy | Plain-language bet | Markets | Odds min | Odds max | Date from | Date to | Dataset SHA | Total unique football matches | Selected | Settled | Open | Wins | Losses | PnL u | ROI % | MaxDD u | Bets/day | Legacy PnL | Legacy ROI | Status |\n|---:|---|---|---|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|";
  const lines = ranked.map((r, i) => {
    const d = byId.get(r.strategy_id)!;
    const l = headlineLegacy(d);
    const m = r.metrics;
    const legacyPnl = l ? `${signed(l.pnl_u)}u (${l.date_from}..${l.date_to}${l.label.includes("BACKFILL") ? ", legacy backfill" : ""})` : "n/a";
    const legacyRoi = l ? `${signed(l.roi_pct, 2)}%` : "n/a";
    return `| ${i + 1} | ${d.strategy_id} | ${d.plain_language_rule} | ${d.market_scope.join(", ")} | ${oddsLabel(d.decimal_odds_min)} | ${oddsLabel(d.decimal_odds_max)} | ${r.date_from} | ${r.date_to} | ${r.dataset_manifest_sha256.slice(0, 12)} | ${r.total_unique_football_matches} | ${m.selected_n} | ${m.settled_n} | ${m.open_n} | ${m.wins} | ${m.losses} | ${signed(m.pnl_u)} | ${signed(m.roi_pct)} | ${fmt(m.max_dd_u)} | ${fmt(m.bets_per_calendar_day)} | ${legacyPnl} | ${legacyRoi} | ${d.status} |`;
  });
  return [
    "# Football strategies — common-corpus P&L leaderboard",
    "",
    `Dataset: \`${dataset.DATASET_ID}\` — ${dataset.DATE_FROM}..${dataset.DATE_TO} (${dataset.CALENDAR_DAY_N} calendar days), ${dataset.UNIQUE_PHYSICAL_EVENT_N} unique canonical football matches, overlay SHA-256 \`${dataset.OVERLAY_SHA256}\`, denominator manifest SHA-256 \`${dataset.MANIFEST_FILE_SHA256}\`.`,
    "",
    "**Primary metric: absolute P&L (common-corpus, descending).** No Champion is selected here. All figures are REFERENCE_PNL at display price, flat 1u, NOT_EXECUTION_AUTHORITY.",
    "",
    "**OPEN ≠ LOSS.** Every strategy uses the SAME common settlement attachment. Bets still OPEN/nonterminal under it are counted in *Open*, contribute nothing to P&L/ROI and are NOT losses. ROI % = 100 × PnL u / Settled.",
    "",
    "**Legacy PnL/ROI are historical reported values, not comparable to the common columns** when their date span or settlement differs (see the date span in the Legacy PnL cell and `LEGACY_REFERENCE_RECONCILIATION.md`). Strategy 1's +182.80u used a special Polymarket backfill of 237 of 299 open rows and ended Sep 20; it is preserved as legacy only.",
    "",
    header,
    ...lines,
    "",
    "Legacy unreproducible reference `LEGACY_UNREPRODUCIBLE_REFERENCE_ALL_FOOTBALL_3835` (selected 3835 / settled 2522 / open 1313 / −0.73u) has no implementation; it is metadata only and is NOT_EXECUTABLE / NOT_MODEL_AUTHORITY. `FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER` is the executable baseline that replaces it.",
    "",
  ].join("\n");
}

export const FORMULAS_MD = `# Frozen economic formulas — football strategy registry v${REGISTRY_VERSION}

Contract: BETTING_ECONOMICS_CONTRACT_V2 / SELECTION_BEFORE_SETTLEMENT_V1. REFERENCE_PNL / NOT_EXECUTION_AUTHORITY.

- Flat stake: 1u per settled bet.
- decimal_odds = 1 / entry_price
- WIN: pnl_u = 1 / entry_price - 1
- LOSS: pnl_u = -1
- OPEN / nonterminal (OPEN, VOID, NO_MATCH, AMBIGUOUS) / invalid identity: NOT a loss; no settled-P&L contribution; excluded from SETTLED_N.
- SETTLED_N = WINS + LOSSES
- ROI_PCT = 100 * PNL_U / SETTLED_N (every settled bet stakes 1u)
- MaxDD: chronological (decisionTimestamp, then physicalEventKey) cumulative settled-P&L drawdown, reported negative.
- Bets/day = SELECTED_N / calendar days in the common window (${RANGE_START}..${RANGE_END}).
- Selection: the predicate is applied BEFORE settlement; rows are processed chronologically; the first qualifying row claims the physicalEventKey, so one physical event yields at most one economic bet per strategy; exact condition/token identity; no settlement or result information influences membership.
- Price bands use entry_price: lower bound inclusive, upper bound exclusive unless stated; odds-bucket strategies use [min, max) on 1/entry_price.
- Common settlement: research_model_ready_rows.settlement_label attached by exact (condition_id, selected_token_id, decision_at), identical for every strategy. No strategy-specific backfill.

Implementation: \`${SCRIPT_PATH}\` (reuses runStandaloneStrict, settledBetsOnly, metricsFor, settleBetU, aggregateMetrics).
`;

export interface ReconRow {
  strategy_id: string;
  legacy_label: string;
  legacy: { selected: number; settled: number; open: number; pnl_u: number; roi_pct: number; max_dd_u: number | null; date_from: string; date_to: string };
  common: CommonMetrics;
  same_span_and_settlement: boolean;
  exact_match: boolean | null;
}

export function reconcileLegacy(rows: ScorecardRow[]): ReconRow[] {
  const byId = new Map(rows.map((r) => [r.strategy_id, r]));
  const out: ReconRow[] = [];
  for (const d of STRATEGY_REGISTRY) {
    const c = byId.get(d.strategy_id)!.metrics;
    for (const l of d.legacy_reported_metrics) {
      const same = l.date_from === RANGE_START && l.date_to === RANGE_END;
      out.push({
        strategy_id: d.strategy_id, legacy_label: l.label,
        legacy: { selected: l.selected, settled: l.settled, open: l.open, pnl_u: l.pnl_u, roi_pct: l.roi_pct, max_dd_u: l.max_dd_u, date_from: l.date_from, date_to: l.date_to },
        common: c, same_span_and_settlement: same,
        exact_match: same ? l.selected === c.selected_n && l.settled === c.settled_n && l.open === c.open_n && l.pnl_u === c.pnl_u && l.max_dd_u === c.max_dd_u : null,
      });
    }
  }
  return out;
}

export function renderReconciliation(recon: ReconRow[], safeWindowReplay: Record<string, CommonMetrics>): string {
  const lines = recon.map((r) => `| ${r.strategy_id} | ${r.legacy_label} | ${r.legacy.date_from}..${r.legacy.date_to} | ${r.legacy.selected}/${r.legacy.settled}/${r.legacy.open} | ${signed(r.legacy.pnl_u)} | ${r.legacy.max_dd_u ?? "n/a"} | ${r.common.selected_n}/${r.common.settled_n}/${r.common.open_n} | ${signed(r.common.pnl_u)} | ${r.common.max_dd_u} | ${r.exact_match === null ? "DIFFERENT_SPAN (not comparable)" : r.exact_match ? "EXACT_MATCH" : "MISMATCH"} |`);
  const replay = Object.entries(safeWindowReplay).map(([id, m]) => `| ${id} | ${m.selected_n} | ${m.settled_n} | ${m.open_n} | ${signed(m.pnl_u)} | ${fmt(m.roi_pct)} | ${fmt(m.max_dd_u)} |`);
  return [
    "# Legacy reference reconciliation",
    "",
    "Two metric layers are kept apart and never overwrite each other: **LEGACY_REPORTED_METRICS** (historical figures with source path/commit, in `STRATEGY_REGISTRY.json`) and **COMMON_CORPUS_METRICS** (`COMMON_CORPUS_SCORECARD.json`).",
    "",
    "| Strategy | Legacy record | Legacy span | Legacy sel/settled/open | Legacy PnL u | Legacy MaxDD | Common sel/settled/open | Common PnL u | Common MaxDD | Verdict |",
    "|---|---|---|---|---:|---:|---|---:|---:|---|",
    ...lines,
    "",
    "## Why strategies 1 and 2 differ from their legacy values",
    "",
    "- Legacy span was 2026-08-04..2026-09-20 on the v1 overlay; the common corpus runs to 2026-09-24 on the v2 overlay/classification, so the selected sets are larger.",
    "- Strategy 1's legacy +182.80u (953 terminal / 62 open) applied a one-off Polymarket lookup to 299 open identities of that strategy only. The common corpus applies ONE uniform settlement attachment (`research_model_ready_rows.settlement_label`) to all strategies, so that backfill is deliberately NOT applied; identities nonterminal under it stay OPEN and are never losses.",
    "- The SAFE selection is all-sport first, football subset after (see `CANONICAL_RECONCILIATION_P50_52.md`); strategies 5/6 are football-first with the ordinary-market filter. They are different strategies and are not merged.",
    "",
    "## Diagnostic: SAFE strategies replayed on the legacy window (model_date <= 2026-09-20, v2 classification, common settlement)",
    "",
    "Informational only — shows how much of the difference is span/overlay/settlement rather than selector semantics.",
    "",
    "| Strategy | Selected | Settled | Open | PnL u | ROI % | MaxDD u |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...replay,
    "",
    "## Legacy unreproducible reference",
    "",
    "`LEGACY_UNREPRODUCIBLE_REFERENCE_ALL_FOOTBALL_3835`: selected 3835 / settled 2522 / open 1313 / −0.73u. No implementation exists; status NOT_EXECUTABLE / NOT_MODEL_AUTHORITY. Replaced by executable baseline `FOOTBALL_ORDINARY_STRUCTURED_NO_ODDS_FILTER` (Founder/Architect decision); its common-corpus figures are recomputed, not inherited.",
    "",
  ].join("\n");
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const canonicalJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x === Infinity ? "Infinity" : x), 2) + "\n";

export function buildDatasetManifest(ctx: RunContext, sourceRowN: number, sourceCommit: string, readFile: (p: string) => Buffer = (p) => readFileSync(p)): DatasetManifest {
  const manifestPath = join(DENOMINATOR_DIR, `MANIFEST_${RANGE_START}_${RANGE_END}.json`);
  const manifestBytes = readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { OVERLAY_CONTENT_SHA256: string; COMBINED: { stats: { canonical_soccer_physical_event_n: number } } };
  const uniqueEvents = new Set(ctx.structural.map((c) => c.physicalEventKey)).size;
  if (manifest.COMBINED.stats.canonical_soccer_physical_event_n !== uniqueEvents) {
    throw new Error(`DATASET_EVENT_N_MISMATCH:manifest=${manifest.COMBINED.stats.canonical_soccer_physical_event_n}:computed=${uniqueEvents}`);
  }
  return {
    DATASET_ID,
    DATE_FROM: RANGE_START,
    DATE_TO: RANGE_END,
    CALENDAR_DAY_N: calendarDaysInclusive(RANGE_START, RANGE_END),
    SOURCE_ROW_N: sourceRowN,
    UNIQUE_PHYSICAL_EVENT_N: uniqueEvents,
    MANIFEST_FILE_SHA256: sha256(manifestBytes),
    MANIFEST_OVERLAY_CONTENT_SHA256: manifest.OVERLAY_CONTENT_SHA256,
    OVERLAY_SHA256: FROZEN_OVERLAY_COMPRESSED_SHA256,
    OVERLAY_CONTENT_SHA256: FROZEN_OVERLAY_CONTENT_SHA256,
    SOURCE_COMMIT_SHA: sourceCommit,
    DENOMINATOR_MANIFEST_PATH: manifestPath,
    DENOMINATOR_OVERLAY_PATH: join(DENOMINATOR_DIR, `FOOTBALL_DENOMINATOR_OVERLAY_${RANGE_START}_${RANGE_END}.jsonl.gz`),
  };
}

export interface Artifacts {
  files: Record<string, string>;
  scorecard: ScorecardRow[];
}

export function buildArtifacts(ctx: RunContext, dataset: DatasetManifest): Artifacts {
  const scorecard = scoreStrategies(ctx, dataset);
  const recon = reconcileLegacy(scorecard);
  const safeWindowReplay: Record<string, CommonMetrics> = {};
  const windowUniverse = ctx.safeUniverse.filter((c) => c.modelDate <= LEGACY_SAFE_WINDOW_END);
  for (const [id, fn] of [
    ["FOOTBALL_ODDS_192_200_REPAIRED_SAFE", selectFootballOdds192200RepairedSafe],
    ["FOOTBALL_ODDS_185_200_REPAIRED", selectFootballOdds185200Repaired],
  ] as const) {
    safeWindowReplay[id] = evaluateSelection(fn(ctx, windowUniverse), ctx.settlement, calendarDaysInclusive(RANGE_START, LEGACY_SAFE_WINDOW_END));
  }
  const ranked = rankByPnl(scorecard);
  const registryJson = {
    REGISTRY_ID: "FOOTBALL_STRATEGY_REGISTRY_V1",
    REGISTRY_VERSION,
    EXECUTABLE_STRATEGY_N: STRATEGY_REGISTRY.length,
    PRIMARY_OPTIMIZATION_METRIC: "ABSOLUTE_PNL_U",
    CHAMPION_SELECTED: false,
    STRATEGIES: STRATEGY_REGISTRY.map((d) => ({
      ...d,
      decimal_odds_max: Number.isFinite(d.decimal_odds_max) ? d.decimal_odds_max : "Infinity",
      common_corpus_metrics: scorecard.find((r) => r.strategy_id === d.strategy_id)!.metrics,
      common_corpus_dataset_id: dataset.DATASET_ID,
    })),
    LEGACY_UNREPRODUCIBLE_REFERENCES,
  };
  const scorecardJson = {
    SCORECARD_ID: "FOOTBALL_COMMON_CORPUS_SCORECARD_V1",
    DATASET: dataset,
    SORT: "COMMON_CORPUS pnl_u DESC",
    FORMULAS: "FORMULAS.md",
    PNL_LABEL: "REFERENCE_PNL / NOT_EXECUTION_AUTHORITY",
    ROWS: ranked.map((r, i) => ({ pnl_rank: i + 1, ...r })),
    LEGACY_RECONCILIATION: recon,
  };
  const files: Record<string, string> = {
    "STRATEGY_REGISTRY.json": canonicalJson(registryJson),
    "COMMON_CORPUS_SCORECARD.json": canonicalJson(scorecardJson),
    "DATASET_MANIFEST.json": canonicalJson(dataset),
    "FORMULAS.md": FORMULAS_MD,
    "CEO_FOOTBALL_STRATEGIES.md": renderCeoTable(scorecard, dataset),
    "LEGACY_REFERENCE_RECONCILIATION.md": renderReconciliation(recon, safeWindowReplay),
  };
  const sums = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n") + "\n";
  files["SHA256SUMS.txt"] = sums;
  return { files, scorecard };
}

async function main() {
  const db = await connectClone();
  const frozen = await loadFrozenFootballDenominatorV2(db);
  const all = buildAllSportCandidates(frozen.sourceRows);
  const preliminary = buildSafeUniverseV2(frozen.sourceRows, frozen.overlay, () => null);
  const identityLookup = await fetchTennisIdentityLookup(db, preliminary.tennisConditionIds);
  const ctx = buildRunContext(frozen.sourceRows, frozen.overlay, identityLookup);
  console.error(JSON.stringify({ STAGE: "CONTEXT_READY", ALL_SPORT_CANDIDATES: all.length, SAFE_UNIVERSE: ctx.safeUniverse.length, STRUCTURAL: ctx.structural.length }));
  const dataset = buildDatasetManifest(ctx, frozen.sourceRows.length, DENOMINATOR_SOURCE_COMMIT);
  const { files, scorecard } = buildArtifacts(ctx, dataset);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(OUT_DIR, name), body);
  const top = rankByPnl(scorecard)[0];
  console.log(JSON.stringify({ STATUS: "SUCCESS", TOP_PNL: top.strategy_id, TOP_PNL_U: top.metrics.pnl_u, DATASET: dataset.DATASET_ID, CLONE_DB_WRITES: 0, PRODUCTION_WRITES: 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(JSON.stringify({ STATUS: "FAILED", ERROR: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  });
}
