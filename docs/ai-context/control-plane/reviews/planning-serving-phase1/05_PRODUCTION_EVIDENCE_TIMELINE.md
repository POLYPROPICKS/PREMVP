# 05 — Production Evidence Timeline

All items below are **supplied** runtime evidence (per mission brief) unless marked "repo-corroborated" (meaning this review independently confirmed a source-level fact consistent with the claim — not that the runtime event itself was re-executed). Categories are kept strictly separate per mission instructions: a transport failure is never presented as SQL slowness.

Dates are approximate/relative as supplied; where a PR merge timestamp is available from `git log`, it is included for cross-reference (all times UTC+3 per repo commit timestamps, 2026-08-13 unless noted).

---

## 1. DATABASE_QUERY_FAILURE — original eligible-source selector (historical, pre-fix)

- **Category**: DATABASE_QUERY_FAILURE
- **Evidence**: original eligible-source selector timed out (supplied evidence, item 1 of mission brief)
- **Repo-corroborated context**: this predates the current `idx_gsp_current_serving_backfill_order`-supported version of query A (file 03). Not independently re-executed.

## 2. Index recovery — idx_gsp_current_serving_backfill_order

- **Category**: not a database failure; recorded as a completed remediation
- **Evidence**: created/recovered, later runtime-proven `indisvalid=true indisready=true` (supplied; also recorded in `CURRENT_STATE.yaml`/`EVIDENCE_LEDGER.md` EV-0020 as `EXTERNALLY_PROVEN_COMPLETE`)
- **Repo-corroborated context**: **no DDL for this index exists anywhere in the repository** (file 04). The index's existence and validity in production cannot be verified from source — only recorded from the supplied/control-plane claim.

## 3. DATABASE_SUCCESS — eligible selector re-proven

- **Category**: DATABASE_SUCCESS
- **Evidence**: exact eligible selector reported successful 3/3, `57014` count = 0, latency ~142–845ms (supplied)
- **Repo-corroborated context**: matches query A in file 03 exactly (cursor-bounded, `LIMIT`-ed, ordered by `created_at ASC, id ASC`) — this query shape is consistent with sub-second latency if its supporting index is valid.

## 4. DATABASE_SUCCESS — bounded backfill calls

- **Category**: DATABASE_SUCCESS
- **Evidence**: `backfill_current_signal_pair_serving(250)` and `backfill_current_signal_pair_serving(1000)` previously succeeded (supplied)
- **Repo-corroborated context**: each call internally runs query A (cheap, per item 3) then delegates to `refresh_current_signal_pair_serving` (query B+C+D, file 03) for the returned id batch. A successful 250/1000-id call does not by itself prove query C is cheap at all scales — it proves it was cheap for *those specific batches' identity fan-out at that point in the backfill's progress*. Cost of query C is a function of (a) how many distinct identities are in the batch and (b) how much historical depth exists per identity — not of batch size alone. **This is directly relevant to why a later, smaller call (`backfill(25)`) timed out: batch size shrinking does not guarantee identity/history-depth shrinking.**

## 5. DATABASE_SUCCESS (data effect) — table growth / checkpoint advance

- **Category**: DATABASE_SUCCESS (effect of item 4)
- **Evidence**: `current_signal_pair_serving` materially grew, durable checkpoint advanced (supplied)

## 6. TRANSPORT_FAILURE — operational execution failures

- **Category**: TRANSPORT_FAILURE (explicitly, per mission brief instruction not to conflate with SQL slowness)
- **Evidence**: `HTTP 429`, `HTTP 504`, `ECHECKOUTTIMEOUT`/session-pool failures (supplied)
- **Repo-corroborated context**: `classifyBackfillTransportError` (`lib/operations/currentServingBackfillRunner.ts:49-55`) has dedicated, tested classification branches for exactly these three failure modes (`THROTTLE`, `POOL_EXHAUSTED`, `AMBIGUOUS`) and explicitly does **not** treat them as `POSTGRES` (real SQL) failures — confirming the repo's own model agrees these are transport-layer, not query-plan, failures.

## 7. RUNNER_FAILURE / mitigation — repo-owned runner + recovery/watchdog

- **Category**: RUNNER_FAILURE (root cause) → mitigated by new capability, not a query fix
- **Evidence**: a repo-owned runner and recovery/watchdog behavior were implemented (supplied)
- **Repo-corroborated (PR-level, `git log`)**:
  - PR #156 `feat(serving): add resumable backfill runner` (merged 09:48) — `lib/operations/currentServingBackfillRunner.ts`, `scripts/current-serving-backfill-runner.ts` added; `postgres@3.4.8` added to `package.json`/`package-lock.json` in the same PR.
  - PR #157 `fix(ops): bound current-serving runner waits` (merged 11:12) — added the 45s query watchdog / 15s heartbeat (`QUERY_TIMEOUT_MS`, `HEARTBEAT_MS`) to `scripts/current-serving-backfill-runner.ts`.
  - PR #158 `fix(ops): recover serving backfill pool exhaustion` (merged 11:50) — extended `currentServingBackfillRunner.ts`'s recovery loop for `ECHECKOUTTIMEOUT`.
  - PR #159 `fix(ops): recover auth checkout timeouts` (merged 11:57) — one-line adjustment to the same recovery path.
