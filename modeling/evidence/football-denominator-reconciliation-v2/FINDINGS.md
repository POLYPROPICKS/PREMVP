# Football Denominator Reconciliation V2 — 2026-08-04 .. 2026-09-24

Status: **DENOMINATOR / CLASSIFICATION AUTHORITY ONLY**

Extends `football-denominator-reconciliation-v1` (2026-08-04..2026-09-20) through 2026-09-24.
The v1 artifact under `modeling/evidence/football-denominator-reconciliation-v1/` is unchanged.
Every classification rule below is imported verbatim from `build-football-denominator-reconciliation.ts` (v1) — this run only extends the read range and adds the SEP_1_12 / SEP_13_24 period split.

## Source range

Read-only overlay over `research_model_ready_rows` (research clone `nppznoujvnyjargjkmnv`) for `2026-08-04` through `2026-09-24`, split into AUG (`2026-08-04..2026-08-31`), SEP_1_12 (`2026-09-01..2026-09-12`) and SEP_13_24 (`2026-09-13..2026-09-24`).

## Per-period summary

| Period | SOURCE_ROW_N | UNIQUE_SELECTION_N | UNIQUE_PHYSICAL_EVENT_N | CANONICAL_SOCCER_PHYSICAL_EVENT_N | SPORT_UNRESOLVED_N | SPORT_CONFLICT_N | DUPLICATE_OVERLAY_IDENTITY_N |
|---|---|---|---|---|---|---|---|
| AUG | 28431 | 18325 | 2514 | 689 | 1111 | 0 | 0 |
| SEP_1_12 | 27439 | 18853 | 6608 | 3046 | 220 | 0 | 0 |
| SEP_13_24 | 19873 | 15755 | 3626 | 1309 | 177 | 0 | 0 |
| COMBINED | 75743 | 52340 | 12709 | 5030 | 1504 | 0 | 0 |

(COMBINED is deduplicated over the whole 2026-08-04..2026-09-24 range, not a sum of the three periods; a physical event present in more than one period is counted once in COMBINED. Physical events present in both AUG and SEP_1_12: 36. Physical events present in both SEP_1_12 and SEP_13_24: 1.)

## Scope and non-claims

This artifact defines **denominator and sport/market classification authority only**.

- `NO_MODEL_RANKING_PERFORMED`
- `NO_EXECUTION_ECONOMICS_CLAIM`
- `IMMUTABLE_SOURCE_CORPUS_UNCHANGED`

No hypothesis was tested, no ROI or leaderboard was computed here, and `research_model_ready_rows`/`research_model_ready_days` were not modified — this is a read-only sidecar overlay.
