import { readFileSync } from 'node:fs';
import { sha256OfText } from './premvp-target-only-migration.mjs';
import { assertNoTransactionControl, runHttpsTargetOnly } from './premvp-migration-https-transport.mjs';
import { FORWARD_BET_CLONE_LEDGER_BASELINE, FORWARD_BET_CLONE_REF } from './premvp-clone-forward-bet-migration.mjs';

export const FORWARD_BET_ACL_MIGRATION_MODE = 'PREMVP_CLONE_FORWARD_BET_SETTLEMENT_ACL_V1';
export const FORWARD_BET_ACL_MIGRATION_FILE = 'ops/research-clone/migrations/20261012190000_virtual_bet_settlement_acl_hardening_v1.sql';
/** The clone ledger after 20261012180000 was registered exactly once. */
export const FORWARD_BET_ACL_LEDGER_BASELINE = Object.freeze([...FORWARD_BET_CLONE_LEDGER_BASELINE, '20261012180000']);

const EXPECTED_STATEMENTS = [
  'revoke all on public.virtual_bet_settlement_authority from public, anon, authenticated, service_role;',
  'grant select, insert on public.virtual_bet_settlement_authority to service_role;',
];

/** Executable statements only: comment lines are stripped so the review compares the real DDL, not the prose. */
function statementsOf(sql) {
  return sql.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim() && !line.trim().startsWith('--')).map((line) => line.trim());
}

export function validateForwardBetAclMigration(declaration, sql) {
  const errors = [];
  if (declaration?.mode !== FORWARD_BET_ACL_MIGRATION_MODE) errors.push('FORWARD_BET_ACL_MODE_INVALID');
  if (declaration?.project_ref !== FORWARD_BET_CLONE_REF) errors.push('FORWARD_BET_ACL_PROJECT_REF_INVALID');
  if (declaration?.migration_file !== FORWARD_BET_ACL_MIGRATION_FILE) errors.push('FORWARD_BET_ACL_FILE_INVALID');
  if (declaration?.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  if (declaration?.idempotent !== true) errors.push('FORWARD_BET_ACL_IDEMPOTENCY_DECLARATION_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(declaration?.target_sha256 ?? '') || declaration.target_sha256 !== sha256OfText(sql)) errors.push('FORWARD_BET_ACL_SHA256_MISMATCH');
  try { assertNoTransactionControl(sql); } catch { errors.push('FORWARD_BET_ACL_TRANSACTION_CONTROL_FORBIDDEN'); }
  const actual = statementsOf(sql);
  if (actual.length !== EXPECTED_STATEMENTS.length || actual.some((line, index) => line !== EXPECTED_STATEMENTS[index])) errors.push('FORWARD_BET_ACL_SQL_NOT_EXACT_REVIEWED_DELTA');
  return { ok: errors.length === 0, errors };
}

export function readForwardBetAclSql(root) {
  return readFileSync(new URL(FORWARD_BET_ACL_MIGRATION_FILE, root), 'utf8').replace(/\r\n/g, '\n');
}

export async function runForwardBetAclMigration({ transport, declaration, sql, apply = false }) {
  const validation = validateForwardBetAclMigration(declaration, sql);
  if (!validation.ok) throw new Error(validation.errors.join(';'));
  if (transport.projectRef !== FORWARD_BET_CLONE_REF) throw new Error('FORWARD_BET_ACL_TRANSPORT_PROJECT_MISMATCH');
  const evidence = await runHttpsTargetOnly({
    transport,
    targetBasename: FORWARD_BET_ACL_MIGRATION_FILE.split('/').at(-1),
    targetSql: sql,
    targetSha256: declaration.target_sha256,
    resolveTracked: (versions) => ({ missing: versions.length === FORWARD_BET_ACL_LEDGER_BASELINE.length &&
      versions.every((version, index) => version === FORWARD_BET_ACL_LEDGER_BASELINE[index]) ? [] : ['FORWARD_BET_ACL_CLONE_LEDGER_DRIFT'] }),
    nativeLocalTimeouts: true,
    verify: [{ schema: 'public', table: 'virtual_bet_settlement_authority', columns: ['check_kind', 'outcome', 'provider_digest', 'checked_at'] }],
    apply,
  });
  if (!apply) return evidence;
  const catalog = await transport.readForwardBetCatalog();
  if (!catalog || catalog.settlement_service_update !== false || catalog.settlement_service_delete !== false || catalog.settlement_service_truncate !== false ||
      catalog.settlement_service_insert !== true || catalog.settlement_anon_any !== false || catalog.settlement_authenticated_any !== false ||
      catalog.settlement_row_trigger_enabled !== true || catalog.settlement_truncate_trigger_enabled !== true) {
    throw new Error('FORWARD_BET_ACL_CATALOG_NOT_PROVEN');
  }
  return { ...evidence, forward_bet_catalog: catalog };
}
