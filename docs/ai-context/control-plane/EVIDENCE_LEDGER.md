# EVIDENCE_LEDGER.md — Append-Only Evidence History

<!-- AUTHORITY: HISTORICAL ONLY. This file is NEVER authoritative for current state. -->
<!-- Current operational state authority: docs/ai-context/control-plane/CURRENT_STATE.yaml -->

## Rules

1. **Append only.** Never edit or delete an existing entry. Supersede it with a new entry
   that references the old `id`.
2. **Never authoritative for current state.** If this ledger and `CURRENT_STATE.yaml`
   disagree about what is true *now*, `CURRENT_STATE.yaml` wins.
3. Every entry MUST declare exactly one evidence class:

| Class | Meaning |
|---|---|
| `PROVEN_IN_RUNTIME` | Produced by a command executed in the stated runtime, with exit code / output. |
| `FOUNDER_ACCEPTED_EXTERNAL_AUDIT` | Audit performed outside this runtime; Founder accepted it. Not inspected here. |
| `FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT` | Operational checkpoint stated by the Founder. Not inspected here. |
| `SUPPORTED` | Executor self-report, not independently verified. |
| `NOT_PROVEN` | Explicitly untested or unavailable. Recorded so it cannot be silently assumed. |

---

## EV-0001 — Phase 0 source and instruction-layer audit

- **evidence_class:** `FOUNDER_ACCEPTED_EXTERNAL_AUDIT`
- **accepted_at:** 2026-08-03
- **scope:** PolyProPicks instruction layer

Findings accepted:

- No single machine-readable current state exists; state is spread across many Markdown checkpoints.
- Four pairs of instruction files have diverged.
- `docs/ai-context/PROMPT__PROTOCOL.md` is **absent** from tracked `origin/main`.
- `PROMPT_COMPLETION_PROTOCOL.md` is **absent**.
- The current completion report format is prose, not schema-validated.
- `AGENTS.md` contains environment assumptions (Windows-only repo path, "Windows CMD preferred") that are not valid in Claude Code Cloud.
- Legacy state documents have no reliable freshness enforcement.
- PREMVP / Ireland separation exists in prose but is not mechanically routed.

**Superseded by:** the canonical control-plane artifacts created under
`docs/ai-context/control-plane/`.

---

## EV-0002 — Claude Code Cloud capability proof

- **evidence_class:** `FOUNDER_ACCEPTED_EXTERNAL_AUDIT`
- **accepted_at:** 2026-08-03
- **executor:** `claude_code_cloud`
- **repository:** `POLYPROPICKS/PREMVP`

Accepted as proven in a clean Cloud checkout:

| Capability | Result |
|---|---|
| PREMVP repository read | PROVEN |
| `npm ci` | exit 0, clean git status afterwards |
| Authenticated Supabase SELECT via `npx tsx scripts/verify-executor-queue.ts` | PROVEN |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| Production HTTPS access | PROVEN |
| Operator terminal required | false |
| Host dependency | false |

Explicitly **NOT_PROVEN** and not tested in this phase:

- Supabase **write** access — `NOT_PROVEN`
- Ireland runtime access — `NOT_PROVEN`

Claude-side executable inventory accepted:

- No project-scoped Claude agents.
- `.claude/commands/verify.md` — explicit command.
- `.claude/commands/refresh-ai-context.md` — explicit command.
- `.claude/commands/daily-ops-report-plan.md` — planned command.
- `.claude/hooks/validate-proof-package.mjs` — automatic Stop hook.
- `.claude/settings.json` contains the Stop hook.
- No SessionStart dependency-install hook existed at audit time.

---

## EV-0003 — Local Windows Codex agent inventory

- **evidence_class:** `FOUNDER_ACCEPTED_EXTERNAL_AUDIT`
- **accepted_at:** 2026-08-03
- **executor:** `local_codex_windows`
- **runtime:** `local_codex_windows`
- **worktree:** `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`
- **host_dependency:** `true`
- **access_surfaces:** `DESKTOP`, `MOBILE_REMOTE` (Codex Remote)

Proven user-scoped reviewers:

| Canonical id | Implementation | Model | Reasoning | Sandbox |
|---|---|---|---|---|
| `codex.agent.weather_gate_reviewer.v0` | `C:\Users\Alex\.codex\agents\weather-gate-reviewer.toml` | `gpt-5.6-luna` | high | read-only |
| `codex.agent.contur_gate_reviewer` | `C:\Users\Alex\.codex\agents\contur-gate-reviewer.toml` | `gpt-5.6-luna` | max | read-only |

