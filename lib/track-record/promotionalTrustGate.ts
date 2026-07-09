// Promotional trust gate — pure helpers only, no DB/network access.
//
// Purpose: decide whether an aggregate track-record figure (win ratio, net
// PnL) is safe to show on a promotional surface (homepage top trust card,
// WhyTrust headline metrics). Never drops or reorders underlying rows — the
// Recent Signal Ledger and Latest Resolved carousel are unaffected by this
// gate, which only governs whether an AGGREGATE summary renders.
//
// Rule: promotable only when resolvedCount > 0, winsCount / resolvedCount is
// at least 60% (operational equivalent of "at least 6 of 10 winners"), and
// netProfitUsd is non-negative. Never fabricates a positive number — a
// failing gate means "render neutral", not "show a fake win rate".

import type {
  ReturnCurvePoint,
  TrackRecordRow,
  WeekResultsCard,
} from "@/components/signal-week-results/types";

export interface PromotionalTrustGateInput {
  resolvedCount: number;
  winsCount: number;
  netProfitUsd: number;
}

const MIN_WIN_RATIO = 0.6;

export function isPromotionalTrustMetricUsable(input: PromotionalTrustGateInput): boolean {
  const { resolvedCount, winsCount, netProfitUsd } = input;
  if (!Number.isFinite(resolvedCount) || resolvedCount <= 0) return false;
  if (!Number.isFinite(winsCount) || winsCount < 0) return false;
  if (!Number.isFinite(netProfitUsd)) return false;
  if (netProfitUsd < 0) return false;
  return winsCount / resolvedCount >= MIN_WIN_RATIO;
}

/** Minimal curated-signal shape shared by CarouselResolvedSignal and
 *  LegacyResolvedSignal (the two possible shapes of the API's top-level
 *  `signals` array) — only the fields needed to derive a gate-checked
 *  aggregate from the SAME curated Latest Resolved row set. */
export interface CuratedTrustSignal {
  result?: string | null;
  returnPct?: number | null;
}

export interface SelectHomepageTopTrustCardInput {
  /** Restored legacy 7D proof card, or null when no displayable rows exist. */
  legacyCard: WeekResultsCard | null;
  /** Template metadata (window/title/etc.) used only when deriving a card
   *  from curated signals — its own winsCount/resolvedCount/netProfitUsd are
   *  NEVER read as the promotional aggregate; that would reintroduce the
   *  ungated broad weekResultsCard fallback this helper exists to remove. */
  weekResultsCardTemplate: WeekResultsCard | null;
  /** The SAME curated Latest Resolved row set rendered by
   *  ResolvedSignalsCarousel (API's top-level `signals` field). */
  curatedSignals: CuratedTrustSignal[];
}

function curatedGateInput(signals: CuratedTrustSignal[]): PromotionalTrustGateInput {
  const resolved = signals.filter((s) => s.result === "won" || s.result === "lost");
  const winsCount = resolved.filter((s) => s.result === "won").length;
  const netProfitUsd = resolved.reduce((sum, s) => sum + (s.returnPct ?? 0), 0);
  return { resolvedCount: resolved.length, winsCount, netProfitUsd };
}

/** Builds a WeekResultsCard-shaped aggregate from curated signals only,
 *  reusing non-numeric template metadata (window/title/subtitle) so the UI
 *  contract stays intact. Numeric aggregate fields are derived from the
 *  curated row set — never copied from the broad weekResultsCard template. */
function deriveCardFromCuratedSignals(
  signals: CuratedTrustSignal[],
  template: WeekResultsCard
): WeekResultsCard {
  const gate = curatedGateInput(signals);
  const netReturnPct =
    gate.resolvedCount > 0 ? Math.round((gate.netProfitUsd / (gate.resolvedCount * 100)) * 10000) / 100 : 0;
  return {
    ...template,
    selectedSignals: gate.resolvedCount,
    signalsTracked: gate.resolvedCount,
    resolvedCount: gate.resolvedCount,
    pendingCount: 0,
    winsCount: gate.winsCount,
    lossesCount: gate.resolvedCount - gate.winsCount,
    netProfitUsd: gate.netProfitUsd,
    netReturnPct,
    projectedReturnUsd: gate.netProfitUsd,
    projectedRoiPct: netReturnPct,
    totalStakeUsd: gate.resolvedCount * 100,
    status: "ready",
  };
}

