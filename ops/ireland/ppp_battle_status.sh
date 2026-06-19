#!/usr/bin/env bash
set -u

ROOT="${PPP_EXECUTOR_ROOT:-/home/ubuntu/polymarket-executor}"
cd "$ROOT" || {
  echo "ROOT_MISSING $ROOT"
  exit 1
}

echo "=== UTC ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"

echo "=== PROCESSES ==="
pgrep -af "pull_night_plan_candidates|monitor_night_plan_endpoint|run_tonight_live_loop|night_live_loop|python.*live" || true
echo "updater_process=$(pgrep -af 'pull_night_plan_candidates' | wc -l)"
echo "live_loop_process=$(pgrep -af 'run_tonight_live_loop|night_live_loop|python.*live' | wc -l)"
echo "endpoint_monitor_process=$(pgrep -af 'monitor_night_plan_endpoint.py' | wc -l)"

echo "=== CANDIDATES_JSON ==="
if [ -f data/candidates.json ]; then
  now="$(date +%s)"
  mtime="$(stat -c %Y data/candidates.json 2>/dev/null || echo 0)"
  echo "path=data/candidates.json"
  echo "mtime_utc=$(date -u -d "@$mtime" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo UNKNOWN)"
  echo "age_seconds=$((now - mtime))"
  python3 - <<'PY'
import json
from pathlib import Path
p=Path("data/candidates.json")
try:
    d=json.loads(p.read_text())
except Exception as exc:
    print("json_error=", exc)
    raise SystemExit(0)
rows=d if isinstance(d, list) else d.get("candidates") or d.get("planned_slots") or []
print("candidate_count=", len(rows))
for r in rows[:10]:
    text=str(r).lower()
    if any(x in text for x in ["world cup","fifwc","soccer","canada","qatar","mexico","korea","wc"]):
        print("wc_candidate=", {
            "event": r.get("event_slug") or r.get("event") or r.get("match_family_key"),
            "market": r.get("market_slug") or r.get("market"),
            "tier": r.get("tier"),
            "score": r.get("score") or r.get("signal_confidence_num"),
            "coverage": r.get("coverage") or r.get("data_coverage_num"),
            "live": r.get("live_eligible"),
            "reject": r.get("live_rejection_reason"),
            "stake": r.get("stake") or r.get("stake_usd") or r.get("recommended_stake"),
            "token": bool(r.get("token_id") or r.get("selected_token_id")),
            "condition": bool(r.get("condition_id")),
        })
PY
else
  echo "missing=data/candidates.json"
fi

echo "=== UPDATER LOG TAIL ==="
tail -20 /tmp/ppp_nightplan_updater.log 2>/dev/null || echo "missing=/tmp/ppp_nightplan_updater.log"

echo "=== LIVE LOOP LOG TAIL ==="
tail -20 /tmp/live_start.log 2>/dev/null || echo "missing=/tmp/live_start.log"

echo "=== LEDGER TAIL ==="
tail -5 reports/night_live_ledger.jsonl 2>/dev/null || echo "missing=reports/night_live_ledger.jsonl"

echo "=== ENDPOINT MONITOR TAIL ==="
tail -5 logs/night_plan_endpoint_monitor.jsonl 2>/dev/null || echo "missing=logs/night_plan_endpoint_monitor.jsonl"

echo "=== DIRECT ENDPOINT SUMMARY ==="
set -a
[ -f config/executor-source.env ] && . config/executor-source.env
set +a
URL="${EXECUTOR_CANDIDATES_URL:-https://polypropicks.com/api/executor/night-plan?bankroll=95&cash=95&windowMinutes=720&limit=50}"
if [ -z "${EXECUTOR_CANDIDATES_SECRET:-}" ]; then
  echo "endpoint_check=SKIPPED missing EXECUTOR_CANDIDATES_SECRET"
else
  tmp_json="$(mktemp)"
  if curl -fsS -H "x-executor-secret: $EXECUTOR_CANDIDATES_SECRET" "$URL" -o "$tmp_json"; then
    python3 - "$tmp_json" <<'PY'
import json, sys
path=sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
        d=json.load(f)
except Exception as exc:
    print("endpoint_json_error=", exc)
    raise SystemExit(0)
diag=d.get("diagnostics") or {}
rows=diag.get("selected_event_candidates") or d.get("planned_slots") or d.get("candidates") or []
def yes(r):
    return bool(r.get("live_eligible"))
def wc(r):
    text=str(r).lower()
    return any(x in text for x in ["world cup","fifwc","soccer","wc"])
print("auditWriteFailed=", diag.get("auditWriteFailed"))
print("auditRunId=", diag.get("auditRunId"))
print("selected_event_candidates=", len(rows))
print("live_eligible=", sum(1 for r in rows if yes(r)))
print("wc_soccer=", sum(1 for r in rows if wc(r)))
reasons={}
for r in rows:
    reason=r.get("live_rejection_reason") or "NONE"
    reasons[reason]=reasons.get(reason,0)+1
print("reject_reasons=", reasons)
PY
  else
    echo "endpoint_check=FAILED"
  fi
  rm -f "$tmp_json"
fi
