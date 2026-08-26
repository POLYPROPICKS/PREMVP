#!/usr/bin/env node
/**
 * evolution-collect.mjs — premvp.command.evolution_collect.v1
 *
 * Turns a raw Evolution input bundle into a normalized, deduplicated operator-action
 * summary that a Daily Evolution Review can be built on.
 *
 * Reads nothing but the bundle: no clock, no network, no database, no product runtime.
 * Same bundle in, byte-identical collection out — on Cloud or on Windows.
 *
 * Usage:
 *   node scripts/control-plane/evolution-collect.mjs --input <bundle.json> [--out <file>] [--json]
 *
 * Exit codes:
 *   0 — bundle valid, collection produced
 *   1 — invalid bundle (every violation printed)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aggregateOperatorActions,
  validateOperatorActionSummary,
} from './lib/operator-actions.mjs';

export const COMMAND_ID = 'premvp.command.evolution_collect.v1';
export const COLLECTION_SCHEMA_VERSION = '1.1';

/** Metrics a cycle may report. Anything the bundle does not supply stays UNKNOWN. */
export const SUPPORTING_METRIC_IDS = Object.freeze([
  'time_to_verified_result',
  'first_pass_pass_rate',
  'rework_count',
  'cost_per_verified_result',
  'reviewer_rejection_count',
  'runtime_evidence_count',
  'reusable_artifacts_created',
  'cloudcode_actions',
  'codex_actions',
  'architect_corrections',
  'intermediate_actions_per_mission',
  'actions_per_verified_result',
]);

