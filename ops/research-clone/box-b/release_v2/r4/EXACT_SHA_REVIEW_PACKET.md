# EXACT-SHA R4 REVIEW PACKET — Box B release payload v2 (DBClone-only, NOT applied)

Reviewer profile: CONTUR_GATE_REVIEWER_V1 (`premvp.reviewer.contur_gate.v1`). Independent of the implementing session.

## 1. Review target (pinned)
- Repository POLYPROPICKS/PREMVP, PR #530 (draft), branch `claude/vigilant-wozniak-sqw3fb`.
- **reviewed_sha: `9bd9e320bcc82a29a9605af9eaf6310cbe857c7e`** (a clean checkout of exactly this commit is at `/var/tmp/boxb_r4_review`).
- **Payload: `ops/research-clone/box-b/release_v2/payload.sql`, 723 lines, 262273 bytes, SHA-256 `3e852ebe78e6f1f2c4c2823251be2aee101d913d24186f785068474e7b76fbb8`.**
- Frozen source: PR #529 head `809093ee09c46ff7ecb588cdc30266465d018c0b` (migration SHA-256 `0643c807eae6b17475d2948af3146251838dd9b86e52955a5d8456c0c4dc4766`, pilot_insert.sql `c45455b18c966dde1ce04ee61004d0ab5eccc32d69dbe2850f22a67da0582f6a`, operator script `26bc5ed895570a0c8605fcd98331e504e24521de2e8972d75e88f77ff374a58f`).
- Target (to be established by a project-bound migration API, not by the SQL): Research DBClone `nppznoujvnyjargjkmnv`.
- Not applied anywhere. No database, Production, PR #526/#528, Ireland or live scorer was touched.

## 2. What the payload is
One SQL file, intended to be sent to the official migration API as a single multi-statement query (one implicit transaction). Sections (line ranges in payload.sql):
1. L1-5 header comments; L6-14 **replay guard** (refuses if Box B tables exist) — included in section 5.1.
2. L15-310 **schema: migration 20261013130000, verbatim** — included in full in section 5.2.
3. L311-658 **pilot data, verbatim `pilot_insert.sql`**: 41 receipt inserts (raw provider bodies, byte-exact, with SHA-256 digests) + 20 revision inserts, all 20 markets FINAL — truncated skeleton in 5.3; full lines can be read from the file.
4. L659-708 **fail-closed verification, operator block verbatim, transaction wrapper removed** — 5.4.
5. L709-723 **added v2 verification** (20 distinct condition_id, 20 FINAL in revisions and in `market_outcome_current`, 41 receipts, no FINAL without winner) — 5.5.

Deliberate differences versus the previously reviewed operator script (v1): removed `begin`/`commit`/`set local` timeouts; removed the `to_regclass('public.research_inplay_core_path_observations')` sentinel (it never proved which project it ran on); removed the `supabase_migrations` version check; guard reduced to "Box B already exists"; added 5.5. Everything else is byte-identical. The payload never writes `supabase_migrations`; the API is meant to assign and register the version.

## 3. Founder decisions in force
- Limited one-time SQL-only Gate 1 exception for this payload SHA (recorded in `GATE1_EXCEPTION.md`; Gate 1 result remains HOLD, the exception is not a PASS).
- Applying to DBClone is **forbidden until** R4 PASS **and** confirmation that the official Supabase API executes the payload atomically. Neither is part of this review's grant.

