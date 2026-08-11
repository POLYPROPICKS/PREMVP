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
    agent_id: 'premvp.reviewer.contur_gate.v1',
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
    required_reviewers: ['premvp.reviewer.contur_gate.v1'],
    invoked_reviewers: ['premvp.reviewer.contur_gate.v1'],
    reviewer_receipts: [conturReceipt()],
    evidence: [
      { id: 'EV-A', evidence_class: 'PROVEN_IN_RUNTIME', statement: 'build exit 0', ref: null },
      {
        id: 'EV-B',
        evidence_class: 'PROVEN_IN_RUNTIME',
        statement: 'queue authority cutoff observed in the controlled-live run',
        ref: null,
        business_result: true,
      },
    ],
    capability_changes: [],
    state_delta_proposal: { proposed_state_version: 2, changes: [], accepted: false },
    runtime_changed: false,
    deployment_changed: false,
    database_changed: false,
    forbidden_actions_respected: true,
    verdict: 'PASS',
    outcome_class: 'TERMINAL_PASS',
    operator_actions: { start: 1, intermediate: 0, terminal_result: 1 },
    blockers: [],
    founder_action: 'Review and accept the state delta proposal.',
    ...overrides,
  };
}

/** A genuine terminal block: canonical id, exhausted recovery, stated impossibility. */
function hardStop(overrides = {}) {
  return {
    hard_stop_id: 'R5_BOUNDARY_REACHED',
    recovery_attempts: [
      {
        id: 'EXECUTOR_REROUTE',
        action: 'searched ROUTING_AND_PIPELINES.yaml for an eligible R5 execution target',
        outcome: 'no eligible execution target exists',
        exhausted: true,
      },
    ],
    unrecoverable_evidence: 'R5 has no eligible execution target and no permitted repository; ireland_local capabilities are NOT_PROVEN.',
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
  assert.match(result.errors.join('\n'), /REVIEWER_RECEIPT_MISSING: premvp\.reviewer\.contur_gate/);
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
  assert.match(result.errors.join('\n'), /REQUIRED_REVIEWER_UNDER_DECLARED.*weather_gate/);
  assert.match(result.errors.join('\n'), /REVIEWER_RECEIPT_MISSING/);
});

test('7e. an R4 envelope that under-declares the Contur reviewer fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    required_reviewers: [],
    invoked_reviewers: [],
    reviewer_receipts: [],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /REQUIRED_REVIEWER_UNDER_DECLARED.*contur_gate/);
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

