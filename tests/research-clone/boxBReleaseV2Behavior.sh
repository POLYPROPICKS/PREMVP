#!/usr/bin/env bash
# Box B RELEASE PAYLOAD V2 - PostgreSQL semantic test runner (local scratch cluster; never touches a real database).
# Usage: tests/research-clone/boxBOutcomeBehavior.sh [receipt_out_file]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OP="$ROOT/ops/research-clone/box-b/release_v2/payload.sql"
ONEQ="$ROOT/tests/research-clone/boxBApplyOneQuery.mjs"
PILOT="$ROOT/ops/research-clone/box-b/pilot_insert.sql"
TEST="$ROOT/tests/research-clone/boxBOutcomeBehavior.sql"
BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
BASE="$(mktemp -d /var/tmp/boxb_pg.XXXXXX)"; chmod 755 "$BASE"
RUN=""; [ "$(id -u)" = 0 ] && { chown postgres "$BASE"; RUN="runuser -u postgres --"; }
OUT="${1:-/dev/null}"; : > "$OUT"
log() { echo "$*" | tee -a "$OUT"; }
cleanup() { $RUN "$BIN/pg_ctl" -D "$BASE/data" -m immediate stop >/dev/null 2>&1; rm -rf "$BASE"; }
trap cleanup EXIT
$RUN "$BIN/initdb" -D "$BASE/data" -A trust -E UTF8 >/dev/null || exit 2
$RUN "$BIN/pg_ctl" -D "$BASE/data" -o "-k $BASE -c listen_addresses=''" -l "$BASE/log" -w start >/dev/null || exit 2
P() { psql -X -q -h "$BASE" -U postgres "$@"; }
# apply FILE as ONE simple-protocol Query (one implicit transaction), like a migration API; extra args = mutation find/replace
apply() { local db="$1"; shift; node "$ONEQ" "$BASE" "$db" "$OP" "$@"; }
log "postgres: $(P -Atc 'select version()' postgres)"
log "migration_sha256: $(sha256sum "$ROOT/ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql" | cut -d' ' -f1)"
log "payload_sha256:   $(sha256sum "$OP" | cut -d' ' -f1)"
log "pilot_sha256:     $(sha256sum "$PILOT" | cut -d' ' -f1)"
P -Atc "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role blind_model_reader nologin;" postgres >/dev/null

mkdb() { # name [with_clone_marker]
  P -Atc "create database $1" postgres >/dev/null
  P -d "$1" -v ON_ERROR_STOP=1 >/dev/null <<SQL
grant usage on schema public to anon, authenticated, service_role, blind_model_reader;
-- worst case: Supabase-style default privileges that auto-grant new objects (also to the blind reader)
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role, blind_model_reader;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role, blind_model_reader;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role, blind_model_reader;
SQL
  P -d "$1" -v ON_ERROR_STOP=1 >/dev/null <<SQL
create schema supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
insert into supabase_migrations.schema_migrations values ('20260101000000', 'seed', null);
SQL
  if [ "${2:-yes}" = yes ]; then
    P -d "$1" -v ON_ERROR_STOP=1 >/dev/null <<SQL
create table public.research_inplay_core_path_observations (id int primary key, payload text);
insert into public.research_inplay_core_path_observations values (1,'a'),(2,'b'),(3,'c');
SQL
  fi
}
obs_opts() {
  local d="$1"
  local m c a
  m=$(P -d "$d" -Atc "select md5(string_agg(x::text,'|' order by x::text)) from public.research_inplay_core_path_observations x")
  c=$(P -d "$d" -Atc "select md5(string_agg(attname||atttypid::text, ',' order by attnum)) from pg_attribute where attrelid='public.research_inplay_core_path_observations'::regclass and attnum>0 and not attisdropped")
  a=$(P -d "$d" -Atc "select coalesce(relacl::text,'') from pg_class where oid='public.research_inplay_core_path_observations'::regclass")
  echo "-c boxb.obs_md5=$m -c boxb.obs_cols_md5=$c -c boxb.obs_acl=$a"
}
run_suite() { PGOPTIONS="${2:-$(obs_opts "$1")}" psql -X -q -h "$BASE" -U postgres -d "$1" -v ON_ERROR_STOP=1 -f "$TEST" 2>&1; }
FAILS=0
expect() { # label rc-wanted(0|nz) output-must-contain
  :
}

