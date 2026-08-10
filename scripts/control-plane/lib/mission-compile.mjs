/**
 * mission-compile.mjs
 *
 * Semantic compiler for the canonical Mission Contract
 * (docs/ai-context/control-plane/MISSION_CONTRACT.schema.json).
 *
 * The Architect states WHAT / WHY / ACCEPTANCE. This compiler machine-enforces the
 * invariants that used to live as prose in a 25-section prompt template, and refuses to
 * emit an executor prompt when any of them is violated.
 *
 * Dependency-free by design: the repository carries no JSON Schema engine and none is
 * added here.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  REGISTERED_LIFECYCLE_PROSE,
  blockJustificationViolations,
  operatorBudgetViolations,
} from './outcome-semantics.mjs';

export const COMMAND_ID = 'premvp.command.mission_compile.v1';

/** §4 mission core — the only always-required sections. */
export const MISSION_CORE = Object.freeze([
  'mission', 'business_result', 'repository', 'scope', 'hard_boundaries', 'acceptance',
]);

/** Conditional sections, emitted only when directly relevant. */
export const MISSION_MODULES = Object.freeze([
  'FOUNDER AUTHORIZATION', 'RUNTIME EVIDENCE', 'DATABASE', 'REVIEWER', 'RELEASE',
  'PRODUCTION OBSERVATION', 'LIVE MONEY',
]);

export const REPOSITORY_BOUNDARIES = Object.freeze(['PREMVP', 'IRELAND']);

/** Capabilities that only ever belong to a foreign repository boundary. */
const FOREIGN_BOUNDARY_CAPABILITIES = Object.freeze({
  PREMVP: [/^IRELAND_/, /^REMOTE_IDENTITY$/],
  IRELAND: [/^PREMVP_/],
});

/** Capability that may be required ONLY by a raw database mutation. */
const RAW_DB_MUTATION_CAPABILITIES = Object.freeze(['DATABASE_WRITE', 'SQL_MUTATION']);

/** Which registry portability classes a given executor can actually invoke. */
const EXECUTOR_PORTABILITY = Object.freeze({
  claude_code_cloud: ['PORTABLE', 'CLAUDE_ONLY'],
  local_codex_windows: ['PORTABLE', 'CODEX_ONLY'],
  ireland_local: ['PORTABLE'],
});

export function loadRegistry(root) {
  return JSON.parse(fs.readFileSync(
    path.join(root, 'docs/ai-context/control-plane/AGENT_REGISTRY.yaml'), 'utf8'));
}

function nonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function missionProse(mission) {
  // Only free-text the Architect authors — never structured ids, which legitimately
  // name registered commands (that is the opposite of duplicating their mechanics).
  return [
    mission?.mission, mission?.business_result,
    ...(mission?.scope?.allowed_paths || []), ...(mission?.scope?.out_of_scope || []),
    ...(mission?.hard_boundaries || []),
    ...(mission?.acceptance || []).map((a) => a?.statement),
    ...Object.values(mission?.modules || {}),
    ...(mission?.direct_actions || []).map((a) => a?.action),
  ].filter(nonEmptyString).join('\n');
}

/**
 * @param {object} mission  Mission Contract instance.
 * @param {object} ctx      { root, registry }
 * @param {object} options  { phase: 'START_GATE' | 'TERMINAL' }
 */
