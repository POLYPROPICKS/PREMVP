/**
 * outcome-semantics.mjs
 *
 * ONE canonical place that decides whether a stated condition is a genuine terminal
 * boundary or something the executor still owns. Shared by the mission compiler and the
 * completion-envelope validator so a mission and its result cannot disagree about what
 * counts as a hard stop.
 *
 * Source of the hard-stop identifier list is the canonical taxonomy artifact
 * docs/ai-context/control-plane/EXECUTION_ESCALATION_TAXONOMY.json — never a second list.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TAXONOMY_REL = 'docs/ai-context/control-plane/EXECUTION_ESCALATION_TAXONOMY.json';

export const OUTCOME_CLASSES = Object.freeze([
  'TERMINAL_PASS',
  'HARD_BLOCKED',
  'RECOVERABLE_EXECUTION_FAILURE',
  'EXTERNAL_WAIT',
  'TRANSPORT_PAUSE',
]);

/** outcome_class → the only verdict it may carry. */
export const OUTCOME_CLASS_VERDICT = Object.freeze({
  TERMINAL_PASS: 'PASS',
  HARD_BLOCKED: 'BLOCKED',
  RECOVERABLE_EXECUTION_FAILURE: 'FAIL',
  EXTERNAL_WAIT: 'WAIT',
  TRANSPORT_PAUSE: 'WAIT',
});

/** Outcome classes that may never consume a Founder action. */
export const NON_TERMINAL_OUTCOME_CLASSES = Object.freeze([
  'RECOVERABLE_EXECUTION_FAILURE', 'EXTERNAL_WAIT', 'TRANSPORT_PAUSE',
]);

/**
 * Conditions that are canonically executor-owned. Declaring any of these as a hard
 * boundary — in a mission or in a completion envelope — is a contract defect.
 */
export const RECOVERABLE_CONDITIONS = Object.freeze([
  { id: 'DIRTY_FOUNDER_ROOT', class: 'EXECUTOR_OWNED_RECOVERY', match: /\bdirty\b[^.\n]{0,40}\b(root|worktree|checkout|working tree)\b|\b(root|worktree|working tree)\b[^.\n]{0,30}\bis dirty\b/i },
  // Both orders occur in practice: "missing dependencies" and "dependencies are missing".
  { id: 'MISSING_LOCKED_DEPENDENCIES', class: 'EXECUTOR_OWNED_RECOVERY', match: /\b(missing|absent|uninstalled|not installed)\b[^.\n]{0,40}\b(dependenc\w+|node_modules|lockfile|locked package)\b|\b(dependenc\w+|node_modules|lockfile)\b[^.\n]{0,30}\b(are |is )?(missing|absent|not installed|uninstalled)\b/i },
  { id: 'GENERATED_ARTIFACT_DRIFT', class: 'EXECUTOR_OWNED_RECOVERY', match: /\b(generated|snapshot|bundle)\b[^.\n]{0,30}\b(drift|stale|out of date|outdated)\b/i },
  { id: 'EXISTING_OR_DRAFT_PULL_REQUEST', class: 'EXPECTED_NON_BLOCKING', match: /\b(existing|draft|open|already open)\b[^.\n]{0,20}\bpull request\b|\bpull request already exists\b/i },
  { id: 'ORDINARY_CI_WAIT', class: 'RESUMABLE_WAIT', match: /\bCI\b[^.\n]{0,20}\b(pending|running|in progress|not finished)\b|\bwaiting (for|on) CI\b/i },
  { id: 'ORDINARY_DEPLOYMENT_WAIT', class: 'RESUMABLE_WAIT', match: /\bdeploy(ment)?\b[^.\n]{0,20}\b(pending|running|in progress|not finished)\b|\bwaiting (for|on) deploy/i },
  { id: 'REVIEWER_CORRECTION_OR_POLLING', class: 'RESUMABLE_WAIT', match: /\breviewer\b[^.\n]{0,30}\b(pending|polling|not yet responded|findings|correction)\b/i },
  { id: 'SAFE_STATE_RECONCILIATION', class: 'EXECUTOR_OWNED_RECOVERY', match: /\b(state refresh|state reconciliation|STATE_REFRESH_REQUIRED|stale state)\b/i },
  { id: 'IMPLEMENTATION_OR_TEST_CORRECTION', class: 'EXECUTOR_OWNED_RECOVERY', match: /\b(test|compiler|implementation)\b[^.\n]{0,30}\b(defect|failure|failed)\b[^.\n]{0,30}\b(fix|correct|retry)\b|\bfailed first (test|attempt)\b/i },
  { id: 'RESUMABLE_TRANSPORT_INTERRUPTION', class: 'TRANSPORT_RESUME', match: /\b(transport|connection|session)\b[^.\n]{0,20}\b(interrupt\w*|dropped|reset)\b/i },
]);

