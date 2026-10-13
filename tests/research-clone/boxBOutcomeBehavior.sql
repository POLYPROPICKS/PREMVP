-- Box B behavioural semantic test. Run by boxBOutcomeBehavior.sh AFTER the operator script
-- has been applied as the owner. Every probe either passes or raises; psql runs ON_ERROR_STOP.
-- Synthetic fixtures live only inside the surrounding transaction and are rolled back.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

create or replace function pg_temp.expect_error(p_sql text, p_state text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = any (string_to_array(p_state, ',')) then
      raise notice 'PASS %: % (%)', p_label, sqlstate, left(sqlerrm, 70);
      return;
    end if;
    raise exception 'FAIL %: expected %, got % (%)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL %: statement succeeded but must be rejected', p_label;
end;
$$;

create or replace function pg_temp.assert_true(p_cond boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
  raise notice 'PASS %', p_label;
end;
$$;

-- ============ T1 independence / structure ============
select pg_temp.assert_true(
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name like 'market_outcome_%'
                 and column_name ~* '(bet_row|roi|stake|ledger|paper|decision|pnl|profit)'),
  'T1.1 no bet/ROI/stake/ledger/paper-decision columns in Box B');
select pg_temp.assert_true(
  not exists (select 1 from pg_constraint c
               where c.contype = 'f'
                 and (c.conrelid::regclass::text like 'market_outcome_%' or c.confrelid::regclass::text like 'market_outcome_%')
                 and not (c.conrelid::regclass::text like 'market_outcome_%' and c.confrelid::regclass::text like 'market_outcome_%')),
  'T1.2 no foreign key crossing the Box B boundary');
select pg_temp.assert_true(
  not exists (select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
               join pg_class v on v.oid = r.ev_class
               where d.refobjid in ('public.market_outcome_revisions'::regclass, 'public.market_outcome_provider_receipts'::regclass)
                 and v.relname not like 'market_outcome_%'),
  'T1.3 no outside view depends on Box B');
select pg_temp.assert_true(
  (select count(*) from public.research_inplay_core_path_observations) = 3
  and (select md5(string_agg(x::text, '|' order by x::text)) from (select * from public.research_inplay_core_path_observations) x)
      = current_setting('boxb.obs_md5'),
  'T1.4 observation table rows unchanged by Box B apply');
select pg_temp.assert_true(
  (select md5(string_agg(attname || atttypid::text, ',' order by attnum)) from pg_attribute
    where attrelid = 'public.research_inplay_core_path_observations'::regclass and attnum > 0 and not attisdropped)
  = current_setting('boxb.obs_cols_md5')
  and (select relacl::text from pg_class where oid = 'public.research_inplay_core_path_observations'::regclass)
      is not distinct from nullif(current_setting('boxb.obs_acl'), '')
  and (select count(*) from pg_trigger where tgrelid = 'public.research_inplay_core_path_observations'::regclass) = 0,
  'T1.5 observation table columns/ACL/triggers unchanged');

-- ============ T2 pilot content ============
select pg_temp.assert_true((select count(*) from public.market_outcome_revisions) = 20, 'T2.1 20 revisions');
select pg_temp.assert_true((select count(*) from public.market_outcome_provider_receipts) = 41, 'T2.2 41 receipts');
select pg_temp.assert_true(
  (select count(*) from public.market_outcome_revisions where outcome_status = 'FINAL'
      and revision_no = 1 and prev_revision_digest is null and winner_token_id is not null) = 20,
  'T2.3 every pilot row is FINAL revision 1 with a winner');
select pg_temp.assert_true(
  not exists (select 1 from public.market_outcome_provider_receipts
               where raw_digest <> encode(sha256(convert_to(raw_body, 'UTF8')), 'hex')),
  'T2.4 every stored receipt body re-hashes to its digest');
select pg_temp.assert_true(
  (select count(distinct condition_id) from public.market_outcome_current where outcome_status = 'FINAL') = 20,
  'T2.5 current view exposes 20 FINAL markets');

-- ============ T3 ACL matrix ============
select pg_temp.assert_true(
  not exists (select 1 from pg_roles r, unnest(array['market_outcome_revisions','market_outcome_provider_receipts','market_outcome_current']) t
               where r.rolname in ('anon', 'authenticated', 'blind_model_reader')
                 and has_table_privilege(r.rolname, 'public.' || t, 'select,insert,update,delete,truncate,references,trigger')),
  'T3.1 anon/authenticated/blind_model_reader hold zero privileges');
select pg_temp.assert_true(
  not exists (select 1 from pg_roles r
               where r.rolname in ('anon', 'authenticated', 'blind_model_reader')
                 and has_function_privilege(r.rolname, 'public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)', 'execute'))
  and not has_function_privilege('public', 'public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)', 'execute')
  and has_function_privilege('service_role', 'public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)', 'execute'),
  'T3.10 validator EXECUTE denied to anon/authenticated/PUBLIC/blind_model_reader, kept for service_role');
select pg_temp.assert_true(
  not exists (select 1 from pg_roles r
               where r.rolname in ('anon', 'authenticated', 'blind_model_reader', 'service_role')
                 and has_sequence_privilege(r.rolname, pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'), 'usage,select,update'))
  and not has_sequence_privilege('public', pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'), 'usage,select,update'),
  'T3.11 receipt identity sequence is closed to every application role');
select pg_temp.assert_true(
  not exists (select 1 from information_schema.role_table_grants
               where grantee = 'PUBLIC' and table_schema = 'public' and table_name like 'market_outcome_%'),
  'T3.2 PUBLIC holds zero privileges');
select pg_temp.assert_true(
  has_table_privilege('service_role', 'public.market_outcome_revisions', 'select,insert')
  and not has_table_privilege('service_role', 'public.market_outcome_revisions', 'update')
  and not has_table_privilege('service_role', 'public.market_outcome_revisions', 'delete')
  and not has_table_privilege('service_role', 'public.market_outcome_revisions', 'truncate')
  and not has_table_privilege('service_role', 'public.market_outcome_provider_receipts', 'update')
  and not has_table_privilege('service_role', 'public.market_outcome_provider_receipts', 'delete')
  and not has_table_privilege('service_role', 'public.market_outcome_provider_receipts', 'truncate'),
  'T3.3 service_role is select+insert only');
select pg_temp.assert_true(
  (select bool_and(relrowsecurity) from pg_class where relname in ('market_outcome_revisions', 'market_outcome_provider_receipts')),
  'T3.4 RLS enabled on both tables');
set role blind_model_reader;
select pg_temp.expect_error('select count(*) from public.market_outcome_revisions', '42501', 'T3.5 blind_model_reader cannot read revisions');
select pg_temp.expect_error('select count(*) from public.market_outcome_current', '42501', 'T3.6 blind_model_reader cannot read current view');
select pg_temp.expect_error('select count(*) from public.market_outcome_provider_receipts', '42501', 'T3.7 blind_model_reader cannot read receipts');
reset role;
set role anon;
select pg_temp.expect_error('select 1 from public.market_outcome_revisions', '42501', 'T3.8 anon denied');
reset role;
set role authenticated;
select pg_temp.expect_error('select 1 from public.market_outcome_current', '42501', 'T3.9 authenticated denied');
reset role;

-- ============ T4 append-only (owner AND service_role) ============
select pg_temp.expect_error('update public.market_outcome_revisions set status_reason = ''x''', '23001', 'T4.1 owner UPDATE revisions');
select pg_temp.expect_error('delete from public.market_outcome_revisions', '23001', 'T4.2 owner DELETE revisions');
select pg_temp.expect_error('truncate public.market_outcome_revisions', '23001', 'T4.3 owner TRUNCATE revisions');
select pg_temp.expect_error('update public.market_outcome_provider_receipts set http_status = 500', '23001', 'T4.4 owner UPDATE receipts');
select pg_temp.expect_error('delete from public.market_outcome_provider_receipts', '23001', 'T4.5 owner DELETE receipts');
select pg_temp.expect_error('truncate public.market_outcome_provider_receipts', '23001,0A000', 'T4.6 owner TRUNCATE receipts');
select pg_temp.expect_error('truncate public.market_outcome_provider_receipts, public.market_outcome_revisions', '23001', 'T4.6b owner TRUNCATE both tables');
select pg_temp.expect_error('insert into public.market_outcome_provider_receipts (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest) select provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest from public.market_outcome_provider_receipts limit 1 on conflict (provider, request_kind, request_key, raw_digest) do update set http_status = 500', '23001', 'T4.7 upsert-update path blocked');
set role service_role;
select pg_temp.expect_error('update public.market_outcome_revisions set status_reason = ''x''', '42501', 'T4.8 service_role UPDATE revisions');
select pg_temp.expect_error('delete from public.market_outcome_revisions', '42501', 'T4.9 service_role DELETE revisions');
select pg_temp.expect_error('truncate public.market_outcome_revisions', '42501', 'T4.10 service_role TRUNCATE revisions');
select pg_temp.expect_error('delete from public.market_outcome_provider_receipts', '42501', 'T4.11 service_role DELETE receipts');
reset role;

-- ============ T5 digest + validation (rolled-back fixtures) ============
begin;
select pg_temp.expect_error($q$insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
  values ('gamma','condition_id','0x00','https://x',200, now(), 'abc', repeat('0',64))$q$, '23514', 'T5.1 wrong digest rejected');
select pg_temp.expect_error($q$insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
  values ('ftp','condition_id','0x00','https://x',200, now(), 'abc', encode(sha256('abc'),'hex'))$q$, '23514', 'T5.2 unknown provider rejected');
rollback;

begin;
-- fixture helpers: market with the lowest condition_id
create temp table fx on commit drop as
select r.condition_id, r.winner_token_id, r.market_token_ids, r.resolved_at, r.resolution_time_source,
       r.gamma_receipt_id g_id, r.clob_receipt_id c_id,
       (select t from jsonb_array_elements_text(r.market_token_ids) t where t <> r.winner_token_id limit 1) loser,
       r.revision_digest d1
  from public.market_outcome_revisions r order by r.condition_id limit 1;
grant select on fx to service_role;

select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select condition_id, 'FINAL', loser, loser, loser, market_token_ids, g_id, c_id, resolved_at, resolution_time_source, now() from fx$q$,
  'P0001', 'T5.3 FINAL naming the LOSER token is refused by receipt validation');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select condition_id, 'FINAL', winner_token_id, winner_token_id, loser, market_token_ids, g_id, c_id, resolved_at, resolution_time_source, now() from fx$q$,
  '23514', 'T5.4 FINAL with gamma/clob winner disagreement refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, checked_at)
  select condition_id, 'FINAL', winner_token_id, winner_token_id, winner_token_id, market_token_ids, g_id, c_id, now() from fx$q$,
  'P0001,23514', 'T5.5 FINAL without resolution time/source refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select condition_id, 'VOID', g_id, c_id, resolved_at, resolution_time_source, now() from fx$q$,
  'P0001', 'T5.6 VOID on receipts that show a winner refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_receipt_id, clob_receipt_id, checked_at)
  select condition_id, 'PENDING', winner_token_id, g_id, c_id, now() from fx$q$,
  '23514', 'T5.7 PENDING carrying a winner refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, checked_at)
  select condition_id, 'CONFLICT', g_id, c_id, now() from fx$q$,
  '23514', 'T5.8 CONFLICT without reason refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, checked_at)
  select '0xABC', 'PENDING', g_id, c_id, now() from fx$q$,
  '23514', 'T5.9 malformed condition_id refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, revision_no, outcome_status, gamma_receipt_id, clob_receipt_id, checked_at)
  select condition_id, 7, 'PENDING', g_id, c_id, now() from fx$q$,
  'P0001', 'T5.10 caller-supplied wrong revision_no refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, checked_at)
  select condition_id, 'PENDING', c_id, g_id, now() from fx$q$,
  'P0001', 'T5.11 swapped provider receipts refused');
-- T5.12/13 resolved_at must equal the provider's own timestamp under a known source label
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select condition_id, 'FINAL', winner_token_id, winner_token_id, winner_token_id, market_token_ids, g_id, c_id,
         resolved_at + interval '1 hour', resolution_time_source, now() from fx$q$,
  'P0001', 'T5.12 FINAL with a resolved_at the receipt does not show refused');
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select condition_id, 'FINAL', winner_token_id, winner_token_id, winner_token_id, market_token_ids, g_id, c_id,
         resolved_at, 'made.up', now() from fx$q$,
  'P0001', 'T5.13 FINAL with an unknown resolution_time_source refused');
