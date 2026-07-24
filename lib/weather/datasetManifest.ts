import { sha256 } from "./types";
export interface DatasetMember { ordinal: number; record: unknown; }
export interface DatasetManifestInput { datasetId: string; records: DatasetMember[]; sourceContractHashes: string[]; stationCatalogHash: string; codeSha: string; }
export function createDatasetManifest(input: DatasetManifestInput) {
  if (!input.datasetId || !input.stationCatalogHash || !input.codeSha) throw new Error("manifest requires explicit provenance");
  const records = [...input.records].sort((left, right) => left.ordinal - right.ordinal);
  if (records.some((member, index) => !Number.isInteger(member.ordinal) || (index > 0 && member.ordinal === records[index - 1].ordinal))) throw new Error("dataset member ordinals must be unique integers");
  const contentHash = sha256({ datasetId: input.datasetId, records });
  const manifest = { codeSha: input.codeSha, contentHash, datasetId: input.datasetId, records, sourceContractHashes: [...input.sourceContractHashes].sort(), stationCatalogHash: input.stationCatalogHash };
  return Object.freeze({ ...manifest, manifestHash: sha256(manifest) });
}
