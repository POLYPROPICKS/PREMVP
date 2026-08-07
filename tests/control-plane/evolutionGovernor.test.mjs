import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeEligibility,
  validateRoadmapDelta,
  validateRoadmapFactualUpdates,
  validateGovernorResult,
  renderGovernorFounderReport,
  validateGovernorReport,
  GOVERNOR_REPORT_HEADINGS,
  ELIGIBILITY_MIN_NEW_CYCLES,
} from '../../scripts/control-plane/lib/evolution-governor.mjs';

import { evaluateGovernorResult } from '../../scripts/control-plane/evolution-govern.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVOLUTION_DIR = 'docs/ai-context/control-plane/evolution';

// ---------------------------------------------------------------------------------------
// Synthetic deterministic fixtures. These are tests, not a dry run and not a real Governor
// run: no fixture is ever written into roadmap-proposals/.
// ---------------------------------------------------------------------------------------

const SYNTHETIC_CYCLES = Object.freeze([
  '2026-08-01__synthetic-a',
  '2026-08-02__synthetic-b',
  '2026-08-03__synthetic-c',
]);

function claim(statement, evidenceClass = 'PROVEN_IN_RUNTIME') {
  return { statement, evidence_class: evidenceClass, evidence_refs: ['PR#109'] };
}

function deltaFixture(overrides = {}) {
  return {
    roadmap_delta_id: 'RMD-SYNTHETIC-1',
    based_on_cycles: [...SYNTHETIC_CYCLES],
    current_stage: 'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE',
    proposed_change: 'Собирать операторские действия автоматически из транскрипта вместо ручного лога',
    preserves: ['Приоритет Оси A над Осью B', 'Продуктовая фаза и гейты по PnL не меняются'],
    supersedes: ['Ручной подсчёт операторских действий'],
    retires: [],
    business_effect: 'Косвенный: точнее видно, где Founder тратит время, но напрямую выручку не двигает',
    manifest_2_effect: 'Усиливает переносимость сбора данных между CloudCode и Codex',
    evidence: [claim('Три цикла подряд показали расхождение ручного и автоматического подсчёта')],
    opportunity_cost: 'Один цикл разработки, который иначе пошёл бы на Ось A',
    drift_from_original_roadmap: 'Небольшое: расширяет уже одобренный Stage 2 объём, не выходит за него',
    drift_justified: true,
    success_metric: 'Три цикла подряд с совпадающим автоматическим и контрольным подсчётом',
    rollback_condition: 'Автоматический подсчёт расходится с контрольным более чем на 10 процентов',
    accepted: false,
    ...overrides,
  };
}

function eligibleResultFixture(overrides = {}) {
  return {
    schema_version: '1.0',
    result_id: 'GOV-SYNTHETIC-1',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: {
      executor: 'local_codex_windows',
      model_label: 'synthetic-test-fixture',
      prompt_id: 'premvp.prompt.automation_roadmap_governor.v1',
    },
    generated_at: '2026-08-07T10:00:00Z',
    eligibility: {
      eligible: true,
      reason: `${SYNTHETIC_CYCLES.length} new validated cycle(s) meets the minimum of ${ELIGIBILITY_MIN_NEW_CYCLES}`,
      based_on_cycles: [...SYNTHETIC_CYCLES],
      new_validated_cycle_count: SYNTHETIC_CYCLES.length,
      weekly_boundary_reached: false,
    },
    findings: {
      axis_b_advancement: { statement: 'Сбор операторских действий стал воспроизводимым между тремя циклами', verdict: 'CAPABILITY_STRENGTHENED', evidence_refs: ['PR#109'] },
      axis_a_support_or_distraction: { statement: 'Разбор не заменял работу над резервированием и очередью, шёл параллельно', verdict: 'NEUTRAL', evidence_refs: [SYNTHETIC_CYCLES[0]] },
      repeated_problems: [
        { problem: 'Ручной подсчёт операторских действий расходился между источниками', repetition_count: 3, cycle_refs: [...SYNTHETIC_CYCLES] },
      ],
      experiments_with_evidence: [
        { experiment_id: 'E1', outcome: 'PROMOTION_CONDITION_MET', evidence_refs: [SYNTHETIC_CYCLES[2]] },
      ],
      founder_skills_practiced: [
        { ladder_id: 'VERIFICATION_DISCIPLINE', repetition_count: 3, cycle_refs: [...SYNTHETIC_CYCLES] },
      ],
      automation_decisions: [
        { subject: 'Автоматический сбор операторских действий', decision: 'PROMOTE', reason: 'Три цикла подряд показали воспроизводимую пользу без риска для Оси A', evidence_refs: [...SYNTHETIC_CYCLES] },
      ],
      roadmap_on_course: { statement: 'Stage 2 объём соответствует тому, что показали циклы', on_course: true },
      roadmap_delta_justified: true,
    },
    roadmap_delta: deltaFixture(),
    roadmap_factual_updates: {
      role: 'FACTUAL_ONLY',
      last_evaluated_at: '2026-08-07T10:00:00Z',
      cycle_count: SYNTHETIC_CYCLES.length,
      repetition_counts: { operator_action_mismatch: 3 },
    },
    founder_report_ref: null,
    next_step: 'Собрать ещё один реальный период и проверить, держится ли автоматический подсчёт.',
    accepted: false,
    ...overrides,
  };
}

