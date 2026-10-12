#!/usr/bin/env node
// Machine-verifiable deployment handoff for the DBClone-only forward-BET migration. It runs nothing against any
// database: it pins the exact reviewed SQL identity, the ledger baseline and the commands/verifications for a
// separately authorised runtime that holds the Supabase management token. Output is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256OfText } from './lib/premvp-target-only-migration.mjs';
import {
  FORWARD_BET_CLONE_LEDGER_BASELINE, FORWARD_BET_CLONE_REF, FORWARD_BET_MIGRATION_FILE, FORWARD_BET_MIGRATION_MODE, validateForwardBetMigration,
} from './lib/premvp-clone-forward-bet-migration.mjs';
import {
  FORWARD_BET_ACL_LEDGER_BASELINE, FORWARD_BET_ACL_MIGRATION_FILE, FORWARD_BET_ACL_MIGRATION_MODE, validateForwardBetAclMigration,
} from './lib/premvp-clone-forward-bet-acl-migration.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildHandoff() {
  const sql = fs.readFileSync(path.join(root, FORWARD_BET_MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
  const sha = sha256OfText(sql);
  const declaration = { mode: FORWARD_BET_MIGRATION_MODE, project_ref: FORWARD_BET_CLONE_REF, migration_file: FORWARD_BET_MIGRATION_FILE, target_sha256: sha, direct_raw_mutation: false, idempotent: true };
  const validation = validateForwardBetMigration(declaration, sql);
  const aclSql = fs.readFileSync(path.join(root, FORWARD_BET_ACL_MIGRATION_FILE), 'utf8').replace(/\r\n/g, '\n');
  const aclSha = sha256OfText(aclSql);
  const aclDeclaration = { mode: FORWARD_BET_ACL_MIGRATION_MODE, project_ref: FORWARD_BET_CLONE_REF, migration_file: FORWARD_BET_ACL_MIGRATION_FILE, target_sha256: aclSha, direct_raw_mutation: false, idempotent: true };
  const aclValidation = validateForwardBetAclMigration(aclDeclaration, aclSql);
  const aclArg = JSON.stringify(aclDeclaration);
  const declarationArg = JSON.stringify(declaration);
  return {
    handoff: 'FORWARD_BET_CONTRACT_V1_DBCLONE_DEPLOYMENT',
    target: { project_ref: FORWARD_BET_CLONE_REF, scope: 'DBCLONE_ONLY', forbidden_refs: ['nbnldzfsxffztsfrrxqy'] },
    migration: { file: FORWARD_BET_MIGRATION_FILE, bytes: Buffer.byteLength(sql), sha256: sha, reviewed_exact_sql_match: validation.ok, validation_errors: validation.errors },
    ledger_baseline: { expected_versions: [...FORWARD_BET_CLONE_LEDGER_BASELINE], count: FORWARD_BET_CLONE_LEDGER_BASELINE.length, drift_policy: 'ANY difference aborts before apply (FORWARD_BET_CLONE_LEDGER_DRIFT)' },
    schema_baseline_before: {
      prospective_selection_shadow_runtime_has_columns: ['first_persisted_at', 'unresolved_reason'],
      prospective_selection_shadow_runtime_lacks_columns: ['contract_version', 'canonical_game_key', 'game_identity_basis', 'provider_root_game_id', 'provider_root_game_source', 'scope_basis', 'economic_unit_key', 'timing_class', 'timing_detail', 'contract_status', 'verification_status'],
      virtual_bet_settlement_authority_exists: false,
      probe: 'npx tsx scripts/modeling/forward-bet-post-deploy-verify.ts  (expected FAIL before apply: columns/table absent)',
    },
    registered_route: {
      script: 'scripts/control-plane/apply-premvp-approved-migration.mjs',
      requires_env: ['SUPABASE_ACCESS_TOKEN (Supabase management API, scoped to the clone project)'],
      dry_run: `node scripts/control-plane/apply-premvp-approved-migration.mjs --declaration '${declarationArg}' --clone-forward-bet-contract`,
      apply: `PREMVP_TARGET_ONLY_APPLY_CONFIRM=1 node scripts/control-plane/apply-premvp-approved-migration.mjs --declaration '${declarationArg}' --clone-forward-bet-contract --apply --confirm`,
      dry_run_proves: ['transaction semantics', 'exact SQL executes inside BEGIN..ROLLBACK', 'schema fingerprint and ledger unchanged afterwards'],
      apply_proves: ['ledger gains exactly one entry (20261012180000)', 'contract and settlement columns present and nullable', 'catalog: triggers enabled, non-SECURITY DEFINER, no anon/authenticated grants, service_role cannot UPDATE/DELETE/TRUNCATE settlement history or DELETE/TRUNCATE the ledger, unique indexes present'],
    },
    settlement_acl_hardening: {
      defect: 'service_role keeps default-privilege UPDATE/DELETE/TRUNCATE on virtual_bet_settlement_authority (clone probe: no-op UPDATE/DELETE returned 204, expected 42501); triggers still block row mutation',
      applies_after: '20261012180000 registered exactly once in the clone ledger; this step never re-runs that DDL',
      migration: { file: FORWARD_BET_ACL_MIGRATION_FILE, bytes: Buffer.byteLength(aclSql), sha256: aclSha, reviewed_exact_sql_match: aclValidation.ok, validation_errors: aclValidation.errors },
      ledger_baseline: [...FORWARD_BET_ACL_LEDGER_BASELINE],
      dry_run: `node scripts/control-plane/apply-premvp-approved-migration.mjs --declaration '${aclArg}' --clone-forward-bet-settlement-acl`,
      apply: `PREMVP_TARGET_ONLY_APPLY_CONFIRM=1 node scripts/control-plane/apply-premvp-approved-migration.mjs --declaration '${aclArg}' --clone-forward-bet-settlement-acl --apply --confirm`,
      requires_env: ['SUPABASE_ACCESS_TOKEN (Supabase management API, scoped to the clone project)'],
      verify: 'npx tsx scripts/modeling/forward-bet-post-deploy-verify.ts  (SETTLEMENT_UPDATE_REFUSED and SETTLEMENT_DELETE_REFUSED must be PASS)',
    },
    post_deploy: {
      verify: 'npx tsx scripts/modeling/forward-bet-post-deploy-verify.ts  (expected PASS)',
      invariants: ['timing_class vocabulary is PRE_START_AUTHORITATIVE | PRE_START_SCHEDULED_ONLY | LATE_OR_REPLAY | TIMING_UNPROVEN; an authoritative start requires a registered independent source', 'verification_status is VERIFIED only with authoritative timing + provider-confirmed root game + structured scope; text dedup and scheduled-only rows are UNVERIFIED with named links', '2858 historical rows still have NULL first_persisted_at and NULL contract fields', 'Chloe Noel precedent row identical and contract-less', 'DELETE on ledger and UPDATE/DELETE on settlement history refused with 42501'],
      first_natural_proof: 'the next modeling:shadow-cycle run writes FORWARD_BET_V1 rows; then npm run modeling:forward-bet-ceo-report',
    },
    order_independence: 'The cycle and settlement script probe the schema and run in legacy/no-op mode until the migration exists, so merge-then-migrate and migrate-then-merge are both safe; the natural proof starts only when both are live.',
    rollback: 'Additive and nullable. Do not drop columns or the settlement table; if the contract must be paused, stop writing it (revert the code) and leave the immutable rows in place.',
    never: ['production project', 'Ireland', 'backfilling historical rows', 'raw SQL outside this route'],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(buildHandoff(), null, 2)}\n`);
}
