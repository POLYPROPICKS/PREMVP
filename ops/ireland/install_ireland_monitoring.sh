#!/usr/bin/env bash
set -euo pipefail

ROOT="${PPP_EXECUTOR_ROOT:-/home/ubuntu/polymarket-executor}"
BRANCH="${PPP_PREMVP_BRANCH:-main}"
RAW_BASE="${PPP_PREMVP_RAW_BASE:-https://raw.githubusercontent.com/POLYPROPICKS/PREMVP/$BRANCH/ops/ireland}"

cd "$ROOT"
mkdir -p logs scripts

install_script() {
  local name="$1"
  if [ -f "$name" ]; then
    cp "$name" "scripts/$name"
  elif [ -f "ops/ireland/$name" ]; then
    cp "ops/ireland/$name" "scripts/$name"
  else
    curl -fsSL "$RAW_BASE/$name" -o "scripts/$name"
  fi
  chmod +x "scripts/$name"
}

install_script ppp_battle_status.sh
install_script restart_live_contour.sh

cat > scripts/monitor_night_plan_endpoint.py <<'PY'
#!/usr/bin/env python3
import json
import os
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.environ.get("PPP_EXECUTOR_ROOT", "/home/ubuntu/polymarket-executor")
ENV = os.path.join(ROOT, "config", "executor-source.env")
LOG = os.path.join(ROOT, "logs", "night_plan_endpoint_monitor.jsonl")
DEFAULT_URL = "https://polypropicks.com/api/executor/night-plan?bankroll=95&cash=95&windowMinutes=720&limit=50"

def load_env(path):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line=line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k,v=line.split("=",1)
            os.environ.setdefault(k, v.strip().strip('"').strip("'"))

def summarize(payload):
    diag=payload.get("diagnostics") or {}
    rows=diag.get("selected_event_candidates") or payload.get("planned_slots") or payload.get("candidates") or []
    reasons={}
    traces=[]
    for r in rows:
        reason=r.get("live_rejection_reason") or "NONE"
        reasons[reason]=reasons.get(reason,0)+1
        cid=r.get("condition_id")
        tid=r.get("token_id") or r.get("selected_token_id")
        ev=r.get("event_slug") or r.get("match_family_key") or r.get("event")
        if cid or tid or ev:
            traces.append(f"{cid or ''}::{tid or ''}::{ev or ''}")
    def wc(r):
        return any(x in str(r).lower() for x in ["world cup","fifwc","soccer","wc"])
    return {
        "auditWriteFailed": diag.get("auditWriteFailed"),
        "auditRunId": diag.get("auditRunId"),
        "selected_event_candidates": len(rows),
        "live_eligible": sum(1 for r in rows if r.get("live_eligible")),
        "wc_soccer": sum(1 for r in rows if wc(r)),
        "reject_reasons": reasons,
        "trace_ids_first_10": traces[:10],
    }

load_env(ENV)
url=os.environ.get("EXECUTOR_CANDIDATES_URL") or DEFAULT_URL
secret=os.environ.get("EXECUTOR_CANDIDATES_SECRET")
interval=int(os.environ.get("PPP_ENDPOINT_MONITOR_INTERVAL_SECONDS", "60"))
os.makedirs(os.path.dirname(LOG), exist_ok=True)

while True:
    row={"ts": datetime.now(timezone.utc).isoformat(), "url": url}
    try:
        req=urllib.request.Request(url)
        if secret:
            req.add_header("x-executor-secret", secret)
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw=resp.read().decode("utf-8")
            row["http_status"]=resp.status
            row.update(summarize(json.loads(raw)))
    except Exception as exc:
        row["error"]=str(exc)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    time.sleep(interval)
PY
chmod +x scripts/monitor_night_plan_endpoint.py

pkill -f "monitor_night_plan_endpoint.py" 2>/dev/null || true
nohup python3 scripts/monitor_night_plan_endpoint.py >> /tmp/ppp_endpoint_monitor.log 2>&1 &
sleep 2

if pgrep -af "monitor_night_plan_endpoint.py" >/dev/null; then
  echo "INSTALL_OK endpoint monitor running"
  echo "log=$ROOT/logs/night_plan_endpoint_monitor.jsonl"
else
  echo "INSTALL_FAILED endpoint monitor not running"
  exit 1
fi
