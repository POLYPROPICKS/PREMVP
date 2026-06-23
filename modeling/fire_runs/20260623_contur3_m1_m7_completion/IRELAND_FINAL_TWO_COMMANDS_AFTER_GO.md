# Ireland — Final Two Commands After GO Signal

Only run after `PHASE4_BATTLE_DUE_WINDOW_NO_JQ_WINDOWS.cmd` returns `RESULT_GO_READY_FOR_CEO_UNLOCK`.

---

## Pre-Unlock Verification (Command 1)

On Ireland terminal:

```bash
# Verify source and candidate count before unlocking
curl -s -H "x-executor-secret: $PPP_SECRET" \
  https://polypropicks.com/api/executor/queue?includeUpcoming=1 | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('source') == 'event_execution_queue', 'BAD SOURCE: ' + str(d.get('source'))
assert d.get('ireland_contract', {}).get('do_not_rank') == True, 'CONTRACT MISSING'
assert d.get('ireland_contract', {}).get('do_not_pull_broad_candidates') == True, 'CONTRACT MISSING'
count = d.get('candidate_count', 0)
assert count > 0, 'NO CANDIDATES — do not unlock yet'
stake = d.get('max_stake_usd', 0)
assert stake == 7, 'WRONG STAKE: ' + str(stake)
print('VERIFY OK  source=event_execution_queue  candidates=' + str(count) + '  stake=' + str(stake))
for c in d.get('candidates', []):
    print('  ' + c['match_family_key'] + '  side=' + c['side'] + '  tier=' + c['tier'] + '  entry_state=' + c['entry_state'])
"
```

**Expected output:** `VERIFY OK  source=event_execution_queue  candidates=N  stake=7`

STOP if any assertion fails.

---

## CEO Unlock (Command 2)

Only after Command 1 passes:

```bash
# Remove hard-stop and start watcher
python3 contur3_battle_queue_only_watcher.py --remove-hard-stop=CEO_APPROVED
```

---

## Watcher Log Tail (separate terminal)

```bash
tail -f /tmp/contur3_battle_watcher.log
```

Expected log entries after unlock:
- `[CLAIMED] candidate_id=... order_key=...`
- `[SENT] polymarket_order_id=...`
- `[MARKED] status=EXECUTED queue_id=...`

---

## Rollback Command

If something goes wrong after unlock:

```bash
# Re-engage hard-stop immediately
touch /tmp/PPP_LIVE_HARD_STOP

# Kill watcher
pkill -f "[c]ontur3_battle_queue_only_watcher.py" || true

# Verify hard-stop active
ls -la /tmp/PPP_LIVE_HARD_STOP
echo "Hard-stop re-engaged"
```

---

## What Ireland Must NOT Do

- Pull candidates from any source other than `/api/executor/queue`
- Apply ranking, tier logic, or stake changes
- Enable Tier2/Tier3
- Send halftime/first-half orders (blocked upstream — should never appear in queue)
- Interpret `next_due_iso` as an order trigger (advisory only)
- Mark status other than CLAIMED/EXECUTED/SKIPPED/FAILED/EXPIRED