test('9f. a BLOCKED envelope with a complete hard-stop record is valid', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    verdict: 'BLOCKED',
    outcome_class: 'HARD_BLOCKED',
    hard_stop: hardStop(),
    blockers: ['R5_BOUNDARY_REACHED — ireland_local capabilities are NOT_PROVEN'],
    founder_action: 'Decide whether to authorize a separate Ireland boundary task.',
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

// --- CP-HARDENING-01: outcome semantics ---------------------------------------------------
// The verdict string is no longer trusted on its own. These cases are the false hard STOPs
// that used to send the Founder a recovery prompt instead of a finished task.

function blocked(overrides = {}) {
  return validEnvelope({
    verdict: 'BLOCKED',
    outcome_class: 'HARD_BLOCKED',
    hard_stop: hardStop(),
    founder_action: 'Decide whether to authorize a separate Ireland boundary task.',
    ...overrides,
  });
}

test('CP-10. "implementation incomplete" can never be a terminal hard block', () => {
  const result = validateCompletionEnvelope(blocked({
    blockers: ['Implementation is incomplete — substantial work remains on the compiler.'],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /INCOMPLETE_IS_NOT_TERMINAL/);
});

test('CP-10b. a failed first attempt can never be a terminal hard block', () => {
  const result = validateCompletionEnvelope(blocked({
    hard_stop: hardStop({ unrecoverable_evidence: 'The first implementation attempt failed.' }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /INCOMPLETE_IS_NOT_TERMINAL/);
});

test('CP-11. session execution time ending is transport state, not a business block', () => {
  const result = validateCompletionEnvelope(blocked({
    blockers: ['Session execution time ended before the release stage.'],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /SESSION_END_IS_NOT_BUSINESS_BLOCK/);
});

test('CP-11b. a transport pause is a WAIT carrying an honest checkpoint', () => {
  const ok = validateCompletionEnvelope(validEnvelope({
    verdict: 'WAIT',
    outcome_class: 'TRANSPORT_PAUSE',
    blockers: [],
    founder_action: 'none',
    checkpoint: {
      checkpoint_id: 'CP-HARDENING-01#stage-3',
      completed_steps: ['compiler', 'completion semantics'],
      next_step: 'regenerate the Project package and re-run the targeted tests',
      platform_auto_resume: false,
    },
  }));
  assert.equal(ok.ok, true, ok.errors.join('\n'));

  const missing = validateCompletionEnvelope(validEnvelope({
    verdict: 'WAIT', outcome_class: 'TRANSPORT_PAUSE', blockers: [], founder_action: 'none',
  }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /TRANSPORT_PAUSE_WITHOUT_CHECKPOINT/);
});

test('CP-12. a hard block without a canonical id or recovery evidence fails', () => {
  const noRecord = validateCompletionEnvelope(validEnvelope({
    verdict: 'BLOCKED', outcome_class: 'HARD_BLOCKED', blockers: ['something went wrong'],
  }));
  assert.equal(noRecord.ok, false);
  assert.match(noRecord.errors.join('\n'), /BLOCKED_WITHOUT_HARD_STOP_RECORD/);

  const invented = validateCompletionEnvelope(blocked({
    hard_stop: hardStop({ hard_stop_id: 'TASK_TOO_BIG' }),
  }));
  assert.equal(invented.ok, false);
  assert.match(invented.errors.join('\n'), /BLOCKED_WITHOUT_CANONICAL_HARD_STOP_ID/);

  const noAttempts = validateCompletionEnvelope(blocked({
    hard_stop: hardStop({ recovery_attempts: [] }),
  }));
  assert.equal(noAttempts.ok, false);
  assert.match(noAttempts.errors.join('\n'), /BLOCKED_WITHOUT_RECOVERY_EVIDENCE/);
});

test('CP-12b. a block while registered recovery remains unexhausted fails', () => {
  const result = validateCompletionEnvelope(blocked({
    hard_stop: hardStop({
      recovery_attempts: [{
        id: 'DEDICATED_WORKTREE', action: 'considered an isolated worktree',
        outcome: 'not attempted', exhausted: false,
      }],
    }),
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /BLOCKED_WHILE_RECOVERY_REMAINS/);
});

test('CP-12c. a recoverable condition returned as a hard block fails', () => {
  for (const reason of [
    'The Founder root is dirty and cannot be used.',
    'Missing locked dependencies prevent the build.',
    'The generated snapshot is stale.',
  ]) {
    const result = validateCompletionEnvelope(blocked({ blockers: [reason] }));
    assert.equal(result.ok, false, reason);
    assert.match(result.errors.join('\n'), /RECOVERABLE_CONDITION_RETURNED_AS_HARD_BLOCK/);
  }
});

test('CP-13. a WAIT may not ask the Founder to launch a recovery prompt', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    verdict: 'WAIT', outcome_class: 'EXTERNAL_WAIT', blockers: [],
    founder_action: 'none',
    wait_reason: 'Please launch another prompt to continue the release.',
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /WAIT_DELEGATES_RECOVERY_TO_FOUNDER/);
});

test('CP-14. outcome_class must carry its one legal verdict', () => {
  const result = validateCompletionEnvelope(validEnvelope({ outcome_class: 'EXTERNAL_WAIT' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /OUTCOME_CLASS_VERDICT_MISMATCH/);
});

test('CP-15. a recoverable outcome may never consume a Founder action', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    verdict: 'FAIL', outcome_class: 'RECOVERABLE_EXECUTION_FAILURE', blockers: [],
    founder_action: 'Re-run the task with a larger budget.',
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /RECOVERABLE_WITH_FOUNDER_ACTION/);
});

test('CP-19. PASS without business-result evidence fails', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    evidence: [{ id: 'EV-A', evidence_class: 'PROVEN_IN_RUNTIME', statement: 'build exit 0', ref: null }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITHOUT_BUSINESS_RESULT_EVIDENCE/);
});

test('CP-19b. business-result evidence that is only SUPPORTED does not prove a PASS', () => {
  const result = validateCompletionEnvelope(validEnvelope({
    evidence: [{ id: 'EV-B', evidence_class: 'SUPPORTED', statement: 'looks right', ref: null, business_result: true }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PASS_WITHOUT_BUSINESS_RESULT_EVIDENCE/);
});

test('CP-20. operator budget: one start, zero intermediate, one terminal result', () => {
  const missing = validateCompletionEnvelope(validEnvelope({ operator_actions: undefined }));
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /PASS_WITHOUT_OPERATOR_ACTION_BUDGET/);

  const intermediate = validateCompletionEnvelope(validEnvelope({
    operator_actions: { start: 1, intermediate: 1, terminal_result: 1 },
  }));
  assert.equal(intermediate.ok, false);
  assert.match(intermediate.errors.join('\n'), /OPERATOR_BUDGET_VIOLATION: intermediate must be 0/);

  const twoStarts = validateCompletionEnvelope(validEnvelope({
    operator_actions: { start: 2, intermediate: 0, terminal_result: 1 },
  }));
  assert.equal(twoStarts.ok, false);
  assert.match(twoStarts.errors.join('\n'), /OPERATOR_BUDGET_VIOLATION: start must be 0 or 1/);
});
