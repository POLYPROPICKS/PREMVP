import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  SHADOW_CLONE_REF, SHADOW_MIGRATION_FILE, SHADOW_MIGRATION_MODE, SHADOW_CLONE_LEDGER_BASELINE,
  runShadowMigration, validateShadowMigration,
} from '../../scripts/control-plane/lib/premvp-clone-shadow-migration.mjs';
import { sha256OfText } from '../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

const sql = fs.readFileSync(new URL(`../../${SHADOW_MIGRATION_FILE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const declaration = {
  mode: SHADOW_MIGRATION_MODE, project_ref: SHADOW_CLONE_REF, migration_file: SHADOW_MIGRATION_FILE,
  target_sha256: sha256OfText(sql), direct_raw_mutation: false, idempotent: true,
};

test('exact-target clone migration rejects altered SQL and production routing', () => {
  assert.deepEqual(validateShadowMigration(declaration, sql), { ok: true, errors: [] });
  for (const altered of [
    sql.replace('clock_timestamp()', 'now()'),
    sql.replace("old.row_kind = 'LEDGER'", "old.row_kind = 'SNAPSHOT'"),
    sql.replace('before truncate', 'after truncate'),
    sql + '\ndrop table public.prospective_selection_shadow_runtime;',
    sql + '\ncommit;',
  ]) assert.equal(validateShadowMigration({ ...declaration, target_sha256: sha256OfText(altered) }, altered).ok, false);
  assert.equal(validateShadowMigration({ ...declaration, project_ref: 'nbnldzfsxffztsfrrxqy' }, sql).ok, false);
  assert.equal(validateShadowMigration({ ...declaration, migration_file: 'ops/research-clone/other-schema.sql' }, sql).ok, false);
  assert.equal(validateShadowMigration({ ...declaration, direct_raw_mutation: true }, sql).ok, false);
});

function transport({ catalogOk = true, ledgerDrift = false } = {}) {
  const calls = [];
  let applied = false;
  let fingerprintReads = 0;
  const target = {
    projectRef: SHADOW_CLONE_REF, calls,
    async readLedger() { calls.push('ledger'); const baseline = ledgerDrift ? SHADOW_CLONE_LEDGER_BASELINE.slice(1) : SHADOW_CLONE_LEDGER_BASELINE; return applied ? [...baseline, '20261012150000'] : [...baseline]; },
    async readSchemaFingerprint() { calls.push('fingerprint'); return { fingerprint: ++fingerprintReads < 3 ? 'before' : 'after' }; },
    async proveTransactionSemantics() { calls.push('transaction'); },
    async dryRunExactSql(value) { assert.equal(value, sql); calls.push('dry_run'); },
    async applyNative({ sql: value, name, localTimeouts }) { assert.equal(value, sql); assert.equal(name, 'prospective_shadow_first_persistence'); assert.equal(localTimeouts, true); applied = true; calls.push('native_apply'); },
    async readColumns() { calls.push('columns'); return [
      { column_name: 'first_persisted_at', data_type: 'timestamp with time zone', is_nullable: true },
      { column_name: 'unresolved_reason', data_type: 'text', is_nullable: true },
    ]; },
    async readShadowGuardCatalog() { calls.push('catalog'); return {
      function_present: catalogOk, security_definer: false, db_clock_present: true,
      anon_execute: false, authenticated_execute: false, row_trigger_enabled: true,
      truncate_trigger_enabled: true, service_delete: false, service_truncate: false,
    }; },
  };
  return target;
}

test('versioned clone dry-run proves rollback without applying SQL', async () => {
  const target = transport();
  const result = await runShadowMigration({ transport: target, declaration, sql });
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.dry_run.schema_unchanged, true);
  assert.equal(result.dry_run.ledger_unchanged, true);
  assert.equal(target.calls.includes('native_apply'), false);
});

test('apply requires catalog proof after native migration and never accepts wrong project', async () => {
  const target = transport();
  const result = await runShadowMigration({ transport: target, declaration, sql, apply: true });
  assert.equal(result.applied, true);
  assert.equal(result.shadow_guard_catalog.row_trigger_enabled, true);
  assert.deepEqual(target.calls.filter((x) => x === 'native_apply'), ['native_apply']);
  await assert.rejects(runShadowMigration({ transport: transport({ catalogOk: false }), declaration, sql, apply: true }), /SHADOW_GUARD_CATALOG_NOT_PROVEN/);
  await assert.rejects(runShadowMigration({ transport: { ...transport(), projectRef: 'nbnldzfsxffztsfrrxqy' }, declaration, sql }), /SHADOW_TRANSPORT_PROJECT_MISMATCH/);
  await assert.rejects(runShadowMigration({ transport: transport({ ledgerDrift: true }), declaration, sql }), /TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY/);
});
