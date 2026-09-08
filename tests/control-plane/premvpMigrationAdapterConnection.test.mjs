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
  extractCausalFailure,
  CAUSE_NOT_EXTRACTABLE,
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

// --- PRESERVE_CAUSAL_SUPABASE_ADAPTER_FAILURE_V1 regressions ---------------------------
// A fallback db-push failure must carry sanitized causal evidence from stdout, stderr and
// the process error, never a bare progress line, and never a secret.

const notLinked = () => ({ stderr: 'LegacyProjectNotLinkedError' });
const CAUSAL_ENV = { SUPABASE_PROJECT_REF: 'abc123', SUPABASE_DB_PASSWORD: 'super-secret-pw', SUPABASE_ACCESS_TOKEN: 'sbp_token_value' };
const fallbackFailure = (failure) => (cliArgs) => {
  if (cliArgs.includes('--linked')) throw notLinked();
  throw failure;
};

test('extractCausalFailure keeps a concrete stdout cause when stderr carries only progress', () => {
  const cause = extractCausalFailure({
    stdout: 'Connecting to remote database...\ndial tcp 1.2.3.4:5432: i/o timeout',
    stderr: 'Connecting to remote database...',
  });
  assert.match(cause, /i\/o timeout/);
  assert.equal(cause.includes('Connecting to remote database'), false);
});

test('extractCausalFailure keeps the concrete stderr cause alongside progress noise', () => {
  const cause = extractCausalFailure({
    stderr: 'Connecting to remote database...\nfailed SASL auth: password authentication failed for user "postgres"',
  });
  assert.match(cause, /password authentication failed/);
  assert.equal(cause.includes('Connecting to remote database'), false);
});

test('extractCausalFailure returns CAUSE_NOT_EXTRACTABLE when only progress text exists', () => {
  assert.equal(extractCausalFailure({ stdout: 'Connecting to remote database...', stderr: '   \n...' }), CAUSE_NOT_EXTRACTABLE);
  assert.equal(extractCausalFailure({}), CAUSE_NOT_EXTRACTABLE);
});

test('extractCausalFailure preserves each concrete cause family it is meant to surface', () => {
  const families = [
    'dial tcp: connection refused',
    'getaddrinfo ENOTFOUND db.abc123.supabase.co',
    'context deadline exceeded: timeout',
    'unauthorized: invalid access token',
    'project not found for ref abc123',
    'spawn npx.cmd ENOENT',
  ];
  for (const line of families) {
    assert.equal(extractCausalFailure({ stderr: `Connecting to remote database...\n${line}` }), line);
  }
});

test('extractCausalFailure bounds the excerpt instead of returning the whole log', () => {
  const noisy = Array.from({ length: 40 }, (_, i) => `error line ${i}`).join('\n');
  const cause = extractCausalFailure({ stdout: noisy });
  assert.equal(cause.split(' | ').length, 3);
  const long = extractCausalFailure({ stderr: `fatal: ${'x'.repeat(500)}` });
  assert.ok(long.length < 260);
  assert.match(long, /\.\.\.$/);
});

test('extractCausalFailure redacts secrets found in either stream', () => {
  const cause = extractCausalFailure(
    {
      stdout: 'auth failed with --password super-secret-pw',
      stderr: 'connection string postgresql://postgres:super-secret-pw@db.abc123.supabase.co:5432/postgres rejected; token sbp_token_value',
    },
    [CAUSAL_ENV.SUPABASE_DB_PASSWORD, CAUSAL_ENV.SUPABASE_ACCESS_TOKEN],
  );
  assert.equal(cause.includes('super-secret-pw'), false);
  assert.equal(cause.includes('sbp_token_value'), false);
  assert.equal(cause.includes('db.abc123.supabase.co:5432/postgres'), false);
  assert.match(cause, /REDACTED/);
});

test('runDbPushWithFallback surfaces the stdout cause instead of the progress line', () => {
  const run = fallbackFailure({
    stdout: 'Connecting to remote database...\ndial tcp 1.2.3.4:5432: i/o timeout',
    stderr: 'Connecting to remote database...',
  });
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env: CAUSAL_ENV }),
    (error) => {
      assert.match(error.message, /^SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED: /);
      assert.match(error.message, /i\/o timeout/);
      assert.equal(error.message.endsWith('Connecting to remote database...'), false);
      return true;
    },
  );
});

test('runDbPushWithFallback reports CAUSE_NOT_EXTRACTABLE rather than a progress line', () => {
  const run = fallbackFailure({ stdout: 'Connecting to remote database...', stderr: '' });
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env: CAUSAL_ENV }),
    /SUPABASE_PROJECT_CONTEXT_ESTABLISH_FAILED: CAUSE_NOT_EXTRACTABLE/,
  );
});

test('runDbPushWithFallback redacts SUPABASE_DB_URL when it appears in the failure', () => {
  const env = { ...CAUSAL_ENV, SUPABASE_DB_URL: 'postgresql://postgres:super-secret-pw@db.abc123.supabase.co:5432/postgres' };
  const run = fallbackFailure({ stderr: `fatal: could not connect using ${env.SUPABASE_DB_URL}` });
  assert.throws(
    () => runDbPushWithFallback({ run, extraArgs: [], env }),
    (error) => {
      assert.equal(error.message.includes('super-secret-pw'), false);
      assert.equal(error.message.includes('db.abc123.supabase.co'), false);
      assert.match(error.message, /could not connect/);
      return true;
    },
  );
});
