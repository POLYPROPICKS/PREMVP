# RANK_SUMMER_MODELS_AND_FREEZE_PROVISIONAL_FINALISTS_V1

Historical MODEL-LAB step. Ranks the already-defined summer models on one trusted
historical basis and freezes provisional finalists for the next mission
(`CURRENT_EXECUTABILITY_AND_FINAL_FREEZE_V1`). No production / Contract A /
Reservation / Rebalance / Queue / Ireland / filter change.

## Files

| file | role |
|---|---|
| `SUMMER_MODEL_FINALIST_FREEZE_V1.json` | **historical freeze** (mission 1) — exact predicates, required decision-time fields, per-model economics on every basis, ranking, 3 provisional finalists (C1/C4/C2), no-tuning contract |
| `SUMMER_MODEL_RANKING_V1.json` / `.md` | full deterministic six-model scorecard (weekly buckets, concentration shares, sport + market-family composition) |
| `PROVISIONAL_LIVE_MODEL_FINAL_FREEZE_V1.json` | **live freeze** (mission 2 — `CURRENT_EXECUTABILITY_AND_FINAL_FREEZE_V1`) — current-capacity funnel for C1/C4/C2, Contract-A vs model rejection split, decision `C1_PROVISIONAL_LIVE_FROZEN` |
| `CURRENT_EXECUTABILITY_PROBE_V1.json` | read-only current-capacity probe output (`scripts/modeling/current-executability-probe.ts`), probe_at 2026-09-04T12:49Z |
| `SHA256.txt` | checksums |

## Current-executability freeze (mission 2)

`npx tsx scripts/modeling/current-executability-probe.ts --scored-lookback-hours 48` — SELECT-only,
no writes. Resolves the current Contract A scored planning predicate from live code
(`v2-lite-growth-safe` + `shadow-firemodel1_1_research_v0`, `signal_confidence_num >= 50`,
`hasStructuredScoredSportAuthority`), scans it by `(created_at,id)` keyset, and runs the
frozen C1/C4/C2 predicates against it plus the true-wide `shadow-strategic-sports-v1`
population and 28 days of `night_event_reservations`.

**Decision: `C1_PROVISIONAL_LIVE_FROZEN`.** C1 supplies ~105 soccer price-band physical
events/day in the scored planning universe (~7x the Contract A 15-slot cap; Contract A
already sources 54.5% soccer), needs only `entry_price` + `sport_family`, and runs through
the existing Contract A → Reservation contour with no change → ~15–30 bets/day. C4 ≡ C1
today (its ≥24h arm has zero supply — the scoring pipeline caps at ~24h lead). C2 has zero
current supply for the same reason. The ≥24h opportunity is real historically but sits
outside the current pipeline; recorded as a post-launch option, not authorized here.

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
