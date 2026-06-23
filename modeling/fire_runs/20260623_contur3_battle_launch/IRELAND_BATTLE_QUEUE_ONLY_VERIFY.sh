#!/usr/bin/env bash
# IRELAND_BATTLE_QUEUE_ONLY_VERIFY.sh
# Validation-only — does NOT remove hard-stop, does NOT send orders.
# Prints ALL_PASS_IRELAND_BATTLE_QUEUE_ONLY_VERIFY only if all checks pass.

set -euo pipefail

EXECUTOR_DIR="/home/ubuntu/polymarket-executor"
cd "$EXECUTOR_DIR" || { echo "ERROR: cannot cd $EXECUTOR_DIR"; exit 1; }

ENV_FILE="config/executor-source.env"
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi

BASE="${BASE:-https://polypropicks.com}"
SECRET="${PPP_SECRET:-${EXECUTOR_SECRET:-}}"
PASS=0; FAIL=0

ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

echo "═══ Ireland Battle Queue-Only Verify ═══"
echo "BASE=$BASE  DATE=$(date -u)"
echo ""

# 1. Hard-stop must be active
echo "── 1. Hard-stop"
if ls /tmp/PPP_LIVE_HARD_STOP data/PPP_LIVE_HARD_STOP 2>/dev/null | grep -q .; then
  ok "Hard-stop active (sends blocked)"
else
  fail "Hard-stop NOT active — live sends not blocked"
fi

# 2. Old wrappers must not be executable
echo "── 2. Old wrapper quarantine"
OLD_WRAPPERS=(
  "scripts/run_ireland_trusted_live.sh"
  "scripts/ireland_trusted_pull_loop.py"
  "scripts/run_tonight_live_loop.sh"
  "scripts/start_contur3_p0f_live.sh"
  "scripts/start_contur3_p0f_norepull_live.sh"
)
for w in "${OLD_WRAPPERS[@]}"; do
  if [ -f "$w" ] && [ -x "$w" ]; then
    fail "Old wrapper still executable: $w"
  else
    ok "Old wrapper not executable or absent: $w"
  fi
done

# 3. No forbidden endpoint references in active scripts
echo "── 3. Forbidden endpoint check"
if grep -r "/api/executor/night-plan\|/api/executor/candidates" scripts/ 2>/dev/null | grep -v "\.py~\|#" | grep -q .; then
  fail "Scripts reference forbidden endpoints (night-plan/candidates)"
else
  ok "No forbidden endpoint references"
fi

# 4. Queue endpoint contract
echo "── 4. Queue endpoint"
if [ -z "$SECRET" ]; then fail "No secret — cannot verify queue"; else
  Q=$(curl -s "${BASE}/api/executor/queue?includeUpcoming=1" -H "x-executor-secret: ${SECRET}" 2>/dev/null || echo '{"ok":false}')
  Q_OK=$(echo "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('ok',False))" 2>/dev/null || echo "false")
  Q_SRC=$(echo "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('source','null'))" 2>/dev/null || echo "null")
  Q_CNT=$(echo "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('candidate_count',0))" 2>/dev/null || echo "0")
  Q_NORANK=$(echo "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);c=d.get('ireland_contract',{});print(c.get('do_not_rank',''))" 2>/dev/null || echo "false")
  Q_NOBROAD=$(echo "$Q" | python3 -c "import sys,json;d=json.load(sys.stdin);c=d.get('ireland_contract',{});print(c.get('do_not_pull_broad_candidates',''))" 2>/dev/null || echo "false")

  if [ "$Q_OK" = "True" ] && [ "$Q_SRC" = "event_execution_queue" ]; then
    ok "Queue ok=true source=event_execution_queue candidates=${Q_CNT}"
  else
    fail "Queue ok=${Q_OK} source=${Q_SRC} (expected event_execution_queue)"
  fi

  if [ "$Q_NORANK" = "True" ] && [ "$Q_NOBROAD" = "True" ]; then
    ok "ireland_contract: do_not_rank=true do_not_pull_broad_candidates=true"
  else
    fail "ireland_contract broken: do_not_rank=${Q_NORANK} do_not_pull_broad_candidates=${Q_NOBROAD}"
  fi

  # Candidate validation
  if [ "$Q_CNT" != "0" ]; then
    echo "── 5. Candidate validation (${Q_CNT} candidates)"
    echo "$Q" | python3 - << 'PYEOF'
import sys, json, re
data = json.loads(sys.stdin.read()) if False else None
PYEOF
    # Use python for candidate validation
    echo "$Q" | python3 << 'PYEOF'
import sys, json, re
data = json.load(sys.stdin)
candidates = data.get("candidates", [])
HALT_RE = re.compile(r"halftime|half.time|first.half|1st.half", re.I)
errs = 0
for c in candidates:
    mfk = c.get("match_family_key", "?")
    for field in ("condition_id", "token_id", "side", "order_key"):
        if not c.get(field):
            print(f"  FAIL  Candidate {mfk} missing {field}"); errs += 1
    stake = c.get("stake_usd", 0)
    if stake > 7:
        print(f"  FAIL  Candidate {mfk} stake={stake} > 7"); errs += 1
    for f in ("market_slug", "market_family", "match_family_key"):
        if HALT_RE.search(c.get(f) or ""):
            print(f"  FAIL  Candidate {mfk} halftime field {f}={c.get(f)}"); errs += 1
    if errs == 0:
        print(f"  PASS  Candidate OK: {mfk} stake={stake} side={c.get('side')}")
if errs > 0:
    sys.exit(1)
PYEOF
  fi
fi

# Summary
echo ""
echo "═══════════════════════════"
TOTAL=$((PASS+FAIL))
if [ "$FAIL" -eq 0 ]; then
  echo "ALL_PASS_IRELAND_BATTLE_QUEUE_ONLY_VERIFY"
  exit 0
else
  echo "FAIL  ${PASS}/${TOTAL} passed, ${FAIL} failed"
  exit 1
fi
