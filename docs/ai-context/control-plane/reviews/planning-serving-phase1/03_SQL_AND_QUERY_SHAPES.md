# 03 — SQL and Query Shapes

All shapes are copied verbatim (or, for Supabase-JS builder chains, reproduced exactly as chained) from `origin/main` at `60dbc14`. No pseudocode substitutions.

---

## A. Eligible backfill source selector

**Source**: `backfill_current_signal_pair_serving(integer)`, inner `batch` CTE — `supabase/migrations/20260812_current_signal_pair_serving_backfill_repair.sql:24-36`

```sql
SELECT source.id, source.created_at
FROM public.generated_signal_pairs source
WHERE source.condition_id IS NOT NULL
  AND source.selected_token_id IS NOT NULL
  AND source.metric_formula_version IS NOT NULL
  AND source.expires_at > now()
  AND source.signal_result IS NULL
  AND (checkpoint.last_source_created_at IS NULL
    OR (source.created_at, source.id) > (checkpoint.last_source_created_at, checkpoint.last_source_generated_signal_pair_id))
ORDER BY source.created_at ASC, source.id ASC
LIMIT p_batch_size
```

- **PREDICATES**: 3 identity NOT-NULL checks, `expires_at > now()`, `signal_result IS NULL`, cursor row-comparison
- **JOIN_KEYS**: none (single table)
- **ORDER_BY**: `created_at ASC, id ASC`
- **DISTINCT/DISTINCT_ON**: none
- **LIMIT**: `p_batch_size` (1–10,000)
- **EXPECTED_CARDINALITY**: bounded, exactly `p_batch_size` rows or fewer
- **SUPPORTING_INDEX**: `idx_gsp_current_serving_backfill_order` per `CURRENT_STATE.yaml`/`EVIDENCE_LEDGER.md` (externally supplied — no DDL for this index exists in the repository; see file 04)
- **HISTORY_TRAVERSAL_REQUIRED**: CONDITIONAL — cursor-bounded forward scan, not a full historical scan, *if* the supporting index exists and is used. This is the query independently reported successful (57014 count=0, 142–845ms).

---

## B. impacted_keys

**Source**: `refresh_current_signal_pair_serving(uuid[])` — `supabase/migrations/20260812_current_signal_pair_serving.sql:55-61`

```sql
SELECT DISTINCT source.condition_id, source.selected_token_id, source.metric_formula_version
FROM public.generated_signal_pairs source
WHERE (p_source_generated_signal_pair_ids IS NULL OR source.id = ANY(p_source_generated_signal_pair_ids))
  AND source.condition_id IS NOT NULL
  AND source.selected_token_id IS NOT NULL
  AND source.metric_formula_version IS NOT NULL
```

- **PREDICATES**: id-array membership (or unbounded if NULL), 3 identity NOT-NULL checks
- **JOIN_KEYS**: none (single table); this is the query that determines *which identities* the next query must re-scan
- **ORDER_BY**: none
- **DISTINCT**: `DISTINCT` on the 3-column identity tuple
- **LIMIT**: none
- **EXPECTED_CARDINALITY**: ≤ `cardinality(p_source_generated_signal_pair_ids)` distinct identities — small for the online writer path (typically 1), up to 10,000 for backfill
- **SUPPORTING_INDEX**: PK on `id` serves the `= ANY(...)` lookup; no index needed when `p_source_generated_signal_pair_ids IS NULL` (full scan, backfill-full-corpus mode only — not the mode used by the writer or by `backfill_current_signal_pair_serving`, which always supplies explicit ids)
- **HISTORY_TRAVERSAL_REQUIRED**: NO for the id-array case (PK lookup, cheap regardless of table size)

---

## C. latest_source

**Source**: `refresh_current_signal_pair_serving(uuid[])` — `supabase/migrations/20260812_current_signal_pair_serving.sql:62-87`

```sql
SELECT DISTINCT ON (source.condition_id, source.selected_token_id, source.metric_formula_version)
  source.id, source.condition_id, source.selected_token_id, source.metric_formula_version,
  source.selected_outcome, source.diagnostics, source.event_slug, source.market_slug,
  source.entry_price_num, source.signal_confidence_num, source.expires_at,
  source.signal_result, source.created_at
FROM public.generated_signal_pairs source
JOIN impacted_keys key ON key.condition_id = source.condition_id
  AND key.selected_token_id = source.selected_token_id
  AND key.metric_formula_version = source.metric_formula_version
WHERE source.condition_id IS NOT NULL
  AND source.selected_token_id IS NOT NULL
  AND source.metric_formula_version IS NOT NULL
  AND source.expires_at > now()
  AND source.signal_result IS NULL
ORDER BY source.condition_id, source.selected_token_id, source.metric_formula_version,
  source.created_at DESC, source.id DESC
```

