# RESEARCH_CORPUS_AUTHORITY_V1

Data-authority freeze. **Not** an alpha verdict, not a model, not a strategy recommendation.
Machine-readable twin: `evidence/modeling/research_corpus_authority_v1.json` (full per-cell tables live there).

- Generated: 2026-10-08T14:18Z · Measured at `main` = `cbf7061` (requested `fc8ce09` is an ancestor; main had advanced)
- Authority: DBClone `nppznoujvnyjargjkmnv`, read-only. Production not queried. 0 writes, 0 schema changes.
- Local event date basis: Europe/Minsk (UTC+3) applied to `event_start_iso`.
- All counts are live snapshots; the capture tables are still growing.

## 1. Dataset manifest

| Table | Role | Rows | Phys. events | Tokens | Min → Max | Days | Growing | Join keys |
|---|---|---:|---:|---:|---|---:|---|---|
| reservation_market_capture_runs | capture-attempt ledger | 843 | 233 | – | 09-30 → 10-08 | 9 | YES | physical_event_id, reservation_id |
| reservation_market_observations | **primary prematch corpus** | 20,384 | 216 | 9,548 | 09-30 → 10-08 | 9 | YES | capture_run_id, physical_event_id, condition_id, token_id |
| reservation_strategy_observations | per-variant decisions | 78,648 | 216 | 9,548 | 09-30 → 10-08 | 9 | YES | market_observation_id, strategy_variant |
| generated_signal_research_snapshots | signal feature history | 1,130,858 (249,480 since 09-28) | 31,698 `event_id` | 259,914 | 06-02 → 10-07 | 109 | YES | event_id, selected_token_id |
| research_precontract_t20_observations | T20 book sample | 166 | 14 | 166 | 10-07 | 1 | NO | physical_event_id, token_id |
| research_inplay_core_path_observations | in-play path | 2,508 | 44 | 88 | 10-08 | 1 | YES | physical_event_id, token_id |
| research_model_ready_rows | frozen legacy | 114,026 | 21,166 `provider_event_id` | 77,594 | 08-03 → 10-07 | 66 | NO | population_id, condition_id, token |
| generated_signal_pairs | frozen legacy | 3,065,533 | – | – | 05-05 → 10-07 | – | unknown | not profiled |
| bet_execution_ledger → event_execution_queue → night_event_reservations | actual execution/settlement lineage | 31 | 31 | 31 | 09-30 → 10-07 | – | YES | (condition_id, token_id) → reservation_id → physical_event_id |

17 of the 233 capture-run events have no market observations (REFERENCE_ONLY / CAPTURE_FAILED / INCOMPLETE_MARKET_SET).
Capture status: COMPLETE 563, REFERENCE_ONLY 218, INCOMPLETE_MARKET_SET 60, CAPTURE_FAILED 2.

## 2. No-bet preservation

Actual execution = a `bet_execution_ledger` row with `exchange_order_id`, status FILLED/WON/LOST, joined by exact
`(condition_id, token_id)` through the queue to the reservation's `physical_event_id`. It is **not** inferred from
SELECTED, reservations, queue rows or observations.

| | Events |
|---|---:|
| Observed physical events (market observations) | **216** |
| With actual execution (in corpus) | 29 (27 with a fill price) |
| **Without actual execution** | **187** (= 216 − 29) |
| Executed ledger events outside the corpus | 2 (31 total) |

`NO_BET_EVENTS_INCLUDED_IN_CORPUS = YES`. Corpus membership is presence in `reservation_market_observations`;
bet status is never a filter.

## 3. Phase coverage (global)

| Phase | Rows | Events | Tokens | minutes_to_start min / median / max |
|---|---:|---:|---:|---|
| T_MINUS_30 | 9,486 | 213 | 9,442 | 26.2 / 29.7 / 39.9 |
| T_MINUS_10 | 9,382 | 213 | 9,338 | 11.9 / 14.6 / 20.0 |
| T_MINUS_3 (legacy, last row 10-02) | 1,374 | 31 | 1,374 | 4.0 / 4.6 / 5.0 |
| LIVE_GUARD | 142 | 142 | 142 | 3.7 / 14.4 / 69.6 |

Phase is a sampling label only. Time truth for modeling = `event_start_iso − observed_at`. The phase × local date ×
market type matrix (69 cells) is in the JSON.

## 4. Market coverage

| Family / type | Rows | Events | First seen | Last seen |
|---|---:|---:|---|---|
| SPREAD | 8,140 | 197 | 10-01 | 10-08 |
| TOTAL | 7,326 | 197 | 10-01 | 10-08 |
| MONEYLINE | 2,454 | 198 | 10-01 | 10-08 |
| NULL / legacy | 2,044 | 142 | 09-30 | 10-08 |
| OTHER_STRUCTURED | 420 | 6 | 10-01 | 10-01 |

- `TOTAL_CORNERS_STATUS = SOURCE_SAMPLE_ABSENT` (no rows in any phase).
- `SPREAD_STATUS = SETTLEMENT_ANALYTICALLY_QUARANTINED` (unresolved historical settlement anomaly; not repaired here).
- NULL type = 142 LIVE_GUARD rows + 3 × 634 legacy T10/T3/T30 rows (12 events), pre-canonical.

## 5. Executable evidence

| Class | Count | Fee semantics |
|---|---:|---|
| `T30_BOOK_EXECUTABLE_EVIDENCE_N` | **0** | would be book-only, fee UNKNOWN / FEE_NOT_ATTEMPTED |
| `T10_FEE_COMPLETE_EXECUTABLE_EVIDENCE_N` | **1,019 rows / 52 events** | taker fee KNOWN, `executable_full_stake=true` |
| `LIVE_GUARD_EXECUTABLE_EVIDENCE_N` | **0** (70 vwap-only rows) | no shares, no flag, no fee |

