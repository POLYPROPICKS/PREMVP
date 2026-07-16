import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BANKROLL_PROFILE_REGISTRY, hashBankrollRegistry } from "./bankrollProfileRegistry";

export const DATASET_SHA = "b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45";
export const REGISTRY_SHA = "5ead4f1079920aa61488ce34c17efee1736524f9dd5a95c747f2dcb487d1bf34";
export const IDENTITY_SHA = "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca";
export const EXECUTION_SHA = "5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036";
export const DATASET_DIR = "modeling/canonical/datasets/2026-07-15-b2f5dfb5963e";
export const EVIDENCE_DIR = "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault";

export const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const json = (value: unknown) => `${stable(value)}\n`;

type Ledger = { observationId: string; decisionAtIso: string; resolvedAtIso: string; operatingDay: string; stake: number; entryPrice: number; result: string; netPnl: number; terminalReason: string }[];
const load = <T>(root: string, relative: string): T => JSON.parse(readFileSync(path.join(root, relative), "utf8"));

export function buildCanonicalModelHandoff(root: string) {
  const fixed = load<Ledger>(root, `${EVIDENCE_DIR}/fixed_profile_ledger.json`);
  const dynamic = load<Ledger>(root, `${EVIDENCE_DIR}/dynamic_profile_ledger.json`);
  const fixedLedgerIds = fixed.map((row) => row.observationId);
  const dynamicLedgerIds = dynamic.map((row) => row.observationId);
  if (fixed.length !== 231 || dynamic.length !== 231 || stable(fixedLedgerIds) !== stable(dynamicLedgerIds)) throw new Error("EXECUTION_LEDGER_ORDER_MISMATCH");
  const identities = [...new Set(fixedLedgerIds)].sort((a, b) => a.localeCompare(b));
  const identityHash = sha(stable(identities));
  const executionHash = sha(stable(fixedLedgerIds));
  if (identityHash !== IDENTITY_SHA) throw new Error("IDENTITY_SET_SHA_MISMATCH");
  if (executionHash !== EXECUTION_SHA) throw new Error("EXECUTION_SEQUENCE_SHA_REPRODUCTION_MISMATCH");
  const executionSequence = {
    version: "LOCKED_EXECUTION_SEQUENCE_V1", count: 231, sha256: executionHash,
    serialization: "SHA256(canonical JSON array of observationId in immutable ledger array order; object keys sorted, no whitespace)",
    sourceLedgers: [`${EVIDENCE_DIR}/fixed_profile_ledger.json`, `${EVIDENCE_DIR}/dynamic_profile_ledger.json`],
    records: fixed.map((row, executionSequenceIndex) => ({ executionSequenceIndex, observationId: row.observationId, decisionAtIso: row.decisionAtIso, resolvedAtIso: row.resolvedAtIso, operatingDay: row.operatingDay, stake: row.stake, terminalReason: row.terminalReason })),
  };
  const identitySet = { version: "LOCKED_SIGNAL_IDENTITY_SET_V1", purpose: "MEMBERSHIP_ONLY_NOT_EXECUTION_ORDER", count: 231, sha256: identityHash, serialization: "SHA256(canonical JSON array of unique observationId sorted lexicographically; no whitespace)", identities };
  return { fixed, dynamic, fixedLedgerIds, dynamicLedgerIds, identitySet, executionSequence };
}

export function verifyCanonicalModelHandoff(root: string, out: string) {
  const built = buildCanonicalModelHandoff(root);
  const gzip = readFileSync(path.join(root, DATASET_DIR, "generated_signal_pairs_export.json.gz"));
  const raw = gunzipSync(gzip);
  if (sha(raw) !== DATASET_SHA || JSON.parse(raw.toString()).length !== 49_400) throw new Error("CANONICAL_DATASET_FREEZE_VERIFICATION_FAILED");
  if (hashBankrollRegistry(BANKROLL_PROFILE_REGISTRY).registrySha256 !== REGISTRY_SHA) throw new Error("REGISTRY_SHA_MISMATCH");
  const manifest = load<any>(root, path.relative(root, path.join(out, "manifest.json")));
  const sourceInventory = load<any[]>(root, path.relative(root, path.join(out, "source_hash_inventory.json")));
  const manifestValid = Object.entries(manifest.files as Record<string, string>).every(([file, expected]) => sha(readFileSync(path.join(out, file))) === expected);
  const sourceHashesValid = sourceInventory.every((row) => existsSync(path.join(root, row.path)) && sha(readFileSync(path.join(root, row.path))) === row.sha256);
  const chart = load<any>(root, path.relative(root, path.join(out, "chart_data.json")));
  const fixedCurve = load<any[]>(root, `${EVIDENCE_DIR}/fixed_profile_curve.json`), dynamicCurve = load<any[]>(root, `${EVIDENCE_DIR}/dynamic_profile_curve.json`);
  const chartLineageValid = stable(chart.fixedCapitalCurve) === stable(fixedCurve) && stable(chart.dynamicCapitalCurve) === stable(dynamicCurve) && stable(chart.fixedSettledEvents.map((x: any) => x.observationId)) === stable(built.fixedLedgerIds);
  const corpus = readFileSync(path.join(out, "canonical_model_contract.json"), "utf8") + readFileSync(path.join(out, "offline_plotly_dashboard.html"), "utf8");
  const absolutePathMatches = corpus.match(/[A-Z]:\\|\/tmp\/|\\Users\\/g) ?? [];
  return { identityCount: built.identitySet.count, executionCount: built.executionSequence.count, manifestValid, sourceHashesValid, chartLineageValid, absolutePathMatches };
}
