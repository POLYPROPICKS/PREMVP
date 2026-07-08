# Contur3 — Final Handoff Report

Generated: 2026-07-08T06:55:48Z
Main HEAD at time of writing: `a0f0864b7fb43d05815e58cacb8fee378178fe4d`

## Executive summary

The PREMVP-side Contur3 order-monitoring root-cause fix is merged to main,
locally verified (unit tests, typecheck, diff-check), and documented. It is
**not yet verified against production** (no Railway access from any session
in this handoff chain) and one input to this handoff — a claimed Ireland
batch-consumer audit — **could not be confirmed to exist in this
repository** and is recorded as unverified rather than as fact. The team
may move to another functional area for non-live work; live execution
should not proceed until both the Railway verify gate and the Ireland-audit
discrepancy are resolved.

## What was achieved

1. **Root-cause fix for `orders=0` undercounting** (PR #59, merged):
   - `app/api/executor/order-events/route.ts` now persists
     `match_family_key`, `reservation_id`, `queue_id` from the verified
     `event_execution_queue` row onto every new order event, instead of
     relying on the client payload or leaving the field empty.
   - `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs` gained a
     nested-match-key fallback (`candidate_snapshot_json`, one and two
     levels of `raw_event_json` nesting) plus an `idempotency_key` → queue
     row → reservation fallback join, so legacy/manually-reconciled rows
     (including the real Switzerland/Colombia order) can still be joined
     even without the new top-level field.
   - Added accepted/rejected/unconfirmed order classification
     (`orders_accepted`, `orders_rejected`, `orders_unconfirmed`,
     `orders_with_clob_id`, `orders_with_tx_hash`) to both per-fixture
     data and the summary/console markers.
2. **Two closeout/review documents** recording verification state and
   next actions:
   - `docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md`
   - `reports/contur3/contur3_fubble_review_20260708T064339Z.md`
3. **This handoff report**, consolidating the above and flagging the
   Ireland-audit discrepancy found during this closeout pass.

## Commits / branches

- Patch commit: `994d9456d98853cd836b61a81b56c9f568e515f3`
- Merge commit (PR #59 → main): `eb79f81b2a0beaa0476604ad99486880c7859043`
- Prior docs closeout commit: `a0f0864b7fb43d05815e58cacb8fee378178fe4d`
- Feature branch (merged, still present): `claude/contur3-premvp-close-z19das`
- PR: https://github.com/POLYPROPICKS/PREMVP/pull/59 (merged)

**Ireland-side commits claimed but not found in this repository:**
`900f8ead70025d82ae7afd0c3f9c50a308470af`,
`6a3a0781deab19c0782f7ee134cb1c382d71aa5e`. Verified absent via
`git cat-file -t <hash>` (both return "Not a valid object name") and
`git log --all --oneline` (no matching commit on any branch/tag). See
`docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md` → "Ireland audit —
verification note" for full detail.

## Tests

- `node --test scripts/contur3/lib/__tests__/contur3LiveFunnelMonitor.test.mjs` — **53/53 PASS**
- `node --test scripts/contur3/lib/__tests__/contur3ExecutorQueueProbe.test.mjs` — **8/8 PASS** (regression, unaffected)
- `npx tsc --noEmit` — **PASS, 0 errors**
- `git diff --check` — clean at every commit in this chain
- `npm run build` — fails only at page-data-collection due to missing
  `SUPABASE_URL` in every sandbox this work has run in; Next's own
  TypeScript compile phase inside the build passes. A/B-proven pre-existing
  via `git stash` to baseline history (not caused by this patch). No full
  green build has been proven anywhere yet.

**Ireland-claimed tests (`py_compile` PASS, one-shot self-test PASS, batch
self-test PASS, dry-run batch selected=0/attempted=0/no live flags) are
unverified** — no corresponding commit, file, or test artifact was found
in this repository to check them against.

## Real live order proof

One real live order exists and is the original motivating incident for
this entire body of work: the manually reconciled Switzerland/Colombia
Polymarket order (`success=true`, `order_status=matched`, `clob_order_id`
present, `transaction_hashes` present, `submitted_price=0.35`,
`submitted_size=20`, `making_amount=7`, `taking_amount=20`). This is the
row the merged fix's regression test (`I16` in
`contur3LiveFunnelMonitor.test.mjs`) is modeled on. **Its live visibility
in the production funnel log has not yet been re-confirmed** post-fix —
that is exactly the Railway verify gate below. No new live order has been
placed by any session in this chain; no POST was made to production.

## Bugs fixed

1. Order-events route accepted/validated against the queue row via
   `idempotency_key` but never wrote that queue row's `match_family_key` /
   `reservation_id` back onto the stored event — every new order was
   structurally unjoinable by the monitor. **Fixed.**
2. Monitor's join was top-level-`match_family_key`-only with no fallback
   for legacy/nested rows, and had no accepted/rejected/unconfirmed
   distinction (only a raw count). **Fixed** — see nested/idempotency
   fallback + classification above.

## Remaining P0

1. Railway deploy confirmation for commit `eb79f81` (or newer, e.g.
   `a0f0864`).
2. Run `node scripts/contur3/live-funnel-log.mjs` on Railway `/app` —
   confirm no crash, confirm `orders_accepted`/`orders_rejected`/
   `orders_unconfirmed` present in output.
3. Run `EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs` — confirm HTTP 200, read-only.
4. Determine Switzerland/Colombia order visibility from the fresh log
   (accepted+in-window, or explicitly `LOOKBACK_EXPIRED_NOT_A_MONITOR_FAILURE`).
5. **Resolve the Ireland-audit discrepancy** — locate the actual
   commits/report if they exist elsewhere, or redo the audit against this
   repo, before treating Ireland batch-consumer readiness as proven.

## Remaining P1

- No CI configured on this repository — all gating so far has been manual
  protocol discipline (local tests/typecheck/diff-check), not automated.
- No standalone batch-readiness report script (deferred scope decision
  from the original task; existing `live-funnel-log.mjs` summary fields
  cover most of the same visibility).
- Full `npm run build` unproven end-to-end with real Supabase env in any
  session so far.

## Remaining P2

- Consider adding a minimal CI workflow gating `scripts/contur3/**` and
  `app/api/executor/**` changes on test + typecheck.
- Consider surfacing `orders_with_clob_id` / `orders_with_tx_hash` in the
  rendered markdown table of `live-funnel-log.mjs`, not just the JSON
  summary.

## Roadmap

- **Level 1 (controlled batch)** — current target level. Founder/operator
  manually runs each script per `OPERATOR_ACCEPTANCE_CHECKLIST.md`. Status:
  `LEVEL_1_PENDING_RAILWAY_VERIFY` (code-complete, production-unverified).
- **Level 2 (semi-automatic scheduled contour)** — not started. Would wire
  `live-funnel-log.mjs` + `preflight24h.mjs` to a scheduled job with
  automated *alerting* (not automated *action*) on P0 anomalies, while
  keeping Ireland start/live-order placement manual and founder-approved.
  Full roadmap detail in `docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md`.
- **Level 3 (unattended)** — not started, not scoped. Should only be
  scoped as a separate, explicitly-approved future task after Level 2 has
  run cleanly across multiple real due windows.

## Can move to another functional area?

**YES, IF NO LIVE IS PLANNED.**
**NO, IF LIVE IS EXPECTED BEFORE RAILWAY VERIFY** — and additionally, no
live execution should proceed while the Ireland batch-consumer audit
remains unverified in this repository (see above). Non-live work in other
functional areas may proceed; Contur3 live/Ireland activity must wait for
both gates to close.

## Next action

1. Founder/operator: run the two Railway `/app` commands above and update
   `docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md` to
   `LEVEL_1_PRODUCTION_VERIFIED` once clean.
2. Founder: locate or re-run the Ireland batch-consumer audit against a
   verifiable commit in this repository, or confirm it lives in a
   different repo/session so this document can be corrected with a real
   reference.
3. Only after both close: reassess live/Ireland go-live readiness as a
   separate, explicitly-authorized task.
