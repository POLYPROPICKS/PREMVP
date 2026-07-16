import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildCanonicalModelHandoff, verifyCanonicalModelHandoff } from "../../lib/modeling/canonicalModelHandoff";

const root = process.cwd();
const out = path.join(root, "modeling/canonical/model-handoff-v1");

test("identity membership and replay order are separate deterministic contracts", () => {
  const built = buildCanonicalModelHandoff(root);
  assert.equal(built.identitySet.identities.length, 231);
  assert.equal(new Set(built.identitySet.identities).size, 231);
  assert.deepEqual(built.identitySet.identities, [...built.identitySet.identities].sort());
  assert.equal(built.identitySet.sha256, "99f22a9bb8db0a2ff7bddd8e72f87a097fdb136f1a242a300ccb0e8740d0fcca");
  assert.equal(built.executionSequence.records.length, 231);
  assert.equal(built.executionSequence.sha256, "5457240a539e5db189c1b23659678f157b322928105909a5812ce318a9d6b036");
  assert.notDeepEqual(built.identitySet.identities, built.executionSequence.records.map((row) => row.observationId));
  built.executionSequence.records.forEach((row, index) => assert.equal(row.executionSequenceIndex, index));
});

test("fixed and dynamic immutable ledgers have identical replay order", () => {
  const built = buildCanonicalModelHandoff(root);
  assert.deepEqual(built.fixedLedgerIds, built.dynamicLedgerIds);
});

test("canonical artifacts verify and renderer is presentation-only offline", () => {
  const result = verifyCanonicalModelHandoff(root, out);
  assert.equal(result.identityCount, 231);
  assert.equal(result.executionCount, 231);
  for (const name of ["CANONICAL_MODEL_ARCHITECTURE_V1.md", "DATASET_FREEZE_AND_REPLAY_CONTRACT_V1.md", "SOURCE_TEST_EVIDENCE_MAP_V1.md", "DOWNSTREAM_INTEGRATION_HANDOFF_V1.md", "FOUNDER_README_RU.md"]) assert.ok(existsSync(path.join(out, name)));
  const html = readFileSync(path.join(out, "offline_plotly_dashboard.html"), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=|cdn\.|unpkg\.|jsdelivr/i);
  assert.doesNotMatch(html, /calculateStake|vaultTransfer|replayModel/);
  const contract = JSON.parse(readFileSync(path.join(out, "canonical_model_contract.json"), "utf8"));
  assert.equal(contract.exportProvenance.queryContractStatus, "PARTIAL");
  assert.equal(contract.exportProvenance.historicalSourceReExportReproducible, false);
  assert.deepEqual(contract.forbiddenProfilePairings.length, 2);
});

test("canonical outputs contain no machine-specific paths and all manifest hashes reproduce", () => {
  const result = verifyCanonicalModelHandoff(root, out);
  assert.equal(result.absolutePathMatches.length, 0);
  assert.equal(result.manifestValid, true);
  assert.equal(result.sourceHashesValid, true);
  assert.equal(result.chartLineageValid, true);
});
