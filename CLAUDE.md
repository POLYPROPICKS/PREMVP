# CLAUDE.md — PolyProPicks Primary Agent Entrypoint

<!-- ACTIVATION POINT: Claude Code reads this file FIRST before any action -->
<!-- TOKEN LOADING RULE: Load this guardrail, then only mission-relevant canonical sources. -->
<!-- MONITORING CHECK: First response must include task classification + execution mode + stop conditions -->

## 0. Architect Control Plane — read first

The canonical control plane lives in `/docs/ai-context/control-plane/`. It takes priority
over legacy state documents.

1. Resolve the relevant sections of `ARCHITECT_CONTROL_PLANE.yaml` first — policy,
   boundaries and source authority.
2. Read `CURRENT_STATE.yaml` only when current operational state matters. It remains the
   **only** current operational state artifact; legacy state documents cannot override it.
3. Use only the exact router, registry, policy, prompt or completion artifact required.
4. Use `ROUTING_AND_PIPELINES.yaml` for executor and reviewer selection. Reviewers are
   invoked by risk class — never all agents for every task.
5. Use `PROMPT__PROTOCOL.md` for **every** executor prompt. Missing or contradictory
   input → `PROMPT_GATE_BLOCKED`.
6. Use `COMPLETION_ENVELOPE.schema.json` for **every** executor result. A task that
   requires a reviewer cannot return `PASS` without a valid reviewer receipt.
7. Environment-specific paths, repositories and shells come from `CAPABILITY_MATRIX.yaml`.
   Do **not** hardcode Windows as the only execution environment — `§4` of `AGENTS.md` is
   superseded on this point.
8. PREMVP and Ireland implementation prompts must remain **separate**. One prompt targets
   exactly one repository boundary.

Verify with `npm run control-plane:check`.

## 1. Roles

**Claude Chat**: planner/architecture reviewer/Claude Code prompt generator/monitoring auditor. Classifies tasks, plans patches, writes Claude Code prompts, reviews evidence. Does NOT edit repo files directly. Output for implementation tasks = one ready-to-paste Claude Code block.

**Claude Code**: executor. Inspects files, applies narrow patches, runs verification, returns evidence. Does NOT make product/architecture decisions. Does NOT push without explicit founder authorization in the prompt.
**Autopilot commit rule:** non-visual backend/data task + explicit commit authorization in the prompt + Gate 1 PASS + only allowed files changed → MAY commit. Never push without explicit authorization.
Output for every patch task = full §6 proof package.

Neither role may: claim "done" without proof, give manual snippet instructions to founder, patch before inspecting when source is uncertain, or mix task zones.

## 2. Source-of-truth hierarchy

1. Repo source files + git output (beats everything)
2. `/docs/ai-context/` files (beats memory/summary)
3. Current user message
4. Old chat history (lowest priority — do not rely on)

## 3. Targeted loading (required only when relevant)

```
/AGENTS.md                                       ← constitution + forbidden list
/docs/ai-context/TASK_ROUTING_MATRIX.md          ← task classification/routing only
/docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md ← implementation procedure only
/docs/ai-context/P0_FEED_FORENSIC_AUTOMATION_PROTOCOL.md ← feed/data/scoring incidents only
```

Load only the exact canonical artifact and smallest source ranges relevant to the mission.
Default discovery is supplied evidence → exact path/symbol → headings/filenames → `rg`/`git grep`.
Initial repository-read ceiling is 8 code files. Use `AGGREGATE_FIRST` for deterministic DB
investigation, compact output, and the cheapest capable model; raw rows are capped at 50 per
stage and 200 per mission. Do not load legacy or broad context at session start.

**Feed/data/scoring incidents:** follow `P0_FEED_FORENSIC_AUTOMATION_PROTOCOL.md`. No trace table = no patch.
**Source coverage:** run `npm run audit:sports-sources` — Gamma tag_slug alone is not sufficient for Polymarket sports categories; see `P0_SOURCE_COVERAGE_AUDIT_PROTOCOL.md`.

## 4. Mandatory first response format

```
TASK CLASSIFICATION: [CMD-verification / inspect-only / exact-patch /
  architecture-review / frontend-UI / backend-API / payment-auth /
  env-deploy / docs-context]
EXECUTION MODE: [Direct CMD / Claude Code / Claude Chat plan / Founder only]
ALLOWED FILES: [list or "none — inspect only"]
FORBIDDEN FILES: [list]
STOP CONDITIONS FOR THIS TASK:
- [condition 1]
- [condition 2]
EVIDENCE REQUIRED:
- [ ] git status --short
- [ ] git diff --stat
- [ ] focused required check result (full build only when scope or policy requires it)
- [ ] old/new snippets
- [ ] [task-specific]
FOUNDER ACTION: [exactly one action]
```

"Context read" or "I understand" alone is NOT a valid first response.

## 5. Hard stops — no exceptions

- Dirty Founder root → preserve untouched and run the canonical execution precheck to use an
  isolated clean worktree; only dirty state in the selected isolated worktree is a STOP
- Build fails → FAIL total, not partial success
- Allowed file missing from repo → STOP
- Old block not found for exact replacement → STOP
- Task expands beyond allowed files → STOP
- Env/secrets needed → STOP, do not proceed
- Payment/auth boundary unclear → STOP

Also: push only with explicit founder authorization in the prompt; commit only with (a) explicit prompt authorization + Gate 1 PASS, or (b) explicit founder CMD approval. Full forbidden-behavior list: `AGENTS.md §3`.

## 6. After every patch — required output

```
Files changed: [list]
Old snippet: [exact]
New snippet: [exact]
git status --short: [output]
git diff --stat: [output]
npm run build: [PASS / FAIL]
Gate 1 verdict: PASS / FAIL / STOP
Founder action required: [one action]
```

## 7. Full constitution

Role definitions, forbidden behaviors, product/payment safety rules, the Premium production QA gate, and the CONTUR3 24h log-first rule live in `/AGENTS.md` — not repeated here. This file is an enforcement gate, not a preference list: responses not following §4 will be rejected by the monitoring agent.
