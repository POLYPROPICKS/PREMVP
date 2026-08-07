/**
 * evolution-governor.mjs
 *
 * Deterministic, dependency-free contracts for the PolyProPicks Automation Roadmap Governor
 * (Evolution Stage 2).
 *
 * Contract source: docs/ai-context/control-plane/evolution/EVOLUTION_POLICY.yaml,
 *                  docs/ai-context/control-plane/evolution/AUTOMATION_ROADMAP.yaml
 * Schemas:         docs/ai-context/control-plane/evolution/schemas/GOVERNOR_RESULT.schema.json
 *                  docs/ai-context/control-plane/evolution/schemas/ROADMAP_DELTA.schema.json
 *
 * The Governor answers whether automation is helping Axis A arrive sooner, never whether
 * automation is impressive on its own. Three things are enforced here that nothing else in
 * the control plane enforces for Stage 2:
 *   1. Eligibility is evidence-driven — insufficient evidence produces an explicit no-change
 *      outcome, never a fabricated roadmap delta.
 *   2. A roadmap delta can never accept itself and can never touch strategic authority —
 *      PnL priority, product-roadmap phase, live-money gates, risk authority, strategic
 *      stage order, accepted capability level or promotion rules stay Architect-owned.
 *   3. Factual auto-updates (counters, statuses, observations) are separated by an explicit
 *      allowlist from strategic fields, which are never auto-updated.
 *
 * Like the rest of scripts/control-plane, this is a focused validator rather than a generic
 * JSON Schema engine: the messages have to be readable by a Founder on a phone.
 */

export const GOVERNOR_SCHEMA_VERSION = '1.0';

export const AUTOMATION_ROADMAP_STAGES = Object.freeze([
  'STAGE_1_DAILY_EVOLUTION_ROUTINE_MVP',
  'STAGE_2_AUTOMATION_ROADMAP_AND_GOVERNANCE',
  'VISION_AGENT_OPERATING_SYSTEM',
]);

export const FOUNDER_CAPABILITY_LADDER_IDS = Object.freeze([
  'MISSION_DISCIPLINE', 'VERIFICATION_DISCIPLINE', 'PERMISSION_AND_TOOL_DESIGN',
  'AUTOMATION_ECONOMICS', 'DURABLE_OPERATIONS', 'CONTROL_PLANE_OWNERSHIP',
  'CONTROLLED_SELF_IMPROVEMENT',
]);

export const AXIS_B_VERDICTS = Object.freeze([
  'CAPABILITY_ADDED', 'CAPABILITY_STRENGTHENED', 'PRACTICED_NOT_YET_PROVEN',
  'NO_MEASURABLE_CHANGE', 'REGRESSED',
]);

export const AXIS_A_SUPPORT_VERDICTS = Object.freeze([
  'SUPPORTED_AXIS_A', 'DISTRACTED_FROM_AXIS_A', 'NEUTRAL', 'NOT_ENOUGH_EVIDENCE',
]);

export const AUTOMATION_DECISIONS = Object.freeze(['PROMOTE', 'DEFER', 'REJECT']);
export const EXPERIMENT_OUTCOMES = Object.freeze(['PROMOTION_CONDITION_MET', 'STOP_CONDITION_MET', 'INCONCLUSIVE']);

export const EVIDENCE_CLASSES = Object.freeze([
  'PROVEN_IN_RUNTIME', 'FOUNDER_ACCEPTED_EXTERNAL_AUDIT',
  'FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT', 'SUPPORTED', 'NOT_PROVEN',
]);

/** Minimum new validated cycles that make a Governor run eligible on its own. */
export const ELIGIBILITY_MIN_NEW_CYCLES = 3;

/** The only keys a factual auto-update may ever carry, besides the role marker. */
export const FACTUAL_UPDATE_FIELDS = Object.freeze([
  'last_evaluated_at', 'cycle_count', 'evidence_counters', 'hypothesis_status',
  'experiment_status', 'measured_supporting_metrics', 'repetition_counts',
  'capability_evidence_observations',
]);

