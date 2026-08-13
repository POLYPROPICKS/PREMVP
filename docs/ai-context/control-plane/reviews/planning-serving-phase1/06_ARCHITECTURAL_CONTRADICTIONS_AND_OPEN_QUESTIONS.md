# 06 — Architectural Contradictions and Open Questions

This file answers the mission's ten investigation questions from verified current source (files 02/03). It does not choose a solution.

---

### Q1. Does online writer maintenance insert a new row and then re-query historical `generated_signal_pairs` to rediscover a winner it may already know?

**PROVEN_CONTRADICTION.**

`writeGeneratedSignalPairs()`, `writeStrategicShadowPairs()`, and `writeFireModel1_1ResearchPairs()` (`lib/feed/cacheGeneratedSignals.ts:233,581,642`) each call `projectInsertedRows(data, count)` immediately after their insert succeeds. That function calls `refreshCurrentSignalPairServing(insertedSourceIds(...))` (`lib/feed/currentSignalPairServing.ts:18-25,40-43`), which invokes the RPC `refresh_current_signal_pair_serving(uuid[])` with **only the ids just inserted**. That RPC is the identical query chain used for bulk backfill (queries B/C/D, file 03) — `impacted_keys` derives the identity tuple from the supplied ids, then `latest_source` re-joins **all** of `generated_signal_pairs` for that identity and re-derives the max `(created_at, id)` row via `DISTINCT ON`. The writer already knows the row it just inserted is the newest possible candidate for that identity (its own `created_at`/`id` are freshly assigned); the RPC re-derives this fact from history anyway, on every single insert.

---

### Q2. Could an incoming candidate instead be compared directly against `current_signal_pair_serving`, preserving exact winner semantics?

**SUPPORTED_INFERENCE**, structurally strong.

Query D's `ON CONFLICT ... WHERE (EXCLUDED.source_created_at, EXCLUDED.source_generated_signal_pair_id) > (current_signal_pair_serving.source_created_at, current_signal_pair_serving.source_generated_signal_pair_id)` already implements exactly this comparison — but only *after* query C has already paid the cost of re-deriving a candidate from history. For the single-row/single-identity writer case, the newly inserted row's own `(created_at, id)` tuple is a valid candidate to compare directly against the existing `current_signal_pair_serving` row for that identity (a single PK lookup), with no join back to `generated_signal_pairs` at all. This would preserve exact winner semantics **for the online writer path** because monotonic `(created_at, id)` ordering within one identity is exactly what the existing `ON CONFLICT` guard already encodes — the historical JOIN in query C adds no additional correctness the guard doesn't already provide for a single fresh row. **Caveat** (why this is SUPPORTED_INFERENCE and not PROVEN): this reasoning assumes at most one competing candidate is being resolved per RPC call and that `created_at`/`id` ordering is trustworthy without re-checking peers. If a batch inserts multiple rows for the *same* identity in one call (verified: `writeStrategicShadowPairs` dedupes within a batch by `(condition_id, selected_token_id)` before insert per its own comment, but `writeGeneratedSignalPairs` was not confirmed to have the same guarantee — **UNKNOWN**), a same-identity intra-batch race would need to be resolved before comparing against the served row, which query C's `DISTINCT ON` handles for free today.

---

### Q3. Why does `refresh_current_signal_pair_serving(uuid[])` map IDs → identities → historical rows → latest winner?

**CORRECTNESS_REQUIREMENT for the multi-id/backfill case; NOT REQUIRED for the single-id/writer case (see Q1/Q2).**

For backfill (`p_source_generated_signal_pair_ids` containing many ids across many identities, or the full-corpus `NULL` mode), the function has no other way to know, for each impacted identity, which of potentially many historical rows is the true current winner — it must look at history because it doesn't know in advance whether the ids it was given are each identity's newest row. This is a real, structural reason the function is written as it is. The design doc calls this "Reconciles either a supplied source batch (writer path) or the complete current corpus (deterministic backfill)" (migration comment, `20260812_current_signal_pair_serving.sql:44-46`) — i.e. the function was **deliberately designed to be one algorithm serving both callers**, not an accident.

---

### Q4. Is that historical traversal required for correctness, recovery/rebuild, bootstrap, or implementation convenience?

Split by caller:

- **Backfill/bootstrap (`p_source_generated_signal_pair_ids` = large id set or `NULL`)**: `CORRECTNESS_REQUIREMENT`. There is no cheaper way to seed the projection from a corpus whose winners aren't yet known.
- **Recovery/reconciliation of `SERVING_PROJECTION_PENDING` rows**: would also be `CORRECTNESS_REQUIREMENT` by the same logic **if a reconciler existed** — but none was found in source (file 03, Query H section). This is itself a gap: pending rows have no proven repair path today.
- **Online writer (single fresh insert, known-newest row)**: `IMPLEMENTATION_CONVENIENCE`. One function, one code path, reused everywhere — a real engineering benefit (see design doc: "not a new competing job") — but it is convenience, not correctness, for this specific caller. See Q1/Q2.

