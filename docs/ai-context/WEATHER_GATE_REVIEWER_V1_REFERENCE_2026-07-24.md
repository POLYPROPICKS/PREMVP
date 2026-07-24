# Weather Gate Reviewer V1 — Reference and Automation Guide

**Project:** PolyProPicks / Weather Model 1
**Current maturity:** `LEVEL 2 — writer-mandated automatic invocation after reviewable Weather commits`
**Reviewer role:** independent, read-only, no auto-fix
**Writer model:** Terra
**Delegated reviewer runtime:** `gpt-5.6-luna`
**Runtime model verification:** PASS

---

## 1. Role

Weather Gate Reviewer is an independent acceptance gate for Weather programming milestones.

It does not:

- write code;
- modify files;
- create commits;
- switch branches;
- push;
- deploy;
- read secrets;
- automatically repair findings.

It does:

- validate Git delta;
- enforce allowlists;
- distinguish full vs delta review;
- inspect targeted source/tests;
- run bounded targeted commands;
- verify evidence and semantics;
- return machine-readable `PASS / FAIL / STOP`.

---

## 2. Current automation maturity

### LEVEL 2 — current

After reviewable Weather commits and writer verification:

1. writer invokes `$weather-gate-reviewer`;
2. Skill validates payload/preflight;
3. Skill delegates to `weather_gate_reviewer`;
4. delegated reviewer runs on Luna;
5. reviewer returns independent verdict;
6. Founder remains final acceptor.

### Explicitly not LEVEL 3

There is no:

- unattended fix;
- automatic recommit;
- automatic push;
- automatic deploy;
- autonomous production authorization.

---

## 3. Current locations

Verified paths from execution evidence:

- `.agents/skills/weather-gate-reviewer/SKILL.md`
- `.agents/skills/weather-gate-reviewer/references/review-contract.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/ai-context/PROMPT__PROTOCOL.md`
- `docs/ai-context/12_AGENT_STARTUP_PROTOCOL.md`
- `docs/ai-context/WEATHER_GATE_REVIEWER_PROMOTION_2026-07-24.md`

### Custom agent configuration

The delegated agent name is:

`weather_gate_reviewer`

The exact repo-tracked configuration path was not included in the available chat evidence. The final runtime did expose:

- requested model: Luna;
- configured model: Luna;
- observed runtime: `gpt-5.6-luna`;
- verification source: direct delegated-agent runtime metadata.

No secret or user-level configuration should be copied into documentation.

---

## 4. Exact current code status

This ChatGPT runtime does not mount the Windows Git worktree, so it cannot independently read the final committed bytes of:

- `SKILL.md`;
- `review-contract.md`;
- custom agent configuration.

Therefore this report does **not** fabricate an “exact current code” block.

### Repo-export requirement

To complete a byte-exact appendix, export:

```cmd
git show HEAD:.agents/skills/weather-gate-reviewer/SKILL.md
git show HEAD:.agents/skills/weather-gate-reviewer/references/review-contract.md
git hash-object .agents/skills/weather-gate-reviewer/SKILL.md
git hash-object .agents/skills/weather-gate-reviewer/references/review-contract.md
```

The mini-export must also identify the tracked custom-agent config path, or state that it is not repo-tracked.

### Functional contract verified from runtime

The committed Skill enforces:

- explicit parent/head SHA;
- branch;
- allowed/forbidden files;
- acceptance checks;
- targeted test commands;
- writer evidence;
- previous findings;
- generated artifact allowlist;
- read-only delegation;
- full/delta routing;
- bounded file/command budget;
- machine-readable verdict;
- Luna hard gate;
- no writer self-review;
- no auto-fix;
- no push/deploy.

---

## 5. Invocation payload

Required fields:

- `task_classification`
- `review_parent_sha`
- `review_head_sha`
- `branch`
- `allowed_files`
- `forbidden_files`
- `acceptance_checks`
- `targeted_test_commands`
- `writer_evidence`

Conditional fields:

- `review_mode`
- `previous_blocking_findings`
- `generated_artifact_allowlist`
- `read_only_context_files`
- `reviewer_model_required`

---

## 6. Full vs delta routing

### FULL_BOUNDED_REVIEW

Use for first review of a milestone.

Expected:

- milestone parent/head;
- complete allowed file surface;
- acceptance contract;
- up to bounded relevant files/commands.

### TARGETED_DELTA_REVIEW

Use after rejection/correction.

Expected:

- exact prior rejected head;
- exact correction head;
- previous blocking findings;
- correction delta only;
- one or two targeted commands.

---

## 7. Terra → Luna execution model

Final proven chain:

```text
Terra writer
  → $weather-gate-reviewer
    → weather_gate_reviewer
      → gpt-5.6-luna
```

Verified evidence:

- top-level model: Terra;
- Skill detected: YES;
- Skill invoked: YES;
- delegated agent: `weather_gate_reviewer`;
- requested model: Luna;
- configured model: Luna;
- observed runtime: `gpt-5.6-luna`;
- source: direct delegated-agent runtime metadata;
- Terra self-review excluded: YES;
- model verification: PASS.

### Hard rule

A configured/requested Luna value is insufficient.

Required output:

```text
reviewer_model_requested: Luna
reviewer_model_observed: gpt-5.6-luna
reviewer_model_verified: PASS
```

Otherwise:

```text
verdict: STOP
blocking_findings:
- reviewer_model_not_verified
```

---

## 8. Read-only guarantees

Reviewer must not:

- edit/create files;
- stage/commit;
- reset/rebase/merge;
- switch branch;
- push/deploy;
- access `.env` or secrets;
- fix findings;
- create a second reviewer.

Post-review `git status --short` is mandatory evidence.

Final observed read-only verdict: `PASS`.

---

## 9. PASS / FAIL / STOP

### PASS

- scope valid;
- evidence sufficient;
- acceptance checks pass;
- model verified;
- no blocking findings.

### FAIL

- implementation/semantics violate acceptance contract;
- exact defects are proven;
- no fix is applied by reviewer.

### STOP

- invalid SHA;
- wrong branch/head;
- unexpected dirty files;
- wrong allowlist;
- reviewer unavailable;
- model not verifiable;
- budget insufficient.

---

## 10. Generated artifact handling

Every invocation must list expected generated files.

Observed Weather examples:

- `reports/weather/inventory/latest.json`
- `reports/weather/inventory/latest.md`
- `reports/weather/gamma-proof/latest.json`
- `reports/weather/gamma-proof/latest.md`

Rule:

- allowlist them;
- do not treat them as unexpected;
- do not stage them unless explicitly approved;
- no broad cleanup.

---

## 11. Token usage

Current state:

- exact input tokens: unavailable;
- exact output tokens: unavailable;
- cached tokens: unavailable;
- average: unavailable;
- canonical value: `NOT_MEASURED`.

No numerical average may be claimed.

### Future telemetry schema

| Field | Purpose |
|---|---|
| `run_id` | unique review |
| `milestone` | WM1-x/domain |
| `mode` | full/delta |
| `reviewer_model_requested` | routing |
| `reviewer_model_observed` | runtime proof |
| `input_tokens` | measured cost |
| `output_tokens` | measured cost |
| `cached_tokens` | optimization |
| `duration_ms` | latency |
| `files_inspected` | scope |
| `commands_run` | execution |
| `verdict` | outcome |

Promotion requires three additional compliant **measured** runs.

---

## 12. Reuse across PolyProPicks

Do not use one generic reviewer for all domains.

Use a shared protocol plus domain-specific Skills/profiles.

### 12.1 Liquidity Model Reviewer

- Scope: capture, pairing, executable entry/exit, history.
- Checks: production-shaped rows, pairing semantics, no fake executable claims.
- Boundary: read-only.
- Model: Luna for bounded review.
- Promotion: three successful runs.

### 12.2 Contur3 Reviewer

- Scope: reservation, queue, Ireland supervisor, freeze constraints.
- Checks: no second runtime, no unauthorized execution path.
- Boundary: read-only; no live orders.
- Founder gate mandatory.

### 12.3 Scoring / model logic reviewer

- Scope: deterministic transformations, cohort semantics, leakage.
- Checks: frozen replay, source-to-result trace, expected behavior.
- TDD required.

### 12.4 API contract reviewer

- Scope: request/response schema, fail-closed validation, rate/size bounds.
- Checks: real envelope evidence, backward compatibility, error taxonomy.

### 12.5 Supabase migration reviewer

- Scope: SQL only.
- Checks: constraints, idempotency, rollback/application evidence.
- Must not apply migration automatically.

### 12.6 Production release reviewer

- Scope: commit range, tests/build, dirty state, remote SHA.
- No automatic deploy.
- Founder approves push/deploy separately.

### 12.7 Compliance-safe UI reviewer

- Scope: visible text, metadata, aria, links, SMS-safe language.
- No backend edits.
- Founder visual Gate 2 remains mandatory.

---

## 13. Automation roadmap

### Stage A — manual independent reviewer

Completed historically.

### Stage B — reusable supervised Skill

Current and proven.

### Stage C — measured mandatory invocation

Next:
- telemetry;
- stable allowlists;
- automatic payload generation from Git;
- SHA validation;
- three compliant runs.

### Stage D — limited unattended review

Only after repeated proof.

Still forbidden:

- automatic implementation;
- automatic push;
- automatic deploy;
- production authorization.

---

## 14. Operational examples

### Full review

```text
$weather-gate-reviewer
mode: FULL_BOUNDED_REVIEW
parent: <milestone-base>
head: <milestone-head>
allowed_files: <exact>
acceptance_checks: <exact>
```

### Delta review

```text
$weather-gate-reviewer
mode: TARGETED_DELTA_REVIEW
parent: <rejected-head>
head: <correction-head>
previous_blocking_findings:
- <exact>
```

### Model verification failure

```text
reviewer_model_observed: NOT_VERIFIABLE
reviewer_model_verified: NOT_VERIFIABLE
verdict: STOP
```

### Generated artifact allowlist

```text
generated_artifact_allowlist:
- reports/weather/gamma-proof/latest.json
- reports/weather/gamma-proof/latest.md
```

---

## 15. Current reviewer verdict

| Capability | State |
|---|---|
| Reusable Skill | PASS |
| Mandatory invocation | PASS |
| Delegation | PASS |
| Terra → Luna | PASS |
| Runtime model proof | PASS |
| Read-only | PASS |
| Auto-fix | OFF |
| Auto-push/deploy | OFF |
| Founder gate | ON |
| Maturity | LEVEL 2 |