# ---- 1. positive: apply payload as ONE batch, ledger untouched, reload pilot twice (idempotency), run suite
mkdb good
OPTS="$(obs_opts good)"
LEDGER_BEFORE="$(P -d good -Atc "select md5(string_agg(x::text,'|' order by x::text)) from supabase_migrations.schema_migrations x")"
R1="$(apply good)"
if echo "$R1" | grep -q '^APPLY_OK'; then log "PASS release payload applies atomically as one simple-protocol batch"; else log "FAIL release payload: $R1"; FAILS=$((FAILS+1)); fi
LEDGER_AFTER="$(P -d good -Atc "select md5(string_agg(x::text,'|' order by x::text)) from supabase_migrations.schema_migrations x")"
if [ "$LEDGER_BEFORE" = "$LEDGER_AFTER" ]; then log "PASS payload does not touch supabase_migrations (version registration is left to the API)"; else log "FAIL payload modified supabase_migrations"; FAILS=$((FAILS+1)); fi
for i in 1 2; do
  P -d good -v ON_ERROR_STOP=1 -f "$PILOT" >/dev/null 2>"$BASE/pilot.err" || { log "FAIL pilot reload $i: $(tail -2 "$BASE/pilot.err")"; FAILS=$((FAILS+1)); }
done
CNT="$(P -d good -Atc "select count(*) from market_outcome_revisions" ) revisions / $(P -d good -Atc "select count(*) from market_outcome_provider_receipts") receipts"
log "INFO pilot reloaded twice; counts: $CNT"
if [ "$CNT" = "20 revisions / 41 receipts" ]; then log "PASS idempotent pilot reload keeps 20 revisions / 41 receipts"; else log "FAIL idempotency counts: $CNT"; FAILS=$((FAILS+1)); fi
D="$(P -d good -Atc "select count(distinct condition_id) || '/' || count(*) filter (where outcome_status='FINAL') from market_outcome_revisions")"
if [ "$D" = "20/20" ]; then log "PASS 20 distinct condition_id, 20 FINAL"; else log "FAIL distinct/FINAL: $D"; FAILS=$((FAILS+1)); fi
R="$(PGOPTIONS="$OPTS" psql -X -q -h "$BASE" -U postgres -d good -v ON_ERROR_STOP=1 -f "$TEST" 2>&1)"; RC=$?
echo "$R" | grep -E "^(NOTICE|psql|ERROR).*|BOXB_SEMANTIC" | sed 's/^psql:[^ ]* //' | grep -E "PASS|FAIL|ERROR|BOXB" >> "$OUT"
if [ $RC -eq 0 ] && echo "$R" | grep -q BOXB_SEMANTIC_ALL_PASS; then log "PASS semantic suite: $(echo "$R" | grep -c 'PASS') probes"; else log "FAIL semantic suite rc=$RC"; echo "$R" | tail -5 | tee -a "$OUT"; FAILS=$((FAILS+1)); fi

# ---- 2. fail-closed / atomicity
R2="$(apply good 2>&1)"
if echo "$R2" | grep -q "Box B already exists"; then log "PASS second apply refused by replay guard"; else log "FAIL second apply must be refused"; FAILS=$((FAILS+1)); fi
mkdb halfway
P -d halfway -Atc "create table public.market_outcome_current(x int);" >/dev/null
R4="$(apply halfway)"
if echo "$R4" | grep -q '^APPLY_ERROR' && [ "$(P -d halfway -Atc "select to_regclass('public.market_outcome_revisions') is null and to_regclass('public.market_outcome_provider_receipts') is null")" = t ]; then log "PASS mid-batch failure rolled back everything (no partial Box B)"; else log "FAIL partial Box B left behind: $R4"; FAILS=$((FAILS+1)); fi
mkdb verifyfail
R5="$(apply verifyfail "(select count(*) from public.market_outcome_provider_receipts) <> 41" "(select count(*) from public.market_outcome_provider_receipts) <> 42")"
if echo "$R5" | grep -q 'BOX_B_VERIFY' && [ "$(P -d verifyfail -Atc "select to_regclass('public.market_outcome_revisions') is null and to_regclass('public.market_outcome_provider_receipts') is null")" = t ]; then log "PASS failing verification rolls back schema AND all inserted rows"; else log "FAIL verification rollback: $R5"; FAILS=$((FAILS+1)); fi
mkdb ledgercheck
apply ledgercheck >/dev/null
if [ "$(P -d ledgercheck -Atc "select count(*) from supabase_migrations.schema_migrations")" = 1 ]; then log "PASS ledger still has exactly the seeded row (no duplicate, no manual registration)"; else log "FAIL ledger changed"; FAILS=$((FAILS+1)); fi

