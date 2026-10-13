-- Scratch-cluster test for payload.sql. Run as superuser on a DB where the Box B migration AND payload.sql are applied
-- and roles anon, authenticated, service_role, blind_model_reader, blind_model_writer exist. Prints PASS lines; any failure raises.
\set ON_ERROR_STOP on
set client_min_messages = notice;

-- ---- fixtures (superuser; guards bypassed ONLY for synthetic Box B rows) ----
create temp table fx(k text primary key, cid text, tok text);
insert into fx select k, '0x' || encode(sha256(convert_to('cid-' || k, 'UTF8')), 'hex'), 'tok-' || k
  from unnest(array['A','B','C','D','E','F','G','H','I','J','K','L','M']) k;
insert into public.market_outcome_provider_receipts (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
values ('gamma','condition_id','fx','https://x/g',200,now(),'{}',encode(sha256(convert_to('{}','UTF8')),'hex')),
       ('clob','condition_id','fx','https://x/c',200,now(),'{}',encode(sha256(convert_to('{}','UTF8')),'hex'));
create function pg_temp.rev(p_k text, p_no int, p_status text, p_winner text, p_resolved timestamptz) returns void language plpgsql as $f$
declare c text; g bigint; b bigint;
begin
  select cid into c from fx where k = p_k;
  select receipt_id into g from public.market_outcome_provider_receipts where provider='gamma' and request_key='fx';
  select receipt_id into b from public.market_outcome_provider_receipts where provider='clob' and request_key='fx';
  set local session_replication_role = replica;
  insert into public.market_outcome_revisions (condition_id, revision_no, prev_revision_digest, revision_digest, evidence_digest,
     outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids, gamma_receipt_id, clob_receipt_id,
     resolved_at, resolution_time_source, checked_at, status_reason)
  values (c, p_no, case when p_no = 1 then null else repeat('a',64) end, encode(sha256(convert_to(c||p_no,'UTF8')),'hex'),
     encode(sha256(convert_to('e'||c||p_no,'UTF8')),'hex'), p_status, p_winner, p_winner, p_winner,
     jsonb_build_array('tok-'||p_k, 'other-'||p_k), g, b, p_resolved, case when p_resolved is not null then 'test' end, now(),
     case when p_status = 'CONFLICT' then 'test conflict' end);
  set local session_replication_role = origin;
end $f$;
select pg_temp.rev(k, 1, 'PENDING', null, null) from fx where k in ('A','B','C','D','E');
select pg_temp.rev('G', 1, 'LOOKUP_FAILED', null, null);
select pg_temp.rev('H', 1, 'FINAL', 'tok-H', now() - interval '1 hour');
select pg_temp.rev('J', 1, 'PENDING', null, null);
select pg_temp.rev('K', 1, 'VOID', null, now() - interval '1 hour');
select pg_temp.rev('L', 1, 'CONFLICT', null, null);
select pg_temp.rev('M', 1, 'FINAL', 'tok-M', now() - interval '2 hour');
select pg_temp.rev('M', 2, 'PENDING', null, null);

create function pg_temp.ins(p_k text, p_obs text, p_dec text, p_fee text) returns void language plpgsql as $f$
declare c text; t text; key text;
begin
  c := '0x' || encode(sha256(convert_to('cid-' || p_k, 'UTF8')), 'hex'); t := 'tok-' || p_k;
  key := encode(sha256(convert_to(concat_ws('|', repeat('b',64), p_obs, c, t), 'UTF8')), 'hex');
  if p_dec = 'BET' then
    insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of,
      condition_id, token_id, decision, entry_price, entry_vwap, max_size_usdc, entry_fee_usdc, entry_fee_authority)
    values (key, 'B2', 'v2', repeat('b',64), p_obs, now() - interval '5 min', now() - interval '5 min', c, t, 'BET', 0.4, 0.41, 10,
      case when p_fee = 'UNKNOWN' then null else 0.05 end, p_fee);
  else
    insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of,
      condition_id, token_id, decision, skip_reason)
    values (key, 'B2', 'v2', repeat('b',64), p_obs, now() - interval '5 min', now() - interval '5 min', c, t, 'SKIP', 'below_price_floor');
  end if;
