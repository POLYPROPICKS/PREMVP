import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadFrozenAuditInputs } from "../../lib/modeling/postJuneCanonicalFreeze";
import { buildExecutionWaterfall, EXECUTION_WATERFALL_VERSION } from "../../lib/modeling/executionWaterfall";
import { loadExecutableFunnelClassifier } from "../../lib/modeling/executableFunnelClassifier";
import type { ExportRow } from "../../lib/modeling/generatedSignalPairsExportContract";
import { produceForwardLocalShadowDecisions, computeForwardDecisionIdentity } from "../../lib/modeling/forwardLocalShadowProducer";
import { buildEvidenceRecord, readExistingJournal, planAppend, commitAppend, acquireExclusiveLock } from "../../lib/modeling/forwardShadowEvidenceStore";

const root = process.cwd();
const AS_OF = "2026-06-01T00:00:00.000Z";
const PROVENANCE = { snapshotSha256: "a".repeat(64), sourceCommit: "deadbeefcafebabe" };

function stripResolution(row: ExportRow): ExportRow {
  const clean: Record<string, unknown> = { ...row };
  delete clean.resolved_at;
  delete clean.result;
  delete clean.signal_result;
  delete clean.outcome_status;
  delete clean.realized_return_pct;
  delete clean.realizedReturnPct;
  return clean as ExportRow;
}

function realForwardRows(): ExportRow[] {
  const { corpus } = loadFrozenAuditInputs(root);
  const classifier = loadExecutableFunnelClassifier();
  const waterfall = buildExecutionWaterfall(corpus as ExportRow[], classifier);
  return waterfall.executionCandidates.map((candidate) => stripResolution({ ...(candidate.row as ExportRow) }));
}

const REAL_ROWS = realForwardRows();
const ROW_A = REAL_ROWS[0];
const ROW_B = REAL_ROWS[2];

function tempJournal(): { dir: string; journal: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-forward-evidence-"));
  return { dir, journal: path.join(dir, "journal.jsonl") };
}

test("1: a valid explicit forward snapshot produces a decision for a real reused row", () => {
  const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.decisions[0].observationId, ROW_A.id);
  assert.equal(result.waterfallVersion, EXECUTION_WATERFALL_VERSION);
});

test("2: the explicit asOf boundary is normalized and carried onto every decision", () => {
  const result = produceForwardLocalShadowDecisions([ROW_A], "2026-06-01T00:00:00Z");
  assert.equal(result.asOfIso, "2026-06-01T00:00:00.000Z");
  assert.equal(result.decisions[0].asOfIso, "2026-06-01T00:00:00.000Z");
});

test("3: a row with created_at after the explicit asOf is rejected fail-closed", () => {
  const futureRow = { ...ROW_A, created_at: "2026-07-01T00:00:00.000Z" };
  assert.throws(() => produceForwardLocalShadowDecisions([futureRow], AS_OF), /FORWARD_PRODUCER_CREATED_AT_AFTER_AS_OF/);
});

test("4: a row carrying resolved/outcome fields is rejected fail-closed", () => {
  assert.throws(() => produceForwardLocalShadowDecisions([{ ...ROW_A, resolved_at: "2026-06-02T00:00:00.000Z" }], AS_OF), /FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED/);
  assert.throws(() => produceForwardLocalShadowDecisions([{ ...ROW_A, signal_result: "won" }], AS_OF), /FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED/);
  assert.throws(() => produceForwardLocalShadowDecisions([{ ...ROW_A, result: "win" }], AS_OF), /FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED/);
  assert.throws(() => produceForwardLocalShadowDecisions([{ ...ROW_A, outcome_status: "settled" }], AS_OF), /FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED/);
  assert.throws(() => produceForwardLocalShadowDecisions([{ ...ROW_A, realized_return_pct: 12 }], AS_OF), /FORWARD_PRODUCER_LEAKAGE_FIELD_DETECTED/);
});

test("5: a malformed strict identity is rejected fail-closed", () => {
  const bad = { ...ROW_A } as Record<string, unknown>;
  delete bad.condition_id;
  delete bad.token_id;
  assert.throws(() => produceForwardLocalShadowDecisions([bad as ExportRow], AS_OF), /FORWARD_PRODUCER_INVALID_IDENTITY/);
});

test("6: a malformed score is rejected fail-closed", () => {
  const bad = { ...ROW_A, score: undefined, signal_score: undefined, pre_event_score_num: undefined, signal_confidence_num: undefined };
  assert.throws(() => produceForwardLocalShadowDecisions([bad], AS_OF), /FORWARD_PRODUCER_INVALID_SCORE/);
});

test("7: an unsupported metric formula version is rejected fail-closed", () => {
  const bad = { ...ROW_A, metric_formula_version: "unsupported-version" };
  assert.throws(() => produceForwardLocalShadowDecisions([bad], AS_OF), /FORWARD_PRODUCER_UNSUPPORTED_METRIC_FORMULA_VERSION/);
});

test("8: the canonical execution waterfall is reused unmodified for selection", () => {
  const classifier = loadExecutableFunnelClassifier();
  const direct = buildExecutionWaterfall([ROW_A], classifier);
  const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
  assert.deepEqual(result.decisions.map((d) => d.observationId).sort(), direct.executionCandidates.map((c) => c.observationId).sort());
});

test("9: input-order independence produces identical decisions and identities", () => {
  const forward = produceForwardLocalShadowDecisions([ROW_A, ROW_B], AS_OF);
  const reversed = produceForwardLocalShadowDecisions([ROW_B, ROW_A], AS_OF);
  assert.equal(forward.decisions.length, 2);
  assert.deepEqual(forward.decisions, reversed.decisions);
});

