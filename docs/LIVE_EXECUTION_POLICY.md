# Live Execution Policy

Status: founder-approved production policy.

## Canonical Battle Rule

Tier1-only live policy is deprecated.

For each active night window, the executor planning layer should fill up to 15
live/executable bet slots when safe candidates exist.

Selection ladder:

1. Select Tier1 candidates first.
2. If Tier1 selected count is below 15, fill remaining slots with Tier2.
3. If Tier1 + Tier2 selected count is below 15, fill remaining slots with Tier3.
4. Stop at 15 total executable slots or when no eligible candidates remain.

Policy id:

```text
TIER_FALLBACK_TO_15
```

## Hard Safety Gates

These gates remain mandatory and are not loosened by fallback quota:

- token_id or selected_token_id present
- condition_id present
- side or selected_outcome present
- no duplicate condition_id::token_id
- event not ended or invalid
- bankroll and max-night-notional caps respected
- max live order cap respected
- no manual orders
- no CLOB/auth/region bypass

## Stake Caps

- Tier1: existing model stake.
- Tier2: existing reduced fallback stake rules, capped by planner.
- Tier3: capped at the smaller of existing stake or `$2.50`.

## Diagnostics

`/api/executor/night-plan` must expose:

- `fallback_policy = TIER_FALLBACK_TO_15`
- `target_live_slots`
- `final_live_slots`
- `tier1_selected_count`
- `tier2_fallback_selected_count`
- `tier3_fallback_selected_count`
- `candidate_shortfall`

Ireland must accept planned fallback candidates when `live_eligible=true` and
token/condition/side are present.
