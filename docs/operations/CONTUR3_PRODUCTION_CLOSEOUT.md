> STATUS: Contur3 order-monitoring closeout record. Superseded by any later
> `docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md` update or newer
> `reports/contur3/contur3_production_closeout_*.md` snapshot.

# Contur3 — PREMVP Production Closeout (order-monitoring hardening)

Last updated: 2026-07-08T06:43:39Z

## Release record

- **Main commit:** `eb79f81b2a0beaa0476604ad99486880c7859043`
  (merge commit for PR #59)
- **Patch commit:** `994d9456d98853cd836b61a81b56c9f568e515f3`
- **PR:** https://github.com/POLYPROPICKS/PREMVP/pull/59 —
  "Contur3: close PREMVP order monitoring for batch readiness" (merged)
- **Files released:**
  - `app/api/executor/order-events/route.ts`
  - `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs`
  - `scripts/contur3/lib/__tests__/contur3LiveFunnelMonitor.test.mjs`

## What this patch fixed

Root cause of the live-funnel monitor persistently reporting `orders=0`
after a real, successfully executed order (the manually reconciled
Switzerland/Colombia row): the order-events ingestion route already looked
up the owning `event_execution_queue` row by `idempotency_key`, but never
persisted that queue row's `match_family_key` / `reservation_id` onto the
stored order event — so every new order event was structurally unjoinable
by the monitor regardless of any JSON-nesting issue.

Fixed at the source (route now persists `match_family_key`,
`reservation_id`, `queue_id` from the verified queue row) and hardened the
monitor for legacy/manually-reconciled rows that predate this fix (nested
`candidate_snapshot_json` match-key fallback, up to two levels of
`raw_event_json` nesting, plus an `idempotency_key` → queue row →
reservation fallback for rows with no resolvable match key at all).

Also added explicit accepted/rejected/unconfirmed order classification
(`orders_accepted`, `orders_rejected`, `orders_unconfirmed`,
`orders_with_clob_id`, `orders_with_tx_hash`) so the monitor can
distinguish "an order attempt exists but has no confirmed proof yet" from
"declined" from "confirmed live" — previously only a raw `orders` count
existed with no classification.

## Verification status

### Tests
- `node --test scripts/contur3/lib/__tests__/contur3LiveFunnelMonitor.test.mjs` — **53/53 PASS**
- `node --test scripts/contur3/lib/__tests__/contur3ExecutorQueueProbe.test.mjs` — **8/8 PASS** (regression, unaffected by this patch)

### TypeScript
- `npx tsc --noEmit` — **PASS, 0 errors** (verified with `node_modules` installed this session; earlier bare-`npx` runs before install showed 71 unrelated `@types/node` resolution errors across the whole repo, proven via A/B `git stash` to be pre-existing/environmental, not code defects)

### Build
- `npm run build` — **FAILS only at the page-data-collection stage**, with
  `Error: Missing required environment variable: SUPABASE_URL`, on an
  unrelated route (`/api/entitlement/check` or `/api/checkout/create`
  depending on worker scheduling order — not the routes touched by this
  patch). Next's own TypeScript compile phase inside `next build`
  ("Compiled successfully" / "Finished TypeScript") **passes** both before
  and after this diff. A/B-proven via `git stash` to baseline history: the
  identical env-missing failure occurs with or without this patch. This
  sandbox has no `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` and none were
  requested, generated, or printed to close this gap — per hard-stop rules
  on env/secrets.
- **Full green `npm run build` has not yet been proven in an environment
  with real Supabase env** (e.g. Railway). That is the one build-side gate
  still open.

### Production / Railway verify

- **Railway access from this session:** `RAILWAY_VERIFY_NOT_RUN_NO_ACCESS`
  — no `railway` CLI installed, no Railway env vars present, no `/app`
  container reachable from this sandbox.
- `live-funnel-log.mjs`: not run (see above). Operator command:
  ```
  cd /app
  node scripts/contur3/live-funnel-log.mjs
  ```
- `contur3-executor-queue-probe.mjs`: not run (see above). Operator command:
  ```
  EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs
  ```
- Switzerland/Colombia order visibility: **not determinable from this
  sandbox.** The only tracked funnel log in the repo
  (`reports/contur3/live_funnel_latest.md`) is dated 2026-06-25 (~13 days
  stale) and was itself generated with `STOPPED_DB_ENV_MISSING` (no real
  DB data) — per the CONTUR3 24h log-first rule it does not count as
  evidence. Requires a fresh Railway-side run.

Full detail: `reports/contur3/contur3_fubble_review_20260708T064339Z.md`.

## Safety proof (this session and the PR-merge session)

- **No DB writes performed by any agent action.** All patched code paths
  were inspected/edited/tested locally; no script that writes rows was
  executed against a live database.
- **No production POST calls made.**
- **No live/Ireland execution.** No Ireland monitor start, no live order
  placement.
- **No UI/CSS changes.** Diff is scoped to one API route file and one
  library + its test file.
- **No `railway up` used**, and none attempted.
- **No secrets/env values printed or requested** at any point.

## Current level

- **`LEVEL_1_PENDING_RAILWAY_VERIFY`** ← current state.
  (Not yet `LEVEL_1_PRODUCTION_VERIFIED` — code is merged and locally
  proven correct, but the live-funnel-log / queue-probe / Switzerland-
  Colombia-visibility checks above have not been run against production.)

## Roadmap to Level 2 (semi-automatic scheduled contour)

Level 1 (controlled batch, founder/operator manually runs each script per
`OPERATOR_ACCEPTANCE_CHECKLIST.md`) is the current operating mode. To reach
Level 2 (semi-automatic — scheduled runs with founder approval gates,
still no unattended live execution):

1. Close the Railway verify gate above (this closeout's only remaining P0).
2. Wire `live-funnel-log.mjs` + `preflight24h.mjs` to a scheduled job
   (e.g. Railway cron or GitHub Actions hitting a Railway-side endpoint)
   that regenerates the canonical log automatically ahead of each due
   window, instead of relying on an operator to remember to run it.
3. Add automated alerting (not automated action) when
   `hard_anomaly_count > 0` or `machine_verdict` is any P0-class verdict,
   so the founder is notified without needing to poll the log manually.
4. Keep Ireland start/live-order placement manual and founder-approved at
   this level — Level 2 automates *visibility*, not *execution*.
5. Once Level 2 has run cleanly across several real due windows with no
   missed P0s, that operating history becomes the evidence basis for
   scoping Level 3 (unattended) as a separate, explicitly-approved future
   task — not implied or started by this closeout.

## Remaining gaps before operatorless live

- Railway production verify (P0, this closeout).
- No CI pipeline configured on this repo — all gating is manual protocol
  discipline; a scheduled/semi-automatic system (Level 2) should not be
  built on top of an unverified manual-only gate.
- No dedicated standalone batch-readiness report script (deferred, P1 in
  the fubble review) — Level 2 scheduling would benefit from one canonical
  machine-readable readiness artifact rather than relying on log-parsing.
- Price/liquidity re-check before order placement remains
  `MEASUREMENT_MISSING` in the monitor (pre-existing, unrelated to this
  patch) — flagged here only because it is a prerequisite the team should
  not forget before increasing automation level.

## Exact next owner/action

**Founder/operator**, on Railway `/app`, after confirming deploy reached
commit `eb79f81`:
```
node scripts/contur3/live-funnel-log.mjs
EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs
```
Then update this document's "Current level" to `LEVEL_1_PRODUCTION_VERIFIED`
once both commands run clean and the Switzerland/Colombia order visibility
question is answered one way or the other (visible+accepted, or explicitly
out-of-lookback).

No new Contur3 feature work should start until this Level 1 verification
is closed.
