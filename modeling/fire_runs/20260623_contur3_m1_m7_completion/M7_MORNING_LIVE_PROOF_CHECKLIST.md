# M7 — Morning Live Proof Checklist

Generated: 2026-06-23.

Use after Ireland has unlocked and events are complete. Verifies execution proof chain.

---

## Pre-Execution Checks (before Ireland unlock)

- [ ] Queue source = `event_execution_queue`
- [ ] max_stake_usd = 7
- [ ] ireland_contract.do_not_rank = true
- [ ] ireland_contract.do_not_pull_broad_candidates = true
- [ ] ireland_contract.do_not_apply_tier2_tier3 = true
- [ ] candidate_count ≥ 1
- [ ] All candidates have condition_id, token_id, side set
- [ ] All candidates are TIER1
- [ ] No halftime candidates

---

## Post-Unlock Execution Proof

For each executed order:
- [ ] queue_id logged
- [ ] order_key logged (format: `condition_id:token_id:side`)
- [ ] polymarket_order_id returned in mark_history
- [ ] live_order_confirmed = true in mark_history
- [ ] status = EXECUTED in event_execution_queue
- [ ] sent_at_iso is before latest_entry_iso (not expired)
- [ ] stake_usd = 7

---

## Morning Result Checklist

Run after all events complete:
- [ ] executed_count = expected (matches candidate_count at unlock)
- [ ] skipped_count explained (due to timing, market close, etc.)
- [ ] failed_count = 0 (or explained)
- [ ] expired_count = 0 (or explained — entry after latest_entry_iso)
- [ ] All EXECUTED rows have polymarket_order_id in mark_history
- [ ] Signal corpus has resolved_outcome for executed condition_ids
- [ ] realized_pnl_usd calculated for resolved rows

---

## Red Alert Verification

- [ ] No queue rows stuck in READY after game_start_iso passed
- [ ] No CLAIMED rows without subsequent EXECUTED or FAILED
- [ ] Ireland ledger count matches PREMVP executed count
- [ ] No source drift: all queue rows from event_execution_queue

---

## Morning SQL

```sql
-- Quick morning result
SELECT
  status,
  count(*) AS n,
  sum(stake_usd) AS total_staked
FROM event_execution_queue
GROUP BY status
ORDER BY n DESC;

-- Execution proof with polymarket IDs
SELECT
  match_family_key,
  order_key,
  stake_usd,
  status,
  diagnostics->'mark_history'->-1->>'polymarket_order_id' AS pm_order_id,
  diagnostics->'mark_history'->-1->>'live_order_confirmed' AS confirmed,
  diagnostics->'mark_history'->-1->>'marked_at_iso' AS executed_at
FROM event_execution_queue
WHERE status = 'EXECUTED'
ORDER BY queued_at;
```

---

## FireModel Linkage Proof

- [ ] Each EXECUTED queue_id linked to signal_id via condition_id + token_id
- [ ] signal.metric_formula_version recorded
- [ ] signal.selected_outcome matches queue.side
- [ ] resolved_outcome populated in generated_signal_pairs (post-resolution)