---

### Q5. Does backfill repeatedly recompute winners for the same identities as the historical cursor advances?

**PROVEN_CONTRADICTION**, by construction.

`backfill_current_signal_pair_serving`'s batch-selection query (query A, file 03) is ordered `created_at ASC, id ASC` and advances a single global cursor — it does **not** group or skip by identity. If a given `(condition_id, selected_token_id, metric_formula_version)` identity has, say, 40 historical rows spread across the corpus's `created_at` range (e.g. a market whose signal was regenerated repeatedly as odds moved), each of those 40 rows can land in a *different* backfill batch, and **each time one of them is included in a batch, `refresh_current_signal_pair_serving` re-runs the full `latest_source` `DISTINCT ON` scan for that identity** (query C), even though only the batch's own final `ON CONFLICT` comparison against the already-serving row matters. The function recomputes the identity's true winner from scratch on every batch that happens to touch it, not just once.

---

### Q6. Is bootstrap cost therefore proportional to historical depth or repeated identity history?

**PROVEN_CONTRADICTION**, following directly from Q5.

Bootstrap/backfill total cost is not simply O(distinct identities) or O(total historical rows) — it is closer to O(Σ over touched identities of (occurrences in the backfill's batch stream × that identity's historical row count)), because query C's cost per invocation for one identity scales with that identity's full historical row count, and Q5 shows a single identity can be re-touched by multiple batches. This directly explains item 8 in file 05: a 25-row batch failing where 250- and 1000-row batches earlier succeeded is consistent with the 25-row batch happening to land on one or more high-history-depth identities, not with batch size itself being the driver.

---

### Q7. Could bootstrap be expressed as one bounded/set-based latest-winner projection plus checkpoint/recovery, rather than repeated historical rediscovery?

**SUPPORTED_INFERENCE.**

A single set-based pass — e.g. one `INSERT ... SELECT DISTINCT ON (identity) ... ORDER BY created_at DESC, id DESC` over the *entire eligible corpus once*, chunked only for transaction-size/lock-duration reasons rather than re-deriving each identity's winner independently per chunk — would compute each identity's winner exactly once regardless of how many historical rows or chunks it spans. This is a genuinely different algorithm from "reconcile whatever id-batch you're handed, from scratch, every time," and would resolve Q5/Q6's repeated-recomputation cost. This is offered as a plausible alternative shape, not a recommendation to implement it without further design.

---

### Q8. Does the proposed ordered partial index make the current algorithm asymptotically appropriate, or only reduce the constant factor?

**SUPPORTED_INFERENCE, leaning toward constant-factor only.**

