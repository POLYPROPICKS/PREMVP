import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { stable, sha } from "./canonicalModelHandoff";
import type { ForwardShadowDecision } from "./forwardLocalShadowProducer";

export const FORWARD_SHADOW_EVIDENCE_SCHEMA_VERSION = "FORWARD_LOCAL_SHADOW_EVIDENCE_V1" as const;

export interface ForwardShadowEvidenceProvenance {
  snapshotSha256: string;
  sourceCommit: string;
}

export interface ForwardShadowEvidenceRecord {
  schemaVersion: typeof FORWARD_SHADOW_EVIDENCE_SCHEMA_VERSION;
  decisionId: string;
  observationId: string;
  asOfIso: string;
  snapshotSha256: string;
  sourceCommit: string;
  waterfallVersion: string;
  classifierRegistrySha: string;
  metricFormulaVersion: string;
  matchKey: string;
  decisionAtIso: string;
  createdAtIso: string;
  finalScore: number;
  dataCoverage: number;
  entryPrice: number;
  payloadHash: string;
}

const REQUIRED_FIELDS = [
  "schemaVersion", "decisionId", "observationId", "asOfIso", "snapshotSha256", "sourceCommit",
  "waterfallVersion", "classifierRegistrySha", "metricFormulaVersion", "matchKey", "decisionAtIso",
  "createdAtIso", "finalScore", "dataCoverage", "entryPrice", "payloadHash",
] as const;

function computePayloadHash(recordWithoutHash: Omit<ForwardShadowEvidenceRecord, "payloadHash">): string {
  return sha(stable(recordWithoutHash));
}

export function buildEvidenceRecord(decision: ForwardShadowDecision, provenance: ForwardShadowEvidenceProvenance): ForwardShadowEvidenceRecord {
  const withoutHash = {
    schemaVersion: FORWARD_SHADOW_EVIDENCE_SCHEMA_VERSION,
    decisionId: decision.decisionId,
    observationId: decision.observationId,
    asOfIso: decision.asOfIso,
    snapshotSha256: provenance.snapshotSha256,
    sourceCommit: provenance.sourceCommit,
    waterfallVersion: decision.waterfallVersion,
    classifierRegistrySha: decision.classifierRegistrySha,
    metricFormulaVersion: decision.metricFormulaVersion,
    matchKey: decision.matchKey,
    decisionAtIso: decision.decisionAtIso,
    createdAtIso: decision.createdAtIso,
    finalScore: decision.finalScore,
    dataCoverage: decision.dataCoverage,
    entryPrice: decision.entryPrice,
  };
  return { ...withoutHash, payloadHash: computePayloadHash(withoutHash) };
}

export function parseJournalLine(line: string, lineNumber: number): ForwardShadowEvidenceRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`FORWARD_EVIDENCE_CORRUPT_LINE:line=${lineNumber}:reason=invalid_json`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`FORWARD_EVIDENCE_CORRUPT_LINE:line=${lineNumber}:reason=not_object`);
  }
  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) throw new Error(`FORWARD_EVIDENCE_CORRUPT_LINE:line=${lineNumber}:reason=missing_field_${field}`);
  }
  const { payloadHash, ...rest } = record;
  if (typeof payloadHash !== "string" || computePayloadHash(rest as Omit<ForwardShadowEvidenceRecord, "payloadHash">) !== payloadHash) {
    throw new Error(`FORWARD_EVIDENCE_CORRUPT_LINE:line=${lineNumber}:reason=payload_hash_mismatch`);
  }
  return record as unknown as ForwardShadowEvidenceRecord;
}

export interface ExistingJournal {
  identities: Map<string, ForwardShadowEvidenceRecord>;
  lineCount: number;
}

export function readExistingJournal(journalPath: string): ExistingJournal {
  const identities = new Map<string, ForwardShadowEvidenceRecord>();
  if (!existsSync(journalPath)) return { identities, lineCount: 0 };
  const raw = readFileSync(journalPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    const record = parseJournalLine(line, index + 1);
    const existing = identities.get(record.decisionId);
    if (existing && existing.payloadHash !== record.payloadHash) {
      throw new Error(`FORWARD_EVIDENCE_CORRUPT_LINE:line=${index + 1}:reason=duplicate_identity_conflict_${record.decisionId}`);
    }
    identities.set(record.decisionId, record);
  });
  return { identities, lineCount: lines.length };
}

export interface AppendPlan {
  toAppend: ForwardShadowEvidenceRecord[];
  existingCount: number;
}

export function planAppend(existing: ExistingJournal, newRecords: readonly ForwardShadowEvidenceRecord[]): AppendPlan {
  const seenInBatch = new Map<string, ForwardShadowEvidenceRecord>();
  const toAppend: ForwardShadowEvidenceRecord[] = [];
  for (const record of newRecords) {
    const inBatch = seenInBatch.get(record.decisionId);
    if (inBatch && inBatch.payloadHash !== record.payloadHash) {
      throw new Error(`FORWARD_EVIDENCE_CONFLICTING_DUPLICATE:decisionId=${record.decisionId}:scope=batch`);
    }
    seenInBatch.set(record.decisionId, record);
    const existingRecord = existing.identities.get(record.decisionId);
    if (existingRecord) {
      if (existingRecord.payloadHash !== record.payloadHash) {
        throw new Error(`FORWARD_EVIDENCE_CONFLICTING_DUPLICATE:decisionId=${record.decisionId}:scope=journal`);
      }
      continue;
    }
    if (!toAppend.some((appended) => appended.decisionId === record.decisionId)) toAppend.push(record);
  }
  return { toAppend, existingCount: existing.identities.size };
}

export function commitAppend(journalPath: string, plan: AppendPlan): { appended: number; existing: number } {
  if (plan.toAppend.length === 0) return { appended: 0, existing: plan.existingCount };
  const lines = plan.toAppend.map((record) => `${JSON.stringify(record)}\n`).join("");
  appendFileSync(journalPath, lines, { encoding: "utf8", flag: "a" });
  return { appended: plan.toAppend.length, existing: plan.existingCount };
}

export interface JournalLock {
  lockPath: string;
  release: () => void;
}

export function acquireExclusiveLock(journalPath: string): JournalLock {
  const lockPath = `${journalPath}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error(`FORWARD_EVIDENCE_JOURNAL_LOCKED:path=${lockPath}`);
  }
  closeSync(fd);
  let released = false;
  return {
    lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        // already removed
      }
    },
  };
}
