import { sha256OfText } from './premvp-target-only-migration.mjs';
import { assertNoTransactionControl, runHttpsTargetOnly } from './premvp-migration-https-transport.mjs';
import { SHADOW_CLONE_LEDGER_BASELINE } from './premvp-clone-shadow-migration.mjs';

export const FORWARD_BET_MIGRATION_MODE = 'PREMVP_CLONE_FORWARD_BET_CONTRACT_V1';
export const FORWARD_BET_CLONE_REF = 'nppznoujvnyjargjkmnv';
export const FORWARD_BET_MIGRATION_FILE = 'ops/research-clone/migrations/20261012180000_virtual_bet_forward_contract_v1.sql';
/** The clone ledger after the PR #525 shadow-immutability migration was applied: baseline + exactly that one version. */
export const FORWARD_BET_CLONE_LEDGER_BASELINE = Object.freeze([...SHADOW_CLONE_LEDGER_BASELINE, '20261012150000']);

// Exact reviewed DBClone-only delta (research-only; historical rows are never backfilled). A declaration hash alone
// cannot authorize a different function, trigger or grant: the SQL must equal this text byte for byte.
const EXPECTED_SQL = `-- DBCLONE ONLY: nppznoujvnyjargjkmnv. Forward BET contract + independent settlement authority.
-- Historical rows (contract_version IS NULL) are never backfilled and can never gain contract fields.
do $$
begin
  if current_setting('lock_timeout') <> '5s' or current_setting('statement_timeout') <> '45s' then
    raise exception 'FORWARD_BET_MIGRATION_TIMEOUTS_NOT_ACTIVE';
  end if;
  if to_regclass('public.prospective_selection_shadow_runtime') is null then
    raise exception 'FORWARD_BET_MIGRATION_REQUIRES_SHADOW_RUNTIME_TABLE';
  end if;
  if not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'prospective_selection_shadow_runtime' and column_name = 'first_persisted_at') then
    raise exception 'FORWARD_BET_MIGRATION_REQUIRES_FIRST_PERSISTENCE_V1';
  end if;
end;
$$;

alter table public.prospective_selection_shadow_runtime
  add column if not exists contract_version text,
  add column if not exists canonical_game_key text,
  add column if not exists game_identity_basis text,
  add column if not exists scope_basis text,
  add column if not exists provider_event_id text,
  add column if not exists market_family text,
  add column if not exists market_type text,
  add column if not exists line_value numeric,
  add column if not exists period_scope text,
  add column if not exists selected_outcome text,
  add column if not exists observed_at timestamptz,
  add column if not exists decision_generated_at timestamptz,
  add column if not exists scheduled_start_at timestamptz,
  add column if not exists authoritative_start_at timestamptz,
  add column if not exists authoritative_start_source text,
  add column if not exists reference_price numeric,
  add column if not exists reference_price_source text,
  add column if not exists reference_price_type text,
  add column if not exists reference_price_acquired_at timestamptz,
  add column if not exists provider_quote_at timestamptz,
  add column if not exists executable_buy_price numeric,
  add column if not exists executable_price_authority text,
  add column if not exists executable_quote_at timestamptz,
  add column if not exists model_version text,
  add column if not exists selection_reason text,
  add column if not exists decision_kind text,
  add column if not exists economic_unit_key text,
  add column if not exists observation_lag_seconds numeric,
  add column if not exists lead_time_scheduled_seconds numeric,
  add column if not exists lead_time_authoritative_seconds numeric,
  add column if not exists timing_class text,
  add column if not exists contract_status text;

alter table public.prospective_selection_shadow_runtime
  drop constraint if exists prospective_shadow_forward_contract_ck;
alter table public.prospective_selection_shadow_runtime
  add constraint prospective_shadow_forward_contract_ck check (
    contract_version is null
    or (
      contract_version = 'FORWARD_BET_V1'
      and row_kind = 'LEDGER'
      and decision_kind = 'BET'
      and (game_identity_basis is null or game_identity_basis in ('TEAM_PAIR_START_TEXT', 'PROVIDER_EVENT_ONLY'))
      and (scope_basis is null or scope_basis in ('STRUCTURED_MONEYLINE', 'TEXT_HEURISTIC'))
      and (reference_price is null or (reference_price > 0 and reference_price < 1))
      and ((executable_buy_price is null) = (executable_price_authority is null))
      and ((executable_buy_price is null) = (executable_quote_at is null))
      and (executable_buy_price is null or (executable_buy_price > 0 and executable_buy_price < 1))
      and (executable_price_authority is null or executable_price_authority in ('CLOB_BEST_ASK', 'CLOB_DEPTH_VWAP'))
    )
  );

create unique index if not exists prospective_shadow_economic_unit_uidx
  on public.prospective_selection_shadow_runtime (model_id, economic_unit_key)
  where row_kind = 'LEDGER' and economic_unit_key is not null;

create or replace function public.prospective_selection_shadow_guard()
returns trigger language plpgsql as $$
declare
  persisted timestamptz;
  missing text[];
  lag_seconds numeric;
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
      persisted := clock_timestamp();
      new.first_persisted_at := persisted;
      if new.contract_version is null then
        if num_nonnulls(new.canonical_game_key, new.game_identity_basis, new.scope_basis, new.provider_event_id, new.market_family, new.market_type,
          new.line_value, new.period_scope, new.selected_outcome, new.observed_at, new.decision_generated_at,
          new.scheduled_start_at, new.authoritative_start_at, new.reference_price, new.executable_buy_price,
          new.model_version, new.selection_reason, new.decision_kind, new.economic_unit_key, new.timing_class,
          new.contract_status) > 0 then
          raise exception 'FORWARD_FIELDS_REQUIRE_CONTRACT_VERSION';
        end if;
      else
        if exists (select 1 from public.prospective_selection_shadow_runtime r
          where r.row_kind = 'LEDGER' and r.model_id = new.model_id
            and r.row_key <> new.row_key
            and (r.physical_event_key = new.physical_event_key
              or (new.canonical_game_key is not null and r.canonical_game_key = new.canonical_game_key))) then
          raise exception using errcode = '23505', message = 'DUPLICATE_ECONOMIC_UNIT';
        end if;
        if new.decision_generated_at is null or new.observed_at is null then
          raise exception 'FORWARD_DECISION_TIMES_REQUIRED';
        end if;
        if new.decision_generated_at > persisted + interval '60 seconds' then
          raise exception 'DECISION_TIME_IN_FUTURE';
        end if;
        if new.observed_at > new.decision_generated_at + interval '60 seconds' then
          raise exception 'OBSERVATION_AFTER_DECISION';
        end if;
        lag_seconds := extract(epoch from (persisted - new.observed_at));
        new.observation_lag_seconds := lag_seconds;
        new.lead_time_scheduled_seconds := case when new.scheduled_start_at is null then null
          else extract(epoch from (new.scheduled_start_at - persisted)) end;
        new.lead_time_authoritative_seconds := case when new.authoritative_start_at is null then null
          else extract(epoch from (new.authoritative_start_at - persisted)) end;
        new.timing_class := case
          when lag_seconds > 7200 then 'HISTORICAL_REPLAY'
          when new.authoritative_start_at is not null and persisted < new.authoritative_start_at then 'PRE_START_AUTHORITATIVE'
          when new.authoritative_start_at is not null then 'LATE_AUTHORITATIVE'
          when new.scheduled_start_at is not null and persisted < new.scheduled_start_at then 'PRE_START_SCHEDULED_ONLY'
          when new.scheduled_start_at is not null then 'LATE_SCHEDULED'
          else 'START_UNKNOWN' end;
        missing := array_remove(array[
          case when new.canonical_game_key is null then 'canonical_game_key' end,
          case when new.game_identity_basis is distinct from 'TEAM_PAIR_START_TEXT' then 'root_game_unverified' end,
          case when new.scope_basis is null then 'scope_basis' end,
          case when new.provider_event_id is null then 'provider_event_id' end,
          case when new.condition_id is null then 'condition_id' end,
          case when new.selected_token_id is null then 'selected_token_id' end,
          case when new.market_family is null then 'market_family' end,
          case when new.market_type is null then 'market_type' end,
          case when new.period_scope is null then 'period_scope' end,
          case when new.selected_outcome is null then 'selected_outcome' end,
          case when new.line_value is null and new.market_family in ('SPREAD', 'TOTAL', 'HANDICAP') then 'line_value' end,
          case when new.reference_price is null then 'reference_price' end,
          case when new.reference_price_source is null then 'reference_price_source' end,
          case when new.reference_price_type is null then 'reference_price_type' end,
          case when new.reference_price_acquired_at is null then 'reference_price_acquired_at' end,
          case when new.model_version is null then 'model_version' end,
          case when new.selection_reason is null then 'selection_reason' end,
          case when new.economic_unit_key is null then 'economic_unit_key' end
        ], null);
        new.contract_status := case when array_length(missing, 1) is null then 'COMPLETE'
          else 'INCOMPLETE:' || array_to_string(missing, ',') end;
      end if;
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
     new.first_persisted_at, new.contract_version, new.canonical_game_key,
     new.game_identity_basis, new.scope_basis,
     new.provider_event_id, new.market_family, new.market_type, new.line_value,
     new.period_scope, new.selected_outcome, new.observed_at, new.decision_generated_at,
     new.scheduled_start_at, new.authoritative_start_at, new.authoritative_start_source,
     new.reference_price, new.reference_price_source, new.reference_price_type,
     new.reference_price_acquired_at, new.provider_quote_at, new.executable_buy_price,
     new.executable_price_authority, new.executable_quote_at, new.model_version,
     new.selection_reason, new.decision_kind, new.economic_unit_key,
     new.observation_lag_seconds, new.lead_time_scheduled_seconds,
     new.lead_time_authoritative_seconds, new.timing_class, new.contract_status)
    is distinct from
    (old.row_key, old.row_kind, old.model_id, old.decision_date,
     old.candidate_identity, old.physical_event_key, old.decision_timestamp,
     old.event_start, old.entry_price, old.sport_family, old.condition_id,
     old.selected_token_id, old.pre_event_score, old.data_coverage,
     old.first_persisted_at, old.contract_version, old.canonical_game_key,
     old.game_identity_basis, old.scope_basis,
     old.provider_event_id, old.market_family, old.market_type, old.line_value,
     old.period_scope, old.selected_outcome, old.observed_at, old.decision_generated_at,
     old.scheduled_start_at, old.authoritative_start_at, old.authoritative_start_source,
     old.reference_price, old.reference_price_source, old.reference_price_type,
     old.reference_price_acquired_at, old.provider_quote_at, old.executable_buy_price,
     old.executable_price_authority, old.executable_quote_at, old.model_version,
     old.selection_reason, old.decision_kind, old.economic_unit_key,
     old.observation_lag_seconds, old.lead_time_scheduled_seconds,
     old.lead_time_authoritative_seconds, old.timing_class, old.contract_status) then
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

create table if not exists public.virtual_bet_settlement_authority (
  check_id bigint generated always as identity primary key,
  bet_row_key text not null references public.prospective_selection_shadow_runtime (row_key),
  condition_id text not null,
  selected_token_id text not null,
  check_kind text not null check (check_kind in ('TERMINAL', 'PENDING', 'DIAGNOSTIC', 'CONFLICT')),
  outcome text not null check (outcome in ('WIN', 'LOSS', 'VOID', 'UNRESOLVED', 'UNKNOWN')),
  source_authority text not null check (source_authority in ('CLOB_WINNER_TOKEN', 'CLOB_5050', 'GAMMA_AUXILIARY', 'NONE')),
  independent_of_selection boolean not null,
  winner_token_id text,
  provider_closed boolean,
  provider_resolved_at timestamptz,
  checked_at timestamptz not null default clock_timestamp(),
  reason text not null,
  provider_digest text not null,
  provider_answer jsonb,
  conflicts_with_check_id bigint references public.virtual_bet_settlement_authority (check_id),
  check (
    (check_kind = 'TERMINAL' and outcome in ('WIN', 'LOSS', 'VOID') and source_authority in ('CLOB_WINNER_TOKEN', 'CLOB_5050') and independent_of_selection)
    or (check_kind = 'PENDING' and outcome = 'UNKNOWN')
    or (check_kind = 'DIAGNOSTIC' and outcome in ('UNRESOLVED', 'UNKNOWN'))
    or (check_kind = 'CONFLICT' and outcome in ('WIN', 'LOSS', 'VOID', 'UNRESOLVED') and conflicts_with_check_id is not null)
  ),
  check (outcome <> 'WIN' or (winner_token_id is not null and winner_token_id = selected_token_id))
);

create unique index if not exists virtual_bet_settlement_one_terminal_uidx
  on public.virtual_bet_settlement_authority (bet_row_key) where check_kind = 'TERMINAL';
create index if not exists virtual_bet_settlement_bet_idx
  on public.virtual_bet_settlement_authority (bet_row_key, check_id desc);

create or replace function public.virtual_bet_settlement_guard()
returns trigger language plpgsql as $$
declare
  bet record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'IMMUTABLE_SETTLEMENT_AUTHORITY';
  end if;
  select r.row_kind, r.contract_version, r.condition_id, r.selected_token_id into bet
    from public.prospective_selection_shadow_runtime r where r.row_key = new.bet_row_key;
  if bet.row_kind is distinct from 'LEDGER' or bet.contract_version is null then
    raise exception 'SETTLEMENT_REQUIRES_FORWARD_CONTRACT_BET';
  end if;
  if new.condition_id is distinct from bet.condition_id or new.selected_token_id is distinct from bet.selected_token_id then
    raise exception 'SETTLEMENT_EXACT_IDENTITY_MISMATCH';
  end if;
  new.checked_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.virtual_bet_settlement_guard() from public, anon, authenticated;
drop trigger if exists virtual_bet_settlement_guard_row_trg on public.virtual_bet_settlement_authority;
create trigger virtual_bet_settlement_guard_row_trg
before insert or update or delete on public.virtual_bet_settlement_authority
for each row execute function public.virtual_bet_settlement_guard();
drop trigger if exists virtual_bet_settlement_guard_truncate_trg on public.virtual_bet_settlement_authority;
create trigger virtual_bet_settlement_guard_truncate_trg
before truncate on public.virtual_bet_settlement_authority
for each statement execute function public.virtual_bet_settlement_guard();

alter table public.virtual_bet_settlement_authority enable row level security;
revoke all on public.virtual_bet_settlement_authority from public, anon, authenticated;
grant select, insert on public.virtual_bet_settlement_authority to service_role;
`;

