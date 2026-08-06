#!/usr/bin/env node
/**
 * validate-completion-envelope.mjs
 *
 * Focused, dependency-free validator for executor completion envelopes against
 * docs/ai-context/control-plane/COMPLETION_ENVELOPE.schema.json.
 *
 * This is deliberately NOT a generic JSON Schema engine: the repository has no schema
 * validation dependency and none is added. It enforces the required-field contract and
 * the x-invariants that make a PASS verdict trustworthy.
 *
 * Usage:
 *   node scripts/control-plane/validate-completion-envelope.mjs <envelope.json> [--json]
 *
 * Exit codes:
 *   0 — envelope valid
 *   1 — one or more violations (each printed explicitly)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCHEMA_PATH = path.join(
  REPO_ROOT, 'docs/ai-context/control-plane/COMPLETION_ENVELOPE.schema.json');
const ROUTING_PATH = path.join(
  REPO_ROOT, 'docs/ai-context/control-plane/ROUTING_AND_PIPELINES.yaml');

const SHA_RE = /^[0-9a-f]{7,40}$/;
const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'WAIT'];
const WORKTREE_STATES = ['clean', 'expected_dirty', 'unexpected_dirty'];
const RISK_CLASSES = [
  'R0_READ_ONLY', 'R1_BOUNDED_CODE', 'R2_ARCHITECTURE_OR_ROADMAP',
  'R3_WEATHER_MODEL_CHANGE', 'R4_CONTUR_PRODUCTION_BOUNDARY', 'R5_CROSS_REPO_OR_LIVE_MONEY',
];
const EXECUTORS = ['claude_code_cloud', 'local_codex_windows', 'ireland_local'];
const TEST_RESULTS = ['PASS', 'FAIL', 'SKIPPED', 'NOT_RUN'];

const RECEIPT_REQUIRED_FIELDS = [
  'agent_id', 'configured_model', 'reasoning_policy', 'independence_group',
  'reviewed_sha', 'verdict', 'evidence_refs',
];

function loadSchema(schemaPath = SCHEMA_PATH) {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

function loadRouting(routingPath = ROUTING_PATH) {
  return JSON.parse(fs.readFileSync(routingPath, 'utf8'));
}

/**
 * Mandatory reviewers are derived from ROUTING_AND_PIPELINES.yaml by risk class — never
 * from the envelope's own `required_reviewers`, which the executor writes about itself.
 * Without this, an R3/R4 envelope could declare `required_reviewers: []` and validate
 * clean, silently bypassing the Weather or Contur gate.
 */
function mandatoryReviewersFor(riskClass, routing) {
  const rc = (routing?.risk_classes || []).find((r) => r.id === riskClass);
  if (!rc) return null;
  const fromReceipts = (rc.reviewer_receipt_requirements || [])
    .filter((r) => r.mandatory === true)
    .map((r) => r.agent_id);
  return [...new Set([...fromReceipts])];
}

function isArray(v) { return Array.isArray(v); }

