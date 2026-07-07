# Contur3 Postmortem — July 7, 2026 Argentina vs. Egypt missed window

**Note on sourcing:** this session had no live Supabase credentials, so the
match-specific figures below are recorded as **founder/operator-reported**,
not independently re-verified against `event_execution_queue` /
`executor_order_events` from this session. Cross-check with
`reports/contur3/runtime_extraction_2026-07-07.sql` or
`scripts/contur3/runtime-extraction-2026-07-07.mjs` (run where real Supabase
env vars exist) before treating these as final.

## Reported facts

| Field | Value |
|---|---|
| Selected market | Argentina vs. Egypt: Argentina O/U 1.5 |
| Side | Under |
| stake_usd | 7 |
| entry_price | 0.375 |
| max_entry_price | 0.415 |
| order_events rows | 0 |

## Failure reason

Ireland execution layer was not ready to consume the queued candidate: no
one-shot runner (`contur3_one_shot_queue_runner.py`) was in place yet, and
legacy hard-stop/arming gates on the Ireland side blocked execution. PREMVP
correctly queued a valid, in-window candidate (stake $7, price cap 0.415,
observed entry ~0.375 — within cap) but no order was ever attempted, so
`executor_order_events` has zero rows for this match. This is a **process/
readiness gap on the Ireland side**, not a PREMVP contract or stake/price
policy defect — the PR #57 fail-closed contract was never exercised here
because no submission was ever sent.

## Contributing factors

- No approved standing execution path existed on Ireland prior to the
  one-shot runner; the legacy `night_live_loop.py` path was correctly not
  used for live production execution.
- No alerting existed to flag "queue row is `IN_WINDOW` and `READY`, but no
  corresponding `executor_order_events` row appeared before
  `latest_entry_iso`" — this is the gap the checklist in the runbook
  (`CONTUR3_EXECUTION_RUNBOOK.md` §8) is meant to close going forward.

## Fee/fill accounting impact

Because zero order-events were recorded, there is no `fee_usd`,
`slippage_usd`, `cost_model_version`, or `fee_notes` data for this match —
nothing to reconcile in `scripts/morning-model-report.ts`. This is flagged as
a **P0 accounting gap for this specific match** (missing execution, not a
missing-field bug in the contract itself — see
`CONTUR3_EXECUTION_RUNBOOK.md` §7 for the fields the contract does persist
when an order-event is actually submitted).

## Follow-up

- Use the one-shot runner (`CONTUR3_EXECUTION_RUNBOOK.md` §4) for the next
  candidate match, dry-run first.
- After go-live, confirm within the entry window that
  `executor_order_events` has a row for the match's `idempotency_key` —
  don't wait for the morning report to discover a miss.
- Re-run `reports/contur3/runtime_extraction_2026-07-07.sql` (or the Node
  script) against the real DB to confirm the reported figures above and
  close out this postmortem with verified numbers.