function ineligibleResultFixture(overrides = {}) {
  return {
    schema_version: '1.0',
    result_id: 'GOV-SYNTHETIC-2',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: {
      executor: 'local_codex_windows',
      model_label: 'synthetic-test-fixture',
      prompt_id: 'premvp.prompt.automation_roadmap_governor.v1',
    },
    generated_at: '2026-08-07T10:00:00Z',
    eligibility: {
      eligible: false,
      reason: 'only 1 new validated cycle(s) (minimum 3) and the weekly boundary has not been reached — insufficient evidence for a Governor run',
      based_on_cycles: [SYNTHETIC_CYCLES[0]],
      new_validated_cycle_count: 1,
      weekly_boundary_reached: false,
    },
    findings: {
      axis_b_advancement: { statement: 'Недостаточно циклов для вывода', verdict: 'NO_MEASURABLE_CHANGE', evidence_refs: [] },
      axis_a_support_or_distraction: { statement: 'Недостаточно циклов для вывода', verdict: 'NOT_ENOUGH_EVIDENCE', evidence_refs: [] },
      repeated_problems: [],
      experiments_with_evidence: [],
      founder_skills_practiced: [],
      automation_decisions: [],
      roadmap_on_course: { statement: 'Недостаточно циклов, чтобы судить', on_course: true },
      roadmap_delta_justified: false,
    },
    roadmap_delta: null,
    roadmap_factual_updates: { role: 'FACTUAL_ONLY', cycle_count: 1 },
    founder_report_ref: null,
    next_step: 'Дождаться ещё двух проверенных циклов или недельной границы.',
    accepted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------------------

test('eligibility is met with three or more new validated cycles', () => {
  const result = computeEligibility({ newValidatedCycleCount: 3, weeklyBoundaryReached: false });
  assert.equal(result.eligible, true);
  assert.match(result.reason, /3 new validated cycle/);
});

test('eligibility is met on the weekly boundary even with fewer than three cycles', () => {
  const result = computeEligibility({ newValidatedCycleCount: 1, weeklyBoundaryReached: true });
  assert.equal(result.eligible, true);
  assert.match(result.reason, /weekly boundary/);
});

test('eligibility is refused with fewer than three cycles and no weekly boundary', () => {
  const result = computeEligibility({ newValidatedCycleCount: 2, weeklyBoundaryReached: false });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /insufficient evidence/);
});

test('eligibility never invents evidence for a missing input', () => {
  const result = computeEligibility({});
  assert.equal(result.eligible, false);
});

// ---------------------------------------------------------------------------------------
// Roadmap delta contract
// ---------------------------------------------------------------------------------------

test('a well-formed roadmap delta passes every Stage 2 contract', () => {
  const result = validateRoadmapDelta(deltaFixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a roadmap delta can never accept itself', () => {
  const { ok, errors } = validateRoadmapDelta(deltaFixture({ accepted: true }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('must never accept its own roadmap delta')));
});

test('a roadmap delta may never carry a strategic authority field', () => {
  for (const key of ['pnl_priority', 'product_roadmap_phase', 'live_money_gates', 'risk_authority', 'accepted_capability_level', 'promotion_rules']) {
    const delta = deltaFixture({ [key]: 'anything' });
    const { ok, errors } = validateRoadmapDelta(delta);
    assert.equal(ok, false, `expected ${key} to be rejected`);
    assert.ok(errors.some((e) => e.includes('strategic field')), `expected a strategic-field error for ${key}`);
  }
});

test('an invented roadmap stage is rejected — there are exactly three approved levels', () => {
  const { ok, errors } = validateRoadmapDelta(deltaFixture({ current_stage: 'STAGE_4_SOMETHING_NEW' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('current_stage')));
});

test('a delta that reorders Axis A below Axis B is rejected outright', () => {
  const delta = deltaFixture({ business_effect: 'Ось B становится важнее и axis a должна быть below axis b с этого момента' });
  const { ok, errors } = validateRoadmapDelta(delta);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('reorders Axis A priority')));
});

test('a delta without evidence is rejected — preserves must name at least the Axis A invariant', () => {
  const noEvidence = validateRoadmapDelta(deltaFixture({ evidence: [] }));
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.errors.some((e) => e.includes('evidence')));

  const noPreserves = validateRoadmapDelta(deltaFixture({ preserves: [] }));
  assert.equal(noPreserves.ok, false);
  assert.ok(noPreserves.errors.some((e) => e.includes('preserves')));
});

