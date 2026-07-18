import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { produceFrozenModelProducerV2, validateFrozenModelProducerRows } from "../../lib/modeling/frozenModelProducerV2";
import { loadFrozenAuditInputs } from "../../lib/modeling/postJuneCanonicalFreeze";

const root = process.cwd();

test("frozen producer derives the 124 sequence as the exact order-preserving locked-231 subset", () => {
  const result = produceFrozenModelProducerV2(root);
  assert.equal(result.datasetRows, 49_400);
  assert.equal(result.selectedDecisions.length, 231);
  assert.equal(result.postJuneDecisions.length, 124);
  const locked = new Set(result.selectedDecisions);
  assert.ok(result.postJuneDecisions.every((row) => locked.has(row)));
  assert.deepEqual(result.postJuneDecisions.map((row) => row.observationId), result.selectedDecisions.filter((row) => result.postJuneDecisions.includes(row)).map((row) => row.observationId));
});

test("a post-June raw/audit-only row cannot enter the locked post-June sequence", () => {
  const { corpus, audit } = loadFrozenAuditInputs(root);
  const source = corpus.find((row: { metric_formula_version?: string; id?: string }) => row.metric_formula_version === "v2-lite-growth-safe" && typeof row.id === "string")!;
  const rawAuditOnlyRow = { ...source, id: "raw-audit-only-post-june-identity", token_id: "raw-audit-only-token", created_at: "2026-06-10T12:00:00.000Z", metric_formula_version: "v2-lite-growth-safe", score: 80 };
  const result = produceFrozenModelProducerV2(root, { corpus: [...corpus, rawAuditOnlyRow], audit });
  assert.equal(result.processedInputRows, 49_401);
  assert.ok(!result.selectedDecisions.some((row) => row.observationId === rawAuditOnlyRow.id));
  assert.ok(!result.postJuneDecisions.some((row) => row.observationId === rawAuditOnlyRow.id));
  assert.ok(result.postJuneDecisions.every((row) => result.selectedDecisions.includes(row)));
  assert.deepEqual(
    result.postJuneDecisions.map((row) => row.observationId),
    result.selectedDecisions.filter((row) => result.postJuneDecisions.includes(row)).map((row) => row.observationId),
  );
});

test("frozen producer reproduces canonical identity and execution hashes deterministically", () => {
  const first = produceFrozenModelProducerV2(root);
  const second = produceFrozenModelProducerV2(root);
  assert.equal(first.identitySetHash, "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");
  assert.equal(first.executionSequenceHash, "5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036");
  assert.deepEqual({ ids: second.selectedDecisions.map((row) => row.observationId), identitySetHash: second.identitySetHash, executionSequenceHash: second.executionSequenceHash }, { ids: first.selectedDecisions.map((row) => row.observationId), identitySetHash: first.identitySetHash, executionSequenceHash: first.executionSequenceHash });
});

test("frozen producer validates score, metric version, and strict identity fail-closed", () => {
  const result = produceFrozenModelProducerV2(root);
  assert.deepEqual(result.replayFromRows([...result.selectedDecisions].reverse()), result.selectedDecisions);
  assert.throws(() => result.replayFromRows([{ ...result.selectedDecisions[0], observationId: "" }]), /observation.id/i);
  assert.throws(() => validateFrozenModelProducerRows([{ id: "bad-score", condition_id: "condition", token_id: "token", metric_formula_version: "v2-lite-growth-safe" } as never]), /score/i);
  assert.throws(() => validateFrozenModelProducerRows([{ id: "bad-version", condition_id: "condition", token_id: "token", score: 80, metric_formula_version: "unsupported" } as never]), /metric.*version/i);
  assert.throws(() => validateFrozenModelProducerRows([{ id: "bad-identity", score: 80, metric_formula_version: "v2-lite-growth-safe" } as never]), /identity/i);
});

test("frozen artifacts are an independent membership, execution-order, post-June, and hash oracle", () => {
  const result = produceFrozenModelProducerV2(root);
  const handoff = path.join(root, "modeling/canonical/model-handoff-v1");
  const locked = JSON.parse(readFileSync(path.join(handoff, "locked_execution_sequence.json"), "utf8"));
  const identities = JSON.parse(readFileSync(path.join(handoff, "locked_signal_identity_set.json"), "utf8"));
  const post = JSON.parse(readFileSync(path.join(root, "modeling/evidence/2026-07-17-post-june-canonical-freeze-v1/post_june9_primary_execution_sequence.json"), "utf8"));
  assert.deepEqual(result.selectedDecisions.map((row) => row.observationId), locked.records.map((row: { observationId: string }) => row.observationId));
  assert.deepEqual([...new Set(result.selectedDecisions.map((row) => row.observationId))].sort(), identities.identities);
  assert.deepEqual(result.postJuneDecisions.map((row) => row.observationId), post.ids);
  assert.equal(result.identitySetHash, identities.sha256);
  assert.equal(result.executionSequenceHash, locked.sha256);
});
