import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateCommandBindings } from '../../scripts/control-plane/validate-command-bindings.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const skillPath = '.agents/skills/polypropicks-independent-challenge/SKILL.md';
const invocation = '$polypropicks-independent-challenge';
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const registry = JSON.parse(read('docs/ai-context/control-plane/AGENT_REGISTRY.yaml'));
const routing = JSON.parse(read('docs/ai-context/control-plane/ROUTING_AND_PIPELINES.yaml'));
const capabilities = read('docs/ai-context/control-plane/CAPABILITY_MATRIX.yaml');
const skill = read(skillPath);

test('skill exists with valid name, descriptive frontmatter, and exact invocation', () => {
  assert.equal(fs.existsSync(path.join(root, skillPath)), true);
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, 'frontmatter must exist');
  assert.match(frontmatter[1], /^name: polypropicks-independent-challenge$/m);
  assert.match(frontmatter[1], /^description: .*(non-trivial|high-impact).*(Do not use|not for)/mi);
  assert.match(skill, /\$polypropicks-independent-challenge/);
  assert.equal(invocation, '$polypropicks-independent-challenge');
});

test('registered skill binding resolves and existing Sentry skill remains resolvable', () => {
  const challenge = registry.entries.find((entry) => entry.canonical_id === 'premvp.skill.independent_challenge.v1');
  const sentry = registry.entries.find((entry) => entry.canonical_id === 'premvp.skill.sentry_production_debug.v1');
  assert.equal(challenge?.type, 'SKILL');
  assert.equal(challenge?.implementation_path, skillPath);
  assert.equal(sentry?.implementation_path, '.agents/skills/polypropicks-production-debug/SKILL.md');
  assert.match(read(sentry.implementation_path), /^---\r?\nname: polypropicks-production-debug\r?\ndescription: /);
  assert.deepEqual(validateCommandBindings(root).errors, []);
});

test('challenge is optional for non-trivial work and never a mandatory risk-class reviewer', () => {
  const id = 'premvp.skill.independent_challenge.v1';
  const routed = routing.risk_classes.filter((risk) => risk.optional_agents.includes(id));
  assert.ok(routed.length > 0, 'skill should be available through optional routing');
  assert.equal(routing.risk_classes.some((risk) => risk.required_agents.includes(id)), false);
  assert.equal(routing.risk_classes.some((risk) => risk.reviewer_receipt_requirements.some((r) => r.agent_id === id)), false);
  assert.match(skill, /trivial mechanical edits/);
  assert.match(skill, /Do not trigger automatically/);
});

test('skill separates evidence classes and attempts to falsify diagnosis and solution', () => {
  for (const label of ['PROVEN_FACTS', 'SUPPORTED_INFERENCES', 'UNVERIFIED_ASSUMPTIONS', 'CONTRADICTIONS']) {
    assert.match(skill, new RegExp(label));
  }
  assert.match(skill, /falsify both the diagnosis and the proposed solution/i);
  assert.match(skill, /FIRST_PROVEN_PROBLEM/);
});

test('skill prefers a bounded correction that preserves the business result', () => {
  assert.match(skill, /SMALLEST_DEFENSIBLE_APPROACH/);
  assert.match(skill, /MATERIAL_ALTERNATIVE/);
  assert.match(skill, /REGRESSION_AND_MAINTENANCE_RISK/);
  assert.match(skill, /PROCEED_WITH_CORRECTION[\s\S]*BUSINESS RESULT/);
});

test('recoverable uncertainty is autonomous and insufficient evidence is not blocked', () => {
  assert.match(skill, /INSUFFICIENT_EVIDENCE[\s\S]*not automatically (?:a )?(?:Founder stop|blocked)/i);
  assert.match(skill, /isolated worktree/);
  assert.match(skill, /dependency\/bootstrap recovery/);
  assert.match(skill, /Founder escalation[\s\S]*genuinely non-recoverable/i);
});

test('skill grants no direct capability or production authority', () => {
  assert.doesNotMatch(capabilities, /INDEPENDENT_CHALLENGE/);
  assert.match(skill, /does not authorize database writes,[\s\S]*deployment,[\s\S]*live-money actions/i);
  assert.match(skill, /Do not infer[\s\S]*permissions or[\s\S]*capabilities from this skill/i);
});

test('root guidance is a short reference rather than a duplicate workflow', () => {
  const agents = read('AGENTS.md');
  const section = agents.match(/## 8\.1 Independent challenge\r?\n([\s\S]*?)(?=\r?\n## )/);
  assert.ok(section, 'short independent-challenge section must exist');
  assert.ok(section[1].trim().split(/\r?\n/).length <= 8);
  assert.match(section[1], /\$polypropicks-independent-challenge/);
  assert.doesNotMatch(section[1], /PROVEN_FACTS|SUPPORTED_INFERENCES|UNVERIFIED_ASSUMPTIONS/);
});