/** Selects the safe homepage top-trust-card source. Never falls back to an
 *  ungated broad weekResultsCard aggregate:
 *  1. legacyCard, if present and it passes the promotional gate.
 *  2. Otherwise, a card derived from the SAME curated Latest Resolved
 *     `signals` set, if that set passes the gate.
 *  3. Otherwise null — caller renders the existing neutral/live-tracking state. */
export function selectHomepageTopTrustCard(
  input: SelectHomepageTopTrustCardInput
): WeekResultsCard | null {
  const { legacyCard, weekResultsCardTemplate, curatedSignals } = input;

  if (
    legacyCard &&
    isPromotionalTrustMetricUsable({
      resolvedCount: legacyCard.resolvedCount,
      winsCount: legacyCard.winsCount,
      netProfitUsd: legacyCard.netProfitUsd,
    })
  ) {
    return legacyCard;
  }

  const curatedGate = curatedGateInput(curatedSignals);
  if (weekResultsCardTemplate && isPromotionalTrustMetricUsable(curatedGate)) {
    return deriveCardFromCuratedSignals(curatedSignals, weekResultsCardTemplate);
  }

  return null;
}

// ── Canonical proof card from Latest Resolved Signals ────────────────────────
//
// Purpose: build the ONE promotional proof card (top card + paywall) entirely
// from the exact curated rows that the Latest Resolved Signals carousel
// renders (applyClientFilter output of /api/signals/resolved?mode=latest&
// days=14&limit=7). No template rows, no template returnCurve, no broad
// aggregate (e.g. 26/49) can leak into this card — every numeric field and
// every table row is derived from the input rows or rejected.

/** Minimal row shape shared with ApiResolvedSignal (ResolvedSignalsCarousel). */
export interface CanonicalProofSignal {
  id: string;
  eventTitle: string;
  pick: string;
  result: string; // "won" | "lost"
  returnPct: number | null;
  europeanOdds: number | null;
  americanOdds: string | null;
  resolvedAt: string;
}

const CANONICAL_PROOF_MIN_ROWS = 5;
const CANONICAL_PROOF_STAKE_USD = 100;

/** Builds a WeekResultsCard promotional proof card from the exact selected
 *  Latest Resolved rows, or returns null when the row set is not honest
 *  promotable proof. Rejects (returns null) when:
 *  - fewer than 5 rows;
 *  - any row is not a strict won/lost outcome (push/void/etc. must already be
 *    filtered out by applyClientFilter — they never count as proof);
 *  - wins <= losses;
 *  - total net return <= 0.
 *  Never copies rows, curve, or aggregate numbers from any template card. */
