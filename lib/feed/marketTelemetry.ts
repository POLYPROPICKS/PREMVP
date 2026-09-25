import type { LandingCardDiagnostics } from "./types";

export type MarketTelemetryAtObservation = NonNullable<LandingCardDiagnostics["marketTelemetry"]>;

export const ODDS_DECIMAL_SEMANTIC = "derived:1/selected_probability" as const;
export const MARKET_TELEMETRY_CAPTURE_SOURCE = "gamma_market_payload_at_enrichment" as const;

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function decimalOddsFromProbability(price: number | null | undefined): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return Math.round((1 / price) * 10_000) / 10_000;
}

export function buildMarketTelemetryAtObservation(
  market: unknown,
  selectedProbability: number | null | undefined
): MarketTelemetryAtObservation {
  const raw = (market ?? {}) as Record<string, unknown>;
  const bestBid = finiteOrNull(raw.bestBid);
  const bestAsk = finiteOrNull(raw.bestAsk);
  const spread = finiteOrNull(raw.spread);
  return {
    v: "v1",
    best_bid_num: bestBid,
    best_ask_num: bestAsk,
    market_spread_num: spread,
    odds_decimal_num: decimalOddsFromProbability(selectedProbability),
    odds_decimal_semantic: ODDS_DECIMAL_SEMANTIC,
    capture_source: MARKET_TELEMETRY_CAPTURE_SOURCE,
  };
}
