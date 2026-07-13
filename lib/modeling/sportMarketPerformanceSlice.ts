// Sport and market-type performance slice engine (Phase 3E.8C).
//
// Analyzes exactly three models -- PRIMARY_V1_AVOID_NBA_NHL_COV_CAP,
// ALT2_TS_SCORE_GE_65 (mandatory), ALT1_CANONICAL_EVENT_GROUPING -- by sport
// and market type on the same canonical dedup corpus. Row selection reuses
// evaluateHistoricalFunnelVariant (never a second predicate engine);
// ROI/PnL/win-loss reuse roiPnlContract; equity/drawdown reuse
// computeFlatUnitEquityMetrics; event identity reuses buildEventGroupKey.
// Sport/market classification is explicit-field-first with a bounded slug
// fallback -- it never guesses from vague title text; unmatched stays
// UNKNOWN. Pure: no fs/env/network/database access, never mutates its input.

import { createHash } from "node:crypto";
import { evaluateHistoricalFunnelVariant } from "./historicalFunnelVariants";
import { computeFlatStakeRoiSummary, computeRowReturnPct } from "./roiPnlContract";
import { computeFlatUnitEquityMetrics } from "./historicalFunnelComparison";
import { buildEventGroupKey } from "./eventGroupSelection";
import { getBundle, type ExecutableFunnelClassifier } from "./executableFunnelClassifier";

type Row = Record<string, unknown>;

export const ANALYZED_MODEL_IDS = [
  "PRIMARY_V1_AVOID_NBA_NHL_COV_CAP",
  "ALT2_TS_SCORE_GE_65",
  "ALT1_CANONICAL_EVENT_GROUPING",
] as const;

// ---- Classification ----

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface SportClassification {
  sportKey: string;
  sportLabel: string;
  classificationSource: "explicit_field" | "slug_fallback" | "unknown";
  classificationConfidence: ClassificationConfidence;
}

export interface MarketClassification {
  marketKey: string;
  classificationSource: "slug_pattern" | "slug_default" | "unknown";
  classificationConfidence: ClassificationConfidence;
}

const EXPLICIT_SPORT_FIELDS = ["league", "league_name", "sport", "sport_name", "competition"] as const;

const SPORT_SLUG_PATTERNS: Array<[RegExp, string]> = [
  [/\bnba\b|basketball/i, "basketball"],
  [/\bnhl\b|ice[\s-]?hockey/i, "hockey"],
  [/\bnfl\b|american[\s-]?football/i, "american_football"],
  [/\bmlb\b|baseball/i, "baseball"],
  [/\btennis\b|\batp\b|\bwta\b/i, "tennis"],
  [/\besport|cs2|valorant|dota|league[\s-]of[\s-]legend|counter[\s-]strike/i, "esports"],
  [/soccer|football|epl|premier[\s-]?league|la[\s-]?liga|bundesliga|fifa|world[\s-]?cup|serie[\s-]?a|champions[\s-]?league/i, "soccer_football"],
];

function slugText(row: Row): string {
  const eventSlug = typeof row.event_slug === "string" ? row.event_slug : "";
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  return `${eventSlug} ${marketSlug}`.toLowerCase();
}

/**
 * Sport classification. Explicit field first (league/league_name/sport/
 * sport_name/competition) -> HIGH confidence. Falls back to a bounded slug
 * regex match -> MEDIUM confidence. If a slug exists but matches nothing
 * known -> LOW confidence with sportKey OTHER. No slug at all -> UNKNOWN.
 * Never guesses from vague title text beyond these explicit, named patterns.
 */
