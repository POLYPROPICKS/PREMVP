/**
 * migrationDirectoryPreflight.test.mjs
 *
 * Proves the permanent migration-directory guard:
 * - the CURRENT repository migration set passes;
 * - legacy short-datestamp filenames are NOT rejected;
 * - an injected preview_*.sql is rejected with NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY
 *   BEFORE any Supabase CLI invocation;
 * - the relocated preview file is no longer inside supabase/migrations/.
 *
 * Run: node --test tests/control-plane/migrationDirectoryPreflight.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateMigrationDirectory,
  preflightMigrationDirectory,
  assertCleanMigrationDirectory,
  classifyMigrationDirEntry,
  PREFLIGHT_REASON,
} from '../../scripts/control-plane/lib/migration-directory-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the current repository migration directory passes the preflight', () => {
  const result = preflightMigrationDirectory(root);
  assert.deepEqual(result, { ok: true, reason: null, offenders: [] });
});

test('the preview/audit script is no longer inside supabase/migrations/', () => {
  const migrations = fs.readdirSync(path.join(root, 'supabase', 'migrations'));
  assert.equal(migrations.includes('preview_track_record_shown_history_flow.sql'), false);
  assert.equal(
    fs.existsSync(path.join(root, 'supabase', 'sql-previews', 'preview_track_record_shown_history_flow.sql')),
    true,
  );
});

test('legacy short-datestamp migration filenames are accepted', () => {
  for (const name of [
    '20260518_whop_v0_1_payment_foundation.sql',
    '20260525_signal_pairs_metric_formula_version.sql',
    '20260813105911_refresh_current_signal_pair_serving_id_bounded.sql',
    '20260814083257_20260814120000_current_signal_pair_serving_prune.sql',
  ]) {
    assert.equal(classifyMigrationDirEntry(name).migration, true, name);
  }
});

test('non-migration SQL (preview/debug/helper) is rejected', () => {
  const result = evaluateMigrationDirectory([
    '20260518_whop_v0_1_payment_foundation.sql',
    'preview_track_record_shown_history_flow.sql',
    'debug_row_counts.sql',
    'scratch.sql',
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, PREFLIGHT_REASON);
  assert.deepEqual(result.offenders, ['debug_row_counts.sql', 'preview_track_record_shown_history_flow.sql', 'scratch.sql']);
});

test('an injected preview_*.sql is rejected before any Supabase CLI call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const migrations = path.join(dir, 'supabase', 'migrations');
  fs.mkdirSync(migrations, { recursive: true });
  fs.writeFileSync(path.join(migrations, '20260518_whop_v0_1_payment_foundation.sql'), '-- ok\n');
  fs.writeFileSync(path.join(migrations, 'preview_injected_helper.sql'), 'SELECT 1;\n');
  try {
    assert.throws(
      () => assertCleanMigrationDirectory(dir),
      (error) => {
        assert.match(error.message, /^NON_MIGRATION_SQL_IN_MIGRATION_DIRECTORY: /);
        assert.match(error.message, /preview_injected_helper\.sql/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing migrations directory is treated as nothing-to-push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-empty-'));
  try {
    assert.deepEqual(preflightMigrationDirectory(dir), { ok: true, reason: null, offenders: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
