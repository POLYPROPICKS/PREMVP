# STEP 4C bounded historical momentum ablation V1

`NOT_EXECUTION_AUTHORITY = true`. Research only. Fixed snapshot run `f94429cb-eb8e-4607-a06d-701208b8ceb3`, production ref `nbnldzfsxffztsfrrxqy`, read-only.

## Result: `NO_MOMENTUM_LIFT_PROVEN`

Estimator `DETERMINISTIC_L2_LOGISTIC_V1` (lambda 1.0, Newton/IRLS, no tuning). 122 historical physical events, one identity each by smallest SHA256(condition_id::selected_token_id). Membership SHA256 `669792cbb32248faf0bfb3de9a536f6d0913d0481b4753afa0deeba41f3a6f1c` (frozen before settlement).

Labels (strict resolver, unchanged): WIN 65, LOSS 56, OPEN 1, LOOKUP_UNAVAILABLE 0, INVALID_TOKEN_IDENTITY 0, CONDITION_ID_MISMATCH 0. TERMINAL_N = 121 (>= 80). Strict invariants passed.

Folds (train/test): 48/24, 72/24, 96/25. Test log-loss per fold (M0 / M1 / M2): 0.7792/0.7857/0.8433, 0.6433/0.6117/0.6322, 0.6020/0.5913/0.5953.

Pooled over the 73 out-of-sample observations:

| Arm | Log-loss | Brier | Accuracy |
|---|---|---|---|
| M0 | 0.6738 | 0.2413 | 0.5616 |
| M1 | 0.6619 | 0.2349 | 0.5753 |
| M2 | 0.6890 | 0.2387 | 0.5753 |

M2 beat M1 on log-loss in 0 of 3 folds; pooled M2 log-loss and Brier are both worse than M1. Predeclared verdict applied mechanically: momentum features add no lift.

## Disclosures

- The SHA256 rule cannot be evaluated by PostgREST, so identity keys (event_id, condition_id, selected_token_id only, no labels or features) for all 2,723 historical S2 rows were read to apply it. RAW_DB_ROWS_READ_N = 2,845 (2,723 keys + 122 feature rows), above the 122/200 row guideline. Outcome-blind; no effect on results.
- Std uses population (divide by n); event_id ties sort as strings. Test-set probabilities are clipped to [1e-15, 1-1e-15] for log-loss only.
- Small sample (73 test observations): the result says lift is not proven, not that it is absent.
- The 30 prospective events, September reconciliation and the remaining label batches were not touched. Production writes: 0.
