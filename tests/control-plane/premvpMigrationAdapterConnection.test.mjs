/**
 * premvpMigrationAdapterConnection.test.mjs
 *
 * Focused tests for the registered PREMVP application-migration adapter's project-context
 * fallback (scripts/control-plane/lib/premvp-migration-adapter-connection.mjs). Verifies:
 * - a linked worktree is always tried first;
 * - an absent-link failure falls back to non-interactive --project-ref/--password from env;
 * - any other db-push failure is never swallowed by the fallback;
 * - missing env fails closed instead of guessing;
 * - a fallback failure never leaks the password/token value.
 *
 * Run: node --test tests/control-plane/premvpMigrationAdapterConnection.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isNotLinkedError,
  resolveProjectContextArgs,
  redactSecrets,
  runDbPushWithFallback,
} from '../../scripts/control-plane/lib/premvp-migration-adapter-connection.mjs';

test('isNotLinkedError recognizes the known not-linked failure signatures', () => {
  assert.equal(isNotLinkedError({ stderr: 'LegacyProjectNotLinkedError: no linked project' }), true);
  assert.equal(isNotLinkedError({ message: 'Cannot find project ref. Have you run supabase link?' }), true);
  assert.equal(isNotLinkedError({ stderr: 'permission denied' }), false);
});

test('resolveProjectContextArgs fails closed when env is incomplete', () => {
  assert.throws(() => resolveProjectContextArgs({}), /SUPABASE_PROJECT_CONTEXT_ENV_MISSING/);
  assert.throws(() => resolveProjectContextArgs({ SUPABASE_PROJECT_REF: 'ref-only' }), /SUPABASE_PROJECT_CONTEXT_ENV_MISSING/);
});

test('resolveProjectContextArgs builds the documented non-interactive db-push flags', () => {
  const args = resolveProjectContextArgs({ SUPABASE_PROJECT_REF: 'abc123', SUPABASE_DB_PASSWORD: 'secret-pw' });
  assert.deepEqual(args, ['--project-ref', 'abc123', '--password', 'secret-pw']);
});

test('redactSecrets removes every secret occurrence and leaves other text intact', () => {
  const out = redactSecrets('db push --password secret-pw failed for ref abc123', ['secret-pw']);
  assert.equal(out.includes('secret-pw'), false);
  assert.equal(out.includes('abc123'), true);
});

test('runDbPushWithFallback returns the linked-project result without falling back when linked succeeds', () => {
  const calls = [];
  const run = (cliArgs) => { calls.push(cliArgs); return 'linked-output'; };
  const result = runDbPushWithFallback({ run, extraArgs: ['--skip-vault', '--dry-run', '--yes'], env: {} });
  assert.equal(result, 'linked-output');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['db', 'push', '--linked', '--skip-vault', '--dry-run', '--yes']);
});

test('runDbPushWithFallback establishes project context non-interactively when not linked', () => {
  const calls = [];
  const run = (cliArgs) => {
    calls.push(cliArgs);
    if (cliArgs.includes('--linked')) throw { stderr: 'LegacyProjectNotLinkedError' };
    return 'fallback-output';
  };
  const env = { SUPABASE_PROJECT_REF: 'abc123', SUPABASE_DB_PASSWORD: 'secret-pw' };
  const result = runDbPushWithFallback({ run, extraArgs: ['--skip-vault', '--dry-run', '--yes'], env });
  assert.equal(result, 'fallback-output');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['db', 'push', '--project-ref', 'abc123', '--password', 'secret-pw', '--skip-vault', '--dry-run', '--yes']);
});

test('runDbPushWithFallback never falls back on an unrelated db-push failure', () => {
  const run = () => { const error = new Error('permission denied for schema public'); error.stderr = 'permission denied for schema public'; throw error; };
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env: { SUPABASE_PROJECT_REF: 'abc123', SUPABASE_DB_PASSWORD: 'secret-pw' } }),
    /permission denied/,
  );
});

test('runDbPushWithFallback fails closed when linkage is absent and env is incomplete', () => {
  const run = (cliArgs) => { throw { stderr: 'LegacyProjectNotLinkedError' }; };
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env: {} }),
    /SUPABASE_PROJECT_CONTEXT_ENV_MISSING/,
  );
});

test('runDbPushWithFallback never leaks the password/token when the fallback itself fails', () => {
  const env = { SUPABASE_PROJECT_REF: 'abc123', SUPABASE_DB_PASSWORD: 'super-secret-pw', SUPABASE_ACCESS_TOKEN: 'sbp_token_value' };
  const run = (cliArgs) => {
    if (cliArgs.includes('--linked')) throw { stderr: 'LegacyProjectNotLinkedError' };
    throw { stderr: `auth failed: --password super-secret-pw token sbp_token_value rejected` };
  };
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env }),
    (error) => {
      assert.equal(error.message.includes('super-secret-pw'), false);
      assert.equal(error.message.includes('sbp_token_value'), false);
      assert.match(error.message, /SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED/);
      return true;
    },
  );
});
