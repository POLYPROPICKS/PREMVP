import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateOperatorActions,
  dedupeOperatorActions,
  validateOperatorActionEvent,
  validateOperatorActionSummary,
} from '../../scripts/control-plane/lib/operator-actions.mjs';

import {
  validateEvolutionCycle,
  validateAutomationHypothesis,
  validateFounderCorrection,
  renderFounderReport,
  validateFounderReport,
  FOUNDER_REPORT_HEADINGS,
} from '../../scripts/control-plane/lib/evolution-cycle.mjs';

import { collectEvolutionInputs } from '../../scripts/control-plane/evolution-collect.mjs';
import { evaluateEvolutionCycle } from '../../scripts/control-plane/evolution-evaluate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVOLUTION_DIR = 'docs/ai-context/control-plane/evolution';

// ---------------------------------------------------------------------------------------
// Synthetic deterministic fixtures. These are tests, not a dry run and not a real cycle:
// no fixture is ever written into cycles/.
// ---------------------------------------------------------------------------------------

function event(overrides = {}) {
  return {
    action_id: 'A1',
    occurred_at: '2026-08-06T09:00:00Z',
    surface: 'CLOUDCODE',
    type: 'START',
    origin: 'FOUNDER_MANUAL',
    mission_id: 'M1',
    capture_coverage: 'COMPLETE',
    source_ref: 'transcript#1',
    ...overrides,
  };
}