Explicitly **NOT_PROVEN**:

- Deterministic reviewer invocation.
- Required invocation receipt.
- Deterministic gate proving a mandatory reviewer ran.
- Project-scoped Codex agent package.
- Tracked CI gate enforcing reviewer invocation.

These Windows paths were **not** inspected from Claude Code Cloud and must not be
accessed from it.

---

## EV-0004 — Accepted C1 external checkpoint

- **evidence_class:** `FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT`
- **accepted_at:** 2026-08-03
- **executor:** `local_codex_windows`
- **branch:** `codex/queue-authority-cutoff-20260803`
- **claimed local HEAD:** `76a1590caf34f25ef15de6c45f51e52045447bd2`

Accepted checkpoint:

- Expected dirty files: `lib/executor/eventExecutionQueue.ts`,
  `tests/contur3/eventExecutionQueue.controlledLiveIntent.test.ts`,
  `tests/contur3/eventExecutionQueue.rebalanceScheduler.test.ts`
- Diff: 104 insertions / 13 deletions
- `git diff --check`: PASS, CRLF warnings only
- Dependency and `tsx` resolution: PASS
- Controlled-live test-file runs: completed normally
- Current failure: **CTL18 assertion failure**
- Previous runtime-hang hypothesis: **not reproduced**
- No retained process, open handle, unresolved Promise, active global `Date` mutation or
  reproducible full-file hang is currently proven.

Roadmap position accepted at the same time:

- Step A / Contract A authority — source-level closed
- Step B / Planning and Reservation writers use Contract A — source-level closed
- Step C1 — current open value step
- Step C2 — next value step
- After C2 — settlement / PnL and production vertical proof

The Local Windows worktree was **not** inspected from Cloud.

---

## EV-0005 — Cloud runtime verification of remote refs (this session)

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-03
- **executor:** `claude_code_cloud`

| Command | Result |
|---|---|
| `git remote -v` | `origin` → `POLYPROPICKS/PREMVP` |
| `git status --short` | empty (clean) |
| `git fetch origin main` + `git rev-parse origin/main` | `6e593a5d0e66e50941f130f7792f67e487dbb347` |
| `git ls-remote --heads origin codex/queue-authority-cutoff-20260803` | `05ed5f45f60567a80fa6a231479ae95bc92962ab` |

**Important distinction:** the remote ref for the C1 branch resolves to
`05ed5f45f60567a80fa6a231479ae95bc92962ab`. The Founder-accepted local HEAD
`76a1590caf34f25ef15de6c45f51e52045447bd2` is **not** the remote tip and remains
`FOUNDER_ACCEPTED_EXTERNAL_CHECKPOINT`. It was **not** downgraded and **not** invented.

---

## EV-0006 — Architect Control Plane Phase 1/2 implementation

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-03
- **executor:** `claude_code_cloud`
- **branch:** `claude/architect-control-plane-phase1-2-20260803`
- **base:** `6e593a5d0e66e50941f130f7792f67e487dbb347`

Created the canonical control-plane artifacts, deterministic validators, bounded tests,
package scripts, the SessionStart dependency guard, and the Phase 2 ChatGPT Project
setup package. Verification results are recorded in the pull request for this branch.

---

## EV-0007 — Architect Control Plane Phase 1/2 merged to main

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-04
- **executor:** `claude_code_cloud`

| Item | Value |
|---|---|
| PR | `POLYPROPICKS/PREMVP#77` |
| PR final head (post freshness-fix) | `b52fab82a46a05ffbc75373049ddbf3ef6563e60` |
| Merge commit | `b522d3a3caaa07d8605f2b6d4edbd2db6a71a629` |
| `git fetch origin main` + `git rev-parse origin/main` | `b522d3a3caaa07d8605f2b6d4edbd2db6a71a629` |
| `git merge-base --is-ancestor b52fab8… origin/main` | ancestor confirmed |

PR #77 carried four commits: the original canonical foundation and ChatGPT Project
setup package, plus a fourth commit (`b52fab8`) fixing a self-stale defect in the
`origin_main_sha` freshness model — exact equality between the recorded baseline and
live `origin/main` cannot survive the merge that lands it, since the merge commit
cannot be embedded in its own parent. `origin_main_sha` is now defined as a
`LAST_VERIFIED_ORIGIN_MAIN_BASELINE` under freshness mode
`BASELINE_ANCESTOR_WITH_STATE_ONLY_ADVANCE`: the baseline must be an ancestor of live
`origin/main`, and a state-only bootstrap advance (touching only `CURRENT_STATE.yaml`,
`ARCHITECT_SNAPSHOT.md`, `EVIDENCE_LEDGER.md`) keeps state FRESH.

