/**
 * evolution-cycle.mjs
 *
 * Deterministic, dependency-free contracts for the PolyProPicks Daily Evolution Review.
 *
 * Contract source: docs/ai-context/control-plane/evolution/EVOLUTION_POLICY.yaml
 * Schemas:         docs/ai-context/control-plane/evolution/schemas/
 *
 * Three things are enforced here that nothing else in the control plane enforces:
 *   1. Axis A (launch/revenue/PnL) and Axis B (Manifest 2 capability) stay separate.
 *   2. Supporting metrics stay diagnostic — they can never carry a verdict.
 *   3. A reconciled-PnL claim without fills, fees and settlement evidence is rejected,
 *      not downgraded.
 *
 * Like the rest of scripts/control-plane, this is a focused validator rather than a generic
 * JSON Schema engine: the messages have to be readable by a Founder on a phone.
 */

import {
  validateOperatorActionSummary,
} from './operator-actions.mjs';

export const CYCLE_SCHEMA_VERSION = '1.0';

export const AXIS_A_VERDICTS = Object.freeze([
  'ADVANCED', 'NO_MEASURABLE_CHANGE', 'STALLED', 'REGRESSED', 'NOT_ENOUGH_EVIDENCE',
]);

export const AXIS_B_VERDICTS = Object.freeze([
  'CAPABILITY_ADDED', 'CAPABILITY_STRENGTHENED', 'PRACTICED_NOT_YET_PROVEN',
  'NO_MEASURABLE_CHANGE', 'REGRESSED',
]);

export const AXIS_B_DOMAINS = Object.freeze([
  'MISSION_CONTRACTS', 'VERIFICATION_AND_EVIDENCE', 'MISSION_REGISTRY',
  'DECLARATIVE_ENVIRONMENTS', 'PERMISSION_AND_TOOL_POLICY',
  'REUSABLE_FUNCTIONS_SCRIPTS_VALIDATORS', 'PORTABILITY_ACROSS_CLOUDCODE_AND_CODEX',
  'RECOVERY_AND_CHECKPOINTS', 'AUTOMATION_ECONOMICS', 'CONTROLLED_IMPROVEMENT',
]);

export const HYPOTHESIS_CLASSIFICATIONS = Object.freeze([
  'NOW', 'PRODUCT_FIRST', 'SYSTEM_LATER', 'REJECT',
]);

export const EVIDENCE_CLASSES = Object.freeze([
  'PROVEN_IN_RUNTIME', 'FOUNDER_ACCEPTED_EXTERNAL_AUDIT',
  'FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT', 'SUPPORTED', 'NOT_PROVEN',
]);

export const EVOLUTION_STAGES = Object.freeze([
  'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP',
  'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE',
  'VISION_AGENT_OPERATING_SYSTEM',
]);

export const HYPOTHESIS_TARGET_MIN = 5;
export const HYPOTHESIS_TARGET_MAX = 8;

export const REQUIRED_PNL_EVIDENCE_KINDS = Object.freeze(['FILLS', 'FEES', 'SETTLEMENT']);

export const UNKNOWN_METRIC_VALUES = Object.freeze(['UNKNOWN', 'NOT_AVAILABLE']);

/** Exact Founder report headings, in order. Contract, not preference. */
export const FOUNDER_REPORT_HEADINGS = Object.freeze([
  '# Daily Evolution Review',
  '## Главный итог',
  '## Ось A — запуск, выручка и PnL',
  '## Ось B — Manifest 2',
  '## Что доказано',
  '## Что блокирует следующий шаг',
  '## Варианты автоматизации',
  '## Две практики Founder',
  '## Следующие эксперименты',
  '## Поддерживающие метрики',
  '## Roadmap',
  '## Что произойдёт дальше',
]);

/** Tokens that mean raw machine structure leaked into the Founder-facing report. */
const SCHEMA_DUMP_MARKERS = Object.freeze([
  'schema_version', 'evidence_class', 'evidence_refs', 'cycle_id', 'capture_coverage',
  '$schema', 'persisted_artifact', 'reconciled_claimed', '"',
]);

const HYPOTHESIS_REQUIRED_FIELDS = Object.freeze([
  'id', 'observed_problem', 'why_it_matters', 'axis_a_effect', 'axis_b_effect',
  'proposed_automation', 'persistent_artifact', 'expected_value', 'implementation_cost',
  'verification_cost', 'risk', 'success_metric', 'rollback_or_stop_condition', 'timing',
]);

