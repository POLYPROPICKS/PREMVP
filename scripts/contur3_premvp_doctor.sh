#!/usr/bin/env bash
# scripts/contur3_premvp_doctor.sh
# Contur3 PREMVP Production Health Doctor — Phase 3 hardened
#
# Usage:
#   BASE=https://polypropicks.com PPP_SECRET=<secret> bash scripts/contur3_premvp_doctor.sh
#
# Secret env (first match wins):
#   PPP_SECRET | EXECUTOR_SECRET | EXECUTOR_CRON_SECRET
#
# Requires: curl, jq (both must be in PATH)
# Prints ALL_PASS_PHASE3_PREMVP_AUTOMATION when all checks pass.

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
echo "═══ Contur3 PREMVP Doctor (Phase 3) ═══"
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

# ─── 2. Reservation plan status (read-only) ───────────────────────────────────
echo "── 2. /api/cron/night-event-reservations?mode=status (read-only plan health)"
res_json=$(fetch_json "${BASE}/api/cron/night-event-reservations?mode=status")
res_ok=$(echo "$res_json" | jq -r '.ok // "false"')
res_run=$(echo "$res_json" | jq -r '.plan_run_id // "null"')
res_mode=$(echo "$res_json" | jq -r '.mode // "null"')
res_in_window=$(echo "$res_json" | jq -r '.in_creation_window // "null"')

# plan_health fields
ph_has_rows=$(echo "$res_json" | jq -r '.plan_health.has_rows // "null"')
ph_total=$(echo "$res_json" | jq -r '.plan_health.total_count // "null"')
ph_active=$(echo "$res_json" | jq -r '.plan_health.active_future_count // "null"')
ph_expired=$(echo "$res_json" | jq -r '.plan_health.expired_count // "null"')
ph_bad=$(echo "$res_json" | jq -r '.plan_health.bad_market_level_count // "null"')
ph_expired_only=$(echo "$res_json" | jq -r '.plan_health.is_expired_only // "null"')
ph_needs_rebuild=$(echo "$res_json" | jq -r '.plan_health.needs_rebuild // "null"')

if [ "$res_ok" = "true" ]; then
  pass "reservation status  plan_run_id=${res_run}  read_only=${res_mode}  in_creation_window=${res_in_window}"
  pass "plan_health  total=${ph_total}  active_future=${ph_active}  expired=${ph_expired}  bad_market_level=${ph_bad}"

  # FAIL: bad market-level keys in plan
  if [ "$ph_bad" != "null" ] && [ "$ph_bad" != "0" ]; then
    fail "bad_market_level_count=${ph_bad} — plan contains market-level prop keys, needs rebuild"
  fi

  # FAIL: plan is expired-only (all rows past, none active future)
  if [ "$ph_expired_only" = "true" ]; then
    fail "plan is EXPIRED_ONLY (is_expired_only=true, active_future_count=0) — run forceRebuild or wait for 17:00 cron"
  fi

  # WARN: plan needs_rebuild
  if [ "$ph_needs_rebuild" = "true" ]; then
    warn "plan_health.needs_rebuild=true — consider ?forceRebuild=CEO_APPROVED"
  fi
else
  err=$(echo "$res_json" | jq -r '.error // "unknown"')
  fail "reservation status ok=false  error=${err}"
fi
echo ""

# Save active_future_count for cross-check with rebalance
RES_ACTIVE_FUTURE="${ph_active:-0}"

# ─── 3. Event-rebalance dryRun ────────────────────────────────────────────────
echo "── 3. /api/cron/event-rebalance?dryRun=1"
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

  # FAIL: next_due_iso is null while there are active future reservations
  if [ "$reb_next" = "null" ] && [ "$RES_ACTIVE_FUTURE" != "null" ] && [ "$RES_ACTIVE_FUTURE" != "0" ]; then
    fail "rebalance next_due_iso=null but active_future_count=${RES_ACTIVE_FUTURE} — rebalance cannot see active reservations"
  fi

  # WARN: ireland_autostart_expected=true but due_count=0
  if [ "$reb_due" = "0" ] && [ "$reb_ireland" = "true" ]; then
    warn "ireland_autostart_expected=true but due_count=0 — review logic"
  fi
else
  err=$(echo "$reb_json" | jq -r '.error // "unknown"')
  fail "/api/cron/event-rebalance ok=false  error=${err}"
fi
echo ""

# ─── 4. Queue endpoint contract ───────────────────────────────────────────────
echo "── 4. /api/executor/queue?includeUpcoming=1"
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

if [ "$q_ok" = "true" ]; then
  # FAIL: wrong source
  if [ "$q_source" != "event_execution_queue" ]; then
    fail "queue source=${q_source} (expected event_execution_queue) — SPLIT BRAIN RISK"
  else
    pass "/api/executor/queue  source=${q_source}  candidates=${q_count}  ready_total=${q_ready}  next_due=${q_next}"
  fi

  # FAIL: ireland_contract incomplete or allows broad/ranking/Tier2
  if [ "$q_ireland" = "event_execution_queue" ] && \
     [ "$q_norank" = "true" ] && \
     [ "$q_nobroad" = "true" ] && \
     [ "$q_notier" = "true" ]; then
    pass "ireland_contract intact  read_only_source=${q_ireland}  do_not_rank=${q_norank}  do_not_pull_broad=${q_nobroad}  do_not_apply_tier2_tier3=${q_notier}"
  else
    fail "ireland_contract INCOMPLETE or allows broad pull/ranking/Tier2 — do_not_rank=${q_norank} do_not_pull_broad=${q_nobroad} do_not_apply_tier2_tier3=${q_notier}"
  fi
else
  err=$(echo "$q_json" | jq -r '.error // "unknown"')
  fail "/api/executor/queue ok=${q_ok}  error=${err}"
fi
echo ""

# ─── 5. Night-plan diagnostic-only safety ────────────────────────────────────
echo "── 5. /api/executor/night-plan (must NOT expose executable top-level candidates)"
np_json=$(fetch_json "${BASE}/api/executor/night-plan")
np_diag=$(echo "$np_json" | jq -r '.diagnostic_only // "false"')
np_cands=$(echo "$np_json" | jq -r '.candidates | length')
np_src=$(echo "$np_json" | jq -r '.executable_source // "null"')

if [ "$np_cands" = "0" ] && [ "$np_diag" = "true" ]; then
  pass "/api/executor/night-plan  diagnostic_only=true  candidates[]=0  executable_source=${np_src}"
elif [ "$np_cands" = "0" ]; then
  fail "/api/executor/night-plan  candidates[]=0 but diagnostic_only!=true — marker missing"
else
  fail "/api/executor/night-plan EXPOSED ${np_cands} top-level candidates — SPLIT BRAIN RISK!"
fi
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}ALL PASS${NC}  ${PASS}/${TOTAL} checks passed"
  echo "ALL_PASS_PHASE3_PREMVP_AUTOMATION"
  exit 0
else
  echo -e "${RED}FAIL${NC}  ${PASS}/${TOTAL} passed, ${FAIL} failed"
  echo "Contur3 PREMVP automation: DEGRADED — review failures above"
  exit 1
fi