The proposed index (`(condition_id, selected_token_id, metric_formula_version, created_at DESC, id DESC) WHERE signal_result IS NULL AND identity columns non-null`, per the mission brief's Codex hypothesis) would let query C serve each identity's `DISTINCT ON` winner via an index scan instead of a sequential-scan-plus-sort — this removes the incremental-sort cost Codex diagnosed and is a real, meaningful constant-factor (and likely also a big-O-in-practice, since it avoids a sort) improvement **per single-identity lookup**. It does **not** change the fact that Q5/Q6's repeated-recomputation pattern still runs once per batch-touch, nor does it change that the online writer path (Q1) still performs a JOIN-and-derive step for a winner it already knows. The index makes the existing algorithm's *per-call* cost cheap; it does not make the *number of calls performing redundant work* smaller. Whether "cheap enough per call" is sufficient to make the current design production-safe at scale is exactly the judgment call for the reviewer — this review does not have production QPS/identity-cardinality/history-depth-distribution numbers to quantify the residual cost.

---

### Q9. Which operations genuinely require historical lineage?

- `GSP-X1` (`loadFinalIdentitySourceRowsByGeneratedSignalPairId`) — exact PK lookup, Reservation lineage. `CORRECTNESS_REQUIREMENT`.
- `GSP-X2` (`loadExactProviderSiblingRowsFromAnchor`) — exact provider-event sibling set. `CORRECTNESS_REQUIREMENT`.
- `GSP-H1` (`scripts/resolve-signals.ts`) — settlement/resolution over the full unresolved backlog, including old rows. `CORRECTNESS_REQUIREMENT`.
- `GSP-W1`/`GSP-W2` (writers) — append to history by definition. `CORRECTNESS_REQUIREMENT` (they *write* history; this is not in question).
- Backfill/bootstrap of `current_signal_pair_serving` (this whole projection's initial population) — `CORRECTNESS_REQUIREMENT` (see Q4).
- Research/training consumers (not enumerated symbol-by-symbol in this review; design doc states "no research/training consumer" changes) — `CORRECTNESS_REQUIREMENT` by definition, out of scope for this migration.

### Q10. Which operations represent current operational state and should normally avoid history traversal?

- `CONTRACT_A_PLANNING_V1` scored/shadow reads (queries F/G) — **already avoid it**, confirmed.
- The online writer's serving-projection step (Q1/Q2) — **currently does not avoid it**, and per Q2's analysis plausibly could.
- `GSP-R1` (`buildFireModelCandidates()` non-Planning mode) — still reads history directly; MISSION_3 (unimplemented) was explicitly scoped to consider migrating this *only if* production reachability and current-state requirement are separately proven. `UNKNOWN` whether it should move; not this review's call.
- The other, non-`CONTRACT_A_PLANNING_V1` selector modes' Planning reads (`GSP-P1`/`GSP-P2` equivalent, still live via `fetchPlanningSourceRowSets`) — these are structurally the same "current operational state" need Contract A had, still unmigrated. `POTENTIAL_DESIGN_SMELL`: the same problem this whole effort was built to solve for Contract A still exists, unaddressed, for every other selector mode.

---

## Additional findings surfaced during this investigation (not in the mission's original 10 questions, but load-bearing for the decision)

### F1. `CURRENT_STATE.yaml` is stale relative to live `origin/main` by 5 merged, code-changing PRs

`CURRENT_STATE.yaml.main.origin_main_sha` records `40389884c34b943d9d50766f45296fee02913c61`. Live `origin/main` is `60dbc143e0cb1b075138a4a532488bcd92282bdb`, five PRs ahead (#155–#159), which is where the backfill runner, its watchdog, its pool-exhaustion recovery, and the `postgres` dependency were all added. `CURRENT_STATE.yaml`'s own `stale_when` rules allow a "state-only bootstrap advance" to remain FRESH even when behind — but PRs #156–#159 are **not** state-only; they add new operational code (`lib/operations/currentServingBackfillRunner.ts`, `scripts/current-serving-backfill-runner.ts`, a new npm dependency). By the control plane's own `stale_when` criteria (`"any path changed between them falls outside stale_state_behavior.state_bootstrap_allowlist"`), this looks like `STATE_REFRESH_REQUIRED`, not fresh. Classification: `PROVEN_CONTRADICTION` (against the control plane's own staleness policy, mechanically checkable), though whether it materially misleads a reviewer is a judgment call — flagged, not fixed, per mission boundaries.

### F2. The "missing `postgres` package" claim is contradicted by current source

Per file 05 item 10: `postgres@3.4.8` is declared in `package.json` `dependencies` and fully resolved in `package-lock.json` on current `origin/main`, added by PR #156. Two possible explanations, both consistent with the evidence and neither confirmed:
- **STALE_EVIDENCE**: the Codex build check ran against a checkout predating PR #156's merge (09:48).
- **Environment/release-integrity gap, not a repo-declaration defect**: the check ran after 09:48 but in an environment where `npm ci`/`npm install` had not been (re-)run after the dependency was added — i.e. a real operational gotcha (anyone with a pre-existing `node_modules` needs to reinstall), but not evidence the *repository* is broken.

This review did **not** perform a clean `npm ci && npm run build` in an isolated checkout (out of scope per "do not fix it," and a full clean install was judged too expensive for a pure evidence-collection pass) — so **whether a genuinely clean checkout builds successfully end-to-end remains `UNKNOWN`**. What is proven is narrower but still decisive against the claim as literally stated: the dependency **is** declared and locked on current `origin/main`.

### F3. A production-critical index has no committed DDL anywhere (`idx_gsp_current_serving_backfill_order`)

See file 04. Independent of the architecture decision, this is a `POTENTIAL_DESIGN_SMELL` in process: a currently-relied-upon index exists only as an operational/production fact recorded in a control-plane YAML file, not as reproducible, reviewable, rollback-capable source.

### F4. The proposed fix's own migration artifact could not be located

`supabase/migrations/20260813094706_current_signal_pair_serving_latest_active_index.sql`, named exactly in the mission brief as the Codex-proposed migration, does not exist on `origin/main`, in the local `.worktrees/` directory, or anywhere else searched by this review. The reviewer is being asked to evaluate a proposal whose exact DDL this package cannot independently show them. Treat the proposed index's column list and predicate (reproduced in file 04 from the mission brief) as an **unverified claim**, not a corroborated artifact.
