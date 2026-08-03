/**
 * validateCompletionEnvelope.test.mjs
 *
 * Bounded tests for the completion-envelope validator.
 * Uses node:test and no additional dependency.
 *
 * Run: node --test tests/control-plane/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateCompletionEnvelope } from '../../scripts/control-plane/validate-completion-envelope.mjs';

const RESULT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const BASE_SHA = '6e593a5d0e66e50941f130f7792f67e487dbb347';

function conturReceipt(overrides = {}) {
  return {
    agent_id: 'codex.agent.contur_gate_reviewer',
    implementation_identity: 'C:\\Users\\Alex\\.codex\\agents\\contur-gate-reviewer.toml',
    configured_model: 'gpt-5.6-luna',
    reasoning_policy: 'max',
    independence_group: 'contur_gate',
    reviewed_sha: RESULT_SHA,
    verdict: 'PASS',
    evidence_refs: ['EVIDENCE_LEDGER#EV-0004'],
    ...overrides,
  };
}

function validEnvelope(overrides = {}) {
  return {
    schema_version: '1.0',
    completion_id: 'CMP-0001',
    task_id: 'TASK-C1-REVIEW',
    task_class: 'LIVE_RUNTIME_OPERATION',
    risk_class: 'R4_CONTUR_PRODUCTION_BOUNDARY',
    executor: 'local_codex_windows',
    environment: 'local_codex_windows',
    repository: 'POLYPROPICKS/PREMVP',
    branch: 'codex/queue-authority-cutoff-20260803',
    base_sha: BASE_SHA,
    result_sha: RESULT_SHA,
    origin_main_sha: BASE_SHA,
    worktree_before: 'clean',
    worktree_after: 'clean',
    files_changed: ['lib/executor/eventExecutionQueue.ts'],
    commands_run: [
      { command: 'git status --short', exit_code: 0, purpose: 'worktree state' },
      { command: 'npm run build', exit_code: 0, purpose: 'build gate' },
    ],
    tests: [{ name: 'contur3 controlled-live', result: 'PASS' }],
    required_reviewers: ['codex.agent.contur_gate_reviewer'],
    invoked_reviewers: ['codex.agent.contur_gate_reviewer'],
    reviewer_receipts: [conturReceipt()],
    evidence: [
      { id: 'EV-A', evidence_class: 'PROVEN_IN_RUNTIME', statement: 'build exit 0', ref: null },
    ],
    capability_changes: [],
    state_delta_proposal: { proposed_state_version: 2, changes: [], accepted: false },
    runtime_changed: false,
    deployment_changed: false,
    database_changed: false,
    forbidden_actions_respected: true,
    verdict: 'PASS',
    blockers: [],
    founder_action: 'Review and accept the state delta proposal.',
    ...overrides,
  };
}

test('6. valid completion envelope passes', () => {
  const result = validateCompletionEnvelope(validEnvelope());
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('6b. missing required fields fail', () => {
  const env = validEnvelope();
  delete env.result_sha;
  delete env.founder_action;
  const result = validateCompletionEnvelope(env);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /MISSING_FIELD: result_sha/);
  assert.match(result.errors.join('\n'), /MISSING_FIELD: founder_action/);
});

test('7. missing required reviewer receipt fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({ reviewer_receipts: [] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REVIEWER_RECEIPT_MISSING: codex\.agent\.contur_gate_reviewer/);
});

test('7b. required reviewer never invoked fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    invoked_reviewers: [],
    reviewer_receipts: [],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REQUIRED_REVIEWER_NOT_INVOKED/);
});

test('7c. receipt missing an identity field fails', () => {
  const receipt = conturReceipt();
  delete receipt.implementation_identity;
  const result = validateCompletionEnvelope(validEnvelope({ reviewer_receipts: [receipt] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /requires definition_hash or implementation_identity/);
});

test('7d. an R3 envelope that under-declares the Weather reviewer fails', () => {
  // The executor writes required_reviewers about itself. Mandatory reviewers must be
  // derived from ROUTING_AND_PIPELINES.yaml so this cannot silently bypass the gate.
  const result = validateCompletionEnvelope(validEnvelope({
    risk_class: 'R3_WEATHER_MODEL_CHANGE',
    task_class: 'ML_MODEL_CHANGE',
    required_reviewers: [],
    invoked_reviewers: [],
    reviewer_receipts: [],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REQUIRED_REVIEWER_UNDER_DECLARED.*weather_gate_reviewer/);
  assert.match(result.errors.join('\n'), /REVIEWER_RECEIPT_MISSING/);
});

test('7e. an R4 envelope that under-declares the Contur reviewer fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    required_reviewers: [],
    invoked_reviewers: [],
    reviewer_receipts: [],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REQUIRED_REVIEWER_UNDER_DECLARED.*contur_gate_reviewer/);
});

test('8. reviewed SHA mismatch fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    reviewer_receipts: [conturReceipt({ reviewed_sha: BASE_SHA })],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REVIEWED_SHA_MISMATCH/);
});

test('9. PASS with a failing command fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    commands_run: [
      { command: 'git status --short', exit_code: 0, purpose: 'worktree state' },
      { command: 'npm run build', exit_code: 1, purpose: 'build gate' },
    ],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITH_FAILED_COMMAND/);
});

test('9b. PASS with a failing test fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    tests: [{ name: 'CTL18', result: 'FAIL' }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITH_FAILED_TEST: CTL18/);
});

test('9c. PASS with blockers fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({ blockers: ['BLK-001'] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITH_BLOCKERS/);
});

test('9d. PASS with a non-PASS reviewer receipt fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    reviewer_receipts: [conturReceipt({ verdict: 'FAIL' })],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITH_NON_PASS_RECEIPT/);
});

test('9e. self-accepted state delta fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    state_delta_proposal: { proposed_state_version: 2, changes: [], accepted: true },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /STATE_DELTA_SELF_ACCEPTED/);
});

test('9f. a BLOCKED envelope with blockers is valid', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    verdict: 'BLOCKED',
    blockers: ['R5_FAIL_CLOSED — ireland_local capabilities are NOT_PROVEN'],
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('9g. an R0 envelope with no required reviewers is valid', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    risk_class: 'R0_READ_ONLY',
    task_class: 'READ_ONLY_EVIDENCE',
    executor: 'claude_code_cloud',
    environment: 'claude_code_cloud',
    files_changed: [],
    required_reviewers: [],
    invoked_reviewers: [],
    reviewer_receipts: [],
    state_delta_proposal: null,
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});
