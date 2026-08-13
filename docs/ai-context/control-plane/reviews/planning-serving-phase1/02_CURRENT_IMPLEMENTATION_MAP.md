# 02 — Current Implementation Map

All line ranges verified against `origin/main` at `60dbc143e0cb1b075138a4a532488bcd92282bdb` via `git show origin/main:<path>`. This SHA is ahead of `CURRENT_STATE.yaml`'s recorded baseline (`40389884...`) by 5 merged PRs (#155–#159) — see file 06 for that staleness finding.

---

### Serving schema

**FILE**: `supabase/migrations/20260812_current_signal_pair_serving.sql`
**SYMBOL**: `CREATE TABLE public.current_signal_pair_serving`
**LINE RANGE**: 4–24
**INPUT**: n/a (DDL)
**OUTPUT**: table with PK `(condition_id, selected_token_id, metric_formula_version)`, `UNIQUE(source_generated_signal_pair_id)`, FK to `generated_signal_pairs(id)`, `CHECK projection_status IN ('ACTIVE','PENDING')`
**READS_FROM**: n/a
**WRITES_TO**: n/a
**WHY_IT_EXISTS**: bounded operational projection, separate from historical corpus
**HISTORY_SCAN_RISK**: none (schema only)

---

### Checkpoint

**FILE**: `supabase/migrations/20260812_current_signal_pair_serving.sql`
**SYMBOL**: `CREATE TABLE public.current_signal_pair_serving_backfill_checkpoint`
**LINE RANGE**: 29–42
**INPUT**: n/a
**OUTPUT**: single row keyed `checkpoint_name='generated_signal_pairs_v1'`, cursor `(last_source_created_at, last_source_generated_signal_pair_id)`
**READS_FROM**: itself, `FOR UPDATE`, inside `backfill_current_signal_pair_serving`
**WRITES_TO**: itself, after a batch's `refresh` call returns
**WHY_IT_EXISTS**: durable resumable cursor for backfill
**HISTORY_SCAN_RISK**: none (single-row table)

---

### Refresh function (the query under investigation)

