# Blind forward Ledger + Box B join v1 (DBClone-only, NOT applied, NOT committed)

Issue #532. Status: **RELEASE_HOLD**. Gate 1: **FAIL/blocked** (`npm run build` needs `SUPABASE_URL`; unrelated to this SQL-only change). Independent R4 (contur-gate-reviewer, static read, pre-commit): no blocking finding, but **not a valid receipt** (no exact SHA). A valid receipt on the committed SHA is still required before apply.

| Item | Value |
|---|---|
| Target | Research DBClone `nppznoujvnyjargjkmnv` via the project-bound Architect route only |
| Payload | `payload.sql`, sha256 `70691844fd8649be93605a9096bca5ddbbd598355707450035e40409e0984838` |
| Prerequisite | Box B applied (`public.market_outcome_current`, `public.market_outcome_revisions`); payload refuses otherwise or if already applied |
| Writes | new objects only: `blind_forward_decision_ledger`, `blind_forward_ledger_box_b_join_v1`, `blind_forward_scoreboard_v1`, one guard function; touches no existing table, `bet_execution_ledger`, `blind_obs.*` or Production |
| Scratch proof | `run_scratch_test.sh` on Postgres 16 with the real Box B migration: 14 PASS lines + ALL_TESTS_PASSED |

## Contract
- Append-only (UPDATE/DELETE/TRUNCATE rejected for every role incl. owner), `frozen_at` and `record_digest` server-stamped, deterministic `decision_key = sha256(model_hash|observation_id|condition_id|token_id)`, replay via `ON CONFLICT DO NOTHING` changes nothing.
- Hindsight guard (SECURITY DEFINER): a decision on a market with Box B FINAL/VOID/CONFLICT is rejected; the model role never gets Box B access (only a 1-bit refusal).
- ACL: only `blind_model_writer` (if the role exists) gets INSERT; `service_role` gets SELECT on ledger/join/scoreboard only; `anon`, `authenticated`, `PUBLIC`, `blind_model_reader` get nothing. If `blind_model_writer` does not exist nobody can insert (fail-closed) - the Architect must create/bind the real model role.
- Join states (BET rows, exact condition_id + token_id): FINAL_WIN, FINAL_LOSS, PENDING, VOID, CONFLICT, LOOKUP_FAILED, UNKNOWN_FEE_AUTHORITY (+ NOT_FORWARD safety state). Scoreboard `net_roi` is the literal `NOT_PROVEN`; no numeric ROI, no ranking.

## Not proven (first unproven transition)
`blind_obs.model_horizon` (0 rows) and the three protected views are **not defined anywhere in the repo**, and the authoring session had no access to the DBClone (Supabase connector: permission denied for `nppznoujvnyjargjkmnv`). So the edge Observation A -> `model_horizon` -> blind input, and therefore the first real BET/SKIP, are NOT_PROVEN. No decision was fabricated.

## Next steps
1. Architect (with DBClone access): read-only aggregate trace of why `blind_obs` exposes 0 rows (source of A, as-of authority, the fail-closed predicate), then apply this payload via the project-bound route after R4 on the committed SHA and Gate 1 (build env or an SQL-only exception like Box B).
2. Run the frozen model (`FROZEN_MODEL_V2_VERSION = B2_PRICE_FLOOR_030_TIMING_WITHIN_120M`, thresholds score>=65, price>=0.30, start within 24h) on the first fresh eligible blind row as `blind_model_writer`; keep SKIPs honest; reconcile via the join.

## R4 pre-commit findings: handled / open
Fixed in this payload: guard now checks EVER-resolved (any FINAL/VOID/CONFLICT revision) and runs with `row_security = off` (errors instead of failing open); `search_path = pg_catalog, pg_temp`; `outcome_result` only on FINAL_WIN/FINAL_LOSS; `service_role` default grants revoked on views/function; digest canonical (UTC, JSON array); tests now cover NOT_FORWARD, VOID/CONFLICT/FINAL->PENDING guard, service_role join states, column privileges.
Open (non-blocking, documented): (a) append-only holds against DML, not against owner/superuser (`DROP/DISABLE TRIGGER`, `session_replication_role=replica`) and digests are not chained - tamper evidence is a follow-up; (b) the guard refusal is a 1-bit "already resolved" signal - the model must treat it as terminal, never a feature; a replay after resolution raises 23514 instead of no-op; (c) token not validated against the market's token set (a garbage token scores FINAL_LOSS) and "never looked up" reports PENDING - add TOKEN_NOT_IN_MARKET / NOT_COVERED / staleness before any ROI use; (d) joins as `service_role` rely on its `BYPASSRLS` (Box B has RLS and no policies); post-apply canary: as the function owner insert against a known FINAL market and expect 23514; (e) `blind_model_writer` must be created/bound by the Architect and must not be a member of anon/authenticated/service_role/pg_read_all_data.
Latest scratch result (payload sha above): 14 PASS lines + ALL_TESTS_PASSED.
