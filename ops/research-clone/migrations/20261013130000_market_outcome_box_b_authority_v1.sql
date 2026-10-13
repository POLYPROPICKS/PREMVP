-- DBCLONE ONLY: nppznoujvnyjargjkmnv. Box B market-outcome authority v1.
-- Market-scoped, append-only, revision-chained, provider-provenanced.
-- Not a replacement for the lost 20261013100000 draft; independent implementation.
-- Deliberately has NO bet_row_key / ROI / stake / Ledger / paper-decision columns and
-- NO foreign keys outside Box B. Observation tables are not touched.

create table if not exists public.market_outcome_provider_receipts (
  receipt_id    bigint generated always as identity primary key,
  provider      text        not null check (provider in ('gamma', 'clob')),
  request_kind  text        not null check (request_kind in ('condition_id', 'token_id')),
  request_key   text        not null check (length(request_key) > 0),
  request_url   text        not null check (request_url like 'https://%'),
  http_status   integer,
  fetch_error   text,
  fetched_at    timestamptz not null,
  raw_body      text        not null,
  raw_digest    text        not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  constraint market_outcome_receipt_digest_ck
    check (raw_digest = encode(sha256(convert_to(raw_body, 'UTF8')), 'hex')),
  constraint market_outcome_receipt_failure_ck
    check ((http_status is not null and fetch_error is null)
        or (http_status is null and fetch_error is not null)
        or (http_status is not null and http_status <> 200)),
  constraint market_outcome_receipt_idem_uq
    unique (provider, request_kind, request_key, raw_digest)
);

create table if not exists public.market_outcome_revisions (
  condition_id          text        not null
    check (condition_id ~ '^0x[0-9a-f]{64}$'),
  revision_no           integer     not null check (revision_no >= 1),
  prev_revision_digest  text,
  revision_digest       text        not null,
  evidence_digest       text        not null,
  outcome_status        text        not null
    check (outcome_status in ('FINAL', 'PENDING', 'VOID', 'CONFLICT', 'LOOKUP_FAILED')),
  winner_token_id       text,
  gamma_winner_token_id text,
  clob_winner_token_id  text,
  market_token_ids      jsonb,
  gamma_receipt_id      bigint      not null references public.market_outcome_provider_receipts (receipt_id),
  clob_receipt_id       bigint      not null references public.market_outcome_provider_receipts (receipt_id),
  resolved_at           timestamptz,
  resolution_time_source text,
  checked_at            timestamptz not null,
  status_reason         text,
  recorded_at           timestamptz not null default clock_timestamp(),
  recorded_by           text        not null default current_user,
  primary key (condition_id, revision_no),
  constraint market_outcome_final_ck check (
    outcome_status <> 'FINAL' or (
      winner_token_id is not null
      and winner_token_id = gamma_winner_token_id
      and winner_token_id = clob_winner_token_id
      and market_token_ids is not null
      and market_token_ids ? winner_token_id
      and resolved_at is not null
      and resolution_time_source is not null)),
  constraint market_outcome_void_ck check (
    outcome_status <> 'VOID' or (
      winner_token_id is null
      and resolved_at is not null
      and resolution_time_source is not null)),
  constraint market_outcome_nonfinal_no_winner_ck check (
    outcome_status = 'FINAL' or winner_token_id is null),
  constraint market_outcome_conflict_ck check (
    outcome_status <> 'CONFLICT' or status_reason is not null),
  constraint market_outcome_digest_shape_ck check (
    revision_digest ~ '^[0-9a-f]{64}$' and evidence_digest ~ '^[0-9a-f]{64}$'
    and (prev_revision_digest is null or prev_revision_digest ~ '^[0-9a-f]{64}$')),
  constraint market_outcome_chain_ck check ((revision_no = 1) = (prev_revision_digest is null))
);

create unique index if not exists market_outcome_revisions_digest_uq
  on public.market_outcome_revisions (revision_digest);
