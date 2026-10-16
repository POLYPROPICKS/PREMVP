-- UNAPPLIED RESEARCH PROTOTYPE. Not in a migration directory. No runtime caller is enabled.
-- This draft deliberately refuses every database except the disposable-test naming boundary.
do $$ begin
  if current_database() !~ '^receipt_v1_[0-9]+_[0-9]+$' then raise exception 'DISPOSABLE_RECEIPT_DATABASE_REQUIRED'; end if;
  if exists (select 1 from public.prospective_selection_shadow_runtime where executable_buy_price is not null) then
    raise exception 'EXISTING_EXECUTABLE_ROWS_REQUIRE_SEPARATE_REVIEW';
  end if;
end $$;

create table public.forward_buy_receipt_attempts (
  attempt_id uuid primary key,
  ledger_payload jsonb not null,
  quote_evidence jsonb not null,
  requested_rejection text,
  input_digest text not null,
  model_id text,
  economic_unit_key text,
  condition_id text,
  selected_token_id text,
  outcome text not null check (outcome in ('ACCEPTED','REJECTED')),
  rejection_reason text,
  ledger_row_key text references public.prospective_selection_shadow_runtime(row_key) deferrable initially deferred,
  db_received_at timestamptz not null,
  db_persisted_at timestamptz not null,
  receipt_canonical text not null,
  receipt_digest text not null,
  canonical_version text not null check (canonical_version='PG_JSONB_TEXT_V1'),
  check ((outcome='ACCEPTED' and ledger_row_key is not null and rejection_reason is null)
      or (outcome='REJECTED' and ledger_row_key is null and rejection_reason is not null))
);
create unique index forward_buy_receipt_ledger_uidx on public.forward_buy_receipt_attempts(ledger_row_key) where outcome='ACCEPTED';
create unique index forward_buy_receipt_unit_uidx on public.forward_buy_receipt_attempts(model_id,economic_unit_key) where outcome='ACCEPTED';
alter table public.forward_buy_receipt_attempts enable row level security;
revoke all on public.forward_buy_receipt_attempts from public,anon,authenticated,service_role;
grant select,insert on public.forward_buy_receipt_attempts to service_role;

create function public.forward_buy_input_digest_v1(l jsonb,e jsonb,reason text) returns text
language sql immutable security invoker set search_path=pg_catalog,public as $$
  select encode(sha256(convert_to(jsonb_build_object('ledger',l,'evidence',e,'requestedRejection',reason)::text,'UTF8')),'hex');
$$;

-- Returns NULL only for a complete, reproducible quote. No calibrated or prospective profitability is inferred.
create function public.forward_buy_rejection_v1(l jsonb,e jsonb) returns text
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  r jsonb := e->'receipt'; b jsonb := e->'book'; a jsonb; src_n bigint;
  decision_at timestamptz; received_at timestamptz; provider_at timestamptz; selection_at timestamptz; fee_at timestamptz;
  stake numeric; rate numeric; remain numeric:=2.5; shares numeric:=0; fee numeric:=0; available numeric:=0;
  price numeric; size numeric; spend numeric; previous numeric:=0; max_price numeric:=0; tick numeric; minimum numeric;
  levels integer:=0; now_at timestamptz:=clock_timestamp();
