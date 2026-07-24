import test from "node:test";
import assert from "node:assert/strict";
import { createCanonicalWeatherIdentity } from "../../lib/weather/canonicalIdentity";

const input = { countryCode: "US", stationAuthority: "NOAA", stationId: "KJFK", measurementType: "daily_max", localMeasurementDate: "2026-07-24", measurementWindowStartLocal: "2026-07-24T00:00:00", measurementWindowEndLocal: "2026-07-24T23:59:59", timezone: "America/New_York", canonicalUnit: "fahrenheit", settlementSemanticsVersion: "weather-settlement.v1" };
test("canonical identity requires and retains every semantic component in stable order", () => {
  const a = createCanonicalWeatherIdentity(input);
  const b = createCanonicalWeatherIdentity({ canonicalUnit: "fahrenheit", timezone: "America/New_York", measurementWindowEndLocal: "2026-07-24T23:59:59", measurementWindowStartLocal: "2026-07-24T00:00:00", localMeasurementDate: "2026-07-24", measurementType: "daily_max", stationId: "KJFK", stationAuthority: "NOAA", countryCode: "US", settlementSemanticsVersion: "weather-settlement.v1" });
  assert.equal(a.id, b.id);
  assert.deepEqual(Object.keys(a.components), ["countryCode", "stationAuthority", "stationId", "measurementType", "localMeasurementDate", "measurementWindowStartLocal", "measurementWindowEndLocal", "timezone", "canonicalUnit", "settlementSemanticsVersion"]);
  assert.deepEqual(a.components, input);
  for (const key of Object.keys(input) as (keyof typeof input)[]) assert.throws(() => createCanonicalWeatherIdentity({ ...input, [key]: "" }));
  for (const key of Object.keys(input) as (keyof typeof input)[]) {
    const changed = key === "localMeasurementDate" ? "2026-07-25" : key === "measurementWindowStartLocal" ? "2026-07-25T00:00:00" : key === "measurementWindowEndLocal" ? "2026-07-25T23:59:59" : `${input[key]}-changed`;
    assert.notEqual(a.id, createCanonicalWeatherIdentity({ ...input, [key]: changed }).id);
  }
});