- **PREDICATES**: 3 identity NOT-NULL checks, `expires_at > now()`, `signal_result IS NULL`
- **JOIN_KEYS**: `(condition_id, selected_token_id, metric_formula_version)` against `impacted_keys` — **this join is on the identity tuple, not on `id`**, meaning it re-reads every historical row in `generated_signal_pairs` sharing that identity, regardless of how many ids were in the original input array
- **ORDER_BY**: `condition_id, selected_token_id, metric_formula_version, created_at DESC, id DESC` — matches the failure signature reported in the mission's "latest decisive database evidence" exactly
- **DISTINCT/DISTINCT_ON**: `DISTINCT ON` the identity tuple — one winner row per identity
- **LIMIT**: none
- **EXPECTED_CARDINALITY**: unbounded per identity going in (every historical row for that identity that satisfies the WHERE clause); exactly 1 row out per identity
- **SUPPORTING_INDEX**: no index in the current repository leads with the identity tuple *and* trails with `created_at DESC, id DESC` under the `expires_at > now() AND signal_result IS NULL` predicate. `idx_gsp_shadow_dedup` supplies only the identity-tuple prefix (see file 04) with no partial predicate and no trailing sort columns — the reported diagnosis (Codex) is that Postgres uses it for the identity match and then performs an incremental sort per group.
- **HISTORY_TRAVERSAL_REQUIRED**: **YES, unconditionally** — this is the query directly implicated in the 120,392ms production statement timeout. It executes identically whether called for 1 identity (online writer, single insert) or thousands (bulk backfill).

---

## D. serving upsert

**Source**: `refresh_current_signal_pair_serving(uuid[])` — `supabase/migrations/20260812_current_signal_pair_serving.sql:88-119`

```sql
INSERT INTO public.current_signal_pair_serving (...)
SELECT ... FROM latest_source
ON CONFLICT (condition_id, selected_token_id, metric_formula_version) DO UPDATE
  SET ... 
  WHERE (EXCLUDED.source_created_at, EXCLUDED.source_generated_signal_pair_id)
      > (current_signal_pair_serving.source_created_at, current_signal_pair_serving.source_generated_signal_pair_id)
RETURNING current_signal_pair_serving.source_generated_signal_pair_id
```

- **PREDICATES**: monotonic-replacement guard on `ON CONFLICT ... WHERE`
- **JOIN_KEYS**: PK conflict target `(condition_id, selected_token_id, metric_formula_version)`
- **ORDER_BY**: none
- **DISTINCT**: none (input already deduplicated by query C)
- **LIMIT**: none
- **EXPECTED_CARDINALITY**: = row count of `latest_source`
- **SUPPORTING_INDEX**: PK (conflict target)
- **HISTORY_TRAVERSAL_REQUIRED**: NO — this step alone is cheap; it never reads `generated_signal_pairs`. **This is the step that makes query C's historical traversal look unnecessary for the single-row writer case**: the guard here already knows how to reject a stale candidate by comparing against the currently-served row. Query C exists to compute the *candidate* in the first place by re-deriving it from history, even though for a single freshly-inserted row the candidate is already known without a JOIN back to `generated_signal_pairs`. See file 06, contradiction #1/#2.

---

## E. writer-side serving update (TypeScript → RPC boundary)

**Source**: `lib/feed/currentSignalPairServing.ts:18-25`

```typescript
const { error } = await supabaseAdmin.rpc("refresh_current_signal_pair_serving", {
  p_source_generated_signal_pair_ids: ids,
});
```

Where `ids` is the deduplicated array of just-inserted `generated_signal_pairs.id` values from the immediately preceding insert (`insertedSourceIds`, line 27–36). This is a **direct, unconditional invocation of query B+C+D above** — there is no separate, cheaper writer-only code path. Every online insert triggers the exact same historical-traversal query shape as a 10,000-row backfill batch, scoped only by how many *identities* that insert's rows happen to touch (typically 1, or `SHADOW_INSERT_CHUNK` for shadow writes).

- **HISTORY_TRAVERSAL_REQUIRED**: YES (delegates to query C)

---

## F. Contract A scored read (serving)

