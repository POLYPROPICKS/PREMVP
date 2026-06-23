#!/usr/bin/env bash
# IRELAND_VERIFY_ONLY_COMMANDS.sh
# ─────────────────────────────────────────────────────────────────────────────
# Contur3 Phase 2 — Ireland VERIFY-ONLY step.
# Run this FIRST. No writes. No process start. No live orders.
#
# Purpose: confirm Ireland server is in a safe state before any queue-only
#          watcher is started.
#
# Run on Ireland server:
#   bash IRELAND_VERIFY_ONLY_COMMANDS.sh
#
# Expected outcome: all checks PASS, hard-stop present, no old process running.
# ─────────────────────────────────────────────────────────────────────────────

set -eu

IRELAND_ROOT="/home/ubuntu/polymarket-executor"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

ok()   { echo -e "  ${GREEN}PASS${NC}  $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL+1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }

echo ""
echo "═══ Ireland Contur3 Verify-Only ═══"
echo "DATE: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "HOST: $(hostname)"
echo ""

# ─── 1. Hard-stop present ────────────────────────────────────────────────────
echo "── 1. Hard-stop files"
if [ -f "/tmp/PPP_LIVE_HARD_STOP" ]; then
  ok "/tmp/PPP_LIVE_HARD_STOP present"
else
  fail "/tmp/PPP_LIVE_HARD_STOP MISSING — recreate before continuing"
fi
if [ -f "${IRELAND_ROOT}/data/PPP_LIVE_HARD_STOP" ]; then
  ok "${IRELAND_ROOT}/data/PPP_LIVE_HARD_STOP present"
else
  warn "${IRELAND_ROOT}/data/PPP_LIVE_HARD_STOP missing — not fatal but recommended"
fi
echo ""

# ─── 2. No old live process ──────────────────────────────────────────────────
echo "── 2. Old live process check"
OLD_PROCS=0
for pattern in "night_live_loop" "pull_night_plan" "live_test_order" "contur2_contract_guard" "live_executor"; do
  count=$(ps aux 2>/dev/null | grep -c "$pattern" || true)
  # subtract the grep itself
  count=$((count - 1))
  if [ "$count" -gt 0 ]; then
    fail "Found running process matching '$pattern' (count=$count)"
    OLD_PROCS=$((OLD_PROCS+1))
  fi
done
if [ "$OLD_PROCS" -eq 0 ]; then
  ok "No old live processes detected"
fi
echo ""

# ─── 3. Quarantine status ────────────────────────────────────────────────────
echo "── 3. Old script quarantine status"
for f in \
  "${IRELAND_ROOT}/scripts/pull_night_plan_candidates.py" \
  "${IRELAND_ROOT}/live/night_live_loop.py" \
  "${IRELAND_ROOT}/live/contur2_contract_guard.py"; do
  if [ -f "${f}.quarantined" ]; then
    ok "$(basename $f) → quarantined"
  elif [ -f "$f" ]; then
    warn "$(basename $f) NOT quarantined — run IRELAND_QUEUE_ONLY_COMMANDS.sh to quarantine"
  else
    ok "$(basename $f) not present"
  fi
done
echo ""

# ─── 4. Queue-only watcher script present ────────────────────────────────────
echo "── 4. Queue-only watcher script"
if [ -f "${IRELAND_ROOT}/live/contur3_queue_only_watcher.py" ]; then
  ok "contur3_queue_only_watcher.py present"
else
  warn "contur3_queue_only_watcher.py NOT present — run IRELAND_QUEUE_ONLY_COMMANDS.sh to deploy"
fi
echo ""

# ─── 5. Executor source config ───────────────────────────────────────────────
echo "── 5. Executor source config"
CONF="${IRELAND_ROOT}/config/executor-source.env"
if [ -f "$CONF" ]; then
  source "$CONF" 2>/dev/null || true
  if [ "${EXECUTOR_SOURCE_URL:-}" = "https://polypropicks.com/api/executor/queue" ]; then
    ok "EXECUTOR_SOURCE_URL = event_execution_queue endpoint"
  else
    fail "EXECUTOR_SOURCE_URL wrong or missing: '${EXECUTOR_SOURCE_URL:-}'"
  fi
  if [ "${EXECUTOR_SOURCE_FORBIDDEN_NIGHT_PLAN:-}" = "true" ]; then
    ok "EXECUTOR_SOURCE_FORBIDDEN_NIGHT_PLAN = true"
  else
    warn "EXECUTOR_SOURCE_FORBIDDEN_NIGHT_PLAN not set"
  fi
else
  warn "config/executor-source.env not present — run IRELAND_QUEUE_ONLY_COMMANDS.sh"
fi
echo ""

# ─── 6. Queue endpoint liveness check ────────────────────────────────────────
echo "── 6. Queue endpoint (auth-gate only — no secret needed for 401 check)"
if command -v curl &>/dev/null; then
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://polypropicks.com/api/executor/queue" -H "x-executor-secret: INVALID_KEY_PROBE")
  if [ "$code" = "401" ]; then
    ok "https://polypropicks.com/api/executor/queue → 401 (auth gate live)"
  else
    fail "Expected 401 from queue endpoint, got $code — PREMVP may be down"
  fi
else
  warn "curl not found — skipping endpoint liveness check"
fi
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}ALL PASS${NC}  ${PASS}/${TOTAL}"
  echo "Ireland verify: SAFE TO PROCEED with queue-only setup"
else
  echo -e "${RED}FAIL${NC}  ${PASS}/${TOTAL} passed, ${FAIL} failed"
  echo "Ireland verify: FIX failures before proceeding"
  exit 1
fi