const UNKNOWN_VALUES = Object.freeze(['UNKNOWN', 'NOT_AVAILABLE']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const DEFECT_ORIGINS = new Set([
  'PRODUCT_OR_RUNTIME_DEFECT', 'PROMPT_OR_MISSION_CONSTRUCTION_DEFECT', 'DIAGNOSIS_SCOPE_DEFECT',
  'ORCHESTRATION_OR_RECOVERY_DEFECT', 'TEST_OR_VERIFICATION_DEFECT', 'STATE_OR_CONTEXT_DEFECT',
  'ENVIRONMENT_OR_PERMISSION_DEFECT', 'CONTROL_PLANE_DEFECT', 'UNKNOWN_ORIGIN',
]);
const DEFECT_RECURRENCES = new Set([
  'NEW_INDEPENDENT', 'SAME_ROOT_REPEAT', 'LATENT_NEXT_LAYER_EXPOSED', 'REGRESSION',
  'PROMPT_INDUCED_REPEAT', 'UNKNOWN_RECURRENCE',
]);
const OPERATING_METRIC_IDS = Object.freeze([
  'founder_actions_removable', 'executor_runs', 'successful_terminal_results', 'reruns_resumes',
  'recovery_iterations', 'reviewer_corrections_rejections', 'orchestration_waste_iterations',
  'implemented_fixes', 'proven_effective_fixes', 'runtime_evidence_count',
  'reusable_artifacts_created', 'actions_per_verified_result', 'time_to_verified_result',
]);

function measuredOrUnknown(value) {
  return (typeof value === 'number' && Number.isFinite(value)) || UNKNOWN_VALUES.includes(value)
    ? value : 'UNKNOWN';
}

export function buildOperatingTelemetry(bundle, summary) {
  const supplied = bundle.operating_telemetry || {};
  const defects = bundle.defect_occurrences;
  const telemetry = Object.fromEntries(OPERATING_METRIC_IDS.map((id) => [id, measuredOrUnknown(supplied[id])]));
  telemetry.capture_coverage = summary.capture_coverage;
  telemetry.chat_interaction_coverage = summary.capture_coverage;
  telemetry.founder_actions_proven = summary.total_operator_actions;
  telemetry.architect_corrections = summary.architect_corrections;
  telemetry.defect_occurrences = Array.isArray(defects) ? defects.map((defect) => ({
    defect_id: defect.defect_id,
    origin: defect.origin,
    recurrence: defect.recurrence,
    defect_chain_id: defect.defect_chain_id || null,
    implemented_fix_ref: defect.implemented_fix_ref || null,
    proven_effective_evidence_refs: Array.isArray(defect.proven_effective_evidence_refs) ? defect.proven_effective_evidence_refs : [],
  })) : 'UNKNOWN';
  if (!Array.isArray(defects)) {
    telemetry.defect_counts_by_origin = 'UNKNOWN';
    telemetry.defect_counts_by_recurrence = 'UNKNOWN';
    telemetry.repeated_defect_families = 'UNKNOWN';
    telemetry.active_onion_chains = 'UNKNOWN';
    return telemetry;
  }
  telemetry.defect_counts_by_origin = {};
  telemetry.defect_counts_by_recurrence = {};
  for (const defect of telemetry.defect_occurrences) {
    telemetry.defect_counts_by_origin[defect.origin] = (telemetry.defect_counts_by_origin[defect.origin] || 0) + 1;
    telemetry.defect_counts_by_recurrence[defect.recurrence] = (telemetry.defect_counts_by_recurrence[defect.recurrence] || 0) + 1;
  }
  const families = new Map();
  for (const defect of telemetry.defect_occurrences) {
    const key = defect.defect_chain_id || defect.defect_id;
    families.set(key, (families.get(key) || 0) + 1);
  }
  telemetry.repeated_defect_families = [...families.values()].filter((count) => count > 1).length;
  telemetry.active_onion_chains = new Set(telemetry.defect_occurrences
    .filter((defect) => defect.recurrence === 'LATENT_NEXT_LAYER_EXPOSED' && defect.defect_chain_id)
    .map((defect) => defect.defect_chain_id)).size;
  telemetry.implemented_fixes = telemetry.defect_occurrences.filter((defect) => defect.implemented_fix_ref).length;
  telemetry.proven_effective_fixes = telemetry.defect_occurrences.filter((defect) => defect.proven_effective_evidence_refs.length > 0).length;
  return telemetry;
}

/**
 * Builds the supporting-metrics block.
 *
 * Anything the bundle did not measure is UNKNOWN, never zero and never an estimate — a
 * guessed cost figure is worse than an admitted gap, because it survives into later cycles
 * as if it were data.
 */
export function buildSupportingMetrics(bundle, summary) {
  const supplied = bundle.supporting_metrics || {};
  const values = {};

  for (const id of SUPPORTING_METRIC_IDS) {
    const raw = supplied[id];
    if (typeof raw === 'number' && Number.isFinite(raw)) values[id] = raw;
    else if (UNKNOWN_VALUES.includes(raw)) values[id] = raw;
    else values[id] = 'UNKNOWN';
  }

  // Derived-from-collection values always win over whatever the bundle guessed.
  values.cloudcode_actions = summary.by_surface.CLOUDCODE;
  values.codex_actions = summary.by_surface.CODEX;
  values.architect_corrections = summary.architect_corrections;
  values.intermediate_actions_per_mission = summary.derived.intermediate_actions_per_mission;
  values.actions_per_verified_result = summary.derived.actions_per_verified_result;

  return { role: 'DIAGNOSTIC_ONLY', values };
}

export function collectEvolutionInputs(bundle) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return { ok: false, errors: ['bundle must be an object'], collection: null };
  }
  for (const field of ['bundle_id', 'period_start', 'period_end']) {
    if (!isNonEmptyString(bundle[field])) push(`${field} must be a non-empty string`);
  }
  if (bundle.repository !== undefined && bundle.repository !== 'POLYPROPICKS/PREMVP') {
    push('repository must be POLYPROPICKS/PREMVP — Evolution never crosses the repository boundary');
  }
  if (!Array.isArray(bundle.operator_action_events)) {
    push('operator_action_events must be an array');
  }
  if (bundle.evidence_cutoff !== undefined && !isNonEmptyString(bundle.evidence_cutoff)) push('evidence_cutoff must be a non-empty string when present');
  if (isNonEmptyString(bundle.evidence_cutoff) && bundle.period_end > bundle.evidence_cutoff) push('period_end must be at or before evidence_cutoff');
  if (Array.isArray(bundle.defect_occurrences)) {
    bundle.defect_occurrences.forEach((defect, i) => {
      if (!defect || !isNonEmptyString(defect.defect_id) || !DEFECT_ORIGINS.has(defect.origin) || !DEFECT_RECURRENCES.has(defect.recurrence)) {
        push(`defect_occurrences[${i}] requires defect_id plus approved origin and recurrence`);
      }
    });
  }
  if (errors.length) return { ok: false, errors, collection: null };

  const aggregation = aggregateOperatorActions(bundle.operator_action_events, {
    period_start: bundle.period_start,
    period_end: bundle.period_end,
    declared_capture_coverage: bundle.capture_coverage,
    mission_count: bundle.mission_count,
    verified_result_count: bundle.verified_result_count,
  });
  if (!aggregation.ok) return { ok: false, errors: aggregation.errors, collection: null };

  const summaryCheck = validateOperatorActionSummary(aggregation.summary);
  if (!summaryCheck.ok) return { ok: false, errors: summaryCheck.errors, collection: null };

  const collection = {
    schema_version: bundle.evidence_cutoff === undefined ? '1.0' : COLLECTION_SCHEMA_VERSION,
    command_id: COMMAND_ID,
    bundle_id: bundle.bundle_id,
    repository: 'POLYPROPICKS/PREMVP',
    period_start: bundle.period_start,
    period_end: bundle.period_end,
    ...(bundle.evidence_cutoff === undefined ? {} : { evidence_cutoff: bundle.evidence_cutoff }),
    completion_envelope_ids: Array.isArray(bundle.completion_envelope_ids) ? bundle.completion_envelope_ids : [],
    confirmed_changes: Array.isArray(bundle.confirmed_changes) ? bundle.confirmed_changes : [],
    operator_actions: aggregation.summary,
    ...(bundle.evidence_cutoff === undefined ? {} : { operating_telemetry: buildOperatingTelemetry(bundle, aggregation.summary) }),
    supporting_metrics: buildSupportingMetrics(bundle, aggregation.summary),
  };

  return { ok: true, errors: [], collection };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(`${COMMAND_ID}\nUsage: --input <bundle.json> [--out <file>] [--json]\n`);
    process.exit(0);
  }
  const inputIdx = args.indexOf('--input');
  if (inputIdx < 0 || !args[inputIdx + 1]) {
    process.stderr.write('evolution-collect requires --input <bundle.json>\n');
    process.exit(1);
  }
  const bundlePath = args[inputIdx + 1];
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const { ok, errors, collection } = collectEvolutionInputs(bundle);

  if (!ok) {
    process.stderr.write(`[evolution-collect] FAIL (${errors.length} violation(s))\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  const serialized = `${JSON.stringify(collection, null, 2)}\n`;
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) {
    fs.mkdirSync(path.dirname(path.resolve(args[outIdx + 1])), { recursive: true });
    fs.writeFileSync(args[outIdx + 1], serialized, 'utf8');
  }
  process.stdout.write(args.includes('--json')
    ? serialized
    : `[evolution-collect] PASS — ${collection.operator_actions.total_operator_actions} operator action(s), coverage ${collection.operator_actions.capture_coverage}\n`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
