/**
 * windows-user-env-bridge.mjs
 *
 * Bridges already-provisioned *persistent Windows User Environment* values into a child
 * process env when the current process env does not carry them.
 *
 * Why this exists: on Windows the Supabase values (SUPABASE_ACCESS_TOKEN /
 * SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD) are commonly set once with
 * `setx` / System Properties, which writes `HKCU\Environment`. A shell or agent process
 * started before that provisioning — or started by a launcher that does not broadcast
 * WM_SETTINGCHANGE — never sees them in `process.env`. That is an executor-owned
 * invocation gap, not an absent secret.
 *
 * Secret safety: values are copied straight from the persistent store into the returned
 * env object. They are never logged, echoed, returned as a value, written to disk, or
 * placed anywhere other than the child process env. `describeBridge()` reports only names
 * and booleans.
 */

import { execFileSync } from 'node:child_process';

export const SUPABASE_ENV_NAMES = Object.freeze([
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_DB_URL',
]);

/**
 * Default persistent reader: the value of `name` in the current user's persistent
 * environment (`HKCU\Environment`), or null. Uses PowerShell's
 * [Environment]::GetEnvironmentVariable(name,'User') which reads the registry directly and
 * does not fall back to the process env.
 */
export function readPersistentUserEnvValue(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$v=[Environment]::GetEnvironmentVariable('${name}','User'); if ($null -ne $v) { [Console]::Out.Write($v) }`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    const value = String(out);
    return value.length ? value : null;
  } catch {
    return null;
  }
}

/**
 * Returns a NEW env object: `baseEnv` plus any of `names` that were missing/empty in
 * `baseEnv` but present in the persistent user environment.
 *
 * @returns {{ env: Record<string,string>, bridged: string[], stillMissing: string[], platform: string }}
 */
export function bridgePersistentUserEnv({
  names = SUPABASE_ENV_NAMES,
  baseEnv = process.env,
  read = readPersistentUserEnvValue,
} = {}) {
  const env = { ...baseEnv };
  const bridged = [];
  const stillMissing = [];
  for (const name of names) {
    if (env[name] && String(env[name]).length) continue;
    const value = read(name);
    if (value && String(value).length) {
      env[name] = String(value);
      bridged.push(name);
    } else {
      stillMissing.push(name);
    }
  }
  return { env, bridged, stillMissing, platform: process.platform };
}

/** Secret-free description for evidence/logging. Never contains a value. */
export function describeBridge(result) {
  return {
    platform: result.platform,
    bridged_from_persistent_user_env: [...result.bridged].sort(),
    still_missing_after_bridge: [...result.stillMissing].sort(),
  };
}
