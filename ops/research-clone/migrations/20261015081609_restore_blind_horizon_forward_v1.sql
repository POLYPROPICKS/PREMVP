-- Research DBClone nppznoujvnyjargjkmnv ONLY. Separate from PR #538; no decision writer/cutover.
-- The existing source ingested_at is an APPLICATION timestamp (the sync upserts it).
-- Never reinterpret it as DB arrival time. Capture a bounded, settlement-free source
-- snapshot NOW, then stamp source_received_at and as_of with the DB clock AFTER that read.
-- A receipt proves availability at this capture, never at an earlier historical instant.
set local lock_timeout = '5s';
set local statement_timeout = '45s';

create table blind_obs.horizon_receipts_v1 (
  receipt_id uuid primary key,
  source_received_at timestamptz not null,
  as_of timestamptz not null check(as_of >= source_received_at),
  set_by text not null,
  source_rows jsonb not null check(jsonb_typeof(source_rows)='array' and jsonb_array_length(source_rows)<=50)
);
alter table blind_obs.horizon_receipts_v1 enable row level security;

create function blind_obs.horizon_receipt_guard_v1() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'IMMUTABLE_BLIND_HORIZON_RECEIPT';
end $$;
create trigger horizon_receipt_guard_v1 before update or delete
on blind_obs.horizon_receipts_v1 for each row execute function blind_obs.horizon_receipt_guard_v1();
create trigger horizon_receipt_truncate_guard_v1 before truncate
on blind_obs.horizon_receipts_v1 for each statement execute function blind_obs.horizon_receipt_guard_v1();
revoke all on function blind_obs.horizon_receipt_guard_v1() from public,anon,authenticated,service_role,blind_model_reader;

alter table blind_obs.model_horizon add column receipt_id uuid
  references blind_obs.horizon_receipts_v1(receipt_id);
revoke all on blind_obs.model_horizon,blind_obs.horizon_receipts_v1
  from public,anon,authenticated,service_role,blind_model_reader;
grant usage on schema blind_obs to service_role,blind_model_reader;
grant select on blind_obs.model_horizon,blind_obs.horizon_receipts_v1 to service_role,blind_model_reader;
create policy blind_horizon_reader_v1 on blind_obs.model_horizon
  for select to service_role,blind_model_reader using(true);
create policy blind_receipt_reader_v1 on blind_obs.horizon_receipts_v1
  for select to service_role,blind_model_reader using(true);

-- SECURITY DEFINER is deliberately a zero-argument controller, not a generic permission workaround:
-- callers cannot supply an as-of, actor, source rows, table name, statement or receipt.
-- Direct horizon/audit writes stay revoked. All names are qualified; no dynamic SQL.
create function public.research_blind_freeze_horizon_v1() returns uuid
language plpgsql security definer set search_path = pg_catalog as $$
declare
  receipt uuid := pg_catalog.gen_random_uuid();
  inputs jsonb;
  received timestamptz;
  frozen timestamptz;
  actor text := session_user || ':' || coalesce(current_setting('role',true),'none');
begin
  perform pg_catalog.pg_advisory_xact_lock(548912043);
  -- Read complete exact rows before taking the authoritative availability timestamp.
  -- This is a bounded source snapshot, NOT the daily 100-event selector/cohort.
  with valid as (
    select r.observation_id,r.item_observation_id,r.observed_at,
      r.ingested_at as claimed_ingested_at,
      r.condition_id,r.selected_token_id,r.provider_event_id,r.provider_sport_family,
      r.market_family,r.market_type,r.game_start_iso,r.entry_price_num,r.pre_event_score_num,
      r.signal_confidence_num,r.formula_version,r.metric_formula_version,r.selected_outcome,r.data_coverage,
      case when pg_catalog.pg_input_is_valid(r.game_start_iso,'timestamp with time zone')
        then r.game_start_iso::timestamptz end as event_start_at
    from public.research_evidence_page_rows r
    where r.observed_at<=r.ingested_at and r.ingested_at<=clock_timestamp()
  ), latest as (
    select distinct on(provider_event_id,condition_id,selected_token_id)
      to_jsonb(v) as snapshot,v.observed_at,v.observation_id,v.item_observation_id
    from valid v where v.event_start_at > clock_timestamp()+interval '90 minutes'
      and v.event_start_at <= clock_timestamp()+interval '24 hours'
    order by provider_event_id,condition_id,selected_token_id,observed_at desc,observation_id,item_observation_id
  ), bounded as (
    select l.snapshot,l.observed_at,l.observation_id,l.item_observation_id
      from latest l order by observed_at desc,observation_id,item_observation_id limit 50
  )
  select coalesce(jsonb_agg(b.snapshot order by b.observed_at desc,b.observation_id,b.item_observation_id),'[]'::jsonb)
    into inputs from bounded b;
  received := clock_timestamp();
  frozen := clock_timestamp();
  if exists(select 1 from blind_obs.model_horizon h where h.as_of>frozen) then
    raise exception 'BLIND_HORIZON_CLOCK_REGRESSION';
  end if;
  insert into blind_obs.horizon_receipts_v1(receipt_id,source_received_at,as_of,set_by,source_rows)
    values(receipt,received,frozen,actor,inputs);
  insert into blind_obs.model_horizon(singleton,as_of,set_by,set_at,receipt_id)
    values(true,frozen,actor,frozen,receipt)
    on conflict(singleton) do update
      set as_of=excluded.as_of,set_by=excluded.set_by,set_at=excluded.set_at,receipt_id=excluded.receipt_id;
  return receipt;
