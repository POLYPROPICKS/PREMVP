# Contur3 Funnel Trace Audit

**Generated:** 2026-09-07T02:07:38.827Z
**Lookback:** 36h (since 2026-09-05T14:07:38.827Z)
**Lookahead:** 24h (until 2026-09-08T02:07:38.827Z)
**Due window:** T-70m → T-3m per event



---

## Current Verdict

**Root cause stage:** `QUEUE_CLAIMED_NO_ORDER`

**Why:** Queue has 0 SENT + 14 CLAIMED rows but 0 executor_order_events. Ireland consumed queue but no order recorded.

**Next operator action:** Check Ireland executor logs immediately. Order may have been sent but not logged.



---

## Summary Table

| Metric | Count |
|--------|-------|
| signals_count | 500 |
| allowed_candidates_next24h | 479 |
| future_reservations_count | 0 |
| future_valid_reservations_count | 0 |
| due_now_count | 0 |
| missed_window_count | 0 |
| queue_ready_count | 0 |
| queue_claimed_count | 14 |
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
| ? | $109 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:909596:2026-09-06:0xd11c6cd98d4ed995e22d86830880527a5fe0fe355c864348f40e23d4e83fa909:109166243334734723187413842106428506156443131617500067986129035327953246108877 |
| ? | $8K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:926680:2026-09-06:0x1dc605415c6fc6059061063382412ae57a959608bd117dd59d85c647f3669500:69526711387591010164501780399567573384012931505780477850037713491955436087473 |
| ? | $82 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:903969:2026-09-06:0xf71566e61c1ef46c58f431d386b774d3c575eb5e6d495c92616ee5d1436a2272:102139248746373415939461426382762815500991214384904863888040725921009273953582 |
| ? | $10K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:899834:2026-09-06:0x7abc9b6251a58c22463decd8164e1dbcfba81129ca5b0ca8f3b8c25195225e68:47705348347256890469120954154545562355561519780285502994468463362414904643978 |
| ? | $648 matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:948797:2026-09-06:0x3b99624c5ae4f19f8f9ebfcd534da96f946cab2771065d5ca560e61d1bb363dd:50980491803046807907560721641091527285391126267894859594373923068940358492424 |
| ? | $33 matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:956083:2026-09-06:0x803c03afc40ce920069eebdb521559ec479b0a3addc9803a80042c5b000bc72a:39472961047445147884592978296959922813753383531296477279299887414593615854366 |
| ? | $455 matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:936505:2026-09-06:0xe113823bf4acd341b30aad447ae97d49c8f60725fd06d45af718241d471c932e:70303325806379349000718391717834930282909724063432689565914163340055382923314 |
| ? | $2K matched activity | EXPIRED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:900013:2026-09-06:0xaaeb059234b3396c1f5e5d775324d59bff2e4a62957119047b724ae9ae7a5f9f:42826101300920515269963906484839837020815196043906088957849898398015834957665 |
| ? | $70K matched activity | CLAIMED | ALLOWED_CORE | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:941708:2026-09-06:0x1a4ef4ed1ad048c9a953cc4739ddd807a8d379716e753f5c79260a355151dac0:32737483954933244961538517586644310598455466720817457554929852535887407423956 |
| ? | $20K matched activity | CLAIMED | ALLOWED_FULLMATCH | 2.5 | contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:899838:2026-09-06:0x19f202f43b67bc3e0499a93eedb74e2abd3fe81f0b6121b8b6df6b5281c56a79:99036660104789790007444362793787835232278704269737501908879519283343507265330 |

---

## Trace Key Examples

*Computed deterministic keys — NOT persisted to DB. See `TRACE_ID_SCHEMA_MIGRATION_REQUIRED`.*

- `contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:909596:2026-09-06:0xd11c6cd98d4ed995e22d86830880527a5fe0fe355c864348f40e23d4e83fa909:109166243334734723187413842106428506156443131617500067986129035327953246108877` — ? [queue]
- `contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:926680:2026-09-06:0x1dc605415c6fc6059061063382412ae57a959608bd117dd59d85c647f3669500:69526711387591010164501780399567573384012931505780477850037713491955436087473` — ? [queue]
- `contur3:night-plan:2026-09-06:1700-minsk:provider:polymarket:903969:2026-09-06:0xf71566e61c1ef46c58f431d386b774d3c575eb5e6d495c92616ee5d1436a2272:102139248746373415939461426382762815500991214384904863888040725921009273953582` — ? [queue]

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
