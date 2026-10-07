// VALUE_RANKING_V1 — typed EXTERNAL fair-probability contract + deterministic de-vig.
//
// Pure. No provider, no I/O, no credential. PREMVP currently has NO independent pre-event probability carrier
// (DISPLAY_ODDS is a Polymarket-derived proxy; pre_event_score is "NOT a real win probability"), so production
// candidates resolve to VALUE_REFERENCE_UNPROVEN. This module is the narrow seam a future bookmaker-odds
// adapter plugs into: it accepts only a COMPLETE, exact, fresh, Polymarket-independent market and de-vigs it:
//
//   q_i = 1 / decimal_odds_i        fair_i = q_i / SUM(q over the complete market)
//
// Polymarket prices (T40 / T20 / midpoint / exactMarketReference) are MARKET PRICE EVIDENCE and are rejected here
// as a fair-probability source. There is no fill probability anywhere in this module.

export type FairMarketType = "MONEYLINE" | "SPREAD" | "TOTAL" | "TOTAL_CORNERS";
export type FairOutcome = "HOME" | "DRAW" | "AWAY" | "OVER" | "UNDER";

export const FAIR_PERIOD_FULL_MATCH = "FULL_MATCH" as const;
export const DEFAULT_FAIR_MAX_AGE_MS = 30 * 60 * 1000;

/** The exact market a PREMVP candidate token settles on. SPREAD line is HOME-perspective (caller-normalised). */
export type FairTarget = {
  physicalEventId: string;
  kickoffIso: string;
  marketType: FairMarketType;
  line: number | null;
  period: string;
  settlement: string;
  outcome: FairOutcome;
};

/** One bookmaker price. The caller supplies the quotes of exactly ONE market from ONE provider. */
export type BookmakerQuote = {
  kind: "BOOKMAKER_ODDS";
  provider: string;
  /** Must be the literal true; a forged/derived Polymarket quote cannot carry it honestly. */
  independentOfPolymarket: true;
  physicalEventId: string;
  kickoffIso: string;
  marketType: FairMarketType;
  line: number | null;
  period: string;
  settlement: string;
  outcome: FairOutcome;
  decimalOdds: number;
  observedAtIso: string;
};

export type ExternalFairResolution =
  | {
      status: "PROVEN";
      fairProbability: number;
      source: string;
      observedAtIso: string;
      overround: number;
      reason: "EXTERNAL_FAIR_DEVIGGED";
    }
  | { status: "VALUE_REFERENCE_UNPROVEN"; fairProbability: null; source: null; observedAtIso: null; overround: null; reason: string };

const EPS = 1e-9;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const POLYMARKET_RE = /polymarket|clob|gamma|t40|t20|midpoint|exact_?market_?reference/i;
const SETS: Record<string, readonly FairOutcome[]> = {
  MONEYLINE_3WAY: ["HOME", "DRAW", "AWAY"],
  MONEYLINE_2WAY: ["HOME", "AWAY"],
  SPREAD: ["HOME", "AWAY"],
  TOTAL: ["OVER", "UNDER"],
  TOTAL_CORNERS: ["OVER", "UNDER"],
};

export const unproven = (reason: string): ExternalFairResolution =>
  ({ status: "VALUE_REFERENCE_UNPROVEN", fairProbability: null, source: null, observedAtIso: null, overround: null, reason });

/** The complete-outcome set the target's market requires (null => unsupported market). */
function requiredOutcomes(target: FairTarget, quotes: readonly BookmakerQuote[]): readonly FairOutcome[] | null {
  if (target.marketType === "MONEYLINE") {
    // 3-way when any DRAW is quoted or the target is DRAW; otherwise a binary moneyline needs both sides.
    return quotes.some((q) => q.outcome === "DRAW") || target.outcome === "DRAW" ? SETS.MONEYLINE_3WAY : SETS.MONEYLINE_2WAY;
  }
  return SETS[target.marketType] ?? null;
}

/**
 * De-vig the target outcome from one complete, exact, fresh, independent bookmaker market.
 * Fails closed to VALUE_REFERENCE_UNPROVEN with the first violated rule; never invents a probability.
 */