function claim(statement, evidenceClass = 'PROVEN_IN_RUNTIME') {
  return { statement, evidence_class: evidenceClass, evidence_refs: ['PR#101'] };
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

function operatorSummaryFixture() {
  const { ok, summary } = aggregateOperatorActions(
    [
      event({ action_id: 'A1', type: 'START' }),
      event({ action_id: 'A2', type: 'FOLLOW_UP', occurred_at: '2026-08-06T10:00:00Z' }),
      event({ action_id: 'A3', type: 'HANDOFF', surface: 'CODEX', occurred_at: '2026-08-06T11:00:00Z' }),
    ],
    {
      period_start: '2026-08-06T00:00:00Z',
      period_end: '2026-08-07T00:00:00Z',
      declared_capture_coverage: 'COMPLETE',
      mission_count: 1,
      verified_result_count: 1,
    },
  );
  assert.equal(ok, true);
  return summary;
}

function cycleFixture(overrides = {}) {
  return {
    schema_version: '1.0',
    cycle_id: '2026-08-06__synthetic',
    period_start: '2026-08-06T00:00:00Z',
    period_end: '2026-08-07T00:00:00Z',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: {
      executor: 'local_codex_windows',
      model_label: 'synthetic-test-fixture',
      prompt_id: 'premvp.prompt.daily_evolution_review.v1',
    },
    inputs: {
      completion_envelope_ids: ['CMP-SYNTHETIC-1'],
      confirmed_changes: ['PR#101'],
      input_bundle_ref: `${EVOLUTION_DIR}/input-bundles/synthetic.json`,
    },
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
      capabilities: [
        {
          domain: 'REUSABLE_FUNCTIONS_SCRIPTS_VALIDATORS',
          statement: 'Появился детерминированный сбор операторских действий',
          persisted_artifact: 'scripts/control-plane/lib/operator-actions.mjs',
          use_or_validation_evidence: 'Покрыт детерминированными тестами',
          evidence_refs: ['tests/control-plane/evolutionDailyReview.test.mjs'],
        },
      ],
      not_proven: ['Запуск на облачном исполнителе'],
    },
    supporting_metrics: {
      role: 'DIAGNOSTIC_ONLY',
      values: {
        time_to_verified_result: 'UNKNOWN',
        cost_per_verified_result: 'NOT_AVAILABLE',
        reusable_artifacts_created: 3,
      },
    },
    operator_actions: operatorSummaryFixture(),
    automation_hypotheses: [
      hypothesis('H1', 'NOW'),
      hypothesis('H2', 'PRODUCT_FIRST'),
      hypothesis('H3', 'SYSTEM_LATER'),
      hypothesis('H4', 'SYSTEM_LATER'),
      hypothesis('H5', 'REJECT'),
    ],
    founder_practices: [
      practice('P1', 'Требовать доказательство вместо отчёта'),
      practice('P2', 'Задавать границы задачи заранее'),
    ],
    founder_practice_comparison: 'Первая практика дешевле и даёт эффект сразу, вторая требует подготовки',
    founder_practice_recommended_order: ['P1', 'P2'],
    experiments: [experiment('E1'), experiment('E2')],
    roadmap: {
      evolution_stage: 'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP',
      product_phase_unchanged: true,
      observed_product_phase: 'CONTUR3_QUEUE_AUTHORITY',
    },
    next_step: 'Собрать первый реальный период и прогнать разбор.',
    accepted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Operator action contract
// ---------------------------------------------------------------------------------------

test('operator action events are deduplicated by action_id, keeping the first in deterministic order', () => {
  const { kept, duplicates } = dedupeOperatorActions([
    event({ action_id: 'A2', occurred_at: '2026-08-06T10:00:00Z', note: 'second' }),
    event({ action_id: 'A1', occurred_at: '2026-08-06T09:00:00Z', note: 'first' }),
    event({ action_id: 'A1', occurred_at: '2026-08-06T09:00:00Z', note: 'duplicate report' }),
  ]);
  assert.deepEqual(kept.map((e) => e.action_id), ['A1', 'A2']);
  assert.equal(kept[0].note, 'first');
  assert.deepEqual(duplicates, [{ action_id: 'A1', reason: 'DUPLICATE_ACTION_ID' }]);
});

test('deduplication is order-independent — shuffled input produces an identical summary', () => {
  const events = [
    event({ action_id: 'A1' }),
    event({ action_id: 'A2', occurred_at: '2026-08-06T10:00:00Z', type: 'RETRY' }),
    event({ action_id: 'A2', occurred_at: '2026-08-06T10:00:00Z', type: 'RETRY' }),
    event({ action_id: 'A3', occurred_at: '2026-08-06T11:00:00Z', type: 'APPROVAL', surface: 'CODEX' }),
  ];
  const options = { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE' };
  const forward = aggregateOperatorActions(events, options);
  const reversed = aggregateOperatorActions([...events].reverse(), options);
  assert.deepEqual(reversed.summary, forward.summary);
  assert.equal(forward.summary.total_operator_actions, 3);
  assert.equal(forward.summary.duplicates_dropped, 1);
});

test('executor-internal work is never counted as an operator action', () => {
  const { summary } = aggregateOperatorActions([
    event({ action_id: 'A1' }),
    event({ action_id: 'A2', origin: 'EXECUTOR_INTERNAL', type: 'RETRY', occurred_at: '2026-08-06T09:30:00Z' }),
  ], { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE' });

  assert.equal(summary.total_operator_actions, 1);
  assert.equal(summary.by_type.RETRY, 0);
  assert.deepEqual(summary.excluded, [{ action_id: 'A2', reason: 'EXECUTOR_INTERNAL' }]);
});

test('architect corrections are tracked separately and excluded from the operator total', () => {
  const { summary } = aggregateOperatorActions([
    event({ action_id: 'A1' }),
    event({ action_id: 'A2', origin: 'ARCHITECT', type: 'CORRECTION', occurred_at: '2026-08-06T09:30:00Z' }),
    event({ action_id: 'A3', origin: 'ARCHITECT', type: 'CORRECTION', occurred_at: '2026-08-06T09:40:00Z' }),
  ], { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE' });

  assert.equal(summary.total_operator_actions, 1);
  assert.equal(summary.architect_corrections, 2);
  assert.equal(summary.by_type.CORRECTION, 0);
});

test('aggregation totals reconcile across type and surface', () => {
  const summary = operatorSummaryFixture();
  const typeSum = Object.values(summary.by_type).reduce((a, b) => a + b, 0);
  const surfaceSum = Object.values(summary.by_surface).reduce((a, b) => a + b, 0);
  assert.equal(typeSum, summary.total_operator_actions);
  assert.equal(surfaceSum, summary.total_operator_actions);
  assert.equal(validateOperatorActionSummary(summary).ok, true);
});

test('capture coverage is worst-wins and defaults to UNKNOWN, which forces derived ratios to UNKNOWN', () => {
  const partial = aggregateOperatorActions([
    event({ action_id: 'A1', capture_coverage: 'COMPLETE' }),
    event({ action_id: 'A2', capture_coverage: 'PARTIAL', occurred_at: '2026-08-06T10:00:00Z' }),
  ], { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE', mission_count: 1, verified_result_count: 1 });
  assert.equal(partial.summary.capture_coverage, 'PARTIAL');
  assert.equal(typeof partial.summary.derived.actions_per_verified_result, 'number');

  const undeclared = aggregateOperatorActions([
    { action_id: 'A1', occurred_at: '2026-08-06T09:00:00Z', surface: 'CODEX', type: 'START', origin: 'FOUNDER_MANUAL', mission_id: 'M1' },
  ], { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', mission_count: 1, verified_result_count: 1 });
  assert.equal(undeclared.summary.capture_coverage, 'UNKNOWN');
  assert.equal(undeclared.summary.derived.actions_per_verified_result, 'UNKNOWN');
  assert.equal(undeclared.summary.derived.intermediate_actions_per_mission, 'UNKNOWN');
});

test('a COMPLETE coverage claim without a source reference is rejected', () => {
  const result = validateOperatorActionEvent(event({ source_ref: undefined }), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('source_ref')));
});

test('a zero denominator yields UNKNOWN rather than a divide-by-zero number', () => {
  const { summary } = aggregateOperatorActions([event({ action_id: 'A1' })], {
    period_start: '2026-08-06T00:00:00Z',
    period_end: '2026-08-07T00:00:00Z',
    declared_capture_coverage: 'COMPLETE',
    mission_count: 1,
    verified_result_count: 0,
  });
  assert.equal(summary.derived.actions_per_verified_result, 'UNKNOWN');
});

test('events outside the period are excluded with an explicit reason', () => {
  const { summary } = aggregateOperatorActions([
    event({ action_id: 'A1' }),
    event({ action_id: 'A0', occurred_at: '2026-08-01T09:00:00Z' }),
  ], { period_start: '2026-08-06T00:00:00Z', period_end: '2026-08-07T00:00:00Z', declared_capture_coverage: 'COMPLETE' });
  assert.equal(summary.total_operator_actions, 1);
  assert.ok(summary.excluded.some((e) => e.action_id === 'A0' && e.reason === 'OUT_OF_PERIOD'));
});

// ---------------------------------------------------------------------------------------
// Collection command
// ---------------------------------------------------------------------------------------

test('collection derives surface metrics from evidence and leaves unmeasured metrics UNKNOWN', () => {
  const { ok, collection } = collectEvolutionInputs({
    bundle_id: 'synthetic',
    repository: 'POLYPROPICKS/PREMVP',
    period_start: '2026-08-06T00:00:00Z',
    period_end: '2026-08-07T00:00:00Z',
    capture_coverage: 'COMPLETE',
    mission_count: 1,
    verified_result_count: 1,
    operator_action_events: [
      event({ action_id: 'A1' }),
      event({ action_id: 'A2', surface: 'CODEX', type: 'HANDOFF', occurred_at: '2026-08-06T10:00:00Z' }),
    ],
    supporting_metrics: { cost_per_verified_result: 'this is a guess' },
  });

  assert.equal(ok, true);
  assert.equal(collection.supporting_metrics.role, 'DIAGNOSTIC_ONLY');
  assert.equal(collection.supporting_metrics.values.cloudcode_actions, 1);
  assert.equal(collection.supporting_metrics.values.codex_actions, 1);
  // An unparseable supplied value is replaced by UNKNOWN, never carried through as data.
  assert.equal(collection.supporting_metrics.values.cost_per_verified_result, 'UNKNOWN');
  assert.equal(collection.supporting_metrics.values.time_to_verified_result, 'UNKNOWN');
});

test('collection refuses a bundle from another repository boundary', () => {
  const { ok, errors } = collectEvolutionInputs({
    bundle_id: 'synthetic',
    repository: 'SOMEONE/ELSE',
    period_start: '2026-08-06T00:00:00Z',
    period_end: '2026-08-07T00:00:00Z',
    operator_action_events: [],
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('POLYPROPICKS/PREMVP')));
});

// ---------------------------------------------------------------------------------------
// Cycle contract
// ---------------------------------------------------------------------------------------

test('a well-formed synthetic cycle passes every Stage 1 contract', () => {
  const result = validateEvolutionCycle(cycleFixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('axis verdicts stay independent — a strong Axis B does not lift Axis A', () => {
  const cycle = cycleFixture();
  assert.equal(cycle.axis_b.verdict, 'CAPABILITY_ADDED');
  assert.equal(cycle.axis_a.verdict, 'NO_MEASURABLE_CHANGE');
  assert.equal(validateEvolutionCycle(cycle).ok, true);
});

test('Axis A ADVANCED without runtime or business evidence is rejected', () => {
  const cycle = cycleFixture();
  cycle.axis_a.verdict = 'ADVANCED';
  cycle.axis_a.runtime_or_business_evidence_exists = false;
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('ADVANCED requires runtime_or_business_evidence_exists')));
});

test('a reconciled PnL claim without fills, fees and settlement evidence is rejected outright', () => {
  const cycle = cycleFixture();
  cycle.axis_a.pnl = { reconciled_claimed: true, evidence_kinds: ['FILLS'], evidence_refs: ['PR#101'] };
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.startsWith('UNSUPPORTED_PNL_CLAIM')));
  assert.ok(errors.some((e) => e.includes('FEES') && e.includes('SETTLEMENT')));
});

test('a fully evidenced reconciled PnL claim is accepted', () => {
  const cycle = cycleFixture();
  cycle.axis_a.pnl = {
    reconciled_claimed: true,
    evidence_kinds: ['FILLS', 'FEES', 'SETTLEMENT'],
    evidence_refs: ['ledger#settled-2026-08-06'],
  };
  assert.equal(validateEvolutionCycle(cycle).ok, true);
});

test('supporting metrics can never carry an axis verdict', () => {
  const cycle = cycleFixture();
  cycle.supporting_metrics.values.axis_a_verdict = 1;
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('may never override Axis A or Axis B')));
});

test('supporting metrics reject a guessed value in place of UNKNOWN', () => {
  const cycle = cycleFixture();
  cycle.supporting_metrics.values.cost_per_verified_result = 'roughly $12';
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('never guessed')));
});

test('supporting metrics must declare themselves diagnostic only', () => {
  const cycle = cycleFixture();
  cycle.supporting_metrics.role = 'AUTHORITATIVE';
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('DIAGNOSTIC_ONLY')));
});

test('a material claim without an evidence reference is rejected', () => {
  const cycle = cycleFixture();
  cycle.axis_a.what_moved = [{ statement: 'Стало лучше', evidence_class: 'SUPPORTED', evidence_refs: [] }];
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('never accepted bare')));
});

test('an Axis B capability with no persisted artifact is not a proven capability', () => {
  const cycle = cycleFixture();
  cycle.axis_b.capabilities[0].persisted_artifact = '';
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('merely described is not proven')));
});

