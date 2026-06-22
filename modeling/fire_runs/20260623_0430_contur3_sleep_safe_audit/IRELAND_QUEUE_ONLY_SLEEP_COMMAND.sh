#!/usr/bin/env bash
# IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh
# Contur3 Sleep-Safe tick loop for Ireland.
#
# Contract (LOCKED):
#   - Reads ONLY /api/executor/queue from PREMVP
#   - Also calls /api/cron/event-rebalance on PREMVP to trigger market selection
#   - NEVER calls /candidates, /night-plan, or any broad FireModel endpoint
#   - NEVER applies Tier2/Tier3 logic
#   - NEVER places orders directly — only reads READY rows from queue
#   - Sleeps next_check_after_seconds when queue is empty and next_due_iso is known
#
# Usage:
#   export PREMVP_URL="https://your-premvp.up.railway.app"
#   export EXECUTOR_SECRET="your-executor-secret-here"
#   bash IRELAND_QUEUE_ONLY_SLEEP_COMMAND.sh
#
# Output file: /tmp/contur3_queue_candidates.json (overwritten each loop)
# Ireland executor reads this file to decide execution.

set -euo pipefail

PREMVP_URL="${PREMVP_URL:?Set PREMVP_URL}"
EXECUTOR_SECRET="${EXECUTOR_SECRET:?Set EXECUTOR_SECRET}"
QUEUE_OUT="/tmp/contur3_queue_candidates.json"
MIN_SLEEP=30
MAX_SLEEP=3600

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

trigger_rebalance() {
  local resp
  resp=$(curl -sf -X POST "${PREMVP_URL}/api/cron/event-rebalance" \
    -H "x-executor-secret: ${EXECUTOR_SECRET}" \
    --max-time 30 2>/dev/null) || { log "WARN: rebalance call failed"; echo "{}"; return; }
  echo "$resp"
}

read_queue() {
  local resp
  resp=$(curl -sf -X GET "${PREMVP_URL}/api/executor/queue?includeUpcoming=1" \
    -H "x-executor-secret: ${EXECUTOR_SECRET}" \
    --max-time 30 2>/dev/null) || { log "WARN: queue call failed"; echo "{}"; return; }
  echo "$resp"
}

extract_json() {
  # $1 = JSON string, $2 = key
  echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('$2'); print('' if v is None else v)" 2>/dev/null || echo ""
}

log "=== Contur3 Ireland Queue-Only Tick Loop ==="
log "PREMVP: ${PREMVP_URL}"
log "Output: ${QUEUE_OUT}"

while true; do
  log "--- tick ---"

  # Step 1: Trigger rebalance on PREMVP (idempotent — safe to call every loop)
  log "Calling PREMVP event-rebalance..."
  REBAL=$(trigger_rebalance)
  REBAL_DUE=$(extract_json "$REBAL" "due_count")
  REBAL_QUEUED=$(extract_json "$REBAL" "queued_count")
  REBAL_NEXT_CHECK=$(extract_json "$REBAL" "next_check_after_seconds")
  REBAL_NEXT_ISO=$(extract_json "$REBAL" "next_due_iso")
  REBAL_IRELAND=$(extract_json "$REBAL" "ireland_autostart_expected")
  log "  due=${REBAL_DUE} queued=${REBAL_QUEUED} next_due_iso=${REBAL_NEXT_ISO} ireland_autostart=${REBAL_IRELAND}"

  # Step 2: Read queue
  log "Calling PREMVP queue..."
  QUEUE=$(read_queue)
  CANDIDATE_COUNT=$(extract_json "$QUEUE" "candidate_count")
  QUEUE_NEXT_CHECK=$(extract_json "$QUEUE" "next_check_after_seconds")
  QUEUE_NEXT_ISO=$(extract_json "$QUEUE" "next_due_iso")
  log "  candidate_count=${CANDIDATE_COUNT} next_check_after_seconds=${QUEUE_NEXT_CHECK}"

  # Step 3: Write candidates file
  echo "$QUEUE" > "$QUEUE_OUT"
  log "  Wrote ${QUEUE_OUT}"

  # Step 4: Determine sleep duration
  if [ -n "$CANDIDATE_COUNT" ] && [ "$CANDIDATE_COUNT" -gt 0 ]; then
    log "  CANDIDATES AVAILABLE — executor should execute now"
    SLEEP_SECS=$MIN_SLEEP
  elif [ -n "$QUEUE_NEXT_CHECK" ] && [ "$QUEUE_NEXT_CHECK" -gt 0 ]; then
    # Sleep until next rebalance window opens (with MIN floor)
    SLEEP_SECS=$(( QUEUE_NEXT_CHECK > MIN_SLEEP ? QUEUE_NEXT_CHECK : MIN_SLEEP ))
    SLEEP_SECS=$(( SLEEP_SECS < MAX_SLEEP ? SLEEP_SECS : MAX_SLEEP ))
    log "  No candidates — sleeping ${SLEEP_SECS}s (next rebalance at ${QUEUE_NEXT_ISO})"
  elif [ -n "$REBAL_NEXT_CHECK" ] && [ "$REBAL_NEXT_CHECK" -gt 0 ]; then
    SLEEP_SECS=$(( REBAL_NEXT_CHECK > MIN_SLEEP ? REBAL_NEXT_CHECK : MIN_SLEEP ))
    SLEEP_SECS=$(( SLEEP_SECS < MAX_SLEEP ? SLEEP_SECS : MAX_SLEEP ))
    log "  No candidates — sleeping ${SLEEP_SECS}s (rebalance: ${REBAL_NEXT_ISO})"
  else
    SLEEP_SECS=120
    log "  No next_due_iso — default sleep ${SLEEP_SECS}s"
  fi

  log "Sleeping ${SLEEP_SECS}s..."
  sleep "$SLEEP_SECS"
done
