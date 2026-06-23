# P0 — Only Two Commands Left Before Live

Generated: 2026-06-23. Battle state: WAIT_NEXT_DUE (candidate_count=0, next due ~16:00 UTC).

---

## Current State

- HEAD: `4a8e751 Ops: finalize Contur3 battle launch package`
- PREMVP Railway: deployed, ALL_PASS_CONTUR3_BATTLE_PREMVP
- Ireland: installed, ALL_PASS_IRELAND_BATTLE_QUEUE_ONLY_VERIFY
- Hard-stop: **ON** (Ireland will not send live orders)
- Queue source: `event_execution_queue` (LOCKED)
- candidate_count: 0 (expected — rebalance window opens T-60 before game start)
- next_due_iso: 2026-06-23T16:00:00.000Z (approximately)

---

## Command A — Windows Due-Window Check

Run from Windows CMD when the due window approaches (roughly 15 min before next_due_iso):

```
PHASE4_BATTLE_DUE_WINDOW_NO_JQ_WINDOWS.cmd
```

Located at: `modeling/fire_runs/20260623_contur3_m1_m7_completion/PHASE4_BATTLE_DUE_WINDOW_NO_JQ_WINDOWS.cmd`

**Expected sentinels:**
- `RESULT_GO_READY_FOR_CEO_UNLOCK` → proceed to Command B
- `RESULT_WAIT_NEXT_DUE` → wait, re-run in 10–15 min
- `RESULT_STOP_REBALANCE_SKIPPED` → STOP, inspect event-rebalance response before proceeding
- `RESULT_FAIL_CONTRACT` → STOP, something is broken — do not unlock

---

## Command B — Ireland CEO Unlock

Only run after Command A returns `RESULT_GO_READY_FOR_CEO_UNLOCK`.

On Ireland terminal/SSH:

```bash
# Verify hard-stop and queue source first
curl -s -H "x-executor-secret: $PPP_SECRET" \
  https://polypropicks.com/api/executor/queue?includeUpcoming=1 | python3 -c "
import json,sys; d=json.load(sys.stdin)
assert d['source']=='event_execution_queue','BAD SOURCE'
assert d['candidate_count']>0,'NO CANDIDATES'
print('SOURCE OK  candidates='+str(d['candidate_count']))
"

# CEO unlock — remove hard-stop flag and start watcher
python3 contur3_battle_queue_only_watcher.py --remove-hard-stop=CEO_APPROVED

# Tail watcher log (separate terminal)
tail -f /tmp/contur3_battle_watcher.log
```

---

## STOP Cases — Do NOT Unlock If

| Condition | Action |
|---|---|
| `RESULT_WAIT_NEXT_DUE` | Wait, re-run Command A in 10–15 min |
| `RESULT_STOP_REBALANCE_SKIPPED` | STOP — rebalance skipped events, inspect before unlocking |
| `candidate_count=0` | Do NOT unlock — queue must have ≥1 candidate |
| `source != event_execution_queue` | STOP — split-brain risk, do not unlock |
| hard-stop missing from Ireland environment | STOP — verify Ireland state first |
| Queue reports `RESULT_FAIL_CONTRACT` | STOP — do not unlock |

---

## Absolute Rule

**No live order before GO.** Ireland hard-stop remains ON until founder explicitly runs Command B with `--remove-hard-stop=CEO_APPROVED` after Command A returns `RESULT_GO_READY_FOR_CEO_UNLOCK`.
