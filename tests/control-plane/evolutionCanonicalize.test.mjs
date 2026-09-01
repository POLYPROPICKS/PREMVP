import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateOperatorActions } from '../../scripts/control-plane/lib/operator-actions.mjs';
import { renderFounderReport } from '../../scripts/control-plane/lib/evolution-cycle.mjs';
import { renderGovernorFounderReport } from '../../scripts/control-plane/lib/evolution-governor.mjs';
import {
  admitCanonicalizationLineage,
  classifyEvolutionEvidencePath,
  COMMAND_ID,
  CYCLES_PREFIX,
  PROPOSALS_PREFIX,
  INPUT_BUNDLES_PREFIX,
} from '../../scripts/control-plane/lib/evolution-canonicalize.mjs';
import { resolveCanonicalizationAdapters } from '../../scripts/control-plane/evolution-canonicalize.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVOLUTION_DIR = 'docs/ai-context/control-plane/evolution';

// ---------------------------------------------------------------------------------------
// Synthetic deterministic fixtures — these are tests, not a real cycle or Governor run.
// Nothing here is ever written into cycles/ or roadmap-proposals/.
// ---------------------------------------------------------------------------------------

function operatorSummary() {
  const { ok, summary } = aggregateOperatorActions(
    [
      { action_id: 'A1', occurred_at: '2026-08-06T09:00:00Z', surface: 'CLOUDCODE', type: 'START', origin: 'FOUNDER_MANUAL', mission_id: 'M1', capture_coverage: 'COMPLETE', source_ref: 'transcript#1' },
      { action_id: 'A2', occurred_at: '2026-08-06T10:00:00Z', surface: 'CLOUDCODE', type: 'FOLLOW_UP', origin: 'FOUNDER_MANUAL', mission_id: 'M1', capture_coverage: 'COMPLETE', source_ref: 'transcript#2' },
    ],
    { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE', mission_count: 1, verified_result_count: 1 },
  );
  assert.equal(ok, true);
  return summary;
}

function claim(statement) {
  return { statement, evidence_class: 'PROVEN_IN_RUNTIME', evidence_refs: ['PR#101'] };
}

function hypothesis(id, classification = 'SYSTEM_LATER') {
  return {
    id,
    observed_problem: 'Сбор операторских действий делался вручную и расходился между источниками',
    why_it_matters: 'Ручной счёт нельзя сравнивать между периодами',
    axis_a_effect: 'none',
    axis_b_effect: 'Усиливает переиспользуемые валидаторы',
    proposed_automation: `Автоматизация ${id}`,
    persistent_artifact: 'scripts/control-plane/lib/operator-actions.mjs',
    expected_value: 'Стабильные сопоставимые метрики',
    implementation_cost: 'UNKNOWN',
    verification_cost: 'UNKNOWN',
    risk: 'Низкий: только чтение',
    success_metric: 'Полнота сбора становится полной',
    rollback_or_stop_condition: 'Останавливаемся, если сбор расходится с исходником',
    timing: 'Следующий цикл',
    classification,
    evidence_refs: ['PR#101'],
  };
}

function practice(id, skill) {
  return {
    id,
    skill_practiced: skill,
    why_it_matters_now: 'Сейчас решается, что считается доказательством',
    how_it_applies_to_current_project: 'Применяется к разбору ежедневной работы',
    persistent_git_artifact: `${EVOLUTION_DIR}/EVOLUTION_POLICY.yaml`,
  };
}

function experiment(id) {
  return {
    id,
    hypothesis: `Гипотеза ${id}`,
    bounded_scope: 'Один период, только чтение',
    persistent_artifact: `${EVOLUTION_DIR}/cycles/`,
    promotion_condition: 'Отчёт проходит проверку без правок',
    stop_condition: 'Проверка падает дважды подряд',
  };
}

function cycleFixture(overrides = {}) {
  return {
    schema_version: '1.0',
    cycle_id: '2026-08-06__synthetic',
    period_start: '2026-08-06T00:00:00Z',
    period_end: '2026-08-07T00:00:00Z',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: { executor: 'local_codex_windows', model_label: 'synthetic-test-fixture', prompt_id: 'premvp.prompt.daily_evolution_review.v1' },
    inputs: { completion_envelope_ids: ['CMP-SYNTHETIC-1'], confirmed_changes: ['PR#101'], input_bundle_ref: `${EVOLUTION_DIR}/input-bundles/synthetic.json` },
    axis_a: {
      verdict: 'NO_MEASURABLE_CHANGE',
      what_moved: [claim('Контур сбора данных стал воспроизводимым')],
      next_verified_production_fact_now_possible: 'Ночной прогон резервирований можно измерить',
      blockers_removed: [],
      blockers_introduced: [],
      not_proven: ['Расчёт по реальным сделкам'],
      runtime_or_business_evidence_exists: false,
      pnl: { reconciled_claimed: false, evidence_kinds: [], evidence_refs: [] },
    },
    axis_b: {
      verdict: 'CAPABILITY_ADDED',
      capabilities: [{
        domain: 'REUSABLE_FUNCTIONS_SCRIPTS_VALIDATORS',
        statement: 'Появился детерминированный сбор операторских действий',
        persisted_artifact: 'scripts/control-plane/lib/operator-actions.mjs',
        use_or_validation_evidence: 'Покрыт детерминированными тестами',
        evidence_refs: ['tests/control-plane/evolutionDailyReview.test.mjs'],
      }],
      not_proven: ['Запуск на облачном исполнителе'],
    },
    supporting_metrics: { role: 'DIAGNOSTIC_ONLY', values: { time_to_verified_result: 'UNKNOWN', cost_per_verified_result: 'NOT_AVAILABLE', reusable_artifacts_created: 3 } },
    operator_actions: operatorSummary(),
    automation_hypotheses: [hypothesis('H1', 'NOW'), hypothesis('H2', 'PRODUCT_FIRST'), hypothesis('H3'), hypothesis('H4'), hypothesis('H5', 'REJECT')],
    founder_practices: [practice('P1', 'Требовать доказательство вместо отчёта'), practice('P2', 'Задавать границы задачи заранее')],
    founder_practice_comparison: 'Первая практика дешевле и даёт эффект сразу, вторая требует подготовки',
    founder_practice_recommended_order: ['P1', 'P2'],
    experiments: [experiment('E1'), experiment('E2')],
    roadmap: { evolution_stage: 'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP', product_phase_unchanged: true, observed_product_phase: 'CONTUR3_QUEUE_AUTHORITY' },
    next_step: 'Собрать первый реальный период и прогнать разбор.',
    accepted: false,
    ...overrides,
  };
}

const GOV_CYCLES = ['2026-08-01__synthetic-a', '2026-08-02__synthetic-b', '2026-08-03__synthetic-c'];

function governorFixture(overrides = {}) {
  return {
    schema_version: '1.1',
    result_id: 'GOV-SYNTHETIC-1',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: { executor: 'local_codex_windows', model_label: 'synthetic-test-fixture', prompt_id: 'premvp.prompt.automation_roadmap_governor.v1' },
    generated_at: '2026-08-07T10:00:00Z',
    terminal_disposition: 'NO_AUTOMATION_NOW',
    eligibility: { eligible: true, reason: '3 new validated cycle(s) meets the minimum of 3', based_on_cycles: [...GOV_CYCLES], new_validated_cycle_count: 3, weekly_boundary_reached: false },
    findings: {
      axis_b_advancement: { statement: 'Сбор операторских действий стал воспроизводимым между тремя циклами', verdict: 'CAPABILITY_STRENGTHENED', evidence_refs: ['PR#109'] },
      axis_a_support_or_distraction: { statement: 'Разбор шёл параллельно работе над очередью, не заменял её', verdict: 'NEUTRAL', evidence_refs: [GOV_CYCLES[0]] },
      repeated_problems: [{ problem: 'Ручной подсчёт операторских действий расходился между источниками', repetition_count: 3, cycle_refs: [...GOV_CYCLES] }],
      experiments_with_evidence: [{ experiment_id: 'E1', outcome: 'PROMOTION_CONDITION_MET', evidence_refs: [GOV_CYCLES[2]] }],
      founder_skills_practiced: [{ ladder_id: 'VERIFICATION_DISCIPLINE', repetition_count: 3, cycle_refs: [...GOV_CYCLES] }],
      automation_decisions: [{ subject: 'Автоматический сбор операторских действий', decision: 'DEFER', reason: 'Ещё один период наблюдения снизит риск для Оси A', evidence_refs: [...GOV_CYCLES] }],
      roadmap_on_course: { statement: 'Stage 2 объём соответствует тому, что показали циклы', on_course: true },
      roadmap_delta_justified: false,
    },
    roadmap_delta: null,
    roadmap_factual_updates: { role: 'FACTUAL_ONLY', last_evaluated_at: '2026-08-07T10:00:00Z', cycle_count: 3, repetition_counts: { operator_action_mismatch: 3 } },
    founder_report_ref: null,
    next_step: 'Собрать ещё один реальный период и проверить, держится ли автоматический подсчёт.',
    accepted: false,
    ...overrides,
  };
}

function cyclePaths(cycle) {
  const json = `${CYCLES_PREFIX}${cycle.cycle_id}.json`;
  const report = `${CYCLES_PREFIX}${cycle.cycle_id}.report.md`;
  return {
    changedPaths: [json, report],
    files: { [json]: `${JSON.stringify(cycle, null, 2)}\n`, [report]: renderFounderReport(cycle) },
  };
}

function governorPaths(result) {
  const json = `${PROPOSALS_PREFIX}${result.result_id}.json`;
  const report = `${PROPOSALS_PREFIX}${result.result_id}.report.md`;
  return {
    changedPaths: [json, report],
    files: { [json]: `${JSON.stringify(result, null, 2)}\n`, [report]: renderGovernorFounderReport(result) },
  };
}

// ---------------------------------------------------------------------------------------
// 1. valid Evolution evidence lineage is admissible
// ---------------------------------------------------------------------------------------

test('a valid Evolution cycle evidence lineage is admissible', () => {
  const cycle = cycleFixture();
  const verdict = admitCanonicalizationLineage(cyclePaths(cycle));
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.admitted.cycles, [cycle.cycle_id]);
  assert.deepEqual(verdict.admitted.new_cycles, [cycle.cycle_id]);
  assert.equal(verdict.admitted.command_id, COMMAND_ID);
});

