import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIGRATION_MODE, validateApprovedMigrationRelease } from '../../scripts/control-plane/lib/premvp-application-migration-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = 'supabase/migrations/20261008042146_storage_reclaim_sports_inventory_v1.sql';
const sql = fs.readFileSync(path.join(root, file), 'utf8');
const target = 'public.sports_event_market_inventory';
const declaration = {
  mode: MIGRATION_MODE,
  safety_class: 'STORAGE_RECLAIM_TRANSITION',
  migration_files: [file],
  storage_reclaim_targets: [target],
  storage_reclaim_justification: 'Expired observability-only inventory; zero unexpired rows; no current reader; provider-regenerable.',
  direct_raw_mutation: false,
  rollback_strategy: 'REGENERABLE_SOURCE',
};
const check = (source, fields = {}) => validateApprovedMigrationRelease({
  declaration: { ...declaration, ...fields }, changedFiles: [file], readFile: () => source,
});

test('the exact guarded inventory truncate is accepted', () => {
  assert.equal(check(sql).ok, true, check(sql).errors.join('\n'));
});

test('normal safety classes keep the truncate ban', () => {
  for (const safety_class of ['ADDITIVE_COMPATIBLE', 'COMPATIBILITY_TRANSITION']) {
    const fields = { safety_class, rollback_strategy: 'COMPATIBILITY_RETAINED' };
    if (safety_class === 'COMPATIBILITY_TRANSITION') fields.constraint_drop_justification = 'Compatibility transition';
    assert.equal(check(sql, fields).ok, false);
  }
});

test('storage declaration requires the exact target, justification, and rollback strategy', () => {
  for (const fields of [
    { storage_reclaim_targets: [] },
    { storage_reclaim_targets: ['public.other'] },
    { storage_reclaim_targets: [target, 'public.other'] },
    { storage_reclaim_justification: ' ' },
    { rollback_strategy: 'COMPATIBILITY_RETAINED' },
  ]) assert.equal(check(sql, fields).ok, false, JSON.stringify(fields));
});

test('storage SQL rejects extra or destructive statements', () => {
  for (const source of [
    sql.replace(target, 'public.other'),
    sql.replace(`TRUNCATE TABLE ${target};`, `TRUNCATE TABLE ${target}, public.other;`),
    sql.replace(`TRUNCATE TABLE ${target};`, `TRUNCATE TABLE ${target} CASCADE;`),
    sql.replace(`TRUNCATE TABLE ${target};`, `TRUNCATE TABLE ${target} RESTART IDENTITY;`),
    `${sql}\nDELETE FROM ${target};`,
    `${sql}\nDROP TABLE ${target};`,
    `${sql}\nDROP INDEX public.other;`,
    `${sql}\nDO $$ BEGIN EXECUTE 'SELECT 1'; END $$;`,
    sql.replace('WHERE expires_at >= now()', 'WHERE expires_at > now()'),
  ]) assert.equal(check(source).ok, false, source);
});