const PRACTICE_REQUIRED_FIELDS = Object.freeze([
  'id', 'skill_practiced', 'why_it_matters_now', 'how_it_applies_to_current_project',
  'persistent_git_artifact',
]);

const EXPERIMENT_REQUIRED_FIELDS = Object.freeze([
  'id', 'hypothesis', 'bounded_scope', 'persistent_artifact', 'promotion_condition',
  'stop_condition',
]);

const CORRECTION_REQUIRED_FIELDS = Object.freeze([
  'correction_id', 'recorded_at', 'source', 'subject', 'what_was_wrong', 'what_is_correct',
  'why_it_matters', 'applies_to', 'evidence_refs',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyStringArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/** A claim is material — it therefore needs at least one evidence reference. */
function validateClaim(claim, label, push) {
  if (!isObject(claim)) return push(`${label} must be an object`);
  if (!isNonEmptyString(claim.statement)) push(`${label}.statement must be a non-empty string`);
  if (!EVIDENCE_CLASSES.includes(claim.evidence_class)) {
    push(`${label}.evidence_class must be one of ${EVIDENCE_CLASSES.join(', ')}`);
  }
  if (!nonEmptyStringArray(claim.evidence_refs)) {
    push(`${label}.evidence_refs must list at least one evidence reference — material claims are never accepted bare`);
  }
}

export function validateAutomationHypothesis(hypothesis, label = 'automation_hypotheses[?]') {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!isObject(hypothesis)) {
    return { ok: false, errors: [`${label} must be an object`] };
  }
  for (const field of HYPOTHESIS_REQUIRED_FIELDS) {
    if (!isNonEmptyString(hypothesis[field])) push(`${label}.${field} must be a non-empty string`);
  }
  if (!HYPOTHESIS_CLASSIFICATIONS.includes(hypothesis.classification)) {
    push(`${label}.classification must be one of ${HYPOTHESIS_CLASSIFICATIONS.join(', ')}`);
  }
  if (!nonEmptyStringArray(hypothesis.evidence_refs)) {
    push(`${label}.evidence_refs must list at least one evidence reference — a hypothesis without an observed problem is invention`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateFounderCorrection(correction, label = 'correction') {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!isObject(correction)) return { ok: false, errors: [`${label} must be an object`] };
  for (const field of CORRECTION_REQUIRED_FIELDS) {
    if (field === 'applies_to' || field === 'evidence_refs') continue;
    if (!isNonEmptyString(correction[field])) push(`${label}.${field} must be a non-empty string`);
  }
  if (!['FOUNDER', 'ARCHITECT'].includes(correction.source)) {
    push(`${label}.source must be FOUNDER or ARCHITECT`);
  }
  if (!nonEmptyStringArray(correction.applies_to)) {
    push(`${label}.applies_to must name at least one artifact, otherwise the correction cannot be enforced later`);
  }
  if (!nonEmptyStringArray(correction.evidence_refs)) {
    push(`${label}.evidence_refs must list at least one evidence reference`);
  }
  if (correction.accepted !== false) {
    push(`${label}.accepted must be false — the writing executor never accepts its own correction`);
  }
  return { ok: errors.length === 0, errors };
}

function validateSupportingMetrics(metrics, push) {
  if (!isObject(metrics)) return push('supporting_metrics must be an object');
  if (metrics.role !== 'DIAGNOSTIC_ONLY') {
    push('supporting_metrics.role must be DIAGNOSTIC_ONLY — metrics never carry a verdict');
  }
  if (!isObject(metrics.values)) return push('supporting_metrics.values must be an object');

  for (const [key, value] of Object.entries(metrics.values)) {
    // A metric key that looks like a verdict is the exact failure mode the axis separation
    // rule exists to stop: a diagnostic quietly overriding an evidence-derived conclusion.
    if (/verdict|axis_a|axis_b/i.test(key)) {
      push(`supporting_metrics.values.${key} looks like an axis verdict — supporting metrics may never override Axis A or Axis B`);
    }
    const isNumber = typeof value === 'number' && Number.isFinite(value);
    const isUnknown = UNKNOWN_METRIC_VALUES.includes(value);
    if (!isNumber && !isUnknown) {
      push(`supporting_metrics.values.${key} must be a number or the literal string UNKNOWN/NOT_AVAILABLE — unavailable cost and usage data is never guessed`);
    }
  }
}

function validateAxisA(axis, push) {
  if (!isObject(axis)) return push('axis_a must be an object');
  if (!AXIS_A_VERDICTS.includes(axis.verdict)) {
    push(`axis_a.verdict must be one of ${AXIS_A_VERDICTS.join(', ')}`);
  }
  for (const field of ['what_moved', 'blockers_removed', 'blockers_introduced']) {
    if (!Array.isArray(axis[field])) {
      push(`axis_a.${field} must be an array`);
      continue;
    }
    axis[field].forEach((claim, i) => validateClaim(claim, `axis_a.${field}[${i}]`, push));
  }
  if (!Array.isArray(axis.not_proven)) push('axis_a.not_proven must be an array');
  if (typeof axis.runtime_or_business_evidence_exists !== 'boolean') {
    push('axis_a.runtime_or_business_evidence_exists must be a boolean');
  }
  if (axis.next_verified_production_fact_now_possible !== null &&
      !isNonEmptyString(axis.next_verified_production_fact_now_possible)) {
    push('axis_a.next_verified_production_fact_now_possible must be a non-empty string or null');
  }

  // ADVANCED without any evidence at all is the single most tempting false positive.
  if (axis.verdict === 'ADVANCED' && axis.runtime_or_business_evidence_exists !== true) {
    push('axis_a.verdict ADVANCED requires runtime_or_business_evidence_exists true');
  }

  const pnl = axis.pnl;
  if (!isObject(pnl)) return push('axis_a.pnl must be an object');
  if (typeof pnl.reconciled_claimed !== 'boolean') {
    push('axis_a.pnl.reconciled_claimed must be a boolean');
    return;
  }
  if (!Array.isArray(pnl.evidence_kinds)) {
    push('axis_a.pnl.evidence_kinds must be an array');
    return;
  }
  if (pnl.reconciled_claimed) {
    const missing = REQUIRED_PNL_EVIDENCE_KINDS.filter((k) => !pnl.evidence_kinds.includes(k));
    if (missing.length) {
      push(`UNSUPPORTED_PNL_CLAIM: axis_a.pnl claims reconciled PnL without ${missing.join(', ')} evidence — reconciled PnL is never inferred`);
    }
    if (!nonEmptyStringArray(pnl.evidence_refs)) {
      push('UNSUPPORTED_PNL_CLAIM: axis_a.pnl claims reconciled PnL without any evidence reference');
    }
  }
}

function validateAxisB(axis, push) {
  if (!isObject(axis)) return push('axis_b must be an object');
  if (!AXIS_B_VERDICTS.includes(axis.verdict)) {
    push(`axis_b.verdict must be one of ${AXIS_B_VERDICTS.join(', ')}`);
  }
  if (!Array.isArray(axis.capabilities)) {
    push('axis_b.capabilities must be an array');
  } else {
    axis.capabilities.forEach((cap, i) => {
      const label = `axis_b.capabilities[${i}]`;
      if (!isObject(cap)) return push(`${label} must be an object`);
      if (!AXIS_B_DOMAINS.includes(cap.domain)) {
        push(`${label}.domain must be one of ${AXIS_B_DOMAINS.join(', ')}`);
      }
      if (!isNonEmptyString(cap.statement)) push(`${label}.statement must be a non-empty string`);
      if (!isNonEmptyString(cap.persisted_artifact)) {
        push(`${label}.persisted_artifact must name a tracked repository path — a capability an LLM merely described is not proven`);
      }
      if (!isNonEmptyString(cap.use_or_validation_evidence)) {
        push(`${label}.use_or_validation_evidence must describe actual use or validation`);
      }
      if (!nonEmptyStringArray(cap.evidence_refs)) {
        push(`${label}.evidence_refs must list at least one evidence reference`);
      }
    });
  }
  if (!Array.isArray(axis.not_proven)) push('axis_b.not_proven must be an array');

  // Claiming a capability landed while listing none is a contradiction, not an edge case.
  if (['CAPABILITY_ADDED', 'CAPABILITY_STRENGTHENED'].includes(axis.verdict) &&
      Array.isArray(axis.capabilities) && axis.capabilities.length === 0) {
    push(`axis_b.verdict ${axis.verdict} requires at least one capability with a persisted artifact`);
  }
}

/** Full EVOLUTION_CYCLE validation. Returns every violation, not just the first. */
export function validateEvolutionCycle(cycle) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!isObject(cycle)) return { ok: false, errors: ['cycle must be an object'] };

  for (const field of ['schema_version', 'cycle_id', 'period_start', 'period_end', 'next_step']) {
    if (!isNonEmptyString(cycle[field])) push(`${field} must be a non-empty string`);
  }
  if (cycle.repository !== 'POLYPROPICKS/PREMVP') {
    push('repository must be POLYPROPICKS/PREMVP — Evolution never crosses the repository boundary');
  }
  if (cycle.accepted !== false) {
    push('accepted must be false — a cycle is evidence and proposal only');
  }

  if (!isObject(cycle.generated_by)) {
    push('generated_by must be an object');
  } else {
    if (!['claude_code_cloud', 'local_codex_windows'].includes(cycle.generated_by.executor)) {
      push('generated_by.executor must be claude_code_cloud or local_codex_windows');
    }
    for (const field of ['model_label', 'prompt_id']) {
      if (!isNonEmptyString(cycle.generated_by[field])) push(`generated_by.${field} must be a non-empty string`);
    }
  }

  if (!isObject(cycle.inputs)) {
    push('inputs must be an object');
  } else {
    if (!Array.isArray(cycle.inputs.completion_envelope_ids)) push('inputs.completion_envelope_ids must be an array');
    if (!Array.isArray(cycle.inputs.confirmed_changes)) push('inputs.confirmed_changes must be an array');
    if (!isNonEmptyString(cycle.inputs.input_bundle_ref)) push('inputs.input_bundle_ref must be a non-empty string');
  }

  validateAxisA(cycle.axis_a, push);
  validateAxisB(cycle.axis_b, push);
  validateSupportingMetrics(cycle.supporting_metrics, push);

  const summaryResult = validateOperatorActionSummary(cycle.operator_actions);
  if (!summaryResult.ok) errors.push(...summaryResult.errors);

  // --- Automation hypotheses -----------------------------------------------------------
  if (!Array.isArray(cycle.automation_hypotheses)) {
    push('automation_hypotheses must be an array');
  } else {
    const count = cycle.automation_hypotheses.length;
    if (count > HYPOTHESIS_TARGET_MAX) {
      push(`automation_hypotheses may contain at most ${HYPOTHESIS_TARGET_MAX} entries (found ${count})`);
    }
    if (count < HYPOTHESIS_TARGET_MIN) {
      if (cycle.insufficient_supported_hypotheses !== true) {
        push(`automation_hypotheses has ${count} entries — fewer than ${HYPOTHESIS_TARGET_MIN} is allowed only with insufficient_supported_hypotheses true; never invent hypotheses to reach the target`);
      }
      if (!isNonEmptyString(cycle.insufficient_supported_hypotheses_reason)) {
        push('insufficient_supported_hypotheses requires an explicit insufficient_supported_hypotheses_reason');
      }
    }
    cycle.automation_hypotheses.forEach((h, i) => {
      const result = validateAutomationHypothesis(h, `automation_hypotheses[${i}]`);
      if (!result.ok) errors.push(...result.errors);
    });
  }

  // --- Founder practices: exactly two ---------------------------------------------------
  if (!Array.isArray(cycle.founder_practices)) {
    push('founder_practices must be an array');
  } else {
    if (cycle.founder_practices.length !== 2) {
      push(`founder_practices must contain exactly 2 entries (found ${cycle.founder_practices.length})`);
    }
    cycle.founder_practices.forEach((p, i) => {
      if (!isObject(p)) return push(`founder_practices[${i}] must be an object`);
      for (const field of PRACTICE_REQUIRED_FIELDS) {
        if (!isNonEmptyString(p[field])) push(`founder_practices[${i}].${field} must be a non-empty string`);
      }
    });
    if (cycle.founder_practices.length === 2) {
      if (!isNonEmptyString(cycle.founder_practice_comparison)) {
        push('founder_practice_comparison must compare the two practices');
      }
      const order = cycle.founder_practice_recommended_order;
      if (!Array.isArray(order) || order.length !== 2 || !order.every(isNonEmptyString)) {
        push('founder_practice_recommended_order must recommend an order over exactly the two practice ids');
      } else {
        const ids = cycle.founder_practices.map((p) => p?.id);
        for (const id of order) {
          if (!ids.includes(id)) push(`founder_practice_recommended_order references unknown practice id ${id}`);
        }
      }
    }
  }

  // --- Experiments: two or three --------------------------------------------------------
  if (!Array.isArray(cycle.experiments)) {
    push('experiments must be an array');
  } else {
    if (cycle.experiments.length < 2 || cycle.experiments.length > 3) {
      push(`experiments must contain 2 or 3 entries (found ${cycle.experiments.length})`);
    }
    cycle.experiments.forEach((e, i) => {
      if (!isObject(e)) return push(`experiments[${i}] must be an object`);
      for (const field of EXPERIMENT_REQUIRED_FIELDS) {
        if (!isNonEmptyString(e[field])) push(`experiments[${i}].${field} must be a non-empty string`);
      }
    });
  }

  // --- Roadmap: Evolution stage only, never the product phase ---------------------------
  if (!isObject(cycle.roadmap)) {
    push('roadmap must be an object');
  } else {
    if (!EVOLUTION_STAGES.includes(cycle.roadmap.evolution_stage)) {
      push(`roadmap.evolution_stage must be one of ${EVOLUTION_STAGES.join(', ')}`);
    }
    if (cycle.roadmap.product_phase_unchanged !== true) {
      push('roadmap.product_phase_unchanged must be true — an Evolution cycle never changes the product phase, C1/C2 meaning, PnL gates or live-money authority');
    }
  }

  if (cycle.corrections !== undefined) {
    if (!Array.isArray(cycle.corrections)) {
      push('corrections must be an array when present');
    } else {
      cycle.corrections.forEach((c, i) => {
        const result = validateFounderCorrection(c, `corrections[${i}]`);
        if (!result.ok) errors.push(...result.errors);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------
// Founder report
// ---------------------------------------------------------------------------------------

const AXIS_A_RU = Object.freeze({
  ADVANCED: 'продвинулись',
  NO_MEASURABLE_CHANGE: 'измеримых изменений нет',
  STALLED: 'застряли',
  REGRESSED: 'откатились назад',
  NOT_ENOUGH_EVIDENCE: 'недостаточно доказательств',
});

const AXIS_B_RU = Object.freeze({
  CAPABILITY_ADDED: 'появилась новая переиспользуемая возможность',
  CAPABILITY_STRENGTHENED: 'существующая возможность стала прочнее',
  PRACTICED_NOT_YET_PROVEN: 'попрактиковались, но доказательства ещё нет',
  NO_MEASURABLE_CHANGE: 'измеримых изменений нет',
  REGRESSED: 'откатились назад',
});

const CLASSIFICATION_RU = Object.freeze({
  NOW: 'делать сейчас',
  PRODUCT_FIRST: 'сначала продукт',
  SYSTEM_LATER: 'система позже',
  REJECT: 'отклонить',
});

const METRIC_RU = Object.freeze({
  time_to_verified_result: 'время до проверенного результата',
  first_pass_pass_rate: 'доля задач, прошедших с первого раза',
  rework_count: 'количество переделок',
  cost_per_verified_result: 'стоимость одного проверенного результата',
  reviewer_rejection_count: 'отказы ревьюера',
  runtime_evidence_count: 'сколько раз получили доказательство из реального рантайма',
  reusable_artifacts_created: 'создано переиспользуемых артефактов',
  cloudcode_actions: 'ручных сообщений в CloudCode',
  codex_actions: 'ручных сообщений в Codex',
  architect_corrections: 'правок от архитектора',
  intermediate_actions_per_mission: 'промежуточных действий на одну миссию',
  actions_per_verified_result: 'действий на один проверенный результат',
});

const COVERAGE_RU = Object.freeze({
  COMPLETE: 'полный',
  PARTIAL: 'частичный',
  UNKNOWN: 'неизвестен',
});

function metricValueRu(value) {
  if (value === 'UNKNOWN') return 'неизвестно';
  if (value === 'NOT_AVAILABLE') return 'нет данных';
  return String(value);
}

function bullets(lines, emptyText) {
  if (!lines || lines.length === 0) return [emptyText];
  return lines.map((l) => `- ${l}`);
}

/**
 * Renders the Russian Founder report from a validated cycle.
 * Deliberately plain: no field names, no JSON, no quotes — those live in the cycle file.
 */
export function renderFounderReport(cycle) {
  const out = [];
  const push = (...lines) => out.push(...lines);

  const a = cycle.axis_a;
  const b = cycle.axis_b;
  const ops = cycle.operator_actions;

  push('# Daily Evolution Review', '');
  push(`Период: ${cycle.period_start} — ${cycle.period_end}.`, '');

  push('## Главный итог', '');
  push(`По бизнесу (запуск, выручка, PnL): ${AXIS_A_RU[a.verdict]}.`);
  push(`По системе (переиспользуемые возможности): ${AXIS_B_RU[b.verdict]}.`);
  push('');
  push('Две оценки живут отдельно. Продвижение системы не засчитывается как продвижение бизнеса, и наоборот.', '');

  push('## Ось A — запуск, выручка и PnL', '');
  push('Что сдвинулось:');
  push(...bullets(a.what_moved.map((c) => c.statement), '- Ничего измеримого.'));
  push('');
  push(`Какой следующий проверяемый факт в проде стал возможен: ${
    a.next_verified_production_fact_now_possible || 'пока никакой'}.`);
  push('');
  if (a.blockers_removed.length) {
    push('Снятые блокеры:');
    push(...bullets(a.blockers_removed.map((c) => c.statement), '- Нет.'));
    push('');
  }
  if (a.blockers_introduced.length) {
    push('Появившиеся блокеры:');
    push(...bullets(a.blockers_introduced.map((c) => c.statement), '- Нет.'));
    push('');
  }
  push(a.pnl.reconciled_claimed
    ? 'Сверенный PnL: заявлен и подтверждён исполнениями, комиссиями и расчётом.'
    : 'Сверенный PnL: не заявлен. Без реальных исполнений, комиссий и расчёта он не считается.');
  push('');

  push('## Ось B — Manifest 2', '');
  push('Manifest 2 — это набор переиспользуемых способностей системы: контракты задач, проверяемость, реестр, окружения, права, скрипты, переносимость, восстановление.');
  push('');
  if (b.capabilities.length) {
    push('Что появилось или окрепло:');
    push(...b.capabilities.map((c) => `- ${c.statement} (остаётся в репозитории: ${c.persisted_artifact})`));
  } else {
    push('Новых переиспользуемых способностей за период не появилось.');
  }
  push('');
  push('Описание в чате возможностью не считается: нужен артефакт в Git и след его использования или проверки.', '');

  push('## Что доказано', '');
  const proven = [
    ...a.what_moved.filter((c) => c.evidence_class === 'PROVEN_IN_RUNTIME').map((c) => c.statement),
    ...b.capabilities.map((c) => `${c.statement} — ${c.use_or_validation_evidence}`),
  ];
  push(...bullets(proven, '- Доказанных фактов за период нет.'));
  push('');

  push('## Что блокирует следующий шаг', '');
  const blocking = [
    ...a.blockers_introduced.map((c) => c.statement),
    ...a.not_proven,
    ...b.not_proven,
  ];
  push(...bullets(blocking, '- Явных блокеров не зафиксировано.'));
  push('');

  push('## Варианты автоматизации', '');
  if (cycle.automation_hypotheses.length === 0) {
    push('Обоснованных вариантов за период не набралось.');
  } else {
    for (const h of cycle.automation_hypotheses) {
      push(`- ${h.proposed_automation} — ${CLASSIFICATION_RU[h.classification]}.`);
      push(`  Проблема: ${h.observed_problem}`);
      push(`  Что останется в репозитории: ${h.persistent_artifact}`);
      push(`  Когда остановиться: ${h.rollback_or_stop_condition}`);
    }
  }
  if (cycle.insufficient_supported_hypotheses === true) {
    push('');
    push(`Меньше пяти вариантов — намеренно: ${cycle.insufficient_supported_hypotheses_reason}`);
  }
  push('');

  push('## Две практики Founder', '');
  for (const p of cycle.founder_practices) {
    push(`- ${p.skill_practiced}`);
    push(`  Зачем сейчас: ${p.why_it_matters_now}`);
    push(`  Как ложится на проект: ${p.how_it_applies_to_current_project}`);
    push(`  Что останется в репозитории: ${p.persistent_git_artifact}`);
  }
  push('');
  push(`Сравнение: ${cycle.founder_practice_comparison}`);
  push(`Рекомендуемый порядок: сначала ${cycle.founder_practice_recommended_order[0]}, затем ${cycle.founder_practice_recommended_order[1]}.`);
  push('');

  push('## Следующие эксперименты', '');
  for (const e of cycle.experiments) {
    push(`- ${e.hypothesis}`);
    push(`  Границы: ${e.bounded_scope}`);
    push(`  Что останется: ${e.persistent_artifact}`);
    push(`  Считаем удачей: ${e.promotion_condition}`);
    push(`  Останавливаемся, если: ${e.stop_condition}`);
  }
  push('');

  push('## Поддерживающие метрики', '');
  push('Это диагностика, а не оценка. Метрики объясняют вывод, но никогда его не заменяют.');
  push('');
  for (const [key, value] of Object.entries(cycle.supporting_metrics.values)) {
    push(`- ${METRIC_RU[key] || key}: ${metricValueRu(value)}`);
  }
  push('');
  push(`Ручных сообщений Founder за период: ${ops.total_operator_actions} (полнота сбора — ${COVERAGE_RU[ops.capture_coverage]}).`);
  push(`Правок от архитектора: ${ops.architect_corrections}. Они считаются отдельно и в число ручных сообщений не входят.`);
  if (ops.capture_coverage !== 'COMPLETE') {
    push('');
    push('Полнота сбора неполная, поэтому это нижняя оценка, а не точное число.');
  }
  push('');

  push('## Roadmap', '');
  push('Эволюция системы идёт тремя уровнями: сначала ежедневный разбор, затем управление автоматизацией, дальше — операционная система агентов.');
  push(`Сейчас: ${evolutionStageRu(cycle.roadmap.evolution_stage)}.`);
  push('');
  push('Продуктовая фаза, смысл C1 и C2, гейты по PnL и права на реальные деньги этим разбором не меняются.', '');

  push('## Что произойдёт дальше', '');
  push(cycle.next_step);
  push('');

  return out.join('\n');
}

function evolutionStageRu(stage) {
  if (stage === 'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP') return 'уровень 1 — ежедневный разбор';
  if (stage === 'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE') return 'уровень 2 — управление автоматизацией';
  return 'горизонт — операционная система агентов';
}

/**
 * Validates a Founder report against the heading and style contract.
 * Checks structure and leakage, not literary quality.
 */
export function validateFounderReport(markdown) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return { ok: false, errors: ['founder_report must be a non-empty string'] };
  }

  const lines = markdown.split('\n');
  const headingLines = lines.filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());

  if (headingLines.length !== FOUNDER_REPORT_HEADINGS.length) {
    push(`founder_report declares ${headingLines.length} headings, expected exactly ${FOUNDER_REPORT_HEADINGS.length}`);
  }
  FOUNDER_REPORT_HEADINGS.forEach((expected, i) => {
    if (headingLines[i] !== expected) {
      push(`founder_report heading ${i + 1} must be "${expected}" (found "${headingLines[i] ?? '<missing>'}")`);
    }
  });

  // Every section must actually say something.
  const indices = FOUNDER_REPORT_HEADINGS.map((h) => lines.findIndex((l) => l.trim() === h));
  FOUNDER_REPORT_HEADINGS.forEach((heading, i) => {
    const start = indices[i];
    if (start < 0) return;
    const end = i + 1 < indices.length && indices[i + 1] > start ? indices[i + 1] : lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    if (body.length === 0) push(`founder_report section "${heading}" is empty`);
  });

  if (/```/.test(markdown)) {
    push('founder_report must not contain code fences — machine evidence belongs in the cycle JSON');
  }
  for (const marker of SCHEMA_DUMP_MARKERS) {
    if (markdown.includes(marker)) {
      push(`founder_report leaks machine structure (${marker === '"' ? 'raw quoted JSON' : marker}) — the Founder report carries no schema dumps`);
    }
  }

  // Mobile readability: no wall-of-text lines.
  lines.forEach((line, i) => {
    if (line.length > 400) push(`founder_report line ${i + 1} is ${line.length} characters — too long to read on a phone`);
  });

  return { ok: errors.length === 0, errors };
}
