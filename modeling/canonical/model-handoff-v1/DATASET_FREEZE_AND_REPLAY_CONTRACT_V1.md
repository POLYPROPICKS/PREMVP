# Dataset Freeze and Replay Contract V1

Corpus — BYTE_FROZEN_SNAPSHOT: 49,400 rows, SHA b2f5dfb5963e036ddb3c2c41a94faff9d7f3eaf08755b9afb9aec7091869be45. Historical export provenance PARTIAL: source generated_signal_pairs; resolved_at IS NOT NULL; known upper rule resolved_at <= exportCutoffResolvedAt; keyset resolved_at,id DESC; no pre-export dedup; downstream identity condition_id+token_id; UTC. Exact invocation, lower boundary, export-start cutoff and DB revision are not proven.

## DECLARED QUERY BOUNDARY
Lower boundary: not declared. Upper value: not recovered.

## OBSERVED VALUE RANGE IN FROZEN BYTES
Observed minima/maxima are inventory facts only and never declared boundaries. T−90 selects latest snapshot at/before event start minus 90 minutes.

Identity set proves 231 memberships via lexicographic serialization. Execution sequence proves immutable ledger array order, including entry/settlement chronology, Minsk cycles, state carry, capacity/exposure, stake and skip reasons. **The lexicographically serialized identity set is not the replay order. Downstream execution must not sort observation IDs lexicographically.**

Verify: npx tsx scripts/modeling/strategies/freeze-canonical-model-handoff.ts --verify
