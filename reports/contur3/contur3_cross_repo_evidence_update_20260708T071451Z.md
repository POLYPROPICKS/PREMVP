# Contur3 — Cross-Repo Evidence Update (Ireland)

Generated: 2026-07-08T07:14:51Z
Main HEAD at time of writing: `4e1ab7e1d05c4501ec0c5eccb2ea0ca1998d15e6`

## Purpose

Supersedes the framing in
`reports/contur3/contur3_final_handoff_20260708T065548Z.md` (§"Ireland-side
commits claimed but not found in this repository") and
`docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md`'s prior "Ireland audit —
verification note". Those correctly reported that the Ireland commit
hashes do not resolve in PREMVP git, but that framing implied an
unresolved discrepancy. It is not one: Ireland runs as a **separate local
executor repo** with no shared remote with PREMVP, so its commits are
never expected to resolve here. This report records the corrected status
and the Ireland-side evidence as relayed by the operator/Codex session.

## Status

**`CODE_READY / IRELAND_EXTERNAL_EVIDENCE_RECEIVED_NOT_PREMVP_LOCAL / RAILWAY_VERIFY_PENDING / LIVE_NO_GO_UNTIL_RAILWAY_VERIFY_AND_FOUNDER_APPROVAL`**

## Ireland external evidence (operator-relayed, not independently reproduced by PREMVP)

Ireland executor `git log --oneline -4`:
```
4e11509 Executor: record Ireland cross-repo evidence manifest
6a3a078 Executor: record Contur3 batch consumer final audit
900f8fe Executor: add controlled Contur3 batch consumer
5e8f539 Executor: parse one-shot CLOB order response
```

`IRELAND_CROSS_REPO_EVIDENCE_FINAL` block, as reported:
- VERDICT: PASS
- HEAD: `4e11509f5d5c2df4c82a9252aea9251cae809327`
- BATCH_COMMIT: `900f8fead70025d82ae7afd0c3f9c50a308470af`
- AUDIT_COMMIT: `6a3a0781deab19c0782f7ee134cb1c382d71aa5e`
- MANIFEST_PATH (Ireland-repo-local): `reports/contur3/ireland_cross_repo_evidence_manifest_20260708T070956Z.md`
- REPORT_PATH (Ireland-repo-local): `reports/contur3/ireland_batch_consumer_final_20260708T064627Z.md`
- DRY_RUN_JSON (Ireland-repo-local): `reports/contur3/ireland_batch_dry_run_latest.json`
- PY_COMPILE: PASS
- BATCH_SELF_TEST: PASS
- DIFF_CHECK: PASS
- GIT_STATUS: clean
- COMMIT_HASH: `4e11509f5d5c2df4c82a9252aea9251cae809327`
- Dry-run batch: PASS — selected 0, attempted 0, no live flags
- Safety: no live / no orders / no POST / no secrets — all yes; hard-stop
  preserved; duplicate guard preserved (per prior handoff's framing of the
  same underlying claims)
- Ireland's own cross-repo note: "Ireland repo has no remote; commits are
  external evidence for PREMVP and are not expected to resolve inside
  PREMVP git."
- Ireland's own next action: "Cite manifest path and commit hash in
  PREMVP closeout; do not run live without PREMVP Railway verify + founder
  live approval."

**Hash discrepancy note:** the operator screenshot's `BATCH_COMMIT`
(`900f8fead70025d82ae7afd0c3f9c50a308470af`) differs by one character from
the `900f8ead70025d82ae7afd0c3f9c50a308470af` cited in the earlier task
prompt / prior handoff report. Recorded verbatim from the screenshot;
flagged rather than silently reconciled, since PREMVP has no way to check
either value against the Ireland repo directly.

## What this does and does not establish

**Does establish (as self-reported by Ireland, not independently verified
by PREMVP):** Ireland's controlled batch consumer code exists, compiles
(`py_compile` PASS), passes its own self-test, and its dry-run posture is
inert (0 selected, 0 attempted, no live flags) with safety invariants
(hard-stop, duplicate guard) reportedly intact.

**Does not establish:** that this evidence has been independently
reproduced from PREMVP (it has not — PREMVP has no access to the Ireland
repo/environment in this session), and does not by itself authorize live
execution. Per Ireland's own stated next action, live still requires the
PREMVP Railway verify gate (unchanged, still pending — see
`docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md`) **and** explicit founder
live approval.

## Remaining P0 (unchanged in substance, reframed)

Only the PREMVP-side Railway production verification remains as a P0
blocking controlled live:
1. Confirm Railway deployed commit matches main (`eb79f81` / `a0f0864` /
   `4e1ab7e` or newer).
2. Run `node scripts/contur3/live-funnel-log.mjs` on Railway `/app`.
3. Run `EXECUTOR_BASE_URL="https://polypropicks.com" node scripts/contur3/contur3-executor-queue-probe.mjs`.
4. Determine Switzerland/Colombia order visibility from a fresh production
   log.

Ireland-side "resolve the audit discrepancy" is **no longer listed as a
PREMVP P0** — it was never a real discrepancy, only a scope-of-verification
mismatch (checking cross-repo evidence against the wrong repo's git).

## Can move to another functional area?

**YES, if no live is planned.** Non-live work in other functional areas
may proceed freely. Contur3 live/Ireland execution specifically still
requires the PREMVP Railway verify gate above plus explicit founder
approval — this report does not grant live authorization, and neither
does the Ireland evidence it records.

## Next action

Founder/operator: run the two Railway `/app` commands above and update
`docs/operations/CONTUR3_PRODUCTION_CLOSEOUT.md`'s "Current level" to
`LEVEL_1_PRODUCTION_VERIFIED` once clean. No PREMVP action is needed on
the Ireland side beyond citing this evidence, which is now recorded here
and in the closeout doc.
