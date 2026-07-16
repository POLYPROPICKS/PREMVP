#!/usr/bin/env -S node --import tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildLockedSequence, canonicalJson, deterministicGzip, EXPECTED_DATASET_SHA256, sha256, validateCanonicalPackage } from "../../../lib/modeling/canonicalDatasetFreeze";

const RELATIVE_ROOT = "modeling/canonical/datasets/2026-07-15-b2f5dfb5963e";
const FIXED_LEDGER = "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/fixed_profile_ledger.json";
const DYNAMIC_LEDGER = "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/dynamic_profile_ledger.json";

function writeJson(root: string, name: string, value: unknown): string {
  const text = canonicalJson(value); writeFileSync(path.join(root, name), text); return sha256(text);
}

export function freezeCanonicalDataset(sourcePath: string, repositoryRoot = process.cwd()) {
  const raw = readFileSync(sourcePath);
  if (sha256(raw) !== EXPECTED_DATASET_SHA256) throw new Error("CANONICAL_CORPUS_SHA_MISMATCH");
  const rows = JSON.parse(raw.toString("utf8")) as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length !== 49_400) throw new Error("CANONICAL_CORPUS_ROW_COUNT_MISMATCH");
  const root = path.join(repositoryRoot, RELATIVE_ROOT); mkdirSync(root, { recursive: true });
  const compressed = deterministicGzip(raw); writeFileSync(path.join(root, "generated_signal_pairs_export.json.gz"), compressed);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const range = (field: string) => { const values = rows.map((row) => row[field]).filter((v): v is string => typeof v === "string" && v.length > 0).sort(); return { min: values[0] ?? null, max: values.at(-1) ?? null, count: values.length, nullCount: rows.length - values.length }; };
  const distinct = (field: string) => [...new Set(rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined && value !== ""))].sort();
  const strict = rows.map((row) => row.condition_id && row.token_id ? `${row.condition_id}::${row.token_id}` : null).filter(Boolean);
  const observed = { inventoryType: "OBSERVED_VALUES_NOT_QUERY_BOUNDARIES", topLevelShape: "array", rowCount: rows.length, fields, fieldNonNullCounts: Object.fromEntries(fields.map((field) => [field, rows.filter((row) => row[field] !== null && row[field] !== undefined && row[field] !== "").length])), timestampRanges: { created_at: range("created_at"), resolved_at: range("resolved_at") }, sportsValues: distinct("sport"), leagueValues: distinct("league"), marketFamilyValues: distinct("market_family"), marketTypeValues: distinct("market_type"), resultValues: distinct("signal_result"), identityStatistics: { uniqueObservationIds: new Set(rows.map((row) => row.id)).size, strictKeyRows: strict.length, uniqueStrictKeys: new Set(strict).size, duplicateStrictKeyRows: strict.length - new Set(strict).size } };
  const contract = { sourceTable: "generated_signal_pairs", queryContractStatus: "PARTIAL", selectedColumnsContract: "scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts#GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS", whereContract: "resolved_at IS NOT NULL AND resolved_at <= exportCutoffResolvedAt", declaredLowerBoundary: null, declaredUpperBoundary: null, boundarySemantics: "LOWER_NOT_DECLARED; UPPER_LTE_AT_EXPORT_START_BUT_EXACT_VALUE_NOT_RECOVERED", timezone: "UTC", ordering: "resolved_at DESC, id DESC", pagination: "KEYSET_RESOLVED_AT_ID; same timestamp id DESC tail then older resolved_at", deduplication: "NO_DEDUP_BEFORE_EXPORT; strict condition_id+token_id projection occurs downstream", resolvedRules: "resolved_at IS NOT NULL", sportsUniverse: "ALL_VALUES_PRESENT_IN_SOURCE_QUERY; NO SPORT FILTER DECLARED", leagueUniverse: "ALL_VALUES_PRESENT_IN_SOURCE_QUERY; NO LEAGUE FILTER DECLARED", marketUniverse: "ALL_VALUES_PRESENT_IN_SOURCE_QUERY; NO MARKET FILTER DECLARED", sourceRevisionEvidence: "snapshot copied at source commit ed1528fa13a9649f6abb94d80eab071cfcc0c191; exact export command and cutoff not recoverable", exportCommandStatus: "NOT_RECOVERABLE_FOR_THIS_SNAPSHOT", exporterSourceFile: "scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts" };
  const fixed = JSON.parse(readFileSync(path.join(repositoryRoot, FIXED_LEDGER), "utf8"));
  const dynamic = JSON.parse(readFileSync(path.join(repositoryRoot, DYNAMIC_LEDGER), "utf8"));
  const sequence = buildLockedSequence(fixed, dynamic);
  const hashes: Record<string, string> = {};
  hashes["dataset_export_contract.json"] = writeJson(root, "dataset_export_contract.json", contract);
  hashes["dataset_observed_inventory.json"] = writeJson(root, "dataset_observed_inventory.json", observed);
  hashes["locked_signal_sequence.json"] = writeJson(root, "locked_signal_sequence.json", sequence);
  hashes["source_lineage.json"] = writeJson(root, "source_lineage.json", { corpusAuthority: "BYTE_FROZEN_SNAPSHOT", exporter: contract.exporterSourceFile, supportingEvidence: ["modeling/evidence/2026-07-15-bankroll-vault-v1_2/dataset_manifest.json", FIXED_LEDGER, DYNAMIC_LEDGER], absoluteOperatorSourceExcluded: true });
  const freezeManifest = { freezeVersion: 1, freezeDate: "2026-07-16", corpusAuthority: "BYTE_FROZEN_SNAPSHOT", rawDatasetSha256: sha256(raw), compressedDatasetSha256: sha256(compressed), rowCount: rows.length, rawByteSize: raw.length, compressedByteSize: compressed.length, sourceTable: contract.sourceTable, declaredLowerBoundary: contract.declaredLowerBoundary, declaredUpperBoundary: contract.declaredUpperBoundary, boundarySemantics: contract.boundarySemantics, timezone: contract.timezone, queryContractStatus: contract.queryContractStatus, sportsUniverse: contract.sportsUniverse, marketUniverse: contract.marketUniverse, resolvedRules: contract.resolvedRules, deduplicationContract: contract.deduplication, T90Contract: "LATEST_SNAPSHOT_AT_OR_BEFORE_EVENT_START_MINUS_90_MINUTES", lockedSequenceCount: sequence.entries.length, lockedSequenceSha256: sequence.lockedSequenceSha256, profileRegistrySha256: "5ead4f1079920aa61488ce34c17efee1736524f9dd5a95c747f2dcb487d1bf34", approvedProfiles: ["FIXED_SAFE_V1", "DYNAMIC_PROTECTED_GROWTH_V1"], historicalEvidenceOnly: true, forwardValidationStatus: "PENDING" };
  hashes["dataset_freeze_manifest.json"] = writeJson(root, "dataset_freeze_manifest.json", freezeManifest);
  const verification = "# Canonical Dataset Freeze V1 verification\n\nThe gzip member deterministically preserves the exact byte-frozen 49,400-row corpus. Query provenance is PARTIAL because the exact export cutoff and command for this snapshot were not recoverable. Historical evidence only; not a forward or live guarantee.\n\nVerify: `node --import tsx scripts/modeling/strategies/freeze-canonical-dataset-v1.ts --verify`\n";
  writeFileSync(path.join(root, "VERIFICATION.md"), verification); hashes["VERIFICATION.md"] = sha256(verification); hashes["generated_signal_pairs_export.json.gz"] = sha256(compressed);
  const manifestPayload = { version: "CANONICAL_DATASET_FREEZE_V1", artifacts: hashes, datasetFreezeManifestSha256: hashes["dataset_freeze_manifest.json"], exportContractSha256: hashes["dataset_export_contract.json"], observedInventorySha256: hashes["dataset_observed_inventory.json"], lockedSequenceSha256: sequence.lockedSequenceSha256 };
  const packageManifestSha256 = sha256(canonicalJson(manifestPayload));
  writeJson(root, "manifest.json", { ...manifestPayload, packageManifestSha256 });
  validateCanonicalPackage(root);
  return { root: RELATIVE_ROOT, ...freezeManifest, packageManifestSha256, artifactHashes: hashes };
}

if (process.argv[2] === "--verify") {
  console.log(JSON.stringify(validateCanonicalPackage(path.join(process.cwd(), RELATIVE_ROOT)), null, 2));
} else if (process.argv[2]) {
  console.log(JSON.stringify(freezeCanonicalDataset(process.argv[2]), null, 2));
} else {
  throw new Error("usage: freeze-canonical-dataset-v1 <external-source-path> | --verify");
}
