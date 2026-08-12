# PREMVP current Signal Pair serving model

Status: implementation-ready design only. No runtime reader, database schema, index, migration, or job behavior is changed by this artifact.

## Authority model

`public.generated_signal_pairs` remains the immutable retained observation corpus. It owns the historical signal snapshot, resolution outcome, diagnostics, attribution, and research/training evidence. It is never pruned or made subject to Planning eligibility rules.

The one proposed operational representation is `public.current_signal_pair_serving`. It is a bounded, replaceable projection of currently executable candidates only. It is not an authority: every serving row points to the single historical row from which it was projected, and its values are a verbatim serving subset plus projection metadata.

`generated_signal_pairs.id` remains the historical lineage key. It is never reused as the serving primary key.

## Independent challenge

### PROVEN_FACTS

- `writeGeneratedSignalPairs()` and `writeStrategicShadowPairs()` append with `INSERT` to `generated_signal_pairs`; they do not upsert the corpus.
- Contract A Planning's scored and shadow reads are broad keyset-paginated reads over this growing corpus. The former reads `signal_confidence_num >= 50`; the latter reads the disjoint unscored `shadow-strategic-sports-v1` population.
- Reservation/Rebalance persists `diagnostics.source_lineage.generated_signal_pair_id` and loads the exact UUID before its sibling selection. The sibling set is constrained by exact provider event identity and `metric_formula_version`.
- Historical exact-source reads and resolution reads have independent index/timeout evidence. The 17:04 Reservation crash is not attributed here; its cause remains unresolved.

### SUPPORTED_INFERENCES

- Moving Planning's two broad current-candidate reads to a bounded projection removes the material production read pressure without altering historical, research, or exact-lineage authority.

### UNVERIFIED_ASSUMPTIONS

- A live production count/retention measurement for the proposed projection does not yet exist.
- The deployed state of the two untracked Aug-12 Planning-index fixes was not used as authority; they are classified below from their named/query contracts only.

### CONTRADICTIONS

- None in the canonical source path. `CURRENT_STATE.yaml` predates the Aug-11/12 accepted contour; this design does not reconcile that separate state artifact.

### FIRST_PROVEN_PROBLEM

Planning has to traverse a growing historical corpus to construct a current execution universe; the shadow path has documented deep-walk/57014 pressure.

### SMALLEST_DEFENSIBLE_APPROACH

Create one current projection, migrate only Contract A Planning first, and retain all exact-lineage and historical readers on the corpus until separately proven safe to move.

### MATERIAL_ALTERNATIVE

Keep adding corpus indexes and push-down predicates. This remains useful during migration but does not bound the operational serving set or separate its lifecycle from historical retention.

### REGRESSION_AND_MAINTENANCE_RISK

A projection can become a competing authority or lose reservation lineage if it silently recomputes values. The contract below prevents both with a source UUID, deterministic replacement, and fail-closed projection status.

Verdict: `PROCEED_WITH_CORRECTION` — replace only current-state Planning reads; do not migrate exact historical lineage/sibling lookups merely because they are on the same spine.

## Access-path classification matrix

