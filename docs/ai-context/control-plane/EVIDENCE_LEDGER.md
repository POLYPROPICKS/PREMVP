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

## EV-0010 — Post-patch state refresh: PR #83 source fix recorded, C1 runtime proof still open

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-04
- **executor:** `claude_code_cloud`
- **completion_id:** `CMP-STATE-V4-POST-PATCH-20260804`
- **accepted_reconciliation_completion_id:** `CMP-POST-PATCH-STATE-RECONCILIATION-20260804`
- **branch:** `claude/state-refresh-v4-post-patch-20260804`
- **base:** `52129f93a314a35abf962069e9efd1566b03975b`

The Architect-accepted reconciliation delta from
`CMP-POST-PATCH-STATE-RECONCILIATION-20260804` was applied to canonical state.

- `state_version` advanced `3` -> `4`.
- Recorded `main.origin_main_sha` baseline advanced from
  `33f0e882c14c71021902c3912268d89681d88003` to
  `52129f93a314a35abf962069e9efd1566b03975b`.
- `52129f93a314a35abf962069e9efd1566b03975b` is the merge commit of PR #83 and was
  verified as the live `origin/main` tip in this session.
- The PR #83 source commit is
  `e48e5f674b4d421105a9714196fb95a9403750fc`, verified as an ancestor of `origin/main`.
- PR #83 changed exactly two paths: application source
  `lib/executor/buildFireModelCandidates.ts` and regression test
  `tests/contur3/buildFireModelCandidates.effectiveActivityLabel.test.ts`. This baseline
  advance therefore includes application source and tests and is not a state-only
  bootstrap advance.
- Commit-to-deployment mapping for this patch remains `NOT_PROVEN`. No deployment was
  observed, triggered or claimed.
- C1 production runtime proof remains `OPEN`; `BLK-001` was restated, not closed.
- C2 remains not started (`NEXT`).
- `runtime_changed=false`, `deployment_changed=false`, `database_changed=false`.
- Founder action: none.

This entry is history only. It records the state refresh and does not reopen, amend or
reimplement PR #83.

## EV-0011 — State refresh: PR #85 production deployment mapping recorded as PROVEN, C1 runtime proof still open

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-04
- **executor:** `claude_code_cloud`
- **completion_id:** `CMP-STATE-V5-PR85-DEPLOYMENT-20260804`
- **accepted_completion_id:** `CMP-PR85-DEPLOYMENT-STATE-RUNTIME-BOUNDARY-20260804`
- **branch:** `claude/state-v5-pr85-deployment-20260804`
- **base:** `1a140a297523c0413c32954ecf7dc63d1d345d3b`

The Architect-accepted delta from `CMP-PR85-DEPLOYMENT-STATE-RUNTIME-BOUNDARY-20260804`
was applied to canonical state.

- `state_version` advanced `4` -> `5`.
- Recorded `main.origin_main_sha` product-source baseline advanced from
  `52129f93a314a35abf962069e9efd1566b03975b` to
  `1a140a297523c0413c32954ecf7dc63d1d345d3b`.
- `1a140a297523c0413c32954ecf7dc63d1d345d3b` is the merge commit of PR #85, verified as
  the live `origin/main` tip in this session.
- The PR #85 implementation commit is `7e0ba854dbe08126536346809137300ab7025eb2`,
  verified as an ancestor of `origin/main`.
- PR #85 changed exactly five paths: `app/api/build-info/route.ts`,
  `lib/runtime/buildProvenance.ts`, `tests/api/buildInfo.test.ts`,
  `tests/runtime/buildProvenance.test.ts` (added), and `next.config.ts` (modified). This
  baseline advance therefore includes application source and tests and is not a
  state-only bootstrap advance.
- Commit-to-deployment mapping is `PROVEN`: production `GET /api/build-info` returned
  HTTP 200 with `commit_sha` `1a140a297523c0413c32954ecf7dc63d1d345d3b` at
  `2026-08-04T19:45:57Z` — the post-deploy observation boundary. This deployed commit
  contains the PR #85 implementation commit and equals the verified `origin/main`
  product-source baseline.
- No natural night-reservations run has started after the post-deploy observation
  boundary. The latest natural run started at `2026-08-04T14:02:25.523Z` with
  `plan_run_id` `night-plan:2026-08-04:1700-minsk`.
- C1 production runtime proof remains `OPEN`; `BLK-001` was restated with the proven
  deployment mapping, not closed.
- C2 remains not started (`NEXT`).
- `runtime_changed=false`, `deployment_changed=false`, `database_changed=false`.
- Founder action: none.

This entry is history only. It records the state refresh and does not reopen, amend or
reimplement PR #85, and does not trigger or observe a new deployment or natural run.

## EV-0012 — 2026-08-06 local runtime repair checkpoint

- Founder decision `FOUNDER_FINAL_PROTOCOL_BOOTSTRAP_AND_RUNTIME_FIX_20260805T2330_PLUS0300` authorized the bounded PREMVP release.
- Governance PR #89 proved local GitHub PR create/merge; application PR #90 merged as `ea09f77753aa5352c3959ae63422bd515131eda1` and production build-info reached that SHA.
- Sport funnel diagnostics and exact `generated_signal_pair_id` Final Identity loading deployed; the application reviewer PASS receipt reviewed `d4c61f91a2242152f519e5b6ac27aacf3ec7ea13`.
- Local `npm ci`, targeted tests, typecheck, and production build passed. No migration, database mutation, manual deployment, job, Ireland, or live-money action occurred.
- Historical 15-Reservation cohort remains SKIPPED and expired; no natural post-deploy immutable Queue success is proven. C1 remains OPEN.
- Capability transitions are recorded by `779516d2cc7d184e9242559fff3fbb52f15e874a`. This ledger entry is history only.