export function classifySport(row: Row): SportClassification {
  for (const field of EXPLICIT_SPORT_FIELDS) {
    const value = row[field];
    if (typeof value === "string" && value.trim() !== "") {
      return {
        sportKey: value.trim().toLowerCase().replace(/\s+/g, "_"),
        sportLabel: value.trim(),
        classificationSource: "explicit_field",
        classificationConfidence: "HIGH",
      };
    }
  }

  const text = slugText(row);
  if (text.trim() === "") {
    return { sportKey: "UNKNOWN", sportLabel: "Unknown", classificationSource: "unknown", classificationConfidence: "UNKNOWN" };
  }
  for (const [pattern, key] of SPORT_SLUG_PATTERNS) {
    if (pattern.test(text)) {
      return { sportKey: key, sportLabel: key.replace(/_/g, " "), classificationSource: "slug_fallback", classificationConfidence: "MEDIUM" };
    }
  }
  return { sportKey: "OTHER", sportLabel: "Other (unmatched slug)", classificationSource: "slug_fallback", classificationConfidence: "LOW" };
}

const MARKET_SLUG_PATTERNS: Array<[RegExp, string]> = [
  [/over[\s-]?under|totals?|\bo\/u\b/i, "TOTALS"],
  [/spread|handicap|[+-]\d+(\.\d+)?(?!\d)/i, "SPREAD_OR_HANDICAP"],
  [/both[\s-]?teams?[\s-]?to[\s-]?score|\bbtts\b/i, "BOTH_TEAMS_TO_SCORE"],
  [/player[\s-]?prop|player[\s-]?points|player[\s-]?assists|player[\s-]?rebounds/i, "PLAYER_PROP"],
  [/team[\s-]?prop|team[\s-]?total/i, "TEAM_PROP"],
  [/series|tournament[\s-]?winner|tournament(?!.*match)/i, "SERIES_OR_TOURNAMENT"],
  [/outright|futures?|to[\s-]?win[\s-]?the/i, "OUTRIGHT_OR_FUTURE"],
  [/moneyline|match[\s-]?winner|\bwinner\b/i, "MATCH_WINNER_OR_MONEYLINE"],
];

/**
 * Market-type classification from explicit market/slug semantics. Returns
 * MATCH_WINNER_OR_MONEYLINE only when a moneyline/winner pattern matches (or
 * as a bounded default when a market_slug exists but matches no other known
 * pattern -- reported with LOW confidence, never claimed exact). No slug at
 * all -> UNKNOWN. If futures/outrights unexpectedly appear on this corpus,
 * they surface here explicitly as OUTRIGHT_OR_FUTURE, never hidden.
 */
export function classifyMarketType(row: Row): MarketClassification {
  const marketSlug = typeof row.market_slug === "string" ? row.market_slug : "";
  if (marketSlug.trim() === "") {
    return { marketKey: "UNKNOWN", classificationSource: "unknown", classificationConfidence: "UNKNOWN" };
  }
  for (const [pattern, key] of MARKET_SLUG_PATTERNS) {
    if (pattern.test(marketSlug)) {
      const confidence: ClassificationConfidence = key === "MATCH_WINNER_OR_MONEYLINE" && !/moneyline|winner/i.test(marketSlug) ? "MEDIUM" : "HIGH";
      return { marketKey: key, classificationSource: "slug_pattern", classificationConfidence: confidence };
    }
  }
  // Bounded default: a market_slug exists but matches no explicit pattern --
  // most unlabeled sports markets on this platform are match-winner style,
  // but this is a heuristic default, reported at LOW confidence, not exact.
  return { marketKey: "MATCH_WINNER_OR_MONEYLINE", classificationSource: "slug_default", classificationConfidence: "LOW" };
}

// ---- Segment metrics ----

export type SampleStatus = "ROBUST_SAMPLE" | "MODERATE_SAMPLE" | "LOW_SAMPLE";

function sampleStatusOf(signals: number): SampleStatus {
  if (signals >= 100) return "ROBUST_SAMPLE";
  if (signals >= 30) return "MODERATE_SAMPLE";
  return "LOW_SAMPLE";
}

export interface SegmentMetrics {
  signals: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  pnlUnits: number | null;
  roiPct: number | null;
  maxDrawdownUnits: number;
  uniqueConditionTokenPairs: number;
  uniqueMarkets: number;
  uniqueEventGroups: number;
  eventsWithMultipleSignals: number;
  maxSignalsPerEvent: number;
  averageSignalsPerEvent: number;
}