-- T5.14 VOID with no price evidence (gamma outcomePrices stripped, CLOB winner flags cleared): NULL-propagation guard
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
select 'gamma', 'condition_id', g.request_key, g.request_url, 200, now(), b.t, encode(sha256(convert_to(b.t, 'UTF8')), 'hex')
  from public.market_outcome_provider_receipts g,
       lateral (select jsonb_set(g.raw_body::jsonb, '{0}', (g.raw_body::jsonb -> 0) - 'outcomePrices')::text t) b
 where g.receipt_id = (select g_id from fx);
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
select 'clob', 'condition_id', c.request_key, c.request_url, 200, now(), b.t, encode(sha256(convert_to(b.t, 'UTF8')), 'hex')
  from public.market_outcome_provider_receipts c,
       lateral (select jsonb_set(c.raw_body::jsonb, '{tokens}',
                  (select jsonb_agg(jsonb_set(t, '{winner}', 'false'::jsonb)) from jsonb_array_elements(c.raw_body::jsonb -> 'tokens') t))::text t) b
 where c.receipt_id = (select c_id from fx);
select pg_temp.expect_error($q$insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
  select f.condition_id, 'VOID',
         (select receipt_id from public.market_outcome_provider_receipts where provider = 'gamma' and raw_body not like '%outcomePrices%'),
         (select max(receipt_id) from public.market_outcome_provider_receipts where provider = 'clob'),
         f.resolved_at, f.resolution_time_source, now() from fx f$q$,
  'P0001', 'T5.14 VOID with missing outcomePrices refused');