test("10: semantic decision identity excludes snapshot SHA and file formatting", () => {
  const fields = { observationId: "obs-1", asOfIso: "2026-06-01T00:00:00.000Z", waterfallVersion: EXECUTION_WATERFALL_VERSION, classifierRegistrySha: "abc", metricFormulaVersion: "v2-lite-growth-safe" };
  assert.equal(computeForwardDecisionIdentity(fields), computeForwardDecisionIdentity({ ...fields }));
  const result1 = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
  const result2 = produceForwardLocalShadowDecisions([{ ...ROW_A }], AS_OF);
  assert.deepEqual(result1.decisions.map((d) => d.decisionId), result2.decisions.map((d) => d.decisionId));
  const record1 = buildEvidenceRecord(result1.decisions[0], { snapshotSha256: "a".repeat(64), sourceCommit: "c1" });
  const record2 = buildEvidenceRecord(result2.decisions[0], { snapshotSha256: "b".repeat(64), sourceCommit: "c2" });
  assert.equal(record1.decisionId, record2.decisionId);
});

test("11: a different explicit asOf changes the decision identity", () => {
  const a = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
  const b = produceForwardLocalShadowDecisions([ROW_A], "2026-06-02T00:00:00.000Z");
  assert.notEqual(a.decisions[0].decisionId, b.decisions[0].decisionId);
});

test("12: the producer module contains no filesystem-mutating calls (historical frozen artifacts cannot be touched)", () => {
  const source = readFileSync(path.join(root, "lib/modeling/forwardLocalShadowProducer.ts"), "utf8");
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|rmSync|unlinkSync|mkdirSync|rmdirSync|openSync/);
});

test("13: first append writes exactly the produced decisions", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
    const records = result.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
    const outcome = commitAppend(journal, planAppend(readExistingJournal(journal), records));
    assert.equal(outcome.appended, records.length);
    assert.ok(existsSync(journal));
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    assert.equal(lines.length, records.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("14: an exact rerun is a no-op and leaves the journal byte-identical", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
    const records = result.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
    commitAppend(journal, planAppend(readExistingJournal(journal), records));
    const before = readFileSync(journal, "utf8");
    const secondOutcome = commitAppend(journal, planAppend(readExistingJournal(journal), records));
    const after = readFileSync(journal, "utf8");
    assert.equal(secondOutcome.appended, 0);
    assert.equal(secondOutcome.existing, records.length);
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("15+20: a conflicting duplicate identity throws and causes zero partial writes for the whole batch", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A, ROW_B], AS_OF);
    const [recA, recB] = result.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
    commitAppend(journal, planAppend(readExistingJournal(journal), [recA]));
    const before = readFileSync(journal, "utf8");
    const conflictingDecision = { ...result.decisions[0], finalScore: result.decisions[0].finalScore + 1 };
    const recAConflict = buildEvidenceRecord(conflictingDecision, PROVENANCE);
    assert.throws(() => planAppend(readExistingJournal(journal), [recAConflict, recB]), /FORWARD_EVIDENCE_CONFLICTING_DUPLICATE/);
    const after = readFileSync(journal, "utf8");
    assert.equal(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("16: a corrupt middle line in the journal fails closed", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A, ROW_B], AS_OF);
    const records = result.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
    const content = `${JSON.stringify(records[0])}\n{not valid json\n${JSON.stringify(records[1])}\n`;
    writeFileSync(journal, content, "utf8");
    assert.throws(() => readExistingJournal(journal), /FORWARD_EVIDENCE_CORRUPT_LINE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("17: a corrupt final line in the journal fails closed", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
    const records = result.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
    const content = `${JSON.stringify(records[0])}\n{truncated-tail\n`;
    writeFileSync(journal, content, "utf8");
    assert.throws(() => readExistingJournal(journal), /FORWARD_EVIDENCE_CORRUPT_LINE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("18: a stored payload-hash mismatch fails closed", () => {
  const { dir, journal } = tempJournal();
  try {
    const result = produceForwardLocalShadowDecisions([ROW_A], AS_OF);
    const record = buildEvidenceRecord(result.decisions[0], PROVENANCE);
    const tampered = { ...record, finalScore: record.finalScore + 1 };
    writeFileSync(journal, `${JSON.stringify(tampered)}\n`, "utf8");
    assert.throws(() => readExistingJournal(journal), /FORWARD_EVIDENCE_CORRUPT_LINE.*payload_hash_mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("19: the append batch order is deterministic regardless of input row order", () => {
  const forward = produceForwardLocalShadowDecisions([ROW_A, ROW_B], AS_OF);
  const reversed = produceForwardLocalShadowDecisions([ROW_B, ROW_A], AS_OF);
  const recsForward = forward.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
  const recsReversed = reversed.decisions.map((d) => buildEvidenceRecord(d, PROVENANCE));
  const { dir, journal } = tempJournal();
  try {
    const planA = planAppend(readExistingJournal(journal), recsForward);
    const planB = planAppend(readExistingJournal(journal), recsReversed);
    assert.deepEqual(planA.toAppend.map((r) => r.decisionId), planB.toAppend.map((r) => r.decisionId));
    assert.deepEqual([...planA.toAppend.map((r) => r.decisionId)].sort(), planA.toAppend.map((r) => r.decisionId));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: acquiring an exclusive lock twice on the same journal fails closed", () => {
  const { dir, journal } = tempJournal();
  try {
    const lock = acquireExclusiveLock(journal);
    assert.throws(() => acquireExclusiveLock(journal), /FORWARD_EVIDENCE_JOURNAL_LOCKED/);
    lock.release();
    const lock2 = acquireExclusiveLock(journal);
    lock2.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