test('CAPABILITY_ADDED with an empty capability list is a contradiction', () => {
  const cycle = cycleFixture();
  cycle.axis_b.capabilities = [];
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('requires at least one capability')));
});

test('exactly two Founder practices are enforced in both directions', () => {
  for (const count of [1, 3]) {
    const cycle = cycleFixture();
    cycle.founder_practices = Array.from({ length: count }, (_, i) => practice(`P${i}`, `Навык ${i}`));
    cycle.founder_practice_recommended_order = ['P0', 'P1'];
    const { ok, errors } = validateEvolutionCycle(cycle);
    assert.equal(ok, false, `expected ${count} practices to be rejected`);
    assert.ok(errors.some((e) => e.includes('exactly 2 entries')));
  }
});

test('the two practices must be compared and ordered', () => {
  const cycle = cycleFixture();
  cycle.founder_practice_recommended_order = ['P1', 'P9'];
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unknown practice id P9')));
});

test('experiments are bounded to two or three, each with a stop condition', () => {
  const tooFew = cycleFixture({ experiments: [experiment('E1')] });
  assert.equal(validateEvolutionCycle(tooFew).ok, false);

  const tooMany = cycleFixture({ experiments: ['E1', 'E2', 'E3', 'E4'].map(experiment) });
  assert.equal(validateEvolutionCycle(tooMany).ok, false);

  const missingStop = cycleFixture();
  missingStop.experiments[0].stop_condition = '';
  const { ok, errors } = validateEvolutionCycle(missingStop);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('stop_condition')));
});

