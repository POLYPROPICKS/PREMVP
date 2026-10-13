#!/usr/bin/env bash
# Box B PostgreSQL semantic test runner (local scratch cluster; never touches a real database).
# Usage: tests/research-clone/boxBOutcomeBehavior.sh [receipt_out_file]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OP="$ROOT/ops/research-clone/box-b/operator_dbclone_box_b_v1.sql"
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
log "postgres: $(P -Atc 'select version()' postgres)"
log "migration_sha256: $(sha256sum "$ROOT/ops/research-clone/migrations/20261013130000_market_outcome_box_b_authority_v1.sql" | cut -d' ' -f1)"
log "operator_sha256:  $(sha256sum "$OP" | cut -d' ' -f1)"
log "pilot_sha256:     $(sha256sum "$PILOT" | cut -d' ' -f1)"
P -Atc "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role blind_model_reader nologin;" postgres >/dev/null

mkdb() { # name [with_clone_marker]
  P -Atc "create database $1" postgres >/dev/null
  P -d "$1" -v ON_ERROR_STOP=1 >/dev/null <<SQL
grant usage on schema public to anon, authenticated, service_role, blind_model_reader;
-- worst case: Supabase-style default privileges that auto-grant new objects (also to the blind reader)
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role, blind_model_reader;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role, blind_model_reader;
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

# ---- 1. positive: apply operator script, reload pilot (idempotency), run suite
mkdb good
OPTS="$(obs_opts good)"
if P -d good -v ON_ERROR_STOP=1 -f "$OP" >"$BASE/op.out" 2>&1; then log "PASS operator script applies atomically"; else log "FAIL operator script: $(tail -3 "$BASE/op.out")"; FAILS=$((FAILS+1)); fi
for i in 1 2; do
  P -d good -v ON_ERROR_STOP=1 -f "$PILOT" >/dev/null 2>"$BASE/pilot.err" || { log "FAIL pilot reload $i: $(tail -2 "$BASE/pilot.err")"; FAILS=$((FAILS+1)); }
done
CNT="$(P -d good -Atc "select count(*) from market_outcome_revisions" ) revisions / $(P -d good -Atc "select count(*) from market_outcome_provider_receipts") receipts"
log "INFO pilot reloaded twice; counts: $CNT"
R="$(PGOPTIONS="$OPTS" psql -X -q -h "$BASE" -U postgres -d good -v ON_ERROR_STOP=1 -f "$TEST" 2>&1)"; RC=$?
echo "$R" | grep -E "^(NOTICE|psql|ERROR).*|BOXB_SEMANTIC" | sed 's/^psql:[^ ]* //' | grep -E "PASS|FAIL|ERROR|BOXB" >> "$OUT"
if [ $RC -eq 0 ] && echo "$R" | grep -q BOXB_SEMANTIC_ALL_PASS; then log "PASS semantic suite: $(echo "$R" | grep -c 'PASS') probes"; else log "FAIL semantic suite rc=$RC"; echo "$R" | tail -5 | tee -a "$OUT"; FAILS=$((FAILS+1)); fi

# ---- 2. fail-closed / atomicity
if P -d good -v ON_ERROR_STOP=1 -f "$OP" >"$BASE/o2" 2>&1; then log "FAIL second apply must be refused"; FAILS=$((FAILS+1)); elif grep -q "Box B already exists" "$BASE/o2"; then log "PASS second apply refused by guard"; else log "FAIL second apply wrong error"; FAILS=$((FAILS+1)); fi
mkdb notclone no
if P -d notclone -v ON_ERROR_STOP=1 -f "$OP" >"$BASE/o3" 2>&1; then log "FAIL non-DBClone apply must be refused"; FAILS=$((FAILS+1)); elif grep -q "not a Research DBClone" "$BASE/o3" && [ "$(P -d notclone -Atc "select to_regclass('public.market_outcome_revisions') is null")" = t ]; then log "PASS non-DBClone database refused, nothing created"; else log "FAIL non-DBClone guard"; FAILS=$((FAILS+1)); fi
mkdb halfway
P -d halfway -Atc "create table public.market_outcome_current(x int);" >/dev/null
if P -d halfway -v ON_ERROR_STOP=1 -f "$OP" >"$BASE/o4" 2>&1; then log "FAIL halfway failure must abort"; FAILS=$((FAILS+1)); elif [ "$(P -d halfway -Atc "select to_regclass('public.market_outcome_revisions') is null and to_regclass('public.market_outcome_provider_receipts') is null")" = t ]; then log "PASS mid-script failure rolled back everything (no partial Box B)"; else log "FAIL partial Box B left behind"; FAILS=$((FAILS+1)); fi

# ---- 3. negative controls: each regression must be CAUGHT by the same suite
neg() { # name sql expected-label-regex
  mkdb "$1"; P -d "$1" -v ON_ERROR_STOP=1 -f "$OP" >/dev/null 2>&1 || { log "FAIL negctl $1 setup"; FAILS=$((FAILS+1)); return; }
  local base_opts; base_opts="$(obs_opts "$1")"
  P -d "$1" -v ON_ERROR_STOP=1 -Atc "$2" >/dev/null 2>"$BASE/mut.err" || { cat "$BASE/mut.err" >> "$OUT"; log "FAIL negctl $1 mutation did not apply"; FAILS=$((FAILS+1)); return; }
  local out; out="$(run_suite "$1" "$base_opts")"; local rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -Eq "$3" && ! echo "$out" | grep -q BOXB_SEMANTIC_ALL_PASS; then log "PASS negative control $1 detected ($(echo "$out" | grep -Eo "$3" | head -1))"; else log "FAIL negative control $1 NOT detected rc=$rc"; FAILS=$((FAILS+1)); fi
}
neg nc_drop_appendonly "drop trigger market_outcome_revisions_row_guard_trg on public.market_outcome_revisions; drop trigger market_outcome_receipts_row_guard_trg on public.market_outcome_provider_receipts;" "FAIL T4\.[0-9]+"
neg nc_grant_blind "grant select on public.market_outcome_revisions, public.market_outcome_current to blind_model_reader;" "FAIL T3\.1"
neg nc_service_update "grant update, delete on public.market_outcome_revisions to service_role;" "FAIL T3\.3"
neg nc_validator_off "create or replace function public.market_outcome_validate_receipts(p_condition_id text, p_status text, p_winner text, p_gamma_receipt bigint, p_clob_receipt bigint, p_tokens jsonb) returns void language plpgsql as 'begin return; end';" "FAIL T5\.[0-9]+"
neg nc_bet_column "alter table public.market_outcome_revisions add column bet_row_key text;" "FAIL T1\.1"
neg nc_outside_fk "create table public.fake_ledger(bet_row_key text primary key); alter table public.market_outcome_revisions add column lk text; alter table public.market_outcome_revisions add constraint x foreign key (lk) references public.fake_ledger(bet_row_key);" "FAIL T1\.[12]"
neg nc_obs_touched "update public.research_inplay_core_path_observations set payload='zzz' where id=1;" "FAIL T1\.4"
neg nc_rls_off "alter table public.market_outcome_revisions disable row level security;" "FAIL T3\.4"
neg nc_public_grant "grant select on public.market_outcome_provider_receipts to public;" "FAIL T3\.[12]"

if [ "$FAILS" -eq 0 ]; then log "BOXB_PG_RESULT=PASS"; exit 0; else log "BOXB_PG_RESULT=FAIL failures=$FAILS"; exit 1; fi