end $f$;

-- ---- T1 model role can INSERT decisions; cannot read ledger or any Box B object ----
set role blind_model_writer;
select pg_temp.ins('A','o1','BET','POLYMARKET_FEE_SCHEDULE'), pg_temp.ins('B','o2','BET','POLYMARKET_FEE_SCHEDULE'),
       pg_temp.ins('C','o3','BET','UNKNOWN'), pg_temp.ins('D','o4','BET','ZERO_FEE_VERIFIED'),
       pg_temp.ins('E','o5','BET','POLYMARKET_FEE_SCHEDULE'), pg_temp.ins('F','o6','BET','POLYMARKET_FEE_SCHEDULE'),
       pg_temp.ins('G','o7','BET','POLYMARKET_FEE_SCHEDULE'), pg_temp.ins('I','o8','SKIP',null),
       pg_temp.ins('J','o13','BET','POLYMARKET_FEE_SCHEDULE');
do $$ begin raise notice 'PASS T1.1 model role inserted 8 BET + 1 SKIP'; end $$;
do $$ declare o text; begin
  foreach o in array array['public.market_outcome_current','public.market_outcome_revisions','public.market_outcome_provider_receipts',
     'public.blind_forward_decision_ledger','public.blind_forward_ledger_box_b_join_v1','public.blind_forward_scoreboard_v1'] loop
    begin execute 'select count(*) from ' || o; raise exception 'LEAK: model role read %', o;
    exception when insufficient_privilege then null; end;
  end loop;
  raise notice 'PASS T1.2 model role denied on Box B, ledger select, join and scoreboard (42501)';
end $$;
do $$ begin
  begin perform pg_temp.ins('H','o9','BET','POLYMARKET_FEE_SCHEDULE'); raise exception 'LEAK: FINAL market accepted';
  exception when check_violation then null; end;
  begin perform pg_temp.ins('K','o14','BET','POLYMARKET_FEE_SCHEDULE'); raise exception 'LEAK: VOID market accepted';
  exception when check_violation then null; end;
  begin perform pg_temp.ins('L','o15','BET','POLYMARKET_FEE_SCHEDULE'); raise exception 'LEAK: CONFLICT market accepted';
  exception when check_violation then null; end;
  begin perform pg_temp.ins('M','o16','BET','POLYMARKET_FEE_SCHEDULE'); raise exception 'LEAK: FINAL->PENDING regressed market accepted';
  exception when check_violation then null; end;
  raise notice 'PASS T1.3 FINAL / VOID / CONFLICT / FINAL->PENDING-regressed markets rejected by definer guard without Box B access';
end $$;
do $$ begin
  begin update public.blind_forward_decision_ledger set decision = 'SKIP'; raise exception 'LEAK'; exception when insufficient_privilege then null; end;
  begin delete from public.blind_forward_decision_ledger; raise exception 'LEAK'; exception when insufficient_privilege then null; end;
  raise notice 'PASS T1.4 model role has no UPDATE/DELETE privilege';
end $$;
reset role;