# ---- 3. negative controls: each regression must be CAUGHT by the same suite
neg() { # name sql expected-label-regex
  mkdb "$1"; SETUP="$(apply "$1" 2>&1)"; echo "$SETUP" | grep -q '^APPLY_OK' || { log "FAIL negctl $1 setup"; FAILS=$((FAILS+1)); return; }
  local base_opts; base_opts="$(obs_opts "$1")"
  P -d "$1" -v ON_ERROR_STOP=1 -Atc "$2" >/dev/null 2>"$BASE/mut.err" || { cat "$BASE/mut.err" >> "$OUT"; log "FAIL negctl $1 mutation did not apply"; FAILS=$((FAILS+1)); return; }
  local out; out="$(run_suite "$1" "$base_opts")"; local rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -Eq "$3" && ! echo "$out" | grep -q BOXB_SEMANTIC_ALL_PASS; then log "PASS negative control $1 detected ($(echo "$out" | grep -Eo "$3" | head -1))"; else log "FAIL negative control $1 NOT detected rc=$rc"; FAILS=$((FAILS+1)); fi
}
neg nc_drop_appendonly "drop trigger market_outcome_revisions_row_guard_trg on public.market_outcome_revisions; drop trigger market_outcome_receipts_row_guard_trg on public.market_outcome_provider_receipts;" "FAIL T4\.[0-9]+"
neg nc_grant_blind "grant select on public.market_outcome_revisions, public.market_outcome_current to blind_model_reader;" "FAIL T3\.1"
neg nc_service_update "grant update, delete on public.market_outcome_revisions to service_role;" "FAIL T3\.3"
neg nc_validator_off "create or replace function public.market_outcome_validate_receipts(p_condition_id text, p_status text, p_winner text, p_gamma_receipt bigint, p_clob_receipt bigint, p_tokens jsonb, p_resolved_at timestamptz, p_time_source text) returns void language plpgsql as 'begin return; end';" "FAIL T5\.[0-9]+"
neg nc_bet_column "alter table public.market_outcome_revisions add column bet_row_key text;" "FAIL T1\.1"
neg nc_outside_fk "create table public.fake_ledger(bet_row_key text primary key); alter table public.market_outcome_revisions add column lk text; alter table public.market_outcome_revisions add constraint x foreign key (lk) references public.fake_ledger(bet_row_key);" "FAIL T1\.[12]"
neg nc_obs_touched "update public.research_inplay_core_path_observations set payload='zzz' where id=1;" "FAIL T1\.4"
neg nc_fn_exec "grant execute on function public.market_outcome_validate_receipts(text,text,text,bigint,bigint,jsonb,timestamptz,text) to blind_model_reader;" "FAIL T3\.10"
neg nc_seq_grant "grant usage on sequence public.market_outcome_provider_receipts_receipt_id_seq to authenticated;" "FAIL T3\.11"
neg nc_rls_off "alter table public.market_outcome_revisions disable row level security;" "FAIL T3\.4"
neg nc_public_grant "grant select on public.market_outcome_provider_receipts to public;" "FAIL T3\.[12]"

if [ "$FAILS" -eq 0 ]; then log "BOXB_PG_V2_RESULT=PASS"; exit 0; else log "BOXB_PG_V2_RESULT=FAIL failures=$FAILS"; exit 1; fi
