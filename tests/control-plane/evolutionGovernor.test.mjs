import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  TERMINAL_DISPOSITIONS,
  discoverCanonicalEvolutionCycles,
  discoverPersistedGovernorResults,
  normalizeCycleTelemetry,
  prepareGovernorEvidence,
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
    schema_version: '1.1',
    result_id: 'GOV-SYNTHETIC-1',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: {
      executor: 'local_codex_windows',
      model_label: 'synthetic-test-fixture',
      prompt_id: 'premvp.prompt.automation_roadmap_governor.v1',
    },
    generated_at: '2026-08-07T10:00:00Z',
    terminal_disposition: 'ONE_AUTOMATION_INVESTMENT',
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
    schema_version: '1.1',
    result_id: 'GOV-SYNTHETIC-2',
    repository: 'POLYPROPICKS/PREMVP',
    generated_by: {
      executor: 'local_codex_windows',
      model_label: 'synthetic-test-fixture',
      prompt_id: 'premvp.prompt.automation_roadmap_governor.v1',
    },
    generated_at: '2026-08-07T10:00:00Z',
    terminal_disposition: 'EVIDENCE_INSUFFICIENT',
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
// Canonical persisted history and telemetry preparation
// ---------------------------------------------------------------------------------------

test('the Governor discovers and validates canonical persisted Cycle history without cardinality assumptions', () => {
  const cyclesDir = path.join(REPO_ROOT, EVOLUTION_DIR, 'cycles');
  const discovered = discoverCanonicalEvolutionCycles(cyclesDir);
  assert.equal(discovered.ok, true, discovered.errors.join('\n'));
  for (const cycle of discovered.cycles) {
    assert.ok(discovered.files.includes(`${cycle.cycle_id}.json`));
  }
});

test('canonical discovery fails closed when any consumed Cycle fails the existing Evolution validator', () => {
  const cyclesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-invalid-cycle-'));
  try {
    fs.writeFileSync(path.join(cyclesDir, 'invalid.json'), JSON.stringify({
      schema_version: '1.0',
      cycle_id: 'invalid',
      repository: 'POLYPROPICKS/PREMVP',
      accepted: false,
    }));
    const discovered = discoverCanonicalEvolutionCycles(cyclesDir);
    assert.equal(discovered.ok, false);
    assert.ok(discovered.errors.some((error) => error.includes('invalid.json')));
    assert.ok(discovered.errors.some((error) => error.includes('period_start')));
  } finally {
    fs.rmSync(cyclesDir, { recursive: true, force: true });
  }
});

test('v1.0 telemetry keeps measured values and exposes absent v1.1 evidence as UNKNOWN', () => {
  const cycle = JSON.parse(fs.readFileSync(path.join(
    REPO_ROOT,
    EVOLUTION_DIR,
    'cycles/2026-08-25__evolution-canonical-cycle.json',
  ), 'utf8'));
  const telemetry = normalizeCycleTelemetry(cycle);
  assert.equal(telemetry.founder_actions_proven, 3);
  assert.equal(telemetry.architect_corrections, 0);
  assert.equal(telemetry.runtime_evidence_count, 1);
  assert.equal(telemetry.executor_runs, 'UNKNOWN');
  assert.equal(telemetry.recovery_iterations, 'UNKNOWN');
  assert.equal(telemetry.defect_occurrences, 'UNKNOWN');
  assert.equal(telemetry.proven_effective_fixes, 'UNKNOWN');
});

test('v1.1 telemetry exposes Founder actions, recovery, defect origin/recurrence, latent layers and fix/effect evidence', () => {
  const defect = {
    defect_id: 'D1',
    origin: 'ORCHESTRATION_OR_RECOVERY_DEFECT',
    recurrence: 'LATENT_NEXT_LAYER_EXPOSED',
    defect_chain_id: 'CHAIN-1',
    implemented_fix_ref: 'commit abc1234',
    proven_effective_evidence_refs: ['test:post-fix-pass'],
  };
  const telemetry = normalizeCycleTelemetry({
    schema_version: '1.1',
    operating_telemetry: {
      capture_coverage: 'COMPLETE',
      chat_interaction_coverage: 'PARTIAL',
      founder_actions_proven: 2,
      founder_actions_removable: 1,
      executor_runs: 4,
      successful_terminal_results: 1,
      reruns_resumes: 2,
      recovery_iterations: 3,
      architect_corrections: 1,
      reviewer_corrections_rejections: 1,
      orchestration_waste_iterations: 1,
      defect_occurrences: [defect],
      defect_counts_by_origin: { ORCHESTRATION_OR_RECOVERY_DEFECT: 1 },
      defect_counts_by_recurrence: { LATENT_NEXT_LAYER_EXPOSED: 1 },
      repeated_defect_families: 0,
      active_onion_chains: 1,
      implemented_fixes: 1,
      proven_effective_fixes: 1,
      runtime_evidence_count: 1,
      reusable_artifacts_created: 1,
      actions_per_verified_result: 2,
      time_to_verified_result: 30,
    },
  });
  assert.equal(telemetry.founder_actions_removable, 1);
  assert.equal(telemetry.executor_runs, 4);
  assert.equal(telemetry.recovery_iterations, 3);
  assert.deepEqual(telemetry.defect_occurrences, [defect]);
  assert.equal(telemetry.defect_counts_by_recurrence.LATENT_NEXT_LAYER_EXPOSED, 1);
  assert.equal(telemetry.proven_effective_fixes, 1);
});

