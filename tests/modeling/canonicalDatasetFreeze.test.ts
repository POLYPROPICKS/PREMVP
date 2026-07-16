import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXPECTED_DATASET_SHA256,
  EXPECTED_LOCKED_SEQUENCE_SHA256,
  buildLockedSequence,
  canonicalJson,
  deterministicGzip,
  sha256,
  validateCanonicalPackage,
} from "../../lib/modeling/canonicalDatasetFreeze";

const root = path.join(process.cwd(), "modeling", "canonical", "datasets", "2026-07-15-b2f5dfb5963e");
const external = "C:/WORK/KalshiProPulse/modeling-snapshots/2026-07-15_b2f5dfb5963e/generated_signal_pairs_export.json";
const fixed = JSON.parse(readFileSync(path.join(process.cwd(), "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/fixed_profile_ledger.json"), "utf8"));
const dynamic = JSON.parse(readFileSync(path.join(process.cwd(), "modeling/evidence/2026-07-16-final-fixed-vs-dynamic-locked-vault/dynamic_profile_ledger.json"), "utf8"));

test("frozen external corpus has exact bytes, SHA and 49,400 rows", () => {
  const raw = readFileSync(external);
  assert.equal(sha256(raw), EXPECTED_DATASET_SHA256);
  assert.equal(JSON.parse(raw.toString("utf8")).length, 49_400);
});

test("deterministic gzip is byte stable and round-trips exact source bytes", () => {
  const raw = readFileSync(external);
  const one = deterministicGzip(raw);
  assert.deepEqual(one, deterministicGzip(raw));
  assert.deepEqual(gunzipSync(one), raw);
});

test("canonical JSON is deterministic and separates declared from observed boundaries", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  const contract = JSON.parse(readFileSync(path.join(root, "dataset_export_contract.json"), "utf8"));
  const observed = JSON.parse(readFileSync(path.join(root, "dataset_observed_inventory.json"), "utf8"));
  assert.equal(contract.queryContractStatus, "PARTIAL");
  assert.equal(contract.declaredUpperBoundary, null);
  assert.ok(observed.timestampRanges.created_at.min);
});

test("both ledgers yield one unique frozen 231-ID sequence and mutation/reorder fails", () => {
  const sequence = buildLockedSequence(fixed, dynamic);
  assert.equal(sequence.entries.length, 231);
  assert.equal(new Set(sequence.entries.map((row) => row.observationId)).size, 231);
  assert.equal(sequence.lockedSequenceSha256, EXPECTED_LOCKED_SEQUENCE_SHA256);
  assert.throws(() => buildLockedSequence(fixed, [...dynamic].reverse()), /LEDGER_SEQUENCE_MISMATCH/);
  const changed = structuredClone(dynamic); changed[0].observationId = "mutated";
  assert.throws(() => buildLockedSequence(fixed, changed), /LEDGER_SEQUENCE_MISMATCH/);
});

test("committed package validates bytes, hashes, required fields and path safety", () => {
  const result = validateCanonicalPackage(root);
  assert.equal(result.rowCount, 49_400);
  assert.equal(result.lockedSequenceCount, 231);
  for (const name of result.canonicalFiles) {
    const text = readFileSync(path.join(root, name), "utf8");
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\/home\//);
    assert.doesNotMatch(text, /guaranteed profit|forward guarantee/i);
  }
});

test("dataset-byte mutation and missing/corrupt compressed artifact fail closed", () => {
  const raw = Buffer.from("abc"); raw[0] ^= 1;
  assert.notEqual(sha256(raw), EXPECTED_DATASET_SHA256);
  assert.throws(() => validateCanonicalPackage(path.join(root, "missing")), /CANONICAL_PACKAGE/);
});

test("module import has no CLI, environment or network side effects", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/modeling/canonicalDatasetFreeze.ts"), "utf8");
  assert.doesNotMatch(source, /process\.env|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /require\.main|import\.meta\.url/);
});