-- ---- T2 append-only even for superuser; replay does not mutate ----
do $$ declare d1 text; d2 text; f1 timestamptz; f2 timestamptz; n int; begin
  begin update public.blind_forward_decision_ledger set model_id = 'x'; raise exception 'LEAK'; exception when integrity_constraint_violation then null; end;
  begin delete from public.blind_forward_decision_ledger; raise exception 'LEAK'; exception when integrity_constraint_violation then null; end;
  begin truncate public.blind_forward_decision_ledger; raise exception 'LEAK'; exception when integrity_constraint_violation then null; end;
  raise notice 'PASS T2.1 UPDATE/DELETE/TRUNCATE rejected for table owner/superuser';
  select record_digest, frozen_at into d1, f1 from public.blind_forward_decision_ledger where observation_id = 'o1';
  perform pg_sleep(0.05);
  insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of,
      condition_id, token_id, decision, entry_price, entry_vwap, max_size_usdc, entry_fee_usdc, entry_fee_authority)
    select decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, 'BET', 0.9, 0.9, 99, 1, 'ZERO_FEE_VERIFIED'
      from public.blind_forward_decision_ledger where observation_id = 'o1'
    on conflict (decision_key) do nothing;
  select record_digest, frozen_at into d2, f2 from public.blind_forward_decision_ledger where observation_id = 'o1';
  select count(*) into n from public.blind_forward_decision_ledger;
  if d1 <> d2 or f1 <> f2 or n <> 9 then raise exception 'replay mutated ledger'; end if;
  begin
    insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of,
      condition_id, token_id, decision, entry_price, entry_vwap, max_size_usdc, entry_fee_usdc, entry_fee_authority)
    select decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, 'BET', 0.9, 0.9, 99, 1, 'ZERO_FEE_VERIFIED'
      from public.blind_forward_decision_ledger where observation_id = 'o1';
    raise exception 'LEAK: duplicate key accepted';
  exception when unique_violation then null; end;
  raise notice 'PASS T2.2 replay (ON CONFLICT DO NOTHING / duplicate) leaves digest and frozen_at unchanged; 9 rows';
end $$;

-- ---- T3 server-stamped frozen_at, future observation, BET economics integrity ----
do $$ declare f timestamptz; c text; begin
  select cid into c from fx where k = 'I';
  insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, decision, skip_reason, frozen_at)
  values (encode(sha256(convert_to(concat_ws('|', repeat('b',64), 'o10', c, 'tok-I'), 'UTF8')), 'hex'), 'B2','v2',repeat('b',64),'o10', now(), now(), c, 'tok-I','SKIP','x', '2000-01-01');
  select frozen_at into f from public.blind_forward_decision_ledger where observation_id = 'o10';
  if f < now() - interval '1 minute' then raise exception 'client frozen_at honoured'; end if;
  raise notice 'PASS T3.1 client-supplied frozen_at ignored (server clock)';
  begin
    insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, decision, skip_reason)
    values (encode(sha256(convert_to(concat_ws('|', repeat('b',64), 'o11', c, 'tok-I'), 'UTF8')), 'hex'), 'B2','v2',repeat('b',64),'o11', now()+interval '1 hour', now()+interval '1 hour', c, 'tok-I','SKIP','x');
    raise exception 'LEAK future obs';
  exception when check_violation then null; end;
  begin
    insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, decision, entry_price)
    values (encode(sha256(convert_to(concat_ws('|', repeat('b',64), 'o12', c, 'tok-I'), 'UTF8')), 'hex'), 'B2','v2',repeat('b',64),'o12', now(), now(), c, 'tok-I','BET', 0.4);
    raise exception 'LEAK incomplete BET';
  exception when check_violation then null; end;
  raise notice 'PASS T3.2 future observation and incomplete BET economics rejected';
end $$;

-- ---- T4 join: PENDING stage ----
do $$ declare r text; begin
  select string_agg(join_state || ':' || n, ',' order by join_state) into r from
    (select join_state, count(*) n from public.blind_forward_ledger_box_b_join_v1 group by 1) s;
  if r <> 'LOOKUP_FAILED:1,PENDING:7' then raise exception 'unexpected pre-resolution states %', r; end if;
  raise notice 'PASS T4.1 before any outcome: % (no false LOSS)', r;
end $$;