test('canonical history preparation derives its evidence from every unconsumed persisted Cycle', () => {
  const cyclesDir = path.join(REPO_ROOT, EVOLUTION_DIR, 'cycles');
  const discovered = discoverCanonicalEvolutionCycles(cyclesDir);
  assert.equal(discovered.ok, true, discovered.errors.join('\n'));
  const canonicalCycleIds = discovered.cycles.map((cycle) => cycle.cycle_id);
  const prepared = prepareGovernorEvidence({ cycles: discovered.cycles, priorGovernorResults: [] });
  assert.equal(prepared.history.canonical_cycle_count, canonicalCycleIds.length);
  assert.equal(prepared.eligibility.new_validated_cycle_count, canonicalCycleIds.length);
  assert.deepEqual(prepared.eligibility.based_on_cycles, canonicalCycleIds);
  assert.deepEqual(prepared.cycle_evidence.map((cycle) => cycle.cycle_id), canonicalCycleIds);
});

test('weekly eligibility is derived from persisted Governor history and Cycle periods', () => {
  const cycles = [
    { cycle_id: 'C1', period_start: '2026-08-01T00:00:00Z', period_end: '2026-08-02T00:00:00Z', schema_version: '1.0', operator_actions: {}, supporting_metrics: { values: {} } },
    { cycle_id: 'C2', period_start: '2026-08-09T00:00:00Z', period_end: '2026-08-10T00:00:00Z', schema_version: '1.0', operator_actions: {}, supporting_metrics: { values: {} } },
  ];
  const priorGovernorResults = [{
    result_id: 'G1',
    generated_at: '2026-08-02T00:00:00Z',
    eligibility: { based_on_cycles: ['C1'] },
  }];
  const prepared = prepareGovernorEvidence({ cycles, priorGovernorResults });
  assert.equal(prepared.eligibility.weekly_boundary_reached, true);
  assert.equal(prepared.eligibility.eligible, true);
  assert.deepEqual(prepared.eligibility.based_on_cycles, ['C2']);
});