| PATH_ID | SOURCE_SYMBOL / CALLER | QUERY_IDENTITY | CLASSIFICATION | HISTORY_NEEDED | FRESHNESS / observed scope | CURRENT_INDEX_DEPENDENCY | Failure evidence |
|---|---|---|---|---|---|---|---|
| GSP-W1 | `writeGeneratedSignalPairs()` / signal generation | append historical observation | WRITE_PATH | YES | every materialization; append-only | none | none attributed |
| GSP-W2 | `writeStrategicShadowPairs()` / structured-sports materialization | `(condition_id, selected_token_id, metric_formula_version)` dedup, then append | WRITE_PATH | YES | current candidate discovery, but output is retained history | `idx_gsp_shadow_dedup` | documented large-corpus timeout before the index |
| GSP-R1 | `buildFireModelCandidates()` non-Planning mode / resolver-scoring callers | current eligibility predicates; newest 150 | CURRENT_STATE_REQUIRED | NO | `expires_at > as_of`; 150-row cap | current generic access path; not a Contract A migration target because L1/L2 are parallel/legacy routes | no canonical-spine timeout claim |
| GSP-P1 | `planning_scored_rows_fetch` / `CONTRACT_A_PLANNING_V1` | allowed formula versions, unresolved, unexpired, populated execution fields, confidence `>=50`, `(created_at,id)` keyset | CURRENT_STATE_REQUIRED | NO | as-of snapshot; all matching pages, source lookback 72h | `idx_gsp_planning_scored_rows` (named current fix) | Planning scored-read 57014 pressure; shadow version exclusion was a push-down correction |
| GSP-P2 | `planning_shadow_rows_fetch` / `CONTRACT_A_PLANNING_V1` | `shadow-strategic-sports-v1`, unresolved, unexpired, populated identity, null confidence, `(created_at,id)` keyset | CURRENT_STATE_REQUIRED | NO | as-of snapshot; all matching pages, source lookback 72h | `idx_gsp_planning_shadow_rows` and game-start push-down (named current fixes) | roughly 100k historical-row deep walk before 57014, with later deterministic rejection |
| GSP-X1 | `loadFinalIdentitySourceRowsByGeneratedSignalPairId()` / persisted Reservation | exact `generated_signal_pairs.id` anchor | EXACT_IDENTITY_LOOKUP | YES | the UUID frozen in Reservation lineage; not replaceable by latest state | PK `id` | prior broad JSONB version timed out; exact PK lookup is the repair |
| GSP-X2 | `loadExactProviderSiblingRowsFromAnchor()` / event-rebalance → Queue | provider-event `v1/polymarket/eventId/eventStartIso` + anchor `metric_formula_version` | EXACT_IDENTITY_LOOKUP | YES | exact reserved-event score-contract domain | `idx_gsp_provider_event_context` | `EXACT_PROVIDER_EVENT_QUERY_FAILED_57014` documented for the earlier JSONB containment scan |
| GSP-H1 | `scripts/resolve-signals.ts` / outcome resolver (not the S3 resolver/scoring label) | unresolved historical rows, ordered for settlement | HISTORY_REQUIRED | YES | expires/resolution lifecycle, including older retained observations | `idx_gsp_pending_resolution` | pending-resolution statement timeout before index |

Totals: 8 paths; HISTORY_REQUIRED 1; CURRENT_STATE_REQUIRED 3; EXACT_IDENTITY_LOOKUP 2; WRITE_PATH 2. `GSP-H1` is recorded to prevent terminology collision with the canonical manifest: it is not the S3 resolver/scoring stage.

## Serving schema and identity contract

```text
TABLE current_signal_pair_serving
PRIMARY KEY (condition_id, selected_token_id, metric_formula_version)
UNIQUE (source_generated_signal_pair_id)
```

The composite primary key is the canonical serving identity: a Polymarket market/outcome is immutable at `condition_id + selected_token_id`, while `metric_formula_version` is deliberately part of the key. Multiple formula versions may coexist for one market/outcome; they must not overwrite or be ranked against each other. Contract A's existing version policy chooses its permitted domain.

Required projection fields (verbatim unless labelled metadata):

- `source_generated_signal_pair_id` UUID — historical lineage; FK/reference to `generated_signal_pairs.id` in implementation.
- `condition_id`, `selected_token_id`, `selected_outcome`, `metric_formula_version`.
- `diagnostics` (including `providerEventContext`, `gameStartIso`, sport/provider metadata), `event_slug`, `market_slug`.
- `entry_price_num`, `signal_confidence_num`, `expires_at`, `signal_result`, `created_at`.
- `served_at`, `source_created_at`, `projection_status`, `projection_error` — projection metadata only.

Do not project execution-owned `stake_usd`, `max_entry_price`, or a synthetic score column. Stake remains the executor constant; `entry_price_num` remains the frozen historical snapshot.

### Freshness, replacement, and expiry

- Eligible means the source row satisfies the exact consumer-specific predicate at projection time. The serving table stores no universal Planning filter.
- A source write projects in the same logical producer operation after the historical insert succeeds. The writer uses an idempotent upsert on the serving primary key.
- Replacement is allowed only when the incoming row has a strictly later `(source_created_at, source_generated_signal_pair_id)` lexicographic tuple. Equal tuples are no-ops. This is deterministic and makes replay/backfill idempotent.
- Projection rows expire when their source `expires_at <= now`, or are marked resolved. Deletion is permitted only from the serving projection after a retention grace period; it never deletes or mutates the historical source row.
- If historical INSERT succeeds and serving upsert fails, the producer records/returns `SERVING_PROJECTION_PENDING` with the source UUID and retries by idempotent backfill. Planning must fail closed for a required current-serving read rather than falling back silently to an unbounded historical scan. Historical ingestion and research remain available.