// ---------------------------------------------------------------------------------------
// 2. valid Governor evidence lineage is admissible
// ---------------------------------------------------------------------------------------

test('a valid Governor result evidence lineage is admissible', () => {
  const result = governorFixture();
  const verdict = admitCanonicalizationLineage(governorPaths(result));
  assert.deepEqual(verdict.errors, []);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.admitted.governor_results, [result.result_id]);
});

test('cloud Governor-result canonicalization selects GitHub MCP while retaining accepted:false', () => {
  const result = governorFixture();
  const adapters = resolveCanonicalizationAdapters('claude_code_cloud');
  const verdict = admitCanonicalizationLineage(governorPaths(result));
  assert.equal(result.accepted, false);
  assert.equal(adapters.create.operation, 'create_pull_request');
  assert.equal(adapters.merge.operation, 'merge_pull_request');
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.admitted.governor_results, [result.result_id]);
});

test('an Evolution input bundle required by a cycle is admissible alongside it', () => {
  const cycle = cycleFixture();
  const base = cyclePaths(cycle);
  const bundlePath = `${INPUT_BUNDLES_PREFIX}2026-08-06__synthetic.json`;
  const verdict = admitCanonicalizationLineage({
    changedPaths: [...base.changedPaths, bundlePath],
    files: { ...base.files, [bundlePath]: JSON.stringify({ bundle_id: '2026-08-06__synthetic' }) },
  });
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.admitted.input_bundles, [bundlePath]);
});