create index if not exists market_outcome_revisions_status_idx
  on public.market_outcome_revisions (outcome_status, condition_id);

-- ---------------------------------------------------------------- guards

create or replace function public.market_outcome_append_only_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'BOX_B_APPEND_ONLY: % on % is forbidden', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

-- Independent in-database check that a FINAL/VOID revision is really backed by its
-- stored provider receipts (winner, closure, market identity), not just by caller claims.
create or replace function public.market_outcome_validate_receipts(
  p_condition_id text, p_status text, p_winner text,
  p_gamma_receipt bigint, p_clob_receipt bigint, p_tokens jsonb,
  p_resolved_at timestamptz, p_time_source text)
returns void language plpgsql stable as $$
declare
  g_row public.market_outcome_provider_receipts%rowtype;
  c_row public.market_outcome_provider_receipts%rowtype;
  g jsonb; c jsonb; g_tokens jsonb; g_prices jsonb;
  n_win integer; idx integer; ones integer; halves integer; total integer;
begin
  select * into g_row from public.market_outcome_provider_receipts where receipt_id = p_gamma_receipt;
  select * into c_row from public.market_outcome_provider_receipts where receipt_id = p_clob_receipt;
  if g_row.provider is distinct from 'gamma' or c_row.provider is distinct from 'clob' then
    raise exception 'BOX_B_RECEIPT_PROVIDER_MISMATCH';
  end if;
  if p_status not in ('FINAL', 'VOID') then
    return;
  end if;
  if g_row.http_status is distinct from 200 or c_row.http_status is distinct from 200 then
    raise exception 'BOX_B_RECEIPT_NOT_HTTP_200';
  end if;
  g := g_row.raw_body::jsonb;
  c := c_row.raw_body::jsonb;
  if jsonb_typeof(g) <> 'array' or jsonb_array_length(g) <> 1
     or (g -> 0 ->> 'conditionId') is distinct from p_condition_id
     or (c ->> 'condition_id') is distinct from p_condition_id then
    raise exception 'BOX_B_RECEIPT_CONDITION_MISMATCH';
  end if;
  if coalesce((g -> 0 ->> 'closed')::boolean, false) is not true
     or coalesce((c ->> 'closed')::boolean, false) is not true then
    raise exception 'BOX_B_RECEIPT_NOT_CLOSED';
  end if;
  g_tokens := (g -> 0 ->> 'clobTokenIds')::jsonb;
  g_prices := (g -> 0 ->> 'outcomePrices')::jsonb;
  if g_tokens is null or g_prices is null
     or jsonb_typeof(g_tokens) <> 'array' or jsonb_typeof(g_prices) <> 'array'
     or jsonb_typeof(c -> 'tokens') is distinct from 'array' then
    raise exception 'BOX_B_RECEIPT_PRICES_OR_TOKENS_MISSING';
  end if;
  -- Resolution time must be the provider's own timestamp, named by its source label.
  if p_time_source = 'gamma.closedTime' then
    if p_resolved_at is distinct from (g -> 0 ->> 'closedTime')::timestamptz then
      raise exception 'BOX_B_RESOLVED_AT_NOT_BACKED_BY_RECEIPT';
    end if;
  elsif p_time_source = 'gamma.umaEndDate' then
    if p_resolved_at is distinct from (g -> 0 ->> 'umaEndDate')::timestamptz then
      raise exception 'BOX_B_RESOLVED_AT_NOT_BACKED_BY_RECEIPT';
    end if;
  else
    raise exception 'BOX_B_RESOLUTION_TIME_SOURCE_UNKNOWN';
  end if;
  if jsonb_array_length(g_tokens) <> jsonb_array_length(g_prices)
     or jsonb_array_length(g_tokens) < 2
     or p_tokens is distinct from g_tokens
     or (select jsonb_agg(x order by x) from jsonb_array_elements_text(g_tokens) x)
        is distinct from (select jsonb_agg(t ->> 'token_id' order by t ->> 'token_id')
                            from jsonb_array_elements(c -> 'tokens') t) then
    raise exception 'BOX_B_RECEIPT_TOKEN_SET_MISMATCH';
  end if;
  total := jsonb_array_length(g_prices);
  select count(*) filter (where (v #>> '{}')::numeric = 1),
         count(*) filter (where (v #>> '{}')::numeric = 0.5)
    into ones, halves
    from jsonb_array_elements(g_prices) as v;
  select count(*) into n_win
    from jsonb_array_elements(c -> 'tokens') t where coalesce((t ->> 'winner')::boolean, false);
  if p_status = 'FINAL' then
    select (ord - 1)::integer into idx
      from jsonb_array_elements(g_prices) with ordinality as x(v, ord)
     where (v #>> '{}')::numeric = 1;
    if ones <> 1 or ones + (select count(*) from jsonb_array_elements(g_prices) v
                              where (v #>> '{}')::numeric = 0) <> total
       or n_win <> 1
       or (g_tokens ->> idx) is distinct from p_winner
       or not exists (select 1 from jsonb_array_elements(c -> 'tokens') t
                       where t ->> 'token_id' = p_winner
                         and coalesce((t ->> 'winner')::boolean, false)) then
      raise exception 'BOX_B_FINAL_NOT_BACKED_BY_RECEIPTS';
    end if;
  else
    if halves is distinct from total or n_win <> 0 then
      raise exception 'BOX_B_VOID_NOT_BACKED_BY_RECEIPTS';
    end if;
  end if;
end;
$$;

create or replace function public.market_outcome_revision_guard()
returns trigger language plpgsql as $$
declare
  prev public.market_outcome_revisions%rowtype;
  g_digest text; c_digest text; ev text;
begin
  perform pg_advisory_xact_lock(hashtextextended('box_b:' || new.condition_id, 0));
  select * into prev from public.market_outcome_revisions
   where condition_id = new.condition_id order by revision_no desc limit 1;
  select raw_digest into g_digest from public.market_outcome_provider_receipts where receipt_id = new.gamma_receipt_id;
  select raw_digest into c_digest from public.market_outcome_provider_receipts where receipt_id = new.clob_receipt_id;
  perform public.market_outcome_validate_receipts(new.condition_id, new.outcome_status,
    new.winner_token_id, new.gamma_receipt_id, new.clob_receipt_id, new.market_token_ids,
    new.resolved_at, new.resolution_time_source);
  ev := encode(sha256(convert_to(concat_ws('|', new.condition_id, new.outcome_status,
    coalesce(new.winner_token_id, ''), coalesce(new.gamma_winner_token_id, ''),
    coalesce(new.clob_winner_token_id, ''), g_digest, c_digest,
    coalesce(extract(epoch from new.resolved_at)::text, '')), 'UTF8')), 'hex');
  -- Idempotent re-load: identical evidence to the latest revision is a silent no-op.
  if prev.revision_no is not null and prev.evidence_digest = ev then
    return null;
  end if;
  if new.revision_no is not null and new.revision_no <> coalesce(prev.revision_no, 0) + 1 then
    raise exception 'BOX_B_REVISION_NO_MISMATCH';
  end if;
  new.revision_no := coalesce(prev.revision_no, 0) + 1;
  new.prev_revision_digest := prev.revision_digest;
  new.evidence_digest := ev;
  new.recorded_at := clock_timestamp();
  new.recorded_by := current_user;
  new.revision_digest := encode(sha256(convert_to(concat_ws('|', new.condition_id,
    new.revision_no::text, coalesce(new.prev_revision_digest, ''), ev), 'UTF8')), 'hex');
  return new;
end;
$$;

revoke all on function public.market_outcome_append_only_guard() from public, anon, authenticated;
revoke all on function public.market_outcome_validate_receipts(text, text, text, bigint, bigint, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.market_outcome_revision_guard() from public, anon, authenticated;

drop trigger if exists market_outcome_receipts_row_guard_trg on public.market_outcome_provider_receipts;
create trigger market_outcome_receipts_row_guard_trg
  before update or delete on public.market_outcome_provider_receipts
  for each row execute function public.market_outcome_append_only_guard();
drop trigger if exists market_outcome_receipts_truncate_guard_trg on public.market_outcome_provider_receipts;
create trigger market_outcome_receipts_truncate_guard_trg
  before truncate on public.market_outcome_provider_receipts
  for each statement execute function public.market_outcome_append_only_guard();

drop trigger if exists market_outcome_revisions_row_guard_trg on public.market_outcome_revisions;
create trigger market_outcome_revisions_row_guard_trg
  before update or delete on public.market_outcome_revisions
  for each row execute function public.market_outcome_append_only_guard();
drop trigger if exists market_outcome_revisions_truncate_guard_trg on public.market_outcome_revisions;
create trigger market_outcome_revisions_truncate_guard_trg
  before truncate on public.market_outcome_revisions
  for each statement execute function public.market_outcome_append_only_guard();
drop trigger if exists market_outcome_revisions_insert_guard_trg on public.market_outcome_revisions;
create trigger market_outcome_revisions_insert_guard_trg
  before insert on public.market_outcome_revisions
  for each row execute function public.market_outcome_revision_guard();

-- ---------------------------------------------------------------- read models

-- Current authoritative claim per market. LOOKUP_FAILED carries no claim about the
-- market and never hides an earlier FINAL/VOID/CONFLICT; last_checked_at still advances.
create or replace view public.market_outcome_current with (security_invoker = true) as
select distinct on (r.condition_id)
       r.condition_id, r.revision_no, r.outcome_status, r.winner_token_id,
       r.resolved_at, r.resolution_time_source, r.checked_at, r.revision_digest,
       r.gamma_receipt_id, r.clob_receipt_id,
       (select max(a.checked_at) from public.market_outcome_revisions a
         where a.condition_id = r.condition_id) as last_checked_at
  from public.market_outcome_revisions r
 where r.outcome_status <> 'LOOKUP_FAILED'
 order by r.condition_id, r.revision_no desc;

-- ---------------------------------------------------------------- ACL

alter table public.market_outcome_provider_receipts enable row level security;
alter table public.market_outcome_revisions enable row level security;

revoke all on public.market_outcome_provider_receipts from public, anon, authenticated;
revoke all on public.market_outcome_revisions from public, anon, authenticated;
revoke all on public.market_outcome_current from public, anon, authenticated;

do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated',
                 pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'));
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'blind_model_reader') then
    execute 'revoke all on public.market_outcome_provider_receipts from blind_model_reader';
    execute 'revoke all on public.market_outcome_revisions from blind_model_reader';
    execute 'revoke all on public.market_outcome_current from blind_model_reader';
    execute format('revoke all on sequence %s from blind_model_reader',
                   pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'));
    execute 'revoke all on function public.market_outcome_validate_receipts(text, text, text, bigint, bigint, jsonb, timestamptz, text) from blind_model_reader';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on public.market_outcome_provider_receipts from service_role';
    execute 'revoke all on public.market_outcome_revisions from service_role';
    execute 'revoke all on public.market_outcome_current from service_role';
    execute format('revoke all on sequence %s from service_role',
                   pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'));
    execute 'grant select, insert on public.market_outcome_provider_receipts to service_role';
    execute 'grant select, insert on public.market_outcome_revisions to service_role';
    execute 'grant select on public.market_outcome_current to service_role';
    execute 'grant execute on function public.market_outcome_validate_receipts(text, text, text, bigint, bigint, jsonb, timestamptz, text) to service_role';
  end if;
end;
$$;
