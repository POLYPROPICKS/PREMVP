#!/usr/bin/env bash
# scripts/contur3_premvp_doctor.sh
# Contur3 PREMVP Production Health Doctor
#
# Usage:
#   BASE=https://polypropicks.com PPP_SECRET=<secret> bash scripts/contur3_premvp_doctor.sh
#
# Secret env (first match wins):
#   PPP_SECRET | EXECUTOR_SECRET | EXECUTOR_CRON_SECRET
#
# Requires: curl, jq (both must be in PATH)

set -euo pipefail

BASE="${BASE:-https://polypropicks.com}"
SECRET="${PPP_SECRET:-${EXECUTOR_SECRET:-${EXECUTOR_CRON_SECRET:-}}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC}  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo -e "${RED}ERROR${NC}: '$1' not found in PATH — install it and retry." >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq

if [ -z "$SECRET" ]; then
  echo -e "${RED}ERROR${NC}: No secret provided. Set PPP_SECRET, EXECUTOR_SECRET, or EXECUTOR_CRON_SECRET." >&2
  exit 1
fi

echo ""
echo "═══ Contur3 PREMVP Doctor ═══"
echo "BASE: $BASE"
echo "DATE: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# ─── Helper ───────────────────────────────────────────────────────────────────

http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$1" -H "$2"
}

fetch_json() {
  curl -s "$1" -H "x-executor-secret: $SECRET"
}

# ─── 1. Auth gates (expect 401 without secret) ────────────────────────────────
echo "── 1. Auth gates (expect HTTP 401 without secret)"

for path in \
  "/api/executor/queue" \
  "/api/cron/night-event-reservations" \
  "/api/cron/event-rebalance"; do
  code=$(http_status "${BASE}${path}" "x-executor-secret: INVALID_BAD_KEY")
  if [ "$code" = "401" ]; then
    pass "${path} → 401 (unauthorized)"
  else
    fail "${path} → expected 401, got $code"
  fi
done
echo ""

# ─── 2. Reservations endpoint ─────────────────────────────────────────────────
echo "── 2. /api/cron/night-event-reservations (with secret)"
res_json=$(fetch_json "${BASE}/api/cron/night-event-reservations")
res_ok=$(echo "$res_json" | jq -r '.ok // "false"')
res_run=$(echo "$res_json" | jq -r '.plan_run_id // "null"')
res_count=$(echo "$res_json" | jq -r '.reserved_count // "null"')
res_exists=$(echo "$res_json" | jq -r '.already_exists // "null"')

if [ "$res_ok" = "true" ]; then
  pass "/api/cron/night-event-reservations ok=true  plan_run_id=${res_run}  reserved_count=${res_count}  already_exists=${res_exists}"
else
  err=$(echo "$res_json" | jq -r '.error // "unknown"')
  fail "/api/cron/night-event-reservations ok=false  error=${err}"
fi
echo ""

# ─── 3. Event-rebalance dryRun ────────────────────────────────────────────────
echo "── 3. /api/cron/event-rebalance?dryRun=1 (with secret)"
reb_json=$(fetch_json "${BASE}/api/cron/event-rebalance?dryRun=1")
reb_ok=$(echo "$reb_json" | jq -r '.ok // "false"')
reb_due=$(echo "$reb_json" | jq -r '.due_count // "null"')
reb_queued=$(echo "$reb_json" | jq -r '.queued_count // "null"')
reb_skipped=$(echo "$reb_json" | jq -r '.skipped_count // "null"')
reb_expired=$(echo "$reb_json" | jq -r '.expired_count // "null"')
reb_next=$(echo "$reb_json" | jq -r '.next_due_iso // "null"')
reb_ireland=$(echo "$reb_json" | jq -r '.ireland_autostart_expected // "null"')

if [ "$reb_ok" = "true" ]; then
  pass "/api/cron/event-rebalance dryRun  due=${reb_due}  queued=${reb_queued}  skipped=${reb_skipped}  expired=${reb_expired}  next_due=${reb_next}  ireland_autostart=${reb_ireland}"
  # Check ireland_autostart_expected is NOT true when due_count=0
  if [ "$reb_due" = "0" ] && [ "$reb_ireland" = "true" ]; then
    warn "ireland_autostart_expected=true but due_count=0 — review logic"
  fi
