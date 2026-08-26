import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseline, reconcilePlan, buildFactualStateDelta } from '../../scripts/control-plane/lib/control-plane-reconcile.mjs';
const good = '6cd262ea220593193b5fb6898361362b83a019bd';
const resolver = (input) => input === '6cd262e' || input === good ? good : null;
const ancestor = (sha, head) => sha === good && head === 'main';
test('reconciliation rejects the exact PR94 malformed full SHA before any write', () => {
  assert.throws(() => normalizeBaseline({ baseline: '6cd262e6b7fba6c4fd392c3903c51d80fd429489', intendedHead: 'main', resolveCommit: resolver, isAncestor: ancestor }), /RECONCILE_BASELINE_UNRESOLVED/);
});
test('reconciliation normalizes an unambiguous abbreviation to an exact commit SHA', () => {
  assert.equal(normalizeBaseline({ baseline: '6cd262e', intendedHead: 'main', resolveCommit: resolver, isAncestor: ancestor }), good);
});
test('reconciliation refuses a resolved non-ancestor baseline', () => {
  assert.throws(() => normalizeBaseline({ baseline: good, intendedHead: 'other', resolveCommit: resolver, isAncestor: ancestor }), /RECONCILE_BASELINE_NOT_ANCESTOR/);
});
test('apply-state records input and resolved SHA separately', () => {
  const result = reconcilePlan({ mode: 'apply-state', baseline: '6cd262e', intendedHead: 'main', resolveCommit: resolver, isAncestor: ancestor });
  assert.equal(result.baseline_input, '6cd262e');
  assert.equal(result.baseline_resolved_sha, good);
});

const acceptedCompletion = {
  completion_id: 'CMP-AUTO-RECONCILE-TEST', repository: 'POLYPROPICKS/PREMVP', verdict: 'PASS', outcome_class: 'TERMINAL_PASS', result_sha: good,
};
const baseState = { state_version: 16, main: { origin_main_sha: good }, accepted_completions: [], evidence_freshness: {} };
test('accepted merge produces only the bounded factual current-state fields', () => {
  const result = buildFactualStateDelta({ state: baseState, completion: acceptedCompletion, mergeSha: good, observedAt: '2026-08-26T00:00:00.000Z', isAncestor: () => true });
  assert.equal(result.changed, true);
  assert.equal(result.state.state_version, 17);
  assert.equal(result.state.main.origin_main_sha, good);
  assert.equal(result.state.last_accepted_completion_id, acceptedCompletion.completion_id);
  assert.equal(result.state.accepted_completions.length, 1);
  assert.equal(result.state.roadmap_phase, undefined, 'writer must not add strategic state');
});
test('reconciliation is idempotent and refuses unaccepted or non-terminal evidence', () => {
  const once = buildFactualStateDelta({ state: baseState, completion: acceptedCompletion, mergeSha: good, observedAt: '2026-08-26T00:00:00.000Z', isAncestor: () => true });
  const twice = buildFactualStateDelta({ state: once.state, completion: acceptedCompletion, mergeSha: good, observedAt: '2026-08-27T00:00:00.000Z', isAncestor: () => true });
  assert.equal(twice.changed, false);
  assert.throws(() => buildFactualStateDelta({ state: baseState, completion: { ...acceptedCompletion, verdict: 'WAIT', outcome_class: 'EXTERNAL_WAIT' }, mergeSha: good, observedAt: '2026-08-26T00:00:00.000Z', isAncestor: () => true }), /RECONCILE_COMPLETION_NOT_TERMINAL_PASS/);
  assert.throws(() => buildFactualStateDelta({ state: baseState, completion: acceptedCompletion, mergeSha: good, observedAt: '2026-08-26T00:00:00.000Z', isAncestor: (_sha, head) => head !== 'origin/main' }), /RECONCILE_MERGE_NOT_ACCEPTED_ON_MAIN/);
});