rollback;

-- ============ T6 revision chain + idempotency (service_role writer) ============
begin;
create temp table fx on commit drop as
select r.condition_id, r.winner_token_id, r.market_token_ids, r.resolved_at,
       r.gamma_receipt_id g_id, r.clob_receipt_id c_id, r.revision_digest d1
  from public.market_outcome_revisions r order by r.condition_id limit 1;
grant select on fx to service_role;
-- same-evidence re-load of revision 1 is a no-op
set role service_role;
do $$
declare n integer;
begin
  insert into public.market_outcome_revisions
     (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
      gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
   select r.condition_id, 'FINAL', r.winner_token_id, r.gamma_winner_token_id, r.clob_winner_token_id, r.market_token_ids,
          r.gamma_receipt_id, r.clob_receipt_id, r.resolved_at, r.resolution_time_source, now()
     from public.market_outcome_revisions r where r.revision_no = 1 and r.condition_id = (select condition_id from fx);
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL T6.1 identical evidence re-load inserted % rows', n; end if;
  raise notice 'PASS T6.1 identical evidence re-load inserts nothing (service_role)';
end;
$$;
reset role;
select pg_temp.assert_true((select count(*) from public.market_outcome_revisions) = 20, 'T6.2 still 20 revisions');

-- a later, different provider claim: flip the CLOB winner => new receipt + CONFLICT revision
set role service_role;
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
select 'clob', 'condition_id', c.request_key, c.request_url, 200, now() + interval '1 hour', b.t,
       encode(sha256(convert_to(b.t, 'UTF8')), 'hex')
  from public.market_outcome_provider_receipts c,
       lateral (select jsonb_set(c.raw_body::jsonb, '{tokens}',
                  (select jsonb_agg(jsonb_set(t, '{winner}', to_jsonb(not (t ->> 'winner')::boolean))) from jsonb_array_elements(c.raw_body::jsonb -> 'tokens') t))::text t) b
 where c.receipt_id = (select c_id from fx);
insert into public.market_outcome_revisions
  (condition_id, outcome_status, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, checked_at, status_reason)
select f.condition_id, 'CONFLICT', f.winner_token_id,
       (select t from jsonb_array_elements_text(f.market_token_ids) t where t <> f.winner_token_id limit 1),
       f.market_token_ids, f.g_id,
       (select receipt_id from public.market_outcome_provider_receipts order by receipt_id desc limit 1),
       now() + interval '1 hour', 'T6 synthetic provider flip (rolled back)'
  from fx f;
reset role;
select pg_temp.assert_true(
  (select revision_no = 2 and prev_revision_digest = (select d1 from fx) and outcome_status = 'CONFLICT' and winner_token_id is null
     from public.market_outcome_revisions where condition_id = (select condition_id from fx) and revision_no = 2),
  'T6.3 conflict is revision 2, chained to revision 1, no winner');
select pg_temp.assert_true(
  (select revision_digest = encode(sha256(convert_to(concat_ws('|', condition_id, '2', prev_revision_digest, evidence_digest), 'UTF8')), 'hex')
     from public.market_outcome_revisions where condition_id = (select condition_id from fx) and revision_no = 2),
  'T6.4 revision digest recomputes independently');
select pg_temp.assert_true(
  (select outcome_status from public.market_outcome_current where condition_id = (select condition_id from fx)) = 'CONFLICT',
  'T6.5 current view follows the newest claim');

-- provider returns to the original FINAL evidence: accepted as a NEW revision (A->B->A is history)
set role service_role;
insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at)
select r.condition_id, 'FINAL', r.winner_token_id, r.gamma_winner_token_id, r.clob_winner_token_id, r.market_token_ids,
       r.gamma_receipt_id, r.clob_receipt_id, r.resolved_at, r.resolution_time_source, now() + interval '2 hour'
  from public.market_outcome_revisions r where r.revision_no = 1 and r.condition_id = (select condition_id from fx);
