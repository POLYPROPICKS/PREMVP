# Ireland Monitoring Patch

The Ireland executor scripts are not managed in this repo. Apply this patch on
the server at `/home/ubuntu/polymarket-executor`.

## Required Log Files

```bash
mkdir -p /home/ubuntu/polymarket-executor/logs
touch logs/night_plan_polls.jsonl logs/candidate_decisions.jsonl logs/live_loop_decisions.jsonl logs/order_attempts.jsonl
```

## Updater Requirements

Patch `scripts/pull_night_plan_candidates.py` to write one JSON line per poll:

```json
{
  "timestamp": "...",
  "stage": "PULLED_BY_IRELAND",
  "url": "...",
  "http_status": 200,
  "raw_count": 0,
  "written_count": 0,
  "drop_token": 0,
  "drop_side": 0,
  "drop_ineligible": 0,
  "trace_ids": [],
  "reject_reasons": {}
}
```

For every candidate, compute:

```python
trace_id = f"{condition_id}::{token_id or selected_token_id}::{event_slug or match_family_key}"
```

Write `candidate_decisions.jsonl` with:

- `PULLED_BY_IRELAND`
- `WRITTEN_TO_CANDIDATES_JSON`
- `DROPPED_BY_IRELAND`
- reason (`drop_token`, `drop_side`, `drop_ineligible`, etc.)

## Live Loop Requirements

Patch `live/night_live_loop.py` to append JSON lines:

- `SEEN_BY_LIVE_LOOP`
- `ORDER_ATTEMPTED`
- `ORDER_SENT`
- `ORDER_REJECTED`
- `LEDGER_WRITTEN`

Each line must include `trace_id`, condition/token, event, market, side, stake,
and the CLOB/order result where available.

## Verification Command

```bash
cd /home/ubuntu/polymarket-executor
tail -50 logs/night_plan_polls.jsonl
tail -50 logs/candidate_decisions.jsonl
tail -50 logs/live_loop_decisions.jsonl
tail -50 logs/order_attempts.jsonl
```