export function compileMission(mission, ctx = {}, options = {}) {
  const phase = options.phase === 'TERMINAL' ? 'TERMINAL' : 'START_GATE';
  const root = ctx.root;
  const registry = ctx.registry || (root ? loadRegistry(root) : { entries: [] });
  const errors = [];
  const err = (m) => errors.push(m);

  if (mission === null || typeof mission !== 'object' || Array.isArray(mission)) {
    return { ok: false, errors: ['MISSION_NOT_AN_OBJECT'], command_id: COMMAND_ID, phase };
  }

  // --- Mission core -----------------------------------------------------------------
  if (!nonEmptyString(mission.mission_id)) err('MISSING_MISSION_CORE: mission_id');
  for (const key of MISSION_CORE) {
    const v = mission[key];
    const present = Array.isArray(v) ? v.length > 0
      : (v !== null && typeof v === 'object') ? Object.keys(v).length > 0
        : nonEmptyString(v);
    if (!present) err(`MISSING_MISSION_CORE: ${key}`);
  }
  if (!Array.isArray(mission.scope?.allowed_paths) || mission.scope.allowed_paths.length === 0) {
    err('MISSING_MISSION_CORE: scope.allowed_paths');
  }

  // --- D. ONE REPOSITORY BOUNDARY ---------------------------------------------------
  const boundary = mission.repository_boundary;
  if (!REPOSITORY_BOUNDARIES.includes(boundary)) {
    err(`INVALID_REPOSITORY_BOUNDARY: ${boundary}`);
  }
  const directActions = Array.isArray(mission.direct_actions) ? mission.direct_actions : [];
  const actionById = new Map();
  for (const a of directActions) {
    if (!nonEmptyString(a?.id)) { err('DIRECT_ACTION_MISSING_ID'); continue; }
    if (actionById.has(a.id)) err(`DIRECT_ACTION_DUPLICATE_ID: ${a.id}`);
    actionById.set(a.id, a);
    if (a.repository_boundary !== boundary) {
      err(`REPOSITORY_BOUNDARY_MIXED: direct action ${a.id} targets ${a.repository_boundary}, mission boundary is ${boundary}`);
    }
  }

  // --- A. CAPABILITY_BY_DIRECT_ACTION_ONLY ------------------------------------------
  const requiredCapabilities = Array.isArray(mission.required_capabilities)
    ? mission.required_capabilities : [];
  const resolved = [];
  for (const entry of requiredCapabilities) {
    const cap = entry?.capability;
    if (!nonEmptyString(cap)) { err('REQUIRED_CAPABILITY_MISSING_NAME'); continue; }
    if (!nonEmptyString(entry?.direct_action_ref)) {
      err(`CAPABILITY_WITHOUT_DIRECT_ACTION: ${cap}`);
      continue;
    }
    const action = actionById.get(entry.direct_action_ref);
    if (!action) {
      err(`CAPABILITY_DIRECT_ACTION_UNKNOWN: ${cap} -> ${entry.direct_action_ref}`);
      continue;
    }
    if (!(action.requires_capabilities || []).includes(cap)) {
      err(`CAPABILITY_NOT_REQUIRED_BY_DIRECT_ACTION: ${cap} is not declared by direct action ${action.id}`);
      continue;
    }
    resolved.push({ capability: cap, direct_action_ref: action.id });

    // D (continued). Foreign-repository capability inside a single-boundary mission.
    for (const re of FOREIGN_BOUNDARY_CAPABILITIES[boundary] || []) {
      if (re.test(cap)) {
        err(`FOREIGN_REPOSITORY_CAPABILITY_IN_SINGLE_BOUNDARY_MISSION: ${cap} is not a ${boundary} capability`);
      }
    }
  }

  // --- B. RISK_NOT_CAPABILITY -------------------------------------------------------
  // Capabilities are derived ONLY from direct_actions. Risk class controls authority,
  // safety and reviewer requirement. Any attempt to source a capability from risk —
  // including the historical "R5 means require everything" shortcut — fails here.
  if (mission.derive_capabilities_from_risk === true) {
    err('RISK_INJECTED_CAPABILITY: capabilities may not be derived from risk_class');
  }
  for (const entry of requiredCapabilities) {
    if (entry?.capability_source !== undefined &&
        String(entry.capability_source).toUpperCase() === 'RISK_CLASS') {
      err(`RISK_INJECTED_CAPABILITY: ${entry.capability} claims risk_class as its source`);
    }
  }

  // --- C. APPLICATION_PERSISTENCE_NOT_RAW_DB_MUTATION -------------------------------
  for (const a of directActions) {
    const persistence = a?.persistence || 'NONE';
    const caps = a?.requires_capabilities || [];
    const rawCaps = caps.filter((c) => RAW_DB_MUTATION_CAPABILITIES.includes(c));
    if (rawCaps.length > 0 && persistence !== 'RAW_DATABASE_MUTATION') {
      err(`APPLICATION_PERSISTENCE_NOT_RAW_DB_MUTATION: direct action ${a.id} declares persistence ${persistence} but requires ${rawCaps.join(', ')}`);
    }
  }

  // --- E. REGISTERED COMMAND VALIDITY -----------------------------------------------
  // All three must hold: registration, executable binding, executor invocability.
  const commands = Array.isArray(mission.commands) ? mission.commands : [];
  const byId = new Map((registry.entries || [])
    .filter((e) => e.type === 'COMMAND').map((e) => [e.canonical_id, e]));
  const executor = mission.executor || null;
  for (const id of commands) {
    const entry = byId.get(id);
    if (!entry) { err(`COMMAND_NOT_REGISTERED: ${id}`); continue; }
    const bound = nonEmptyString(entry.implementation_path) && entry.status === 'PROVEN_PRESENT' &&
      (!root || fs.existsSync(path.join(root, entry.implementation_path)));
    if (!bound) { err(`COMMAND_NOT_EXECUTABLE: ${id} -> ${entry.implementation_path || 'none'} (${entry.status})`); continue; }
    if (executor) {
      const allowed = EXECUTOR_PORTABILITY[executor] || [];
      if (!allowed.includes(entry.portability)) {
        err(`COMMAND_NOT_INVOKABLE_BY_EXECUTOR: ${id} is ${entry.portability}, executor ${executor} cannot invoke it`);
      }
    }
  }
  if (executor !== null && !Object.prototype.hasOwnProperty.call(EXECUTOR_PORTABILITY, executor)) {
    err(`UNKNOWN_EXECUTOR: ${executor}`);
  }
  if (executor === 'default' || executor === 'fallback') err('DEFAULT_OR_FALLBACK_EXECUTOR');

  // --- F/G/H. RECOVERY_BEFORE_BLOCK, INCOMPLETE, SESSION END ------------------------
  for (const b of mission.hard_boundaries || []) {
    for (const v of blockJustificationViolations(b)) {
      err(`HARD_BOUNDARY_NOT_TERMINAL: ${v} — "${b}"`);
    }
  }

  // --- I. FOUNDER INTERMEDIATE ACTION BUDGET ----------------------------------------
  for (const v of operatorBudgetViolations(mission.operator_budget)) err(v);

  // --- J. ACCEPTANCE AFTER EXECUTION ------------------------------------------------
  const acceptance = Array.isArray(mission.acceptance) ? mission.acceptance : [];
  for (const c of acceptance) {
    if (!nonEmptyString(c?.id) || !nonEmptyString(c?.statement)) { err('ACCEPTANCE_ENTRY_INCOMPLETE'); continue; }
    if (!['START_GATE', 'TERMINAL'].includes(c.evaluated_at)) {
      err(`ACCEPTANCE_PHASE_INVALID: ${c.id} -> ${c.evaluated_at}`);
      continue;
    }
    if (phase === 'START_GATE') {
      // A TERMINAL criterion that is "not yet implemented" or "not yet measured" at task
      // start is exactly what is expected. It is NEVER a failed start gate.
      if (c.evaluated_at === 'START_GATE' && c.met === false) {
        err(`START_GATE_ACCEPTANCE_NOT_MET: ${c.id}`);
      }
    } else if (c.met !== true) {
      err(`TERMINAL_ACCEPTANCE_NOT_MET: ${c.id}`);
    }
  }
  if (acceptance.length > 0 && !acceptance.some((c) => c?.evaluated_at === 'TERMINAL')) {
    err('ACCEPTANCE_HAS_NO_TERMINAL_CRITERION');
  }

  // --- K. PROMPT COMPLEXITY ---------------------------------------------------------
  const prose = missionProse(mission);
  if (REGISTERED_LIFECYCLE_PROSE.test(prose)) {
    err('MISSION_MANUAL_ORCHESTRATION_DUPLICATION: registered commands own precheck/worktree/dependency/PR/merge/deployment/reviewer/reconciliation mechanics');
  }

  // --- Conditional modules ----------------------------------------------------------
  const emitted = Object.entries(mission.modules || {})
    .filter(([, v]) => nonEmptyString(v)).map(([k]) => k);
  for (const k of emitted) if (!MISSION_MODULES.includes(k)) err(`UNKNOWN_MODULE: ${k}`);

  if (errors.length) {
    return { ok: false, errors, command_id: COMMAND_ID, phase, mission_id: mission.mission_id || null };
  }

  return {
    ok: true,
    errors: [],
    command_id: COMMAND_ID,
    phase,
    mission_id: mission.mission_id,
    repository_boundary: boundary,
    executor,
    resolved_capabilities: resolved,
    emitted_modules: emitted,
    omitted_modules: MISSION_MODULES.filter((m) => !emitted.includes(m)),
    registered_commands_referenced: commands,
    prompt: renderMission(mission, emitted),
  };
}