## 4. Evidence collected by the parent (exact commit; also reproduced from a fresh worktree earlier)
- Static gate `tests/research-clone/boxBReleaseV2Static.test.ts` + v1 `boxBOutcomeStatic.test.ts`: 10/10 PASS (byte hashes vs manifest; payload includes the migration, pilot and verification block verbatim; only Box B tables written; 41 receipt + 20 revision inserts; no commit/rollback/begin/savepoint at top level, no `set`, no `supabase_migrations`, no sentinel).
- PostgreSQL 16.15 scratch cluster, payload sent as ONE simple-protocol Query (`postgres.js` `.simple()`): `BOXB_PG_V2_RESULT=PASS`. Full log is in `ops/research-clone/box-b/release_v2/pg_test_receipt.txt` (list below). Test sources: `tests/research-clone/boxBReleaseV2Behavior.sh`, `tests/research-clone/boxBOutcomeBehavior.sql` (56 semantic probes), `tests/research-clone/boxBApplyOneQuery.mjs`.
- `npm run control-plane:check`: PASS (439 control-plane tests, snapshot and project-package checks). `git diff --check`: clean.
- Deterministic rebuild: `python3 ops/research-clone/box-b/build_release_payload_v2.py` yields byte-identical payload (git status clean after rebuild).
- Scope checks: payload contains 0 occurrences of `research_inplay_core_path_observations` and of `supabase_migrations`.

Summary of the PG log (all PASS): payload applies atomically as one batch; supabase_migrations (seeded fake ledger) unchanged; pilot reloaded twice keeps 20 revisions / 41 receipts; 20 distinct condition_id and 20 FINAL; 56 semantic probes; second apply refused by replay guard; mid-batch failure (pre-existing `market_outcome_current` table) rolls back everything; a mutated failing verification (`<> 42`) rolls back schema AND all inserted rows; ledger still exactly the seeded row; 11 negative controls each detected by the suite (drop append-only triggers; grant to blind_model_reader; service_role update/delete; validator disabled; bet column added; outside FK; observation table touched; function execute grant; sequence grant; RLS disabled; PUBLIC grant).

## 5. Executable SQL under review (extracted programmatically from the exact payload)

### 5.1 Replay guard (payload L6-14)
```sql
-- ===== replay guard: refuse to run if Box B objects already exist (not a target-identity check) =====
do $$
begin
  if to_regclass('public.market_outcome_provider_receipts') is not null
     or to_regclass('public.market_outcome_revisions') is not null then
    raise exception 'BOX_B_GUARD: Box B already exists';
  end if;
end;
$$;
```

### 5.2 Schema — migration, verbatim (payload L15-310)
```sql
-- ===== schema: migration 20261013130000 (verbatim) =====
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
```

### 5.3 Pilot data (payload L311-658) — structure only; raw bodies elided (lines truncated to 170 chars)
Counts: 41 receipt inserts (`on conflict (provider, request_kind, request_key, raw_digest) do nothing`), 20 revision inserts (receipts referenced by sub-select on provider/kind/key/digest; no `on conflict`, dedupe by the revision guard). First receipt insert (L314), the last receipt insert (L514) and the first and last revision inserts (L519, L652) follow.
```sql
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetch_error, fetched_at, raw_body, raw_digest)
values ('gamma', 'condition_id', '0x1720920991843e094f3121247275663d87537bb3cf112e914adf133f15e5c1e3', 'https://gamma-api.polymarket.com/markets?condition_ids=0x172092099
$bb$, '00e1464aa9cfd0763e8c2b29243fd875106320d76e01c84709acc0ca4d2e2dd0')
-- ... L514:
insert into public.market_outcome_provider_receipts
  (provider, request_kind, request_key, request_url, http_status, fetch_error, fetched_at, raw_body, raw_digest)
values ('clob', 'condition_id', '0x1bd8dc4dbda4b0677fa10e62aae86e417b93cf8b8376353c0c1529ba7276d68f', 'https://clob.polymarket.com/markets/0x1bd8dc4dbda4b0677fa10e62aae86
$bb$, 'eaaea789651fde91366831f963a9e568d7a50bb8a6ed98890f4215ca72bbd22e')
-- ... first revision insert (L519):
insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at, status_reason)
values ('0x1720920991843e094f3121247275663d87537bb3cf112e914adf133f15e5c1e3', 'FINAL', '64536053840563797886753858447897158555269652108423423147763437678588697641940', '6
  (select receipt_id from public.market_outcome_provider_receipts where provider = 'gamma' and request_kind = 'condition_id' and request_key = '0x1720920991843e094f312124
  (select receipt_id from public.market_outcome_provider_receipts where provider = 'clob' and request_kind = 'condition_id' and request_key = '0x1720920991843e094f3121247
  '2026-10-10T15:29:31+00:00'::timestamptz, 'gamma.closedTime', '2026-10-13T07:49:52.008813Z'::timestamptz, 'gamma+clob closed, identical single winner, provider time pre
insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at, status_reason)
-- ... last revision insert (L652):
insert into public.market_outcome_revisions
  (condition_id, outcome_status, winner_token_id, gamma_winner_token_id, clob_winner_token_id, market_token_ids,
   gamma_receipt_id, clob_receipt_id, resolved_at, resolution_time_source, checked_at, status_reason)
values ('0x1bd8dc4dbda4b0677fa10e62aae86e417b93cf8b8376353c0c1529ba7276d68f', 'FINAL', '49503499314299482686253524599927100138610851079733716609267909300288930323672', '4
  (select receipt_id from public.market_outcome_provider_receipts where provider = 'gamma' and request_kind = 'condition_id' and request_key = '0x1bd8dc4dbda4b0677fa10e62
  (select receipt_id from public.market_outcome_provider_receipts where provider = 'clob' and request_kind = 'condition_id' and request_key = '0x1bd8dc4dbda4b0677fa10e62a
  '2026-10-09T19:05:41+00:00'::timestamptz, 'gamma.closedTime', '2026-10-13T07:50:03.164331Z'::timestamptz, 'gamma+clob closed, identical single winner, provider time pre
-- ===== fail-closed verification (operator block verbatim; transaction wrapper removed) =====
do $$
declare bad text;
```