- **Note**: none of PRs #156–#159 touch `refresh_current_signal_pair_serving` or any SQL file — they are entirely transport/orchestration-layer changes, consistent with the "these were network failures, not query failures" classification.

## 8. DATABASE_QUERY_FAILURE — the decisive refresh timeout

- **Category**: DATABASE_QUERY_FAILURE
- **Evidence**: `backfill_current_signal_pair_serving(25) → refresh_current_signal_pair_serving(uuid[])` → statement timeout, ~120,392ms (supplied, "latest decisive database evidence")
- **Repo-corroborated context**: this is a **genuine SQL-side failure distinct from item 6's transport failures** — it names the exact function chain (query A → query B/C/D per file 03) and reports an actual PostgreSQL statement-timeout duration, not a network error. `classifyBackfillTransportError` would classify a `57014`/statement-timeout message as `POSTGRES` (not retried) if it ever reached the TypeScript runner layer — consistent with treating this as a hard stop requiring architectural review rather than a transport retry.
- **Cross-reference to item 4**: a batch of only 25 ids failed where earlier batches of 250 and 1000 succeeded. This is consistent with query C's cost being driven by *historical depth per identity* rather than *batch size* (see item 4's note) — as the backfill cursor advances through the historical corpus in `created_at` order, later batches may land on identities with much longer accumulated history (e.g. frequently-regenerated markets), making a small batch slower than an earlier large one.

## 9. Codex diagnosis — plan-level evidence

- **Category**: not independently re-executed; recorded as a subsequent investigation's findings, per mission instruction to treat as hypothesis
- **Evidence claimed**: live refresh plan read 644 rows across 6 identities and performed an incremental sort; reported latency for a 25-source sample ~640ms; no valid `idx_gsp_current_serving_latest_unresolved` existed after cleanup
- **Repo-corroborated context**: the "incremental sort" mechanism is *plausible* given `idx_gsp_shadow_dedup`'s actual definition (identity-prefix only, no partial predicate, no trailing sort columns — file 04) — this part of the diagnosis is structurally consistent with what's in the repo. The specific 644-row/6-identity/640ms numbers and the proposed index's exact DDL text are **not independently corroborated** — no `EXPLAIN` output, no query log, and no copy of the proposed migration file was available to this review.

## 10. CODE/RELEASE_FAILURE — build/dependency claim (investigated separately per mission instruction)

- **Category**: CODE/RELEASE_FAILURE (claimed) — **contradicted by current source**, see file 06 for full analysis
- **Evidence claimed**: current `origin/main` build fails because `scripts/current-serving-backfill-runner.ts` imports missing package `postgres`
- **Repo-corroborated context**: `postgres@3.4.8` is declared in `package.json` `dependencies` and fully resolved (with integrity hash) in `package-lock.json` on current `origin/main` (`60dbc14`), added by PR #156 (merged 09:48). This directly contradicts the claim as stated against current `origin/main`. See file 06 for the STALE_EVIDENCE vs. environment-issue classification.

## 11. DDL apply attempt (proposed index) — did not complete

- **Category**: not a database query failure or a transport failure in the query sense — an operational/tooling limit
- **Evidence**: production DDL apply for the proposed index did not complete inside ~100s management-gateway limit (supplied)
- **Consequence**: post-index refresh latency and checkpoint advancement remain **UNPROVEN**. Item 9's ~640ms figure, if accurate, describes a *plan read*, not a confirmed post-index production timing.

---

## Chronological summary

1. (historical) original selector times out → `idx_gsp_current_serving_backfill_order` created/recovered, proven valid/ready (undated DDL, no source artifact)
2. selector re-proven 3/3 success, sub-second
3. `backfill(250)`, `backfill(1000)` succeed; serving table grows, checkpoint advances
4. operational transport failures (429/504/ECHECKOUTTIMEOUT) → runner + watchdog + pool/auth recovery built (PRs #156–#159, all Aug 13, 09:48–11:57)
5. `backfill(25)` → `refresh(...)` hits a genuine ~120s statement timeout (a real SQL-cost problem, not transport)
6. Codex diagnosis: incremental sort off `idx_gsp_shadow_dedup`'s identity-only prefix; proposes ordered partial index; DDL apply attempt does not complete within the management-gateway window
7. separately, a "missing `postgres` package" build claim is raised — contradicted by current `origin/main` source (package is declared and locked, added in step 4's PR #156)

This package stops here: it does not attempt to re-run the DDL, re-run the backfill, or otherwise resolve open items 6/7/9 through further local action, per the mission's hard boundaries.