### Backfill and ongoing update

Backfill reads eligible historical rows in deterministic `(created_at ASC, id ASC)` order, projects each source row with the same upsert rule, and checkpoints the last tuple only after a committed batch. Re-running any batch is safe.

Ongoing maintenance is producer-owned, not a new competing job: every canonical materialization writer inserts history first, then projects that returned source row. A bounded reconciler may repair `SERVING_PROJECTION_PENDING` rows and remove expired projection rows; it may never invent a row without a historical UUID.

## Existing-index disposition

| Current fix | Disposition | Reason |
|---|---|---|
| `idx_gsp_planning_scored_rows` | KEEP_DURING_MIGRATION | protects the source fallback/backfill and remains required until Planning has cut over and verified. |
| `idx_gsp_planning_shadow_rows` | KEEP_DURING_MIGRATION | same; source backfill and rollback safety need it. |
| gameStartIso Planning push-down | KEEP_DURING_MIGRATION | correctness/performance predicate on source readers; no deletion decision before source-read retirement proof. |
| `idx_gsp_pending_resolution` | KEEP_FOR_HISTORY | serves `GSP-H1`, a retained historical resolver. |
| `idx_gsp_shadow_dedup` | KEEP_FOR_HISTORY | serves append-time historical shadow dedup. |
| `idx_gsp_provider_event_context` | KEEP_FOR_HISTORY | serves exact historical reservation/rebalance sibling safety. |

No additional index is proposed in this mission. `LIKELY_REDUNDANT_AFTER_SERVING` is intentionally not asserted for any index: it requires production-reader removal evidence, not design inference.

## Timeout rationale and corpus safety

The Aug-11/12 evidence supports a serving projection for broad current Planning reads: historical retention makes those predicates grow with the corpus, while Planning needs a current execution set. The existing index/push-down work is still justified during migration and for retained historical consumers.

This design deletes zero `generated_signal_pairs` rows, preserves diagnostics and attribution, changes no research/training consumer, and never applies Planning filters to historical/research reads. The 17:04 Reservation crash remains unresolved and must not be attributed to these database access paths.

## Subsequent bounded missions

### MISSION_2 — serving state plus Contract A Planning only

Scope: one migration creating `current_signal_pair_serving`; a deterministic backfill/reconciler; projection calls in `lib/feed/cacheGeneratedSignals.ts`; the Contract A Planning source loader in `lib/executor/buildFireModelCandidates.ts`; targeted Planning/backfill tests.

Acceptance: schema identity and foreign lineage enforced; backfill replay is idempotent; source insert → projection success/failure recovery is tested; scored and shadow Planning return the same source UUID/candidate decisions for a fixture corpus; no non-Planning reader changes; no historical deletion; source fallback is explicit, bounded, and fail-closed.

### MISSION_3 — remaining proven current-state consumers and release

Scope: only `GSP-R1` if its production consumer/reachability is confirmed and its contract is shown to require current state; then update this design, the canonical spine manifest, cross-system contract matrix, and release evidence. Do not migrate `GSP-X1`, `GSP-X2`, or `GSP-H1` without a separate historical-lineage decision.

Acceptance: every migrated consumer is source-proven CURRENT_STATE_REQUIRED; no exact historical lookup regresses; canonical artifacts describe the deployed boundary; targeted tests and release/runtime proof pass; historical/research corpus remains unchanged.

## Unknowns before implementation

1. Whether the already-named `idx_gsp_planning_scored_rows` and `idx_gsp_planning_shadow_rows` migrations are deployed; the clean `origin/main` baseline does not contain the latter untracked root artifact.
2. The exact production retention/grace duration for expired serving rows; this is an operational policy, not discoverable from current source.
3. Whether `GSP-R1` has live traffic. The canonical inventory labels its inbound callers parallel production-reachable but requires proof before migration.