function heading(name, value) {
  const body = Array.isArray(value) ? value.map((v) => `- ${v}`).join('\n') : value;
  return `## ${name}\n${body}`;
}

export function renderMission(mission, emitted) {
  const sections = [
    heading('MISSION', mission.mission),
    heading('BUSINESS RESULT', mission.business_result),
    heading('REPOSITORY', `${mission.repository} (boundary: ${mission.repository_boundary})`),
    heading('SCOPE', [
      ...mission.scope.allowed_paths.map((p) => `allowed: ${p}`),
      ...(mission.scope.out_of_scope || []).map((p) => `out of scope: ${p}`),
    ]),
    heading('HARD BOUNDARIES', mission.hard_boundaries),
    heading('ACCEPTANCE', mission.acceptance.map((c) => `[${c.evaluated_at}] ${c.id}: ${c.statement}`)),
  ];
  for (const k of emitted) sections.push(heading(k, mission.modules[k]));
  return [
    `# Mission Contract — ${mission.mission_id}`,
    '',
    sections.join('\n\n'),
    '',
    'Registered commands own generic lifecycle mechanics (precheck, worktree, dependency bootstrap, PR, merge, deployment, reviewer, reconciliation, resume). Recoverable, WAIT and transport-pause outcomes always set founder_action: none. Return exactly one terminal result.',
  ].join('\n');
}
