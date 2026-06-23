# M7 — Founder Reports Specification

Generated: 2026-06-23. Spec only — no fake data, no inferred conclusions.

---

## Purpose

Founders must not infer from terminal logs. Reports must show night plan, queue proof, live execution, and morning result in a single coherent package.

---

## Report 1 — Night Portfolio Plan (sent at 17:00 Minsk)

**Source:** `night_event_reservations` (frozen plan)
**Trigger:** `GET /api/cron/night-plan-email?mode=plan`

**Required sections:**
- plan_run_id
- plan_date_minsk
- total reserved events
- active_future_count (events still in future)
- expired_count
- breakdown by sport / tier
- list of events: event_title, game_start_iso (Minsk + UTC), sport, tier
- expected rebalance windows (T-60 before each game)
- ⚠️ RED ALERT: zero events reserved → send alert email immediately

**Template:**
```
Night Plan — {plan_date_minsk}
plan_run_id: {plan_run_id}
Reserved events: {total}  Active: {active_future}  Expired: {expired}

Sport breakdown:
  WC/Soccer: {n}
  MLB: {n}
  Other: {n}

Events:
  {event_title}  {game_start_minsk} Minsk / {game_start_utc} UTC  [{sport}] T1
  ...

Rebalance windows (T-60):
  {rebalance_iso} for {event_title}
  ...

[ALERT: NO EVENTS RESERVED]  ← only if active=0
```

---

## Report 2 — Pre-Live Queue Proof (sent after rebalance fires)

**Source:** `GET /api/executor/queue?includeUpcoming=1`
**Trigger:** Manual or cron when candidate_count > 0

**Required sections:**
- source = event_execution_queue (verified)
- candidate_count
- max_stake_usd = 7 (verified)
- ireland_contract verified (do_not_rank=true, do_not_pull_broad=true)
- list of candidates: match_family_key, side, tier, entry_state, preferred_entry_iso
- next_due_iso if no candidates yet

**⚠️ RED ALERTS:**
- source ≠ event_execution_queue → CRITICAL: do not unlock
- max_stake_usd ≠ 7 → CRITICAL: do not unlock
- ireland_contract broken → CRITICAL: do not unlock

---

## Report 3 — Live Execution Proof (sent after each EXECUTED mark)

**Source:** `event_execution_queue.diagnostics.mark_history` where status=EXECUTED
**Trigger:** Ireland calls `/api/executor/queue/mark` with status=EXECUTED

**Required sections per executed order:**
- queue_id
- order_key
- polymarket_order_id
- tx_hash (if available)
- condition_id, token_id, side
- stake_usd
- match_family_key, event_title
- sent_at_iso, executed_at_iso
- live_order_confirmed = true

**⚠️ RED ALERTS:**
- live_order_confirmed ≠ true in EXECUTED mark → flag for investigation
- no EXECUTED marks after Ireland unlock → check watcher log

---

## Report 4 — Morning Result

**Source:** Join of `event_execution_queue` + `generated_signal_pairs` (resolved)
**Trigger:** Morning cron or manual run after events complete

**Required sections:**
- executed_count
- skipped_count
- failed_count
- expired_count
- pending_unresolved_count
- realized_pnl_usd (where resolved_outcome available)
- win_rate (resolved rows only)
- FireModel linkage status (signal_id linked / not linked)

**⚠️ RED ALERTS:**
- queue empty, no EXECUTED rows → flag: did Ireland actually unlock?
- expired_only: all queue rows expired before execution
- no mark callbacks: queue rows stuck in READY after due window passed
- mismatch: queue count ≠ Ireland ledger count

---

## Report 5 — Red Alert Section (always included)

| Alert | Condition | Severity |
|---|---|---|
| Queue empty at due window | candidate_count=0 after next_due_iso passes | CRITICAL |
| Expired-only plan | all reservations expired before rebalance | HIGH |
| No mark callbacks | CLAIMED/EXECUTED/FAILED marks absent after due window | HIGH |
| No executor rows | Ireland ran but no mark records exist | CRITICAL |
| Source mismatch | queue source ≠ event_execution_queue | CRITICAL |
| Stake violation | max_stake_usd ≠ 7 | CRITICAL |
| Ireland contract broken | do_not_rank or do_not_pull_broad = false | CRITICAL |
