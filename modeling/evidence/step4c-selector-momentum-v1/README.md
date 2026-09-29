# STEP 4C selector and momentum transition V1

`NOT_EXECUTION_AUTHORITY`. Fixed production snapshot run: `f94429cb-eb8e-4607-a06d-701208b8ceb3`.

## Verified opportunity set

One opportunity is one exact `(condition_id, selected_token_id)` snapshot identity in this run with `diagnostics.providerSportFamily = soccer`, a nonempty `event_id`, valid `0 < selected_price_num < 1`, structured `diagnostics.researchContext.marketType`, and `snapshot_at < game_start_iso`. All 3,784 soccer rows satisfy those requirements. Physical events group by the persisted `event_id`. `FORWARD_EVENT_MEMBERSHIP.json` freezes all 197 event IDs, per-event identity count, 1.75–2.00 token count, and a server-side hash of the exact sorted identity set; it does not substitute inferred siblings.

Production read-only aggregate on 2026-09-29: 197 events; 169 with at least two identities; 107 with any 1.75–2.00 token; 53 with at least two band tokens; maximum 94 identities and 25 band tokens per event. Identity distribution by event: 28 with one, 53 with two to four, 56 with five to nine, 1 with ten to 24, and 59 with at least 25. Total band tokens: 573. `FORWARD_SUPPLY_DIAGNOSTICS.json` retains the 22 structured market types and timing buckets. Timing counts: `<1h=127`, `1–3h=0`, `3–6h=805`, `6–12h=1969`, `12–24h=856`, `>=24h=27`.

## Selector binding and current limit

`scripts/modeling/step4c-selector-momentum-harness.ts` imports `compareChronologically()` from the frozen research engine and `compareCandidateQuality()` from the current live planner. It groups exact siblings by `event_id`, selects before joining labels, preserves OPEN slots, rejects duplicate identities or incomplete live candidates, and rejects a top-ranked comparator tie. Focused tests demonstrate different A/B identities and reversed-input determinism on complete candidates.

The production snapshot does **not** persist the full `FireModelCandidate` required by the live comparator. For the S2 soccer subset, persisted `live_eligible`, live tier, `smart_money`, and `match_family_key_source` are each present on **0/3276** rows. `fireModel.modelCandidate` contains research score and coverage, but its `tier` is null. Filling these fields with defaults or rewriting the comparator in SQL would invent a live selector. The frozen STEP 4B historical rows also lack the full live candidate. Consequently, actual A/B disagreement N, exact A/B selected membership, paired PnL, ROI, MaxDD, market-family/timing diagnostics of selected arms, and A-win/B-loss cannot be reported from these sources. Previous provisional selector figures remain provenance only.

## Momentum readiness

S2 soccer is defined by `diagnostics.scoreObservation.sourceLineage = S2_WIDE_SCORER` in the fixed run. It has 3,276 exact identities and 152 events. All 3,276 have price, structured market type, score, coverage, pre-start timing, and all four momentum fields: `price1hAgo`, `price6hAgo`, `delta1hPp`, `delta6hPp`. The fixed temporal split is event start before 2026-09-29 UTC (2,723 identities, 122 events) versus event start on/after that date (553 identities, 30 events). No identity crosses the split by event start.

`MOMENTUM_CONTRACT.json` freezes M0 price/market baseline, M1 decision-time context without momentum, M2 the same context plus exactly the four momentum fields, missing-value rule, outcome boundary, and metrics. No canonical M0/M1/M2 estimator was identified in current code; this package does not create an arbitrary fitting method. Current exact-key `generated_signal_pairs.signal_result` WIN/LOSS matches for the S2 cohort: **0** (diagnostic only, not canonical settlement). Canonical settlement comes from Gamma/CLOB terminal state in the research-corpus path, and no current persisted canonical exact-identity label source was available for this production cohort in this bounded read. Architect's preflight also reported canonical WIN/LOSS 0; this run could not independently remeasure that external settlement join.

`MOMENTUM_ABLATION_STATUS = WAITING_FOR_CANONICAL_SETTLEMENT`. Selected forward A/B membership and held-out alpha are also awaiting authentic full live-comparator inputs and a canonical estimator binding. No outcome, PnL, or incremental lift is inferred from price movement or noncanonical labels.

## Reproducibility

The event membership file pins every physical event's exact identity-set hash. `SHA256SUMS.txt` pins the evidence and harness bytes. The pure selector test exercises forward/reversed input order. Rerun the focused test with `node --import tsx --test tests/modeling/step4c-selector-momentum-harness.test.ts`. A later outcome-based run must supply the fixed cohort's full point-in-time `FireModelCandidate` values and exact canonical labels to this binding; it must not reselect from a later candidate universe.
