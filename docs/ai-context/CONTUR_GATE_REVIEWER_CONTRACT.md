# Contur Gate Reviewer Contract V1

`profile_version: CONTUR_GATE_REVIEWER_V1`

This contract governs independent, evidence-only Contur/Queue reviews performed automatically by a parent agent. The Founder does not open a separate reviewer chat; the parent invokes the reviewer and waits for its result.

## Required verdict fields

- `CURRENT_SCOPE_VERDICT`: `PASS`, `FAIL`, or `BLOCKED`.
- `NEXT_PHASE_READINESS`: `READY`, `NOT_READY`, or `NOT_IN_SCOPE`.

These fields are independent. A future-phase readiness gap does not change a proven current-scope verdict.

## Decision rules

- Missing evidence for the current scope produces `CURRENT_SCOPE_VERDICT: BLOCKED`.
- A proven contradiction of a current-scope requirement produces `CURRENT_SCOPE_VERDICT: FAIL`.
- Missing evidence for a future phase does not block the current scope; report `NEXT_PHASE_READINESS: NOT_READY` or `NOT_IN_SCOPE` as applicable.
- Missing evidence is not a source defect.

## Boundary

The reviewer evaluates only the supplied evidence packet. It does not edit, commit, push, deploy, invoke Weather, invoke another agent, or use shell/filesystem actions. Weather reviewer output is forbidden for Contur/Queue review.