else
  err=$(echo "$reb_json" | jq -r '.error // "unknown"')
  fail "/api/cron/event-rebalance ok=false  error=${err}"
fi
echo ""

# ─── 4. Queue endpoint ────────────────────────────────────────────────────────
echo "── 4. /api/executor/queue?includeUpcoming=1 (with secret)"
q_json=$(fetch_json "${BASE}/api/executor/queue?includeUpcoming=1")
q_ok=$(echo "$q_json" | jq -r '.ok // "false"')
q_source=$(echo "$q_json" | jq -r '.source // "null"')
q_count=$(echo "$q_json" | jq -r '.candidate_count // "null"')
q_next=$(echo "$q_json" | jq -r '.next_due_iso // "null"')
q_ireland=$(echo "$q_json" | jq -r '.ireland_contract.read_only_source // "null"')
q_norank=$(echo "$q_json" | jq -r '.ireland_contract.do_not_rank // "null"')
q_nobroad=$(echo "$q_json" | jq -r '.ireland_contract.do_not_pull_broad_candidates // "null"')
q_notier=$(echo "$q_json" | jq -r '.ireland_contract.do_not_apply_tier2_tier3 // "null"')
q_ready=$(echo "$q_json" | jq -r '.diagnostics.ready_rows_total // "null"')

if [ "$q_ok" = "true" ] && [ "$q_source" = "event_execution_queue" ]; then
  pass "/api/executor/queue  source=${q_source}  candidates=${q_count}  ready_total=${q_ready}  next_due=${q_next}"
  # Ireland contract checks
  if [ "$q_ireland" = "event_execution_queue" ] && [ "$q_norank" = "true" ] && [ "$q_nobroad" = "true" ] && [ "$q_notier" = "true" ]; then
    pass "ireland_contract intact  read_only_source=${q_ireland}  do_not_rank=${q_norank}  do_not_pull_broad=${q_nobroad}  do_not_apply_tier2_tier3=${q_notier}"
  else
    fail "ireland_contract incomplete or missing field(s)"
  fi
else
  err=$(echo "$q_json" | jq -r '.error // "unknown"')
  fail "/api/executor/queue ok=${q_ok} source=${q_source}  error=${err}"
fi
echo ""

# ─── 5. Night-plan diagnostic-only safety ────────────────────────────────────
echo "── 5. /api/executor/night-plan (must NOT expose top-level candidates)"
np_json=$(fetch_json "${BASE}/api/executor/night-plan")
np_ok=$(echo "$np_json" | jq -r '.ok // "false"')
np_diag=$(echo "$np_json" | jq -r '.diagnostic_only // "false"')
np_cands=$(echo "$np_json" | jq -r '.candidates | length // -1')
np_src=$(echo "$np_json" | jq -r '.executable_source // "null"')

if [ "$np_ok" = "true" ] || [ "$np_ok" = "false" ]; then
  # Accept any HTTP-level response; what matters is candidates is empty and diagnostic_only=true
  if [ "$np_cands" = "0" ] && [ "$np_diag" = "true" ]; then
    pass "/api/executor/night-plan diagnostic_only=true  candidates[]=0  executable_source=${np_src}"
  elif [ "$np_cands" = "0" ]; then
    warn "/api/executor/night-plan candidates[]=0 but diagnostic_only field missing or false"
    FAIL=$((FAIL + 1))
  else
    fail "/api/executor/night-plan EXPOSED ${np_cands} top-level candidates — split-brain risk!"
  fi
fi
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}ALL PASS${NC}  ${PASS}/${TOTAL} checks passed"
  echo "Contur3 PREMVP automation: HEALTHY"
  exit 0
else
  echo -e "${RED}FAIL${NC}  ${PASS}/${TOTAL} passed, ${FAIL} failed"
  echo "Contur3 PREMVP automation: DEGRADED — review failures above"
  exit 1
fi