test('fewer than five hypotheses requires an explicit insufficient-evidence classification', () => {
  const cycle = cycleFixture({ automation_hypotheses: [hypothesis('H1'), hypothesis('H2')] });
  const rejected = validateEvolutionCycle(cycle);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((e) => e.includes('never invent hypotheses')));

  cycle.insufficient_supported_hypotheses = true;
  cycle.insufficient_supported_hypotheses_reason = 'Период содержал одну задачу, больше обоснованных проблем не наблюдалось';
  assert.equal(validateEvolutionCycle(cycle).ok, true);
});

test('the insufficient-evidence flag still requires a reason', () => {
  const cycle = cycleFixture({ automation_hypotheses: [hypothesis('H1')] });
  cycle.insufficient_supported_hypotheses = true;
  const { ok, errors } = validateEvolutionCycle(cycle);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('insufficient_supported_hypotheses_reason')));
});

test('more than eight hypotheses is rejected', () => {
  const cycle = cycleFixture({
    automation_hypotheses: Array.from({ length: 9 }, (_, i) => hypothesis(`H${i}`)),
  });
  assert.equal(validateEvolutionCycle(cycle).ok, false);
});

test('a hypothesis must name the artifact that survives in Git', () => {
  const { ok, errors } = validateAutomationHypothesis({ ...hypothesis('H1'), persistent_artifact: '' }, 'h');
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('persistent_artifact')));
});

