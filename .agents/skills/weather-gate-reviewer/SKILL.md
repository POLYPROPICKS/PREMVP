---
name: weather-gate-reviewer
description: Run a bounded independent read-only review after committed Weather programming changes or corrections. Use explicit parent/head SHAs, changed-file scope, acceptance checks, targeted tests, and machine-readable PASS/FAIL/STOP. Do not use before reviewable commits exist and do not implement fixes.
---

# Weather Gate Reviewer

Require an invocation payload with `task_classification`, `review_parent_sha`, `review_head_sha`, `branch`, `allowed_files`, `forbidden_files`, `acceptance_checks`, `targeted_test_commands`, and `writer_evidence`. Accept `previous_blocking_findings` and `generated_artifact_allowlist` when supplied. Read [the review contract](references/review-contract.md).

Before delegation, verify both SHAs resolve and differ, the expected branch is active, the delta exists, status contains only explicitly allowed untracked/generated files, and no code-edit request is present. Otherwise return `WEATHER_REVIEW_AUTOMATION_STOP` with a machine-readable `reason` and `next_action`.

Select `FULL_BOUNDED_REVIEW` for the first milestone review. Select `TARGETED_DELTA_REVIEW` only when a previous rejected head and exact prior findings are supplied; inspect only the correction delta and prior findings.

Delegate the review to the existing `weather_gate_reviewer` custom agent with `reviewer_model: Luna`. The delegation must expose direct runtime evidence of the observed model. The delegated agent is read-only: no file creation or edits, staging, commits, branch changes, push/deploy, secrets/env access, or implementation fixes. Do not perform the independent review in the writer context or substitute the writer model. If the agent is unavailable, return:

```text
WEATHER_REVIEW_AUTOMATION_STOP:
reason: reviewer_agent_unavailable
next_action: restore or configure weather_gate_reviewer
```

If Luna routing or its observed runtime model cannot be verified, return:

```text
WEATHER_REVIEW_AUTOMATION_STOP:
reason: reviewer_model_not_verifiable
reviewer_model_requested: Luna
reviewer_model_observed: NOT_VERIFIABLE
reviewer_model_verified: FAIL
next_action: configure Codex delegation metadata that exposes the observed reviewer model
```

Use at most 25 relevant files and 3 targeted test commands for a full review; at most 12 files and 2 commands for a delta review. Do not broadly search the repository, load unrelated Markdown, or repeat unaffected suites. If more evidence is required, return `BUDGET_EXCEEDED` with exact additional files, commands, and reason. Keep the reviewer result under 700 words.

Return this contract exactly, filling every field:

```text
WEATHER_GATE_AUTOMATED_REVIEW:
review_mode:
task_classification:
parent_sha:
head_sha:
branch:
reviewer_model_requested: Luna
reviewer_model_observed:
reviewer_model_verified: PASS/FAIL
delta_exists: PASS/FAIL
allowed_files: PASS/FAIL
commit_boundaries: PASS/FAIL
acceptance_checks:
targeted_tests:
writer_evidence_retained:
blocking_findings:
residual_risks:
runtime_proven: YES/NO
verdict: PASS/FAIL/STOP
next_action:
TOKEN_USAGE: NOT_MEASURED
```

`verdict: PASS` is forbidden unless `reviewer_model_verified: PASS`. On PASS, return the verdict to the Founder without push/deploy. On FAIL or STOP, return exact findings and stop; do not auto-fix or launch another review. Keep token usage `NOT_MEASURED` unless exact runtime counters are available.
