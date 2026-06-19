#!/usr/bin/env bash
set -euo pipefail

ROOT="${PPP_EXECUTOR_ROOT:-/home/ubuntu/polymarket-executor}"
cd "$ROOT"

mkdir -p logs
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
for f in /tmp/ppp_nightplan_updater.log /tmp/live_start.log; do
  if [ -f "$f" ]; then
    cp "$f" "logs/$(basename "$f").$stamp.bak" || true
  fi
done

echo "Stopping existing updater/live-loop wrappers if present..."
pkill -f "pull_night_plan_candidates.py" 2>/dev/null || true
pkill -f "run_tonight_live_loop.sh" 2>/dev/null || true
pkill -f "night_live_loop|python.*live" 2>/dev/null || true
sleep 2

echo "Starting updater..."
if [ -f scripts/pull_night_plan_candidates.py ]; then
  nohup python3 scripts/pull_night_plan_candidates.py >> /tmp/ppp_nightplan_updater.log 2>&1 &
else
  echo "WARN missing scripts/pull_night_plan_candidates.py"
fi

echo "Starting live loop via existing script..."
if [ -x scripts/run_tonight_live_loop.sh ]; then
  nohup bash scripts/run_tonight_live_loop.sh >> /tmp/live_start.log 2>&1 &
else
  echo "WARN missing executable scripts/run_tonight_live_loop.sh"
fi

echo "Ensuring endpoint monitor..."
if ! pgrep -af "monitor_night_plan_endpoint.py" >/dev/null && [ -f scripts/monitor_night_plan_endpoint.py ]; then
  nohup python3 scripts/monitor_night_plan_endpoint.py >> /tmp/ppp_endpoint_monitor.log 2>&1 &
fi

sleep 5
if [ -x scripts/status_tonight_live_loop.sh ]; then
  bash scripts/status_tonight_live_loop.sh || true
fi
if [ -x scripts/ppp_battle_status.sh ]; then
  bash scripts/ppp_battle_status.sh
fi
