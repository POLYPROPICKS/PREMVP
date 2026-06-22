# Contur2 V4 Audit - 2026-06-22

## Railway producer contract state

- Pushed commit: `10a2013 Executor: add night plan contract v1 envelope`
- Contract shape at production head:
  - `api_schema_version = executor-night-plan-v1`
  - `execution_mode = ONE_ORDER_PILOT_REVIEW`
  - `max_live_orders = 1`
  - `max_candidate_count = 1`
  - `max_stake_usd = 5`
  - `per_token_side_cap_usd = 10`
  - `valid_until_iso` present
  - `candidates[]` present
  - `planned_slots` preserved
  - `diagnostics` preserved
  - `rejected_candidates_summary` present

## Ireland runtime audit results

- `RAILWAY_CONTRACT_RUNTIME_VERIFY: PASS`
- Sanitized runtime summary:
  - `HTTP status = 200`
  - `ok = true`
  - `api_schema_version = executor-night-plan-v1`
  - `execution_mode = ONE_ORDER_PILOT_REVIEW`
  - `strategy_run_id exists = true`
  - `generated_at_iso exists = true`
  - `valid_until_iso exists = true`
  - `valid_until_not_expired = true`
  - `max_live_orders = 1`
  - `max_candidate_count = 1`
  - `max_stake_usd = 5`
  - `per_token_side_cap_usd = 10`
  - `candidates_length = 1`
  - `first candidate has order_key = true`
  - `first candidate is_executable = true`
  - `first candidate has condition_id/token_id/side = true`
  - `planned_slots exists = true`
  - `diagnostics exists = true`
  - `rejected_candidates_summary exists = true`

## Ireland consumer rejector patch summary

- Server-side consumer update applied in Ireland:
  - `scripts/pull_night_plan_candidates.py` now consumes top-level v1 `candidates`
  - `live/contur2_contract_guard.py` added
  - `live/night_live_loop.py` guards candidate JSON loading
- Full contour audit after patch:
  - `IRELAND_CONSUMER_REJECTOR_PRESENT: YES`
  - `schema_guard: YES`
  - `expiry_guard: YES`
  - `mode_guard: YES`
  - `cap_guard: YES`
  - `order_key_guard: YES`
  - `stake_guard: YES`

## Hard-stop and no-live proof

- `LIVE_HARD_STOP_PRESENT: YES`
- `NO_LIVE_PROCESS: YES` confirmed by direct `ps` check
- A prior `V4_NO_LIVE_PROCESS: FAIL` result was attributed to a false `pgrep` / audit-script issue and corrected by direct process verification
- Live/pilot remains blocked

## Preservation archive

- ` /home/ubuntu/polymarket-executor/reports/contur2_preservation_20260622T094748Z`
- ` /home/ubuntu/polymarket-executor/reports/contur2_preservation_20260622T094748Z.tar.gz`

## Final verdict

- `READY_FOR_CEO_REVIEW_ONLY`
- Not approved for live execution
- One-order pilot remains gated behind CEO approval

## Explicit forbidden actions

- Do not remove the hard-stop
- Do not start live execution
- Do not run order tests
- Do not bypass the one-order pilot gate