function getStr(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function computeSegmentMetrics(rows: readonly Row[]): SegmentMetrics {
  const roi = computeFlatStakeRoiSummary([...rows], { strict: false, stakeUnits: 1 });
  const equity = computeFlatUnitEquityMetrics(rows);

  const pairs = new Set<string>();
  const markets = new Set<string>();
  const eventCounts = new Map<string, number>();
  for (const row of rows) {
    const cond = getStr(row, "condition_id");
    const tok = getStr(row, "token_id") ?? getStr(row, "selected_token_id");
    if (cond !== null && tok !== null) pairs.add(`${cond}::${tok}`);
    if (cond !== null) markets.add(cond);
    const key = buildEventGroupKey(row).key;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const counts = Array.from(eventCounts.values());

  return {
    signals: rows.length,
    wins: roi.winCount,
    losses: roi.lossCount,
    winRatePct: roi.winRatePct,
    pnlUnits: roi.totalPnlUnits,
    roiPct: roi.roiPct,
    maxDrawdownUnits: equity.maximumDrawdownUnits,
    uniqueConditionTokenPairs: pairs.size,
    uniqueMarkets: markets.size,
    uniqueEventGroups: eventCounts.size,
    eventsWithMultipleSignals: counts.filter((c) => c > 1).length,
    maxSignalsPerEvent: counts.length > 0 ? Math.max(...counts) : 0,
    averageSignalsPerEvent: eventCounts.size > 0 ? rows.length / eventCounts.size : 0,
  };
}

export interface SegmentBucket {
  label: string;
  classificationConfidence: ClassificationConfidence;
  metrics: SegmentMetrics;
  sampleStatus: SampleStatus;
}

function bucketByLabel(
  rows: readonly Row[],
  labelOf: (row: Row) => { label: string; confidence: ClassificationConfidence },
): SegmentBucket[] {
  const groups = new Map<string, { rows: Row[]; confidence: ClassificationConfidence }>();
  for (const row of rows) {
    const { label, confidence } = labelOf(row);
    const bucket = groups.get(label) ?? { rows: [], confidence };
    bucket.rows.push(row);
    groups.set(label, bucket);
  }
  return Array.from(groups.entries())
    .map(([label, { rows: bucketRows, confidence }]) => ({
      label,
      classificationConfidence: confidence,
      metrics: computeSegmentMetrics(bucketRows),
      sampleStatus: sampleStatusOf(bucketRows.length),
    }))
    .sort((a, b) => b.metrics.signals - a.metrics.signals || a.label.localeCompare(b.label));
}

// ---- Leaderboards ----

export interface LeaderEntry {
  label: string;
  signals: number;
  roiPct: number | null;
  pnlUnits: number | null;
}

const ROI_LEADERBOARD_MIN_SAMPLE = 30;

function topByRoi(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.signals >= ROI_LEADERBOARD_MIN_SAMPLE && b.metrics.roiPct !== null)
    .sort((a, b) => (b.metrics.roiPct ?? 0) - (a.metrics.roiPct ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

function topByPnl(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.pnlUnits !== null)
    .sort((a, b) => (b.metrics.pnlUnits ?? 0) - (a.metrics.pnlUnits ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

function worstByPnl(buckets: SegmentBucket[], n: number): LeaderEntry[] {
  return [...buckets]
    .filter((b) => b.metrics.pnlUnits !== null)
    .sort((a, b) => (a.metrics.pnlUnits ?? 0) - (b.metrics.pnlUnits ?? 0))
    .slice(0, n)
    .map((b) => ({ label: b.label, signals: b.metrics.signals, roiPct: b.metrics.roiPct, pnlUnits: b.metrics.pnlUnits }));
}

// ---- Event concentration ----

export interface ConcentratedGroup {
  eventGroupKeyHash: string;
  signals: number;
  pnlUnits: number | null;
  roiPct: number | null;
}

export interface EventConcentration {
  totalSignals: number;
  uniqueEventGroups: number;
  averageSignalsPerEvent: number;
  eventsWithMultipleSignals: number;
  shareOfSignalsFromMultiSignalEvents: number;
  maxSignalsPerEvent: number;
  topConcentratedGroups: ConcentratedGroup[];
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function computeEventConcentration(rows: readonly Row[]): EventConcentration {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = buildEventGroupKey(row).key;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const entries = Array.from(groups.entries());
  const counts = entries.map(([, g]) => g.length);
  const multiSignalRows = entries.filter(([, g]) => g.length > 1).reduce((s, [, g]) => s + g.length, 0);

  const top = [...entries]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([key, g]) => {
      const roi = computeFlatStakeRoiSummary(g, { strict: false, stakeUnits: 1 });
      return { eventGroupKeyHash: hashKey(key), signals: g.length, pnlUnits: roi.totalPnlUnits, roiPct: roi.roiPct };
    });

  return {
    totalSignals: rows.length,
    uniqueEventGroups: groups.size,
    averageSignalsPerEvent: groups.size > 0 ? rows.length / groups.size : 0,
    eventsWithMultipleSignals: counts.filter((c) => c > 1).length,
    shareOfSignalsFromMultiSignalEvents: rows.length > 0 ? (multiSignalRows / rows.length) * 100 : 0,
    maxSignalsPerEvent: counts.length > 0 ? Math.max(...counts) : 0,
    topConcentratedGroups: top,
  };
}

// ---- Top-level model slice ----

export interface ModelSlice {
  variantId: string;
  outputRows: number;
  overallPnlUnits: number | null;
  overallRoiPct: number | null;
  sportBreakdown: SegmentBucket[];
  marketTypeBreakdown: SegmentBucket[];
  leaders: {
    topSportsByRoi: LeaderEntry[];
    topSportsByPnl: LeaderEntry[];
    topMarketsByRoi: LeaderEntry[];
    topMarketsByPnl: LeaderEntry[];
    worstSportsByPnl: LeaderEntry[];
    worstMarketsByPnl: LeaderEntry[];
  };
  eventConcentration: EventConcentration;
  // Retained ONLY for same-process test verification against
  // computeFlatStakeRoiSummary; never serialized into a written report.
  selectedRowsForVerificationOnly?: Row[];
}

export interface CrossModelRow {
  label: string;
  PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
  ALT2_TS_SCORE_GE_65: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
  ALT1_CANONICAL_EVENT_GROUPING: { signals: number; pnlUnits: number | null; roiPct: number | null } | null;
}

export interface ClassificationCoverage {
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  UNKNOWN: number;
}

export interface SportMarketPerformanceSlice {
  schemaVersion: 1;
  corpusRowCount: number;
  models: ModelSlice[];
  crossModelSportMatrix: CrossModelRow[];
  crossModelMarketMatrix: CrossModelRow[];
  classificationCoverage: { sport: ClassificationCoverage; marketType: ClassificationCoverage };
}

function computeCorpusHash(rows: readonly Row[]): string {
  const ordered = [...rows].sort((a, b) => {
    const ak = `${getStr(a, "condition_id") ?? ""}::${getStr(a, "token_id") ?? ""}`;
    const bk = `${getStr(b, "condition_id") ?? ""}::${getStr(b, "token_id") ?? ""}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function coverageOf(rows: readonly Row[], classify: (r: Row) => { classificationConfidence: ClassificationConfidence }): ClassificationCoverage {
  const total = rows.length;
  const counts: ClassificationCoverage = { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const row of rows) counts[classify(row).classificationConfidence] += 1;
  if (total === 0) return counts;
  return {
    HIGH: (counts.HIGH / total) * 100,
    MEDIUM: (counts.MEDIUM / total) * 100,
    LOW: (counts.LOW / total) * 100,
    UNKNOWN: (counts.UNKNOWN / total) * 100,
  };
}

function buildCrossModelMatrix(
  models: ModelSlice[],
  pickBreakdown: (m: ModelSlice) => SegmentBucket[],
): CrossModelRow[] {
  const labels = new Set<string>();
  for (const m of models) for (const b of pickBreakdown(m)) labels.add(b.label);

  return Array.from(labels)
    .sort()
    .map((label) => {
      const cell = (variantId: string): CrossModelRow[keyof CrossModelRow] extends never ? never : { signals: number; pnlUnits: number | null; roiPct: number | null } | null => {
        const m = models.find((x) => x.variantId === variantId);
        const b = m ? pickBreakdown(m).find((x) => x.label === label) : undefined;
        return b ? { signals: b.metrics.signals, pnlUnits: b.metrics.pnlUnits, roiPct: b.metrics.roiPct } : null;
      };
      return {
        label,
        PRIMARY_V1_AVOID_NBA_NHL_COV_CAP: cell("PRIMARY_V1_AVOID_NBA_NHL_COV_CAP"),
        ALT2_TS_SCORE_GE_65: cell("ALT2_TS_SCORE_GE_65"),
        ALT1_CANONICAL_EVENT_GROUPING: cell("ALT1_CANONICAL_EVENT_GROUPING"),
      };
    });
}

export interface BuildOptions {
  rows: readonly Row[];
  classifier: ExecutableFunnelClassifier;
  candidateIds: readonly string[];
  expectedCorpusSha256?: string;
}

/**
 * Builds the sport/market performance slice for the three analyzed models.
 * Row selection is delegated entirely to evaluateHistoricalFunnelVariant
 * (against the classifier's own declared funnel) -- no predicate is
 * reimplemented here. Pure: no fs/env/network access. Throws if
 * expectedCorpusSha256 is supplied and does not match.
 */
export function buildSportMarketPerformanceSlice(options: BuildOptions): SportMarketPerformanceSlice {
  const { rows, classifier, candidateIds, expectedCorpusSha256 } = options;

  const corpusSha256 = computeCorpusHash(rows);
  if (expectedCorpusSha256 && corpusSha256 !== expectedCorpusSha256) {
    throw new Error(`sport/market performance slice: corpus hash mismatch (expected ${expectedCorpusSha256}, computed ${corpusSha256})`);
  }

  const models: ModelSlice[] = candidateIds.map((variantId) => {
    if (!getBundle(classifier, variantId)) {
      throw new Error(`sport/market performance slice: unknown bundle ${variantId}`);
    }
    const evalResult = evaluateHistoricalFunnelVariant(rows, classifier, variantId);
    const selected = evalResult.selectedRows;
    const roi = computeFlatStakeRoiSummary([...selected], { strict: false, stakeUnits: 1 });

    const sportBreakdown = bucketByLabel(selected, (row) => {
      const c = classifySport(row);
      return { label: c.sportKey, confidence: c.classificationConfidence };
    });
    const marketTypeBreakdown = bucketByLabel(selected, (row) => {
      const c = classifyMarketType(row);
      return { label: c.marketKey, confidence: c.classificationConfidence };
    });

    return {
      variantId,
      outputRows: selected.length,
      overallPnlUnits: roi.totalPnlUnits,
      overallRoiPct: roi.roiPct,
      sportBreakdown,
      marketTypeBreakdown,
      leaders: {
        topSportsByRoi: topByRoi(sportBreakdown, 3),
        topSportsByPnl: topByPnl(sportBreakdown, 3),
        topMarketsByRoi: topByRoi(marketTypeBreakdown, 3),
        topMarketsByPnl: topByPnl(marketTypeBreakdown, 3),
        worstSportsByPnl: worstByPnl(sportBreakdown, 3),
        worstMarketsByPnl: worstByPnl(marketTypeBreakdown, 3),
      },
      eventConcentration: computeEventConcentration(selected),
      selectedRowsForVerificationOnly: selected,
    };
  });

  return {
    schemaVersion: 1,
    corpusRowCount: rows.length,
    models,
    crossModelSportMatrix: buildCrossModelMatrix(models, (m) => m.sportBreakdown),
    crossModelMarketMatrix: buildCrossModelMatrix(models, (m) => m.marketTypeBreakdown),
    classificationCoverage: {
      sport: coverageOf(rows, classifySport),
      marketType: coverageOf(rows, classifyMarketType),
    },
  };
}
