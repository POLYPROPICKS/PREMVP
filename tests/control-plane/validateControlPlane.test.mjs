/**
 * validateControlPlane.test.mjs
 *
 * Bounded tests for the control-plane validator and the deterministic snapshot generator.
 * Uses node:test — the repository's existing test runner — and no additional dependency.
 *
 * Run: node --test tests/control-plane/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateControlPlane } from '../../scripts/control-plane/validate-control-plane.mjs';
import { renderSnapshot, SNAPSHOT_REL } from '../../scripts/control-plane/generate-architect-snapshot.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'docs/ai-context/control-plane';

/** Copy the real control-plane directory into a temp root, then mutate one artifact. */
function withMutatedRoot(file, mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  const dest = path.join(tmp, DIR);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, DIR))) {
    fs.copyFileSync(path.join(REPO_ROOT, DIR, entry), path.join(dest, entry));
  }
  const target = path.join(dest, file);
  const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutate(doc);
  fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return tmp;
}

function errorsFrom(result) {
  return result.errors.join('\n');
}

test('1. valid control-plane artifacts pass', () => {
  const result = validateControlPlane(REPO_ROOT);
  assert.equal(result.ok, true, errorsFrom(result));
  assert.deepEqual(result.errors, []);
});

test('2. missing next value step fails', () => {
  const root = withMutatedRoot('CURRENT_STATE.yaml', (doc) => {
    doc.next_two_value_steps = [doc.next_two_value_steps[0]];
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /next_two_value_steps must contain exactly two entries/);
});

test('3. unknown executor in routing fails', () => {
  const root = withMutatedRoot('ROUTING_AND_PIPELINES.yaml', (doc) => {
    const r0 = doc.risk_classes.find((r) => r.id === 'R0_READ_ONLY');
    r0.eligible_execution_targets.push('mystery_runtime');
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /references unknown execution target mystery_runtime/);
});

test('4. unknown agent in a required pipeline fails', () => {
  const root = withMutatedRoot('ROUTING_AND_PIPELINES.yaml', (doc) => {
    const r3 = doc.risk_classes.find((r) => r.id === 'R3_WEATHER_MODEL_CHANGE');
    r3.required_agents.push('codex.agent.does_not_exist');
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /references unknown agent codex\.agent\.does_not_exist/);
});

test('5. R5 without explicit fail-closed behavior fails', () => {
  const root = withMutatedRoot('ROUTING_AND_PIPELINES.yaml', (doc) => {
    const r5 = doc.risk_classes.find((r) => r.id === 'R5_CROSS_REPO_OR_LIVE_MONEY');
    r5.fail_closed = false;
    delete r5.fail_closed_behavior;
    r5.eligible_execution_targets = ['claude_code_cloud'];
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /R5_CROSS_REPO_OR_LIVE_MONEY must set fail_closed true/);
  assert.match(errorsFrom(result), /fail_closed_behavior\.default_verdict BLOCKED/);
  assert.match(errorsFrom(result), /must have no eligible execution targets/);
});

test('5b. Ireland is not eligible for implementation without proven capability', () => {
  const root = withMutatedRoot('ROUTING_AND_PIPELINES.yaml', (doc) => {
    const r1 = doc.risk_classes.find((r) => r.id === 'R1_BOUNDED_CODE');
    r1.eligible_execution_targets.push('ireland_local');
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /makes ireland_local eligible while its capabilities are not PROVEN/);
});

test('5c. Standard Chat default and Work escalation-only are enforced', () => {
  const root = withMutatedRoot('ARCHITECT_CONTROL_PLANE.yaml', (doc) => {
    doc.architect_interface.default = 'WORK';
    doc.architect_interface.work_mode = 'DEFAULT';
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /default must be STANDARD_CHAT/);
  assert.match(errorsFrom(result), /work_mode must be ESCALATION_ONLY/);
});

test('5d. Codex Remote may not be registered as a separate executor', () => {
  const root = withMutatedRoot('CAPABILITY_MATRIX.yaml', (doc) => {
    doc.execution_targets.push({
      executor_id: 'MOBILE_REMOTE',
      runtime: 'codex_remote',
      repository_scope: ['POLYPROPICKS/PREMVP'],
      host_dependency: false,
      access_surfaces: [],
      founder_terminal_required: false,
      capabilities: [],
      restrictions: [],
    });
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /registered both as an access surface and an execution target/);
});

test('5e. secret-like values in canonical artifacts fail', () => {
  const root = withMutatedRoot('CURRENT_STATE.yaml', (doc) => {
    doc.leaked = 'sk-ABCDEF0123456789abcdef0123';
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /SECRET_LIKE_VALUE/);
});

test('5f. freshness mode is BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE, not exact equality', () => {
  const result = validateControlPlane(REPO_ROOT);
  assert.equal(result.ok, true, errorsFrom(result));

  const state = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DIR, 'CURRENT_STATE.yaml'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DIR, 'ARCHITECT_CONTROL_PLANE.yaml'), 'utf8'));

  assert.equal(state.main.origin_main_sha_semantics, 'LAST_VERIFIED_ORIGIN_MAIN_BASELINE');
  assert.equal(state.main.freshness_check_mode, 'BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE');
  assert.equal(policy.stale_state_behavior.freshness_check_mode, 'BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE');
  assert.doesNotMatch(policy.stale_state_behavior.rule, /^Exact equality is required/);
});

test('5g. state-bootstrap allowlist is exactly the three state artifacts', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DIR, 'ARCHITECT_CONTROL_PLANE.yaml'), 'utf8'));
  const allowlist = policy.stale_state_behavior.state_bootstrap_allowlist;
  assert.deepEqual(
    [...allowlist].sort(),
    [
      'docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md',
      'docs/ai-context/control-plane/CURRENT_STATE.yaml',
      'docs/ai-context/control-plane/EVIDENCE_LEDGER.md',
    ].sort(),
  );
});

test('5h. missing origin_main_sha_semantics fails validation', () => {
  const root = withMutatedRoot('CURRENT_STATE.yaml', (doc) => {
    delete doc.main.origin_main_sha_semantics;
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /origin_main_sha_semantics must be LAST_VERIFIED_ORIGIN_MAIN_BASELINE/);
});

test('5i. wrong freshness_check_mode fails validation', () => {
  const root = withMutatedRoot('CURRENT_STATE.yaml', (doc) => {
    doc.main.freshness_check_mode = 'EXACT_MATCH';
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /freshness_check_mode must be BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE/);
});

test('5j. incomplete state_bootstrap_allowlist fails validation', () => {
  const root = withMutatedRoot('ARCHITECT_CONTROL_PLANE.yaml', (doc) => {
    doc.stale_state_behavior.state_bootstrap_allowlist = [
      'docs/ai-context/control-plane/CURRENT_STATE.yaml',
    ];
  });
  const result = validateControlPlane(root);
  assert.equal(result.ok, false);
  assert.match(errorsFrom(result), /state_bootstrap_allowlist must be exactly the three state-bootstrap paths/);
});

test('5k. snapshot describes baseline/ancestor semantics, not a bare SHA equality claim', () => {
  const rendered = renderSnapshot(REPO_ROOT);
  assert.match(rendered, /LAST_VERIFIED_ORIGIN_MAIN_BASELINE/);
  assert.match(rendered, /BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE/);
  assert.match(rendered, /ancestor of live origin\/main/);
});

test('10. deterministic snapshot check passes and is stable across runs', () => {
  const committed = fs.readFileSync(path.join(REPO_ROOT, SNAPSHOT_REL), 'utf8');
  const first = renderSnapshot(REPO_ROOT);
  const second = renderSnapshot(REPO_ROOT);

  assert.equal(first, second, 'renderSnapshot must be deterministic across invocations');
  assert.equal(committed, first, 'committed ARCHITECT_SNAPSHOT.md must match the generated output');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(first),
    'snapshot must not embed wall-clock generation time');
});

test('11. snapshot stays within the 7,000-character architect context budget', () => {
  // The snapshot is pasted into a phone-first ChatGPT project. If it grows past this,
  // it stops being a compact stand-in and starts crowding out the actual task.
  const rendered = renderSnapshot(REPO_ROOT);
  assert.ok(rendered.length <= 7000,
    `ARCHITECT_SNAPSHOT.md is ${rendered.length} characters, budget is 7000`);
});