end $$;
revoke all on function public.research_blind_freeze_horizon_v1() from public,anon,authenticated,blind_model_reader;
grant execute on function public.research_blind_freeze_horizon_v1() to service_role;

-- The only newly authorized model-read surface. Original raw views are untouched
-- and are denied to model readers: their historical availability is unproven.
revoke all on blind_obs.prematch_observations_v1,blind_obs.inplay_observations_v1,blind_obs.t20_observations_v1
  from public,anon,authenticated,service_role,blind_model_reader;
create view blind_obs.scored_prematch_observations_v1 with(security_barrier=true) as
select a.receipt_id,a.source_received_at,a.as_of,
  s.observation_id,s.item_observation_id,s.observed_at,s.claimed_ingested_at,
  s.condition_id,s.selected_token_id,s.provider_event_id,s.provider_sport_family,
  s.market_family,s.market_type,s.game_start_iso,s.event_start_at,s.entry_price_num,
  s.pre_event_score_num,s.signal_confidence_num,s.formula_version,s.metric_formula_version,
  s.selected_outcome,s.data_coverage
from blind_obs.model_horizon h
join blind_obs.horizon_receipts_v1 a on a.receipt_id=h.receipt_id and a.as_of=h.as_of
cross join lateral jsonb_to_recordset(a.source_rows) as s(
  observation_id uuid,item_observation_id uuid,observed_at timestamptz,claimed_ingested_at timestamptz,
  condition_id text,selected_token_id text,provider_event_id text,provider_sport_family text,
  market_family text,market_type text,game_start_iso text,event_start_at timestamptz,
  entry_price_num numeric,pre_event_score_num numeric,signal_confidence_num numeric,
  formula_version text,metric_formula_version text,selected_outcome text,data_coverage numeric
)
where h.singleton and s.observed_at<=s.claimed_ingested_at
  and s.claimed_ingested_at<=a.source_received_at and a.source_received_at<=a.as_of
  and a.as_of<s.event_start_at-interval '90 minutes';
revoke all on blind_obs.scored_prematch_observations_v1 from public,anon,authenticated;
grant select on blind_obs.scored_prematch_observations_v1 to service_role,blind_model_reader;

-- Public-schema RPC avoids requiring blind_obs to be exposed through PostgREST.
-- SECURITY INVOKER: only the named reader's SELECT policies apply.
create function public.research_blind_read_horizon_v1(p_receipt_id uuid) returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$
  select jsonb_build_object('receipt_id',a.receipt_id,'source_received_at',a.source_received_at,
    'as_of',a.as_of,'set_by',a.set_by,'source_rows',a.source_rows)
  from blind_obs.horizon_receipts_v1 a where a.receipt_id=p_receipt_id;
$$;
revoke all on function public.research_blind_read_horizon_v1(uuid) from public,anon,authenticated;
grant execute on function public.research_blind_read_horizon_v1(uuid) to service_role,blind_model_reader;

-- First capture is genuinely current. No historical receipt or decision is manufactured.
select public.research_blind_freeze_horizon_v1();
