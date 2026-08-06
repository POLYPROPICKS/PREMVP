/** Shared, executor-neutral classification for PREMVP task entry. */
export const COMMAND_ID = 'premvp.command.execution_precheck.v1';
export const TAXONOMY = Object.freeze({
  EXPECTED_NON_BLOCKING: 'EXPECTED_NON_BLOCKING',
  EXECUTOR_OWNED_RECOVERY: 'EXECUTOR_OWNED_RECOVERY',
  RESUMABLE_WAIT: 'RESUMABLE_WAIT',
  HARD_SAFETY_STOP: 'HARD_SAFETY_STOP',
});

export const HARD_STOP_IDS = Object.freeze([
  'CONTROL_PLANE_WRONG_REPOSITORY', 'REPOSITORY_BOUNDARY_MIXED',
  'R5_BOUNDARY_REACHED', 'IRELAND_BOUNDARY_REACHED', 'REQUIRED_SECRET',
  'INVALID_MAIN_ANCESTRY', 'CANONICAL_SEMANTIC_CONTRADICTION',
  'SELECTED_EXECUTOR_CAPABILITY_ACTUALLY_UNAVAILABLE', 'SEMANTIC_AUTHORITY_CONFLICT',
  'DATABASE_MUTATION_BOUNDARY_REACHED', 'REQUIRED_REVIEWER_TERMINAL_FAILURE',
  'REPOSITORY_GIT_METADATA_CORRUPT', 'ALLOWED_WRITE_PATH_OVERLAP',
]);

function classification(kind, id, detail) {
  return { classification: kind, id, detail, founder_action: 'none' };
}

/**
 * Pure classifier. Callers supply inventory/live evidence; it never reads or mutates the
 * Founder root. This makes equal input deterministic and testable on Codex and Cloud.
 */
export function classifyExecutionPrecheck(input) {
  const errors = [];
  const one = (v) => typeof v === 'string' && v.length > 0;
  if (!one(input?.selected_executor)) errors.push('MISSING_SELECTED_EXECUTOR');
  if (!one(input?.repository)) errors.push('MISSING_REPOSITORY');
  if (!one(input?.operation_mode) || !['READ_ONLY', 'WRITE'].includes(input.operation_mode)) errors.push('INVALID_OPERATION_MODE');
  if (!one(input?.authority_sha)) errors.push('MISSING_AUTHORITY_SHA');
  if (errors.length) return hardStop('CANONICAL_SEMANTIC_CONTRADICTION', errors.join(', '));
  if (input.repository !== 'POLYPROPICKS/PREMVP') return hardStop('CONTROL_PLANE_WRONG_REPOSITORY', input.repository);
  if (input.repository_boundary && input.repository_boundary !== 'PREMVP') return hardStop('REPOSITORY_BOUNDARY_MIXED', input.repository_boundary);
  const capabilities = input.capabilities || [];
  const unavailable = capabilities.find((c) => c.required && c.verdict === 'NOT_AVAILABLE');
  if (unavailable) return hardStop('SELECTED_EXECUTOR_CAPABILITY_ACTUALLY_UNAVAILABLE', unavailable.capability);
  const paths = input.worktree_inventory || [];
  const preservation = new Set(input.declared_preservation_only_paths || []);
  const allowed = new Set(input.allowed_files || []);
  const path_classifications = paths.map((p) => {
    if (preservation.has(p.path)) return classification(TAXONOMY.EXPECTED_NON_BLOCKING, 'PRESERVATION_ONLY_PATH', p.path);
    if (input.operation_mode === 'WRITE' && p.status !== 'untracked' && allowed.has(p.path)) return hardStop('ALLOWED_WRITE_PATH_OVERLAP', p.path);
    return classification(TAXONOMY.EXECUTOR_OWNED_RECOVERY, 'ROOT_DIFFERENCE_ISOLATED', p.path);
  });
  const state = input.state_freshness || {};
  const recoveries = [];
  if (state.baseline_ancestor === true && state.production_equals_main === true && state.requires_refresh === true) {
    recoveries.push(classification(TAXONOMY.EXECUTOR_OWNED_RECOVERY, 'SAFE_STATE_REFRESH', 'baseline ancestry verified'));
  } else if (state.baseline_ancestor === false) return hardStop('INVALID_MAIN_ANCESTRY', 'state baseline is not an ancestor');
  if (input.operation_mode === 'WRITE') recoveries.push(classification(TAXONOMY.EXECUTOR_OWNED_RECOVERY, 'DEDICATED_WORKTREE', 'write tasks use an isolated clean worktree'));
  const waits = (input.wait_conditions || []).map((w) => classification(TAXONOMY.RESUMABLE_WAIT, w.id || 'EXTERNAL_PENDING', w.detail || ''));
  return {
    command_id: COMMAND_ID, verdict: waits.length ? 'WAIT' : 'CONTINUE', founder_action: 'none',
    repository_identity: input.repository, live_origin_main: input.live_origin_main || input.authority_sha,
    canonical_cache_key: input.authority_sha, worktree_inventory: paths, path_classifications,
    state_freshness_classification: state.requires_refresh ? 'EXECUTOR_OWNED_STATE_REFRESH' : 'FRESH',
    capability_classifications: capabilities, recoveries_performed: recoveries,
    wait_conditions: waits, hard_stops: [], safe_cwd: input.safe_cwd || null,
    evidence: [{ name: 'selected_executor', value: input.selected_executor }, { name: 'operation_mode', value: input.operation_mode }],
  };
}

function hardStop(id, detail) {
  return { command_id: COMMAND_ID, verdict: 'BLOCKED', founder_action: 'FOUNDER_DECISION_REQUIRED', hard_stops: [{ classification: TAXONOMY.HARD_SAFETY_STOP, id, detail }], recoveries_performed: [], wait_conditions: [] };
}
