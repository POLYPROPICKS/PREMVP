#!/usr/bin/env bash
# Rebuilds a scratch DB (Box B migration + payload.sql) on a local throwaway Postgres and runs test.sql.
# usage: PGHOST=<socket dir> PGPORT=<port> PGUSER=postgres ops/research-clone/forward-ledger/run_scratch_test.sh
set -euo pipefail
d="$(cd "$(dirname "$0")" && pwd)"
psql -q -d postgres -c "drop database if exists fl_test" -c "create database fl_test"
for r in anon authenticated service_role blind_model_reader blind_model_writer; do
  psql -q -d postgres -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='$r') then create role $r; end if; end \$\$"
done
# Supabase's service_role has BYPASSRLS (Box B enables RLS with no policies); mirror that here.
psql -q -d postgres -c "alter role service_role bypassrls"
psql -q -v ON_ERROR_STOP=1 -d fl_test -f "$d/../migrations/20261013130000_market_outcome_box_b_authority_v1.sql" 2>&1 | grep -v NOTICE || true
psql -q -v ON_ERROR_STOP=1 -d fl_test -f "$d/payload.sql"
psql -q -v ON_ERROR_STOP=1 -d fl_test -f "$d/test.sql" 2>&1 | grep -E "PASS|ALL_TESTS|ERROR|LEAK"
