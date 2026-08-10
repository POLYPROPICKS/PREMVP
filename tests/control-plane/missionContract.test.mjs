/**
 * missionContract.test.mjs
 *
 * CP-HARDENING-01 regression suite for the semantic Mission Contract compiler.
 *
 * Every case here is a real failure mode of the retired prose-heavy prompt model: a
 * capability invented from a downstream effect, a risk class treated as a capability
 * source, ordinary application persistence mistaken for raw database mutation, an
 * unregistered command, and a recoverable condition dressed up as a hard boundary.
 *
 * Run: node --test tests/control-plane/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { compileMission, loadRegistry } from '../../scripts/control-plane/lib/mission-compile.mjs';
import { validateCommandBindings } from '../../scripts/control-plane/validate-command-bindings.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const registry = loadRegistry(root);
const ctx = { root, registry };

function mission(overrides = {}) {
  return {
    schema_version: '1.0',
    mission_id: 'CP-EXAMPLE-01',
    mission: 'Persist the resolved provider lineage on every reservation row.',
    business_result: 'Reservation provenance is auditable without re-deriving it from logs.',
    repository: 'POLYPROPICKS/PREMVP',
    repository_boundary: 'PREMVP',
    executor: 'local_codex_windows',
    risk_class: 'R1_BOUNDED_CODE',
    scope: {
      allowed_paths: ['lib/executor/**'],
      out_of_scope: ['scoring behavior', 'schema migrations'],
    },
    hard_boundaries: [
      'No schema migration.',
      'No production database mutation.',
      'No Ireland runtime access.',
    ],
    acceptance: [
      { id: 'A1', statement: 'Lineage is written by the existing application code path.', evaluated_at: 'TERMINAL', met: null },
    ],
    direct_actions: [
      {
        id: 'DA-EDIT',
        action: 'edit bounded application source inside the allowed paths',
        repository_boundary: 'PREMVP',
        persistence: 'NONE',
        requires_capabilities: ['REPOSITORY_READ', 'BUILD'],
      },
    ],
    required_capabilities: [
      { capability: 'REPOSITORY_READ', direct_action_ref: 'DA-EDIT' },
      { capability: 'BUILD', direct_action_ref: 'DA-EDIT' },
    ],
    commands: ['premvp.command.execution_precheck.v1'],
    operator_budget: { start: 1, intermediate: 0, terminal_result: 1 },
    modules: {},
    ...overrides,
  };
}

function errorsOf(m, options) {
  return compileMission(m, ctx, options).errors.join('\n');
}

test('0. the baseline mission compiles and emits no inapplicable module', () => {
  const r = compileMission(mission(), ctx);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.emitted_modules, []);
  assert.ok(r.omitted_modules.includes('LIVE MONEY'));
  assert.ok(!r.prompt.includes('## RELEASE'));
  assert.equal(r.resolved_capabilities.length, 2);
});

test('0b. every registered command has an executable binding', () => {
  assert.deepEqual(validateCommandBindings(root).errors, []);
});

// --- 1 & 2. Executor-owned recovery is never a mission boundary ---------------------------

test('1. a dirty Founder root is recovery, not a Founder hard stop', () => {
  const errors = errorsOf(mission({
    hard_boundaries: ['STOP if the Founder root is dirty and ask the Founder to clean it.'],
  }));
  assert.match(errors, /HARD_BOUNDARY_NOT_TERMINAL.*RECOVERABLE_CONDITION_RETURNED_AS_HARD_BLOCK: DIRTY_FOUNDER_ROOT/s);
});

test('2. missing locked dependencies are executor recovery, not Founder clarification', () => {
  const errors = errorsOf(mission({
    hard_boundaries: ['STOP when dependencies are missing and ask the Founder how to install them.'],
  }));
  assert.match(errors, /RECOVERABLE_CONDITION_RETURNED_AS_HARD_BLOCK: MISSING_LOCKED_DEPENDENCIES/);
});

// --- 3, 4, 5, 6, 7. Capability derivation ------------------------------------------------

test('3. a PREMVP Queue write with a downstream Ireland effect requires no Ireland capability', () => {
  // The executor writes the Queue. Ireland consumes it later. That consumption is a
  // downstream consequence, not a direct action, and creates no capability requirement.
  const ok = compileMission(mission({
    mission: 'Write Queue rows through the existing application path.',
    direct_actions: [{
      id: 'DA-QUEUE',
      action: 'write Queue rows through the existing application persistence path',
      repository_boundary: 'PREMVP',
      persistence: 'APPLICATION_OWNED',
      downstream_effects: ['Ireland later consumes the Queue'],
      requires_capabilities: ['REPOSITORY_READ'],
    }],
    required_capabilities: [{ capability: 'REPOSITORY_READ', direct_action_ref: 'DA-QUEUE' }],
  }), ctx);
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(ok.resolved_capabilities.map((c) => c.capability), ['REPOSITORY_READ']);

  // Requiring Ireland access for that same downstream effect must fail.
  const errors = errorsOf(mission({
    direct_actions: [{
      id: 'DA-QUEUE',
      action: 'write Queue rows through the existing application persistence path',
      repository_boundary: 'PREMVP',
      persistence: 'APPLICATION_OWNED',
      downstream_effects: ['Ireland later consumes the Queue'],
      requires_capabilities: ['REPOSITORY_READ', 'IRELAND_RUNTIME_ACCESS'],
    }],
    required_capabilities: [
      { capability: 'REPOSITORY_READ', direct_action_ref: 'DA-QUEUE' },
      { capability: 'IRELAND_RUNTIME_ACCESS', direct_action_ref: 'DA-QUEUE' },
    ],
  }));
  assert.match(errors, /FOREIGN_REPOSITORY_CAPABILITY_IN_SINGLE_BOUNDARY_MISSION: IRELAND_RUNTIME_ACCESS/);
});

test('4. application-owned persistence does not require raw DB mutation capability', () => {
  const errors = errorsOf(mission({
    direct_actions: [{
      id: 'DA-QUEUE',
      action: 'write Queue rows through the existing application persistence path',
      repository_boundary: 'PREMVP',
      persistence: 'APPLICATION_OWNED',
      requires_capabilities: ['DATABASE_WRITE'],
    }],
    required_capabilities: [{ capability: 'DATABASE_WRITE', direct_action_ref: 'DA-QUEUE' }],
  }));
  assert.match(errors, /APPLICATION_PERSISTENCE_NOT_RAW_DB_MUTATION: direct action DA-QUEUE/);

  // A genuine raw mutation may declare it.
  const raw = compileMission(mission({
    direct_actions: [{
      id: 'DA-SQL',
      action: 'apply one bounded reversible probe write',
      repository_boundary: 'PREMVP',
      persistence: 'RAW_DATABASE_MUTATION',
      requires_capabilities: ['DATABASE_WRITE'],
    }],
    required_capabilities: [{ capability: 'DATABASE_WRITE', direct_action_ref: 'DA-SQL' }],
  }), ctx);
  assert.equal(raw.ok, true, raw.errors.join('\n'));
});

test('5. risk class R5 alone injects no capability', () => {
  // No direct action, no required capability — the compiler must not widen the set from
  // the risk class, and "R5 means require everything" must not reappear.
  const r = compileMission(mission({
    risk_class: 'R5_CROSS_REPO_OR_LIVE_MONEY',
    direct_actions: [],
    required_capabilities: [],
  }), ctx);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.resolved_capabilities, []);

  const errors = errorsOf(mission({
    risk_class: 'R5_CROSS_REPO_OR_LIVE_MONEY',
    derive_capabilities_from_risk: true,
  }));
  assert.match(errors, /RISK_INJECTED_CAPABILITY/);
});

test('6. a capability with no direct action fails compilation', () => {
  const noRef = errorsOf(mission({
    required_capabilities: [
      { capability: 'REPOSITORY_READ', direct_action_ref: 'DA-EDIT' },
      { capability: 'BUILD', direct_action_ref: 'DA-EDIT' },
      { capability: 'DEPLOY' },
    ],
  }));
  assert.match(noRef, /CAPABILITY_WITHOUT_DIRECT_ACTION: DEPLOY/);

  const danglingRef = errorsOf(mission({
    required_capabilities: [{ capability: 'DEPLOY', direct_action_ref: 'DA-GHOST' }],
  }));
  assert.match(danglingRef, /CAPABILITY_DIRECT_ACTION_UNKNOWN: DEPLOY -> DA-GHOST/);

  const undeclared = errorsOf(mission({
    required_capabilities: [{ capability: 'DEPLOY', direct_action_ref: 'DA-EDIT' }],
  }));
  assert.match(undeclared, /CAPABILITY_NOT_REQUIRED_BY_DIRECT_ACTION: DEPLOY/);
});

test('7. a foreign repository boundary in a single-repository mission fails', () => {
  const errors = errorsOf(mission({
    direct_actions: [
      mission().direct_actions[0],
      {
        id: 'DA-IRL', action: 'run the Ireland executor', repository_boundary: 'IRELAND',
        persistence: 'NONE', requires_capabilities: [],
      },
    ],
  }));
  assert.match(errors, /REPOSITORY_BOUNDARY_MIXED: direct action DA-IRL/);
});

// --- 8. Command validity -----------------------------------------------------------------

test('8. an invented or unusable command fails compilation', () => {
  assert.match(errorsOf(mission({ commands: ['premvp.command.does_not_exist.v9'] })),
    /COMMAND_NOT_REGISTERED: premvp\.command\.does_not_exist\.v9/);

  // Registered but PLANNED — a registration alone is not an executable binding.
  assert.match(errorsOf(mission({ commands: ['claude.command.github_pr_merge.v0'] })),
    /COMMAND_NOT_EXECUTABLE: claude\.command\.github_pr_merge\.v0/);

  // Registered, bound, but not invokable by the selected executor.
  assert.match(errorsOf(mission({ executor: 'local_codex_windows', commands: ['claude.command.verify'] })),
    /COMMAND_NOT_INVOKABLE_BY_EXECUTOR: claude\.command\.verify is CLAUDE_ONLY/);
});

// --- 9, 10, 11. Non-terminal reasons and the operator budget -----------------------------

test('9. a recoverable outcome with a Founder action fails the operator budget', () => {
  assert.match(errorsOf(mission({ operator_budget: { start: 1, intermediate: 1, terminal_result: 1 } })),
    /OPERATOR_BUDGET_VIOLATION: intermediate must be 0/);
});

test('10. "implementation incomplete" is not a hard boundary', () => {
  assert.match(errorsOf(mission({
    hard_boundaries: ['STOP and report BLOCKED when the implementation is incomplete.'],
  })), /INCOMPLETE_IS_NOT_TERMINAL/);
});

test('11. session execution time ending is not a business boundary', () => {
  assert.match(errorsOf(mission({
    hard_boundaries: ['STOP with PROMPT_GATE_BLOCKED when the session execution time ended.'],
  })), /SESSION_END_IS_NOT_BUSINESS_BLOCK/);
});

// --- 13. Acceptance is measured after execution ------------------------------------------

test('13. an unmet TERMINAL criterion does not fail the START GATE', () => {
  const m = mission({
    acceptance: [
      { id: 'A1', statement: 'Compiler rejects risk-injected capabilities.', evaluated_at: 'TERMINAL', met: false },
      { id: 'A0', statement: 'Repository boundary is PREMVP.', evaluated_at: 'START_GATE', met: true },
    ],
  });
  assert.equal(compileMission(m, ctx, { phase: 'START_GATE' }).ok, true);

  const terminal = compileMission(m, ctx, { phase: 'TERMINAL' });
  assert.equal(terminal.ok, false);
  assert.match(terminal.errors.join('\n'), /TERMINAL_ACCEPTANCE_NOT_MET: A1/);

  // A START_GATE criterion that is already false does block the start.
  assert.match(errorsOf(mission({
    acceptance: [
      { id: 'A0', statement: 'Repository boundary is PREMVP.', evaluated_at: 'START_GATE', met: false },
      { id: 'A1', statement: 'Lineage persisted.', evaluated_at: 'TERMINAL', met: null },
    ],
  })), /START_GATE_ACCEPTANCE_NOT_MET: A0/);
});

// --- 14. Registered lifecycle may not be restated as mission prose -----------------------

test('14. duplicating registered lifecycle mechanics in mission prose fails', () => {
  assert.match(errorsOf(mission({
    scope: { allowed_paths: ['lib/**'], out_of_scope: ['git fetch and poll deployment status'] },
  })), /MISSION_MANUAL_ORCHESTRATION_DUPLICATION/);

  assert.match(errorsOf(mission({
    modules: { RELEASE: 'Run npm ci, then create pull request and merge pull request.' },
  })), /MISSION_MANUAL_ORCHESTRATION_DUPLICATION/);
});

// --- Structural guards --------------------------------------------------------------------

test('mission core, module names and executor identity are enforced', () => {
  assert.match(errorsOf(mission({ business_result: '' })), /MISSING_MISSION_CORE: business_result/);
  assert.match(errorsOf(mission({ hard_boundaries: [] })), /MISSING_MISSION_CORE: hard_boundaries/);
  assert.match(errorsOf(mission({ modules: { ROADMAP: 'x' } })), /UNKNOWN_MODULE: ROADMAP/);
  assert.match(errorsOf(mission({ executor: 'default' })), /DEFAULT_OR_FALLBACK_EXECUTOR/);
  assert.match(errorsOf(mission({ repository_boundary: 'BOTH' })), /INVALID_REPOSITORY_BOUNDARY/);
});

test('a mission with only START_GATE acceptance has nothing to measure and fails', () => {
  assert.match(errorsOf(mission({
    acceptance: [{ id: 'A0', statement: 'Boundary is PREMVP.', evaluated_at: 'START_GATE', met: true }],
  })), /ACCEPTANCE_HAS_NO_TERMINAL_CRITERION/);
});