### 5.4 Operator verification block, verbatim (payload L659-708)
```sql
-- ===== fail-closed verification (operator block verbatim; transaction wrapper removed) =====
do $$
declare bad text;
begin
  if (select count(*) from public.market_outcome_revisions) <> 20
     or (select count(*) from public.market_outcome_provider_receipts) <> 41 then
    raise exception 'BOX_B_VERIFY: unexpected row counts';
  end if;
  if exists (select 1 from public.market_outcome_revisions r
              join public.market_outcome_provider_receipts g on g.receipt_id = r.gamma_receipt_id
             where r.outcome_status in ('FINAL', 'VOID')
               and r.resolved_at is distinct from (g.raw_body::jsonb -> 0 ->> 'closedTime')::timestamptz) then
    raise exception 'BOX_B_VERIFY: resolved_at not backed by gamma closedTime';
  end if;
  if exists (select 1 from public.market_outcome_revisions where revision_no <> 1 or prev_revision_digest is not null) then
    raise exception 'BOX_B_VERIFY: unexpected revision chain';
  end if;
  foreach bad in array array['anon', 'authenticated', 'public', 'blind_model_reader'] loop
    if bad = 'public' or exists (select 1 from pg_roles where rolname = bad) then
      if bad = 'public' then
        if exists (select 1 from information_schema.role_table_grants
                    where grantee = 'PUBLIC' and table_schema = 'public' and table_name like 'market_outcome_%') then
          raise exception 'BOX_B_VERIFY: PUBLIC has grants';
        end if;
        if has_function_privilege('public', 'public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)', 'execute')
           or has_sequence_privilege('public', pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'), 'usage,select,update') then
          raise exception 'BOX_B_VERIFY: PUBLIC can execute/use Box B function or sequence';
        end if;
      elsif has_table_privilege(bad, 'public.market_outcome_revisions', 'select,insert,update,delete,truncate,references,trigger')
         or has_table_privilege(bad, 'public.market_outcome_provider_receipts', 'select,insert,update,delete,truncate,references,trigger')
         or has_table_privilege(bad, 'public.market_outcome_current', 'select')
         or has_function_privilege(bad, 'public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text)', 'execute')
         or has_sequence_privilege(bad, pg_get_serial_sequence('public.market_outcome_provider_receipts', 'receipt_id'), 'usage,select,update') then
        raise exception 'BOX_B_VERIFY: % has access', bad;
      end if;
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') and (
       has_table_privilege('service_role', 'public.market_outcome_revisions', 'update,delete,truncate')
    or has_table_privilege('service_role', 'public.market_outcome_provider_receipts', 'update,delete,truncate')
    or not has_table_privilege('service_role', 'public.market_outcome_revisions', 'select,insert')) then
    raise exception 'BOX_B_VERIFY: service_role privileges wrong';
  end if;
  if (select count(*) from pg_trigger where tgrelid in ('public.market_outcome_revisions'::regclass,
        'public.market_outcome_provider_receipts'::regclass) and not tgisinternal) <> 5 then
    raise exception 'BOX_B_VERIFY: guard triggers missing';
  end if;
end;
$$;

```

