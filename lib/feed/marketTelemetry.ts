import type { LandingCardDiagnostics } from "./types";

export type MarketTelemetryAtObservation = NonNullable<LandingCardDiagnostics["marketTelemetry"]>;

export const ODDS_DECIMAL_SEMANTIC = "derived:1/selected_probability" as const;
export const MARKET_TELEMETRY_CAPTURE_SOURCE = "gamma_market_payload_at_enrichment" as const;

// The Gamma market payload carries market-level top-of-book values. The
// normalized candidate is then fanned out into independent candidates for BOTH
// opposite outcome/token identities, so these values can never be claimed as
// selected-token executable BBO without a proven token mapping (none exists in
// current source; deriving one from array position is forbidden).
export const GAMMA_BBO_SEMANTIC = "gamma_market_level_bbo_not_token_authority" as const;

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function decimalOddsFromProbability(price: number | null | undefined): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Math.round((1 / price) * 10_000) / 10_000;
}

function gammaMarketSpreadFromBbo(
  bestBid: number | null,
  bestAsk: number | null
): number | null {
  if (bestBid === null || bestAsk === null || bestAsk < bestBid) return null;
  return Math.round((bestAsk - bestBid) * 1_000_000) / 1_000_000;
}

export function buildMarketTelemetryAtObservation(
  market: unknown,
  selectedProbability: number | null | undefined
): MarketTelemetryAtObservation {
  const raw = (market ?? {}) as Record<string, unknown>;
  const bestBid = finiteOrNull(raw.bestBid);
  const bestAsk = finiteOrNull(raw.bestAsk);
  return {
    v: "v1",
    gamma_market_best_bid_num: bestBid,
    gamma_market_best_ask_num: bestAsk,
    gamma_market_spread_num: gammaMarketSpreadFromBbo(bestBid, bestAsk),
    gamma_bbo_semantic: GAMMA_BBO_SEMANTIC,
    odds_decimal_num: decimalOddsFromProbability(selectedProbability),
    odds_decimal_semantic: ODDS_DECIMAL_SEMANTIC,
    capture_source: MARKET_TELEMETRY_CAPTURE_SOURCE,
  };
}
