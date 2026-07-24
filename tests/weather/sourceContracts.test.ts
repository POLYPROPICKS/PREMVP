import test from "node:test";
import assert from "node:assert/strict";
import { POLYMARKET_GAMMA_WEATHER_V1 } from "../../lib/weather/source-contracts/polymarketGammaWeather.v1";
import { POLYMARKET_CLOB_TOP_BOOK_V1 } from "../../lib/weather/source-contracts/polymarketClobTopBook.v1";
import { hashSourceContract } from "../../lib/weather/types";
test("source contracts are immutable, distinct and deterministic", () => {
  assert.notEqual(POLYMARKET_GAMMA_WEATHER_V1.id, POLYMARKET_CLOB_TOP_BOOK_V1.id);
  assert.equal(POLYMARKET_GAMMA_WEATHER_V1.contractHash, hashSourceContract(POLYMARKET_GAMMA_WEATHER_V1));
  assert.throws(() => { (POLYMARKET_GAMMA_WEATHER_V1 as { venue: string }).venue = "other"; });
});
