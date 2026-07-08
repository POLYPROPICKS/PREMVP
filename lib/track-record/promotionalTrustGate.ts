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

import type { WeekResultsCard } from "@/components/signal-week-results/types";

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
  /** Broad read-model card — accepted for shape compatibility but NEVER used
   *  as a promotional source: neither its aggregate nor its rows may leak
   *  into the promotional card (that reintroduces the ungated broad
   *  weekResultsCard fallback this helper exists to remove). */
  weekResultsCardTemplate: WeekResultsCard | null;
  /** Curated Latest Resolved row set (API's top-level `signals` field) —
   *  accepted for shape compatibility; no card is derived from it because a
   *  derived headline cannot render matching chips/chart rows. */
  curatedSignals: CuratedTrustSignal[];
}

function cardTableRows(card: WeekResultsCard): Array<{
  displayStatus?: string;
  projectedReturnUsd?: number;
}> {
  const table = card.trackRecordDisplayTable as unknown;
  if (Array.isArray(table)) return table;
  const rows = (table as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/** True only when the card's headline aggregate is derivable from its OWN
 *  visible rows: resolvedCount === rows.length, winsCount === Hit rows,
 *  lossesCount === non-Hit rows, and netProfitUsd === sum of the rows'
 *  projectedReturnUsd (within $0.01 rounding). A card whose headline (e.g.
 *  5/7) does not match its chips/chart rows is never promotable — that class
 *  of mismatch is exactly what this check exists to reject. */
export function isInternallyConsistentProofCard(card: WeekResultsCard): boolean {
  const rows = cardTableRows(card);
  if (rows.length === 0) return false;
  const hits = rows.filter((r) => r.displayStatus === "Hit").length;
  if (card.resolvedCount !== rows.length) return false;
  if (card.winsCount !== hits) return false;
  if (card.lossesCount !== rows.length - hits) return false;
  const rowNet = rows.reduce((sum, r) => sum + (r.projectedReturnUsd ?? 0), 0);
  if (!Number.isFinite(card.netProfitUsd)) return false;
  return Math.abs(card.netProfitUsd - rowNet) <= 0.01;
}

/** Selects the safe homepage top-trust-card source. Never falls back to an
 *  ungated broad weekResultsCard aggregate, and never derives a headline from
 *  one row set while rendering chips/chart from another (that produced the
 *  "5/7 headline over mismatched chips" regression):
 *  1. legacyCard, if present, internally consistent with its own rows, and it
 *     passes the promotional gate.
 *  2. Otherwise null — caller renders the existing neutral/live-tracking
 *     state, never a broad aggregate or a template-derived hybrid. */
export function selectHomepageTopTrustCard(
  input: SelectHomepageTopTrustCardInput
): WeekResultsCard | null {
  const { legacyCard } = input;

  if (
    legacyCard &&
    isInternallyConsistentProofCard(legacyCard) &&
    isPromotionalTrustMetricUsable({
      resolvedCount: legacyCard.resolvedCount,
      winsCount: legacyCard.winsCount,
      netProfitUsd: legacyCard.netProfitUsd,
    })
  ) {
    return legacyCard;
  }

  return null;
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