test('a delta with no based_on_cycles is rejected — a delta is never derived from nothing', () => {
  const { ok, errors } = validateRoadmapDelta(deltaFixture({ based_on_cycles: [] }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('based_on_cycles')));
});

// ---------------------------------------------------------------------------------------
// Factual vs strategic separation
// ---------------------------------------------------------------------------------------

test('factual auto-updates accept the allowed diagnostic fields', () => {
  const { ok, errors } = validateRoadmapFactualUpdates({
    role: 'FACTUAL_ONLY',
    last_evaluated_at: '2026-08-07T10:00:00Z',
    cycle_count: 3,
    evidence_counters: { proven_in_runtime: 4 },
    hypothesis_status: { H1: 'NOW' },
    experiment_status: { E1: 'PROMOTION_CONDITION_MET' },
    measured_supporting_metrics: { reusable_artifacts_created: 3 },
    repetition_counts: { operator_action_mismatch: 3 },
    capability_evidence_observations: { REUSABLE_FUNCTIONS_SCRIPTS_VALIDATORS: 2 },
  });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('factual auto-updates reject every strategic field, one at a time', () => {
  for (const key of ['pnl_priority', 'product_roadmap_phase', 'live_money_gates', 'risk_authority', 'strategic_stage_order', 'accepted_capability_level', 'promotion_rules']) {
    const { ok, errors } = validateRoadmapFactualUpdates({ role: 'FACTUAL_ONLY', [key]: 'anything' });
    assert.equal(ok, false, `expected ${key} to be rejected`);
    assert.ok(errors.some((e) => e.includes('strategic field')));
  }
});

test('factual auto-updates reject an unrecognized key even when it is not obviously strategic', () => {
  const { ok, errors } = validateRoadmapFactualUpdates({ role: 'FACTUAL_ONLY', made_up_field: 1 });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('not a recognized factual field')));
});

// ---------------------------------------------------------------------------------------
// Governor result contract
// ---------------------------------------------------------------------------------------

