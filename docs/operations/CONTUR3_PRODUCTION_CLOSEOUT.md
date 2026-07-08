> STATUS: Contur3 order-monitoring closeout record. Superseded by any later
> `docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md` update or newer
> `reports/contur3/contur3_production_closeout_*.md` snapshot.

# Contur3 — PREMVP Production Closeout (order-monitoring hardening)

Last updated: 2026-07-08T07:12:00Z

## Status

**`CODE_READY / IRELAND_EXTERNAL_EVIDENCE_RECEIVED_NOT_PREMVP_LOCAL / RAILWAY_VERIFY_PENDING / LIVE_NO_GO_UNTIL_RAILWAY_VERIFY_AND_FOUNDER_APPROVAL`**

See "Ireland audit — cross-repo external evidence" below for the Ireland
executor's own reported evidence and why it is not, and is not expected to
be, verifiable directly from PREMVP git.

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

## Ireland audit — cross-repo external evidence

Ireland runs as a **separate local executor repo/environment**, distinct
from PREMVP. Its commit hashes are not expected to resolve inside PREMVP
git history, and a prior verification pass in this document that checked
`git cat-file -t <hash>` against PREMVP and reported "not found" was
checking the wrong repository for that kind of evidence — technically
accurate for PREMVP-local verification, but the wrong bar to hold
cross-repo evidence to. This section corrects that framing.

**Ireland-side evidence, as reported by the Ireland/Codex executor
session** (operator-relayed; this is external evidence PREMVP did not and
cannot directly execute or verify from its own git):

- Ireland executor `git log --oneline -4`:
  ```
  4e11509 Executor: record Ireland cross-repo evidence manifest
  6a3a078 Executor: record Contur3 batch consumer final audit
  900f8fe Executor: add controlled Contur3 batch consumer
  5e8f539 Executor: parse one-shot CLOB order response
  ```
- Reported verdict block (`IRELAND_CROSS_REPO_EVIDENCE_FINAL`):
  - VERDICT: PASS
  - HEAD: `4e11509f5d5c2df4c82a9252aea9251cae809327`
  - BATCH_COMMIT: `900f8fead70025d82ae7afd0c3f9c50a308470af`
  - AUDIT_COMMIT: `6a3a0781deab19c0782f7ee134cb1c382d71aa5e`
  - MANIFEST_PATH (Ireland-repo-local):
    `reports/contur3/ireland_cross_repo_evidence_manifest_20260708T070956Z.md`
  - REPORT_PATH (Ireland-repo-local):
    `reports/contur3/ireland_batch_consumer_final_20260708T064627Z.md`
  - DRY_RUN_JSON (Ireland-repo-local):
    `reports/contur3/ireland_batch_dry_run_latest.json`
  - PY_COMPILE: PASS
  - BATCH_SELF_TEST: PASS
  - DIFF_CHECK: PASS
  - GIT_STATUS: clean
  - COMMIT_HASH: `4e11509f5d5c2df4c82a9252aea9251cae809327`
  - Dry-run batch: PASS — selected 0, attempted 0, no live flags
  - Safety: no live: yes / no orders: yes / no POST: yes / no secrets: yes
  - Cross-repo note (Ireland's own words): "Ireland repo has no remote;
    commits are external evidence for PREMVP and are not expected to
    resolve inside PREMVP git."
  - Ireland's own next action: "Cite manifest path and commit hash in
    PREMVP closeout; do not run live without PREMVP Railway verify +
    founder live approval."

**Minor hash-transcription note:** the operator screenshot shows
`BATCH_COMMIT: 900f8fead70025d82ae7afd0c3f9c50a308470af`, one character
off from the `900f8ead70025d82ae7afd0c3f9c50a308470af` cited in the prior
PREMVP task prompt/handoff report. Recorded verbatim from the screenshot
above; flagging the discrepancy rather than silently picking one, since
neither is independently verifiable from PREMVP.

**What PREMVP can and cannot confirm about this:**
- PREMVP git correctly reports these commit hashes as absent from its own
  history — that is expected and not a discrepancy, since Ireland is a
  separate repo with no shared remote.
- PREMVP has **not independently re-run** `py_compile`, the batch
  self-test, or the dry-run against the Ireland codebase — this section
  records what Ireland self-reported, not an independently reproduced
  result. If independent PREMVP-side reproduction is ever required, it
  would need direct access to the Ireland repo/environment, which this
  session does not have.
- This evidence, even taken at face value, only covers Ireland's
  **dry-run/self-test** posture (selected 0, attempted 0, no live flags).
  It does not by itself establish that a live order is safe to place — that
  still requires the PREMVP Railway verify gate below **and** explicit
  founder live approval, per Ireland's own stated next action.

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
  (Not yet `LEVEL_1_PRODUCTION_VERIFIED` — PREMVP code is merged and
  locally proven correct, but the live-funnel-log / queue-probe /
  Switzerland-Colombia-visibility checks above have not been run against
  production. Ireland has separately self-reported dry-run/self-test
  evidence — see "Ireland audit — cross-repo external evidence" above —
  but that does not substitute for the PREMVP Railway verify gate, and
  live is not authorized on the strength of Ireland's dry-run evidence
  alone.)

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

- Railway production verify for PREMVP (P0, this closeout — the only
  remaining PREMVP-side P0 before controlled live; Ireland-side readiness
  is externally self-reported and out of PREMVP's scope to verify).
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
commit `eb79f81` (or newer main containing it, e.g. `a0f0864`):
```
node scripts/contur3/live-funnel-log.mjs
EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs
```
Confirm the summary exposes `orders_accepted` / `orders_rejected` /
`orders_unconfirmed`. Then update this document's "Current level" to
`LEVEL_1_PRODUCTION_VERIFIED` once both commands run clean and the
Switzerland/Colombia order visibility question is answered one way or the
other (visible+accepted, or explicitly out-of-lookback).

Ireland-side: no PREMVP action required to "resolve" the Ireland evidence
— it is expected to live outside PREMVP git by design. The only remaining
requirement before live is unchanged from Ireland's own stated next
action: PREMVP Railway verify (above) **and** explicit founder live
approval. Do not run live on Ireland's dry-run/self-test evidence alone.

No new Contur3 feature work should start until Level 1 PREMVP verification
is closed. Live execution additionally requires explicit founder approval
on top of that — this document records external evidence, it does not
grant live authorization.
