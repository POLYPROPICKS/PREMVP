
create index strategic_jul15_aug27_snapshot_created_at_idx
  on research.strategic_jul15_aug27_identity_snapshot (created_at);
create index strategic_jul15_aug27_snapshot_selected_token_idx
  on research.strategic_jul15_aug27_identity_snapshot (selected_token_id);
create index strategic_jul15_aug27_snapshot_provider_identity_idx
  on research.strategic_jul15_aug27_identity_snapshot (provider_event_identity);
create index strategic_jul15_aug27_snapshot_sport_idx
  on research.strategic_jul15_aug27_identity_snapshot (sport_family, sport_code);

create function research.prevent_strategic_jul15_aug27_snapshot_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'research.strategic_jul15_aug27_identity_snapshot is immutable';
end;
$$;

create trigger strategic_jul15_aug27_snapshot_immutable
before update or delete on research.strategic_jul15_aug27_identity_snapshot
for each row execute function research.prevent_strategic_jul15_aug27_snapshot_mutation();

revoke all on schema research from anon, authenticated;
revoke all on table research.strategic_jul15_aug27_identity_snapshot from anon, authenticated;
revoke all on function research.prevent_strategic_jul15_aug27_snapshot_mutation() from public;
;
