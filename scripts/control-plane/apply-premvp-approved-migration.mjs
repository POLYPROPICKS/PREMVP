#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAndValidateMigration } from './lib/premvp-application-migration-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const index = args.indexOf('--declaration');
const raw = index >= 0 ? args[index + 1] : null;
if (!raw) throw new Error('MIGRATION_DECLARATION_REQUIRED');
const declaration = JSON.parse(raw);
const migrationFile = readAndValidateMigration(root, declaration);
const run = (cliArgs) => execFileSync('npx', ['--yes', 'supabase@latest', ...cliArgs], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
const dry = run(['db', 'push', '--linked', '--skip-vault', '--dry-run', '--yes']);
if (!dry.includes(path.basename(migrationFile))) throw new Error('MIGRATION_NOT_PENDING_ON_LINKED_PROJECT');
const localMigrations = [...dry.matchAll(/\d{14}_[a-z0-9_]+\.sql/gi)].map((match) => `supabase/migrations/${match[0]}`);
if ([...new Set(localMigrations)].some((file) => file !== migrationFile)) throw new Error('UNEXPECTED_PENDING_MIGRATION');
if (args.includes('--dry-run')) {
  process.stdout.write(JSON.stringify({ ok: true, mode: 'dry_run', migration_file: migrationFile }) + '\n');
} else {
  run(['db', 'push', '--linked', '--skip-vault', '--yes']);
  process.stdout.write(JSON.stringify({ ok: true, mode: 'applied', migration_file: migrationFile }) + '\n');
}
