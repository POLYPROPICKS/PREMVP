# NEW_CONTOUR_7 — Direct serving with bounded bootstrap

## Status and authority

**STATUS = HISTORICAL / CONTEXT CHECKPOINT**
**NOT CANONICAL CURRENT STATE**

`CURRENT_STATE.yaml` and the live Architect Control Plane remain the only operational authority. This checkpoint records the Founder-approved decision and the bounded readiness assessment as of the mission; it cannot create a runtime PASS.

## Founder-approved direction

**Independent-reviewer verdict: `DIRECT_SERVING_WITH_BOUNDED_BOOTSTRAP`.**

The steady-state path is:

`compute -> historical insert where lineage/FK requires it -> exact inserted ids/rows -> current_signal_pair_serving -> Planning -> Reservation -> Rebalance -> Queue`.

`current_signal_pair_serving` is **KEEP_AS_IS** as the bounded operational projection. `generated_signal_pairs` remains lineage, immutable history, archive/training/research corpus, and genuine recovery/resolution source; it is not the steady-state Planning/current-state authority.

Fresh generation cutover alone was rejected: scored rows and shadow/research identities have distinct producer-completeness and dedup semantics, so a single new producer cycle cannot prove carry-forward coverage. There is no historical-to-current eligibility transition. Eligibility is determined from the currently unresolved, unexpired operational universe; `expires_at` supplies the bounded rolling horizon.

One bounded pre-writer-hook seed remains required. It must use the current eligible identity winner, not a time-window approximation: identity `(condition_id, selected_token_id, metric_formula_version)`, winner `(created_at DESC, id DESC)`, and only identities absent or stale in active serving. Full historical cursor exhaustion is not a Phase 1 prerequisite.

No `generation_id`, snapshot, outbox, CDC, async archive, speculative index, runner/watchdog, or broad Phase 2 redesign is authorized now.

## Roadmap checkpoint

Phase 1 — Planning serving closure:

1. `BOUNDED_PRE_HOOK_SEED`
2. `CURRENT_OPERATIONAL_COVERAGE_PROOF`
3. `NATURAL_WRITER_PROJECTION_PROOF`
4. `CONTRACT_A_PLANNING_PROOF`
5. `NATURAL_PLANNING_TO_RESERVATION`
6. `PHASE1_CANONICAL_CLOSE`

Then the PREMVP live contour is Reservation -> Rebalance -> immutable Queue. Ireland execution boundary -> venue -> callback -> settlement/reconciled PnL remains a separate repository mission.

## Lessons and deferrals

- History is not operational authority; historical growth must not increase normal Planning serving cost.
- Bounded current truth, not full-corpus backfill, is the relevant operational scale.
- Cursor exhaustion, 49.7-second runner optimization, runner/watchdog redesign, speculative serving indexes, generation/snapshot redesign, async archive/outbox, and broad Phase 2 audit are deferred recovery or hypothesis work.
- Improve maintenance machinery only after proving it blocks the next business transition. Remove one proven blocker, observe the next boundary, and do not make the Founder an SQL/batch/Git/reviewer/recovery operator.

## Readiness recorded, not accepted

Source proves that `3bdab9fb2c876d3e6956b87c8b100cf3c17d5bf0` introduced the non-NULL, exact-ID path of `refresh_current_signal_pair_serving(uuid[])`; its source commit time is `2026-08-13T14:04:21+03:00`. Deployment time and runtime coverage are not proven here.

The bounded read-only database measurement paused on a transient schema-cache retry error. No seed cardinality, serving coverage, Planning PASS, Reservation PASS, or Phase 1 PASS is claimed. The next R4 mission is limited to bounded current-universe bootstrap -> serving coverage proof -> natural writer proof -> natural Planning -> Reservation -> Phase 1 close, then return immediately to Reservation -> Rebalance -> Queue.

Operator contract: **1 start / 0 intermediate Founder actions / 1 terminal result**.
