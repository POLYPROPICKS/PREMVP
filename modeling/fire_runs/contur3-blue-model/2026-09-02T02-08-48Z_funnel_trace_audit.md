# Contur3 Funnel Trace Audit

**Generated:** 2026-09-02T02:08:48.453Z
**Lookback:** 36h (since 2026-08-31T14:08:48.453Z)
**Lookahead:** 24h (until 2026-09-03T02:08:48.453Z)
**Due window:** T-70m → T-3m per event



---

## Current Verdict

**Root cause stage:** `QUEUE_CLAIMED_NO_ORDER`

**Why:** Queue has 0 SENT + 15 CLAIMED rows but 0 executor_order_events. Ireland consumed queue but no order recorded.

**Next operator action:** Check Ireland executor logs immediately. Order may have been sent but not logged.



---

## Summary Table

| Metric | Count |
|--------|-------|
| signals_count | 500 |
| allowed_candidates_next24h | 475 |
| future_reservations_count | 0 |
| future_valid_reservations_count | 0 |
| due_now_count | 0 |
| missed_window_count | 0 |
| queue_ready_count | 0 |
| queue_claimed_count | 15 |
| queue_sent_count | 0 |
| orders_real_count | 0 |
| orders_live_confirmed_count | 0 |

---

## Exact Broken Stage

Stage `QUEUE_CLAIMED_NO_ORDER` is the first stage where the funnel is blocked.



---

## Future Reservations (next 24h)

| Event | Start | DB Status | Market Class | Due Window State | Due Window Opens |
|-------|-------|-----------|-------------|-----------------|-----------------|
| (none) | | | | | |

---

## Queue Rows (last 36h)

| Event | Market Slug | Status | Market Class | Stake USD | Battle Trace Key |
|-------|-------------|--------|-------------|-----------|-----------------|
| ? | $51K matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:915659:2026-09-01:0x9e8345ef61995457041dded86ec4b24ead5ddd1b6563f543efe30cf373b1866a:114255470365874246962547608298701897700582241689906010275469345628218676018497 |
| ? | $3K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:876763:2026-09-01:0xeeb1591da6b769a57c8c97faab5c6802637524ef06c0ed925746600b30ed8995:57455571143673014400075179213842470429917463348509450546152633383738123789404 |
| ? | $60 matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874937:2026-09-01:0xebf7b515b3970ca93f03c3fd1d514c87f28be5f2505d3c3d1ecb3de3151e7727:59929268991782479267497335461709589522509679255934709582142149535203493113751 |
| ? | $2 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874797:2026-09-01:0x7582d38d55528409de77d2b4eded0b8fa0e39016359c564d398b73f799d00713:51056721380696760786438739951668163070398494592954293011057713160565336936130 |
| ? | $10 matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874720:2026-09-01:0xa52ef2a052370fe078127dd36bad109dc90ca77317a5ab0e4437d58f3ed35f06:6032949337083458327463862672045209572349985727135442776302093003332304591434 |
| ? | $96 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:873859:2026-09-01:0xfbf0fc4c684ec237e5b172e2d3da85197eb77c977633e08cfeee284e420eeec5:93127514407443594016309084464214059580527253668238033722120826703684412556302 |
| ? | $62 matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874946:2026-09-01:0xbb1e2a241a99040390dd2b8bf64d7695a15af8e32f43f2f1fe0909f79c2ad515:95673651574931536453833400474717058514842314641100946163672806985432839873556 |
| ? | $1K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:875148:2026-09-01:0x0ec5979a77b64af003f6548c41fff297f01e5650a0f3ce67d398d645c5a211d4:52936989079189978707878685871055070369726140835911996601066054520310220160791 |
| ? | $1 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874718:2026-09-01:0x1db7b9405f9aacd29aee88633bcdbd116ab92ff7837fde5c6f9c2f86fcb07677:102199647546872227998708948513949155230649750773837092095802399167526981943621 |
| ? | $19K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:875144:2026-09-01:0x7caa00bbaf9b92f728ed0ca0ab15d1ec7a890cc816ecfe8d6f92bcf9d0a4ff03:9346597671474698982418342183296625021193526320967326260630084683240146994671 |

---

## Trace Key Examples

*Computed deterministic keys — NOT persisted to DB. See `TRACE_ID_SCHEMA_MIGRATION_REQUIRED`.*

- `contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:915659:2026-09-01:0x9e8345ef61995457041dded86ec4b24ead5ddd1b6563f543efe30cf373b1866a:114255470365874246962547608298701897700582241689906010275469345628218676018497` — ? [queue]
- `contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:876763:2026-09-01:0xeeb1591da6b769a57c8c97faab5c6802637524ef06c0ed925746600b30ed8995:57455571143673014400075179213842470429917463348509450546152633383738123789404` — ? [queue]
- `contur3:night-plan:2026-09-01:1700-minsk:provider:polymarket:874937:2026-09-01:0xebf7b515b3970ca93f03c3fd1d514c87f28be5f2505d3c3d1ecb3de3151e7727:59929268991782479267497335461709589522509679255934709582142149535203493113751` — ? [queue]

**Format:** `contur3:<plan_run_id>:<match_family_key>:<condition_id_or_unknown>:<token_id_or_unknown>`

---

## What Not to Patch Yet

| Do not patch | Until |
|-------------|-------|
| Ireland executor | READY queue row exists without order |
| Email/ops pipeline | Betting chain (RESERVED → ORDER_CONFIRMED) is proven |
| Rebalance cron | DUE_NOW / MISSED_WINDOW with no queue is proven |
| Reservation planner | Valid candidates exist but no future valid reservations |
| Stake policy | Never — locked at $7 TIER1 |

---

## Next Operator Action

**Check Ireland executor logs immediately. Order may have been sent but not logged.**



---

*Canonical forensic: `npm run contur3:funnel-trace-audit`*
