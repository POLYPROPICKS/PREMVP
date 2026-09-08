/**
 * windowsUserEnvBridge.test.mjs
 *
 * Proves the Windows persistent User Environment bridge for the registered PREMVP
 * application-migration adapter:
 * - values already in the current process env are never re-read;
 * - values missing from the process env but present in the persistent user env are bridged
 *   into the child env;
 * - values genuinely absent from both are reported as still-missing (→ REQUIRED_SECRET
 *   classification by the caller), never guessed;
 * - the secret VALUE never appears in the describeBridge() evidence.
 *
 * Run: node --test tests/control-plane/windowsUserEnvBridge.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bridgePersistentUserEnv,
  describeBridge,
} from '../../scripts/control-plane/lib/windows-user-env-bridge.mjs';

const NAMES = ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_DB_PASSWORD'];

test('process-env values are used as-is and the persistent store is not consulted', () => {
  const read = () => { throw new Error('persistent store must not be read'); };
  const result = bridgePersistentUserEnv({
    names: NAMES,
    baseEnv: { SUPABASE_ACCESS_TOKEN: 'a', SUPABASE_PROJECT_REF: 'b', SUPABASE_DB_PASSWORD: 'c' },
    read,
  });
  assert.deepEqual(result.bridged, []);
  assert.deepEqual(result.stillMissing, []);
  assert.equal(result.env.SUPABASE_PROJECT_REF, 'b');
});

test('missing process-env values present in the persistent user env are bridged', () => {
  const persistent = { SUPABASE_ACCESS_TOKEN: 'sbp_tok', SUPABASE_PROJECT_REF: 'ref123', SUPABASE_DB_PASSWORD: 'pw!' };
  const result = bridgePersistentUserEnv({
    names: NAMES,
    baseEnv: { PATH: '/usr/bin' },
    read: (name) => persistent[name] ?? null,
  });
  assert.deepEqual([...result.bridged].sort(), [...NAMES].sort());
  assert.deepEqual(result.stillMissing, []);
  assert.equal(result.env.SUPABASE_DB_PASSWORD, 'pw!');
  assert.equal(result.env.PATH, '/usr/bin');
});

test('values absent from both are reported still-missing, never guessed', () => {
  const result = bridgePersistentUserEnv({
    names: NAMES,
    baseEnv: { SUPABASE_PROJECT_REF: 'ref123' },
    read: () => null,
  });
  assert.deepEqual(result.bridged, []);
  assert.deepEqual(result.stillMissing.sort(), ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD']);
  assert.equal('SUPABASE_ACCESS_TOKEN' in result.env, false);
});

test('describeBridge exposes only names and booleans, never a value', () => {
  const persistent = { SUPABASE_ACCESS_TOKEN: 'super-secret-token' };
  const result = bridgePersistentUserEnv({
    names: ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD'],
    baseEnv: {},
    read: (name) => persistent[name] ?? null,
  });
  const described = JSON.stringify(describeBridge(result));
  assert.equal(described.includes('super-secret-token'), false);
  assert.match(described, /bridged_from_persistent_user_env/);
  assert.match(described, /still_missing_after_bridge/);
});
