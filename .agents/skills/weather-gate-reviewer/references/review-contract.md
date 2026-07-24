# Review contract

## Invocation payload

Require task classification, parent/head SHAs, branch, allowed/forbidden files, acceptance checks, targeted test commands, and writer evidence. Accept prior blocking findings and generated-artifact allowlist as optional fields.

## Review choice and boundaries

Use a full bounded review for the first milestone review; use a targeted delta review only with a rejected prior head and exact findings. Validate resolving, distinct SHAs, expected branch, an existing delta, clean scope, and a no-edit request before delegation. Treat only the supplied generated artifacts as permitted untracked status.

The `weather_gate_reviewer` agent is read-only: no writes, staging, commits, branch changes, secrets/env access, implementation fixes, push, or deploy. Full review is capped at 25 files/3 tests; delta review at 12 files/2 tests. Return `BUDGET_EXCEEDED` when more is required.

## Result and routing

The delegated custom agent must be requested with `reviewer_model: Luna`. Its result must record `reviewer_model_requested: Luna`, the direct delegation/runtime value in `reviewer_model_observed`, and `reviewer_model_verified: PASS/FAIL`. A textual request alone is insufficient. If the observed value is unavailable or does not verify Luna, return `WEATHER_REVIEW_AUTOMATION_STOP` with `reason: reviewer_model_not_verifiable`, `reviewer_model_observed: NOT_VERIFIABLE` when applicable, and `reviewer_model_verified: FAIL`. The writer must not review in place or substitute its own model.

Return `WEATHER_GATE_AUTOMATED_REVIEW` with review metadata (including all three model fields), boundary and delta checks, acceptance/test evidence, findings, risks, runtime proof, verdict, next action, and `TOKEN_USAGE: NOT_MEASURED`. `verdict: PASS` is forbidden unless `reviewer_model_verified: PASS`. PASS returns the verdict for Founder acceptance. FAIL or STOP returns exact findings and halts; do not auto-fix. If the agent is unavailable, return `WEATHER_REVIEW_AUTOMATION_STOP` with `reason: reviewer_agent_unavailable`.
