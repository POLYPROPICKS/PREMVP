import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compileMission, loadRegistry } from '../../scripts/control-plane/lib/mission-compile.mjs';
import { validateCommandBindings } from '../../scripts/control-plane/validate-command-bindings.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const registry = loadRegistry(root);

test('Sentry debug skill resolves and its direct query is capability-scoped', () => {
  const skill = registry.entries.find((entry) => entry.canonical_id === 'premvp.skill.sentry_production_debug.v1');
  assert.ok(skill);
  assert.equal(fs.existsSync(path.join(root, skill.implementation_path)), true);
  assert.match(skill.permissions, /SENTRY_READ_DEBUG/);
  assert.deepEqual(validateCommandBindings(root).errors, []);
});

test('ordinary code mission does not require Sentry', () => {
  const mission = { schema_version: '1.0', mission_id: 'SENTRY-ORDINARY-01', mission: 'Fix a bounded utility.', business_result: 'Utility behavior is verified.', repository: 'POLYPROPICKS/PREMVP', repository_boundary: 'PREMVP', executor: 'local_codex_windows', risk_class: 'R1_BOUNDED_CODE', scope: { allowed_paths: ['lib/example.ts'], out_of_scope: ['Sentry'] }, hard_boundaries: ['No production Sentry query.'], acceptance: [{ id: 'A1', statement: 'Tests pass.', evaluated_at: 'TERMINAL', met: null }], direct_actions: [{ id: 'EDIT', action: 'edit a bounded utility', repository_boundary: 'PREMVP', persistence: 'NONE', requires_capabilities: ['REPOSITORY_READ'] }], required_capabilities: [{ capability: 'REPOSITORY_READ', direct_action_ref: 'EDIT' }], commands: ['premvp.command.execution_precheck.v1'], operator_budget: { start: 1, intermediate: 0, terminal_result: 1 }, modules: {} };
  const result = compileMission(mission, { root, registry });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.resolved_capabilities.map((x) => x.capability), ['REPOSITORY_READ']);
});

test('skill bans fabricated evidence and treats Sentry unavailability as non-hard-stop evidence loss', () => {
  const skill = fs.readFileSync(path.join(root, '.agents/skills/polypropicks-production-debug/SKILL.md'), 'utf8');
  assert.match(skill, /SENTRY_EVIDENCE_UNAVAILABLE/);
  assert.match(skill, /never fabricate findings/);
  assert.match(skill, /not enable replay, broad tracing, profiling, or PII/i);
});

test('instrumentation references environment-variable names without tracked DSN or auth-token values', () => {
  const files = ['instrumentation-client.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts', 'next.config.ts'];
  const text = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.match(text, /process\.env\.(NEXT_PUBLIC_SENTRY_DSN|SENTRY_DSN|SENTRY_AUTH_TOKEN)/);
  assert.doesNotMatch(text, /https?:\/\/[^\s"']+@[^\s"']+/);
});
