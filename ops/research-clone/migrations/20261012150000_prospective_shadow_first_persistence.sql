-- DBCLONE ONLY: nppznoujvnyjargjkmnv. Historical first-persistence remains unknown.
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
