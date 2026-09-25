import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMarketTelemetryAtObservation,
  ODDS_DECIMAL_SEMANTIC,
  MARKET_TELEMETRY_CAPTURE_SOURCE,
} from "../../lib/feed/marketTelemetry";

test("captures gamma top-of-book scalars plus derived decimal odds at observation time", () => {
  const telemetry = buildMarketTelemetryAtObservation(
    { bestBid: 0.52, bestAsk: 0.56, spread: 0.04 },
    0.54
  );
  assert.equal(telemetry.v, "v1");
  assert.equal(telemetry.best_bid_num, 0.52);
  assert.equal(telemetry.best_ask_num, 0.56);
  assert.equal(telemetry.market_spread_num, 0.04);
  assert.equal(telemetry.odds_decimal_num, 1.8519);
  assert.equal(telemetry.odds_decimal_semantic, ODDS_DECIMAL_SEMANTIC);
  assert.equal(telemetry.capture_source, MARKET_TELEMETRY_CAPTURE_SOURCE);
});

test("missing optional gamma telemetry fields stay null and are never invented", () => {
  const telemetry = buildMarketTelemetryAtObservation({}, 0.6);
  assert.equal(telemetry.best_bid_num, null);
  assert.equal(telemetry.best_ask_num, null);
  assert.equal(telemetry.market_spread_num, null);
  assert.equal(telemetry.odds_decimal_num, 1.6667);
});

test("market-level spread from the payload is preserved verbatim, never fabricated", () => {
  const telemetry = buildMarketTelemetryAtObservation({ spread: 0.02 }, null);
  assert.equal(telemetry.market_spread_num, 0.02);
  assert.equal(telemetry.odds_decimal_num, null);
});

test("probability outside (0,1) never produces decimal odds", () => {
  assert.equal(buildMarketTelemetryAtObservation({}, 0).odds_decimal_num, null);
  assert.equal(buildMarketTelemetryAtObservation({}, 1).odds_decimal_num, null);
  assert.equal(buildMarketTelemetryAtObservation({}, -0.2).odds_decimal_num, null);
});
