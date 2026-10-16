import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FORWARD_BET_CLONE_REF } from '../../scripts/control-plane/lib/premvp-clone-forward-bet-migration.mjs';
import {
  FORWARD_BET_ACL_LEDGER_BASELINE, FORWARD_BET_ACL_MIGRATION_FILE, FORWARD_BET_ACL_MIGRATION_MODE,
  runForwardBetAclMigration, validateForwardBetAclMigration,
} from '../../scripts/control-plane/lib/premvp-clone-forward-bet-acl-migration.mjs';
import { sha256OfText } from '../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

const sql = fs.readFileSync(new URL(`../../${FORWARD_BET_ACL_MIGRATION_FILE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const declaration = {
  mode: FORWARD_BET_ACL_MIGRATION_MODE, project_ref: FORWARD_BET_CLONE_REF, migration_file: FORWARD_BET_ACL_MIGRATION_FILE,
  target_sha256: sha256OfText(sql), direct_raw_mutation: false, idempotent: true,
};

test('the ACL migration is the exact two-statement DBClone-only delta and rejects anything wider', () => {
  assert.deepEqual(validateForwardBetAclMigration(declaration, sql), { ok: true, errors: [] });
  assert.doesNotMatch(sql, /nbnldzfsxffztsfrrxqy/);
  assert.doesNotMatch(sql, /^\s*(update|delete|insert|drop|alter|truncate)\b/im);
  assert.doesNotMatch(sql, /^grant\b[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/im);
  for (const altered of [
    sql.replace('grant select, insert', 'grant all'),
    sql.replace('from public, anon, authenticated, service_role', 'from public, anon, authenticated'),
    sql + '\ndrop table public.virtual_bet_settlement_authority;',
    sql + '\ncommit;',
  ]) assert.equal(validateForwardBetAclMigration({ ...declaration, target_sha256: sha256OfText(altered) }, altered).ok, false);
  assert.equal(validateForwardBetAclMigration({ ...declaration, project_ref: 'nbnldzfsxffztsfrrxqy' }, sql).ok, false);
  assert.equal(validateForwardBetAclMigration({ ...declaration, direct_raw_mutation: true }, sql).ok, false);
});

const goodCatalog = {
  settlement_service_update: false, settlement_service_delete: false, settlement_service_truncate: false, settlement_service_insert: true,
  settlement_anon_any: false, settlement_authenticated_any: false, settlement_row_trigger_enabled: true, settlement_truncate_trigger_enabled: true,
};

function transport({ catalog = goodCatalog, ledgerDrift = false } = {}) {
  let applied = false;
  let fingerprintReads = 0;
  return {
    projectRef: FORWARD_BET_CLONE_REF,
    async readLedger() { const base = ledgerDrift ? FORWARD_BET_ACL_LEDGER_BASELINE.slice(1) : FORWARD_BET_ACL_LEDGER_BASELINE; return applied ? [...base, '20261012190000'] : [...base]; },
    async readSchemaFingerprint() { return { fingerprint: ++fingerprintReads < 3 ? 'before' : 'after' }; },
    async proveTransactionSemantics() {},
    async dryRunExactSql(value) { assert.equal(value, sql); },
    async applyNative({ sql: value, name }) { assert.equal(value, sql); assert.equal(name, 'virtual_bet_settlement_acl_hardening_v1'); applied = true; },
    async readColumns(schema, table, columns) { return columns.map((column_name) => ({ column_name, data_type: 'text', is_nullable: true })); },
    async readForwardBetCatalog() { return catalog; },
  };
}

test('the ACL baseline is the applied forward-contract ledger and apply needs service UPDATE/DELETE/TRUNCATE all revoked', async () => {
  assert.equal(FORWARD_BET_ACL_LEDGER_BASELINE.at(-1), '20261012180000');
  assert.equal(FORWARD_BET_ACL_LEDGER_BASELINE.filter((version) => version === '20261012180000').length, 1);
  const dry = await runForwardBetAclMigration({ transport: transport(), declaration, sql });
  assert.equal(dry.mode, 'dry_run');
  const applied = await runForwardBetAclMigration({ transport: transport(), declaration, sql, apply: true });
  assert.equal(applied.applied, true);
  for (const broken of [{ settlement_service_update: true }, { settlement_service_delete: true }, { settlement_service_truncate: true }, { settlement_service_insert: false }, { settlement_anon_any: true }]) {
    await assert.rejects(runForwardBetAclMigration({ transport: transport({ catalog: { ...goodCatalog, ...broken } }), declaration, sql, apply: true }), /FORWARD_BET_ACL_CATALOG_NOT_PROVEN/);
  }
  await assert.rejects(runForwardBetAclMigration({ transport: transport({ ledgerDrift: true }), declaration, sql }), /TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY/);
  await assert.rejects(runForwardBetAclMigration({ transport: { ...transport(), projectRef: 'nbnldzfsxffztsfrrxqy' }, declaration, sql }), /FORWARD_BET_ACL_TRANSPORT_PROJECT_MISMATCH/);
});
