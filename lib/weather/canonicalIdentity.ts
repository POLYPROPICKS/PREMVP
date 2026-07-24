import { sha256 } from "./types";
export interface CanonicalWeatherIdentityInput { countryCode: string; stationAuthority: string; stationId: string; measurementType: string; localMeasurementDate: string; measurementWindowStartLocal: string; measurementWindowEndLocal: string; timezone: string; canonicalUnit: string; settlementSemanticsVersion: string; }
export function createCanonicalWeatherIdentity(input: CanonicalWeatherIdentityInput) {
  for (const [key, value] of Object.entries(input)) if (!value || !value.trim()) throw new Error(`required identity field: ${key}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localMeasurementDate)) throw new Error("localMeasurementDate must be YYYY-MM-DD");
  const components = { countryCode: input.countryCode, stationAuthority: input.stationAuthority, stationId: input.stationId, measurementType: input.measurementType, localMeasurementDate: input.localMeasurementDate, measurementWindowStartLocal: input.measurementWindowStartLocal, measurementWindowEndLocal: input.measurementWindowEndLocal, timezone: input.timezone, canonicalUnit: input.canonicalUnit, settlementSemanticsVersion: input.settlementSemanticsVersion };
  return Object.freeze({ id: `weather:${sha256(components)}`, components: Object.freeze(components) });
}