### 5.5 Added v2 verification (payload L709-723)
```sql
-- ===== fail-closed verification (added in v2): 20 distinct markets, all FINAL, 41 receipts =====
do $$
begin
  if (select count(distinct condition_id) from public.market_outcome_revisions) <> 20
     or (select count(*) from public.market_outcome_revisions where outcome_status = 'FINAL') <> 20
     or (select count(*) from public.market_outcome_current where outcome_status = 'FINAL') <> 20
     or (select count(*) from public.market_outcome_revisions) <> 20
     or (select count(*) from public.market_outcome_provider_receipts) <> 41 then
    raise exception 'BOX_B_VERIFY: expected 20 distinct FINAL markets and 41 provider receipts';
  end if;
  if exists (select 1 from public.market_outcome_revisions where winner_token_id is null) then
    raise exception 'BOX_B_VERIFY: FINAL revision without winner';
  end if;
end;
$$;
```

## 6. Known residuals declared by the parent (not defects to be hidden)
- Single-batch atomicity of the **real** Supabase migration endpoint is unverified (proven only with a local simple-protocol client). If the endpoint runs statements individually, a mid-batch failure could leave partial state.
- Tested on PostgreSQL 16, not on Supabase's PG17; real default privileges / roles (`blind_model_reader`, `service_role`) were simulated in a scratch cluster.
- Both provider receipt families (Gamma and CLOB) come from Polymarket infrastructure: independent of the model, not two independently owned settlement authorities.
- The replay guard is not a target-identity check; target identity depends entirely on the API being bound to the exact project ref.
- Gate 1 is HOLD with a Founder-documented exception.

## 7. Review request
Current scope: is this exact payload (SHA-256 above, reviewed_sha above) safe and correct as the final executable package for a DBClone-only Box B release — i.e. no defect that would corrupt data, weaken append-only/ACL guarantees (notably denial to `blind_model_reader`), touch other tables, write the migration ledger, or misreport verification? Check specifically: (a) replay guard and fail-closed verification actually abort the whole batch; (b) no transaction control / ledger write / sentinel identity claim; (c) append-only (row and TRUNCATE) enforcement and the receipt-backed validation of FINAL/VOID; (d) ACL: RLS, revokes (including default-privilege grants), `security_invoker` view, function EXECUTE; (e) added v2 checks are correct and not vacuous; (f) verbatim composition and counts (41 / 20); (g) whether the test evidence supports the claims.

Next phase named: "DBClone write/apply via the official project-bound Supabase migration API" — its readiness requires atomicity confirmation and separate Founder authorization, which are NOT part of this review's evidence. Report that readiness honestly.

Explicit file references the reviewer MAY Read for verification (files in the exact checkout `/var/tmp/boxb_r4_review`): `ops/research-clone/box-b/release_v2/payload.sql` (any range, esp. L311-658 data; lines can be very long), `ops/research-clone/box-b/release_v2/pg_test_receipt.txt`, `ops/research-clone/box-b/release_v2/manifest.json`, `ops/research-clone/box-b/release_v2/GATE1_EXCEPTION.md`, `tests/research-clone/boxBOutcomeBehavior.sql`, `tests/research-clone/boxBReleaseV2Behavior.sh`, `tests/research-clone/boxBReleaseV2Static.test.ts`, `ops/research-clone/box-b/receipts/receipts_index.json`.

Return the format required by your profile; list each finding with severity (BLOCKING / NON-BLOCKING), location, and reason.