test('a well-formed eligible Governor result with a justified delta passes', () => {
  const { ok, errors } = validateGovernorResult(eligibleResultFixture());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('a well-formed ineligible Governor result with no delta passes — a stated no-change outcome is correct, not a failure', () => {
  const { ok, errors } = validateGovernorResult(ineligibleResultFixture());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('a Governor result can never accept itself', () => {
  const { ok, errors } = validateGovernorResult(eligibleResultFixture({ accepted: true }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('evidence and proposal only')));
});

test('insufficient evidence never produces a fabricated roadmap delta', () => {
  const contradictory = ineligibleResultFixture({ roadmap_delta: deltaFixture() });
  const { ok, errors } = validateGovernorResult(contradictory);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('roadmap_delta must be null when eligibility.eligible is false')));
});

test('a roadmap_delta_justified true result with a null delta is rejected — a justified delta must actually be produced', () => {
  const withheld = eligibleResultFixture({ roadmap_delta: null });
  const { ok, errors } = validateGovernorResult(withheld);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('a justified delta must be produced')));
});

test('eligible=true is rejected when neither the cycle-count nor weekly-boundary condition actually holds', () => {
  const contradictory = eligibleResultFixture({
    eligibility: {
      eligible: true,
      reason: 'claimed without meeting either condition',
      based_on_cycles: [SYNTHETIC_CYCLES[0]],
      new_validated_cycle_count: 1,
      weekly_boundary_reached: false,
    },
  });
  const { ok, errors } = validateGovernorResult(contradictory);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('neither the minimum cycle count nor the weekly boundary')));
});

test('eligible=false is rejected when the cycle count already meets the minimum', () => {
  const contradictory = eligibleResultFixture({
    eligibility: {
      eligible: false,
      reason: 'claimed ineligible despite meeting the threshold',
      based_on_cycles: [...SYNTHETIC_CYCLES],
      new_validated_cycle_count: 3,
      weekly_boundary_reached: false,
    },
  });
  const { ok, errors } = validateGovernorResult(contradictory);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('this contradicts the eligibility rule')));
});

test('a repeated problem naming only one cycle is not a repetition', () => {
  const result = eligibleResultFixture();
  result.findings.repeated_problems = [{ problem: 'Одноразовая проблема', repetition_count: 1, cycle_refs: [SYNTHETIC_CYCLES[0]] }];
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('not a repetition')));
});

test('a Founder skill must reference a real capability ladder id — the Governor never invents one', () => {
  const result = eligibleResultFixture();
  result.findings.founder_skills_practiced = [{ ladder_id: 'MADE_UP_LEVEL', repetition_count: 2, cycle_refs: [...SYNTHETIC_CYCLES] }];
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('ladder_id')));
});

test('a Governor result carrying a strategic field at the top level is rejected', () => {
  const result = eligibleResultFixture({ risk_authority: 'anything' });
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('risk_authority') && e.includes('strategic field')));
});

test('a Governor result from another repository boundary is rejected', () => {
  const { ok, errors } = validateGovernorResult(eligibleResultFixture({ repository: 'SOMEONE/ELSE' }));
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('repository boundary')));
});

test('an embedded roadmap delta is still validated against the full delta contract', () => {
  const result = eligibleResultFixture();
  result.roadmap_delta = deltaFixture({ accepted: true });
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('roadmap_delta.accepted must be false')));
});

// ---------------------------------------------------------------------------------------
// Founder report contract
// ---------------------------------------------------------------------------------------

test('the rendered eligible-path report satisfies the heading and style contract', () => {
  const report = renderGovernorFounderReport(eligibleResultFixture());
  const result = validateGovernorReport(report);
  assert.deepEqual(result.errors, []);

  const headings = report.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());
  assert.deepEqual(headings, [...GOVERNOR_REPORT_HEADINGS]);
});

test('the rendered no-change report also satisfies the heading and style contract', () => {
  const report = renderGovernorFounderReport(ineligibleResultFixture());
  const result = validateGovernorReport(report);
  assert.deepEqual(result.errors, []);
  assert.ok(report.includes('Доказательств пока недостаточно'));
  assert.ok(report.includes('Изменений не предлагается'));
});

