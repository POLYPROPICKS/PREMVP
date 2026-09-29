# STEP 4C canonical label closure v1 (research only, NOT_EXECUTION_AUTHORITY)

Result: **STRICT_LABEL_PATH_PROVEN**. Production project `nbnldzfsxffztsfrrxqy`, fixed snapshot run `f94429cb-eb8e-4607-a06d-701208b8ceb3`, read-only.

## Strict resolver
`scripts/modeling/step4c-strict-terminal-resolver.ts` reuses `fetchGammaMarketByConditionId` and `resolveProviderMarketWinner` unchanged and adds: returned conditionId must equal requested (else LOOKUP_UNAVAILABLE / CONDITION_ID_MISMATCH); selected token must be in `clobTokenIds` (else INVALID_TOKEN_IDENTITY, never LOSS); null lookup, malformed data, or closed without a single >=0.99 winner is LOOKUP_UNAVAILABLE, never OPEN. `lib/feed/resolveSignalOutcome.ts` is untouched. 12/12 focused tests pass.

## Bounded sample (50 exact identities, ORDER BY condition_id, selected_token_id, membership frozen and SHA-recorded before resolution)
| SAMPLE_N | WIN | LOSS | OPEN | LOOKUP_UNAVAILABLE | INVALID_TOKEN_IDENTITY | CONDITION_ID_MISMATCH |
|---|---|---|---|---|---|---|
| 50 | 25 | 22 | 3 | 0 | 0 | 0 |

All strict invariants pass; reversed input gives identical label counts. OPEN is point-in-time provider state.
The first 50 identities by ordering are a deterministic but not random slice; do not read its win rate as a cohort estimate.

## Full-cohort feasibility (aggregates only, nothing else resolved)
S2_IDENTITY_N 3,276 (all with non-empty condition_id and selected_token_id); BATCH_SIZE 50; TOTAL_BATCH_N_REQUIRED 66 (last batch 26). Identities are retrievable deterministically by keyset paging on (condition_id, selected_token_id), which is unique per run; a keyset probe from the last sample key returned the next row. Full closure needs at most 3,276 Gamma lookups (fewer, as identities share conditionIds). Remaining batches were not executed.

Counters: RAW_DB_ROWS_READ_N 52, GAMMA_LOOKUP_N 28 (distinct conditionIds), production writes 0.