// ---------------------------------------------------------------------------------------
// 3. unexpected changed paths are rejected
// ---------------------------------------------------------------------------------------

test('an unrelated changed path outside the Evolution evidence allowlist is rejected', () => {
  const cycle = cycleFixture();
  const base = cyclePaths(cycle);
  const stray = 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml';
  const verdict = admitCanonicalizationLineage({
    changedPaths: [...base.changedPaths, stray],
    files: { ...base.files, [stray]: '{}' },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('UNEXPECTED_CHANGED_PATH') && e.includes('AGENT_REGISTRY.yaml')));
});

test('an Evolution schema, policy, prompt or correction change is not admissible', () => {
  for (const stray of [
    `${EVOLUTION_DIR}/schemas/EVOLUTION_CYCLE.schema.json`,
    `${EVOLUTION_DIR}/EVOLUTION_POLICY.yaml`,
    `${EVOLUTION_DIR}/prompts/DAILY_EVOLUTION_REVIEW.md`,
    `${EVOLUTION_DIR}/SCHEDULE_MANIFEST.yaml`,
    `${EVOLUTION_DIR}/corrections/COR-1.json`,
    `${EVOLUTION_DIR}/cycles/README.md`,
  ]) {
    assert.equal(classifyEvolutionEvidencePath(stray).ok, false, `${stray} must not classify as evidence`);
  }
});

