#!/usr/bin/env node
/**
 * validate-premvp-release-run.mjs
 *
 * Deterministic, dependency-free validator for a PREMVP release-run manifest against
 * docs/ai-context/control-plane/pipelines/PREMVP_RELEASE_RUN.schema.json's invariants.
 *
 * Usage:
 *   node scripts/control-plane/validate-premvp-release-run.mjs --manifest <path> [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const RECONCILE_COMMAND_ID = 'premvp.command.control_plane_reconcile.v1';
export const RELEASE_PIPELINE_COMMAND_ID = 'premvp.command.release_pipeline.v1';
export const CANONICAL_REPOSITORY = 'POLYPROPICKS/PREMVP';
export const R5_AUTHORIZED_ROUTE_ID = 'FOUNDER_AUTHORIZED_PREMVP_FUTURE_QUEUE_STAKE_V1';
export const R5_AUTHORIZATION_REF = 'FOUNDER_AUTH_R5_PREMVP_FUTURE_QUEUE_STAKE_20260824';

const REQUIRED_FIELDS = [
  'schema_version', 'release_run_id', 'task_id', 'task_class', 'risk_class', 'executor',
  'repository', 'base_ref', 'feature_branch', 'target_ref', 'allowed_files', 'forbidden_files',
  'test_commands', 'typecheck_commands', 'build_commands', 'required_capabilities',
  'expected_reviewer_policy', 'production_build_info_url', 'deployment_timeout_seconds',
  'operator_intervention_budget', 'state_reconcile_command', 'completion_envelope_path',
];

const KNOWN_RISK_CLASSES = [
  'R0_READ_ONLY', 'R1_BOUNDED_CODE', 'R2_ARCHITECTURE_OR_ROADMAP',
  'R3_WEATHER_MODEL_CHANGE', 'R4_CONTUR_PRODUCTION_BOUNDARY', 'R5_CROSS_REPO_OR_LIVE_MONEY',
];

const SECRET_PATTERNS = [
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'assigned secret value', re: /(SECRET|PASSWORD|SERVICE_ROLE|ANON_KEY|API_KEY|ACCESS_TOKEN)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

const DEPLOY_FIELD_NAMES = ['deploy_command', 'railway_command', 'manual_deploy', 'deploy_cli', 'deploy_api'];
const DB_COMMAND_PATTERN = /\b(migrate|migration|db:push|db:migrate|prisma migrate|supabase db)\b/i;
const IRELAND_PATTERN = /\bireland\b/i;

function stringify(manifest) {
  return JSON.stringify(manifest);
}

export function isAuthorizedBoundedR5Manifest(manifest) {
  const a = manifest?.r5_authorization;
  return Boolean(
    a &&
    a.route_id === R5_AUTHORIZED_ROUTE_ID &&
    a.authorization_ref === R5_AUTHORIZATION_REF &&
    a.direct_action_scope === 'FUTURE_QUEUE_STAKE_CONFIGURATION' &&
    a.max_stake_usd === 2.5 &&
    a.historical_queue_mutation === false &&
    a.raw_database_mutation === false &&
    a.direct_venue_action === false
  );
}

export function validateReleaseRunManifest(manifest) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['MANIFEST_NOT_AN_OBJECT'] };
  }

  for (const f of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(manifest, f)) {
      err(`MISSING_FIELD: ${f}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // SINGLE_REPOSITORY
  if (manifest.repository !== CANONICAL_REPOSITORY) {
    err(`SINGLE_REPOSITORY: repository must equal ${CANONICAL_REPOSITORY}, got ${manifest.repository}`);
  }

  // NO_IRELAND
  const wholeText = stringify(manifest);
  if (IRELAND_PATTERN.test(wholeText)) {
    err('NO_IRELAND: manifest references Ireland, which is forbidden for this pipeline');
  }

  // R5 remains fail-closed except for the one manifest-bound Founder route.
  if (manifest.risk_class === 'R5_CROSS_REPO_OR_LIVE_MONEY') {
    if (!isAuthorizedBoundedR5Manifest(manifest)) {
      err('R5_FAIL_CLOSED: R5 requires the exact bounded Founder authorization');
    }
    if (manifest.executor !== 'local_codex_windows') {
      err('R5_AUTHORIZED_EXECUTOR: bounded R5 route requires local_codex_windows');
    }
  }
  if (manifest.risk_class && !KNOWN_RISK_CLASSES.includes(manifest.risk_class)) {
    err(`UNKNOWN_RISK_CLASS: ${manifest.risk_class}`);
  }

  // ZERO_INTERMEDIATE_OPERATOR_ACTIONS
  const budget = manifest.operator_intervention_budget;
  if (!budget || typeof budget !== 'object' || budget.intermediate !== 0) {
    err('ZERO_INTERMEDIATE_OPERATOR_ACTIONS: operator_intervention_budget.intermediate must equal 0');
  }

  // NO_DIRECT_MAIN_PUSH
  if (manifest.feature_branch && manifest.base_ref && manifest.feature_branch === manifest.base_ref) {
    err('NO_DIRECT_MAIN_PUSH: feature_branch must not equal base_ref');
  }
  if (manifest.feature_branch === 'main' || manifest.feature_branch === manifest.target_ref) {
    err('NO_DIRECT_MAIN_PUSH: feature_branch must not equal target_ref');
  }

  // NO_MANUAL_DEPLOYMENT
  for (const field of DEPLOY_FIELD_NAMES) {
    if (Object.prototype.hasOwnProperty.call(manifest, field)) {
      err(`NO_MANUAL_DEPLOYMENT: manifest declares forbidden field ${field}`);
    }
  }

  // NO_SECRETS
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(wholeText)) err(`NO_SECRETS: manifest matches ${p.name}`);
  }

  // NO_DATABASE_MUTATION_V1
  const allCommands = [
    ...(manifest.test_commands || []),
    ...(manifest.build_commands || []),
    ...(manifest.typecheck_commands || []),
  ];
  for (const cmd of allCommands) {
    if (typeof cmd === 'string' && DB_COMMAND_PATTERN.test(cmd)) {
      err(`NO_DATABASE_MUTATION_V1: command "${cmd}" looks like a database migration/write`);
    }
  }

  // Field shape checks
  if (!Array.isArray(manifest.allowed_files) || manifest.allowed_files.length === 0) {
    err('ALLOWED_FILES: must be a non-empty array');
  }
  if (!Array.isArray(manifest.forbidden_files)) {
    err('FORBIDDEN_FILES: must be an array');
  }
  if (manifest.expected_base_sha !== undefined) {
    const v = manifest.expected_base_sha;
    if (v !== 'RESOLVE_AT_RUNTIME' && !/^[0-9a-f]{40}$/.test(String(v))) {
      err('EXPECTED_BASE_SHA: must be RESOLVE_AT_RUNTIME or a full 40-character hex SHA');
    }
  }

  // RECONCILE_GATE — the field must be present and correct even while the pipeline is disabled,
  // so that mutating activation later needs no manifest migration.
  if (manifest.state_reconcile_command !== RECONCILE_COMMAND_ID) {
    err(`RECONCILE_GATE: state_reconcile_command must equal ${RECONCILE_COMMAND_ID}`);
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  const manifestArg = args.find((a) => a.startsWith('--manifest='));
  const manifestIdx = args.indexOf('--manifest');
  const manifestPath = manifestArg
    ? manifestArg.slice('--manifest='.length)
    : manifestIdx !== -1 ? args[manifestIdx + 1] : null;
  const asJson = args.includes('--json');

  if (!manifestPath) {
    process.stderr.write('Usage: validate-premvp-release-run.mjs --manifest <path> [--json]\n');
    process.exit(1);
  }

  const full = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(full, 'utf8'));
  const { ok, errors } = validateReleaseRunManifest(manifest);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, errors }, null, 2) + '\n');
  } else if (ok) {
    process.stdout.write('[release-run] validate: PASS\n');
  } else {
    process.stderr.write(`[release-run] validate: FAIL (${errors.length} violation(s))\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
