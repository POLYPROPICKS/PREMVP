// Phase 3E.2j Commit B -- event-identity evidence gate tests.
//
// Locked operator decision: strict market/outcome dedup is untouched.
// A match with two markets (moneyline, total-goals) remains two strict
// signals and two markets -- it is only "one sporting event" when the
// identity evidence actually supports it. Confidence is classified from
// which field-priority tier supplied the identity; conflicting strong/
// medium evidence must never be silently resolved by falling back to a
// weaker field.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEventIdentityEvidence,
  buildEventIdentityEvidenceSummary,
} from "../../scripts/modeling/strategies/audit-generated-signal-pairs-corpus";

test("B1: match_family_key is STRONG and takes top priority", () => {
  const row = { match_family_key: "barca-real-2024-03-01", condition_id: "c1" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "STRONG");
  assert.equal(evidence.sourceField, "match_family_key");
});

test("B2: top-level field takes precedence over a diagnostics alias for the same field", () => {
  const row = {
    match_family_key: "top-level-value",
    diagnostics: { matchFamilyKey: "diagnostics-value" },
  };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.sourceLocation, "top_level");
});

test("B3: a diagnostics alias is used when no top-level field is present", () => {
  const row = { diagnostics: { canonicalEventKey: "canon-123" } };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "STRONG");
  assert.equal(evidence.sourceField, "canonical_event_key");
  assert.equal(evidence.sourceLocation, "diagnostics");
});

test("B4: Barcelona-Real scenario -- moneyline and total-goals rows share one event, two strict markets", () => {
  const moneyline = {
    match_family_key: "barca-real-2024-03-01",
    condition_id: "moneyline-cond",
    token_id: "moneyline-tok",
  };
  const totalGoals = {
    match_family_key: "barca-real-2024-03-01",
    condition_id: "total-goals-cond",
    token_id: "total-goals-tok",
  };
  const e1 = extractEventIdentityEvidence(moneyline);
  const e2 = extractEventIdentityEvidence(totalGoals);
  assert.equal(e1.eventKey, e2.eventKey);
  assert.notEqual(moneyline.condition_id, totalGoals.condition_id);
});

test("B5: different strong keys produce different events", () => {
  const rowA = { match_family_key: "match-a" };
  const rowB = { match_family_key: "match-b" };
  const evA = extractEventIdentityEvidence(rowA);
  const evB = extractEventIdentityEvidence(rowB);
  assert.notEqual(evA.eventKey, evB.eventKey);
});

test("B6: conflicting strong values (same tier, different fields) yield CONFLICT", () => {
  const row = { match_family_key: "match-a", canonical_event_key: "match-b" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "CONFLICT");
  assert.equal(evidence.eventKey, null);
});

test("B7: event_slug alone is MEDIUM, not STRONG", () => {
  const row = { event_slug: "barca-vs-real" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "MEDIUM");
  assert.equal(evidence.sourceField, "event_slug");
});

test("B8: market_slug alone is WEAK", () => {
  const row = { market_slug: "barca-real-moneyline" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "WEAK");
  assert.equal(evidence.sourceField, "market_slug");
});

test("B9: condition_id alone is WEAK", () => {
  const row = { condition_id: "cond-only" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "WEAK");
  assert.equal(evidence.sourceField, "condition_id");
});

test("B10: no usable identity field is MISSING", () => {
  const row = { unrelated_field: "x" };
  const evidence = extractEventIdentityEvidence(row);
  assert.equal(evidence.confidenceClass, "MISSING");
  assert.equal(evidence.eventKey, null);
  assert.equal(evidence.sourceField, null);
});

test("B11: fallback provenance is counted correctly across a mixed batch", () => {
  const rows = [
    { match_family_key: "m1" },
    { event_slug: "s1" },
    { market_slug: "mk1" },
    {},
  ];
  const evidences = rows.map(extractEventIdentityEvidence);
  const summary = buildEventIdentityEvidenceSummary(evidences);
  assert.equal(summary.rowsByConfidenceClass.STRONG, 1);
  assert.equal(summary.rowsByConfidenceClass.MEDIUM, 1);
  assert.equal(summary.rowsByConfidenceClass.WEAK, 1);
  assert.equal(summary.rowsByConfidenceClass.MISSING, 1);
});

test("B12: the audit must not overclaim strongly-proven events from slug-only rows", () => {
  const rows = [{ event_slug: "s1" }, { event_slug: "s2" }];
  const evidences = rows.map(extractEventIdentityEvidence);
  const summary = buildEventIdentityEvidenceSummary(evidences);
  assert.equal(summary.strongIdentityEventCount, 0);
  assert.equal(summary.mediumOrBetterEventCount, 2);
});

test("B13: extractEventIdentityEvidence never mutates its input row", () => {
  const row = { match_family_key: "m1", diagnostics: { canonicalEventKey: "c1" } };
  const before = JSON.stringify(row);
  extractEventIdentityEvidence(row);
  assert.equal(JSON.stringify(row), before);
});

test("B14: results are deterministic across repeated calls", () => {
  const row = { event_slug: "s1", market_slug: "mk1" };
  const a = extractEventIdentityEvidence(row);
  const b = extractEventIdentityEvidence(row);
  assert.deepEqual(a, b);
});

test("B15: extraction reads no DB/network, and writes nothing", () => {
  const row = { match_family_key: "m1" };
  const before = JSON.stringify(process.env);
  extractEventIdentityEvidence(row);
  assert.equal(JSON.stringify(process.env), before);
});

test("B16: the corpus audit's physical PostgREST select list is unchanged by this feature", () => {
  const source = require("node:fs").readFileSync(
    require.resolve("../../scripts/modeling/strategies/export-generated-signal-pairs-from-supabase.ts"),
    "utf8",
  );
  const match = source.match(
    /export const GENERATED_SIGNAL_PAIRS_PHYSICAL_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(match);
  const physicalFieldsBlock = match![1];
  assert.doesNotMatch(physicalFieldsBlock, /match_family_key/);
  assert.doesNotMatch(physicalFieldsBlock, /canonical_event_key/);
  assert.doesNotMatch(physicalFieldsBlock, /parent_event_key/);
});

test("B17: candidates array carries no raw full-row payload, only field/value/location entries", () => {
  const row = { match_family_key: "m1", event_slug: "s1", secret_internal_field: "should-not-leak" };
  const evidence = extractEventIdentityEvidence(row);
  for (const candidate of evidence.candidates) {
    assert.ok("field" in candidate);
    assert.ok("value" in candidate);
    assert.ok("location" in candidate);
  }
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /secret_internal_field/);
  assert.doesNotMatch(serialized, /should-not-leak/);
});