test('a deletion of canonical Evolution evidence is rejected', () => {
  const cycle = cycleFixture();
  const json = `${CYCLES_PREFIX}${cycle.cycle_id}.json`;
  const report = `${CYCLES_PREFIX}${cycle.cycle_id}.report.md`;
  const verdict = admitCanonicalizationLineage({ changedPaths: [json, report], files: { [json]: null, [report]: null } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('EVIDENCE_DELETION_NOT_ADMISSIBLE')));
});

// ---------------------------------------------------------------------------------------
// 4. malformed / invalid artifacts are rejected
// ---------------------------------------------------------------------------------------

test('a malformed cycle artifact is rejected with an explicit MALFORMED_ARTIFACT violation', () => {
  const broken = cycleFixture();
  delete broken.founder_practices;
  const json = `${CYCLES_PREFIX}${broken.cycle_id}.json`;
  const report = `${CYCLES_PREFIX}${broken.cycle_id}.report.md`;
  const verdict = admitCanonicalizationLineage({
    changedPaths: [json, report],
    files: { [json]: JSON.stringify(broken, null, 2), [report]: 'placeholder — the json is rejected first' },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('MALFORMED_ARTIFACT') && e.includes('founder_practices')));
});

test('a cycle file that is not valid JSON is rejected', () => {
  const json = `${CYCLES_PREFIX}2026-08-06__synthetic.json`;
  const report = `${CYCLES_PREFIX}2026-08-06__synthetic.report.md`;
  const verdict = admitCanonicalizationLineage({ changedPaths: [json, report], files: { [json]: '{ not json', [report]: 'x' } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('MALFORMED_ARTIFACT') && e.includes('not valid JSON')));
});

test('a rendered report that does not match its deterministic regeneration is rejected', () => {
  const cycle = cycleFixture();
  const base = cyclePaths(cycle);
  base.files[`${CYCLES_PREFIX}${cycle.cycle_id}.report.md`] += '\nручная правка\n';
  const verdict = admitCanonicalizationLineage(base);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('ARTIFACT_REPORT_MISMATCH')));
});

test('a cycle canonicalized without its rendered report is rejected', () => {
  const cycle = cycleFixture();
  const json = `${CYCLES_PREFIX}${cycle.cycle_id}.json`;
  const verdict = admitCanonicalizationLineage({ changedPaths: [json], files: { [json]: JSON.stringify(cycle) } });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('MISSING_RENDERED_REPORT')));
});

// ---------------------------------------------------------------------------------------
// 5. accepted / self-accepted strategic state is rejected where policy requires accepted:false
// ---------------------------------------------------------------------------------------

test('a cycle representing itself as accepted is rejected', () => {
  const verdict = admitCanonicalizationLineage(cyclePaths(cycleFixture({ accepted: true })));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('SELF_ACCEPTED_STRATEGIC_STATE') && e.includes('accepted:true')));
});

test('a Governor lineage carrying a strategic authority field anywhere is rejected', () => {
  const result = governorFixture();
  result.roadmap_factual_updates.pnl_priority = 'Ось B выше Оси A';
  const verdict = admitCanonicalizationLineage(governorPaths(result));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('SELF_ACCEPTED_STRATEGIC_STATE') && e.includes('pnl_priority')));
});