test('a cycle can never accept itself, and can never change the product phase', () => {
  const selfAccepted = cycleFixture({ accepted: true });
  assert.ok(validateEvolutionCycle(selfAccepted).errors.some((e) => e.includes('evidence and proposal only')));

  const phaseChange = cycleFixture();
  phaseChange.roadmap.product_phase_unchanged = false;
  assert.ok(validateEvolutionCycle(phaseChange).errors.some((e) => e.includes('never changes the product phase')));
});

test('a cycle from another repository boundary is rejected', () => {
  const cycle = cycleFixture({ repository: 'SOMEONE/ELSE' });
  assert.ok(validateEvolutionCycle(cycle).errors.some((e) => e.includes('repository boundary')));
});

test('an invented Evolution stage is rejected — there are exactly three approved levels', () => {
  const cycle = cycleFixture();
  cycle.roadmap.evolution_stage = 'STAGE_4_SOMETHING_NEW';
  assert.equal(validateEvolutionCycle(cycle).ok, false);
});

// ---------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------

test('a correction round-trips through JSON and is readable without any chat context', () => {
  const correction = {
    correction_id: 'COR-SYNTHETIC-1',
    recorded_at: '2026-08-06T12:00:00Z',
    source: 'FOUNDER',
    subject: 'Операторские действия',
    what_was_wrong: 'Внутренние команды исполнителя считались как действия оператора',
    what_is_correct: 'Считается только сообщение, отправленное вручную',
    why_it_matters: 'Иначе метрика ручного труда завышена и несопоставима',
    applies_to: [`${EVOLUTION_DIR}/OPERATOR_ACTION_POLICY.yaml`],
    cycle_id: '2026-08-06__synthetic',
    evidence_refs: ['PR#101'],
    accepted: false,
  };
  assert.equal(validateFounderCorrection(correction).ok, true);

  const reread = JSON.parse(JSON.stringify(correction));
  assert.equal(validateFounderCorrection(reread).ok, true);
  assert.equal(reread.applies_to[0], `${EVOLUTION_DIR}/OPERATOR_ACTION_POLICY.yaml`);

  const selfAccepted = { ...correction, accepted: true };
  assert.equal(validateFounderCorrection(selfAccepted).ok, false);

  const unenforceable = { ...correction, applies_to: [] };
  assert.ok(validateFounderCorrection(unenforceable).errors.some((e) => e.includes('cannot be enforced later')));
});