## EV-0013 — 2026-08-06 Action 2: resumable PREMVP release pipeline scaffold (experimental, disabled)

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **observed_at:** 2026-08-06
- **executor:** `claude_code_cloud`
- **branch:** `claude/premvp-release-pipeline-otzkt6`
- **implementation commit:** `688179b` (see `git log` on the branch for the full 40-character SHA)

Implemented `premvp.command.release_pipeline.v1` / `premvp.release_pipeline.v1`, a reusable,
resumable, idempotent PREMVP release-orchestration state machine, registered
`EXPERIMENTAL_DISABLED`.

- Canonical pipeline specification and release-run manifest schema added under
  `docs/ai-context/control-plane/pipelines/`.
- Engine library (`scripts/control-plane/lib/premvp-release-pipeline.mjs`), CLI
  (`scripts/control-plane/run-premvp-release.mjs`), and manifest validator
  (`scripts/control-plane/validate-premvp-release-run.mjs`) are transport-free: every
  Git/GitHub/deployment/reviewer operation goes through an injected adapter, so mutating
  behavior is exercised only via fake adapters in tests.
- Registered in `AGENT_REGISTRY.yaml` (status `PLANNED`, `pipeline_status
  EXPERIMENTAL_DISABLED`, `enabled: false`) and cataloged in `ROUTING_AND_PIPELINES.yaml`
  and `ARCHITECT_CONTROL_PLANE.yaml` without changing any existing task-class routing or
  R3/R4 mandatory-reviewer routing.
- `tests/control-plane/premvpReleasePipeline.test.mjs` — 33 tests, all passing — cover
  manifest invariants (single repository, no Ireland, no R5, zero intermediate operator
  actions, no direct main push, no manual deployment, no secrets, no v1 database
  mutation), disabled-mode gating (`assertMutationAllowed` throws
  `PIPELINE_MUTATING_MODE_NOT_DISABLED` while dry-run/status/validate remain permitted),
  live-evidence-first reconstruction and resume (a contradictory local checkpoint loses
  to live Git/PR/deployment state), and idempotency (no duplicate PR creation, no
  duplicate merge, deployment poll short-circuits on a matching production SHA, no
  duplicate reviewer invocation, pending reviewer receipts are polled not re-invoked,
  mismatched receipt SHA blocks) and R5 fail-closed behavior.
- `npm run control-plane:check` (validator + full control-plane test suite + snapshot
  check), `npx tsc --noEmit`, and `npm run build` all passed after this change.
  `git diff --check` passed clean.
- Mutating pipeline mode remains refused: `premvp.command.control_plane_reconcile.v1`
  does not exist yet. Dry-run, status reconstruction, manifest validation, and a
  fixture-manifest resume simulation were exercised locally with zero repository or
  GitHub mutation.
- Live `origin/main` at session start was `9574dced71579048148401662e67912f7ec03d39`,
  proven an exact match to production `GET /api/build-info` in this session. This
  baseline is unchanged by this entry — the branch above has not been pushed, PR'd, or
  merged.
- No product behavior changed. No database, Ireland, or live-money action occurred. C1
  remains `OPEN`; C2 and `SETTLEMENT_PNL` remain the next two value steps.
- Founder action: none required to accept this scaffold; merge requires a follow-up
  confirmation on this remote session before `claude.command.github_pr_merge.v0` is
  invoked.

This entry is history only. It records the Action 2 pipeline scaffold and does not mark
the pipeline enabled, does not mark C1 complete, and does not self-accept a state delta.

## EV-0014 — 2026-08-06 Action 3 executor-owned preflight state refresh

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **executor:** `local_codex_windows`
- **observed_at:** 2026-08-06T08:43:57Z
- Live `origin/main` and production `GET /api/build-info` both resolved to
  `b8aa8e7ba2114d5f9828200afb2d6c778e15224b`, the Action 2 PR #92 merge.
- The prior baseline `9574dced71579048148401662e67912f7ec03d39` is an ancestor of that
  merge. The refresh advances only current-state artifacts; it records Action 2 as merged
  while retaining `EXPERIMENTAL_DISABLED` status and Action 3 as pending.
- C1 remains OPEN; no product, database, Ireland, or live-money change occurred.

This entry is historical evidence only and does not accept an Action 3 completion.

## EV-0015 — 2026-08-06 Action 3 implementation state bootstrap

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **executor:** `local_codex_windows`
- **implementation_sha:** `1c3b10aaec79a6fb7886533cb563606c61d1549a`
- Shared executor-neutral GitHub, reviewer, and reconcile command contracts were registered.
  The release pipeline is enabled only with prompt-selected executor context; R5 remains
  fail-closed and reviewer routing remains risk-class derived.
- This bootstrap advances state only after the non-state implementation commit and does
  not accept the current completion. C1 remains OPEN; no product, database, Ireland, or
  live-money behavior changed.
## EV-0016 — 2026-08-06 PR #94 baseline correction

- **evidence_class:** `PROVEN_IN_RUNTIME`
- **executor:** `local_codex_windows`
- PR #94 stored malformed baseline `6cd262e6b7fba6c4fd392c3903c51d80fd429489`; Git could not resolve it.
- Validator hardening commit `c74106c46e6e12de2f0ab26be4e0e38bee3169a0` resolves a supplied
  revision to one full commit SHA and requires ancestor proof before state output.
- Corrective state bootstrap is pending integration. C1 remains OPEN; no product, database,
  Ireland, job, or live-money behavior changed.