- T10 telemetry (`T10_EXECUTABLE_SIBLING_TELEMETRY_V1`): 2,288 rows, vwap/shares non-null 1,075, executable true 1,019
  (MONEYLINE 156, TOTAL 454, SPREAD 409). First seen 2026-10-05.
- T30: `T30_PASSIVE_EXECUTABLE_BOOK_V1` code merged 2026-10-08T13:23Z, after the newest T30 row in the clone
  (10:50Z). No persisted T30 row carries it yet. The two cost definitions must stay separate.

## 6. Decision telemetry

| Variant | Rows | Class |
|---|---:|---|
| A_CURRENT_CONTROL | 8,748 (SELECTED 102 / NOT_SELECTED 8,646) | VALID_DECISION_AUTHORITY |
| B_FOUR_MARKET_PRIORITY_V1 | 8,748 (SELECTED 127 / NOT_SELECTED 8,621) | VALID_DECISION_AUTHORITY |
| S1_TAKER_HOLD | 20,384 NOT_EVALUATED | PLACEHOLDER_NOT_EVALUATED |
| S2_FIXED_MAKER_HOLD | 20,384 NOT_EVALUATED | PLACEHOLDER_NOT_EVALUATED |
| S3_MAKER_VALUE_BAND_HOLD | 20,384 NOT_EVALUATED | PLACEHOLDER_NOT_EVALUATED |

`maker_target_price` and `target_touched` are non-null in 0 rows. `WOULD_BET_ECONOMIC_DECISION_AUTHORITY = PARTIAL`
(eligible/SELECTED persisted for A/B; no persisted economic decision fields). Not patched.

## 7. Execution / settlement joinability (lineage only, no PnL)

| | Events |
|---|---:|
| Executed ledger events | 31 |
| `ACTUAL_EXECUTION_JOINABLE_EVENT_N` (capture run + exact-token observation) | **29** |
| `ACTUAL_SETTLED_JOINABLE_EVENT_N` | **25** (27 settled in ledger overall) |
| `UNRESOLVED_EXECUTION_EVENT_N` | **4** (FILLED, no settlement) |

`EXACT_TOKEN_SETTLEMENT_JOIN = PASS`: `raw_order.settlement_v1.winning_token_id` agrees with status for 27/27
(13 WON = token, 14 LOST ≠ token, 0 inconsistent). The join fans out nowhere (31 → 31 reservations → 31 events).
Caveat: in the clone, `filled_at`, `result_side` and `real_pnl` are all NULL, so `settlement_v1` is the only settlement authority.

## 8. Prematch path counts (canonical-typed rows)

| Type | Events | BOTH T30+T10 | T30_ONLY | T10_ONLY |
|---|---:|---:|---:|---:|
| MONEYLINE | 198 | **195** | 0 | 3 |
| TOTAL | 197 | **195** | 0 | 2 |
| SPREAD | 197 | **195** | 0 | 2 |
| OTHER_STRUCTURED | 6 | 3 | 3 | 0 |

## 9. In-play

tennis × MONEYLINE only: 2,508 rows, 44 events, 88 tokens, 2026-10-08 07:38Z → 14:02Z, 1 day.
30 events have a FINAL observation, 14 do not.

## 10. Sport authority

`CANONICAL_SPORT_AUTHORITY = research_evidence_page_rows.provider_sport_family`, joined by the reservation's
`provider_event_id`. `CANONICAL_SPORT_MAPPED_EVENT_N = 213`, `SPORT_UNRESOLVED_EVENT_N = 3` (`provider_event_id` NULL,
not guessed). 0 conflicting mappings. `night_event_reservations.sport` is **not** canonical (league codes such as unl, conl, lal, epl).
Families: baseball, basketball, cricket, esports, hockey, mma, soccer, table-tennis, tennis.

## 11. Corpus classes

| Class | Events | Dates | Executable quality | Settlement quality | Limitation |
|---|---:|---|---|---|---|
| A PREMATCH_MARKET_PATH | 213 | 09-30 → 10-08 | top-of-book + depth | none in table | no market-level settlement; SPREAD quarantined; no corners |
| B PREMATCH_EXECUTABLE_T10 | 52 | 10-05 → 10-08 | full-stake VWAP + fee KNOWN | none beyond executed sample | 52 events, 4 days |
| C PREMATCH_EXECUTABLE_T30_PASSIVE | 0 | – | book-only, fee UNKNOWN | none | no persisted rows yet |
| D ACTUAL_EXECUTION_SETTLEMENT | 29 | 09-30 → 10-07 | real fills | exact-token PASS (25 settled, 4 open) | tiny, selection-biased, clone fields NULL |
| E INPLAY_PATH | 44 | 10-08 | book + full-stake fields | FINAL for 30 | tennis ML, 1 day |
| F LEGACY_RESEARCH_HISTORY | 31,698 `event_id` / 21,166 `provider_event_id` | 05-05 → 10-07 | signal entry price only | model_ready: 58,690 WIN/LOSS, 55,336 OPEN | different identity space; no bridge proven |

## 12. Known gaps

See `known_gaps` in the JSON. Headlines: 9-day corpus, T30 executable evidence unpersisted, no TOTAL_CORNERS, SPREAD
settlement quarantined, S1–S3 placeholders, partial would-bet authority, 31-row executed sample, 3 events without sport,
no bridge from the legacy identity space to `physical_event_id`.

NEXT = MECHANISM_GATE_V1.
