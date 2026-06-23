# M2 — eSports Policy Shadow Audit

Generated: 2026-06-23. Phase: shadow-only, no production policy changed.

---

## Purpose

Determine whether eSports should be allowed/skipped/stake-reduced based on resolved data evidence, not intuition.

---

## Sample Size Limitation

**Current state (2026-06-23):** No resolved eSports execution rows exist yet (first live order has not been placed). All conclusions below are structural/framework only. Profitability recommendations require ≥10 resolved eSports rows minimum.

---

## eSports Subcategory Classification

| Game / League | Source Label | Expected Market Families | Initial Stance |
|---|---|---|---|
| CS2 / Counter-Strike | `esport`, `cs2`, `csgo` | moneyline, map winner | `SHADOW_ONLY` |
| League of Legends | `esport`, `lol` | moneyline, series winner | `SHADOW_ONLY` |
| Dota 2 | `esport`, `dota2` | moneyline, series winner | `SHADOW_ONLY` |
| Valorant | `esport`, `valorant` | moneyline | `SHADOW_ONLY` |
| Generic eSports | `esport`, `ESPORT` | unknown | `SHADOW_ONLY` |

---

## Structural Assessment (Pre-Data)

| Dimension | Assessment |
|---|---|
| Timing sensitivity | High — matches start/end quickly, T-60 window may be too early or too late |
| Identity quality | Typically medium: team names in slug but no stable WC-style event IDs |
| Market liquidity | Lower than WC/soccer — price impact risk on $7 orders is low but spread may be wide |
| Odds bands | Often binary (one team is heavy favorite); edge may exist on underdog sides |
| Tier eligibility | TIER1 only — no eSports Tier2 candidates in queue (confirmed by executorQueueTypes) |

---

## Recommendation (Shadow Phase)

**Default: `SHADOW_ONLY` for all eSports until ≥10 resolved rows are available.**

Do not change execution policy in code. Do not add eSports to allow-list. Do not skip eSports proactively (they may already be below selection threshold naturally).

When ≥10 resolved rows exist, re-run `M2_ESPORTS_SQL.sql` and evaluate:
- win_rate ≥ 55% → `ALLOW`
- win_rate 45–55%, N<10 → `SHADOW_ONLY` (more data)
- win_rate <45%, N≥10 → `SKIP` or `STAKE_REDUCE` to $3.50

---

## No Production Policy Changed

This file is documentation only. No code was modified.
