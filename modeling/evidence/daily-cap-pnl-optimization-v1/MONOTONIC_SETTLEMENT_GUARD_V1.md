# MONOTONIC_SETTLEMENT_GUARD_V1 — research_model_ready_rows settlement-regression repair

## Root cause

`scripts/modeling/materialize-research-model-ready.ts`'s `writeNonEmptyDayRows()` upserted
`research_model_ready_rows` on its full economic identity key
(`model_date,population_id,condition_id,selected_token_id,decision_at`) with no invariant
preventing an already-terminal `settlement_label` (`WIN`/`LOSS`) from being overwritten by a
non-terminal incoming label (`OPEN`/`NO_MATCH`/`AMBIGUOUS`/`VOID`) on an explicit
`--start`/`--end`/`--dates` rematerialization. `clone-model-ready-pipeline.ts`'s own documented
invariant — "once accepted, the clone row-set and its label AS-OF remain immutable" — was not
enforced by this second, independently-callable materialization path.

Diagnosed via the artifact/clone data-authority mismatch investigation on 2026-09-22: the
committed `DAILY_CAP_PNL_OPTIMIZATION_2026-08-04_2026-09-20.md` artifact (generated 2026-09-21
17:54 UTC from commit `d1dc4e6`) reports `TENNIS_P50_52 N=1365 / PnL=+478.77u`, while the current
clone (same 68,949-row / 48-model-date source population as the artifact's own header states)
carries only 1014 WIN/LOSS-eligible unique events and 816 `OPEN` rows across 788 unique provider
events — including on old completed dates (e.g. Sep01=105, Sep02=114, Sep07=374 OPEN rows), which
rules out ordinary same-day settlement lag.

## Repair invariant (MONOTONIC_SETTLEMENT_GUARD_V1)

Implemented in `writeNonEmptyDayRows()` (scripts/modeling/materialize-research-model-ready.ts):

- Before upsert, a single date-bounded read of `research_model_ready_rows` for the day being
  materialized, filtered to `settlement_label IN (WIN, LOSS)` — no broad table read.
- For every incoming row: if an existing terminal (WIN/LOSS) row shares its economic identity and
  the incoming row's `labelAsOf` is non-terminal, the existing terminal canonical row is
  substituted back verbatim (regression refused).
- WIN/LOSS -> WIN/LOSS still overwrites freely (other canonical_row content still refreshes).
- OPEN/non-terminal -> WIN/LOSS still promotes freely.
- No new terminal-correction mechanism was introduced, per mission scope.

Exported as `applyMonotonicSettlementGuard` for direct unit coverage.

## Tests

`tests/modeling/monotonic-settlement-guard.test.ts` (9 focused cases, <1s): OPEN->WIN allowed,
OPEN->LOSS allowed, WIN->OPEN refused, LOSS->OPEN refused, LOSS->{NO_MATCH,AMBIGUOUS,VOID}
refused, WIN->WIN stable, LOSS->LOSS stable, unknown-identity pass-through, and one end-to-end
`writeDayRows()` case through the bounded date-scoped existing-row read. All pass.
Pre-existing `tests/modeling/materialize-research-model-ready.test.ts` and
`tests/modeling/materializeZeroDaySourceProof.test.ts` fixtures were extended with a no-op
`select/eq/in` stub on their fake `research_model_ready_rows` table client (no prior rows in
those fixtures) so the new pre-upsert read does not break existing coverage; all 25 tests across
the three files pass.

## Rows repaired / reproduction status — NOT EXECUTED

Part 3 (Gamma-authoritative repair of the 816 stale historical OPEN rows), Part 4 (per-day
before/after counts), and Part 5 (rerunning `daily-cap-pnl-optimization.ts` to check whether
`TENNIS_P50_52 N=1365/PnL=+478.77u` is reproduced) were **not executed in this session**: the
research-clone credentials this repair requires (`SUPABASE_CLONE_URL` /
`SUPABASE_CLONE_SERVICE_ROLE_KEY`, read by `resolveDb()`/`resolveCloneClient()`) are not present
in this shell's environment (confirmed via `MISSING_CLONE_CREDENTIALS` runtime error on a direct
run attempt). No repair rows were written, no Gamma calls were made, and the old artifact's
`TENNIS_P50_52` authority is therefore **neither confirmed restored nor superseded** — it remains
exactly as committed, unmodified.

## Status

Code fix + regression guard: **landed**.
Historical OPEN-row repair + reproduction check: **blocked on missing research-clone credentials
in this execution environment** — requires re-running with `SUPABASE_CLONE_URL` /
`SUPABASE_CLONE_SERVICE_ROLE_KEY` set, then:
`npx tsx scripts/modeling/materialize-research-model-ready.ts --start 2026-08-04 --end 2026-09-20`
followed by `npx tsx scripts/modeling/daily-cap-pnl-optimization.ts --start=2026-08-04 --end=2026-09-20`.
