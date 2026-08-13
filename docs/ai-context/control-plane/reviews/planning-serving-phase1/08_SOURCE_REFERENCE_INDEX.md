# 08 — Source Reference Index

**CURRENT_ORIGIN_MAIN_SHA**: `60dbc143e0cb1b075138a4a532488bcd92282bdb` (resolved via `git fetch origin main && git rev-parse origin/main` at package generation time; this is ahead of `CURRENT_STATE.yaml`'s recorded baseline — see file 06 F1)

## Canonical control-plane docs (as of the above SHA)

- `docs/ai-context/control-plane/ARCHITECT_CONTROL_PLANE.yaml` — policy/authority
- `docs/ai-context/control-plane/CURRENT_STATE.yaml` — operational state (recorded baseline `40389884c34b943d9d50766f45296fee02913c61`, 5 PRs behind live)
- `docs/ai-context/control-plane/CURRENT_SIGNAL_PAIR_SERVING_MODEL_DESIGN.md` — the design document this whole migration implements
- `docs/ai-context/control-plane/CANONICAL_VERTICAL_SPINE_MANIFEST.yaml` — vertical-spine stage inventory, references the design doc at line 10-14
- `docs/ai-context/control-plane/EVIDENCE_LEDGER.md` — history only; entry `EV-0020` (2026-08-13) covers the current-serving authority reconciliation
- `docs/ai-context/control-plane/ARCHITECT_SNAPSHOT.md`

## Application source (all paths relative to repo root, all read from `origin/main`)

- `lib/feed/currentSignalPairServing.ts` (43 lines) — writer-side projection wrapper
- `lib/feed/cacheGeneratedSignals.ts` — three writer call sites (`writeGeneratedSignalPairs` L172, `writeStrategicShadowPairs` L361, `writeFireModel1_1ResearchPairs` L601); `projectInsertedRows` calls at L233, L581, L642
- `lib/executor/buildFireModelCandidates.ts` — `fetchPlanningSourceRowSets` L1500-1594 (legacy historical path); `normalizeServingSourceRow` L1599-1604; `fetchContractAPlanningServingRowSets` L1607-1652 (serving path); `loadContractAPlanningSourceRows` L1663-1672; `buildFireModelCandidates` L1674+
- `lib/operations/currentServingBackfillRunner.ts` — `runCurrentServingBackfill` L65-170; `classifyBackfillTransportError` L49-55
- `scripts/current-serving-backfill-runner.ts` — production CLI (180 lines); imports `postgres` at L9

## Runner source

Same as above (`scripts/current-serving-backfill-runner.ts`); its TypeScript state-machine dependency is `lib/operations/currentServingBackfillRunner.ts`.

## Tests

- `tests/feed/currentSignalPairServing.test.ts` — asserts migration SQL shape (PK, unique, FK, `DISTINCT ON`, ordering, `FOR UPDATE`, no `DELETE`), writer idempotency/pending-error behavior, and an in-memory "old cohort == new cohort" identity-conservation check
- `tests/operations/currentServingBackfillRunner.test.ts` — sequential terminal-zero confirmation, ambiguous-transport reconnect/resume, transport-error classification, pool-exhaustion recovery, extended-pause persistence, production-adapter watchdog assertions

## Migrations (chronological)

- `supabase/migrations/20260702_generated_signal_pairs_pending_resolution_index.sql` — `idx_gsp_pending_resolution`
- `supabase/migrations/20260805_generated_signal_pairs_shadow_dedup_index.sql` — `idx_gsp_shadow_dedup`
- `supabase/migrations/20260811_generated_signal_pairs_provider_event_context_index.sql` — `idx_gsp_provider_event_context`
- `supabase/migrations/20260812_current_signal_pair_serving.sql` — schema, `refresh_current_signal_pair_serving`, original `backfill_current_signal_pair_serving`
- `supabase/migrations/20260812_current_signal_pair_serving_backfill_repair.sql` — current-authoritative `backfill_current_signal_pair_serving` redefinition + checkpoint reset
- `supabase/migrations/20260812_current_signal_pair_serving_security.sql` — RLS/grants

## Historical migration artifact referenced but not found

`supabase/migrations/20260813094706_current_signal_pair_serving_latest_active_index.sql` — named in the mission brief as the Codex-proposed index migration, located "inside a historical investigation worktree." **Not found** on `origin/main`, in the local `.worktrees/current-serving-auth-recovery-released-20260813/` copy, or by filesystem search on this machine for the filename or its numeric prefix. See file 04.

## Relevant merged commits/PRs (`git log --oneline`, `origin/main`)

| PR | Title | Merge commit | Relevance |
|---|---|---|---|
| #153 | `fix(serving): bound backfill to current sources` | `4038988` | backfill function repair; recorded in `CURRENT_STATE.yaml` as the baseline SHA |
| #155 | `docs(control-plane): reconcile current serving authority` | `6e3af42` | records `idx_gsp_current_serving_backfill_order` as externally proven |
| #156 | `feat(serving): add resumable backfill runner` | `792ac4f` | adds runner + `postgres` dependency |
| #157 | `fix(ops): bound current-serving runner waits` | `7959241` | adds 45s watchdog / 15s heartbeat |
| #158 | `fix(ops): recover serving backfill pool exhaustion` | `b096330` | pool-exhaustion recovery |
| #159 | `fix(ops): recover auth checkout timeouts` | `60dbc14` | auth-checkout recovery (current `origin/main` HEAD) |

## Repository/session context

- Local checkout branch at package-generation time: `claude/contract-a-planning-shadow-read-fix` (behind `origin/main`; carries unrelated uncommitted local work on `lib/executor/buildFireModelCandidates.ts` for a different task — not part of this evidence package's authority chain, and left untouched)
- `.worktrees/current-serving-auth-recovery-released-20260813/` exists locally as a historical investigation copy; searched but did not contain the proposed index migration file