export function validateForwardBetMigration(declaration, sql) {
  const errors = [];
  if (declaration?.mode !== FORWARD_BET_MIGRATION_MODE) errors.push('FORWARD_BET_MODE_INVALID');
  if (declaration?.project_ref !== FORWARD_BET_CLONE_REF) errors.push('FORWARD_BET_PROJECT_REF_INVALID');
  if (declaration?.migration_file !== FORWARD_BET_MIGRATION_FILE) errors.push('FORWARD_BET_FILE_INVALID');
  if (declaration?.direct_raw_mutation !== false) errors.push('RAW_DATABASE_MUTATION_FORBIDDEN');
  if (declaration?.idempotent !== true) errors.push('FORWARD_BET_IDEMPOTENCY_DECLARATION_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(declaration?.target_sha256 ?? '') || declaration.target_sha256 !== sha256OfText(sql)) errors.push('FORWARD_BET_SHA256_MISMATCH');
  try { assertNoTransactionControl(sql); } catch { errors.push('FORWARD_BET_TRANSACTION_CONTROL_FORBIDDEN'); }
  if (sql.replace(/\r\n/g, '\n') !== EXPECTED_SQL) errors.push('FORWARD_BET_SQL_NOT_EXACT_REVIEWED_DELTA');
  return { ok: errors.length === 0, errors };
}

export async function runForwardBetMigration({ transport, declaration, sql, apply = false }) {
  const validation = validateForwardBetMigration(declaration, sql);
  if (!validation.ok) throw new Error(validation.errors.join(';'));
  if (transport.projectRef !== FORWARD_BET_CLONE_REF) throw new Error('FORWARD_BET_TRANSPORT_PROJECT_MISMATCH');
  const evidence = await runHttpsTargetOnly({
    transport,
    targetBasename: FORWARD_BET_MIGRATION_FILE.split('/').at(-1),
    targetSql: sql,
    targetSha256: declaration.target_sha256,
    resolveTracked: (versions) => ({ missing: versions.length === FORWARD_BET_CLONE_LEDGER_BASELINE.length &&
      versions.every((version, index) => version === FORWARD_BET_CLONE_LEDGER_BASELINE[index]) ? [] : ['FORWARD_BET_CLONE_LEDGER_DRIFT'] }),
    nativeLocalTimeouts: true,
    verify: [
      { schema: 'public', table: 'prospective_selection_shadow_runtime', columns: ['contract_version', 'canonical_game_key', 'economic_unit_key', 'timing_class', 'contract_status', 'executable_buy_price', 'executable_price_authority'] },
      { schema: 'public', table: 'virtual_bet_settlement_authority', columns: ['check_kind', 'outcome', 'provider_digest', 'checked_at'] },
    ],
    apply,
  });
  if (!apply) return evidence;
  const catalog = await transport.readForwardBetCatalog();
  if (!catalog || catalog.ledger_guard_present !== true || catalog.ledger_security_definer !== false || catalog.ledger_row_trigger_enabled !== true ||
      catalog.ledger_truncate_trigger_enabled !== true || catalog.economic_unit_index_present !== true || catalog.contract_check_present !== true ||
      catalog.settlement_table_present !== true || catalog.settlement_rls_enabled !== true || catalog.settlement_row_trigger_enabled !== true ||
      catalog.settlement_truncate_trigger_enabled !== true || catalog.one_terminal_index_present !== true ||
      catalog.settlement_anon_any !== false || catalog.settlement_authenticated_any !== false || catalog.settlement_service_update !== false ||
      catalog.settlement_service_delete !== false || catalog.settlement_service_truncate !== false || catalog.settlement_service_insert !== true ||
      catalog.ledger_service_delete !== false || catalog.ledger_service_truncate !== false) {
    throw new Error('FORWARD_BET_CATALOG_NOT_PROVEN');
  }
  return { ...evidence, forward_bet_catalog: catalog };
}
