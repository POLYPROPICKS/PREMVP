import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseline, reconcilePlan } from '../../scripts/control-plane/lib/control-plane-reconcile.mjs';
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