export function validateCompletionEnvelope(envelope, schema = loadSchema(), routing = loadRouting()) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['ENVELOPE_NOT_AN_OBJECT'] };
  }

  // --- Required fields ------------------------------------------------------------------
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(envelope, field)) {
      err(`MISSING_FIELD: ${field}`);
    }
  }

  // --- Field-level contract -------------------------------------------------------------
  if (envelope.risk_class !== undefined && !RISK_CLASSES.includes(envelope.risk_class)) {
    err(`INVALID_RISK_CLASS: ${envelope.risk_class}`);
  }
  if (envelope.executor !== undefined && !EXECUTORS.includes(envelope.executor)) {
    err(`INVALID_EXECUTOR: ${envelope.executor}`);
  }
  if (envelope.verdict !== undefined && !VERDICTS.includes(envelope.verdict)) {
    err(`INVALID_VERDICT: ${envelope.verdict}`);
  }
  for (const f of ['worktree_before', 'worktree_after']) {
    if (envelope[f] !== undefined && !WORKTREE_STATES.includes(envelope[f])) {
      err(`INVALID_${f.toUpperCase()}: ${envelope[f]}`);
    }
  }
  for (const f of ['base_sha', 'result_sha', 'origin_main_sha']) {
    if (envelope[f] !== undefined && !SHA_RE.test(String(envelope[f]))) {
      err(`INVALID_SHA: ${f} = ${envelope[f]}`);
    }
  }
  for (const f of ['runtime_changed', 'deployment_changed', 'database_changed',
    'forbidden_actions_respected']) {
    if (envelope[f] !== undefined && typeof envelope[f] !== 'boolean') {
      err(`INVALID_BOOLEAN: ${f}`);
    }
  }
  for (const f of ['files_changed', 'commands_run', 'tests', 'required_reviewers',
    'invoked_reviewers', 'reviewer_receipts', 'evidence', 'capability_changes', 'blockers']) {
    if (envelope[f] !== undefined && !isArray(envelope[f])) err(`INVALID_ARRAY: ${f}`);
  }
  if (envelope.founder_action !== undefined &&
      (typeof envelope.founder_action !== 'string' || envelope.founder_action.length === 0)) {
    err('INVALID_FOUNDER_ACTION: must be a non-empty string');
  }
  if (envelope.verdict === 'WAIT' && envelope.founder_action !== undefined && envelope.founder_action !== 'none') {
    err('WAIT_WITH_FOUNDER_ACTION: resumable WAIT must set founder_action none');
  }
  if (Array.isArray(envelope.evidence) && envelope.evidence.some((e) =>
    ['EXPECTED_NON_BLOCKING', 'EXECUTOR_OWNED_RECOVERY', 'RESUMABLE_WAIT'].includes(e?.classification)) &&
    envelope.founder_action !== 'none') {
    err('RECOVERABLE_WITH_FOUNDER_ACTION: recoverable classifications must set founder_action none');
  }

  // --- commands_run entries -------------------------------------------------------------
  if (isArray(envelope.commands_run)) {
    envelope.commands_run.forEach((c, i) => {
      for (const f of ['command', 'exit_code', 'purpose']) {
        if (c === null || typeof c !== 'object' || !Object.prototype.hasOwnProperty.call(c, f)) {
          err(`COMMANDS_RUN[${i}]: missing ${f}`);
        }
      }
      if (c && typeof c.exit_code !== 'number') err(`COMMANDS_RUN[${i}]: exit_code must be a number`);
    });
  }

  // --- tests entries --------------------------------------------------------------------
  if (isArray(envelope.tests)) {
    envelope.tests.forEach((t, i) => {
      if (!t || typeof t !== 'object') { err(`TESTS[${i}]: not an object`); return; }
      if (typeof t.name !== 'string' || !t.name) err(`TESTS[${i}]: missing name`);
      if (!TEST_RESULTS.includes(t.result)) err(`TESTS[${i}]: invalid result ${t.result}`);
    });
  }

  // --- reviewer receipts ----------------------------------------------------------------
  const receipts = isArray(envelope.reviewer_receipts) ? envelope.reviewer_receipts : [];
  receipts.forEach((r, i) => {
    if (!r || typeof r !== 'object') { err(`REVIEWER_RECEIPT[${i}]: not an object`); return; }
    for (const f of RECEIPT_REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(r, f)) err(`REVIEWER_RECEIPT[${i}]: missing ${f}`);
    }
    if (!r.definition_hash && !r.implementation_identity) {
      err(`REVIEWER_RECEIPT[${i}]: requires definition_hash or implementation_identity`);
    }
    if (r.reviewed_sha !== undefined && !SHA_RE.test(String(r.reviewed_sha))) {
      err(`REVIEWER_RECEIPT[${i}]: invalid reviewed_sha ${r.reviewed_sha}`);
    }
    if (r.reviewed_sha !== undefined && envelope.result_sha !== undefined &&
        String(r.reviewed_sha) !== String(envelope.result_sha)) {
      err(`REVIEWED_SHA_MISMATCH: receipt for ${r.agent_id} reviewed ${r.reviewed_sha} but result_sha is ${envelope.result_sha}`);
    }
    if (!['PASS', 'FAIL', 'BLOCKED'].includes(r.verdict)) {
      err(`REVIEWER_RECEIPT[${i}]: invalid verdict ${r.verdict}`);
    }
  });

  // --- Required reviewers must be invoked and must have receipts -------------------------
  // The declared set is cross-checked against routing so it cannot be under-declared.
  const declared = isArray(envelope.required_reviewers) ? envelope.required_reviewers : [];
  const mandatory = mandatoryReviewersFor(envelope.risk_class, routing);
  if (mandatory === null && envelope.risk_class !== undefined) {
    err(`UNKNOWN_RISK_CLASS_IN_ROUTING: ${envelope.risk_class} has no pipeline in ROUTING_AND_PIPELINES.yaml`);
  }
  for (const m of mandatory || []) {
    if (!declared.includes(m)) {
      err(`REQUIRED_REVIEWER_UNDER_DECLARED: risk class ${envelope.risk_class} mandates ${m}, but required_reviewers omits it`);
    }
  }
  const required = [...new Set([...declared, ...(mandatory || [])])];
  const invoked = new Set(isArray(envelope.invoked_reviewers) ? envelope.invoked_reviewers : []);
  const receiptAgents = new Set(receipts.map((r) => r && r.agent_id));
  for (const rev of required) {
    if (!invoked.has(rev)) err(`REQUIRED_REVIEWER_NOT_INVOKED: ${rev}`);
    if (!receiptAgents.has(rev)) err(`REVIEWER_RECEIPT_MISSING: ${rev}`);
  }

  // --- state_delta_proposal may never be self-accepted -----------------------------------
  const sdp = envelope.state_delta_proposal;
  if (sdp && typeof sdp === 'object' && sdp.accepted === true) {
    err('STATE_DELTA_SELF_ACCEPTED: the writing executor may not mark its own state delta accepted');
  }

  // --- PASS invariants ------------------------------------------------------------------
  if (envelope.verdict === 'PASS') {
    const failedCommands = (isArray(envelope.commands_run) ? envelope.commands_run : [])
      .filter((c) => c && typeof c.exit_code === 'number' && c.exit_code !== 0);
    for (const c of failedCommands) {
      err(`PASS_WITH_FAILED_COMMAND: "${c.command}" exited ${c.exit_code}`);
    }
    const failedTests = (isArray(envelope.tests) ? envelope.tests : [])
      .filter((t) => t && t.result === 'FAIL');
    for (const t of failedTests) err(`PASS_WITH_FAILED_TEST: ${t.name}`);

    if (isArray(envelope.blockers) && envelope.blockers.length > 0) {
      err(`PASS_WITH_BLOCKERS: ${envelope.blockers.length} blocker(s) present`);
    }
    if (envelope.forbidden_actions_respected === false) {
      err('PASS_WITH_FORBIDDEN_ACTION: forbidden_actions_respected is false');
    }
    if (envelope.worktree_after === 'unexpected_dirty') {
      err('PASS_WITH_UNEXPECTED_DIRTY_WORKTREE');
    }
    for (const r of receipts) {
      if (r && r.verdict && r.verdict !== 'PASS') {
        err(`PASS_WITH_NON_PASS_RECEIPT: ${r.agent_id} returned ${r.verdict}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const file = args.find((a) => !a.startsWith('--'));

  if (!file) {
    process.stderr.write('usage: validate-completion-envelope.mjs <envelope.json> [--json]\n');
    process.exit(1);
  }

  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (e) {
    process.stderr.write(`[control-plane] envelope: FAIL — cannot read/parse ${file}: ${e.message}\n`);
    process.exit(1);
  }

  const { ok, errors } = validateCompletionEnvelope(envelope);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, errors }, null, 2) + '\n');
  } else if (ok) {
    process.stdout.write('[control-plane] envelope: PASS\n');
  } else {
    process.stderr.write(`[control-plane] envelope: FAIL (${errors.length} violation(s))\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