reset role;
select pg_temp.assert_true(
  (select max(revision_no) from public.market_outcome_revisions where condition_id = (select condition_id from fx)) = 3,
  'T6.6 A->B->A keeps all three revisions');
-- a failed lookup is recorded but never hides the standing claim
set role service_role;
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetched_at, raw_body, raw_digest)
select 'gamma', 'condition_id', request_key, request_url, 503, now() + interval '3 hour', 'upstream down', encode(sha256('upstream down'), 'hex')
  from public.market_outcome_provider_receipts where receipt_id = (select g_id from fx);
insert into public.market_outcome_revisions (condition_id, outcome_status, gamma_receipt_id, clob_receipt_id, checked_at, status_reason)
select f.condition_id, 'LOOKUP_FAILED',
       (select receipt_id from public.market_outcome_provider_receipts where http_status = 503),
       f.c_id, now() + interval '3 hour', 'gamma 503'
  from fx f;
reset role;
select pg_temp.assert_true(
  (select outcome_status = 'FINAL' and revision_no = 3 and last_checked_at > now() + interval '2 hour'
     from public.market_outcome_current where condition_id = (select condition_id from fx)),
  'T6.7 LOOKUP_FAILED never hides FINAL but advances last_checked_at');
rollback;

select pg_temp.assert_true((select count(*) from public.market_outcome_revisions) = 20
  and (select count(*) from public.market_outcome_provider_receipts) = 41, 'T6.8 fixtures fully rolled back');
\echo BOXB_SEMANTIC_ALL_PASS