**FILE**: `supabase/migrations/20260812_current_signal_pair_serving.sql`
**SYMBOL**: `refresh_current_signal_pair_serving(uuid[])`
**LINE RANGE**: 47–120
**INPUT**: `p_source_generated_signal_pair_ids uuid[] DEFAULT NULL` (NULL = full corpus)
**OUTPUT**: `TABLE(source_generated_signal_pair_id uuid)` — the set of serving rows actually changed
**READS_FROM**: `generated_signal_pairs` (twice: `impacted_keys` CTE, `latest_source` CTE with `DISTINCT ON`), `current_signal_pair_serving` (ON CONFLICT comparison)
**WRITES_TO**: `current_signal_pair_serving` (upsert)
**WHY_IT_EXISTS**: single deterministic reconciler shared by both the writer path and the backfill path
**HISTORY_SCAN_RISK**: **YES, unconditionally.** `impacted_keys` selects `DISTINCT source.condition_id, ...` from `generated_signal_pairs` filtered only by the supplied id array (or nothing, for full-corpus mode) — no bound on how much history that touches. `latest_source` then re-joins the *entire* `generated_signal_pairs` table on those identity keys (not on the supplied ids) and computes `DISTINCT ON (identity) ... ORDER BY ... created_at DESC, id DESC` — i.e., for every identity touched by the input batch, it re-scans **all** historical rows for that identity, not just the input rows. This is true whether called with 1 id (online writer) or 10,000 ids (backfill). See file 03 (Query B/C) and file 06 (contradiction #1/#2) for the consequence.

---

### Backfill function (current, post-repair definition)

**FILE**: `supabase/migrations/20260812_current_signal_pair_serving_backfill_repair.sql`
**SYMBOL**: `backfill_current_signal_pair_serving(integer)` — `CREATE OR REPLACE`, this definition supersedes the same-named function in the base migration file (per `EVIDENCE_LEDGER.md` EV-0020, confirmed by file ordering: `_backfill_repair.sql` is a later, separately-named migration applied after the base file)
**LINE RANGE**: 4–51
**INPUT**: `p_batch_size integer DEFAULT 1000` (validated 1–10000)
**OUTPUT**: `integer` (rows processed in this batch)
**READS_FROM**: `current_signal_pair_serving_backfill_checkpoint` (`FOR UPDATE`), `generated_signal_pairs` (batch selection, cursor-bounded, `LIMIT p_batch_size`)
**WRITES_TO**: calls `refresh_current_signal_pair_serving(source_ids)`; updates the checkpoint row
**WHY_IT_EXISTS**: deterministic, resumable, idempotent one-time/ongoing population of the serving table from history
**HISTORY_SCAN_RISK**: the batch-selection query itself is cursor-bounded and `LIMIT`-ed (cheap by design — this is the query independently reported successful at 142–845ms). The risk is entirely inside the `refresh_current_signal_pair_serving` call it makes (see above).

---

### RLS / grants

**FILE**: `supabase/migrations/20260812_current_signal_pair_serving_security.sql`
**LINE RANGE**: 1–13
**WHY_IT_EXISTS**: `service_role`-only access; no `anon`/`authenticated` grants on either table or either function.
**HISTORY_SCAN_RISK**: n/a

---

### Writer-side projection call (TypeScript wrapper)

**FILE**: `lib/feed/currentSignalPairServing.ts`
**SYMBOL**: `refreshCurrentSignalPairServing(sourceGeneratedSignalPairIds)`
**LINE RANGE**: 18–25
**INPUT**: `readonly string[]` (source UUIDs just inserted)
**OUTPUT**: `Promise<void>`; throws `ServingProjectionPendingError` on RPC failure
**READS_FROM**: nothing directly — calls RPC `refresh_current_signal_pair_serving`
**WRITES_TO**: `current_signal_pair_serving` (via RPC)
**WHY_IT_EXISTS**: fail-closed, explicit, recoverable projection step run in the same logical producer operation as the historical insert
**HISTORY_SCAN_RISK**: inherits the RPC's risk above — **and this is the call site proving the online writer path always uses the historical-traversal shape, never a cheaper direct compare.**

**SYMBOL**: `insertedSourceIds(data, expectedCount)` / `projectInsertedRows(data, expectedCount)`
**LINE RANGE**: 27–43
**WHY_IT_EXISTS**: extracts returned insert IDs and forwards to `refreshCurrentSignalPairServing`; throws if the writer's `.select()` didn't return all expected IDs (production requires `.select()`; the guard exists for older test doubles).

---

### Writer projection call sites (producer side)

**FILE**: `lib/feed/cacheGeneratedSignals.ts`
| Symbol | Insert line | `projectInsertedRows` call line |
|---|---|---|
| `writeGeneratedSignalPairs()` | ~215 (`insertQuery`) | 233 |
| `writeStrategicShadowPairs()` | ~567 (chunked insert loop) | 581 (inside the per-chunk loop — one RPC call per chunk, chunk size `SHADOW_INSERT_CHUNK`) |
| `writeFireModel1_1ResearchPairs()` | ~634 (`insertQuery`) | 642 |

**READS_FROM**: n/a (write path)
**WRITES_TO**: `generated_signal_pairs` (insert), then `current_signal_pair_serving` (via RPC)
**WHY_IT_EXISTS**: these are the three canonical materialization writers the design doc refers to as "every canonical materialization writer inserts history first, then projects that returned source row"
**HISTORY_SCAN_RISK**: each call triggers one (or, for shadow writes, one per chunk) `refresh_current_signal_pair_serving` RPC — i.e. one historical-traversal query per write/chunk, in the hot generation/materialization path, not just in bulk backfill.

---

### Contract A Planning serving read (scored + shadow)

**FILE**: `lib/executor/buildFireModelCandidates.ts`
**SYMBOL**: `fetchContractAPlanningServingRowSets(snapshotAsOfIso, includePlanningShadowRows)`
**LINE RANGE**: 1607–1652
**INPUT**: as-of timestamp, whether to include the shadow subset
**OUTPUT**: `{ scoredRows, planningShadowRows }`, each normalized via `normalizeServingSourceRow` (line 1599–1604: remaps `source_generated_signal_pair_id`→`id`, `source_created_at`→`created_at` so downstream candidate logic is source-row-shaped)
**READS_FROM**: `current_signal_pair_serving`, filtered `projection_status='ACTIVE'`, bounded `LIMIT PLANNING_SERVING_ROW_LIMIT`, **fails closed** (throws) if the limit is hit rather than silently truncating or paginating further
**WRITES_TO**: nothing
**WHY_IT_EXISTS**: the bounded MISSION_2 replacement for the historical Planning reads
**HISTORY_SCAN_RISK**: **NO** — this is exactly the path the whole migration exists to make history-free.

**SYMBOL**: `loadContractAPlanningSourceRows(nowMs)`
**LINE RANGE**: 1663–1672
**WHY_IT_EXISTS**: Contract A decision boundary; deliberately calls `fetchContractAPlanningServingRowSets(..., false)` — shadow rows excluded because they're score-null and can never become a Contract A Decision; comment explains reading their unbounded historical pages here would delay the real Reservation write for no eligibility benefit.

---

### Legacy / non-serving Planning source read (still historical, still live)

**FILE**: `lib/executor/buildFireModelCandidates.ts`
**SYMBOL**: `fetchPlanningSourceRowSets(planningMode, versions, planningLookbackIso, includePlanningShadowRows)`
**LINE RANGE**: 1500–1594
**READS_FROM**: `generated_signal_pairs` directly, keyset-paginated (`fetchAllPlanningRowsByKeyset`) when `planningMode` is true
**WHY_IT_EXISTS**: serves `selectorMode !== "CONTRACT_A_PLANNING_V1"` — the live non-Planning executor path (`CONTUR3_CURRENT`) and any other planning version not yet migrated
**HISTORY_SCAN_RISK**: **YES, unchanged from before this migration** — this is `GSP-P1`/`GSP-P2` from file 01, still reading the full historical corpus. Confirms the design doc's MISSION_2 scope: only `CONTRACT_A_PLANNING_V1` was migrated; other selector modes were explicitly left on history.

---

### Dispatch point

**FILE**: `lib/executor/buildFireModelCandidates.ts`
**SYMBOL**: `buildFireModelCandidates(limit, scope, planningMode, injectedRows, selectorMode, nowMs)`
**LINE RANGE**: 1674 onward (branch of interest ~1726–1734)
**LOGIC**: `injectedRows !== undefined` → in-memory filter, zero reads. Else if `planningMode && selectorMode === "CONTRACT_A_PLANNING_V1"` → serving path. Else → legacy historical path (`fetchPlanningSourceRowSets`).

---

### Resumable backfill runner (state machine)

**FILE**: `lib/operations/currentServingBackfillRunner.ts`
**SYMBOL**: `runCurrentServingBackfill(options)`
**LINE RANGE**: 65–170
**INPUT**: `ServingBackfillRunnerOptions` (batch size default 25, pace 250ms, transport-fault tolerance knobs, injectable `newPort`/`store`/`sleep`/`now`/`random` for testing)
**OUTPUT**: `ServingBackfillResult` (terminal/paused state, receipt)
**READS_FROM**: `ServingBackfillPort.readCheckpoint()` / `.backfill()`
**WRITES_TO**: `ServingBackfillReceiptStore` (durable JSON receipt file)
**WHY_IT_EXISTS**: sequential-only state machine that never replays an ambiguous call before re-reading the durable cursor — added across PR #156 (runner skeleton), #157 (`fix(ops): bound current-serving runner waits`, watchdog), #158 (`fix(ops): recover serving backfill pool exhaustion`), #159 (`fix(ops): recover auth checkout timeouts`)
**HISTORY_SCAN_RISK**: none directly — it's a transport/orchestration layer around `backfill_current_signal_pair_serving`, which itself calls the risky `refresh_current_signal_pair_serving`.

**SYMBOL**: `classifyBackfillTransportError(error)`
**LINE RANGE**: 49–55
**WHY_IT_EXISTS**: distinguishes `THROTTLE` (429) / `POOL_EXHAUSTED` (ECHECKOUTTIMEOUT) / `AMBIGUOUS` (timeout/connection-reset/etc.) from `POSTGRES` (anything else, e.g. a real `57014`/statement-timeout) — a `POSTGRES`-classified error is explicitly **not** retried (`if (nextKind === "POSTGRES") throw error`), i.e. the runner already treats a genuine SQL-side statement timeout as fatal/non-recoverable, distinct from transport failures.

---

### Production CLI runner

**FILE**: `scripts/current-serving-backfill-runner.ts`
**SYMBOL**: `main()`, `createPort()`, `verifyTerminal()`, `runBoundedQuery()`
**LINE RANGE**: full file, 1–180
**INPUT**: `DATABASE_URL` env (or `--connection-env` override); direct Postgres connection via the `postgres` npm package, explicitly **not** PostgREST/Supabase MCP (comment at lines 3–6)
**OUTPUT**: JSON-lines progress events to stdout, exit code 0/1/2, durable receipt at `var/current-serving-backfill/receipt.json`
**READS_FROM**: `current_signal_pair_serving`, `generated_signal_pairs`, checkpoint table (verification queries in `verifyTerminal`, lines 104–135)
**WRITES_TO**: receipt file only (DB writes happen through the RPCs it calls)
**WHY_IT_EXISTS**: production-only resumable execution surface for the backfill, with a 45s (`QUERY_TIMEOUT_MS`) per-query watchdog and 15s heartbeat, because `postgres.js` has no built-in per-query deadline
**HISTORY_SCAN_RISK**: inherits from the RPCs it calls; the 45s local watchdog is shorter than the observed 120,392ms production statement timeout, meaning **this runner would itself abort/cancel a `refresh_current_signal_pair_serving` call before the database-side statement timeout fires**, entering its ambiguous-recovery path (see file 05 timeline).

---

### Sibling historical writer indexes (unchanged by this migration, for context — see file 04 for full matrix)

`idx_gsp_shadow_dedup` (`supabase/migrations/20260805_generated_signal_pairs_shadow_dedup_index.sql`), `idx_gsp_pending_resolution` (`20260702_generated_signal_pairs_pending_resolution_index.sql`), `idx_gsp_provider_event_context` (`20260811_generated_signal_pairs_provider_event_context_index.sql`) all remain in place and unmodified by the serving-projection work.
