# M7 — Night Plan Email Checklist

Generated: 2026-06-23.

Use this checklist to verify the night plan email was sent correctly and contains required fields.

---

## Trigger

- Time: ~17:00 Minsk (14:00 UTC)
- Endpoint: `GET /api/cron/night-plan-email?mode=plan`
- Auth: `x-executor-secret` header

---

## Checklist

### Email Delivery
- [ ] Email received at founder address within 5 min of 17:00 Minsk
- [ ] Subject line contains plan_date_minsk (e.g. "Night Plan 2026-06-23")
- [ ] Email body is not empty / not truncated

### Plan Content
- [ ] plan_run_id present (format: `night-plan:YYYY-MM-DD:1700-minsk`)
- [ ] Reserved event count > 0
- [ ] active_future_count > 0 (events not yet expired)
- [ ] No "ZERO EVENTS" alert (if zero: immediately rebuild or alert)
- [ ] Events listed with: event_title, game_start Minsk + UTC, sport, tier
- [ ] Sport breakdown present (WC/Soccer / MLB / Other)
- [ ] Expected rebalance windows listed (T-60 time for each event)

### Sanity Checks
- [ ] No halftime events in plan
- [ ] All events are TIER1
- [ ] No events with game_start_iso in the past (relative to 17:00 Minsk)
- [ ] plan_date_minsk matches today's Minsk date

### Red Alerts (if any)
- [ ] If active_future_count = 0 → send alert email immediately
- [ ] If needs_rebuild = true → log for forceRebuild decision
- [ ] If bad_market_level_count > 0 → rebuild required

---

## Verification Command

```bash
curl -s -H "x-executor-secret: $PPP_SECRET" \
  "https://polypropicks.com/api/cron/night-event-reservations?mode=status" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
h = d.get('plan_health', {})
print('plan_run_id:', d.get('plan_run_id'))
print('active_future:', h.get('active_future_count'))
print('expired:', h.get('expired_count'))
print('bad_market_level:', h.get('bad_market_level_count'))
print('needs_rebuild:', h.get('needs_rebuild'))
print('CHECKLIST: OK' if h.get('active_future_count', 0) > 0 else 'CHECKLIST: RED — ZERO ACTIVE EVENTS')
"
```
