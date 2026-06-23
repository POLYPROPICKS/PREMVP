# M3 — MLB / Other Sports Profitability Audit

Generated: 2026-06-23. Phase: shadow-only, no production policy changed.

---

## Purpose

Do not blindly take all MLB/other sports. Produce market-family policy table per sport based on data coverage, identity quality, and timing.

---

## Sample Size Limitation

**Current state (2026-06-23):** No resolved execution rows exist yet. Framework only — all classifications are structural pending live data.

---

## Policy Matrix (Pre-Data / Structural)

### Baseball / MLB

| Market Family | Current Live Status | Reason | Data Required for Future Allow | Safe Tonight | Sample/Evidence |
|---|---|---|---|---|---|
| moneyline | ALLOW_TIER1 | High liquidity, binary, clear identity | ≥10 resolved rows | YES if identity STRONG | Pending |
| run_line (spread) | SHADOW_ONLY | Spread requires confirmed run-line token | token_id + condition_id verified | Monitor | Pending |
| totals (over/under) | SHADOW_ONLY | Totals liquid but pricing may be efficient | ≥10 resolved rows | Monitor | Pending |
| team totals | SHADOW_ONLY | Smaller market, wider spread | ≥5 resolved rows | No | Pending |
| props | KEEP_BLOCKED | Player props are activity-label blocked upstream | N/A | No | Blocked by policy |
| unknown | NEEDS_MORE_SAMPLE | Cannot classify without market_family | market_family field required | No | Gap |

### Other Sports (Basketball, Hockey, Tennis, etc.)

| Market Family | Current Live Status | Reason | Data Required | Safe Tonight | Sample/Evidence |
|---|---|---|---|---|---|
| moneyline | ALLOW_TIER1 | Same binary structure as MLB | ≥10 resolved rows by sport | YES if identity STRONG | Pending |
| spread | SHADOW_ONLY | Needs spread-confirmed token | token_id present + verified | Monitor | Pending |
| totals | SHADOW_ONLY | Liquid but efficiency unknown | ≥10 resolved rows | Monitor | Pending |
| props | KEEP_BLOCKED | Activity-label blocked upstream | N/A | No | Blocked by policy |
| unknown | NEEDS_MORE_SAMPLE | No market_family field | market_family field required | No | Gap |

---

## Event-Level One-Per-Fixture Policy

- PREMVP rebalance writes exactly one market per match_family_key to `event_execution_queue`
- Ireland reads this as-is — no additional event-level dedup needed on Ireland side
- If reservation exists but rebalance writes zero rows → SKIPPED (reported in rebalance diagnostics)

---

## Data Coverage Requirement by Sport

| Sport | Min Resolved N for Policy Decision | Field Coverage Requirement |
|---|---|---|
| Baseball/MLB | 10 | event_slug, token_id, condition_id, market_family, resolved_outcome |
| Basketball (NBA/NCAA) | 10 | Same |
| Hockey (NHL) | 10 | Same |
| Tennis | 5 | event_slug, token_id, condition_id, market_family |
| Other | 5 | Same |

---

## No Production Policy Changed

Documentation only. See `M3_MLB_OTHER_SPORTS_SQL.sql` for data queries.