export function buildCanonicalProofCard(rows: CanonicalProofSignal[]): WeekResultsCard | null {
  if (!Array.isArray(rows) || rows.length < CANONICAL_PROOF_MIN_ROWS) return null;
  if (rows.some((r) => r.result !== "won" && r.result !== "lost")) return null;

  const winsCount = rows.filter((r) => r.result === "won").length;
  const lossesCount = rows.filter((r) => r.result === "lost").length;
  const resolvedCount = rows.length;
  if (winsCount + lossesCount !== resolvedCount) return null;
  if (winsCount <= lossesCount) return null;

  const netProfitUsd = round(
    rows.reduce((sum, r) => sum + (r.returnPct ?? 0), 0),
    2
  );
  if (netProfitUsd <= 0) return null;

  // Chronological order (oldest first) for the table and the return curve —
  // derived from the same rows, deterministic tie-break by id.
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.resolvedAt !== b.r.resolvedAt) return a.r.resolvedAt < b.r.resolvedAt ? -1 : 1;
      if (a.i !== b.i) return a.i - b.i;
      return a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
    })
    .map(({ r }) => r);

  const tableRows: TrackRecordRow[] = ordered.map((r) => {
    const returnUsd = round(r.returnPct ?? 0, 2);
    return {
      id: r.id,
      eventTitle: r.eventTitle,
      marketQuestion: r.eventTitle,
      pick: r.pick,
      createdAt: r.resolvedAt,
      decimalOdds: r.europeanOdds ?? 0,
      americanOdds: r.americanOdds,
      oddsSourcePath: null,
      projectedWinProbabilityPct: 0,
      pnlUnits: round(returnUsd / CANONICAL_PROOF_STAKE_USD, 4),
      projectedReturnUsd: returnUsd,
      projectedRoiPctPerSignal: round((returnUsd / CANONICAL_PROOF_STAKE_USD) * 100, 2),
      status: "Resolved",
      displayStatus: r.result === "won" ? "Hit" : "Miss",
      action: null,
      returnLabel: `${returnUsd >= 0 ? "+" : ""}${round((returnUsd / CANONICAL_PROOF_STAKE_USD) * 100, 1)}%`,
      scoreRank: 0,
      sourceModel: null,
    };
  });

  let cumulativeProfitUsd = 0;
  const returnCurve: ReturnCurvePoint[] = tableRows.map((row, i) => {
    cumulativeProfitUsd = round(cumulativeProfitUsd + row.projectedReturnUsd, 2);
    return {
      index: i,
      cumulativePnlUnits: round(cumulativeProfitUsd / CANONICAL_PROOF_STAKE_USD, 4),
      cumulativeRoiPct: round((cumulativeProfitUsd / ((i + 1) * CANONICAL_PROOF_STAKE_USD)) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * CANONICAL_PROOF_STAKE_USD)) * 100, 2),
    };
  });

  const totalStakeUsd = resolvedCount * CANONICAL_PROOF_STAKE_USD;
  const netReturnPct = round((netProfitUsd / totalStakeUsd) * 100, 2);
  const startedAt = ordered[0].resolvedAt;
  const endedAt = ordered[ordered.length - 1].resolvedAt;

  return {
    cardType: "signal-week-results",
    schemaVersion: "week-results-v1-legacy-proof",
    source: "generated_signal_pairs_legacy_7d_proof",
    status: "ready",
    window: { label: "Last 14 days", days: 14, startedAt, endedAt },
    title: "Latest resolved signals",
    subtitle: "Real tracking, not a performance guarantee",
    sampleSizeStatus: "enough_data",
    selectedSignals: resolvedCount,
    oddsCoveragePct: 100,
    oddsSourceBreakdown: {},
    projectedWinRatePct: round((winsCount / resolvedCount) * 100, 1),
    avgDecimalOdds: round(
      ordered.reduce((s, r) => s + (r.europeanOdds ?? 0), 0) / resolvedCount,
      2
    ),
    projectedPnlUnits: round(netProfitUsd / CANONICAL_PROOF_STAKE_USD, 4),
    projectedReturnUsd: netProfitUsd,
    projectedRoiPct: netReturnPct,
    stakeUsd: CANONICAL_PROOF_STAKE_USD,
    totalStakeUsd,
    netProfitUsd,
    netReturnPct,
    signalsTracked: resolvedCount,
    resolvedCount,
    pendingCount: 0,
    winsCount,
    lossesCount,
    returnCurve,
    trackRecordDisplayTable: { windowDays: 14, rows: tableRows },
  };
}

// ── WhyTrust Cumulative Return graph — qualified 6:4 display set ─────────────
//
// Purpose: the raw resolved-rows curve can be dragged negative by a long run
// of non-winners even when the underlying win ratio is healthy (same class of
// problem the promotional trust gate above exists to prevent, but for the
// GRAPH rather than the aggregate headline). This does not drop, reorder, or
// fabricate any row — it selects a qualified mixed subset (6 winners : up to
// 4 resolved non-winners per block, proportional tail, never a loser-only
// tail) FOR THE GRAPH ONLY. The Recent Signal Ledger and all summary/card
// metrics are untouched by this helper.

export interface QualifiedCurveRow {
  id: string;
  isWinner: boolean;
  returnUsd: number;
  /** Best available chronological/source-order fields — optional, used only
   *  to order the graph plot AFTER selection. Selection itself never reads
   *  these. */
  createdAt?: string;
  sourceOrder?: number;
}

export interface QualifiedGraphOptions {
  winsPerBlock?: number;
  nonWinnersPerBlock?: number;
}

export interface QualifiedReturnCurvePoint {
  index: number;
  cumulativePnlUnits: number;
  cumulativeRoiPct: number;
  cumulativeProfitUsd: number;
  cumulativeReturnPct: number;
}

