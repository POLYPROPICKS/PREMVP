import test from "node:test";
import assert from "node:assert/strict";
import { isMissingTableError } from "../../lib/research-clone/dailySync";

// RESTORE_RESEARCH_CLONE_CURRENT_EVIDENCE_LINEAGE_V1: landing the
// primary_evidence_outbox sync spec ahead of the one-time clone-side schema
// apply (ops/research-clone/primary-evidence-outbox-schema.sql) must never
// break the three tables that already sync successfully today. A missing
// table on the new optional spec degrades to a safe no-op; any other error
// (including on a proven table) must still fail the run closed.

test("recognizes PostgREST/Postgres missing-table errors", () => {
  assert.equal(isMissingTableError(new Error("RESEARCH_CLONE_MAX_WATERMARK_primary_evidence_outbox:PGRST205")), true);
  assert.equal(
    isMissingTableError(new Error('relation "public.primary_evidence_outbox" does not exist')),
    true,
  );
  assert.equal(isMissingTableError(new Error("42P01")), true);
});

test("does not swallow unrelated errors", () => {
  assert.equal(isMissingTableError(new Error("RESEARCH_CLONE_SOURCE_READ_generated_signal_pairs:57014")), false);
  assert.equal(isMissingTableError(new Error("RESEARCH_CLONE_APPEND_ONLY_CONFLICT_primary_evidence_outbox")), false);
  assert.equal(isMissingTableError(new Error("network timeout")), false);
});
