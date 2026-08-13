# 00 — Executive Technical Brief

Read time: ~5 minutes. This is the entry point; details and full source citations are in files 01–08.

## Original problem

`public.generated_signal_pairs` is an append-only, million-row-scale historical corpus (every signal ever generated, retained forever for training/attribution/lineage). Contract A Planning needed to read "what's currently executable" but the only available read path was a broad, keyset-paginated scan of that growing historical table. Production hit PostgreSQL `57014` statement-timeout behavior on this path (documented for the shadow-rows deep walk and, independently, for two other unindexed historical reads — pending-resolution and exact-provider-event sibling lookup).

## Target architecture

Separate historical authority from operational serving:

- `generated_signal_pairs` stays the immutable historical/training/attribution corpus. Never pruned, never subject to Planning eligibility rules.
- `current_signal_pair_serving` is a new bounded, replaceable projection of "currently executable" rows only, one row per `(condition_id, selected_token_id, metric_formula_version)`, pointing back to its source historical row by UUID.
- `CONTRACT_A_PLANNING_V1` reads the bounded projection instead of the historical corpus.
- Everything else (exact-lineage lookups for Reservation/rebalance, historical resolution, research) keeps reading `generated_signal_pairs` directly, unchanged.

This design is documented in [`CURRENT_SIGNAL_PAIR_SERVING_MODEL_DESIGN.md`](../../CURRENT_SIGNAL_PAIR_SERVING_MODEL_DESIGN.md) (status: `implementation-ready design only` at time of writing) and its verdict was `PROCEED_WITH_CORRECTION`.

## What has actually been implemented (current origin/main, `60dbc14`)

- Schema, `refresh_current_signal_pair_serving(uuid[])`, and the original `backfill_current_signal_pair_serving(integer)` (migration `20260812_current_signal_pair_serving.sql`).
- A repair migration that redefines `backfill_current_signal_pair_serving` to only pull currently-eligible source rows and resets the checkpoint (`20260812_current_signal_pair_serving_backfill_repair.sql` — this is the function definition that wins on current main).
- RLS/grants restricting the serving tables/functions to `service_role` (`20260812_current_signal_pair_serving_security.sql`).
- A writer-side hook: every historical insert (`writeGeneratedSignalPairs`, `writeStrategicShadowPairs`, `writeFireModel1_1ResearchPairs` in `lib/feed/cacheGeneratedSignals.ts`) calls `projectInsertedRows()` → `refreshCurrentSignalPairServing()` (`lib/feed/currentSignalPairServing.ts`) → the same `refresh_current_signal_pair_serving` RPC, immediately after the historical insert succeeds.
- `CONTRACT_A_PLANNING_V1`'s scored/shadow reads in `lib/executor/buildFireModelCandidates.ts` now read `current_signal_pair_serving`, not `generated_signal_pairs`. The older direct-historical-read path (`fetchPlanningSourceRowSets`) still exists and still serves the non-Planning selector mode and other planning versions.
- A resumable, transport-fault-tolerant backfill runner (`lib/operations/currentServingBackfillRunner.ts`, CLI at `scripts/current-serving-backfill-runner.ts`) built across PRs #156–#159, using a direct `postgres` client (not PostgREST), with a 45s per-query watchdog and durable-cursor recovery from `429`/`ECHECKOUTTIMEOUT`/connect-timeout failures.

## What has actually been proven

- The eligible-source selector (feeding `backfill_current_signal_pair_serving`) was reported successful 3/3 with `57014` count = 0, latency ~142–845ms — this is *supplied* runtime evidence, not independently re-derived here.
- Bounded backfill calls `backfill_current_signal_pair_serving(250)` and `(1000)` reportedly succeeded and the serving table/checkpoint advanced (supplied evidence).
- An externally-completed index, `idx_gsp_current_serving_backfill_order`, is recorded in `CURRENT_STATE.yaml`/`EVIDENCE_LEDGER.md` as `indisvalid=true indisready=true` — but **no DDL for this index exists anywhere in the current repository** (grep-confirmed zero matches on `origin/main` and in the local `.worktrees/` copy). It is production state without a source artifact.
- `postgres@3.4.8` **is** declared in `package.json` (`dependencies`) and fully resolved in `package-lock.json` on current `origin/main` — added by PR #156 (merged 2026-08-13 09:48). A "missing `postgres` package" build failure is contradicted by current source; see file 06 for the stale-evidence classification.

## What failed

- Transport-layer failures during backfill execution (`HTTP 429`, `HTTP 504`, `ECHECKOUTTIMEOUT`) — these are network/pool failures, not SQL failures, and the runner's recovery logic exists specifically to survive them.
- A direct database call, `backfill_current_signal_pair_serving(25) → refresh_current_signal_pair_serving(uuid[])`, hit a genuine **PostgreSQL statement timeout at ~120,392ms**. This is a real query-plan cost problem inside `refresh_current_signal_pair_serving`, independent of the (already-fixed) eligible-source selector and independent of transport.
- A later investigation (Codex) attributed the refresh cost to `idx_gsp_shadow_dedup` supplying only the identity prefix `(condition_id, selected_token_id, metric_formula_version)` — with no `signal_result IS NULL` predicate and no `created_at DESC, id DESC` trailing columns — forcing an incremental sort, and proposed an additional partial ordered index. That proposed migration's DDL could not be located anywhere on this machine's `origin/main` or worktree copies; it is treated as an unverified claim, not confirmed artifact.
- The proposed index's production DDL apply did not complete (~100s management-gateway limit). Post-index latency and checkpoint advancement remain **unproven**.

## Why we stopped local optimization and requested independent review

`refresh_current_signal_pair_serving(uuid[])` is called from two structurally different places with the same SQL: (1) bulk backfill (up to 10,000 identities per call) and (2) the online writer, on **every single historical insert**, however small. Both invoke the identical `impacted_keys → JOIN generated_signal_pairs → DISTINCT ON (...) ORDER BY created_at DESC, id DESC` historical-traversal shape. Adding an index makes that shape cheaper, but does not answer whether that shape should exist at all for the online writer case, where the newly-inserted row is (barring backfill/replay) already the newest candidate and could plausibly be compared directly against the existing `current_signal_pair_serving` row without touching `generated_signal_pairs` again. That is an architectural question, not an indexing question, and it is exactly the kind of decision this evidence package exists to hand to an independent reviewer rather than resolve by another local patch-and-hope cycle.

## Exact decision now required

Choose one of:

- **(A)** Keep the current design; the index is the only missing piece.
- **(B)** Keep the serving-table architecture but change the query shape (e.g., the writer path should not re-derive a winner from history it already knows).
- **(C)** The serving-maintenance design itself needs correction (bootstrap and steady-state should not share one historical-traversal algorithm).
- **(D)** Something smaller/different.

See [`07_REVIEWER_DECISION_PACKET.md`](07_REVIEWER_DECISION_PACKET.md) for the full comparison and the exact questions the reviewer must answer.