begin
  if jsonb_typeof(l) is distinct from 'object' or jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(b) is distinct from 'object' then return 'EVIDENCE_MISSING'; end if;
  if l->>'row_kind' is distinct from 'LEDGER' or l->>'contract_version' is distinct from 'FORWARD_BET_V1'
    or l->>'model_id' not in ('P50_52_SAFE','QUALITY_FILL_D_SAFE') or l->>'model_id' is null
    or r->>'version' is distinct from 'FORWARD_BUY_V1' or r->>'model' is distinct from l->>'model_id'
    or r->>'stakeLedger' is distinct from 'FORWARD_BUY_VIRTUAL_USD_2_50' then return 'CONTRACT_MISMATCH'; end if;
  if coalesce(l->>'row_key','')='' or coalesce(l->>'candidate_identity','')='' or coalesce(l->>'physical_event_key','')=''
    or coalesce(l->>'economic_unit_key','')='' or l->>'economic_unit_key' is distinct from l->>'canonical_game_key'
    or r->>'economicUnitKey' is distinct from l->>'economic_unit_key' then return 'ECONOMIC_UNIT_UNKNOWN'; end if;
  if coalesce(l->>'condition_id','')='' or coalesce(l->>'selected_token_id','')=''
    or r->>'conditionId' is distinct from l->>'condition_id' or r->>'selectedTokenId' is distinct from l->>'selected_token_id'
    or b->>'asset_id' is distinct from l->>'selected_token_id' or b->>'market' is distinct from l->>'condition_id'
    or l->>'market_type' is distinct from 'moneyline' or l->>'market_family' is distinct from 'MONEYLINE'
    or l->>'scope_basis' is distinct from 'STRUCTURED_MONEYLINE' or l->>'period_scope' is distinct from 'FULL_MATCH'
    then return 'IDENTITY_MISMATCH'; end if;
  selection_at := (r->>'selectionObservedAt')::timestamptz;
  decision_at := (r->>'decisionAt')::timestamptz; received_at := (r->'quote'->>'receivedAt')::timestamptz;
  provider_at := (r->'quote'->>'providerTimestamp')::timestamptz; fee_at := (r->'fee'->>'observedAt')::timestamptz;
  if selection_at is null or decision_at is null or received_at is null or provider_at is null or fee_at is null
    or (r->'quote'->>'requestStartedAt') is null then return 'TIMING_MISSING'; end if;
  if (l->>'observed_at')::timestamptz is distinct from selection_at
    or (l->>'decision_timestamp')::timestamptz is distinct from selection_at
    or (l->>'decision_generated_at')::timestamptz is distinct from decision_at
    or (l->>'executable_quote_at')::timestamptz is distinct from received_at
    or (l->>'provider_quote_at')::timestamptz is distinct from provider_at then return 'TIMING_IDENTITY_MISMATCH'; end if;
  if (r->'quote'->>'requestStartedAt')::timestamptz>received_at or selection_at>received_at or received_at>decision_at
    or decision_at>now_at or decision_at-received_at>interval '10 seconds' or provider_at>received_at+interval '2 seconds'
    or received_at-provider_at>interval '30 seconds' then return 'TIMING_INVALID'; end if;
  if now_at-received_at>interval '60 seconds' then return 'STALE_AT_PERSIST'; end if;
  if (l->>'scheduled_start_at')::timestamptz is null or (l->>'scheduled_start_at')::timestamptz<=now_at+interval '5 minutes' then return 'START_NOT_AFTER_DECISION'; end if;
  if fee_at>decision_at or now_at-fee_at>interval '60 seconds' then return 'FEE_STALE'; end if;
  select count(*) into src_n from public.research_evidence_page_rows s
    where s.observation_id::text=e->'source'->>'observationId' and s.item_observation_id::text=e->'source'->>'itemObservationId'
      and s.condition_id=l->>'condition_id' and s.selected_token_id=l->>'selected_token_id' and s.observed_at=selection_at
      and s.entry_price_num=(l->>'reference_price')::numeric and s.source_kind='PRODUCTION_RESEARCH_EVIDENCE_PAGE' and s.market_type='moneyline';
  if src_n<>1 then return 'SELECTION_SOURCE_UNPROVEN'; end if;
  stake := (r->>'stakeUsd')::numeric; rate := (r->'fee'->>'rate')::numeric;
  minimum := (b->>'min_order_size')::numeric; tick := (b->>'tick_size')::numeric;
  if stake is distinct from 2.5 or (r->>'referencePrice')::numeric is distinct from (l->>'reference_price')::numeric then return 'STAKE_OR_REFERENCE_MISMATCH'; end if;
  if rate is null or rate<0 or rate>0.05 or r->'fee'->>'formulaVersion' is distinct from 'POLYMARKET_TAKER_FEE_C_RATE_P_1MP_V1'
    or r->'fee'->>'source' is distinct from 'GAMMA_MARKETS_BY_CLOB_TOKEN_ID' then return 'FEE_UNKNOWN'; end if;
  if minimum is null or minimum<=0 or tick is null or tick not in (0.1,0.01,0.005,0.0025,0.001,0.0001)
    or (r->>'minOrderSize')::numeric is distinct from minimum or (r->>'tickSize')::numeric is distinct from tick then return 'MINIMUM_OR_TICK_UNKNOWN'; end if;
  if jsonb_typeof(b->'asks') is distinct from 'array' or jsonb_array_length(b->'asks')=0 then return 'NO_ASKS'; end if;
  for a in select value from jsonb_array_elements(b->'asks') loop
    if jsonb_typeof(a->'price') is distinct from 'number' or jsonb_typeof(a->'size') is distinct from 'number' then return 'BOOK_INVALID'; end if;
    price := (a->>'price')::numeric; size := (a->>'size')::numeric;
    if price<=0 or price>=1 or size<=0 or price<previous or mod(price,tick)<>0 then return 'BOOK_INVALID'; end if;
    previous:=price; available:=available+price*size;
    if remain>0 then
      spend:=least(remain,price*size); shares:=shares+spend/price; fee:=fee+(spend/price)*rate*price*(1-price);
      remain:=remain-spend; max_price:=price; levels:=levels+1;
    end if;
  end loop;
  if remain>0 then return 'INSUFFICIENT_DEPTH'; end if;
  -- Both actual fill shares and encoded market-order shares must meet the current provider minimum.
  if shares<minimum or trunc(2.5/max_price,2)<minimum then return 'BELOW_MIN_ORDER_SIZE'; end if;
  if abs(shares-(r->>'shares')::numeric)>0.000000001 or (r->>'shares') is null
    or round(2.5/shares,6) is distinct from (r->>'vwap')::numeric
    or (l->>'executable_buy_price')::numeric is distinct from (r->>'vwap')::numeric
    or l->>'executable_price_authority' is distinct from 'CLOB_DEPTH_VWAP'
    or abs(fee-(r->'fee'->>'usd')::numeric)>0.000000001 or (r->'fee'->>'usd') is null
    or abs(2.5+fee-(r->>'allInCostUsd')::numeric)>0.000000001 or (r->>'allInCostUsd') is null
    or abs(available-(r->>'depthAvailableUsd')::numeric)>0.000000001 or (r->>'depthAvailableUsd') is null
    or (r->>'depthLevelsUsed')::integer is distinct from levels or (r->>'bestAsk')::numeric is distinct from (b->'asks'->0->>'price')::numeric
    then return 'FILL_OR_FEE_MISMATCH'; end if;
  if (l->>'reference_price')::numeric<=0 or (l->>'reference_price')::numeric>=1
    or round(2.5/shares,6)-(l->>'reference_price')::numeric>0.03 then return 'PRICE_MOVED_AGAINST_REFERENCE'; end if;
  return null;
exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range or division_by_zero then
  return 'EVIDENCE_INVALID';
end $$;

create function public.forward_buy_receipt_guard_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare reason text; ledger_persisted timestamptz;
begin
  if tg_op<>'INSERT' then raise exception 'IMMUTABLE_BUY_RECEIPT'; end if;
  if octet_length(new.ledger_payload::text)+octet_length(new.quote_evidence::text)>1048576 then raise exception 'RECEIPT_BUDGET_EXCEEDED'; end if;
  new.model_id:=new.ledger_payload->>'model_id'; new.economic_unit_key:=new.ledger_payload->>'economic_unit_key';
  new.condition_id:=new.ledger_payload->>'condition_id'; new.selected_token_id:=new.ledger_payload->>'selected_token_id';
  new.input_digest:=public.forward_buy_input_digest_v1(new.ledger_payload,new.quote_evidence,new.requested_rejection);
  new.db_received_at:=clock_timestamp(); new.db_persisted_at:=clock_timestamp();
  if new.outcome='ACCEPTED' then
    reason:=public.forward_buy_rejection_v1(new.ledger_payload,new.quote_evidence);
    if reason is not null then raise exception 'RECEIPT_EVIDENCE_REJECTED:%',reason; end if;
    if new.requested_rejection is not null or new.ledger_row_key is distinct from new.ledger_payload->>'row_key' then raise exception 'BUY_RECEIPT_LINK_MISMATCH'; end if;
    select first_persisted_at into ledger_persisted from public.prospective_selection_shadow_runtime where row_key=new.ledger_row_key;
  end if;
  new.canonical_version:='PG_JSONB_TEXT_V1';
  new.receipt_canonical:=jsonb_build_object('attemptId',new.attempt_id,'ledger',new.ledger_payload,'evidence',new.quote_evidence,
    'outcome',new.outcome,'rejectionReason',new.rejection_reason,'dbReceivedAt',new.db_received_at,'dbPersistedAt',new.db_persisted_at,'ledgerFirstPersistedAt',ledger_persisted)::text;
  new.receipt_digest:=encode(sha256(convert_to(new.receipt_canonical,'UTF8')),'hex');
  return new;
