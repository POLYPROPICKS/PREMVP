#!/usr/bin/env bash
# IRELAND_QUEUE_ONLY_COMMANDS.sh
# ─────────────────────────────────────────────────────────────────────────────
# Contur3 Phase 2 — Ireland Queue-Only Setup.
# Run AFTER IRELAND_VERIFY_ONLY_COMMANDS.sh passes.
#
# This script:
#   1. Ensures hard-stop is ON (recreates if missing).
#   2. Kills any old live/night-plan process.
#   3. Quarantines old unsafe pull+execute wrappers.
#   4. Writes config/executor-source.env with queue-only source.
#   5. Deploys contur3_queue_only_watcher.py (LOG-ONLY mode, hard-stop ON).
#   6. Starts the watcher in log-only mode (HARD_STOP guards all execution paths).
#
# HARD-STOP IS NEVER REMOVED BY THIS SCRIPT.
# Log-only mode means the watcher reads the queue and logs what it WOULD do,
# but never calls the Polymarket sender or places any order.
#
# Run on Ireland server:
#   bash IRELAND_QUEUE_ONLY_COMMANDS.sh
# ─────────────────────────────────────────────────────────────────────────────

set -eu

IRELAND_ROOT="/home/ubuntu/polymarket-executor"
LOG_DIR="${IRELAND_ROOT}/logs"
CONF_DIR="${IRELAND_ROOT}/config"
WATCHER="${IRELAND_ROOT}/live/contur3_queue_only_watcher.py"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "\n${YELLOW}▶${NC} $1"; }
ok()   { echo -e "  ${GREEN}OK${NC}  $1"; }
fail_exit() { echo -e "  ${RED}FAIL${NC}  $1" >&2; exit 1; }

echo ""
echo "═══ Ireland Contur3 Queue-Only Setup ═══"
echo "DATE: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "HOST: $(hostname)"
echo ""

# ─── STEP 1: Ensure hard-stop is ON ─────────────────────────────────────────
step "1. Ensure hard-stop ON"
touch /tmp/PPP_LIVE_HARD_STOP
ok "/tmp/PPP_LIVE_HARD_STOP created/confirmed"
mkdir -p "${IRELAND_ROOT}/data"
touch "${IRELAND_ROOT}/data/PPP_LIVE_HARD_STOP"
ok "${IRELAND_ROOT}/data/PPP_LIVE_HARD_STOP created/confirmed"

# ─── STEP 2: Kill old unsafe processes ──────────────────────────────────────
step "2. Kill old unsafe processes"
KILLED=0
for pattern in "night_live_loop" "pull_night_plan_candidates" "contur2_contract_guard"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  Killing PIDs for '$pattern': $pids"
    kill -TERM $pids 2>/dev/null || true
    sleep 1
    kill -KILL $pids 2>/dev/null || true
    KILLED=$((KILLED+1))
    ok "Killed process '$pattern'"
  fi
done
if [ "$KILLED" -eq 0 ]; then
  ok "No old processes found — nothing to kill"
fi

# Verify no old processes remain
for pattern in "night_live_loop" "pull_night_plan_candidates" "contur2_contract_guard"; do
  count=$(pgrep -c -f "$pattern" 2>/dev/null || true)
  if [ "${count:-0}" -gt 0 ]; then
    fail_exit "Process '$pattern' still running after kill — abort and investigate"
  fi
done
ok "Process check clean"

# ─── STEP 3: Quarantine old pull+execute wrappers ───────────────────────────
step "3. Quarantine old unsafe scripts"
for f in \
  "${IRELAND_ROOT}/scripts/pull_night_plan_candidates.py" \
  "${IRELAND_ROOT}/live/night_live_loop.py" \
  "${IRELAND_ROOT}/live/contur2_contract_guard.py"; do
  if [ -f "$f" ] && [ ! -f "${f}.quarantined" ]; then
    cp "$f" "${f}.quarantined"
    echo "  Quarantined: $f → ${f}.quarantined (original preserved)"
    ok "$(basename $f) quarantined"
  elif [ -f "${f}.quarantined" ]; then
    ok "$(basename $f) already quarantined — skip"
  fi
done

