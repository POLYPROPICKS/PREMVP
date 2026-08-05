/**
 * executorParity.test.mjs
 *
 * Bounded tests proving the CONTROL_PLANE_EXECUTOR_PARITY change: claude_code_cloud and
 * local_codex_windows are equally authorized PREMVP execution targets for R0-R4, neither
 * depends on the other, authorization and evidence are distinct, and R5/Ireland remain
 * fail-closed.
 *
 * Run: node --test tests/control-plane/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateControlPlane } from '../../scripts/control-plane/validate-control-plane.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = 'docs/ai-context/control-plane';

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DIR, rel), 'utf8'));
}

test('parity: both PREMVP executors are eligible for R0-R4', () => {
  const routing = readJson('ROUTING_AND_PIPELINES.yaml');
  for (const id of [
    'R0_READ_ONLY', 'R1_BOUNDED_CODE', 'R2_ARCHITECTURE_OR_ROADMAP',
    'R3_WEATHER_MODEL_CHANGE', 'R4_CONTUR_PRODUCTION_BOUNDARY',
  ]) {
    const rc = routing.risk_classes.find((r) => r.id === id);
    assert.ok(rc, `${id} must exist`);
    assert.ok(rc.eligible_execution_targets.includes('claude_code_cloud'), `${id} must allow claude_code_cloud`);
    assert.ok(rc.eligible_execution_targets.includes('local_codex_windows'), `${id} must allow local_codex_windows`);
  }
});

test('parity: R5 remains fail-closed with no eligible executors', () => {
  const routing = readJson('ROUTING_AND_PIPELINES.yaml');
  const r5 = routing.risk_classes.find((r) => r.id === 'R5_CROSS_REPO_OR_LIVE_MONEY');
  assert.equal(r5.fail_closed, true);
  assert.deepEqual(r5.eligible_execution_targets, []);
});

test('parity: Ireland remains protected and unauthorized', () => {
  const capability = readJson('CAPABILITY_MATRIX.yaml');
  const ireland = capability.execution_targets.find((t) => t.executor_id === 'ireland_local');
  assert.ok(ireland);
  for (const c of ireland.capabilities) {
    assert.equal(c.authorized, false, `ireland_local.${c.capability} must be unauthorized`);
  }
});

test('parity: routing declares no executor-to-executor dependency', () => {
  const routing = readJson('ROUTING_AND_PIPELINES.yaml');
  assert.ok(routing.executor_parity_policy, 'executor_parity_policy must be declared');
  assert.match(routing.executor_parity_policy.rule, /Neither executor is an execution dependency of the other/);
});

test('authorization and evidence are distinct facts on capability entries', () => {
  const capability = readJson('CAPABILITY_MATRIX.yaml');
  const cloud = capability.execution_targets.find((t) => t.executor_id === 'claude_code_cloud');
  const dbWrite = cloud.capabilities.find((c) => c.capability === 'DATABASE_WRITE');
  assert.equal(dbWrite.authorized, true, 'DATABASE_WRITE may be authorized');
  assert.equal(dbWrite.verdict, 'NOT_PROVEN', 'DATABASE_WRITE evidence remains NOT_PROVEN — authorization never fabricates a runtime PASS');
});

test('NOT_PROVEN capabilities are still authorized (not equal to forbidden)', () => {
  const capability = readJson('CAPABILITY_MATRIX.yaml');
  const codex = capability.execution_targets.find((t) => t.executor_id === 'local_codex_windows');
  const build = codex.capabilities.find((c) => c.capability === 'BUILD');
  assert.equal(build.verdict, 'NOT_PROVEN');
  assert.equal(build.authorized, true);
});

test('same-run capability bootstrap rule is declared with fail-closed constraints', () => {
  const capability = readJson('CAPABILITY_MATRIX.yaml');
  const bootstrap = capability.authorization_vs_evidence_policy?.same_run_capability_bootstrap;
  assert.ok(bootstrap, 'same_run_capability_bootstrap must be declared');
  assert.match(bootstrap.rule, /same task/);
  const constraints = bootstrap.constraints.join(' ');
  assert.match(constraints, /no separate Founder confirmation/);
  assert.match(constraints, /no destructive probe/);
  assert.match(constraints, /fails closed/);
});

test('portable reviewer definitions carry no user-specific absolute path as authority', () => {
  const weather = readJson('reviewers/weather-gate-reviewer.yaml');
  const contur = readJson('reviewers/contur-gate-reviewer.yaml');
  for (const def of [weather, contur]) {
    assert.doesNotMatch(def.authority, /^C:\\Users\\/);
    assert.equal(def.executor_adapters.length, 2);
    const ids = def.executor_adapters.map((a) => a.executor_id).sort();
    assert.deepEqual(ids, ['claude_code_cloud', 'local_codex_windows']);
    for (const adapter of def.executor_adapters) {
      assert.equal(adapter.emits_same_receipt_schema, true);
    }
  }
});

test('portable reviewer canonical ids are registered PORTABLE and both legacy Codex-only ids are deprecated compatibility only', () => {
  const registry = readJson('AGENT_REGISTRY.yaml');
  for (const id of ['premvp.reviewer.weather_gate.v1', 'premvp.reviewer.contur_gate.v1']) {
    const e = registry.entries.find((x) => x.canonical_id === id);
    assert.ok(e, `${id} must be registered`);
    assert.equal(e.portability, 'PORTABLE');
    assert.equal(e.receipt_required, true);
  }
  for (const id of ['codex.agent.weather_gate_reviewer.v0', 'codex.agent.contur_gate_reviewer']) {
    const e = registry.entries.find((x) => x.canonical_id === id);
    assert.ok(e, `${id} must remain present for historical compatibility`);
    assert.equal(e.status, 'SUPERSEDED');
  }
});

test('R3/R4 routing requires the portable reviewer ids, not the deprecated Codex-only ids', () => {
  const routing = readJson('ROUTING_AND_PIPELINES.yaml');
  const r3 = routing.risk_classes.find((r) => r.id === 'R3_WEATHER_MODEL_CHANGE');
  const r4 = routing.risk_classes.find((r) => r.id === 'R4_CONTUR_PRODUCTION_BOUNDARY');
  assert.ok(r3.required_agents.includes('premvp.reviewer.weather_gate.v1'));
  assert.ok(r4.required_agents.includes('premvp.reviewer.contur_gate.v1'));
  assert.ok(!r3.required_agents.includes('codex.agent.weather_gate_reviewer.v0'));
  assert.ok(!r4.required_agents.includes('codex.agent.contur_gate_reviewer'));
});

test('full validator still passes with parity changes applied', () => {
  const result = validateControlPlane(REPO_ROOT);
  assert.equal(result.ok, true, result.errors.join('\n'));
});
