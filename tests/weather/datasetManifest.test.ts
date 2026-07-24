import test from "node:test";
import assert from "node:assert/strict";
import { createDatasetManifest } from "../../lib/weather/datasetManifest";
test("dataset manifest hashes are canonical and sensitivity-aware", () => {
  const base = { datasetId: "weather-observations.v1", records: [{ ordinal: 2, record: { b: null, a: 1 } }, { ordinal: 1, record: { b: 1.5, a: null } }], sourceContractHashes: ["source-b", "source-a"], stationCatalogHash: "stations", codeSha: "abc" };
  const first = createDatasetManifest(base);
  const reordered = createDatasetManifest({ ...base, records: [{ ordinal: 1, record: { a: null, b: 1.5 } }, { ordinal: 2, record: { a: 1, b: null } }], sourceContractHashes: ["source-a", "source-b"] });
  assert.equal(first.manifestHash, reordered.manifestHash);
  assert.deepEqual(first.records.map((member) => member.ordinal), [1, 2]);
  assert.throws(() => createDatasetManifest({ ...base, records: [{ ordinal: 1, record: {} }, { ordinal: 1, record: {} }] }));
  assert.notEqual(createDatasetManifest(base).manifestHash, createDatasetManifest({ ...base, codeSha: "def" }).manifestHash);
  assert.notEqual(first.manifestHash, createDatasetManifest({ ...base, stationCatalogHash: "other-stations" }).manifestHash);
  assert.notEqual(first.manifestHash, createDatasetManifest({ ...base, sourceContractHashes: ["other-source"] }).manifestHash);
});
