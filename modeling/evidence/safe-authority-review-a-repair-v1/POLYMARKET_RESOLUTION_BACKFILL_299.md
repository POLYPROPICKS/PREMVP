# Polymarket resolution backfill — frozen P50_52 football selections

Lookup snapshot: 2026-09-24T14:17:39.134Z, on PR #396 at `8c8b714f164717e27dfe18a4440a361eca3309ca`. The 299 identities were selected before this lookup. The six-field frozen identity export was verified again by SHA-256 after restoring entry prices from the exact research-clone rows; no membership or price changed. The exact canonical reconciliation is recorded in `CANONICAL_RECONCILIATION_P50_52.md`.

## Frozen baseline

```text
P50_52_SELECTED_N=1015
ORIGINAL_TERMINAL_N=716
ORIGINAL_OPEN_N=299
ORIGINAL_REFERENCE_PNL_U=+131.79
```

## Authoritative lookup

```text
POLYMARKET_LOOKUP_N=299
AUTHORITATIVE_MATCH_N=299
BACKFILL_RESOLVED_N=237
WIN_N=145
LOSS_N=92
VOID_N=0
STILL_UNRESOLVED_N=62
BACKFILL_PNL_U=+51.01
BACKFILLED_COHORT_ROI_PCT=21.5232
```

Each frozen `condition_id` was requested with `GET https://clob.polymarket.com/markets/{condition_id}`. A market match requires the returned `condition_id` to equal the requested ID and the exact `selected_token_id` to occur once in `tokens[].token_id`. WIN/LOSS require `closed=true`, exactly one `tokens[].winner=true`, and boolean winner fields for every token. The selected token's winner field determines WIN or LOSS. VOID requires an explicit market resolution marker proving void; none was observed. All other cases remain UNRESOLVED. The compact per-identity classification and HTTP status are in `POLYMARKET_RESOLUTION_MAPPING_299.json`; raw API payloads are not stored.

The mapping also records each frozen `entry_price`, `decision_at`, `provider_event_id`, and `event_start`. Those values were restored read-only by exact condition/token keys from the research clone. The resulting six-field identity list has SHA-256 `27acf81ef7fd3f5d8b6e80b00c866be56ca952efcce3a8784d0e9f266871ead1`, identical to the original export. For each newly resolved row, reference PnL is `1 / entry_price - 1` for WIN, `-1` for LOSS, and `0` for VOID. Recomputing from the mapping gives +51.01u after rounding to cents.

## Updated reference result

```text
FINAL_SELECTED_N=1015
FINAL_TERMINAL_N=953
FINAL_UNRESOLVED_N=62
FINAL_REFERENCE_PNL_U=+182.80
FINAL_REFERENCE_ROI_PCT=19.1815
SETTLEMENT_COVERAGE_PCT=93.89
```

The 237 newly resolved selections produced +51.01u and 21.5232% reference ROI. This observed backfilled cohort does not support the hypothesis that the previously OPEN subset was hiding systematically worse historical outcomes. The remaining 62 selections are unresolved, so this observation is not generalized to all 299.

```text
REFERENCE_PNL=NOT_EXECUTION_AUTHORITY
PRICE_INDEPENDENT_ALPHA_PROVEN=NO
RESULT_SHA=37837812e902ac7819d2d283121d1c3747a707b13ddb8d08aff9956df352adb1
```
