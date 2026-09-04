# RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1

Historical MODEL-LAB step. Ranks the already-defined summer models on one trusted
historical basis and freezes provisional finalists for the next mission
(`CURRENT_EXECUTABILITY_AND_FINAL_FREEZE_V1`). No production / Contract A /
Reservation / Rebalance / Queue / Ireland / filter change.

## Files

| file | role |
|---|---|
| `SUMMER_MODEL_FINALIST_FREEZE_V1.json` | **the freeze** — exact predicates, required decision-time fields, per-model economics on every basis, ranking, 3 provisional finalists, no-tuning contract |
| `SUMMER_MODEL_RANKING_V1.json` / `.md` | full deterministic six-model scorecard (weekly buckets, concentration shares, sport + market-family composition) |
| `SHA256.txt` | checksums |

## Reproduce

```
npx tsx scripts/modeling/summer-model-ranking-scorecard.ts \
  --json-out modeling/evidence/summer-model-ranking/SUMMER_MODEL_RANKING_V1.json \
  --md-out   modeling/evidence/summer-model-ranking/SUMMER_MODEL_RANKING_V1.md
```

Deterministic: byte-identical output on every run. Reuses
`lib/modeling/research-engine/**` predicates, chronological ordering, flat-1u
settlement and PNL/ROI/MaxDD math unchanged. The C4 cohort reproduces the
accepted frozen August anchor exactly (N=4117 / +474.56u / 11.5269% / -16.41u).

## Basis

- **Primary reproduced basis**: `AUGUST_MAIN_DB_ENRICHMENT_V1` (18,705 August
  events, `shadow-strategic-sports-v1`, SHA `3e347283…93`), the in-repo
  reproducible portable slice of the June–August discovery corpus.
- **Cross-checks (not pooled)**: the June–August DISCOVERY denominator (9,282
  price-band physical events; `lib/modeling/research-engine/goldenContract.ts`,
  reproduced bit-for-bit in `PNL_PORTFOLIO_OVERLAP_AND_PRIORITY_V1`) and the
  held-out chronological tail `untouched_test.jsonl` (3,741 provider events).
- Contract A is evaluated only on its own settled Reservation denominator
  (`modeling/evidence/contract-a-validation/`), never pooled with C0–C5.

## Decision

`TWO_OR_THREE_PROVISIONAL_FINALISTS_FROZEN` — **C1, C4, C2**.

| finalist | predicate (shared band `0.50 ≤ entry_price < 0.60`) | Aug N | Aug ROI | Aug MaxDD | tail ROI |
|---|---|---|---|---|---|
| C1 | `AND sport_family = soccer` | 3253 | 13.26% | −16.94u | 18.61% |
| C4 | `AND (sport_family = soccer OR lead_time_hours ≥ 24)` | 4117 | 11.53% | −16.41u | 14.90% |
| C2 | `AND lead_time_hours ≥ 24` | 2868 | 10.80% | −14.39u | 13.54% |

Rejected: C0 (ROI ~5%, MaxDD −40/−51u), C5 (adds a slice that goes negative on
the tail, deepest drawdown), C3 (strict subset of C1 — held as a risk-tightened
reference), Contract A (3.5% ROI on its own denominator, half its quartiles
negative, edge is a composition artifact).
