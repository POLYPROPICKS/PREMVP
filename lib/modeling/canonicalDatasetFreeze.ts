import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const EXPECTED_DATASET_SHA256 = "b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45";
export const EXPECTED_LOCKED_SEQUENCE_SHA256 = "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string { return `${canonical(value)}\n`; }

export function deterministicGzip(raw: Buffer): Buffer {
  const compressed = gzipSync(raw, { level: 9 });
  compressed.fill(0, 4, 8); // RFC 1952 MTIME=0; Node writes no source filename.
  return compressed;
}

export interface SourceLedgerRow {
  observationId: string;
  decisionAtIso: string;
  resolvedAtIso: string;
}

export function buildLockedSequence(fixed: readonly SourceLedgerRow[], dynamic: readonly SourceLedgerRow[]) {
  if (fixed.length !== 231 || dynamic.length !== 231) throw new Error("LOCKED_SEQUENCE_COUNT_MISMATCH");
  const fixedLedgerOrder = fixed.map((row) => row.observationId);
  const dynamicLedgerOrder = dynamic.map((row) => row.observationId);
  if (JSON.stringify(fixedLedgerOrder) !== JSON.stringify(dynamicLedgerOrder)) throw new Error("LEDGER_SEQUENCE_MISMATCH");
  if (new Set(fixedLedgerOrder).size !== 231) throw new Error("LOCKED_SEQUENCE_DUPLICATE_ID");
  const byId = new Map(fixed.map((row) => [row.observationId, row]));
  const lockedIds = [...fixedLedgerOrder].sort((a, b) => a.localeCompare(b));
  const lockedSequenceSha256 = sha256(canonical(lockedIds));
  if (lockedSequenceSha256 !== EXPECTED_LOCKED_SEQUENCE_SHA256) throw new Error("LOCKED_SEQUENCE_SHA_MISMATCH");
  return {
    version: "CANONICAL_LOCKED_SIGNAL_SEQUENCE_V1",
    orderingContract: "OBSERVATION_ID_LEXICOGRAPHIC_ASC",
    chronologicalLedgerOrderSha256: sha256(canonical(fixedLedgerOrder)),
    lockedSequenceSha256,
    entries: lockedIds.map((observationId, sequenceIndex) => {
      const row = byId.get(observationId)!;
      return { sequenceIndex, observationId, eventMatchIdentity: null, entryTimestamp: row.decisionAtIso, settlementTimestamp: row.resolvedAtIso };
    }),
    sourceLedgerLineage: [
      "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/fixed_profile_ledger.json",
      "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/dynamic_profile_ledger.json",
    ],
    limitation: "SOURCE_LEDGERS_DO_NOT_CONTAIN_EVENT_MATCH_IDENTITY",
  };
}

const REQUIRED_CANONICAL_FILES = ["dataset_freeze_manifest.json", "dataset_export_contract.json", "dataset_observed_inventory.json", "locked_signal_sequence.json", "source_lineage.json", "manifest.json"] as const;

export function validateCanonicalPackage(root: string) {
  if (!existsSync(root)) throw new Error("CANONICAL_PACKAGE_MISSING");
  const gzipPath = path.join(root, "generated_signal_pairs_export.json.gz");
  if (!existsSync(gzipPath)) throw new Error("CANONICAL_PACKAGE_CORPUS_MISSING");
  const compressed = readFileSync(gzipPath);
  const raw = gunzipSync(compressed);
  if (sha256(raw) !== EXPECTED_DATASET_SHA256) throw new Error("CANONICAL_PACKAGE_DATASET_SHA_MISMATCH");
  const rows = JSON.parse(raw.toString("utf8"));
  if (!Array.isArray(rows) || rows.length !== 49_400) throw new Error("CANONICAL_PACKAGE_ROW_COUNT_MISMATCH");
  for (const file of REQUIRED_CANONICAL_FILES) if (!existsSync(path.join(root, file))) throw new Error(`CANONICAL_PACKAGE_FILE_MISSING:${file}`);
  const manifest = JSON.parse(readFileSync(path.join(root, "dataset_freeze_manifest.json"), "utf8"));
  for (const field of ["declaredLowerBoundary", "declaredUpperBoundary", "boundarySemantics", "timezone", "queryContractStatus", "sportsUniverse", "marketUniverse", "resolvedRules", "deduplicationContract", "T90Contract"]) {
    if (!(field in manifest)) throw new Error(`CANONICAL_PACKAGE_MANIFEST_FIELD_MISSING:${field}`);
  }
  const sequence = JSON.parse(readFileSync(path.join(root, "locked_signal_sequence.json"), "utf8"));
  if (sequence.entries?.length !== 231 || sequence.lockedSequenceSha256 !== EXPECTED_LOCKED_SEQUENCE_SHA256) throw new Error("CANONICAL_PACKAGE_SEQUENCE_MISMATCH");
  return { rowCount: rows.length, lockedSequenceCount: sequence.entries.length, canonicalFiles: [...REQUIRED_CANONICAL_FILES] };
}