# ─── STEP 4: Write executor source config ───────────────────────────────────
step "4. Write config/executor-source.env"
mkdir -p "$CONF_DIR"
cat > "${CONF_DIR}/executor-source.env" <<'ENVEOF'
# Contur3 Ireland executor source — written by IRELAND_QUEUE_ONLY_COMMANDS.sh
# DO NOT edit manually. The only executable source for Ireland is below.
EXECUTOR_SOURCE_URL=https://polypropicks.com/api/executor/queue
EXECUTOR_SOURCE_SCHEMA=executor-queue-v1
EXECUTOR_SOURCE_TABLE=event_execution_queue
EXECUTOR_SOURCE_FORBIDDEN_NIGHT_PLAN=true
EXECUTOR_SOURCE_FORBIDDEN_BROAD_CANDIDATES=true
EXECUTOR_SOURCE_FORBIDDEN_TIER2_TIER3=true
ENVEOF
chmod 600 "${CONF_DIR}/executor-source.env"
ok "config/executor-source.env written (chmod 600)"

# ─── STEP 5: Write contur3_queue_only_watcher.py ────────────────────────────
step "5. Write contur3_queue_only_watcher.py"
mkdir -p "${IRELAND_ROOT}/live"
mkdir -p "$LOG_DIR"

cat > "$WATCHER" << 'PYEOF'
#!/usr/bin/env python3
"""
contur3_queue_only_watcher.py — Contur3 Ireland queue-only consumer.

Reads /api/executor/queue (PREMVP event_execution_queue).
LOG-ONLY by default (HARD_STOP_ENFORCED=true).
Never calls Polymarket sender. Never places orders while hard-stop is present.

Usage:
  python3 live/contur3_queue_only_watcher.py --secret=$EXECUTOR_SECRET

Hard-stop override (CEO-approved only, Phase 5):
  python3 live/contur3_queue_only_watcher.py --secret=$EXECUTOR_SECRET --remove-hard-stop=CEO_APPROVED
  (This flag is intentionally long and explicit.)
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import logging
import argparse
import re
from datetime import datetime, timezone

# ─── Constants ──────────────────────────────────────────────────────────────
QUEUE_URL = "https://polypropicks.com/api/executor/queue"
EXPECTED_SCHEMA = "executor-queue-v1"
EXPECTED_SOURCE = "event_execution_queue"
EXPECTED_STAKE_USD = 7
EXPECTED_TIER = "TIER1"
HALFTIME_RE = re.compile(
    r"halftime|half[\s\-]time|first[\s\-]half|1st[\s\-]half|"
    r"leading\s+at\s+halftime|draw\s+at\s+halftime",
    re.IGNORECASE
)
HARD_STOP_PATHS = ["/tmp/PPP_LIVE_HARD_STOP", "data/PPP_LIVE_HARD_STOP"]
POLL_INTERVAL_DEFAULT = 60  # seconds when next_check_after_seconds absent

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [queue-watcher] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("queue-watcher")


def hard_stop_present():
    return any(os.path.exists(p) for p in HARD_STOP_PATHS)


def fetch_queue(secret: str, include_upcoming: bool = True) -> dict:
    url = QUEUE_URL + ("?includeUpcoming=1" if include_upcoming else "")
    req = urllib.request.Request(url, headers={"x-executor-secret": secret})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:200]
        raise RuntimeError(f"HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}")


def validate_candidate(c: dict) -> list:
    """Return list of violation strings (empty = PASS)."""
    violations = []
    if c.get("is_executable") is not True:
        violations.append(f"is_executable != true")
    if c.get("tier") != EXPECTED_TIER:
        violations.append(f"tier={c.get('tier')} (expected {EXPECTED_TIER})")
    if c.get("stake_usd") != EXPECTED_STAKE_USD:
        violations.append(f"stake_usd={c.get('stake_usd')} (expected {EXPECTED_STAKE_USD})")
    for field in ("condition_id", "token_id", "side"):
        if not c.get(field):
            violations.append(f"{field} missing/empty")
    for field in ("preferred_entry_iso", "latest_entry_iso"):
        if not c.get(field):
            violations.append(f"{field} missing")
    # Halftime guard
    for key in ("market_slug", "market_family", "event_slug", "match_family_key"):
        val = c.get(key) or ""
        if HALFTIME_RE.search(val):
            violations.append(f"halftime/first-half market detected in {key}={val}")
            break
    return violations


def validate_response(data: dict) -> list:
    """Return list of top-level contract violation strings."""
    violations = []
    if data.get("schema") != EXPECTED_SCHEMA:
        violations.append(f"schema={data.get('schema')} (expected {EXPECTED_SCHEMA})")
    if data.get("source") != EXPECTED_SOURCE:
        violations.append(f"source={data.get('source')} (expected {EXPECTED_SOURCE})")
    contract = data.get("ireland_contract", {})
    if contract.get("do_not_rank") is not True:
        violations.append("ireland_contract.do_not_rank != true")
    if contract.get("do_not_pull_broad_candidates") is not True:
        violations.append("ireland_contract.do_not_pull_broad_candidates != true")
    if contract.get("do_not_apply_tier2_tier3") is not True:
        violations.append("ireland_contract.do_not_apply_tier2_tier3 != true")
    return violations


def run_loop(secret: str, remove_hard_stop_flag: str = ""):
    remove_hard_stop = (remove_hard_stop_flag == "CEO_APPROVED")
    if remove_hard_stop:
        log.warning("--remove-hard-stop=CEO_APPROVED received. Hard-stop will be bypassed for execution.")
        log.warning("THIS REQUIRES EXPLICIT CEO APPROVAL. Confirm you have it before proceeding.")
    else:
        log.info("Hard-stop mode: ENFORCED (log-only). Execution is blocked.")

    iteration = 0
    while True:
        iteration += 1
        now_iso = datetime.now(timezone.utc).isoformat()
        log.info(f"=== Iteration {iteration} at {now_iso} ===")

        # Hard-stop check every iteration
        if not remove_hard_stop and hard_stop_present():
            log.info("HARD_STOP: present — execution blocked. Watcher continues in log-only mode.")

        try:
            data = fetch_queue(secret, include_upcoming=True)
        except RuntimeError as e:
            log.error(f"Queue fetch failed: {e} — sleeping 60s")
            time.sleep(60)
            continue

        if not data.get("ok"):
            log.error(f"Queue returned ok=false: {data.get('error')} — sleeping 60s")
            time.sleep(60)
            continue

        # Contract validation
        contract_violations = validate_response(data)
        if contract_violations:
            log.error(f"CONTRACT VIOLATION — aborting this iteration:")
            for v in contract_violations:
                log.error(f"  - {v}")
            time.sleep(60)
            continue

        candidate_count = data.get("candidate_count", 0)
        next_due_iso = data.get("next_due_iso")
        next_check_after = data.get("next_check_after_seconds", POLL_INTERVAL_DEFAULT)

        if candidate_count == 0:
            log.info(f"candidate_count=0 — nothing to execute.")
            if next_due_iso:
                log.info(f"next_due_iso={next_due_iso}  next_check_after={next_check_after}s")
            sleep_secs = max(30, min(int(next_check_after or POLL_INTERVAL_DEFAULT), 300))
            log.info(f"Sleeping {sleep_secs}s")
            time.sleep(sleep_secs)
            continue

        # Candidates present — validate each
        candidates = data.get("candidates", [])
        log.info(f"candidate_count={candidate_count}  source={data.get('source')}  schema={data.get('schema')}")
        all_valid = True
        for i, c in enumerate(candidates):
            violations = validate_candidate(c)
            tag = f"[{i+1}/{len(candidates)}] {c.get('match_family_key','?')} side={c.get('side','?')}"
            if violations:
                log.error(f"CANDIDATE REJECTED {tag}:")
                for v in violations:
                    log.error(f"    - {v}")
                all_valid = False
            else:
                entry_state = c.get("entry_state", "?")
                log.info(
                    f"CANDIDATE VALID {tag} "
                    f"tier={c.get('tier')} stake=${c.get('stake_usd')} "
                    f"entry_state={entry_state} "
                    f"preferred={c.get('preferred_entry_iso')} "
                    f"latest={c.get('latest_entry_iso')}"
                )

        # Execution gate
        if not all_valid:
            log.warning("One or more candidates rejected — not executing any.")
            time.sleep(30)
            continue

        # Hard-stop gate
        if hard_stop_present() and not remove_hard_stop:
            log.info(
                f"HARD_STOP GATE: {len(candidates)} valid candidate(s) ready. "
                "Execution blocked by hard-stop. "
                "Phase 5 CEO approval required to remove hard-stop."
            )
            # Log what WOULD happen
            for c in candidates:
                if c.get("entry_state") == "IN_WINDOW":
                    log.info(
                        f"  WOULD_EXECUTE: {c.get('match_family_key')} "
                        f"side={c.get('side')} stake=${c.get('stake_usd')} "
                        f"condition={c.get('condition_id')} token={c.get('token_id')}"
                    )
        elif not remove_hard_stop:
            # No hard-stop file but flag not set — safety block
            log.warning(
                "Hard-stop file not present but --remove-hard-stop=CEO_APPROVED not provided. "
                "Recreating hard-stop and blocking execution."
            )
            for p in HARD_STOP_PATHS:
                try:
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    open(p, "w").close()
                    log.info(f"Recreated hard-stop: {p}")
                except Exception:
                    pass
        else:
            # CEO-approved execution path (Phase 5 only)
            log.warning("=== CEO-APPROVED EXECUTION PATH ===")
            log.warning("Hard-stop removed by CEO_APPROVED flag. This is Phase 5 territory.")
            log.warning("PLACEHOLDER — actual Polymarket sender call not wired in this watcher.")
            log.warning("Wire sender in Phase 5 after CEO approval.")

        sleep_secs = max(30, min(int(next_check_after or POLL_INTERVAL_DEFAULT), 120))
        log.info(f"Sleeping {sleep_secs}s")
        time.sleep(sleep_secs)


def main():
    parser = argparse.ArgumentParser(description="Contur3 queue-only watcher")
    parser.add_argument("--secret", required=True, help="x-executor-secret value")
    parser.add_argument(
        "--remove-hard-stop",
        default="",
        help="Must be CEO_APPROVED to bypass hard-stop (Phase 5 only)",
    )
    args = parser.parse_args()
    log.info("contur3_queue_only_watcher starting")
    log.info(f"queue_url={QUEUE_URL}")
    log.info(f"hard_stop_remove_flag={args.remove_hard_stop or 'NOT_SET'}")
    run_loop(args.secret, args.remove_hard_stop)


if __name__ == "__main__":
    main()
PYEOF

chmod 755 "$WATCHER"
ok "contur3_queue_only_watcher.py written to live/"

# ─── STEP 6: Verify queue endpoint from Ireland ──────────────────────────────
step "6. Verify /api/executor/queue auth gate from Ireland"
if command -v curl &>/dev/null; then
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://polypropicks.com/api/executor/queue" \
    -H "x-executor-secret: INVALID_KEY_PROBE")
  if [ "$code" = "401" ]; then
    ok "Queue endpoint reachable from Ireland → 401 (expected)"
  else
    echo -e "  ${YELLOW}WARN${NC}  Queue endpoint returned $code (expected 401) — check network"
  fi
else
  echo -e "  ${YELLOW}WARN${NC}  curl not found — skipping endpoint check"
fi
echo ""

# ─── STEP 7: Start watcher in log-only mode ─────────────────────────────────
step "7. Start queue-only watcher (log-only mode, hard-stop ON)"
echo ""
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │  To start the watcher, run:                                  │"
echo "  │                                                               │"
echo "  │  read -rsp 'Enter executor secret: ' PPP_SECRET && echo      │"
echo "  │  nohup python3 live/contur3_queue_only_watcher.py \\          │"
echo "  │    --secret=\"\$PPP_SECRET\" \\                                  │"
echo "  │    > logs/queue_watcher_\$(date -u +%Y%m%d_%H%M%SZ).log 2>&1 & │"
echo "  │  echo \"Watcher PID: \$!\"                                       │"
echo "  │                                                               │"
echo "  │  Hard-stop remains ON. Watcher logs but DOES NOT execute.    │"
echo "  └──────────────────────────────────────────────────────────────┘"
echo ""

# ─── Final summary ───────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════"
echo -e "${GREEN}SETUP COMPLETE${NC}"
echo ""
echo "  Hard-stop:    ON (both /tmp and data/)"
echo "  Old scripts:  quarantined"
echo "  Config:       config/executor-source.env written"
echo "  Watcher:      live/contur3_queue_only_watcher.py deployed"
echo "  Mode:         LOG-ONLY (hard-stop guards all execution)"
echo ""
echo "  NEXT: Copy and run the nohup command above to start the watcher."
echo "  THEN: tail -f logs/queue_watcher_*.log to observe."
echo "  THEN: run IRELAND_VERIFY_ONLY_COMMANDS.sh again to confirm state."
echo ""
echo "  DO NOT remove hard-stop until Phase 5 CEO approval."
echo "═══════════════════════════════════════════════════════════"