// ---------------------------------------------------------------------------------------
// Founder report contract
// ---------------------------------------------------------------------------------------

test('the rendered Founder report satisfies the heading and style contract', () => {
  const report = renderFounderReport(cycleFixture());
  const result = validateFounderReport(report);
  assert.deepEqual(result.errors, []);

  const headings = report.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(headings, [...FOUNDER_REPORT_HEADINGS]);
});

test('the Founder report carries no schema dumps and no code fences', () => {
  const report = renderFounderReport(cycleFixture());
  assert.ok(!report.includes('```'));
  assert.ok(!report.includes('schema_version'));
  assert.ok(!report.includes('evidence_class'));
  assert.ok(!report.includes('"'));
});

test('the Founder report states unknown metrics as unknown, never as zero', () => {
  const report = renderFounderReport(cycleFixture());
  assert.ok(report.includes('неизвестно'));
  assert.ok(report.includes('нет данных'));
});

test('the Founder report refuses to imply reconciled PnL that was not claimed', () => {
  const report = renderFounderReport(cycleFixture());
  assert.ok(report.includes('Сверенный PnL: не заявлен'));
});

test('a report with reordered or missing headings is rejected', () => {
  const report = renderFounderReport(cycleFixture());
  const reordered = report.replace('## Что доказано', '## Доказано');
  assert.equal(validateFounderReport(reordered).ok, false);

  const truncated = report.split('## Roadmap')[0];
  assert.equal(validateFounderReport(truncated).ok, false);
});

test('a report with an empty section is rejected', () => {
  const cycle = cycleFixture();
  const report = renderFounderReport(cycle).replace(/## Что произойдёт дальше\n[\s\S]*$/, '## Что произойдёт дальше\n');
  assert.equal(validateFounderReport(report).ok, false);
});

test('a report that leaks raw machine structure is rejected', () => {
  const report = `${renderFounderReport(cycleFixture())}\n\nschema_version: 1.0\n`;
  const { ok, errors } = validateFounderReport(report);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('schema dumps')));
});

// ---------------------------------------------------------------------------------------
// End-to-end evaluation and cross-environment consumability
// ---------------------------------------------------------------------------------------

test('evaluation renders a report only for an admissible cycle', () => {
  const good = evaluateEvolutionCycle(cycleFixture());
  assert.equal(good.ok, true);
  assert.ok(good.report.startsWith('# Daily Evolution Review'));

  const bad = evaluateEvolutionCycle(cycleFixture({ accepted: true }));
  assert.equal(bad.ok, false);
  assert.equal(bad.report, null);
});

