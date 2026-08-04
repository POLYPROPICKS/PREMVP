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
- `NEXT_PHASE_READINESS: READY` only when the next phase is explicitly named and its readiness is fully proven by evidence.
- `NEXT_PHASE_READINESS: NOT_READY` when the next phase is explicitly named and readiness evidence is absent, incomplete, or has not passed its gate.
- `NEXT_PHASE_READINESS: NOT_IN_SCOPE` only when the next phase is not named in the evidence packet or is explicitly excluded from the requested review scope without a readiness request.
- If current scope is proven and Ireland/callback is named as the next phase but readiness evidence is absent, return `CURRENT_SCOPE_VERDICT: PASS` and `NEXT_PHASE_READINESS: NOT_READY`.
- Missing evidence is not a source defect.

## Boundary

The reviewer evaluates only the supplied evidence packet. It does not edit, commit, push, deploy, invoke Weather, invoke another agent, or use shell/filesystem actions. Weather reviewer output is forbidden for Contur/Queue review.
