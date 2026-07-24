export interface DatasetContract { id: string; schemaVersion: string; identityContract: "weather-canonical-identity.v1"; normalizationVersion: "weather-normalization.v1"; sourceContractIds: readonly string[]; sourceContractHashes: readonly string[]; }
export interface DatasetCompatibilityInput { datasetVersionId: string; datasetSchemaVersion: string; identityContractVersion: string; normalizationVersion: string; sourceContractIds?: readonly string[]; sourceContractHashes?: readonly string[]; }
const contracts: Record<string, DatasetContract> = Object.freeze({ "weather-observations.v1": Object.freeze({ id: "weather-observations.v1", schemaVersion: "1", identityContract: "weather-canonical-identity.v1", normalizationVersion: "weather-normalization.v1", sourceContractIds: Object.freeze(["noaa-observations.v1"]), sourceContractHashes: Object.freeze(["noaa-hash"]) }) });
export function selectDatasetContract(id: string): DatasetContract { if (!id || /^(latest|default|current|alias)$/i.test(id) || !contracts[id]) throw new Error("explicit known dataset version required"); return contracts[id]; }
export function validateDatasetCompatibility(input: DatasetCompatibilityInput): DatasetContract {
  const contract = selectDatasetContract(input.datasetVersionId);
  if (input.datasetSchemaVersion !== contract.schemaVersion || input.identityContractVersion !== contract.identityContract || input.normalizationVersion !== contract.normalizationVersion) throw new Error("dataset compatibility mismatch");
  if (contract.sourceContractIds.join("\u0000") !== (input.sourceContractIds ?? []).join("\u0000") || contract.sourceContractHashes.join("\u0000") !== (input.sourceContractHashes ?? []).join("\u0000")) throw new Error("source contract compatibility mismatch");
  return contract;
}
