#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAndValidateMigration } from './lib/premvp-application-migration-release.mjs';
import { runDbPushWithFallback, redactSecrets } from './lib/premvp-migration-adapter-connection.mjs';
import { assertCleanMigrationDirectory } from './lib/migration-directory-preflight.mjs';
import { bridgePersistentUserEnv, describeBridge, SUPABASE_ENV_NAMES } from './lib/windows-user-env-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const index = args.indexOf('--declaration');
const raw = index >= 0 ? args[index + 1] : null;
if (!raw) throw new Error('MIGRATION_DECLARATION_REQUIRED');
const declaration = JSON.parse(raw);

// Static migration-directory hygiene — fail closed before any Supabase CLI invocation.
assertCleanMigrationDirectory(root);

const migrationFile = readAndValidateMigration(root, declaration);

// Windows persistent-env bridge: source already-provisioned User Environment values into
// the child process when the current process env lacks them. Never prints or persists values.
const bridge = bridgePersistentUserEnv({ names: SUPABASE_ENV_NAMES, baseEnv: process.env });
const childEnv = bridge.env;

const secrets = [childEnv.SUPABASE_DB_PASSWORD, childEnv.SUPABASE_ACCESS_TOKEN, childEnv.SUPABASE_DB_URL].filter(Boolean);
const sanitize = (text) => redactSecrets(text, secrets);

const run = (cliArgs) => {
  try {
    return process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '--yes', 'supabase@latest', ...cliArgs], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: childEnv })
      : execFileSync('npx', ['--yes', 'supabase@latest', ...cliArgs], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: childEnv });
  } catch (error) {
    // Re-throw with secrets stripped from any captured output so a dry-run failure cause
    // stays visible without exposing the bridged values.
    if (error && (error.stdout || error.stderr)) {
      error.stdout = sanitize(error.stdout || '');
      error.stderr = sanitize(error.stderr || '');
    }
    throw error;
  }
};
const dbPush = (extraArgs) => runDbPushWithFallback({ run, extraArgs, env: childEnv });

const dry = dbPush(['--skip-vault', '--dry-run', '--yes']);
if (!dry.includes(path.basename(migrationFile))) throw new Error('MIGRATION_NOT_PENDING_ON_LINKED_PROJECT');
const localMigrations = [...dry.matchAll(/\d{14}_[a-z0-9_]+\.sql/gi)].map((match) => `supabase/migrations/${match[0]}`);
if ([...new Set(localMigrations)].some((file) => file !== migrationFile)) throw new Error('UNEXPECTED_PENDING_MIGRATION');
if (args.includes('--dry-run')) {
  process.stdout.write(JSON.stringify({ ok: true, mode: 'dry_run', migration_file: migrationFile, env_bridge: describeBridge(bridge) }) + '\n');
} else {
  dbPush(['--skip-vault', '--yes']);
  process.stdout.write(JSON.stringify({ ok: true, mode: 'applied', migration_file: migrationFile, env_bridge: describeBridge(bridge) }) + '\n');
}
