# STEP 4C Contract A final selector replay V1 — Batch 1

`NOT_EXECUTION_AUTHORITY = true`. Research only. Production DB read-only, 0 writes. No settlement, PnL, or momentum fitting.
Fixed snapshot run `f94429cb-eb8e-4607-a06d-701208b8ceb3`, `REPLAY_AS_OF_ISO = 2026-09-28T10:34:08.835Z`
(min = max snapshot_at, 1 distinct value, 12,082 rows). Replay start SHA `4b8a7bfdfe92f0866928b0b3eeb550e4fdfcaec9`.

## Supersession of the earlier research binding

The previous `step4c-selector-momentum-v1` binding B = `compareCandidateQuality` represented planning-stage sibling ranking
and is not the production final WHAT-to-bet authority. It is superseded for exact-market A/B analysis by
B = `produceFrozenModelV2ShadowDecisions`. That artifact is preserved unmodified as provenance.

## Frozen selector contract

- PLANNING_OWNER: `buildReservationPlan` / `CONTRACT_A_PLANNING_V1` / `compareCandidateQuality` (physical-event reservation ranking, `nightEventReservations.ts:947,1151`). Reservations persist a `PlanningEventIdentity`, not a market.
- FINAL_MARKET_OWNER: Contract A final (`CONTRACT_A_V1` / FROZEN_MODEL_V2).
- FINAL_MARKET_FUNCTION: `produceFrozenModelV2ShadowDecisions` (`frozenModelProducerV2Shadow.ts:269`), reached through `buildContractAV1Candidates` (`buildFireModelCandidates.ts:1399-1415`).
- FINAL_MARKET_STAGE: T-70..T-3 rebalance authoritative identity; `eventExecutionQueue.ts:1563-1640` validates the exact identity and must not replace it via `compareCandidateQuality`.
- As-of seam: the producer's explicit `asOfIso` argument. No production code was modified; wall clock unused.
- Producer gates (verbatim, not reimplemented): visible at as-of, canonical T-90 snapshot per identity, score >= 65, entry price >= 0.30, binary market, 0 < minutes-to-start <= 1440, esports excluded, one winner per event (highest score, earliest created_at, smallest identity).

## Source coverage (aggregates, no raw extraction)

| | N |
|---|---|
| S2 exact identities | 3,276 |
| with a source row visible at as-of (exact condition_id + selected_token_id, created_at <= as-of) | 2,432 |
| S2 events | 152 |
| COMPLETE (every frozen sibling visible) | 65 |
| PARTIAL | 61 |
| ZERO | 26 |

Complete events need 1,679 source rows (max 3 per identity), all T-90 compatible. Replay coverage of the 152 S2 events is 65/152 = 42.76%. The 61 partial and 26 zero events are not replayed and never inferred.

## Batch plan

Complete events are sorted by snapshot `event_id` (text ascending) and packed greedily without splitting an event. The 200-row mission cap covers all raw rows, so each event costs its visible source rows plus the A tie-set rows (the exact minimum-`entryPrice` siblings, which `compareChronologically` decides among; all other tie fields are identical within an event). Total cost is 1,679 + 926 rows, so **20 batches** are required. Under source-rows-only accounting the requirement would be 9 batches. Batch 1 is 17 events, 176 source rows + 18 A rows = 194. `RAW_ROWS_READ_N = 197` including three single-row probes.

## Batch 1 result (17 events, denominator = paired events)

- A selected 17, B selected 11, B fail-closed 6, paired 11.
- **Different exact identity: 7 of 11 = 63.64%. Same identity: 4.** This is Batch 1 only (17 of 65 complete events), not all-152 or all-65 coverage.
- B fail-closed reasons: all 6 events failed on `SCORE_BELOW_65` (23 identity rejections). Across all 74 identities of Batch 1: `SCORE_BELOW_65` 53, `DUPLICATE_EVENT_LOWER_RANK` 10, 11 accepted.
- Every fail-closed event is one where no sibling passes the frozen score floor; A still selects chronologically there.

## Semantic assertions (all true)

Max one accepted identity per event; no outcome field in input; no source row after as-of; pairing by exact snapshot event_id and exact condition::token join only; no fabricated sibling; reversed input gives identical B decisions; repeat run identical; every selected identity is in the input. The artifact bytes are identical across two independent runs.

## Defect found and handled (transport, not selector)

The Management SQL API returns `numeric` as strings and `timestamptz` as `YYYY-MM-DD HH:MM:SS+00`. The producer requires JSON numbers, so the first run rejected every row as `SCORE_BELOW_65`. Production reads via PostgREST (numbers, ISO timestamps; verified with one row). The script's `toPostgrestShape` restores that wire shape without changing any value. That first result was discarded.

## Limits

- Batch 1 only; remaining 19 batches are not run.
- Batch 1 events are the lowest event_ids, not a random sample.
- Raw source rows are not committed; `BATCH_1_MEMBERSHIP.json` carries `RAW_INPUT_SHA256` of the exact input.