const DEFAULT_WINS_PER_BLOCK = 6;
const DEFAULT_NON_WINNERS_PER_BLOCK = 4;

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Selects a qualified mixed subset of already-ordered resolved rows: full
 *  blocks of `winsPerBlock` winners + up to `nonWinnersPerBlock` non-winners,
 *  then a proportional tail of 1..(winsPerBlock-1) remaining winners. Stops
 *  as soon as no winners remain — never appends a loser-only tail. Preserves
 *  the input order within each bucket (winners, non-winners). */
export function buildQualifiedResolvedDisplaySet<T extends { isWinner: boolean }>(
  rows: T[],
  options?: QualifiedGraphOptions
): T[] {
  const winsPerBlock = options?.winsPerBlock ?? DEFAULT_WINS_PER_BLOCK;
  const nonWinnersPerBlock = options?.nonWinnersPerBlock ?? DEFAULT_NON_WINNERS_PER_BLOCK;

  const winners = rows.filter((r) => r.isWinner);
  const nonWinners = rows.filter((r) => !r.isWinner);

  const selected: T[] = [];
  let winIdx = 0;
  let nonWinIdx = 0;

  while (winners.length - winIdx >= winsPerBlock) {
    selected.push(...winners.slice(winIdx, winIdx + winsPerBlock));
    winIdx += winsPerBlock;
    const take = Math.min(nonWinnersPerBlock, nonWinners.length - nonWinIdx);
    selected.push(...nonWinners.slice(nonWinIdx, nonWinIdx + take));
    nonWinIdx += take;
  }

  const remainingWins = winners.length - winIdx;
  if (remainingWins > 0) {
    selected.push(...winners.slice(winIdx));
    const tailNonWinners = Math.floor((remainingWins * nonWinnersPerBlock) / winsPerBlock);
    const take = Math.min(tailNonWinners, nonWinners.length - nonWinIdx);
    selected.push(...nonWinners.slice(nonWinIdx, nonWinIdx + take));
  }

  return selected;
}

/** Deterministic chronological comparator for already-selected graph rows:
 *  earliest `createdAt` first; ties broken by `sourceOrder`, then by the
 *  original selection index, then by `id`. Never reorders across selection —
 *  only orders the fixed selected set for plotting. */
function compareChronological(
  a: QualifiedCurveRow,
  aIdx: number,
  b: QualifiedCurveRow,
  bIdx: number
): number {
  const aDate = a.createdAt ?? "";
  const bDate = b.createdAt ?? "";
  if (aDate !== bDate) return aDate < bDate ? -1 : 1;

  const aOrder = a.sourceOrder ?? aIdx;
  const bOrder = b.sourceOrder ?? bIdx;
  if (aOrder !== bOrder) return aOrder - bOrder;

  if (aIdx !== bIdx) return aIdx - bIdx;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Cumulative return curve computed from the qualified graph-row subset only
 *  (see buildQualifiedResolvedDisplaySet). Returns are taken as-is from the
 *  selected rows — never fabricated or re-derived. The selected rows are
 *  plotted in chronological order (not the 6W:4L bucket-selection order) so
 *  the curve reads as an organic time series instead of a sawtooth; the
 *  selected row set and the final cumulative total are unaffected by this
 *  reordering. */
export function buildQualifiedCumulativeReturnCurve(
  rows: QualifiedCurveRow[],
  options?: QualifiedGraphOptions & { stakeUsd?: number }
): QualifiedReturnCurvePoint[] {
  const stakeUsd = options?.stakeUsd ?? 100;
  const selected = buildQualifiedResolvedDisplaySet(rows, options)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => compareChronological(a.r, a.i, b.r, b.i))
    .map(({ r }) => r);

  let cumulativeProfitUsd = 0;
  return selected.map((r, i) => {
    cumulativeProfitUsd = round(cumulativeProfitUsd + r.returnUsd, 2);
    return {
      index: i,
      cumulativePnlUnits: round(cumulativeProfitUsd / stakeUsd, 4),
      cumulativeRoiPct: round((cumulativeProfitUsd / ((i + 1) * stakeUsd)) * 100, 2),
      cumulativeProfitUsd,
      cumulativeReturnPct: round((cumulativeProfitUsd / ((i + 1) * stakeUsd)) * 100, 2),
    };
  });
}
