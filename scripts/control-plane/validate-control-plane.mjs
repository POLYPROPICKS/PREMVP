#!/usr/bin/env node
/**
 * validate-control-plane.mjs
 *
 * Deterministic, dependency-free validator for the canonical Architect Control Plane
 * artifacts in docs/ai-context/control-plane/.
 *
 * All .yaml control-plane artifacts are written in the JSON-compatible YAML 1.2 subset,
 * so they are parsed with JSON.parse and no YAML dependency is required.
 *
 * Usage:
 *   node scripts/control-plane/validate-control-plane.mjs [--root=<dir>] [--json]
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more violations (each printed explicitly)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const CONTROL_PLANE_DIR = 'docs/ai-context/control-plane';

const FILES = {
  policy: 'ARCHITECT_CONTROL_PLANE.yaml',
  state: 'CURRENT_STATE.yaml',
  capability: 'CAPABILITY_MATRIX.yaml',
  routing: 'ROUTING_AND_PIPELINES.yaml',
  registry: 'AGENT_REGISTRY.yaml',
  promptProtocol: 'PROMPT__PROTOCOL.md',
  completionSchema: 'COMPLETION_ENVELOPE.schema.json',
  evidenceLedger: 'EVIDENCE_LEDGER.md',
};

const REQUIRED_POLICY_KEYS = [
  'schema_version', 'policy_version', 'project', 'architect_interface', 'operator_mode',
  'source_authority', 'canonical_artifacts', 'execution_targets', 'repository_boundaries',
  'mobile_first_policy', 'founder_action_budget', 'global_stop_conditions',
  'stale_state_behavior', 'prohibited_founder_actions', 'superseded_or_legacy_sources',
];

const REQUIRED_STATE_KEYS = [
  'schema_version', 'updated_at', 'state_version', 'roadmap_phase', 'current_value_step',
  'next_two_value_steps', 'main', 'active_execution_work', 'proven_passes',
  'proven_failures', 'open_blockers', 'external_accepted_checkpoints',
  'evidence_freshness', 'stale_when', 'last_accepted_completion_id',
];

const REQUIRED_CAPABILITY_KEYS = ['schema_version', 'updated_at', 'access_surface_policy', 'execution_targets'];
const REQUIRED_ROUTING_KEYS = ['schema_version', 'updated_at', 'minimum_agent_policy', 'task_classes', 'risk_classes'];
const REQUIRED_REGISTRY_KEYS = ['schema_version', 'updated_at', 'entries'];

const REQUIRED_RISK_CLASSES = [
  'R0_READ_ONLY', 'R1_BOUNDED_CODE', 'R2_ARCHITECTURE_OR_ROADMAP',
  'R3_ML_CHANGE', 'R4_LIVE_RUNTIME', 'R5_CROSS_REPO_OR_LIVE_MONEY',
];

const CAPABILITY_VERDICTS = ['PROVEN', 'FAILED', 'NOT_PROVEN', 'NOT_AVAILABLE'];
const EVIDENCE_CLASSES = [
  'PROVEN_IN_RUNTIME', 'FOUNDER_ACCEPTED_EXTERNAL_AUDIT',
  'FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT', 'SUPPORTED', 'NOT_PROVEN',
];
const REGISTRY_TYPES = ['AGENT', 'SKILL', 'COMMAND', 'HOOK', 'SCRIPT', 'CI_GATE', 'POLICY'];
const REGISTRY_STATUS = ['PROVEN_PRESENT', 'REFERENCED_ONLY', 'PLANNED', 'SUPERSEDED'];
const REGISTRY_INVOCATION = ['AUTOMATIC', 'EXPLICIT', 'MODEL_DECIDED', 'NONE'];
const REGISTRY_PORTABILITY = ['PORTABLE', 'CODEX_ONLY', 'CLAUDE_ONLY', 'NEEDS_ADAPTER'];

const REQUIRED_REGISTRY_ENTRY_KEYS = [
  'canonical_id', 'type', 'owner_platform', 'implementation_path', 'status', 'invocation',
  'triggers', 'exclusions', 'model_policy', 'reasoning_policy', 'permissions',
  'repository_scope', 'input_contract', 'output_contract', 'independence_group',
  'receipt_required', 'evidence_class', 'last_verified_at', 'portability',
];

const REQUIRED_REGISTRY_IDS = [
  'codex.agent.weather_gate_reviewer.v0',
  'codex.agent.contur_gate_reviewer',
  'claude.command.verify',
  'claude.command.refresh_ai_context',
  'claude.command.daily_ops_report',
  'claude.hook.validate_proof_package',
  'premvp.policy.agent_constitution',
  'premvp.policy.task_routing',
  'premvp.policy.execution_protocol',
  'premvp.policy.verification_gates',
  'premvp.spec.code_auditor',
  'premvp.spec.compliance_monitor',
];

/** The untracked Local Windows prompt file. It may be mentioned, but never as authority. */
const UNTRACKED_PROMPT_PATH = 'docs/ai-context/PROMPT__PROTOCOL.md';
const NON_AUTHORITY_MARKERS = [
  'NOT_TRACKED', 'untracked', 'absent', 'ABSENT', 'MUST NOT', 'not present', 'unresolved',
];

