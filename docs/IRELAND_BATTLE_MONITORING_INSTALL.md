# Ireland Battle Monitoring Install

Run these commands on the Ireland executor host:

```bash
cd /home/ubuntu/polymarket-executor && curl -fsSL https://raw.githubusercontent.com/POLYPROPICKS/PREMVP/main/ops/ireland/install_ireland_monitoring.sh -o /tmp/install_ireland_monitoring.sh && bash /tmp/install_ireland_monitoring.sh
```

```bash
cd /home/ubuntu/polymarket-executor && bash scripts/ppp_battle_status.sh
```

```bash
cd /home/ubuntu/polymarket-executor && bash scripts/restart_live_contour.sh
```

## What This Installs

- `scripts/ppp_battle_status.sh`
- `scripts/restart_live_contour.sh`
- `scripts/monitor_night_plan_endpoint.py`
- `logs/night_plan_endpoint_monitor.jsonl`

## Contract

The scripts do not place manual orders. They only install monitoring, print
status, and restart the existing updater/live loop using the Ireland executor's
existing scripts.