end $$;
create trigger forward_buy_receipt_immutable_row before insert or update or delete on public.forward_buy_receipt_attempts for each row execute function public.forward_buy_receipt_guard_v1();
create trigger forward_buy_receipt_immutable_truncate before truncate on public.forward_buy_receipt_attempts for each statement execute function public.forward_buy_receipt_guard_v1();

create function public.forward_buy_link_guard_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare key text; n bigint; bad text;
begin
  if tg_table_name='prospective_selection_shadow_runtime' then
    if new.executable_buy_price is null then return null; end if; key:=new.row_key;
  else
    if new.outcome<>'ACCEPTED' then return null; end if; key:=new.ledger_row_key;
  end if;
  select count(*) into n from public.forward_buy_receipt_attempts a join public.prospective_selection_shadow_runtime l on l.row_key=a.ledger_row_key
  where a.outcome='ACCEPTED' and l.row_key=key and l.row_kind='LEDGER' and l.contract_version='FORWARD_BET_V1'
    and a.model_id=l.model_id and a.economic_unit_key=l.economic_unit_key and a.condition_id=l.condition_id and a.selected_token_id=l.selected_token_id
    and a.ledger_payload->>'candidate_identity'=l.candidate_identity and (a.ledger_payload->>'observed_at')::timestamptz=l.observed_at
    and (a.ledger_payload->>'decision_generated_at')::timestamptz=l.decision_generated_at
    and (a.ledger_payload->>'provider_quote_at')::timestamptz=l.provider_quote_at and (a.ledger_payload->>'executable_quote_at')::timestamptz=l.executable_quote_at
    and (a.ledger_payload->>'reference_price')::numeric=l.reference_price and (a.ledger_payload->>'executable_buy_price')::numeric=l.executable_buy_price
    and a.ledger_payload->>'executable_price_authority'=l.executable_price_authority and l.canonical_game_key=a.economic_unit_key;
  if n<>1 then raise exception 'BUY_RECEIPT_LINK_MISMATCH'; end if;
  select public.forward_buy_rejection_v1(ledger_payload,quote_evidence) into bad from public.forward_buy_receipt_attempts where ledger_row_key=key and outcome='ACCEPTED';
  if bad is not null then raise exception 'RECEIPT_EVIDENCE_REJECTED:%',bad; end if;
  return null;
end $$;
create constraint trigger forward_buy_ledger_receipt_link after insert or update on public.prospective_selection_shadow_runtime deferrable initially deferred for each row execute function public.forward_buy_link_guard_v1();
create constraint trigger forward_buy_receipt_ledger_link after insert on public.forward_buy_receipt_attempts deferrable initially deferred for each row execute function public.forward_buy_link_guard_v1();

create function public.forward_buy_attempt_result_v1(id uuid) returns jsonb
language sql security invoker set search_path=pg_catalog,public as $$
  select jsonb_build_object('status',outcome,'attemptId',attempt_id,'ledgerRowKey',ledger_row_key,'rejectionReason',rejection_reason,
    'receiptCanonical',receipt_canonical,'receiptDigest',receipt_digest,'dbPersistedAt',db_persisted_at)
  from public.forward_buy_receipt_attempts where attempt_id=id;
$$;