/** Patterns for real secret values, not for the words "key" or "token" in prose. */
const SECRET_PATTERNS = [
  { name: 'openai-style key', re: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'assigned secret value', re: /(SECRET|PASSWORD|SERVICE_ROLE|ANON_KEY|API_KEY|ACCESS_TOKEN)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

function readText(root, rel) {
  return fs.readFileSync(path.join(root, CONTROL_PLANE_DIR, rel), 'utf8');
}

function has(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

export function validateControlPlane(root = REPO_ROOT) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  // --- Presence + JSON-compatible parse -------------------------------------------------
  const raw = {};
  const parsed = {};
  for (const [key, rel] of Object.entries(FILES)) {
    const full = path.join(root, CONTROL_PLANE_DIR, rel);
    if (!fs.existsSync(full)) {
      err(`MISSING_ARTIFACT: ${CONTROL_PLANE_DIR}/${rel}`);
      continue;
    }
    raw[key] = readText(root, rel);
    if (rel.endsWith('.yaml') || rel.endsWith('.json')) {
      try {
        parsed[key] = JSON.parse(raw[key]);
      } catch (e) {
        err(`NOT_JSON_PARSEABLE: ${CONTROL_PLANE_DIR}/${rel} — ${e.message}`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const policy = parsed.policy;
  const state = parsed.state;
  const capability = parsed.capability;
  const routing = parsed.routing;
  const registry = parsed.registry;

  // --- Required top-level keys ----------------------------------------------------------
  const keySets = [
    [FILES.policy, policy, REQUIRED_POLICY_KEYS],
    [FILES.state, state, REQUIRED_STATE_KEYS],
    [FILES.capability, capability, REQUIRED_CAPABILITY_KEYS],
    [FILES.routing, routing, REQUIRED_ROUTING_KEYS],
    [FILES.registry, registry, REQUIRED_REGISTRY_KEYS],
  ];
  for (const [name, obj, keys] of keySets) {
    for (const k of keys) {
      if (!has(obj, k)) err(`MISSING_KEY: ${name} → ${k}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // --- Architect interface policy -------------------------------------------------------
  if (policy.architect_interface.default !== 'STANDARD_CHAT') {
    err('ARCHITECT_INTERFACE: default must be STANDARD_CHAT');
  }
  if (policy.architect_interface.work_mode !== 'ESCALATION_ONLY') {
    err('ARCHITECT_INTERFACE: work_mode must be ESCALATION_ONLY');
  }
  if (policy.architect_interface.memory_mode !== 'PROJECT_ONLY') {
    err('ARCHITECT_INTERFACE: memory_mode must be PROJECT_ONLY');
  }
  if (policy.operator_mode.default !== 'MOBILE_REMOTE') {
    err('OPERATOR_MODE: default must be MOBILE_REMOTE');
  }
  if (policy.stale_state_behavior.mode !== 'FAIL_CLOSED') {
    err('STALE_STATE_BEHAVIOR: mode must be FAIL_CLOSED');
  }

  // --- Source authority: two separate trees ---------------------------------------------
  for (const tree of ['runtime_facts', 'product_decisions']) {
    const t = policy.source_authority[tree];
    if (!Array.isArray(t) || t.length < 2) {
      err(`SOURCE_AUTHORITY: ${tree} must be a ranked list with at least two entries`);
    }
  }

  // --- Single current-state authority ---------------------------------------------------
  const scsa = policy.canonical_artifacts.single_current_state_authority;
  if (!scsa || scsa.artifact !== `${CONTROL_PLANE_DIR}/${FILES.state}`) {
    err('CURRENT_STATE_AUTHORITY: canonical_artifacts.single_current_state_authority must name CURRENT_STATE.yaml');
  }
  const ela = policy.canonical_artifacts.evidence_ledger_authority;
  if (!ela || !/never authoritative for current state/i.test(String(ela.rule))) {
    err('EVIDENCE_LEDGER_AUTHORITY: must state that EVIDENCE_LEDGER.md is never authoritative for current state');
  }

  // --- Repository boundary --------------------------------------------------------------
  if (policy.repository_boundaries.mixing_rule === undefined ||
      !/CANNOT be mixed/i.test(String(policy.repository_boundaries.mixing_rule))) {
    err('REPOSITORY_BOUNDARIES: mixing_rule must forbid mixing PREMVP and Ireland prompts');
  }
  if (policy.repository_boundaries.ireland.access_in_control_plane_phase_1_2 !== false) {
    err('REPOSITORY_BOUNDARIES: Ireland access must be false in Phase 1/2');
  }
  if (routing.repository_boundary_rules?.premvp_and_ireland_mixing !== 'FORBIDDEN') {
    err('ROUTING: repository_boundary_rules.premvp_and_ireland_mixing must be FORBIDDEN');
  }

  // --- Minimum agent policy -------------------------------------------------------------
  if (routing.minimum_agent_policy.all_agent_invocation !== false) {
    err('ROUTING: minimum_agent_policy.all_agent_invocation must be false — no all-agent policy is permitted');
  }

  // --- CURRENT_STATE: exactly two next value steps --------------------------------------
  if (!Array.isArray(state.next_two_value_steps) || state.next_two_value_steps.length !== 2) {
    err(`CURRENT_STATE: next_two_value_steps must contain exactly two entries (found ${
      Array.isArray(state.next_two_value_steps) ? state.next_two_value_steps.length : 'non-array'})`);
  }
  if (!state.main || !/^[0-9a-f]{40}$/.test(String(state.main.origin_main_sha || ''))) {
    err('CURRENT_STATE: main.origin_main_sha must be a full 40-character SHA');
  }
  if (!state.main?.proof || !EVIDENCE_CLASSES.includes(state.main.proof.evidence_class)) {
    err('CURRENT_STATE: main.proof.evidence_class must be a known evidence class');
  }

  // --- Capability matrix ----------------------------------------------------------------
  const targets = capability.execution_targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    err('CAPABILITY_MATRIX: execution_targets must be a non-empty array');
    return { ok: false, errors };
  }
  const targetIds = new Set(targets.map((t) => t.executor_id));
  for (const seeded of ['claude_code_cloud', 'local_codex_windows', 'ireland_local']) {
    if (!targetIds.has(seeded)) err(`CAPABILITY_MATRIX: missing seeded execution target ${seeded}`);
  }
  const capIndex = new Map();
  for (const t of targets) {
    for (const field of ['runtime', 'repository_scope', 'host_dependency', 'access_surfaces',
      'founder_terminal_required', 'capabilities', 'restrictions']) {
      if (!has(t, field)) err(`CAPABILITY_MATRIX: ${t.executor_id} missing ${field}`);
    }
    for (const c of t.capabilities || []) {
      if (!CAPABILITY_VERDICTS.includes(c.verdict)) {
        err(`CAPABILITY_MATRIX: ${t.executor_id}.${c.capability} has invalid verdict ${c.verdict}`);
      }
      if (!EVIDENCE_CLASSES.includes(c.evidence_class)) {
        err(`CAPABILITY_MATRIX: ${t.executor_id}.${c.capability} has invalid evidence_class ${c.evidence_class}`);
      }
      if (c.verdict === 'PROVEN' && c.evidence_class === 'NOT_PROVEN') {
        err(`CAPABILITY_MATRIX: ${t.executor_id}.${c.capability} claims PROVEN with evidence_class NOT_PROVEN`);
      }
      capIndex.set(`${t.executor_id}::${c.capability}`, c.verdict);
    }
  }

  // Codex Remote must remain an access surface to local_codex_windows, not an executor.
  const surfaces = capability.access_surface_policy?.surfaces || [];
  const remote = surfaces.find((s) => s.id === 'MOBILE_REMOTE');
  if (!remote || remote.reaches !== 'local_codex_windows') {
    err('ACCESS_SURFACE: MOBILE_REMOTE must be an access surface that reaches local_codex_windows');
  }
  for (const s of surfaces) {
    if (targetIds.has(s.id)) {
      err(`ACCESS_SURFACE: ${s.id} is registered both as an access surface and an execution target`);
    }
  }

  // --- Agent registry -------------------------------------------------------------------
  const agentIds = new Set();
  for (const e of registry.entries || []) {
    for (const k of REQUIRED_REGISTRY_ENTRY_KEYS) {
      if (!has(e, k)) err(`AGENT_REGISTRY: entry ${e.canonical_id || '<unnamed>'} missing ${k}`);
    }
    if (!REGISTRY_TYPES.includes(e.type)) err(`AGENT_REGISTRY: ${e.canonical_id} invalid type ${e.type}`);
    if (!REGISTRY_STATUS.includes(e.status)) err(`AGENT_REGISTRY: ${e.canonical_id} invalid status ${e.status}`);
    if (!REGISTRY_INVOCATION.includes(e.invocation)) err(`AGENT_REGISTRY: ${e.canonical_id} invalid invocation ${e.invocation}`);
    if (!REGISTRY_PORTABILITY.includes(e.portability)) err(`AGENT_REGISTRY: ${e.canonical_id} invalid portability ${e.portability}`);
    if (e.evidence_class !== null && !EVIDENCE_CLASSES.includes(e.evidence_class)) {
      err(`AGENT_REGISTRY: ${e.canonical_id} invalid evidence_class ${e.evidence_class}`);
    }
    agentIds.add(e.canonical_id);
  }
  for (const id of REQUIRED_REGISTRY_IDS) {
    if (!agentIds.has(id)) err(`AGENT_REGISTRY: required entry missing — ${id}`);
  }
  // Weather and Contur reviewers must be preserved and receipt-bearing.
  for (const id of ['codex.agent.weather_gate_reviewer.v0', 'codex.agent.contur_gate_reviewer']) {
    const e = (registry.entries || []).find((x) => x.canonical_id === id);
    if (e && e.receipt_required !== true) err(`AGENT_REGISTRY: ${id} must have receipt_required true`);
    if (e && e.invocation === 'AUTOMATIC') err(`AGENT_REGISTRY: ${id} must not be globally automatic`);
  }

  // --- Routing / pipelines --------------------------------------------------------------
  const riskIds = new Set((routing.risk_classes || []).map((r) => r.id));
  for (const rid of REQUIRED_RISK_CLASSES) {
    if (!riskIds.has(rid)) err(`ROUTING: missing required risk class ${rid}`);
  }
  const taskClassRisks = new Set((routing.task_classes || []).map((t) => t.default_risk_class));
  for (const trc of taskClassRisks) {
    if (!riskIds.has(trc)) err(`ROUTING: task class references unknown risk class ${trc}`);
  }

  for (const rc of routing.risk_classes || []) {
    const REQ = ['required_capabilities', 'eligible_execution_targets', 'required_agents',
      'optional_agents', 'permitted_repositories', 'forbidden_actions', 'sequential_stages',
      'parallel_stages', 'evidence_requirements', 'reviewer_receipt_requirements',
      'completion_requirements', 'stop_conditions', 'founder_action_budget',
      'mobile_compatible', 'fail_closed'];
    for (const k of REQ) {
      if (!has(rc, k)) err(`ROUTING: ${rc.id} missing ${k}`);
    }
    if (!Array.isArray(rc.evidence_requirements) || rc.evidence_requirements.length === 0) {
      err(`ROUTING: ${rc.id} must declare at least one evidence requirement`);
    }
    if (!Array.isArray(rc.stop_conditions) || rc.stop_conditions.length === 0) {
      err(`ROUTING: ${rc.id} must declare at least one stop condition`);
    }
    if (!Array.isArray(rc.completion_requirements) || rc.completion_requirements.length === 0) {
      err(`ROUTING: ${rc.id} must declare at least one completion requirement`);
    }

    // Execution target references must exist.
    for (const t of rc.eligible_execution_targets || []) {
      if (!targetIds.has(t)) err(`ROUTING: ${rc.id} references unknown execution target ${t}`);
    }
    // Agent references must exist.
    for (const a of [...(rc.required_agents || []), ...(rc.optional_agents || [])]) {
      if (!agentIds.has(a)) err(`ROUTING: ${rc.id} references unknown agent ${a}`);
    }
    // Required reviewers must be receipt-bearing and declared.
    for (const rr of rc.reviewer_receipt_requirements || []) {
      if (!agentIds.has(rr.agent_id)) {
        err(`ROUTING: ${rc.id} reviewer receipt references unknown agent ${rr.agent_id}`);
      }
      if (rr.mandatory === true && !(rc.required_agents || []).includes(rr.agent_id)) {
        err(`ROUTING: ${rc.id} declares mandatory receipt for ${rr.agent_id} but does not list it in required_agents`);
      }
    }
    // Required capabilities must be PROVEN on at least one eligible target.
    if (Array.isArray(rc.eligible_execution_targets) && rc.eligible_execution_targets.length > 0) {
      for (const cap of rc.required_capabilities || []) {
        const ok = rc.eligible_execution_targets.some(
          (t) => capIndex.get(`${t}::${cap}`) === 'PROVEN');
        if (!ok) {
          err(`ROUTING: ${rc.id} requires capability ${cap} but no eligible execution target holds verdict PROVEN for it`);
        }
      }
    }
    // Ireland must never be eligible while any of its capabilities are unproven.
    if ((rc.eligible_execution_targets || []).includes('ireland_local')) {
      const irl = targets.find((t) => t.executor_id === 'ireland_local');
      const allProven = (irl?.capabilities || []).every((c) => c.verdict === 'PROVEN');
      if (!allProven) {
        err(`ROUTING: ${rc.id} makes ireland_local eligible while its capabilities are not PROVEN`);
      }
    }
  }

  // --- R5 must fail closed --------------------------------------------------------------
  const r5 = (routing.risk_classes || []).find((r) => r.id === 'R5_CROSS_REPO_OR_LIVE_MONEY');
  if (r5) {
    if (r5.fail_closed !== true) err('ROUTING: R5_CROSS_REPO_OR_LIVE_MONEY must set fail_closed true');
    if (!r5.fail_closed_behavior || r5.fail_closed_behavior.default_verdict !== 'BLOCKED') {
      err('ROUTING: R5_CROSS_REPO_OR_LIVE_MONEY must declare fail_closed_behavior.default_verdict BLOCKED');
    }
    if ((r5.eligible_execution_targets || []).length !== 0) {
      err('ROUTING: R5_CROSS_REPO_OR_LIVE_MONEY must have no eligible execution targets');
    }
    if ((r5.permitted_repositories || []).length !== 0) {
      err('ROUTING: R5_CROSS_REPO_OR_LIVE_MONEY must have no permitted repositories');
    }
  }

  // --- Secret scan ----------------------------------------------------------------------
  // Scans the whole control-plane directory, not just the canonical map: the Founder-facing
  // setup guide is exactly where a pasted token would land.
  const dirEntries = fs.readdirSync(path.join(root, CONTROL_PLANE_DIR))
    .filter((f) => /\.(ya?ml|json|md)$/.test(f));
  for (const rel of dirEntries) {
    const text = fs.readFileSync(path.join(root, CONTROL_PLANE_DIR, rel), 'utf8');
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) err(`SECRET_LIKE_VALUE: ${CONTROL_PLANE_DIR}/${rel} matches ${p.name}`);
    }
  }

  // --- Untracked Local Windows prompt file must never be cited as authority --------------
  for (const [key, rel] of Object.entries(FILES)) {
    const text = raw[key];
    if (!text) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!line.includes(UNTRACKED_PROMPT_PATH)) return;
      const disclaimed = NON_AUTHORITY_MARKERS.some((m) => line.includes(m));
      if (!disclaimed) {
        err(`UNTRACKED_PROMPT_AUTHORITY: ${CONTROL_PLANE_DIR}/${rel}:${i + 1} references ${UNTRACKED_PROMPT_PATH} without disclaiming its authority`);
      }
    });
  }

  // --- Prompt protocol contract ---------------------------------------------------------
  const pp = raw.promptProtocol || '';
  const REQUIRED_PROMPT_SECTIONS = [
    'MODEL', 'MODEL LEVEL', 'SESSION MODE', 'SESSION REASON', 'EXECUTION ENVIRONMENT',
    'REPOSITORY / WORKTREE / CWD', 'BRANCH / TARGET REF / TARGET SHA', 'TOKEN / READ BUDGET',
    'VALUE TARGET', 'CURRENT ROADMAP PHASE', 'NEXT TWO VALUE STEPS', 'OPERATOR MODE',
    'TASK CLASS', 'RISK CLASS', 'REQUIRED CAPABILITIES', 'REQUIRED AGENTS / REVIEWERS',
    'PRECHECK', 'EXECUTION SCOPE', 'ALLOWED FILES', 'FORBIDDEN FILES', 'WRITE POLICY',
    'STOP CONDITIONS', 'EVIDENCE REQUIRED', 'COMPLETION ENVELOPE', 'FOUNDER ACTION',
  ];
  // Anchored to the numbered §2 table rows, not a loose substring match: a bare
  // `includes` would let "MODEL" be satisfied by "MODEL LEVEL", or by any prose mention.
  const promptTableRows = pp.split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
  const declaredSections = new Set(
    promptTableRows.map((l) => (l.split('|')[2] || '').replace(/`/g, '').trim()));
  for (const s of REQUIRED_PROMPT_SECTIONS) {
    if (!declaredSections.has(s)) {
      err(`PROMPT_PROTOCOL: missing mandatory section row for ${s} in the §2 contract table`);
    }
  }
  if (promptTableRows.length !== REQUIRED_PROMPT_SECTIONS.length) {
    err(`PROMPT_PROTOCOL: §2 table declares ${promptTableRows.length} sections, expected ${REQUIRED_PROMPT_SECTIONS.length}`);
  }
  if (!pp.includes('PROMPT_GATE_BLOCKED')) err('PROMPT_PROTOCOL: must define PROMPT_GATE_BLOCKED fail-closed behavior');

  // --- Completion schema ----------------------------------------------------------------
  const schema = parsed.completionSchema;
  const REQUIRED_SCHEMA_FIELDS = [
    'schema_version', 'completion_id', 'task_id', 'task_class', 'risk_class', 'executor',
    'environment', 'repository', 'branch', 'base_sha', 'result_sha', 'origin_main_sha',
    'worktree_before', 'worktree_after', 'files_changed', 'commands_run', 'tests',
    'required_reviewers', 'invoked_reviewers', 'reviewer_receipts', 'evidence',
    'capability_changes', 'state_delta_proposal', 'runtime_changed', 'deployment_changed',
    'database_changed', 'forbidden_actions_respected', 'verdict', 'blockers', 'founder_action',
  ];
  for (const f of REQUIRED_SCHEMA_FIELDS) {
    if (!(schema.required || []).includes(f)) err(`COMPLETION_SCHEMA: required field missing — ${f}`);
  }
  const receipt = schema.definitions?.reviewer_receipt;
  for (const f of ['agent_id', 'configured_model', 'reasoning_policy', 'independence_group',
    'reviewed_sha', 'verdict', 'evidence_refs']) {
    if (!(receipt?.required || []).includes(f)) err(`COMPLETION_SCHEMA: reviewer_receipt required field missing — ${f}`);
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const root = rootArg ? path.resolve(rootArg.slice('--root='.length)) : REPO_ROOT;
  const asJson = args.includes('--json');

  const { ok, errors } = validateControlPlane(root);

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, errors }, null, 2) + '\n');
  } else if (ok) {
    process.stdout.write('[control-plane] validate: PASS\n');
  } else {
    process.stderr.write(`[control-plane] validate: FAIL (${errors.length} violation(s))\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