-- ---- T5 markets resolve later (resolved_at after frozen_at) ----
select pg_temp.rev('A', 2, 'FINAL', 'tok-A', now() + interval '1 hour');
select pg_temp.rev('B', 2, 'FINAL', 'other-B', now() + interval '1 hour');
select pg_temp.rev('C', 2, 'FINAL', 'tok-C', now() + interval '1 hour');
select pg_temp.rev('D', 2, 'VOID', null, now() + interval '1 hour');
select pg_temp.rev('E', 2, 'CONFLICT', null, null);
select pg_temp.rev('J', 2, 'FINAL', 'tok-J', now() - interval '1 hour'); -- resolved BEFORE frozen_at: hindsight
do $$ declare r text; begin
  select string_agg(join_state || ':' || n, ',' order by join_state) into r from
    (select join_state, count(*) n from public.blind_forward_ledger_box_b_join_v1 group by 1) s;
  if r <> 'CONFLICT:1,FINAL_LOSS:1,FINAL_WIN:1,LOOKUP_FAILED:1,NOT_FORWARD:1,PENDING:1,UNKNOWN_FEE_AUTHORITY:1,VOID:1' then raise exception 'unexpected states %', r; end if;
  raise notice 'PASS T5.1 all eight states (7 required + NOT_FORWARD) reachable and separate: %', r;
  if exists (select 1 from public.blind_forward_ledger_box_b_join_v1 where join_state in ('FINAL_WIN','FINAL_LOSS') and entry_fee_authority = 'UNKNOWN') then raise exception 'fee unknown scored'; end if;
  if exists (select 1 from public.blind_forward_ledger_box_b_join_v1 where outcome_result is not null and join_state not in ('FINAL_WIN','FINAL_LOSS')) then raise exception 'outcome_result on unscored row'; end if;
  if (select count(*) from public.blind_forward_ledger_box_b_join_v1 where outcome_result is not null) <> 2 then raise exception 'outcome_result count'; end if;
  raise notice 'PASS T5.2 UNKNOWN-fee and NOT_FORWARD rows never scored; outcome_result set only on FINAL_WIN/FINAL_LOSS (2 rows)';
  if exists (select 1 from public.blind_forward_scoreboard_v1 where net_roi <> 'NOT_PROVEN') then raise exception 'ROI claimed'; end if;
  raise notice 'PASS T5.3 scoreboard net_roi = NOT_PROVEN on every row';
end $$;

-- ---- T6 reconciler role: select join yes; insert no ----
set role service_role;
do $$ declare r text; begin
  select string_agg(join_state || ':' || n, ',' order by join_state) into r from
    (select join_state, count(*) n from public.blind_forward_ledger_box_b_join_v1 group by 1) s;
  if r <> 'CONFLICT:1,FINAL_LOSS:1,FINAL_WIN:1,LOOKUP_FAILED:1,NOT_FORWARD:1,PENDING:1,UNKNOWN_FEE_AUTHORITY:1,VOID:1' then raise exception 'service_role join states %', r; end if;
  begin insert into public.blind_forward_decision_ledger (decision_key, model_id, model_version, model_hash, observation_id, observed_at, as_of, condition_id, token_id, decision, skip_reason)
    values ('x','x','x',repeat('b',64),'x',now(),now(),'0x'||repeat('0',64),'x','SKIP','x'); raise exception 'LEAK'; exception when insufficient_privilege then null; end;
  raise notice 'PASS T6.1 service_role reads join, cannot write decisions (reconciliation separated from decision writes)';
end $$;
reset role;
do $$ declare o text; b text; begin
  foreach o in array array['public.blind_forward_decision_ledger','public.blind_forward_ledger_box_b_join_v1','public.blind_forward_scoreboard_v1'] loop
    foreach b in array array['anon','authenticated','blind_model_reader'] loop
      if has_table_privilege(b, o, 'select,insert,update,delete,truncate,references,trigger') or has_any_column_privilege(b, o, 'select,insert,update,references') then raise exception 'ACL leak % %', b, o; end if;
    end loop;
  end loop;
  if has_function_privilege('blind_model_writer','public.blind_forward_ledger_guard()','execute')
     or has_function_privilege('service_role','public.blind_forward_ledger_guard()','execute') then raise exception 'guard exec'; end if;
  if has_table_privilege('service_role','public.blind_forward_decision_ledger','insert,update,delete,truncate')
     or has_table_privilege('service_role','public.blind_forward_ledger_box_b_join_v1','insert,update,delete') then raise exception 'service_role write grant'; end if;
  raise notice 'PASS T6.2 anon/authenticated/blind_model_reader hold zero privileges on ledger objects';
end $$;
select 'ALL_TESTS_PASSED';