**Source**: `fetchContractAPlanningServingRowSets` → `buildScoredQuery`, `lib/executor/buildFireModelCandidates.ts:1621-1632`

```typescript
supabaseAdmin
  .from("current_signal_pair_serving")
  .select(SERVING_SIGNAL_SELECT_COLS)
  .eq("projection_status", "ACTIVE")
  .in("metric_formula_version", ALLOWED_VERSIONS)
  .is("signal_result", null)
  .gt("expires_at", snapshotAsOfIso)
  .not("selected_token_id", "is", null)
  .not("condition_id", "is", null)
  .not("entry_price_num", "is", null)
  .gte("signal_confidence_num", 50)
  .order("source_created_at", { ascending: false })
  .order("source_generated_signal_pair_id", { ascending: false })
  .limit(PLANNING_SERVING_ROW_LIMIT)
```

- **PREDICATES**: `projection_status='ACTIVE'`, version allowlist, unresolved, unexpired-as-of-snapshot, identity/price/confidence populated, `signal_confidence_num >= 50`
- **JOIN_KEYS**: none — single-table read against the serving projection
- **ORDER_BY**: `source_created_at DESC, source_generated_signal_pair_id DESC`
- **LIMIT**: `PLANNING_SERVING_ROW_LIMIT`; throws (`fails closed`) if the result hits the cap exactly rather than silently truncating
- **EXPECTED_CARDINALITY**: bounded by the size of `current_signal_pair_serving` (one row per live identity), not by historical corpus size
- **SUPPORTING_INDEX**: none named/confirmed for this exact predicate set on `current_signal_pair_serving`; the table is expected to stay small enough for a sequential scan to be acceptable, but this was **not independently measured** in this review — `UNKNOWN`
- **HISTORY_TRAVERSAL_REQUIRED**: NO

---

## G. Contract A shadow read (serving)

**Source**: `fetchContractAPlanningServingRowSets` → `buildShadowQuery`, `lib/executor/buildFireModelCandidates.ts:1635-1646`

```typescript
supabaseAdmin
  .from("current_signal_pair_serving")
  .select(SERVING_SIGNAL_SELECT_COLS)
  .eq("projection_status", "ACTIVE")
  .eq("metric_formula_version", "shadow-strategic-sports-v1")
  .is("signal_result", null)
  .gt("expires_at", snapshotAsOfIso)
  .not("selected_token_id", "is", null)
  .not("condition_id", "is", null)
  .is("signal_confidence_num", null)
  .order("source_created_at", { ascending: false })
  .order("source_generated_signal_pair_id", { ascending: false })
  .limit(PLANNING_SERVING_ROW_LIMIT)
```

Same shape as F, disjoint predicate (`metric_formula_version = 'shadow-strategic-sports-v1'`, `signal_confidence_num IS NULL` instead of `>= 50`). Same LIMIT/fail-closed behavior. **HISTORY_TRAVERSAL_REQUIRED**: NO.

---

## H. Reachable historical fallback

There is **no in-process fallback** from the serving read (F/G) back to the historical corpus on failure. If `fetchContractAPlanningServingRowSets` throws (RLS denial, connection error, or the `PLANNING_SERVING_ROW_LIMIT` cap), `buildFireModelCandidates` in `CONTRACT_A_PLANNING_V1` mode propagates that error — it does not catch and retry against `fetchPlanningSourceRowSets`. The only "historical fallback" that exists is the **separate, unrelated selector mode** (`selectorMode !== "CONTRACT_A_PLANNING_V1"`), which was never migrated and always reads history (query shape identical to the pre-migration `GSP-P1`/`GSP-P2` queries in the design doc) — this is a parallel code path, not a runtime fallback triggered by a serving-read failure.

- **HISTORY_TRAVERSAL_REQUIRED**: N/A (not a fallback in the failure-recovery sense) / CONDITIONAL if interpreted as "the other selector mode still exists and still does full history traversal."

**UNKNOWN**: whether `SERVING_PROJECTION_PENDING` (writer-side projection failure) has any read-side consequence — i.e. if a row's projection failed and it never made it into `current_signal_pair_serving`, does Contract A Planning simply never see that candidate until a reconciler retries it? The design doc mentions "a bounded reconciler may repair `SERVING_PROJECTION_PENDING` rows," but no such reconciler was found in current source (`grep` for `SERVING_PROJECTION_PENDING` outside `currentSignalPairServing.ts` and its test found no reconciler symbol). This is a real gap worth flagging to the reviewer but is out of scope for the immediate index/refresh-cost decision.