test('the CLI preparation path is directly runnable from canonical persisted Cycles', () => {
  const run = spawnSync(process.execPath, ['scripts/control-plane/evolution-govern.mjs', '--prepare', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const prepared = JSON.parse(run.stdout);
  const cycles = discoverCanonicalEvolutionCycles(path.join(REPO_ROOT, EVOLUTION_DIR, 'cycles'));
  const priorResults = discoverPersistedGovernorResults(path.join(REPO_ROOT, EVOLUTION_DIR, 'roadmap-proposals'));
  assert.equal(cycles.ok, true, cycles.errors.join('\n'));
  assert.equal(priorResults.ok, true, priorResults.errors.join('\n'));
  const consumedCycleIds = new Set(priorResults.results.flatMap((result) => result.eligibility.based_on_cycles));
  const unconsumedCycleIds = cycles.cycles
    .filter((cycle) => !consumedCycleIds.has(cycle.cycle_id))
    .map((cycle) => cycle.cycle_id);
  assert.equal(prepared.command_id, 'premvp.command.evolution_govern.v1');
  assert.equal(prepared.history.canonical_cycle_count, cycles.cycles.length);
  assert.equal(prepared.history.prior_governor_result_count, priorResults.results.length);
  assert.equal(prepared.eligibility.new_validated_cycle_count, unconsumedCycleIds.length);
  assert.deepEqual(prepared.eligibility.based_on_cycles, unconsumedCycleIds);
  assert.deepEqual(prepared.cycle_evidence.map((cycle) => cycle.cycle_id), unconsumedCycleIds);
  assert.equal(prepared.terminal_disposition, prepared.eligibility.eligible ? null : 'EVIDENCE_INSUFFICIENT');
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

test('the Governor contract exposes exactly the three terminal dispositions', () => {
  assert.deepEqual(TERMINAL_DISPOSITIONS, [
    'ONE_AUTOMATION_INVESTMENT',
    'NO_AUTOMATION_NOW',
    'EVIDENCE_INSUFFICIENT',
  ]);
});

test('insufficient eligibility requires the EVIDENCE_INSUFFICIENT terminal disposition', () => {
  const { ok, errors } = validateGovernorResult(ineligibleResultFixture({ terminal_disposition: 'NO_AUTOMATION_NOW' }));
  assert.equal(ok, false);
  assert.ok(errors.some((error) => error.includes('EVIDENCE_INSUFFICIENT')));
});

test('EVIDENCE_INSUFFICIENT cannot promote an automation without sufficient history', () => {
  const result = ineligibleResultFixture();
  result.findings.automation_decisions = [{
    subject: 'Unsupported investment', decision: 'PROMOTE', reason: 'synthetic', evidence_refs: [SYNTHETIC_CYCLES[0]],
  }];
  result.findings.roadmap_delta_justified = true;
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((error) => error.includes('zero PROMOTE')));
  assert.ok(errors.some((error) => error.includes('roadmap_delta_justified false')));
});

test('ONE_AUTOMATION_INVESTMENT requires exactly one promoted automation and an unaccepted delta', () => {
  const result = eligibleResultFixture();
  result.findings.automation_decisions.push({
    subject: 'Second investment', decision: 'PROMOTE', reason: 'synthetic', evidence_refs: [...SYNTHETIC_CYCLES],
  });
  const { ok, errors } = validateGovernorResult(result);
  assert.equal(ok, false);
  assert.ok(errors.some((error) => error.includes('exactly one PROMOTE')));
});

test('NO_AUTOMATION_NOW is an eligible no-investment result with no delta', () => {
  const result = eligibleResultFixture({ terminal_disposition: 'NO_AUTOMATION_NOW', roadmap_delta: null });
  result.findings.automation_decisions = result.findings.automation_decisions.map((decision) => ({ ...decision, decision: 'DEFER' }));
  result.findings.roadmap_delta_justified = false;
  const { ok, errors } = validateGovernorResult(result);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('canonical preparation rejects a result that supplies non-canonical Cycle ids or eligibility', () => {
  const cyclesDir = path.join(REPO_ROOT, EVOLUTION_DIR, 'cycles');
  const discovered = discoverCanonicalEvolutionCycles(cyclesDir);
  const preparedEvidence = prepareGovernorEvidence({ cycles: discovered.cycles, priorGovernorResults: [] });
  const result = ineligibleResultFixture({
    eligibility: {
      eligible: false,
      reason: 'manually reconstructed',
      based_on_cycles: ['fabricated-cycle'],
      new_validated_cycle_count: 1,
      weekly_boundary_reached: false,
    },
  });
  const evaluated = evaluateGovernorResult(result, { preparedEvidence });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((error) => error.includes('canonical persisted history')));
});

test('a proposed investment must cite the same canonical Cycle ids as prepared eligibility', () => {
  const result = eligibleResultFixture();
  const preparedEvidence = {
    eligibility: result.eligibility,
    terminal_disposition: null,
  };
  result.roadmap_delta.based_on_cycles = ['fabricated-cycle'];
  const { ok, errors } = validateGovernorResult(result, { preparedEvidence });
  assert.equal(ok, false);
  assert.ok(errors.some((error) => error.includes('roadmap_delta.based_on_cycles')));
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

test('persisted Governor result discovery accepts growing valid history and rejects malformed or duplicate results', () => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-result-history-'));
  try {
    assert.deepEqual(discoverPersistedGovernorResults(resultsDir), {
      ok: true,
      results: [],
      files: [],
      errors: [],
    });

    const first = ineligibleResultFixture();
    fs.writeFileSync(path.join(resultsDir, `${first.result_id}.json`), JSON.stringify(first));
    let discovered = discoverPersistedGovernorResults(resultsDir);
    assert.equal(discovered.ok, true, discovered.errors.join('\n'));
    assert.deepEqual(discovered.results.map((result) => result.result_id), [first.result_id]);

    const second = eligibleResultFixture();
    fs.writeFileSync(path.join(resultsDir, `${second.result_id}.json`), JSON.stringify(second));
    discovered = discoverPersistedGovernorResults(resultsDir);
    assert.equal(discovered.ok, true, discovered.errors.join('\n'));
    assert.deepEqual(discovered.results.map((result) => result.result_id), [second.result_id, first.result_id]);

    fs.writeFileSync(path.join(resultsDir, 'duplicate-id.json'), JSON.stringify({ ...first, result_id: second.result_id }));
    discovered = discoverPersistedGovernorResults(resultsDir);
    assert.equal(discovered.ok, false);
    assert.ok(discovered.errors.some((error) => error.includes(`duplicate Governor result_id ${second.result_id}`)));

    fs.rmSync(path.join(resultsDir, 'duplicate-id.json'));
    fs.writeFileSync(path.join(resultsDir, 'malformed.json'), '{');
    discovered = discoverPersistedGovernorResults(resultsDir);
    assert.equal(discovered.ok, false);
    assert.ok(discovered.errors.some((error) => error.includes('malformed.json: invalid JSON')));
  } finally {
    fs.rmSync(resultsDir, { recursive: true, force: true });
  }
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
