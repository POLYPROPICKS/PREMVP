import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_ODDS_MIN,
  SOURCE_ODDS_MAX,
  SOURCE_AGGREGATE_VOLUME_MIN_USD,
  isSourceOddsEligible,
  isSourceAggregateVolumeEligible,
  marketHasSourceEligibleOddsSide,
} from "../../lib/feed/discoverSportsMarkets";

test("BOUNDED_MULTI_IDENTITY_SOURCE_QUALIFICATION_V1", async (t) => {
  await t.test("constants match the authorized bounded corridor", () => {
    assert.equal(SOURCE_ODDS_MIN, 1.30);
    assert.equal(SOURCE_ODDS_MAX, 6.00);
    assert.equal(SOURCE_AGGREGATE_VOLUME_MIN_USD, 1000);
  });

  await t.test("aggregate provider-event volume boundary: 999.99 rejected, 1000 eligible", () => {
    assert.equal(isSourceAggregateVolumeEligible(999.99), false);
    assert.equal(isSourceAggregateVolumeEligible(1000), true);
  });

  await t.test("source decimal odds boundary: 1.29 rejected, 1.30 eligible, 6.00 eligible, 6.01 rejected", () => {
    // price = 1 / odds
    assert.equal(isSourceOddsEligible(1.29), false);
    assert.equal(isSourceOddsEligible(1.30), true);
    assert.equal(isSourceOddsEligible(6.00), true);
    assert.equal(isSourceOddsEligible(6.01), false);
  });

  await t.test("marketHasSourceEligibleOddsSide: true when either side implies eligible odds", () => {
    // price 0.5 -> odds 2.00, inside corridor
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: [0.5, 0.5] }), true);
    // price 0.10 -> odds 10.00 (outside), price 0.90 -> odds 1.111 (outside 1.30 min)
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: [0.10, 0.90] }), false);
    // exact boundary: price for odds 1.30 == 1/1.30 == 0.769231
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: [0.769231, 0.230769] }), true);
    // exact boundary: price for odds 6.00 == 1/6 == 0.166667
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: [0.166667, 0.833333] }), true);
    // malformed input fails closed
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: undefined }), false);
    assert.equal(marketHasSourceEligibleOddsSide({ outcomePrices: [] }), false);
  });

  await t.test("Signal Score's own unchanged corridor (1.35..5.00) is strictly narrower than the source corridor", () => {
    // Source-eligible but scorer-corridor-ineligible: 1.31 and 5.50 legitimately reach
    // the scorer and may return score-null — this is expected, not a defect.
    assert.equal(isSourceOddsEligible(1.31), true);
    assert.equal(isSourceOddsEligible(5.50), true);
  });
});
