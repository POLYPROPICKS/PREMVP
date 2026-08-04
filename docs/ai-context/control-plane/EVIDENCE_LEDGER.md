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
