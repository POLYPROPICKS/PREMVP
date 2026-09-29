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

## Canonical market-type lineage

Counts are shown first by unique `condition_id + selected_token_id` identity, then by unique `provider_event_id` physical event, for canonical soccer only. A condition with conflicting normalized structured observations fails closed.

`MARKET_TYPE_LINEAGE_BY_PERIOD`:
```json
{
  "AUG": {
    "IDENTITY": {
      "FROM_CANONICAL_ROW_N": 2493,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 542,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 2,
      "FROM_EVIDENCE_PAGE_N": 0,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 56,
      "CANONICAL_SOCCER_N": 3093,
      "RESOLVED_N": 3037,
      "EXACT_SCORE_N": 788,
      "PROVEN_ORDINARY_N": 2249
    },
    "PHYSICAL_EVENT": {
      "FROM_CANONICAL_ROW_N": 185,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 473,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 2,
      "FROM_EVIDENCE_PAGE_N": 0,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 29,
      "CANONICAL_SOCCER_N": 689,
      "RESOLVED_N": 660,
      "EXACT_SCORE_N": 34,
      "PROVEN_ORDINARY_N": 626
    }
  },
  "SEP_1_12": {
    "IDENTITY": {
      "FROM_CANONICAL_ROW_N": 0,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 2813,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 89,
      "FROM_EVIDENCE_PAGE_N": 708,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 3886,
      "CANONICAL_SOCCER_N": 7496,
      "RESOLVED_N": 3610,
      "EXACT_SCORE_N": 7,
      "PROVEN_ORDINARY_N": 3603
    },
    "PHYSICAL_EVENT": {
      "FROM_CANONICAL_ROW_N": 0,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 1432,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 31,
      "FROM_EVIDENCE_PAGE_N": 391,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 1192,
      "CANONICAL_SOCCER_N": 3046,
      "RESOLVED_N": 1854,
      "EXACT_SCORE_N": 7,
      "PROVEN_ORDINARY_N": 1847
    }
  },
  "SEP_13_24": {
    "IDENTITY": {
      "FROM_CANONICAL_ROW_N": 6034,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 2,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 2,
      "FROM_EVIDENCE_PAGE_N": 1920,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 6,
      "CANONICAL_SOCCER_N": 7964,
      "RESOLVED_N": 7958,
      "EXACT_SCORE_N": 12,
      "PROVEN_ORDINARY_N": 7946
    },
    "PHYSICAL_EVENT": {
      "FROM_CANONICAL_ROW_N": 1159,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 2,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 0,
      "FROM_EVIDENCE_PAGE_N": 143,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 5,
      "CANONICAL_SOCCER_N": 1309,
      "RESOLVED_N": 1304,
      "EXACT_SCORE_N": 9,
      "PROVEN_ORDINARY_N": 1304
    }
  },
  "COMBINED": {
    "IDENTITY": {
      "FROM_CANONICAL_ROW_N": 8527,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 3348,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 93,
      "FROM_EVIDENCE_PAGE_N": 2628,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 3948,
      "CANONICAL_SOCCER_N": 18544,
      "RESOLVED_N": 14596,
      "EXACT_SCORE_N": 807,
      "PROVEN_ORDINARY_N": 13789
    },
    "PHYSICAL_EVENT": {
      "FROM_CANONICAL_ROW_N": 1344,
      "FROM_RESEARCH_CONTEXT_EXACT_N": 1893,
      "FROM_FIREMODEL_HINT_EXACT_N": 0,
      "FROM_CONDITION_STATIC_RECOVERY_N": 33,
      "FROM_EVIDENCE_PAGE_N": 534,
      "FROM_GSP_N": 0,
      "CONFLICT_N": 0,
      "UNRESOLVED_N": 1226,
      "CANONICAL_SOCCER_N": 5030,
      "RESOLVED_N": 3804,
      "EXACT_SCORE_N": 50,
      "PROVEN_ORDINARY_N": 3763
    }
  }
}
```

## Scope and non-claims

This artifact defines **denominator and sport/market classification authority only**.

- `NO_MODEL_RANKING_PERFORMED`
- `NO_EXECUTION_ECONOMICS_CLAIM`
- `IMMUTABLE_SOURCE_CORPUS_UNCHANGED`

No hypothesis was tested, no ROI or leaderboard was computed here, and `research_model_ready_rows`/`research_model_ready_days` were not modified — this is a read-only sidecar overlay.