export function resolveExternalFair(
  target: FairTarget,
  quotes: readonly BookmakerQuote[] | null | undefined,
  nowMs: number,
  maxAgeMs: number = DEFAULT_FAIR_MAX_AGE_MS,
): ExternalFairResolution {
  if (!quotes || quotes.length === 0) return unproven("NO_EXTERNAL_FAIR_CARRIER");
  const targetKickoff = Date.parse(target.kickoffIso);
  if (!Number.isFinite(targetKickoff)) return unproven("TARGET_KICKOFF_INVALID");
  if (target.period !== FAIR_PERIOD_FULL_MATCH) return unproven("TARGET_PERIOD_NOT_FULL_MATCH");
  const lineRequired = target.marketType !== "MONEYLINE";
  if (lineRequired && !num(target.line)) return unproven("TARGET_LINE_MISSING");

  const provider = quotes[0].provider;
  for (const q of quotes) {
    if (q.kind !== "BOOKMAKER_ODDS" || q.independentOfPolymarket !== true) return unproven("SOURCE_NOT_INDEPENDENT_BOOKMAKER");
    if (typeof q.provider !== "string" || q.provider === "" || POLYMARKET_RE.test(q.provider)) return unproven("SOURCE_IS_POLYMARKET_DERIVED");
    if (q.provider !== provider) return unproven("MIXED_PROVIDERS");
    if (q.physicalEventId !== target.physicalEventId) return unproven("EVENT_MISMATCH");
    if (Date.parse(q.kickoffIso) !== targetKickoff) return unproven("KICKOFF_MISMATCH");
    if (q.marketType !== target.marketType) return unproven("MARKET_TYPE_MISMATCH");
    if (q.period !== target.period) return unproven("PERIOD_MISMATCH");
    if (q.settlement !== target.settlement) return unproven("SETTLEMENT_MISMATCH");
    if (lineRequired ? !(num(q.line) && Math.abs(q.line - (target.line as number)) <= EPS) : q.line !== null && q.line !== undefined) {
      return unproven("LINE_MISMATCH");
    }
    if (!num(q.decimalOdds) || !(q.decimalOdds > 1)) return unproven("ODDS_INVALID");
    const at = Date.parse(q.observedAtIso);
    if (!Number.isFinite(at)) return unproven("OBSERVED_AT_INVALID");
    if (at > nowMs + 1000) return unproven("OBSERVED_AT_IN_FUTURE");
    if (nowMs - at > maxAgeMs) return unproven("EXTERNAL_FAIR_STALE");
    if (at >= targetKickoff) return unproven("EXTERNAL_FAIR_NOT_PRE_EVENT");
  }

  const required = requiredOutcomes(target, quotes);
  if (!required) return unproven("MARKET_TYPE_UNSUPPORTED");
  const seen = new Map<FairOutcome, BookmakerQuote>();
  for (const q of quotes) {
    if (seen.has(q.outcome)) return unproven("DUPLICATE_OUTCOME");
    seen.set(q.outcome, q);
  }
  if (seen.size !== required.length || !required.every((o) => seen.has(o))) return unproven("INCOMPLETE_EXTERNAL_MARKET");
  if (!seen.has(target.outcome)) return unproven("TARGET_OUTCOME_NOT_QUOTED");

  const total = required.reduce((s, o) => s + 1 / (seen.get(o) as BookmakerQuote).decimalOdds, 0);
  // A complete bookmaker market carries a positive margin; < 1 is incoherent, > 1.5 is not a usable market.
  if (!(total >= 1 - EPS) || total > 1.5) return unproven("OVERROUND_OUT_OF_RANGE");
  const fair = r6(1 / (seen.get(target.outcome) as BookmakerQuote).decimalOdds / total);
  const oldest = quotes.map((q) => q.observedAtIso).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return { status: "PROVEN", fairProbability: fair, source: `BOOKMAKER_ODDS:${provider}`, observedAtIso: oldest, overround: r6(total), reason: "EXTERNAL_FAIR_DEVIGGED" };
}

/** TAKER_EDGE = independent fair probability - fee-inclusive effective cost. Null unless the fair is proven. */
export function takerProvenEdge(fair: ExternalFairResolution | null | undefined, effectiveCost: number | null): number | null {
  return fair?.status === "PROVEN" && num(effectiveCost) ? r6(fair.fairProbability - effectiveCost) : null;
}

/** MAKER_PRICE_EDGE = independent fair probability - maker limit price. No fill probability is modelled. */
export function makerPriceEdge(fair: ExternalFairResolution | null | undefined, limitPrice: number | null): number | null {
  return fair?.status === "PROVEN" && num(limitPrice) ? r6(fair.fairProbability - limitPrice) : null;
}
