# Review contract

## Invocation payload

Require task classification, parent/head SHAs, branch, allowed/forbidden files, acceptance checks, targeted test commands, and writer evidence. Accept prior blocking findings and generated-artifact allowlist as optional fields.

## Review choice and boundaries

Use a full bounded review for the first milestone review; use a targeted delta review only with a rejected prior head and exact findings. Validate resolving, distinct SHAs, expected branch, an existing delta, clean scope, and a no-edit request before delegation. Treat only the supplied generated artifacts as permitted untracked status.

The `weather_gate_reviewer` agent is read-only: no writes, staging, commits, branch changes, secrets/env access, implementation fixes, push, or deploy. Full review is capped at 25 files/3 tests; delta review at 12 files/2 tests. Return `BUDGET_EXCEEDED` when more is required.

## Result and routing

Return `WEATHER_GATE_AUTOMATED_REVIEW` with review metadata, boundary and delta checks, acceptance/test evidence, findings, risks, runtime proof, verdict, next action, and `TOKEN_USAGE: NOT_MEASURED`. PASS returns the verdict for Founder acceptance. FAIL or STOP returns exact findings and halts; do not auto-fix. If the agent is unavailable, return `WEATHER_REVIEW_AUTOMATION_STOP` with `reason: reviewer_agent_unavailable`.
