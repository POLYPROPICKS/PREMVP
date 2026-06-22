# Contur2 One-Order Pilot Runbook

## Scope

This runbook documents the minimum safe gate for a one-order pilot.
It does not authorize live execution.

## Prerequisites

- Railway producer contract is deployed and verified at the current production head.
- Ireland consumer rejector audit is present and current.
- Hard-stop file is present before approval.
- No live process is running before approval.
- Final contract audit is run immediately before any controlled order.
- The runbook owner has explicit CEO approval before any live action.

## Exact pilot boundaries

- `max_live_orders = 1`
- `max_candidate_count = 1`
- `max_stake_usd = 5`
- `per_token_side_cap_usd = 10`

## CEO approval checklist

- Confirm the production contract is the v1 envelope.
- Confirm `RAILWAY_CONTRACT_RUNTIME_VERIFY: PASS`.
- Confirm `IRELAND_CONSUMER_REJECTOR_PRESENT: YES`.
- Confirm `LIVE_HARD_STOP_PRESENT: YES`.
- Confirm `NO_LIVE_PROCESS: YES`.
- Confirm `ONE_ORDER_PILOT_READY: NO` until the CEO explicitly approves the pilot.
- Confirm the final audit is rerun immediately before any controlled order.

## Required pre-order verification

- Verify the hard-stop is still present.
- Verify no live process is running.
- Verify the runtime contract still matches:
  - `executor-night-plan-v1`
  - `ONE_ORDER_PILOT_REVIEW`
  - `max_live_orders = 1`
  - `max_candidate_count = 1`
  - `max_stake_usd = 5`
  - `per_token_side_cap_usd = 10`
- Verify `order_key` is present.
- Verify `valid_until_iso` is present and not expired.
- Verify `planned_slots`, `diagnostics`, and `rejected_candidates_summary` are present.

## Pilot execution rule

- Run the final audit immediately before any controlled order.
- If any check fails, stop and do not place an order.
- Log the result in the preservation record after the audit.
- Restore or re-check the hard-stop after the pilot path completes.

## Operating constraint

This runbook is for review and gatekeeping only.
It does not authorize live execution, live loop start, or order placement.