test('a Governor result with an accepted roadmap delta is rejected', () => {
  const result = governorFixture({
    terminal_disposition: 'ONE_AUTOMATION_INVESTMENT',
    findings: { ...governorFixture().findings, roadmap_delta_justified: true, automation_decisions: [{ subject: 'Автосбор', decision: 'PROMOTE', reason: 'Три цикла подряд показали пользу', evidence_refs: [...GOV_CYCLES] }] },
    roadmap_delta: {
      roadmap_delta_id: 'RMD-1', based_on_cycles: [...GOV_CYCLES], current_stage: 'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE',
      proposed_change: 'Автосбор операторских действий', preserves: ['Приоритет Оси A над Осью B'], supersedes: [], retires: [],
      business_effect: 'Косвенный', manifest_2_effect: 'Усиливает переносимость', evidence: [{ statement: 'Три цикла', evidence_class: 'PROVEN_IN_RUNTIME', evidence_refs: ['PR#109'] }],
      opportunity_cost: 'Один цикл разработки', drift_from_original_roadmap: 'Небольшое', drift_justified: true,
      success_metric: 'Три совпадения подряд', rollback_condition: 'Расхождение более 10 процентов', accepted: true,
    },
  });
  const verdict = admitCanonicalizationLineage(governorPaths(result));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.includes('accepted')));
});

// ---------------------------------------------------------------------------------------
// Uniqueness / one-period-one-lineage semantics
// ---------------------------------------------------------------------------------------

test('a cycle for an evaluation period already canonical under another id is rejected', () => {
  const cycle = cycleFixture({ cycle_id: '2026-08-06__synthetic-retry' });
  const verdict = admitCanonicalizationLineage({
    ...cyclePaths(cycle),
    canonical: { cycleIds: ['2026-08-06__synthetic'], cyclePeriods: { '2026-08-06': '2026-08-06__synthetic' }, governorResultIds: [] },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('DUPLICATE_CANONICAL_CYCLE_FOR_PERIOD')));
});

test('more than one new cycle in a single canonicalization run is rejected', () => {
  const a = cycleFixture({ cycle_id: '2026-08-06__a', period_start: '2026-08-06T00:00:00Z' });
  const b = cycleFixture({ cycle_id: '2026-08-07__b', period_start: '2026-08-07T00:00:00Z', period_end: '2026-08-08T00:00:00Z' });
  const pa = cyclePaths(a);
  const pb = cyclePaths(b);
  const verdict = admitCanonicalizationLineage({
    changedPaths: [...pa.changedPaths, ...pb.changedPaths],
    files: { ...pa.files, ...pb.files },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('MULTIPLE_NEW_CYCLES_IN_BATCH')));
});

test('an empty lineage is rejected — canonicalization is never a no-op', () => {
  const verdict = admitCanonicalizationLineage({ changedPaths: [], files: {} });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('EMPTY_LINEAGE')));
});

// ---------------------------------------------------------------------------------------
// 6. Routine bindings expose the canonicalization lifecycle as their terminal persistence stage
// ---------------------------------------------------------------------------------------

test('both Evolution routines bind evolution_canonicalize as their terminal persistence stage', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'SCHEDULE_MANIFEST.yaml'), 'utf8'));
  assert.deepEqual(manifest.routines.map((r) => r.routine_id), [
    'premvp.routine.daily_evolution_review.v1',
    'premvp.routine.automation_roadmap_governor.v1',
  ]);
  for (const routine of manifest.routines) {
    assert.ok(routine.terminal_persistence_stage, `${routine.routine_id} missing terminal_persistence_stage`);
    assert.equal(routine.terminal_persistence_stage.command_id, COMMAND_ID);
    assert.ok(String(routine.terminal_persistence_stage.command || '').includes('control-plane:evolution:canonicalize'));
  }
  // The manifest still does not invent a registered scheduler.
  assert.equal(manifest.registered_routine_mechanism.status, 'NOT_FOUND_IN_CONTROL_PLANE');
  assert.equal(manifest.founder_ui_action_required.blocks_implementation, false);
});

test('the canonicalization lifecycle is registered and executable in the canonical registry', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'), 'utf8'));
  const entry = registry.entries.find((e) => e.canonical_id === COMMAND_ID);
  assert.ok(entry, `${COMMAND_ID} is not registered`);
  assert.equal(entry.type, 'COMMAND');
  assert.equal(entry.status, 'PROVEN_PRESENT');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.implementation_path)), `${entry.implementation_path} does not exist`);
  assert.ok(entry.repository_scope.includes('POLYPROPICKS/PREMVP'));
});

test('the lifecycle never widens beyond POLYPROPICKS/PREMVP — a foreign-repository cycle is already rejected by the reused validator', () => {
  const verdict = admitCanonicalizationLineage(cyclePaths(cycleFixture({ repository: 'SOMEONE/ELSE' })));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.startsWith('MALFORMED_ARTIFACT') && e.includes('repository boundary')));
});
