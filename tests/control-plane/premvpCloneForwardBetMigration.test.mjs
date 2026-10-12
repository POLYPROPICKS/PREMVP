import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  FORWARD_BET_CLONE_LEDGER_BASELINE, FORWARD_BET_CLONE_REF, FORWARD_BET_MIGRATION_FILE, FORWARD_BET_MIGRATION_MODE,
  runForwardBetMigration, validateForwardBetMigration,
} from '../../scripts/control-plane/lib/premvp-clone-forward-bet-migration.mjs';
import { sha256OfText } from '../../scripts/control-plane/lib/premvp-target-only-migration.mjs';

const sql = fs.readFileSync(new URL(`../../${FORWARD_BET_MIGRATION_FILE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const declaration = {
  mode: FORWARD_BET_MIGRATION_MODE, project_ref: FORWARD_BET_CLONE_REF, migration_file: FORWARD_BET_MIGRATION_FILE,
  target_sha256: sha256OfText(sql), direct_raw_mutation: false, idempotent: true,
};

test('exact-target forward-BET migration rejects altered SQL, production routing and wrong files', () => {
  assert.deepEqual(validateForwardBetMigration(declaration, sql), { ok: true, errors: [] });
  for (const altered of [
    sql.replace('clock_timestamp()', 'now()'),
    sql.replace("interval '7200 seconds'", "interval '9 seconds'").replace('lag_seconds > 7200', 'lag_seconds > 7201'),
    sql.replace('grant select, insert on', 'grant all on'),
    sql.replace('unique index if not exists prospective_shadow_economic_unit_uidx', 'index if not exists prospective_shadow_economic_unit_uidx'),
    sql + '\ndrop table public.prospective_selection_shadow_runtime;',
    sql + '\ncommit;',
  ]) assert.equal(validateForwardBetMigration({ ...declaration, target_sha256: sha256OfText(altered) }, altered).ok, false);
  assert.equal(validateForwardBetMigration({ ...declaration, project_ref: 'nbnldzfsxffztsfrrxqy' }, sql).ok, false);
  assert.equal(validateForwardBetMigration({ ...declaration, migration_file: 'ops/research-clone/other-schema.sql' }, sql).ok, false);
  assert.equal(validateForwardBetMigration({ ...declaration, direct_raw_mutation: true }, sql).ok, false);
});

test('the migration is DBClone-only, never rewrites history and never grants anon/authenticated', () => {
  assert.match(sql, /DBCLONE ONLY: nppznoujvnyjargjkmnv/);
  assert.doesNotMatch(sql, /nbnldzfsxffztsfrrxqy/);
  assert.doesNotMatch(sql, /^\s*(update|delete)\b/im);
  assert.doesNotMatch(sql, /grant [^;]*(anon|authenticated)/i);
  assert.match(sql, /revoke all on public\.virtual_bet_settlement_authority from public, anon, authenticated/);
});

const goodCatalog = {
  ledger_guard_present: true, ledger_security_definer: false, ledger_row_trigger_enabled: true, ledger_truncate_trigger_enabled: true,
  economic_unit_index_present: true, contract_check_present: true, ledger_service_delete: false, ledger_service_truncate: false,
  settlement_table_present: true, settlement_rls_enabled: true, settlement_row_trigger_enabled: true, settlement_truncate_trigger_enabled: true,
  one_terminal_index_present: true, settlement_anon_any: false, settlement_authenticated_any: false, settlement_service_update: false,
  settlement_service_delete: false, settlement_service_truncate: false, settlement_service_insert: true,
};

function transport({ catalog = goodCatalog, ledgerDrift = false } = {}) {
  const calls = [];
  let applied = false;
  let fingerprintReads = 0;
  return {
    projectRef: FORWARD_BET_CLONE_REF, calls,
    async readLedger() { calls.push('ledger'); const base = ledgerDrift ? FORWARD_BET_CLONE_LEDGER_BASELINE.slice(1) : FORWARD_BET_CLONE_LEDGER_BASELINE; return applied ? [...base, '20261012180000'] : [...base]; },
    async readSchemaFingerprint() { calls.push('fingerprint'); return { fingerprint: ++fingerprintReads < 3 ? 'before' : 'after' }; },
    async proveTransactionSemantics() { calls.push('transaction'); },
    async dryRunExactSql(value) { assert.equal(value, sql); calls.push('dry_run'); },
    async applyNative({ sql: value, name, localTimeouts }) { assert.equal(value, sql); assert.equal(name, 'virtual_bet_forward_contract_v1'); assert.equal(localTimeouts, true); applied = true; calls.push('native_apply'); },
    async readColumns(schema, table, columns) {
      calls.push('columns');
      return columns.map((column_name) => ({ column_name, data_type: 'text', is_nullable: true }));
    },
    async readForwardBetCatalog() { calls.push('catalog'); return catalog; },
  };
}

test('dry-run proves rollback on the exact post-#525 clone ledger without applying', async () => {
  const target = transport();
  const result = await runForwardBetMigration({ transport: target, declaration, sql });
  assert.equal(result.mode, 'dry_run');
  assert.equal(result.dry_run.schema_unchanged, true);
  assert.equal(target.calls.includes('native_apply'), false);
});

test('apply needs the full catalog proof, an unchanged ledger baseline and the clone project only', async () => {
  const applied = await runForwardBetMigration({ transport: transport(), declaration, sql, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.forward_bet_catalog.settlement_service_update, false);
  for (const broken of [{ settlement_service_update: true }, { settlement_anon_any: true }, { one_terminal_index_present: false }, { economic_unit_index_present: false }, { ledger_service_delete: true }]) {
    await assert.rejects(runForwardBetMigration({ transport: transport({ catalog: { ...goodCatalog, ...broken } }), declaration, sql, apply: true }), /FORWARD_BET_CATALOG_NOT_PROVEN/);
  }
  await assert.rejects(runForwardBetMigration({ transport: { ...transport(), projectRef: 'nbnldzfsxffztsfrrxqy' }, declaration, sql }), /FORWARD_BET_TRANSPORT_PROJECT_MISMATCH/);
  await assert.rejects(runForwardBetMigration({ transport: transport({ ledgerDrift: true }), declaration, sql }), /TARGET_ONLY_REMOTE_TRACKED_FILE_MISSING_LOCALLY/);
});

test('deployment handoff pins the exact reviewed SQL, the baseline and the registered route', async () => {
  const { buildHandoff } = await import('../../scripts/control-plane/forward-bet-deployment-handoff.mjs');
  const handoff = buildHandoff();
  assert.equal(handoff.migration.sha256, sha256OfText(sql));
  assert.equal(handoff.migration.reviewed_exact_sql_match, true);
  assert.equal(handoff.target.project_ref, FORWARD_BET_CLONE_REF);
  assert.deepEqual(handoff.ledger_baseline.expected_versions, [...FORWARD_BET_CLONE_LEDGER_BASELINE]);
  assert.match(handoff.registered_route.apply, /--clone-forward-bet-contract --apply --confirm/);
  assert.doesNotMatch(JSON.stringify(handoff.registered_route), /nbnldzfsxffztsfrrxqy/);
  assert.deepEqual(buildHandoff(), handoff);
});

test('the committed handoff evidence is current with the reviewed SQL', async () => {
  const { buildHandoff } = await import('../../scripts/control-plane/forward-bet-deployment-handoff.mjs');
  const committed = JSON.parse(fs.readFileSync(new URL('../../modeling/evidence/forward-bet-ledger-v1/DEPLOYMENT_HANDOFF.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, buildHandoff());
});
