import test from "node:test";
import assert from "node:assert/strict";
import { selectDatasetContract, validateDatasetCompatibility } from "../../lib/weather/datasetContract";
test("dataset selection is explicit and fail closed", () => {
  for (const alias of ["latest", "default", "current", "alias"]) assert.throws(() => selectDatasetContract(alias));
  assert.throws(() => selectDatasetContract(""));
  assert.throws(() => selectDatasetContract("unknown"));
  assert.equal(selectDatasetContract("weather-observations.v1").id, "weather-observations.v1");
});
test("dataset compatibility requires exact versions and declared source contracts", () => {
  const exact = { datasetVersionId: "weather-observations.v1", datasetSchemaVersion: "1", identityContractVersion: "weather-canonical-identity.v1", normalizationVersion: "weather-normalization.v1", sourceContractIds: ["noaa-observations.v1"], sourceContractHashes: ["noaa-hash"] };
  assert.doesNotThrow(() => validateDatasetCompatibility(exact));
  for (const value of ["", "unknown", "latest", "default", "current"]) assert.throws(() => validateDatasetCompatibility({ ...exact, datasetVersionId: value }));
  assert.throws(() => validateDatasetCompatibility({ ...exact, datasetSchemaVersion: "2" }));
  assert.throws(() => validateDatasetCompatibility({ ...exact, identityContractVersion: "weather-canonical-identity.v2" }));
  assert.throws(() => validateDatasetCompatibility({ ...exact, normalizationVersion: "weather-normalization.v2" }));
  assert.throws(() => validateDatasetCompatibility({ ...exact, sourceContractHashes: ["other-hash"] }));
  assert.throws(() => validateDatasetCompatibility({ ...exact, sourceContractIds: ["other-source.v1"] }));
});
