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
export const COLLECTION_SCHEMA_VERSION = '1.0';

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
    schema_version: COLLECTION_SCHEMA_VERSION,
    command_id: COMMAND_ID,
    bundle_id: bundle.bundle_id,
    repository: 'POLYPROPICKS/PREMVP',
    period_start: bundle.period_start,
    period_end: bundle.period_end,
    completion_envelope_ids: Array.isArray(bundle.completion_envelope_ids) ? bundle.completion_envelope_ids : [],
    confirmed_changes: Array.isArray(bundle.confirmed_changes) ? bundle.confirmed_changes : [],
    operator_actions: aggregation.summary,
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
