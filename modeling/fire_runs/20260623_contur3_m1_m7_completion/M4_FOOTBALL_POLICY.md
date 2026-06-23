# M4 — Football / Soccer Policy

Generated: 2026-06-23. Codified from current runtime rules. No live code changed.

---

## Purpose

Stop rediscovering halftime/spread/total/corners/moneyline behavior on every session. This file is the single reference for football execution policy.

---

## Policy Table

| Market Family | Current Live Status | Reason | Data Required for Future Allow | Safe Tonight | Sample/Evidence |
|---|---|---|---|---|---|
| moneyline | **ALLOW_TIER1** | Clean binary, high liquidity, strong identity in WC/soccer events | Already live | YES — standard path | WC corpus evidence |
| spread (run_line) | **ALLOW_TIER1** (strong identity only) | Liquid on WC events. Blocked if weak identity single-team spread | team pair confirmed + token_id + condition_id | YES if identity STRONG | WC corpus |
| total / over-under | **ALLOW_TIER1** | Liquid, straightforward, no identity ambiguity | Already live | YES | WC corpus |
| corners | **SHADOW_ONLY** | Props-adjacent. Not in current signal corpus. No resolved rows. | ≥5 resolved rows + explicit founder approval | No | None |
| exact score | **SHADOW_ONLY** | Multi-outcome market. Complex side/token mapping. | ≥5 resolved rows + explicit founder approval | No | None |
| goalscorer | **KEEP_BLOCKED** | Player prop — activity_label blocked upstream | N/A | No | Blocked by policy |
| halftime / first-half | **HARD_BLOCKED** | Permanent policy. Never enters queue. Blocked in buildFireModelCandidates. | N/A — permanent block | No | Policy |
| second-half | **KEEP_BLOCKED** | Same as halftime category | N/A | No | Blocked by policy |
| WC-specific (fifwc-*) | **ALLOW_TIER1** | Canonical event_slug, strongest identity, WC policy | Already live | YES | WC corpus |
| General soccer (non-WC) | **ALLOW_TIER1** (STRONG identity only) | Lower data coverage but allowed if identity STRONG | token_id + event_slug | YES if STRONG | Growing corpus |
| Weak identity single-team spread | **BLOCKED** | Cannot confirm which team's spread without full event context | event_slug + team pair extraction | No | Blocked by M1 rules |
| Activity label contaminated | **BLOCKED** | activity_label_in_market_slug detected | N/A | No | Blocked by policy |

---

## WC vs General Football

| Dimension | WC (fifwc-*) | General Soccer |
|---|---|---|
| Event slug | Canonical, always present | Variable quality |
| Identity quality | STRONG | MEDIUM–STRONG |
| Tier eligibility | TIER1 | TIER1 only |
| Timing window | T-60 to T-5 | T-60 to T-5 |
| Stake | $7 | $7 |
| Markets allowed | moneyline, spread, total | moneyline, spread, total |

---

## Halftime / First-Half — Permanent Hard Block

```
halftime/first-half markets are blocked in buildFireModelCandidates
before they reach night_event_reservations or event_execution_queue.
They will never appear in the queue. No founder action required.
```

---

## Event-Level vs Market-Level Flow

1. **Reservation** (`night_event_reservations`): event-level lock at 17:00 Minsk. Records the event, not the market.
2. **Rebalance** (`event_execution_queue`): market-level selection at T-60. Picks best market for the reserved event.
3. **Ireland**: reads the single queued market per event. Does not re-select.

---

## No Production Policy Changed

This file documents current runtime behavior. No code was modified.
See `M4_FOOTBALL_POLICY_SQL.sql` for diagnostic queries.
