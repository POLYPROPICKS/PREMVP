# PolyProPicks Ireland Live Executor — Контур 1 Battle Mode

## Purpose

This runbook preserves the accepted production operating contour for the PolyProPicks Ireland live executor. It is an operational reference only. Do not commit secrets, do not reset the live ledger during a live night, and do not place manual orders outside the loop.

## Core Contour

```text
PREMVP /api/executor/night-plan
-> Ireland Lightsail updater
-> /home/ubuntu/polymarket-executor/data/candidates.json
-> /home/ubuntu/polymarket-executor/live/night_live_loop.py
-> /home/ubuntu/polymarket-executor/live/live_test_order.mjs
-> Polymarket CLOB
-> /home/ubuntu/polymarket-executor/reports/night_live_ledger.jsonl
```

## Verified Production / Live Proof

- PREMVP commit `ce1753b` (`Ops: expose executable night plan candidate fields`) was pushed and deployed successfully.
- It exposes `token_id`, `selected_token_id`, and `condition_id` in `/api/executor/night-plan` candidate previews and diagnostics.
- Ireland live executor placed England vs Croatia O/U 2.5 Over.
- Polymarket response was matched/success.
- Ledger recorded it.
- `LIVE_ORDER_SENT=YES`
- `LIVE_RECORDED_TO_LEDGER`

## Ireland Server

- Workdir: `/home/ubuntu/polymarket-executor`
- Source config: `config/executor-source.env`
- CLOB creds: `config/clob_creds.env`
- Private key config: `config/private-key.env`
- Do not print or commit secrets.

## Runtime Files

- `live/night_live_loop.py`
- `live/live_test_order.mjs`
- `scripts/pull_night_plan_candidates.py`
- `scripts/run_tonight_live_loop.sh`
- `scripts/status_tonight_live_loop.sh`
- `data/candidates.json`
- `reports/night_live_ledger.jsonl`
- `reports/night_plan_pull.log`
- `/tmp/ppp_nightplan_updater.log`
- `/tmp/live_start.log`

## Correct Runtime Env

```bash
LIVE_ENABLED=YES
ALLOW_ALL_SPORTS=NO
MAX_LIVE_ORDERS=25
MAX_NIGHT_NOTIONAL=95
RUN_SECONDS=46800
```

Use `MAX_NIGHT_NOTIONAL=95` for the current approximately `$95` bankroll.

## Critical Traps

- `LIVE_ENABLED=true` is wrong; it must be `YES`.
- `MAX_ORDERS` is wrong; use `MAX_LIVE_ORDERS`.
- `/api/executor/candidates` is not the night portfolio source.
- Correct endpoint:

```text
/api/executor/night-plan?bankroll=95&cash=95&windowMinutes=720&limit=50
```

- Codex cannot SSH into Ireland. Only the Lightsail terminal controls that server.
- `NO_CANDIDATES` is not automatically a bug. It is normal when no event is currently inside the execution window.
- Do not reset `reports/night_live_ledger.jsonl` during a live night.
- Do not use `ALLOW_ALL_SPORTS=YES` in normal WC/soccer mode.
- Do not place manual orders outside the loop.

## Candidate Adapter

`scripts/pull_night_plan_candidates.py` pulls `diagnostics.selected_event_candidates` from `/api/executor/night-plan` and writes `data/candidates.json`.

It must preserve:

- `token_id`
- `selected_token_id`
- `condition_id`
- `side`
- `selected_outcome`
- `max_entry_price`
- `stake_usd`
- `sport`
- `inferred_sport`
- `strategic_scope`
- `live_eligible`
- `event_slug`
- `match_family_key`

`inferred_sport` is required because `night_live_loop.py` expects it.

Healthy adapter log:

```text
raw=5 written=5 drop_token=0 drop_side=0 drop_ineligible=0
```

## Start

Run on Ireland Lightsail:

```bash
cd /home/ubuntu/polymarket-executor
bash scripts/run_tonight_live_loop.sh
```

## Status

Run on Ireland Lightsail:

```bash
cd /home/ubuntu/polymarket-executor
bash scripts/status_tonight_live_loop.sh
```

## Healthy Idle Status

- Updater alive.
- Loop alive.
- `raw >= 1`
- `written >= 1`
- `drop_token=0`
- `drop_side=0`
- `LIVE_ENABLED=YES`
- `all_sports=False`
- `max_orders=25`
- `max_notional=current bankroll/cash`
- Ledger preserved.
- `NO_CANDIDATES` may be normal outside event window.

## Morning Acceptance

Run on Ireland Lightsail:

```bash
cd /home/ubuntu/polymarket-executor
bash scripts/status_tonight_live_loop.sh
```

Check:

- Updater did not die.
- Loop did not die.
- `drop_token=0`
- Ledger has no duplicates.
- Polymarket history/portfolio matches ledger.
- If no event was in window, `NO_CANDIDATES` is acceptable.

## Final Accepted Screenshot State

The current final accepted screenshot showed:

- Updater alive.
- Loop alive.
- `raw=5 written=5 drop_token=0 drop_side=0 drop_ineligible=0`
- `live=True all_sports=False max_orders=25 max_notional=95.0`
- Ledger contains England Over with `live_sent=true`.

## Operator Guardrails

- Use PREMVP `/api/executor/night-plan` as the source of executable candidates.
- Keep Ireland execution constrained to football/WC mode unless explicitly approved otherwise.
- Keep live sizing aligned with current bankroll/cash.
- Do not treat missing candidates outside an event window as a production failure.
- Do not expose or copy secrets from `config/*.env`.
