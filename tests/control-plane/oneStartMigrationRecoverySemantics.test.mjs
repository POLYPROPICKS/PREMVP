/**
 * oneStartMigrationRecoverySemantics.test.mjs
 *
 * Regression for RESTORE_ONE_START_PREMVP_MIGRATION_EXECUTION_V1: the failure classes
 * proven recoverable today must NOT be representable as terminal hard stops by the shared
 * outcome-semantics validator. A recoverable first failure must not generate a
 * Founder-confirmation request.
 *
 * Run: node --test tests/control-plane/oneStartMigrationRecoverySemantics.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchRecoverableCondition,
  blockJustificationViolations,
} from '../../scripts/control-plane/lib/outcome-semantics.mjs';

const RECOVERABLE_JUSTIFICATIONS = {
  WINDOWS_PERSISTENT_ENV_BRIDGE_AVAILABLE:
    'SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD are missing from the process env but are present in the persistent user environment and were bridged into the child process.',
  NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY:
    'Preflight failed with NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY: preview_track_record_shown_history_flow.sql.',
  LOCAL_PLATFORM_INVOCATION_CORRECTION:
    'The npx invocation on Windows used the wrong binary and needs a ComSpec/npx.cmd correction.',
};

for (const [id, text] of Object.entries(RECOVERABLE_JUSTIFICATIONS)) {
  test(`"${id}" is classified executor-owned, not a hard stop`, () => {
    const matched = matchRecoverableCondition(text);
    assert.ok(matched, `expected a recoverable-condition match for ${id}`);
    assert.equal(matched.class, 'EXECUTOR_OWNED_RECOVERY');
    const violations = blockJustificationViolations(text);
    assert.ok(
      violations.some((v) => v.startsWith('RECOVERABLE_CONDITION_RETURNED_AS_HARD_BLOCK')),
      `a terminal block justified by ${id} must be rejected`,
    );
  });
}

test('a genuinely absent secret is still eligible to be a REQUIRED_SECRET hard stop', () => {
  const text = 'SUPABASE_DB_PASSWORD is not set in the process env and is not present in the persistent user environment either.';
  // The "still missing after bridge" phrasing must NOT be swallowed as recoverable.
  assert.equal(matchRecoverableCondition(text), null);
});