test('the Founder report carries no schema dumps and no code fences', () => {
  const report = renderGovernorFounderReport(eligibleResultFixture());
  assert.ok(!report.includes('```'));
  assert.ok(!report.includes('schema_version'));
  assert.ok(!report.includes('evidence_class'));
  assert.ok(!report.includes('"'));
});

test('a report with reordered or missing headings is rejected', () => {
  const report = renderGovernorFounderReport(eligibleResultFixture());
  const reordered = report.replace('## Что улучшилось', '## Улучшения');
  assert.equal(validateGovernorReport(reordered).ok, false);

  const truncated = report.split('## Следующий разумный шаг')[0];
  assert.equal(validateGovernorReport(truncated).ok, false);
});

test('a report with an empty section is rejected', () => {
  const report = renderGovernorFounderReport(eligibleResultFixture())
    .replace(/## Следующий разумный шаг\n[\s\S]*$/, '## Следующий разумный шаг\n');
  assert.equal(validateGovernorReport(report).ok, false);
});

test('a report that leaks raw machine structure is rejected', () => {
  const report = `${renderGovernorFounderReport(eligibleResultFixture())}\n\nschema_version: 1.0\n`;
  const { ok, errors } = validateGovernorReport(report);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('schema dumps')));
});

test('rendering is deterministic — the same result produces a byte-identical report', () => {
  assert.equal(renderGovernorFounderReport(eligibleResultFixture()), renderGovernorFounderReport(eligibleResultFixture()));
  assert.equal(renderGovernorFounderReport(ineligibleResultFixture()), renderGovernorFounderReport(ineligibleResultFixture()));
});

// ---------------------------------------------------------------------------------------
// End-to-end evaluation
// ---------------------------------------------------------------------------------------

test('evaluation renders a report only for an admissible Governor result', () => {
  const good = evaluateGovernorResult(eligibleResultFixture());
  assert.equal(good.ok, true);
  assert.ok(good.report.startsWith('# Automation Roadmap Review'));

  const bad = evaluateGovernorResult(eligibleResultFixture({ accepted: true }));
  assert.equal(bad.ok, false);
  assert.equal(bad.report, null);
});

test('evaluation is admissible for the ineligible no-change path too', () => {
  const result = evaluateGovernorResult(ineligibleResultFixture());
  assert.equal(result.ok, true);
  assert.ok(result.report.includes('## Главный вывод'));
});

// ---------------------------------------------------------------------------------------
// Cross-artifact presence
// ---------------------------------------------------------------------------------------

test('every Stage 2 Governor artifact another session needs is present and machine-readable', () => {
  const schemaFiles = ['GOVERNOR_RESULT.schema.json', 'ROADMAP_DELTA.schema.json'];
  for (const rel of schemaFiles) {
    const full = path.join(REPO_ROOT, EVOLUTION_DIR, 'schemas', rel);
    assert.ok(fs.existsSync(full), `missing schema ${rel}`);
    JSON.parse(fs.readFileSync(full, 'utf8'));
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'prompts/AUTOMATION_ROADMAP_GOVERNOR.md')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'roadmap-proposals/README.md')));
});

test('Stage 2 ships no historical Governor result — roadmap-proposals/ holds only its placeholder', () => {
  const entries = fs.readdirSync(path.join(REPO_ROOT, EVOLUTION_DIR, 'roadmap-proposals'));
  assert.deepEqual(entries.filter((f) => f.endsWith('.json')), []);
});

test('a schedule manifest exists, parses, and does not invent a registered scheduler', () => {
  const full = path.join(REPO_ROOT, EVOLUTION_DIR, 'SCHEDULE_MANIFEST.yaml');
  assert.ok(fs.existsSync(full));
  const manifest = JSON.parse(fs.readFileSync(full, 'utf8'));
  assert.equal(manifest.registered_routine_mechanism.status, 'NOT_FOUND_IN_CONTROL_PLANE');
  assert.deepEqual(manifest.routines.map((r) => r.routine_id), [
    'premvp.routine.daily_evolution_review.v1',
    'premvp.routine.automation_roadmap_governor.v1',
  ]);
  assert.equal(manifest.founder_ui_action_required.blocks_implementation, false);
});
