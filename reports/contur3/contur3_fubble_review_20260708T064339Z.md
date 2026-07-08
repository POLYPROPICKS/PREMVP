# Contur3 — Fubble Review Record

Generated: 2026-07-08T06:43:39Z (this session, sandbox — no production DB access)
Main HEAD reviewed: `eb79f81b2a0beaa0476604ad99486880c7859043` (merge of PR #59)
Patch commit: `994d9456d98853cd836b61a81b56c9f568e515f3`

## Fubble verdict

**READY_AFTER_P0_FIXES**

The order-monitoring root-cause fix (PR #59) is merged to main and passes all
sandbox-runnable verification (unit tests, `git diff --check`, TypeScript).
It is not yet verified against production Supabase/Railway. Readiness is
conditional on the P0 items below being run and passing on Railway.

## P0 blockers (must clear before calling this fully closed)

1. **Confirm Railway deployed commit `eb79f81`.**
   Status: `RAILWAY_VERIFY_NOT_RUN_NO_ACCESS` — this session has no Railway
   CLI, no Railway env vars, and no `/app` container. Founder/operator must
   confirm the deployed commit matches `eb79f81` (e.g. via Railway dashboard
   or `git.deployment_commit_hash` in a freshly generated live-funnel log).

2. **Run production `live-funnel-log.mjs`.**
   Status: `RAILWAY_VERIFY_NOT_RUN_NO_ACCESS`. Exact command for the operator:
   ```
   cd /app
   node scripts/contur3/live-funnel-log.mjs
   ```
   Must confirm the run does not crash and that the summary now exposes
   `orders_accepted`, `orders_rejected`, `orders_unconfirmed` (new fields
   from this patch) alongside the pre-existing `orders` total.

3. **Run production `contur3-executor-queue-probe.mjs`.**
   Status: `RAILWAY_VERIFY_NOT_RUN_NO_ACCESS`. Exact command:
   ```
   EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs
   ```
   Must confirm HTTP 200 from `/api/executor/queue`, read-only, no live order.

4. **Document Switzerland/Colombia order visibility.**
   Status: **NOT DETERMINABLE FROM THIS SANDBOX.** The only tracked funnel
   log in the repo (`reports/contur3/live_funnel_latest.md`) is dated
   2026-06-25T18:24Z — ~13 days stale relative to today (2026-07-08) and was
   itself generated with `machine_verdict: STOPPED_DB_ENV_MISSING` (no real
   Supabase data, empty skeleton). Per `VERIFICATION_GATES.md` /
   `AGENTS.md §11` (CONTUR3 24H log-first rule), a tracked report older than
   30 minutes during an active window is historical/stale and must not be
   treated as fresh evidence. This sandbox has no `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY`, so a fresh log cannot be generated here.
   **Operator action required:** run item 2 above on Railway, then check the
   Switzerland vs Colombia fixture row's `order_events` /
   `orders_accepted` count. If the row falls outside the log's lookback
   window (default 24h) at run time, mark `LOOKBACK_EXPIRED_NOT_A_MONITOR_FAILURE`
   and re-run with `--lookback-hours` widened to cover the known order
   timestamp instead of treating it as a monitor defect.

## P1 risks (non-blocking, tracked)

- No dedicated batch-readiness report script was added (deferred in the prior
  session as a scope decision — existing `live-funnel-log.mjs` summary fields
  already expose `queue_created`/`queue_actionable`/`orders_accepted` etc.).
  If the team still wants a standalone `expected_max_orders_possible` /
  `already_ordered_by_idempotency` report, that is a separate scoped task.
- `npm run build` cannot be proven green end-to-end from this sandbox (no
  `SUPABASE_URL`); only the TypeScript compile phase inside `next build` has
  been proven clean (0 errors), both via `next build`'s own check and a bare
  `npx tsc --noEmit`.
- No CI checks are configured on this repository (`gh`/GitHub status API
  reports 0 checks on PR #59) — merge safety here relied entirely on local
  test/typecheck verification plus manual diff-scope review, not automated
  CI gating.

## P2 improvements (optional, future)

- Consider wiring a minimal GitHub Actions workflow to run
  `node --test scripts/contur3/lib/__tests__/*.test.mjs` + `tsc --noEmit` on
  PRs touching `scripts/contur3/**` or `app/api/executor/**`, so future
  Contur3 patches get automated gating instead of relying on manual protocol
  discipline every time.
- Consider exposing `orders_with_clob_id` / `orders_with_tx_hash` (added in
  this patch) in the rendered markdown table columns of
  `live-funnel-log.mjs`'s per-fixture section, not just the JSON summary —
  currently only `orders` appears in the markdown table.

## PREMVP status

Order-event ingestion and live-funnel monitor code changes are merged to
main (`eb79f81`). All logic is read-only where required (monitor) and
DB-write-safe where write occurs (order-events POST, gated by
idempotency_key + queue-row validation, pre-existing behavior unchanged).
No source touched outside the previously-scoped 3 files.

## Ireland status

Unaffected by this patch. No Ireland/live commands were run or modified.
`docs/operations/CONTUR3_EXECUTION_RUNBOOK.md` and the Ireland manual
command pack remain the operative references; this review does not change
Ireland's dry/fail-closed-only posture.

## Final GO/NO-GO

**GO for main merge (already done).**
**NO-GO for calling Contur3 fully production-verified** until the four P0
items above are run by someone with Railway access and their results are
appended to this report or a follow-up report.

## Exact remaining gates

1. Railway deploy confirmation for commit `eb79f81`.
2. `node scripts/contur3/live-funnel-log.mjs` on Railway `/app` — no crash,
   new order fields present.
3. `EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs` — HTTP 200, read-only.
4. Explicit Switzerland/Colombia order visibility determination (in-window
   accepted, or explicitly out-of-window/expired — not silently absent).
