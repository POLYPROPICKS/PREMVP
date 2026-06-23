#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Contur3 Ireland CEO-Gated Live Unlock Script
#  Date: 2026-06-23
#
#  SAFE BY DEFAULT — does NOT remove hard-stop unless called with:
#    --remove-hard-stop=CEO_APPROVED
#  AND all validation checks pass.
#
#  Usage (Ireland terminal, /home/ubuntu/polymarket-executor):
#    bash IRELAND_PHASE5_CEO_UNLOCK_COMMAND.sh
#          → validation only, hard-stop stays ON
#
#    bash IRELAND_PHASE5_CEO_UNLOCK_COMMAND.sh --remove-hard-stop=CEO_APPROVED
#          → validation + hard-stop removal + starts queue-only watcher
#
#  Requires: curl, jq, EXECUTOR_CANDIDATES_SECRET in env
#  Does NOT contain any private secrets.
#  Does NOT send any order directly.
#  Only starts queue-only watcher after hard-stop removal.
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

CEO_FLAG="${1:-}"
REMOVE_HARD_STOP=false
if [ "$CEO_FLAG" = "--remove-hard-stop=CEO_APPROVED" ]; then
  REMOVE_HARD_STOP=true
fi

WORKDIR="/home/ubuntu/polymarket-executor"
SOURCE_ENV="$WORKDIR/config/executor-source.env"
HARD_STOP_TMP="/tmp/PPP_LIVE_HARD_STOP"
HARD_STOP_DATA="$WORKDIR/data/PPP_LIVE_HARD_STOP"
QUEUE_WATCHER="$WORKDIR/scripts/contur3_queue_only_watcher.sh"
PREMVP_BASE="${PREMVP_BASE:-https://polypropicks.com}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAIL=0
pass() { echo -e "  ${GREEN}PASS${NC}  $1"; }
fail() { echo -e "  ${RED}FAIL${NC}  $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "  ${YELLOW}WARN${NC}  $1"; }

echo ""
echo "═══ Contur3 Ireland CEO-Gated Unlock ═══"
echo "DATE: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "REMOVE_HARD_STOP: $REMOVE_HARD_STOP"
echo ""

# ── 1. Working directory ──────────────────────────────────────────────────────
echo "── 1. Working directory"
if [ "$(pwd)" != "$WORKDIR" ]; then
  fail "Not in $WORKDIR — cd there first"
else
  pass "Working directory: $WORKDIR"
fi
echo ""

# ── 2. executor-source.env ────────────────────────────────────────────────────
echo "── 2. executor-source.env"
if [ ! -f "$SOURCE_ENV" ]; then
  fail "$SOURCE_ENV not found — Ireland source config missing"
else
  pass "$SOURCE_ENV exists"
  QUEUE_SOURCE_VAL=$(grep -E '^QUEUE_SOURCE=' "$SOURCE_ENV" | head -1 | cut -d= -f2- | tr -d '[:space:]')
  if [ "$QUEUE_SOURCE_VAL" = "/api/executor/queue" ]; then
    pass "QUEUE_SOURCE=/api/executor/queue ✓"
  else
    fail "QUEUE_SOURCE=${QUEUE_SOURCE_VAL} (expected /api/executor/queue) — SPLIT BRAIN RISK"
  fi
fi
echo ""

# ── 3. No active source pointing to forbidden endpoints ───────────────────────
echo "── 3. Active source isolation (no night-plan / candidates)"
# Scan active scripts (not .bak quarantine files) for forbidden sources
FORBIDDEN_REFS=0
for pattern in "/api/executor/night-plan" "/api/executor/candidates"; do
  hits=$(grep -rl "$pattern" "$WORKDIR/scripts/" 2>/dev/null \
    | grep -v '\.bak$' \
    | grep -v IRELAND_PHASE5_CEO_UNLOCK_COMMAND \
    | wc -l || true)
  if [ "$hits" -gt 0 ]; then
    fail "Active script references '$pattern' — quarantine these .bak files first"
    FORBIDDEN_REFS=$((FORBIDDEN_REFS + 1))
  fi
done
if [ "$FORBIDDEN_REFS" -eq 0 ]; then
  pass "No active scripts reference /api/executor/night-plan or /api/executor/candidates"
fi
echo ""

# ── 4. Queue-only watcher exists ─────────────────────────────────────────────
echo "── 4. Queue-only watcher"
if [ -f "$QUEUE_WATCHER" ]; then
  pass "Queue-only watcher found: $QUEUE_WATCHER"
else
  fail "Queue-only watcher not found at $QUEUE_WATCHER — install from runbook first"
fi
echo ""

# ── 5. Old wrappers not executable ────────────────────────────────────────────
echo "── 5. Old wrappers must not be executable"
OLD_WRAPPERS=(
  "$WORKDIR/scripts/run_ireland_trusted_live.sh"
  "$WORKDIR/scripts/ireland_trusted_pull_loop.py"
  "$WORKDIR/scripts/run_tonight_live_loop.sh"
  "$WORKDIR/scripts/start_contur3_p0f_live.sh"
  "$WORKDIR/scripts/start_contur3_p0f_norepull_live.sh"
)
for f in "${OLD_WRAPPERS[@]}"; do
  if [ -f "$f" ] && [ -x "$f" ]; then
    fail "Old wrapper is executable: $f — chmod -x it"
  elif [ -f "$f" ]; then
    pass "Old wrapper exists but not executable: $(basename $f)"
  else
    pass "Old wrapper absent (ok): $(basename $f)"
  fi
done
echo ""

# ── 6. No existing live order process ────────────────────────────────────────
echo "── 6. No existing live order process"
LIVE_PROCS=$(pgrep -f "polymarket.*live\|ireland.*live\|run_tonight\|start_contur3" 2>/dev/null | wc -l || echo 0)
if [ "$LIVE_PROCS" -gt 0 ]; then
  fail "Existing live-order process detected (count=$LIVE_PROCS) — kill before unlock"
else
  pass "No live-order process running"
fi
echo ""

# ── 7. Queue validation ───────────────────────────────────────────────────────
echo "── 7. Queue validation (calls PREMVP)"
if [ -z "${EXECUTOR_CANDIDATES_SECRET:-}" ]; then
  fail "EXECUTOR_CANDIDATES_SECRET not set in env — cannot call queue"
else
  Q_JSON=$(curl -sf "$PREMVP_BASE/api/executor/queue?includeUpcoming=1" \
    -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" 2>/dev/null || echo '{"ok":false,"error":"curl_failed"}')

  Q_OK=$(echo "$Q_JSON" | jq -r '.ok // "false"')
  Q_SOURCE=$(echo "$Q_JSON" | jq -r '.source // "null"')
  Q_COUNT=$(echo "$Q_JSON" | jq -r '.candidate_count // 0')
  Q_NEXT=$(echo "$Q_JSON" | jq -r '.next_due_iso // "null"')

  if [ "$Q_OK" != "true" ]; then
    fail "Queue returned ok=false — check PREMVP logs"
  else
    pass "Queue ok=true  source=${Q_SOURCE}  candidate_count=${Q_COUNT}  next_due=${Q_NEXT}"
  fi

  if [ "$Q_SOURCE" != "event_execution_queue" ]; then
    fail "Queue source=${Q_SOURCE} (expected event_execution_queue) — SPLIT BRAIN"
  else
    pass "Queue source=event_execution_queue ✓"
  fi

  if [ "$Q_COUNT" -le 0 ] 2>/dev/null; then
    fail "candidate_count=${Q_COUNT} — queue is empty, cannot unlock. Wait for rebalance."
  else
    pass "candidate_count=${Q_COUNT} > 0 ✓"
  fi

  # Per-candidate validation
  CAND_FAIL=0
  while IFS= read -r cand; do
    CID=$(echo "$cand" | jq -r '.condition_id // ""')
    TID=$(echo "$cand" | jq -r '.token_id // ""')
    SIDE=$(echo "$cand" | jq -r '.side // ""')
    STAKE=$(echo "$cand" | jq -r '.stake_usd // 0')
    TIER=$(echo "$cand" | jq -r '.tier // ""')
    MKT=$(echo "$cand" | jq -r '.market_slug // ""')
    SRC=$(echo "$cand" | jq -r '.source // "event_execution_queue"')
    MFKEY=$(echo "$cand" | jq -r '.match_family_key // ""')

    CAND_OK=true
    if [ -z "$CID" ]; then
      fail "Candidate missing condition_id: $MFKEY"
      CAND_OK=false
    fi
    if [ -z "$TID" ]; then
      fail "Candidate missing token_id: $MFKEY"
      CAND_OK=false
    fi
    if [ -z "$SIDE" ]; then
      fail "Candidate missing side: $MFKEY"
      CAND_OK=false
    fi
    # stake_usd must be <= 7
    STAKE_CHECK=$(echo "$STAKE <= 7" | bc -l 2>/dev/null || echo "0")
    if [ "$STAKE_CHECK" != "1" ]; then
      fail "Candidate stake_usd=${STAKE} > 7: $MFKEY"
      CAND_OK=false
    fi
    # tier must contain TIER1
    if [[ "$TIER" != *"TIER1"* ]]; then
      fail "Candidate tier=${TIER} is not TIER1: $MFKEY"
      CAND_OK=false
    fi
    # halftime check
    if echo "$MKT $MFKEY" | grep -qi "halftime\|half.time\|first.half\|1st.half"; then
      fail "Candidate is halftime/first-half market: $MFKEY ($MKT)"
      CAND_OK=false
    fi
    if [ "$CAND_OK" = "true" ]; then
      pass "Candidate valid: $MFKEY  tier=${TIER}  stake=${STAKE}  side=${SIDE}"
    else
      CAND_FAIL=$((CAND_FAIL + 1))
    fi
  done < <(echo "$Q_JSON" | jq -c '.candidates[]')

  if [ "$CAND_FAIL" -gt 0 ]; then
    FAIL=$((FAIL + CAND_FAIL))
  fi
fi
echo ""

# ── Final verdict ─────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}STOP${NC}  ${FAIL} validation failure(s) — hard-stop REMAINS ON"
  if [ "$REMOVE_HARD_STOP" = "true" ]; then
    echo "CEO flag was set but validation failed — hard-stop NOT removed. Fix failures first."
  fi
  exit 1
fi

echo -e "${GREEN}ALL VALIDATION PASSED${NC}"

if [ "$REMOVE_HARD_STOP" = "false" ]; then
  echo "Dry-run mode — hard-stop NOT removed (pass --remove-hard-stop=CEO_APPROVED to unlock)"
  exit 0
fi

# ── Remove hard-stop (CEO_APPROVED path only) ─────────────────────────────────
echo ""
echo "── Removing hard-stop (CEO_APPROVED)"
for STOP_FILE in "$HARD_STOP_TMP" "$HARD_STOP_DATA"; do
  if [ -f "$STOP_FILE" ]; then
    rm -f "$STOP_FILE"
    echo "  Removed: $STOP_FILE"
  else
    echo "  Already absent: $STOP_FILE"
  fi
done

# Verify removal
for STOP_FILE in "$HARD_STOP_TMP" "$HARD_STOP_DATA"; do
  if [ -f "$STOP_FILE" ]; then
    fail "Hard-stop file still exists: $STOP_FILE"
    exit 1
  fi
done
echo "  Hard-stop removed ✓"
echo ""

# ── Start queue-only watcher ──────────────────────────────────────────────────
echo "── Starting queue-only watcher"
if [ ! -f "$QUEUE_WATCHER" ]; then
  fail "Queue watcher not found — cannot start"
  exit 1
fi
nohup bash "$QUEUE_WATCHER" >> "$WORKDIR/logs/contur3_queue_watcher.log" 2>&1 &
WATCHER_PID=$!
sleep 2
if kill -0 "$WATCHER_PID" 2>/dev/null; then
  pass "Queue-only watcher started (PID=$WATCHER_PID)"
else
  fail "Queue-only watcher failed to start — check logs"
  exit 1
fi
echo ""

# ── Final evidence ────────────────────────────────────────────────────────────
echo "── Final evidence"
echo "  hardstop_absent  : true"
echo "  queue_source     : $Q_SOURCE"
echo "  candidate_count  : $Q_COUNT"
echo "  next_due_iso     : $Q_NEXT"
echo ""
echo "  Process list (polymarket):"
pgrep -fa "polymarket\|contur3\|queue_watcher" 2>/dev/null || echo "  (none matched)"
echo ""
echo "  Last 80 lines of queue watcher log:"
WATCHER_LOG="$WORKDIR/logs/contur3_queue_watcher.log"
if [ -f "$WATCHER_LOG" ]; then
  tail -80 "$WATCHER_LOG"
else
  echo "  (log not yet created)"
fi
echo ""
echo -e "${GREEN}IRELAND LIVE UNLOCK COMPLETE — queue-only watcher running${NC}"
exit 0
