import { sha256OfText } from './premvp-target-only-migration.mjs';
import { assertNoTransactionControl, runHttpsTargetOnly } from './premvp-migration-https-transport.mjs';

export const SHADOW_MIGRATION_MODE = 'PREMVP_CLONE_SHADOW_IMMUTABILITY_V1';
export const SHADOW_CLONE_REF = 'nppznoujvnyjargjkmnv';
export const SHADOW_MIGRATION_FILE = 'ops/research-clone/migrations/20261012150000_prospective_shadow_first_persistence.sql';

// Separate from the generic clone-schema allowlist. This exact SQL is independently reviewed
// in code, so a declaration hash alone cannot authorize a different function or trigger.
const EXPECTED_SQL = `-- DBCLONE ONLY: nppznoujvnyjargjkmnv. Historical first-persistence remains unknown.
do $$
begin
  if current_setting('lock_timeout') <> '5s' or current_setting('statement_timeout') <> '45s' then
    raise exception 'SHADOW_MIGRATION_TIMEOUTS_NOT_ACTIVE';
  end if;
end;
$$;

alter table public.prospective_selection_shadow_runtime
  add column if not exists first_persisted_at timestamptz,
  add column if not exists unresolved_reason text;

create or replace function public.prospective_selection_shadow_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception 'IMMUTABLE_SHADOW_LEDGER_TRUNCATE';
  end if;
  if tg_op = 'DELETE' then
    if old.row_kind = 'LEDGER' then
      raise exception 'IMMUTABLE_SHADOW_CHOICE';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.row_kind = 'LEDGER' then
      new.first_persisted_at := clock_timestamp();
    end if;
    return new;
  end if;
  if old.row_kind = 'SNAPSHOT' and new.row_kind = 'LEDGER' then
    raise exception 'SNAPSHOT_CANNOT_BECOME_LEDGER';
  end if;
  if old.row_kind = 'LEDGER' and
    (new.row_key, new.row_kind, new.model_id, new.decision_date,
     new.candidate_identity, new.physical_event_key, new.decision_timestamp,
     new.event_start, new.entry_price, new.sport_family, new.condition_id,
     new.selected_token_id, new.pre_event_score, new.data_coverage,
     new.first_persisted_at)
    is distinct from
    (old.row_key, old.row_kind, old.model_id, old.decision_date,
     old.candidate_identity, old.physical_event_key, old.decision_timestamp,
     old.event_start, old.entry_price, old.sport_family, old.condition_id,
     old.selected_token_id, old.pre_event_score, old.data_coverage,
     old.first_persisted_at) then
    raise exception 'IMMUTABLE_SHADOW_CHOICE';
  end if;
  return new;
end;
$$;

revoke all on function public.prospective_selection_shadow_guard() from public, anon, authenticated;
drop trigger if exists prospective_selection_shadow_guard_row_trg on public.prospective_selection_shadow_runtime;
create trigger prospective_selection_shadow_guard_row_trg
before insert or update or delete on public.prospective_selection_shadow_runtime
for each row execute function public.prospective_selection_shadow_guard();
drop trigger if exists prospective_selection_shadow_guard_truncate_trg on public.prospective_selection_shadow_runtime;
create trigger prospective_selection_shadow_guard_truncate_trg
before truncate on public.prospective_selection_shadow_runtime
for each statement execute function public.prospective_selection_shadow_guard();
revoke delete, truncate on public.prospective_selection_shadow_runtime from service_role;
`;

export function validateShadowMigration(declaration, sql) {
  const errors = [];
  if (declaration?.mode !== SHADOW_MIGRATION_MODE) errors.push('SHADOW_MODE_INVALID');
  if (declaration?.project_ref !== SHADOW_CLONE_REF) errors.push('SHADOW_PROJECT_REF_INVALID');
  if (declaration?.migration_file !== SHADOW_MIGRATION_FILE) errors.push('SHADOW_FILE_INVALID');
  if (declaration?.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  if (declaration?.idempotent !== true) errors.push('SHADOW_IDEMPOTENCY_DECLARATION_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(declaration?.target_sha256 ?? '') || declaration.target_sha256 !== sha256OfText(sql)) errors.push('SHADOW_SHA256_MISMATCH');
  try { assertNoTransactionControl(sql); } catch { errors.push('SHADOW_TRANSACTION_CONTROL_FORBIDDEN'); }
  if (sql.replace(/\r\n/g, '\n') !== EXPECTED_SQL) errors.push('SHADOW_SQL_NOT_EXACT_REVIEWED_DELTA');
  return { ok: errors.length === 0, errors };
}

// Exact DBClone ledger observed before this one-purpose migration. Any drift requires a fresh review.
export const SHADOW_CLONE_LEDGER_BASELINE = Object.freeze([
  '20260812152531', '20260812152539', '20260812154439', '20260813111146', '20260814083257',
  '20260907090854', '20260907090911', '20260916182024', '20260919072722', '20260923104049',
  '20260923121955', '20260924192128', '20260924201147', '20260925052246', '20260925071724',
  '20260925072111', '20260925092253', '20260925092300', '20260925133329', '20260925133336',
  '20260930081720', '20260930104845', '20260930120158', '20261007125949', '20261010093450',
  '20261011075303', '20261011075337', '20261011075355', '20261011173709', '20261012081337',
  '20261012091611',
]);

export async function runShadowMigration({ transport, declaration, sql, apply = false }) {
  const validation = validateShadowMigration(declaration, sql);
  if (!validation.ok) throw new Error(validation.errors.join(';'));
  if (transport.projectRef !== SHADOW_CLONE_REF) throw new Error('SHADOW_TRANSPORT_PROJECT_MISMATCH');
  const evidence = await runHttpsTargetOnly({
    transport,
    targetBasename: SHADOW_MIGRATION_FILE.split('/').at(-1),
    targetSql: sql,
    targetSha256: declaration.target_sha256,
    resolveTracked: (versions) => ({ missing: versions.length === SHADOW_CLONE_LEDGER_BASELINE.length &&
      versions.every((version, index) => version === SHADOW_CLONE_LEDGER_BASELINE[index]) ? [] : ['SHADOW_CLONE_LEDGER_DRIFT'] }),
    nativeLocalTimeouts: true,
    verify: [{ schema: 'public', table: 'prospective_selection_shadow_runtime', columns: ['first_persisted_at', 'unresolved_reason'] }],
    apply,
  });
  if (!apply) return evidence;
  const catalog = await transport.readShadowGuardCatalog();
  if (!catalog || catalog.function_present !== true || catalog.security_definer !== false ||
      catalog.db_clock_present !== true || catalog.anon_execute !== false || catalog.authenticated_execute !== false ||
      catalog.row_trigger_enabled !== true || catalog.truncate_trigger_enabled !== true ||
      catalog.service_delete !== false || catalog.service_truncate !== false) {
    throw new Error('SHADOW_GUARD_CATALOG_NOT_PROVEN');
  }
  return { ...evidence, shadow_guard_catalog: catalog };
}
