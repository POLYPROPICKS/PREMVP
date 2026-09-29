# Delta: Candidate V3 vs prior candidate

NOT_EXECUTION_AUTHORITY = true

## WHAT V3 KEEPS
- KEEP: Contract A final exact-market authority (`produceFrozenModelV2ShadowDecisions`).
- KEEP: score >= 65.
- KEEP: price >= 0.30 (no ceiling, no odds band).
- KEEP: existing Contract A timing (0 < minutes_until_start <= 1440) and T-90 semantics (created_at <= start - 90m, latest eligible).
- KEEP: one exact market per physical event (score DESC, created_at ASC, observationId ASC).
- KEEP: BINARY-only, eSports excluded, complete identity, strict settlement labels.

## WHAT V3 REMOVES / REJECTS
- REMOVE / DO NOT PROMOTE: momentum features (price1hAgo, price6hAgo, delta1hPp, delta6hPp) - STEP4C: NO_MOMENTUM_LIFT_PROVEN.
- DO NOT PROMOTE: chronological-first selector.
- DO NOT PROMOTE: cross-period September ROI as execution authority.
- DO NOT ADD: odds 1.75-2.00 restriction.

## WHAT REMAINS PROVISIONAL
- Historical ROI / ROI magnitude (Sep1-12 vs Sep13-24 coverage and settlement limited).
- OPEN_ITEM_MARKET_TYPE_ABSENT_ADMITTED: producer admits rows with absent market_type; PR #409 lineage shows market type unresolved for most SEP_1_12 rows. Preserved as-is; Final Review decides.
- OPEN_ITEM_SPORT_SCOPE_UPSTREAM: football scope is enforced by the universe pre-filter, not inside the producer.