create function public.record_forward_buy_attempt_v1(p_id uuid,l jsonb,e jsonb,requested_reason text default null) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare prior_digest text; reason text; key text; inserted_key text;
begin
  if p_id is null or l is null or e is null then raise exception 'MISSING_ATTEMPT_INPUT'; end if;
  if octet_length(l::text)+octet_length(e::text)>1048576 then raise exception 'RECEIPT_BUDGET_EXCEEDED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select input_digest into prior_digest from public.forward_buy_receipt_attempts where attempt_id=p_id;
  if prior_digest is not null then
    if prior_digest<>public.forward_buy_input_digest_v1(l,e,requested_reason) then raise exception 'ATTEMPT_ID_CONFLICT'; end if;
    return public.forward_buy_attempt_result_v1(p_id)||jsonb_build_object('status','REPLAY');
  end if;
  if requested_reason is not null and requested_reason not in ('BOOK_UNAVAILABLE','FEE_UNKNOWN','IDENTITY_UNPROVEN') then raise exception 'UNSUPPORTED_REJECTION_REASON'; end if;
  if l->>'model_id' is not null and l->>'economic_unit_key' is not null then
    perform pg_advisory_xact_lock(hashtextextended((l->>'model_id')||':'||(l->>'economic_unit_key'),0));
  end if;
  reason:=coalesce(requested_reason,public.forward_buy_rejection_v1(l,e)); key:=l->>'row_key';
  if reason is null then
    if exists(select 1 from public.prospective_selection_shadow_runtime where row_key=key) then reason:='LEDGER_KEY_CONFLICT';
    elsif exists(select 1 from public.prospective_selection_shadow_runtime where model_id=l->>'model_id' and economic_unit_key=l->>'economic_unit_key') then reason:='ECONOMIC_UNIT_CONFLICT'; end if;
  end if;
  if reason is null then
    begin
      insert into public.prospective_selection_shadow_runtime(
        row_key,row_kind,model_id,decision_date,candidate_identity,physical_event_key,decision_timestamp,event_start,entry_price,sport_family,condition_id,selected_token_id,settlement_state,
        contract_version,canonical_game_key,game_identity_basis,scope_basis,provider_event_id,market_family,market_type,period_scope,selected_outcome,observed_at,decision_generated_at,scheduled_start_at,
        reference_price,reference_price_source,reference_price_type,reference_price_acquired_at,provider_quote_at,executable_buy_price,executable_price_authority,executable_quote_at,model_version,selection_reason,decision_kind,economic_unit_key)
      values(key,'LEDGER',l->>'model_id',(l->>'decision_date')::date,l->>'candidate_identity',l->>'physical_event_key',(l->>'decision_timestamp')::timestamptz,(l->>'event_start')::timestamptz,
        (l->>'entry_price')::numeric,l->>'sport_family',l->>'condition_id',l->>'selected_token_id','UNQUERIED','FORWARD_BET_V1',l->>'canonical_game_key',l->>'game_identity_basis',l->>'scope_basis',l->>'provider_event_id',
        l->>'market_family',l->>'market_type',l->>'period_scope',l->>'selected_outcome',(l->>'observed_at')::timestamptz,(l->>'decision_generated_at')::timestamptz,(l->>'scheduled_start_at')::timestamptz,
        (l->>'reference_price')::numeric,l->>'reference_price_source',l->>'reference_price_type',(l->>'reference_price_acquired_at')::timestamptz,(l->>'provider_quote_at')::timestamptz,
        (l->>'executable_buy_price')::numeric,l->>'executable_price_authority',(l->>'executable_quote_at')::timestamptz,l->>'model_version',l->>'selection_reason','BET',l->>'economic_unit_key') returning row_key into inserted_key;
      insert into public.forward_buy_receipt_attempts(attempt_id,ledger_payload,quote_evidence,requested_rejection,outcome,ledger_row_key)
        values(p_id,l,e,requested_reason,'ACCEPTED',inserted_key);
    exception when unique_violation then reason:='ECONOMIC_UNIT_CONFLICT'; end;
  end if;
  if reason is not null then
    insert into public.forward_buy_receipt_attempts(attempt_id,ledger_payload,quote_evidence,requested_rejection,outcome,rejection_reason)
      values(p_id,l,e,requested_reason,'REJECTED',reason);
  end if;
  return public.forward_buy_attempt_result_v1(p_id);
end $$;

revoke all on function public.forward_buy_input_digest_v1(jsonb,jsonb,text),public.forward_buy_rejection_v1(jsonb,jsonb),public.forward_buy_receipt_guard_v1(),public.forward_buy_link_guard_v1(),public.forward_buy_attempt_result_v1(uuid),public.record_forward_buy_attempt_v1(uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.forward_buy_input_digest_v1(jsonb,jsonb,text),public.forward_buy_rejection_v1(jsonb,jsonb),public.forward_buy_receipt_guard_v1(),public.forward_buy_link_guard_v1(),public.forward_buy_attempt_result_v1(uuid),public.record_forward_buy_attempt_v1(uuid,jsonb,jsonb,text) to service_role;