/** Strategic authority a Governor result — and a roadmap delta — may never carry or mutate. */
export const STRATEGIC_FIELD_KEYS = Object.freeze([
  'pnl_priority', 'product_roadmap_phase', 'live_money_gates', 'risk_authority',
  'strategic_stage_order', 'accepted_capability_level', 'promotion_rules',
  'roadmap_phase', 'current_value_step',
]);

/** Phrases that would mean Axis A got quietly reordered below Axis B. Never allowed. */
const AXIS_REORDER_MARKERS = [
  /axis\s*a.{0,40}below\s*axis\s*b/i,
  /axis\s*b.{0,40}(above|before|instead of)\s*axis\s*a/i,
  /(automation|axis\s*b).{0,40}replaces?\s*(pnl|axis\s*a|launch|revenue)/i,
];

/** Tokens that mean raw machine structure leaked into the Founder-facing report. */
const SCHEMA_DUMP_MARKERS = Object.freeze([
  'schema_version', 'evidence_class', 'evidence_refs', 'result_id', 'roadmap_delta_id',
  '$schema', 'accepted', '"',
]);

export const GOVERNOR_REPORT_HEADINGS = Object.freeze([
  '# Automation Roadmap Review',
  '## Главный вывод',
  '## Что улучшилось',
  '## Что реально помогло запуску и PnL',
  '## Что повторяется и требует автоматизации',
  '## Какие навыки Founder закрепляются',
  '## Что предлагается изменить в roadmap',
  '## Что сохраняется без изменений',
  '## Риск ухода в лишнюю автоматизацию',
  '## Следующий разумный шаг',
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

/**
 * Evidence-driven eligibility. Default: at least three new validated cycles since the last
 * governance run, OR the configured weekly boundary. Never both required, never invented.
 */
export function computeEligibility({ newValidatedCycleCount, weeklyBoundaryReached } = {}) {
  const count = Number.isInteger(newValidatedCycleCount) ? newValidatedCycleCount : 0;
  const boundary = weeklyBoundaryReached === true;
  if (count >= ELIGIBILITY_MIN_NEW_CYCLES) {
    return { eligible: true, reason: `${count} new validated cycle(s) meets the minimum of ${ELIGIBILITY_MIN_NEW_CYCLES}` };
  }
  if (boundary) {
    return { eligible: true, reason: 'the configured weekly boundary was reached' };
  }
  return {
    eligible: false,
    reason: `only ${count} new validated cycle(s) (minimum ${ELIGIBILITY_MIN_NEW_CYCLES}) and the weekly boundary has not been reached — insufficient evidence for a Governor run`,
  };
}

/** Full ROADMAP_DELTA validation. Returns every violation, not just the first. */
export function validateRoadmapDelta(delta, label = 'roadmap_delta') {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!isObject(delta)) return { ok: false, errors: [`${label} must be an object`] };

  for (const key of STRATEGIC_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(delta, key)) {
      push(`${label}.${key} is a strategic field — a roadmap delta may never carry it; strategic authority requires a separate Promotion Gate`);
    }
  }

  for (const field of ['roadmap_delta_id', 'proposed_change', 'business_effect', 'manifest_2_effect', 'opportunity_cost', 'drift_from_original_roadmap', 'success_metric', 'rollback_condition']) {
    if (!isNonEmptyString(delta[field])) push(`${label}.${field} must be a non-empty string`);
  }

  if (!AUTOMATION_ROADMAP_STAGES.includes(delta.current_stage)) {
    push(`${label}.current_stage must be one of ${AUTOMATION_ROADMAP_STAGES.join(', ')} — the Governor never invents a fourth stage`);
  }

  if (!nonEmptyStringArray(delta.based_on_cycles)) {
    push(`${label}.based_on_cycles must list at least one persisted, validated cycle id`);
  }
  if (!Array.isArray(delta.preserves) || delta.preserves.length === 0 || !delta.preserves.every(isNonEmptyString)) {
    push(`${label}.preserves must list at least one thing that stays unchanged`);
  }
  if (!Array.isArray(delta.supersedes) || !delta.supersedes.every(isNonEmptyString)) {
    push(`${label}.supersedes must be an array of strings`);
  }
  if (!Array.isArray(delta.retires) || !delta.retires.every(isNonEmptyString)) {
    push(`${label}.retires must be an array of strings`);
  }

  if (!Array.isArray(delta.evidence) || delta.evidence.length === 0) {
    push(`${label}.evidence must list at least one material claim`);
  } else {
    delta.evidence.forEach((claim, i) => validateClaim(claim, `${label}.evidence[${i}]`, push));
  }

  if (typeof delta.drift_justified !== 'boolean') {
    push(`${label}.drift_justified must be a boolean`);
  }

  if (delta.accepted !== false) {
    push(`${label}.accepted must be false — the Governor must never accept its own roadmap delta`);
  }

  const businessEffect = isNonEmptyString(delta.business_effect) ? delta.business_effect : '';
  const proposedChange = isNonEmptyString(delta.proposed_change) ? delta.proposed_change : '';
  const combined = `${businessEffect} ${proposedChange}`;
  for (const marker of AXIS_REORDER_MARKERS) {
    if (marker.test(combined)) {
      push(`${label} reorders Axis A priority — a roadmap delta may never move launch, revenue, settlement or reconciled PnL below Manifest 2 capability`);
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Validates the factual-update block against the explicit factual/strategic separation. */
export function validateRoadmapFactualUpdates(updates, label = 'roadmap_factual_updates') {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!isObject(updates)) return { ok: false, errors: [`${label} must be an object`] };
  if (updates.role !== 'FACTUAL_ONLY') {
    push(`${label}.role must be FACTUAL_ONLY`);
  }
  for (const key of Object.keys(updates)) {
    if (key === 'role') continue;
    if (STRATEGIC_FIELD_KEYS.includes(key)) {
      push(`${label}.${key} is a strategic field and can never be auto-updated — it requires a Promotion Gate`);
      continue;
    }
    if (!FACTUAL_UPDATE_FIELDS.includes(key)) {
      push(`${label}.${key} is not a recognized factual field — allowed keys are ${FACTUAL_UPDATE_FIELDS.join(', ')}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Full GOVERNOR_RESULT validation. Returns every violation, not just the first. */
export function validateGovernorResult(result) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!isObject(result)) return { ok: false, errors: ['result must be an object'] };

  for (const field of ['result_id', 'generated_at', 'next_step']) {
    if (!isNonEmptyString(result[field])) push(`${field} must be a non-empty string`);
  }
  if (result.repository !== 'POLYPROPICKS/PREMVP') {
    push('repository must be POLYPROPICKS/PREMVP — the Governor never crosses the repository boundary');
  }
  if (result.accepted !== false) {
    push('accepted must be false — a Governor result is evidence and proposal only');
  }

  if (!isObject(result.generated_by)) {
    push('generated_by must be an object');
  } else {
    if (!['claude_code_cloud', 'local_codex_windows'].includes(result.generated_by.executor)) {
      push('generated_by.executor must be claude_code_cloud or local_codex_windows');
    }
    for (const field of ['model_label', 'prompt_id']) {
      if (!isNonEmptyString(result.generated_by[field])) push(`generated_by.${field} must be a non-empty string`);
    }
  }

  const eligibility = result.eligibility;
  if (!isObject(eligibility)) {
    push('eligibility must be an object');
  } else {
    if (typeof eligibility.eligible !== 'boolean') push('eligibility.eligible must be a boolean');
    if (!isNonEmptyString(eligibility.reason)) push('eligibility.reason must be a non-empty string');
    if (!Array.isArray(eligibility.based_on_cycles) || !eligibility.based_on_cycles.every(isNonEmptyString)) {
      push('eligibility.based_on_cycles must be an array of cycle ids');
    }
    if (!Number.isInteger(eligibility.new_validated_cycle_count) || eligibility.new_validated_cycle_count < 0) {
      push('eligibility.new_validated_cycle_count must be a non-negative integer');
    }
    if (typeof eligibility.weekly_boundary_reached !== 'boolean') {
      push('eligibility.weekly_boundary_reached must be a boolean');
    }
    if (eligibility.eligible === false &&
        Number.isInteger(eligibility.new_validated_cycle_count) &&
        eligibility.new_validated_cycle_count >= ELIGIBILITY_MIN_NEW_CYCLES) {
      push(`eligibility.eligible is false but new_validated_cycle_count (${eligibility.new_validated_cycle_count}) already meets the minimum of ${ELIGIBILITY_MIN_NEW_CYCLES} — this contradicts the eligibility rule`);
    }
    if (eligibility.eligible === true &&
        Number.isInteger(eligibility.new_validated_cycle_count) &&
        eligibility.new_validated_cycle_count < ELIGIBILITY_MIN_NEW_CYCLES &&
        eligibility.weekly_boundary_reached !== true) {
      push('eligibility.eligible is true but neither the minimum cycle count nor the weekly boundary condition holds — eligibility is never asserted without a met condition');
    }
  }

  const findings = result.findings;
  if (!isObject(findings)) {
    push('findings must be an object');
  } else {
    if (!isObject(findings.axis_b_advancement)) {
      push('findings.axis_b_advancement must be an object');
    } else {
      if (!AXIS_B_VERDICTS.includes(findings.axis_b_advancement.verdict)) {
        push(`findings.axis_b_advancement.verdict must be one of ${AXIS_B_VERDICTS.join(', ')}`);
      }
      if (!isNonEmptyString(findings.axis_b_advancement.statement)) {
        push('findings.axis_b_advancement.statement must be a non-empty string');
      }
    }

    if (!isObject(findings.axis_a_support_or_distraction)) {
      push('findings.axis_a_support_or_distraction must be an object');
    } else {
      if (!AXIS_A_SUPPORT_VERDICTS.includes(findings.axis_a_support_or_distraction.verdict)) {
        push(`findings.axis_a_support_or_distraction.verdict must be one of ${AXIS_A_SUPPORT_VERDICTS.join(', ')}`);
      }
      if (!isNonEmptyString(findings.axis_a_support_or_distraction.statement)) {
        push('findings.axis_a_support_or_distraction.statement must be a non-empty string');
      }
    }

    if (!Array.isArray(findings.repeated_problems)) {
      push('findings.repeated_problems must be an array');
    } else {
      findings.repeated_problems.forEach((p, i) => {
        const l = `findings.repeated_problems[${i}]`;
        if (!isObject(p)) return push(`${l} must be an object`);
        if (!isNonEmptyString(p.problem)) push(`${l}.problem must be a non-empty string`);
        if (!Array.isArray(p.cycle_refs) || p.cycle_refs.length < 2 || !p.cycle_refs.every(isNonEmptyString)) {
          push(`${l}.cycle_refs must name at least two distinct cycles — a single-cycle observation is not a repetition`);
        }
        if (!Number.isInteger(p.repetition_count) || p.repetition_count < 2) {
          push(`${l}.repetition_count must be an integer of at least 2`);
        }
      });
    }

    if (!Array.isArray(findings.experiments_with_evidence)) {
      push('findings.experiments_with_evidence must be an array');
    } else {
      findings.experiments_with_evidence.forEach((e, i) => {
        const l = `findings.experiments_with_evidence[${i}]`;
        if (!isObject(e)) return push(`${l} must be an object`);
        if (!isNonEmptyString(e.experiment_id)) push(`${l}.experiment_id must be a non-empty string`);
        if (!EXPERIMENT_OUTCOMES.includes(e.outcome)) push(`${l}.outcome must be one of ${EXPERIMENT_OUTCOMES.join(', ')}`);
        if (!nonEmptyStringArray(e.evidence_refs)) push(`${l}.evidence_refs must list at least one evidence reference`);
      });
    }

    if (!Array.isArray(findings.founder_skills_practiced)) {
      push('findings.founder_skills_practiced must be an array');
    } else {
      findings.founder_skills_practiced.forEach((s, i) => {
        const l = `findings.founder_skills_practiced[${i}]`;
        if (!isObject(s)) return push(`${l} must be an object`);
        if (!FOUNDER_CAPABILITY_LADDER_IDS.includes(s.ladder_id)) {
          push(`${l}.ladder_id must be one of ${FOUNDER_CAPABILITY_LADDER_IDS.join(', ')} — the Governor records repetition evidence, it never promotes a level`);
        }
        if (!Number.isInteger(s.repetition_count) || s.repetition_count < 1) {
          push(`${l}.repetition_count must be a positive integer`);
        }
        if (!nonEmptyStringArray(s.cycle_refs)) push(`${l}.cycle_refs must list at least one cycle reference`);
      });
    }

    if (!Array.isArray(findings.automation_decisions)) {
      push('findings.automation_decisions must be an array');
    } else {
      findings.automation_decisions.forEach((d, i) => {
        const l = `findings.automation_decisions[${i}]`;
        if (!isObject(d)) return push(`${l} must be an object`);
        if (!isNonEmptyString(d.subject)) push(`${l}.subject must be a non-empty string`);
        if (!AUTOMATION_DECISIONS.includes(d.decision)) push(`${l}.decision must be one of ${AUTOMATION_DECISIONS.join(', ')}`);
        if (!isNonEmptyString(d.reason)) push(`${l}.reason must be a non-empty string`);
        if (!nonEmptyStringArray(d.evidence_refs)) push(`${l}.evidence_refs must list at least one evidence reference`);
      });
    }

    if (!isObject(findings.roadmap_on_course)) {
      push('findings.roadmap_on_course must be an object');
    } else {
      if (typeof findings.roadmap_on_course.on_course !== 'boolean') push('findings.roadmap_on_course.on_course must be a boolean');
      if (!isNonEmptyString(findings.roadmap_on_course.statement)) push('findings.roadmap_on_course.statement must be a non-empty string');
    }

    if (typeof findings.roadmap_delta_justified !== 'boolean') {
      push('findings.roadmap_delta_justified must be a boolean');
    }
  }

  // --- roadmap_delta presence rule --------------------------------------------------------
  const deltaJustified = isObject(findings) && findings.roadmap_delta_justified === true;
  const eligible = isObject(eligibility) && eligibility.eligible === true;

  if (result.roadmap_delta !== null) {
    if (!eligible) {
      push('roadmap_delta must be null when eligibility.eligible is false — insufficient evidence never produces a delta');
    }
    if (!deltaJustified) {
      push('roadmap_delta must be null when findings.roadmap_delta_justified is false');
    }
    const deltaResult = validateRoadmapDelta(result.roadmap_delta, 'roadmap_delta');
    if (!deltaResult.ok) errors.push(...deltaResult.errors);
  } else if (eligible && deltaJustified) {
    push('roadmap_delta is null but eligibility.eligible and findings.roadmap_delta_justified are both true — a justified delta must be produced, not omitted');
  }

  // --- factual/strategic separation -------------------------------------------------------
  const factualResult = validateRoadmapFactualUpdates(result.roadmap_factual_updates);
  if (!factualResult.ok) errors.push(...factualResult.errors);

  for (const key of STRATEGIC_FIELD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      push(`result.${key} is a strategic field — a Governor result may never carry it at the top level`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------------------
// Founder report
// ---------------------------------------------------------------------------------------

const AXIS_B_RU = Object.freeze({
  CAPABILITY_ADDED: 'появилась новая переиспользуемая возможность',
  CAPABILITY_STRENGTHENED: 'существующая возможность стала прочнее',
  PRACTICED_NOT_YET_PROVEN: 'попрактиковались, но доказательства ещё нет',
  NO_MEASURABLE_CHANGE: 'измеримых изменений нет',
  REGRESSED: 'откатились назад',
});

const AXIS_A_SUPPORT_RU = Object.freeze({
  SUPPORTED_AXIS_A: 'помогло запуску и PnL',
  DISTRACTED_FROM_AXIS_A: 'отвлекло от запуска и PnL',
  NEUTRAL: 'не повлияло ни в одну сторону',
  NOT_ENOUGH_EVIDENCE: 'доказательств пока недостаточно',
});

const DECISION_RU = Object.freeze({
  PROMOTE: 'продвинуть',
  DEFER: 'отложить',
  REJECT: 'отклонить',
});

const LADDER_RU = Object.freeze({
  MISSION_DISCIPLINE: 'умение ставить задачу с ясной границей',
  VERIFICATION_DISCIPLINE: 'умение требовать доказательство, а не отчёт',
  PERMISSION_AND_TOOL_DESIGN: 'умение заранее решать права и инструменты',
  AUTOMATION_ECONOMICS: 'умение считать цену автоматизации',
  DURABLE_OPERATIONS: 'умение строить так, чтобы работа переживала смену сессии',
  CONTROL_PLANE_OWNERSHIP: 'умение осознанно менять правила системы',
  CONTROLLED_SELF_IMPROVEMENT: 'умение позволять системе улучшать себя не теряя контроль',
});

function bullets(lines, emptyText) {
  if (!lines || lines.length === 0) return [emptyText];
  return lines.map((l) => `- ${l}`);
}

/**
 * Renders the Russian Founder report from a validated Governor result.
 * Deliberately plain: no field names, no JSON, no quotes — those live in the result JSON.
 */
export function renderGovernorFounderReport(result) {
  const out = [];
  const push = (...lines) => out.push(...lines);
  const f = result.findings;
  const delta = result.roadmap_delta;

  push('# Automation Roadmap Review', '');
  push(`Основано на циклах: ${result.eligibility.based_on_cycles.join(', ') || 'нет циклов за этот разбор'}. Сформировано: ${result.generated_at}.`, '');

  push('## Главный вывод', '');
  if (!result.eligibility.eligible) {
    push(`Доказательств пока недостаточно для полноценного разбора: ${result.eligibility.reason}.`);
    push('Roadmap не меняется — это осознанный вывод без изменений, а не пропуск.', '');
  } else {
    push(`По системе (Manifest 2): ${AXIS_B_RU[f.axis_b_advancement.verdict]}.`);
    push(`По бизнесу: автоматизация ${AXIS_A_SUPPORT_RU[f.axis_a_support_or_distraction.verdict]}.`);
    push('');
  }

  push('## Что улучшилось', '');
  push(...bullets(
    f.axis_b_advancement && f.axis_b_advancement.statement ? [f.axis_b_advancement.statement] : [],
    '- За этот разбор ничего измеримого не появилось.',
  ));
  push('');

  push('## Что реально помогло запуску и PnL', '');
  push(f.axis_a_support_or_distraction ? f.axis_a_support_or_distraction.statement : 'Оценка ещё не проведена.');
  push('');
  push('Автоматизация никогда не оценивается сама по себе — только через то, приближает ли она запуск, выручку и сверенный PnL, или отвлекает от них.', '');

  push('## Что повторяется и требует автоматизации', '');
  push(...bullets(
    (f.repeated_problems || []).map((p) => `${p.problem} (встретилось ${p.repetition_count} раз)`),
    '- Повторяющихся проблем за этот разбор не набралось.',
  ));
  push('');
  if ((f.automation_decisions || []).length) {
    push('Решения по автоматизации:');
    for (const d of f.automation_decisions) {
      push(`- ${d.subject} — ${DECISION_RU[d.decision]}. ${d.reason}`);
    }
    push('');
  }

  push('## Какие навыки Founder закрепляются', '');
  push(...bullets(
    (f.founder_skills_practiced || []).map((s) => `${LADDER_RU[s.ladder_id] || s.ladder_id} — повторено ${s.repetition_count} раз(а)`),
    '- Пока недостаточно циклов, чтобы увидеть закрепление конкретного навыка.',
  ));
  push('');

  push('## Что предлагается изменить в roadmap', '');
  if (delta) {
    push(`${delta.proposed_change}`);
    push('');
    push(`Эффект на бизнес: ${delta.business_effect}`);
    push(`Эффект на Manifest 2: ${delta.manifest_2_effect}`);
    push(`Чем платим за это изменение: ${delta.opportunity_cost}`);
    push(`Отклонение от исходного roadmap: ${delta.drift_from_original_roadmap} (оправдано: ${delta.drift_justified ? 'да' : 'нет'}).`);
    push(`Как поймём, что сработало: ${delta.success_metric}`);
    push(`Когда откатываем: ${delta.rollback_condition}`);
    push('');
    push('Это предложение, а не решение — изменение вступит в силу только после отдельного шага принятия (Promotion Gate).', '');
  } else {
    push('Изменений не предлагается: либо доказательств недостаточно, либо roadmap уже соответствует тому, что показали циклы.', '');
  }

  push('## Что сохраняется без изменений', '');
  push(...bullets(
    delta ? delta.preserves : ['Приоритет Оси A (запуск, выручка, PnL) над Осью B', 'Продуктовая фаза, C1/C2, гейты по PnL и права на реальные деньги'],
    '- Всё сохраняется без изменений.',
  ));
  push('');

  push('## Риск ухода в лишнюю автоматизацию', '');
  push(f.axis_a_support_or_distraction && f.axis_a_support_or_distraction.verdict === 'DISTRACTED_FROM_AXIS_A'
    ? 'Есть признак, что автоматизация в этом периоде отвлекала от запуска и PnL — это явно зафиксировано выше, а не сглажено.'
    : 'Явного риска подмены бизнес-цели автоматизацией в этом периоде не зафиксировано. Проверка на это выполняется каждый раз заново.');
  push('');

  push('## Следующий разумный шаг', '');
  push(result.next_step);
  push('');

  return out.join('\n');
}

/**
 * Validates a Governor report against the heading and style contract.
 * Checks structure and leakage, not literary quality.
 */
export function validateGovernorReport(markdown) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    return { ok: false, errors: ['founder_report must be a non-empty string'] };
  }

  const lines = markdown.split('\n');
  const headingLines = lines.filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.trim());

  if (headingLines.length !== GOVERNOR_REPORT_HEADINGS.length) {
    push(`founder_report declares ${headingLines.length} headings, expected exactly ${GOVERNOR_REPORT_HEADINGS.length}`);
  }
  GOVERNOR_REPORT_HEADINGS.forEach((expected, i) => {
    if (headingLines[i] !== expected) {
      push(`founder_report heading ${i + 1} must be "${expected}" (found "${headingLines[i] ?? '<missing>'}")`);
    }
  });

  const indices = GOVERNOR_REPORT_HEADINGS.map((h) => lines.findIndex((l) => l.trim() === h));
  GOVERNOR_REPORT_HEADINGS.forEach((heading, i) => {
    const start = indices[i];
    if (start < 0) return;
    const end = i + 1 < indices.length && indices[i + 1] > start ? indices[i + 1] : lines.length;
    const body = lines.slice(start + 1, end).join('\n').trim();
    if (body.length === 0) push(`founder_report section "${heading}" is empty`);
  });

  if (/```/.test(markdown)) {
    push('founder_report must not contain code fences — machine evidence belongs in the result JSON');
  }
  for (const marker of SCHEMA_DUMP_MARKERS) {
    if (markdown.includes(marker)) {
      push(`founder_report leaks machine structure (${marker === '"' ? 'raw quoted JSON' : marker}) — the Founder report carries no schema dumps`);
    }
  }

  lines.forEach((line, i) => {
    if (line.length > 400) push(`founder_report line ${i + 1} is ${line.length} characters — too long to read on a phone`);
  });

  return { ok: errors.length === 0, errors };
}