/**
 * Reasons that can NEVER by themselves make a result terminal. These are the exact
 * failure mode CP-HARDENING-01 exists to remove: an executor stopping mid-way and
 * handing the remainder back to the Founder as if it were a boundary.
 */
export const NON_TERMINAL_REASONS = Object.freeze([
  /\bimplementation\b[^.\n]{0,20}\b(unfinished|incomplete|not complete|not finished)\b/i,
  /\b(work|implementation) (is )?(still )?(unfinished|incomplete)\b/i,
  /\b(substantial|significant|more|further|additional) work (remains|is required|is needed)\b/i,
  /\bmore tests? (are |is )?(required|needed)\b/i,
  /\bcontinue (the )?implementation\b/i,
  /\bfirst implementation attempt failed\b/i,
  /\bnot yet implemented\b[^.\n]{0,30}\bblock/i,
]);

/** Execution-slice exhaustion. Transport state, never a business or authority block. */
export const SESSION_END_REASONS = Object.freeze([
  /\bsession\b[^.\n]{0,25}\b(time )?(ended|expired|exhausted|ran out|limit reached)\b/i,
  /\b(execution|runtime) slice\b[^.\n]{0,20}\b(ended|exhausted|expired)\b/i,
  /\b(ran out of|out of) (session )?(time|budget|context)\b/i,
  /\bcontext (window )?exhausted\b/i,
  /\bapproaching (the )?session (time )?limit\b/i,
]);

/** Lifecycle mechanics owned by registered commands; restating them is duplication. */
export const REGISTERED_LIFECYCLE_PROSE = /\b(dirty.worktree|git fetch|create pull request|merge pull request|poll.*deploy|CI polling|state refresh|reviewer polling|npm ci|git worktree add)\b/i;

export function loadHardStopIds(root, taxonomyRel = TAXONOMY_REL) {
  const taxonomy = JSON.parse(fs.readFileSync(path.join(root, taxonomyRel), 'utf8'));
  return taxonomy?.classes?.HARD_SAFETY_STOP?.identifiers || [];
}

/** Returns the recoverable condition a free-text reason matches, or null. */
export function matchRecoverableCondition(text) {
  const s = String(text || '');
  return RECOVERABLE_CONDITIONS.find((c) => c.match.test(s)) || null;
}

export function matchesNonTerminalReason(text) {
  const s = String(text || '');
  return NON_TERMINAL_REASONS.some((re) => re.test(s));
}

export function matchesSessionEnd(text) {
  const s = String(text || '');
  return SESSION_END_REASONS.some((re) => re.test(s));
}

/**
 * Central rule set applied to any free-text justification for a terminal block.
 * Returns an array of violation identifiers (empty means the text is admissible).
 */
export function blockJustificationViolations(text) {
  const violations = [];
  if (matchesNonTerminalReason(text)) violations.push('INCOMPLETE_IS_NOT_TERMINAL');
  if (matchesSessionEnd(text)) violations.push('SESSION_END_IS_NOT_BUSINESS_BLOCK');
  const recoverable = matchRecoverableCondition(text);
  if (recoverable) violations.push(`RECOVERABLE_CONDITION_RETURNED_AS_HARD_BLOCK: ${recoverable.id}`);
  return violations;
}

/** start <= 1, intermediate = 0, terminal_result = 1. */
export function operatorBudgetViolations(budget) {
  const errors = [];
  if (budget === null || typeof budget !== 'object') return ['OPERATOR_BUDGET_MISSING'];
  const n = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
  const start = n(budget.start);
  const intermediate = n(budget.intermediate);
  const terminal = n(budget.terminal_result);
  if (start === null || start < 0 || start > 1) errors.push(`OPERATOR_BUDGET_VIOLATION: start must be 0 or 1 (got ${budget.start})`);
  if (intermediate !== 0) errors.push(`OPERATOR_BUDGET_VIOLATION: intermediate must be 0 (got ${budget.intermediate})`);
  if (terminal !== 1) errors.push(`OPERATOR_BUDGET_VIOLATION: terminal_result must be 1 (got ${budget.terminal_result})`);
  return errors;
}