test('rendering is deterministic — the same cycle produces a byte-identical report', () => {
  assert.equal(renderFounderReport(cycleFixture()), renderFounderReport(cycleFixture()));
});

test('every Evolution artifact another session needs is present and machine-readable', () => {
  const yamlFiles = [
    'EVOLUTION_POLICY.yaml',
    'AUTOMATION_ROADMAP.yaml',
    'FOUNDER_CAPABILITY_LADDER.yaml',
    'OPERATOR_ACTION_POLICY.yaml',
    'TOOL_AND_ENVIRONMENT_PORTABILITY.yaml',
  ];
  const schemaFiles = [
    'EVOLUTION_CYCLE.schema.json',
    'AUTOMATION_HYPOTHESIS.schema.json',
    'FOUNDER_CORRECTION.schema.json',
    'OPERATOR_ACTION_EVENT.schema.json',
    'OPERATOR_ACTION_SUMMARY.schema.json',
  ];

  for (const rel of yamlFiles) {
    const full = path.join(REPO_ROOT, EVOLUTION_DIR, rel);
    assert.ok(fs.existsSync(full), `missing ${rel}`);
    // Same JSON-compatible YAML subset as the rest of the control plane.
    JSON.parse(fs.readFileSync(full, 'utf8'));
  }
  for (const rel of schemaFiles) {
    const full = path.join(REPO_ROOT, EVOLUTION_DIR, 'schemas', rel);
    assert.ok(fs.existsSync(full), `missing schema ${rel}`);
    JSON.parse(fs.readFileSync(full, 'utf8'));
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'prompts/DAILY_EVOLUTION_REVIEW.md')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'README.md')));
});

test('the report heading contract in code matches the heading contract in policy', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'EVOLUTION_POLICY.yaml'), 'utf8'));
  assert.deepEqual(policy.founder_report.required_headings, [...FOUNDER_REPORT_HEADINGS]);
});

test('the roadmap holds exactly the three approved levels', () => {
  const roadmap = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'AUTOMATION_ROADMAP.yaml'), 'utf8'));
  assert.deepEqual(roadmap.levels.map((l) => l.id), [
    'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP',
    'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE',
    'VISION_AGENT_OPERATING_SYSTEM',
  ]);
});

test('the Founder capability ladder holds the seven approved levels in order', () => {
  const ladder = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'FOUNDER_CAPABILITY_LADDER.yaml'), 'utf8'));
  assert.deepEqual(ladder.levels.map((l) => l.level), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ladder.levels.map((l) => l.id), [
    'MISSION_DISCIPLINE', 'VERIFICATION_DISCIPLINE', 'PERMISSION_AND_TOOL_DESIGN',
    'AUTOMATION_ECONOMICS', 'DURABLE_OPERATIONS', 'CONTROL_PLANE_OWNERSHIP',
    'CONTROLLED_SELF_IMPROVEMENT',
  ]);
  // Description alone must never promote a level.
  assert.ok(ladder.levels.every((l) => l.status === 'NOT_ASSESSED'));
});

test('every persisted cycle under cycles/ is schema-valid and carries its rendered report', () => {
  const dir = path.join(REPO_ROOT, EVOLUTION_DIR, 'cycles');
  const entries = fs.readdirSync(dir);
  const cycleFiles = entries.filter((f) => f.endsWith('.json'));
  for (const file of cycleFiles) {
    const cycle = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const result = validateEvolutionCycle(cycle);
    assert.deepEqual(result.errors, [], `${file} must be schema-valid`);
    assert.equal(cycle.accepted, false, `${file}.accepted must be false — a cycle is evidence and proposal only`);
    const reportFile = file.replace(/\.json$/, '.report.md');
    assert.ok(entries.includes(reportFile), `${file} must carry a persisted report ${reportFile}`);
  }
});
