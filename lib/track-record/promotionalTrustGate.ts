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