This entry documents the merge event only. `CURRENT_STATE.yaml.main.origin_main_sha`
was updated to this merge commit in the same bootstrap that appended this entry — see
`CURRENT_STATE.yaml` for the current baseline, never this ledger.

No production, database, Railway, Ireland or UAS change occurred.

---

## EV-0008 — State refresh: C1 lineage closed, C1 production runtime proof opened

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-04
- **executor:** `claude_code_cloud`
- **completion_id:** `CMP-T1-STATE-RECONCILIATION-RECOVERY-V2-20260804`

| Item | Value |
|---|---|
| `git fetch --prune origin` + `git rev-parse origin/main` | `33f0e882c14c71021902c3912268d89681d88003` |
| C1 source and merge lineage | proven merged on `origin/main` |
| State refresh applied | `CURRENT_STATE.yaml` advanced state_version 2 → 3 |
| Deployment mapping (commit → Railway deployment) | `NOT_PROVEN` (unchanged) |
| Runtime, deployment, database | unchanged in this task |
| Next authorized step | C1 production runtime proof (OPEN); C2 not started |

This entry documents the state-refresh event only. It is history and is **never**
authoritative for current state — see `CURRENT_STATE.yaml`.

---

## EV-0009 — Founder authority + prompt-relay-only operator model encoded; GitHub PR integration registered

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-04
- **executor:** `claude_code_cloud`
- **completion_id:** `CMP-FOUNDER-AUTHORITY-GITHUB-INTEGRATION-20260804`
- **branch:** `claude/state-refresh-c1-runtime-proof-20260804`
- **base:** `e9e304cc40acd12c3efeec1076af95c5205f60d7`

A current explicit Founder decision was accepted and encoded into the canonical Control
Plane:

- Founder is the highest project authority; a concrete current Founder directive
  supersedes conflicting internal Control Plane policy for the exact authorized task
  only (`ARCHITECT_CONTROL_PLANE.yaml.founder_authority`).
- Founder operates prompt-relay-only: no GitHub, Git, terminal, Supabase or deployment
  action (`ARCHITECT_CONTROL_PLANE.yaml.operator_model`).
- Executors own repository integration end-to-end: implement, validate, commit, push,
  create the PR, merge the PR, verify origin/main
  (`ARCHITECT_CONTROL_PLANE.yaml.repository_integration`).
- A minimum command, `claude.command.github_pr_merge.v0`, was registered in
  `AGENT_REGISTRY.yaml` (status `PLANNED` — no dedicated command file exists yet; the
  bounded integration is executed directly via authenticated GitHub MCP tools under this
  policy). R1 and R2 forbidden_actions no longer include a blanket `MERGE` prohibition;
  R3 and R4 replace it with `MERGE_WITHOUT_REVIEWER_RECEIPT`, preserving the mandatory
  Weather and Contur reviewer-receipt gates. R5 remains fail-closed by default; its
  `fail_closed_behavior.founder_override_scope` documents that only an explicit,
  exactly-named Founder directive can authorize a bounded R5 action, and its empty
  `eligible_execution_targets` / `permitted_repositories` are unchanged.
- `CAPABILITY_MATRIX.yaml` registers `GITHUB_PR_CREATE` and `GITHUB_PR_MERGE` for
  `claude_code_cloud`, both `NOT_PROVEN` at commit time. The schema's verdict enum
  (`PROVEN`/`FAILED`/`NOT_PROVEN`/`NOT_AVAILABLE`) has no pending state, and this
  governance commit necessarily precedes the PR-create and PR-merge calls it describes,
  so it cannot itself prove them. Marking them `PROVEN` here would be a false pre-proof
  claim, which `founder_authority.limitations` and this project's evidence rules
  forbid.

Per the authorizing prompt's bounded budget (maximum one new commit, one PR creation,
one PR merge in this session), this governance change and the PR create/merge attempt
it authorizes are carried out as a single commit and a single PR. The live result of
that PR-create and PR-merge attempt — PR number, base/head SHAs, required-check status,
merge result, and final verified `origin/main` SHA — is reported in completion envelope
`CMP-FOUNDER-AUTHORITY-GITHUB-INTEGRATION-20260804` for this task. Because that live
result lands after this commit is authored, `GITHUB_PR_CREATE` and `GITHUB_PR_MERGE`
stay `NOT_PROVEN` in this file until a later bounded task reads that completion envelope
and updates these two verdicts with a matching evidence reference.

No production, deployment, database, Ireland or live-money action occurred.
