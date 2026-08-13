# 01 — Original Problem and Target Architecture

## Source

Primary source: `docs/ai-context/control-plane/CURRENT_SIGNAL_PAIR_SERVING_MODEL_DESIGN.md` on `origin/main` (`60dbc14`). This file self-describes as "implementation-ready design only" and predates the implementation that followed (PRs #153–#159). Cross-checked against `CANONICAL_VERTICAL_SPINE_MANIFEST.yaml` and `CURRENT_STATE.yaml` on the same SHA.

## The seven architectural roles

### HISTORICAL CORPUS — `PROVEN_CURRENT`
`public.generated_signal_pairs`. Append-only. Owns the historical signal snapshot, resolution outcome, diagnostics, attribution, research/training evidence. Never pruned. Never subject to Planning eligibility filters. Design doc: "It is never pruned or made subject to Planning eligibility rules."

### OPERATIONAL SERVING STATE — `PROVEN_CURRENT`
`public.current_signal_pair_serving`. A bounded, replaceable projection of currently executable candidates. Design doc: "It is not an authority: every serving row points to the single historical row from which it was projected, and its values are a verbatim serving subset plus projection metadata." Schema confirmed in `supabase/migrations/20260812_current_signal_pair_serving.sql:4-24`.

### SERVING IDENTITY — `PROVEN_CURRENT`
Composite primary key `(condition_id, selected_token_id, metric_formula_version)`, plus `UNIQUE(source_generated_signal_pair_id)`. Design rationale: a market/outcome is immutable at `condition_id + selected_token_id`; `metric_formula_version` is deliberately part of the key because multiple formula versions may coexist and must not overwrite or rank against each other.

### LINEAGE — `PROVEN_CURRENT`
`source_generated_signal_pair_id uuid NOT NULL REFERENCES public.generated_signal_pairs(id)`. `generated_signal_pairs.id` is explicitly stated as never reused as the serving primary key — lineage is preserved through the FK, not through key reuse.

### WRITER MAINTENANCE — `PROVEN_CURRENT`
Design doc: "Ongoing maintenance is producer-owned, not a new competing job: every canonical materialization writer inserts history first, then projects that returned source row." Confirmed in source: `lib/feed/cacheGeneratedSignals.ts` calls `projectInsertedRows()` after every insert into `generated_signal_pairs` from `writeGeneratedSignalPairs()`, `writeStrategicShadowPairs()`, and `writeFireModel1_1ResearchPairs()`. `projectInsertedRows` → `refreshCurrentSignalPairServing()` (`lib/feed/currentSignalPairServing.ts:18-25`) → RPC `refresh_current_signal_pair_serving`.

### BOOTSTRAP/BACKFILL — `PROVEN_CURRENT`
Design doc: "Backfill reads eligible historical rows in deterministic `(created_at ASC, id ASC)` order, projects each source row with the same upsert rule, and checkpoints the last tuple only after a committed batch. Re-running any batch is safe." Confirmed: `backfill_current_signal_pair_serving(integer)` in `20260812_current_signal_pair_serving_backfill_repair.sql` (the function definition current main actually runs — it supersedes the same-named function in the base migration file). Checkpoint table `current_signal_pair_serving_backfill_checkpoint`, single row keyed `generated_signal_pairs_v1`, locked `FOR UPDATE` during backfill.

### PLANNING READ PATH — `PROVEN_CURRENT`
`CONTRACT_A_PLANNING_V1` selector mode in `lib/executor/buildFireModelCandidates.ts` calls `fetchContractAPlanningServingRowSets()`, which reads `current_signal_pair_serving` (not `generated_signal_pairs`) for both the scored and shadow subsets, each capped at `PLANNING_SERVING_ROW_LIMIT` and failing closed if the cap is hit.

## Independent-challenge fields from the design doc (as authored, not re-verified here)

- **PROVEN_FACTS**: writers append (never upsert) to `generated_signal_pairs`; Contract A's scored/shadow reads are broad keyset-paginated historical reads; Reservation/rebalance persists an exact `generated_signal_pair_id` UUID and loads it directly; historical exact-source and resolution reads have independent index/timeout evidence.
- **SUPPORTED_INFERENCES**: moving Planning's two broad current-candidate reads to a bounded projection removes the material production read pressure without altering historical, research, or exact-lineage authority.
- **UNVERIFIED_ASSUMPTIONS** (as of the design doc's writing): no live production count/retention measurement for the projection existed yet; the deployed state of two then-untracked Aug-12 Planning-index fixes was not used as authority.
- **CONTRADICTIONS**: none claimed in the canonical source path at design time; `CURRENT_STATE.yaml` was noted as predating the accepted Aug-11/12 contour.
- **FIRST_PROVEN_PROBLEM**: Planning has to traverse a growing historical corpus to construct a current execution universe; the shadow path had documented deep-walk/`57014` pressure.
- **SMALLEST_DEFENSIBLE_APPROACH** (design-time): create one current projection, migrate only Contract A Planning first, retain all exact-lineage/historical readers on the corpus until separately proven safe to move.
- **MATERIAL_ALTERNATIVE considered and rejected**: keep adding corpus indexes/push-down predicates — "does not bound the operational serving set or separate its lifecycle from historical retention."
- **Verdict**: `PROCEED_WITH_CORRECTION` — replace only current-state Planning reads; do not migrate exact historical lineage/sibling lookups merely because they are on the same spine.

## Access-path classification (as inventoried in the design doc; not independently re-derived line-by-line here — see file 02/03 for current-source verification of the Planning paths specifically)

| PATH_ID | Caller | Classification | History needed | Current index dependency |
|---|---|---|---|---|
| GSP-W1 | `writeGeneratedSignalPairs()` | WRITE_PATH | YES (append) | none |
| GSP-W2 | `writeStrategicShadowPairs()` | WRITE_PATH | YES (append) | `idx_gsp_shadow_dedup` |
| GSP-R1 | `buildFireModelCandidates()` non-Planning mode | CURRENT_STATE_REQUIRED | NO | generic access path; not a migration target (reachability of L1/L2 callers unconfirmed) |
| GSP-P1 | `planning_scored_rows_fetch` (legacy, non-serving) | CURRENT_STATE_REQUIRED | NO | `idx_gsp_planning_scored_rows` (named in design doc; not found as a migration file on current `origin/main` — see file 04) |
| GSP-P2 | `planning_shadow_rows_fetch` (legacy, non-serving) | CURRENT_STATE_REQUIRED | NO | `idx_gsp_planning_shadow_rows` (same caveat) |
| GSP-X1 | `loadFinalIdentitySourceRowsByGeneratedSignalPairId()` | EXACT_IDENTITY_LOOKUP | YES | PK `id` |
| GSP-X2 | `loadExactProviderSiblingRowsFromAnchor()` | EXACT_IDENTITY_LOOKUP | YES | `idx_gsp_provider_event_context` (confirmed migration `20260811_generated_signal_pairs_provider_event_context_index.sql`) |
| GSP-H1 | `scripts/resolve-signals.ts` | HISTORY_REQUIRED | YES | `idx_gsp_pending_resolution` (confirmed migration `20260702_generated_signal_pairs_pending_resolution_index.sql`) |

The design doc explicitly notes `GSP-P1`/`GSP-P2`'s named index migrations were not present as tracked files at design time ("the clean `origin/main` baseline does not contain the latter untracked root artifact"). This review did not find `idx_gsp_planning_scored_rows` or `idx_gsp_planning_shadow_rows` as migration files on current `origin/main` either — see file 04 for the full index inventory and disposition. **UNKNOWN**: whether these were applied directly in production without a committed migration, or whether the design doc's naming was aspirational.

## Existing-index disposition asserted by the design doc (not modified by this review)

| Index | Design-doc disposition |
|---|---|
| `idx_gsp_planning_scored_rows` | KEEP_DURING_MIGRATION |
| `idx_gsp_planning_shadow_rows` | KEEP_DURING_MIGRATION |
| gameStartIso Planning push-down | KEEP_DURING_MIGRATION |
| `idx_gsp_pending_resolution` | KEEP_FOR_HISTORY |
| `idx_gsp_shadow_dedup` | KEEP_FOR_HISTORY |
| `idx_gsp_provider_event_context` | KEEP_FOR_HISTORY |

The design doc explicitly declines to assert `LIKELY_REDUNDANT_AFTER_SERVING` for any index, "it requires production-reader removal evidence, not design inference."

## Bounded-mission sequencing (design-time plan)

- **MISSION_2** (implemented — this is what shipped): one migration creating `current_signal_pair_serving`; deterministic backfill/reconciler; projection calls in `cacheGeneratedSignals.ts`; the Contract A Planning source loader; targeted tests. Explicitly scoped to *only* Contract A Planning.
- **MISSION_3** (not started): migrate `GSP-R1` only if production reachability and current-state requirement are separately proven. Explicitly: "Do not migrate `GSP-X1`, `GSP-X2`, or `GSP-H1` without a separate historical-lineage decision."

## Unknowns the design doc itself flagged before implementation

1. Whether `idx_gsp_planning_scored_rows`/`idx_gsp_planning_shadow_rows` were actually deployed — not resolved by this review either.
2. The exact production retention/grace duration for expired serving rows — an operational policy, not discoverable from source. Still `UNKNOWN`.
3. Whether `GSP-R1` has live production traffic — still `UNKNOWN`; not investigated further in this review since MISSION_3 (its migration) has not started.
