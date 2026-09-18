# AGENTS.md — PolyProPicks AI Agent Constitution

<!-- ACTIVATION POINT: Read after CLAUDE.md, before any implementation -->
<!-- TOKEN LOADING RULE: Load this guardrail, then only mission-relevant canonical sources. -->
<!-- OWNER: Founder/Operator -->
<!-- MONITORING CHECK: Agent behavior audited against §3 forbidden list and §5 stop conditions -->

## 0. Architect Control Plane — highest-priority entrypoint

Canonical artifacts live in `/docs/ai-context/control-plane/`. Resolve them narrowly before
the hierarchy in §1:

- `ARCHITECT_CONTROL_PLANE.yaml` — resolve the relevant policy and boundaries first.
- `CURRENT_STATE.yaml` — read only when current operational state matters. It remains the only
  current operational state artifact; legacy state documents cannot override it.
- Then read only the exact registry, router, policy, prompt or completion artifact required by
  the mission. `EVIDENCE_LEDGER.md` remains history only.

Default discovery is supplied evidence → exact known path/symbol → filenames/headings →
`rg`/`git grep` → smallest code ranges. Initial repository-read ceiling is 8 code files;
broaden only with a proven dependency. For database investigation use `AGGREGATE_FIRST`,
projected columns and exact joins, never `SELECT *` for deterministic work; raw rows are a
ceiling of 50 per stage and 200 per mission. Prefer compact output and the cheapest capable
model. These economics supplement, and do not weaken, safety, authority, lifecycle,
repository-boundary, recovery or verification rules.

Two further data-forensic rules apply (`EXECUTOR_CONTEXT_ECONOMICS_V2`). `QUERY_PLAN_THEN_BATCH`:
compile one bounded query plan before the first production-data read, batch independent
deterministic aggregates, and never place a model interpretation turn between already-known
independent `COUNT`s — default budgets are <=2 main evidence calls and <=1 verification call.
`ONE_LINEAGE_REPAIR`: when lineage is unknown, take one cheap key/schema probe, one exact
persisted-key join, and at most one corrected join only when the probe revealed the exact key;
otherwise return `UNRESOLVED_EVIDENCE_GAP`. No speculative FK fishing, JSON-path fishing,
timeout escalation or historical-table fishing.

MODEL ECONOMICS: route by mission; prefer runtime-confirmed safe workhorse; READ/SQL →
GLM-5.3 Flash family; implementation → Kimi K2.7 Code family; $15 specialist never default;
switching models does not reset quota; current runtime/provider evidence beats static table.

Two corrections this makes to the rest of this file:

1. **§4 is environment-specific and superseded.** The Windows repo path and "Windows CMD
   preferred" line describe `local_codex_windows` only. Do **not** hardcode Windows as the
   only execution environment — read the executor's row in `CAPABILITY_MATRIX.yaml`.
2. **PREMVP and Ireland implementation prompts must remain separate.** One executor prompt
   targets exactly one repository boundary; mixing them is `PROMPT_GATE_BLOCKED`.

Legacy duplicates are not resolved file-by-file. Their authority and supersession status
is registered centrally in `ARCHITECT_CONTROL_PLANE.yaml → superseded_or_legacy_sources`.

Verify with `npm run control-plane:check`.

## 1. Source-of-truth hierarchy

```
1. Repo source files + git output        ← beats everything
2. /docs/ai-context/*.md                 ← beats memory
3. CLAUDE.md + AGENTS.md                 ← active rules
4. Current user message
5. Old chat history                      ← lowest priority
```

ChatGPT Saved Memory is NOT project source of truth.

## 2. Role split

| Agent | Role | Must NOT do |
|---|---|---|
| Claude Chat | Classify tasks, plan, review, generate Claude Code prompts | Directly edit local repo files |
| Claude Code | Inspect source, apply narrow patches, run verification, report evidence | Commit/push without approval; broad refactor |
| CMD / Terminal | Cheap verification: git/build/curl ≤5 commands | Multi-step complex verification |
| Founder | Product intent, visual acceptance, business decisions, deploy approval | Manual code editing, multi-file snippet replacement |
| ChatGPT | External strategic backup; may challenge stale or conflicting /docs/ai-context/ entries by flagging them explicitly to founder | Must NOT silently override /docs/ai-context/ decisions; any challenge must be stated as "I believe [file X] may be stale because [reason] — founder to decide" |

## 3. Forbidden behaviors — hard rules

Every rule below is a **gate**, not a preference.

### 3.1 Code and source rules
- Do NOT propose full rewrite or broad refactor
- Do NOT edit source before git/source state is verified
- Do NOT patch when source is uncertain — inspect first
- Do NOT mix zones: UI task → no backend; backend task → no UI/CSS
- Do NOT invent file paths — verify against 11_SOURCE_FILES_AND_REPO_INVENTORY.md
- Do NOT provide "open file X and replace snippet Y" instructions to founder

### 3.2 Product/architecture rules
- Do NOT override locked product decisions in 04_PRODUCT_DECISIONS_LOCKED.md
- Do NOT recommend localStorage-only premium entitlement
- Do NOT allow forced login before one free signal is visible
- Do NOT recommend Whop-only or Stripe-only internal architecture
- Do NOT redesign frontend without explicit founder request
- Do NOT change DOM/className/CSS structure without explicit UI scope

### 3.3 Payment/auth rules
- Supabase entitlement is internal source of truth — UI must not trust Whop/Stripe directly
- Whop first, Stripe later — provider-neutral internal architecture required
- No payment/auth changes without locked decision in 04_PRODUCT_DECISIONS_LOCKED.md

### 3.4 Verification and completion rules
- Do NOT claim "done" or "success" without full proof package
- Do NOT treat build pass as visual/product acceptance
- Do NOT treat cached API response as fresh-generation proof
- Do NOT omit git status / git diff stat / build result from patch responses
- Do NOT treat old/new snippets as optional for code-changing tasks

### 3.5 Git/deploy rules
- Do NOT commit without explicit gate check
- Do NOT push/deploy without explicit founder approval
- Do NOT use an unexpectedly dirty Founder root as task input. Preserve it untouched and use the
  canonical execution precheck to create an isolated clean worktree; it is executor-owned recovery.
- Do NOT commit when git diff --check reports trailing whitespace

### 3.6 Env/secrets rules
- Do NOT expose or print env vars / secrets
- Do NOT request secrets unless absolutely required
- Do NOT change Railway/Supabase/connector config without explicit scope

### 3.7 Source file path rules
- Do NOT invent file paths from memory
- Primary source for file paths: `/docs/ai-context/11_SOURCE_FILES_AND_REPO_INVENTORY.md`
- If that file is missing OR its last-modified date is >7 days before current task date → treat as STALE
- Stale or missing fallback: verify paths directly from repo tree
  (Claude Code: run `dir` / `ls` on relevant folder; confirm file exists before referencing)
- If path cannot be confirmed from repo → mark as NEEDS VERIFICATION, do not patch


### 3.8 Operator cost and scope contract — Tier 0

`SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL.md` is mandatory for every task that may require Founder action.

Before the first command/prompt to the Founder, declare:

```text
TASK CONTRACT
DoD
BUSINESS EFFECT
OPERATOR BUDGET
EXPECTED ARTIFACTS
REVIEW CHECKLIST
NOT IN SCOPE
FIRST PROOF
MINIMAL CHANGE BOUNDARY
```

Hard rules:

- Every Founder-action response starts with `OPERATOR CYCLE: k / N`.
- Default Founder budget is 3 cycles; maximum 5 without explicit re-contract.
- All commands for one cycle are batched in one block with a pre-declared decision table.
- A defect outside DoD is deferred; it is not silently absorbed into the current task.
- One writer pass, one full-diff review, at most one minimal correction and delta re-review.
- Two non-progress cycles or two repeated defect classes trigger automatic STOP.
- `commit/push` is not production effect; only merge + deploy + runtime proof is production effect.
- Observability/hygiene work must never be described as live-contour progress.
- Executor/self-report claims are `SUPPORTED`, not `PROVEN`, until current git/source/runtime evidence verifies them.
- When full context-file text is unavailable, request the full file and return a complete corrected replacement; do not tell another agent to open and reconcile it.

If a small task exceeds two executor iterations or 30 minutes without shipped value, return `WORKFLOW_FAILURE_STOP` and re-contract instead of issuing another broad prompt.

## 4. Project identity and environment

```
Repo path:      C:\WORK\KalshiProPulse\sipropicks-premvp1-1
Production:     https://polypropicks.com
Stack:          Next.js / React / TypeScript / CSS Modules
Data:           Supabase (lead/reserve/cache)
Deploy:         Railway
Terminal:       Windows CMD preferred over PowerShell
```

## 5. Project preservation rules

```
LandingPair                    → canonical unit — preserve
PremiumEventCard               → master signal card — preserve
MarketSourceCard               → dependent evidence card — preserve
MarketSourceCarousel           → dependent evidence carousel — preserve
marketSource                   → backward compatibility required
marketSources[]                → evidence stack — preserve
marketSources[0]               → must correspond to marketSource where possible
Feed generation                → display-grade deterministic, not ML
```

Evidence must always match active PremiumEventCard / active LandingPair.
MarketSourceCarousel must NOT become an independent random feed.
Do not create proof/signal mismatch.

## 6. Approved MarketSource evidence types

Only these card types are approved unless explicitly changed by founder:

1. `market-source`
2. `news-pulse` — **future-only** unless a verified news/context source is implemented
3. `market-momentum`
4. `sharp-flow`

Do NOT add new P0 evidence types without explicit founder approval.
Do NOT display `news-pulse` as live data unless verified source exists.

## 7. Product copy / claims rules

```
Signal Confidence              → approved label for display score
Win Probability                → DO NOT revive
Main landing CTA               → "Get 5 Free Signals NOW" — do not change
Sharp/whale language           → must remain proxy-safe
```

Do NOT claim: guaranteed profit / real calibrated ML / verified news without source /
verified institutional smart money.

## 8. Supabase / lead / payment rules

Active table: `public.lead_intents`

Premium reserve fields:
- `source`, `intent_type`, `plan_id`, `plan_name`, `plan_price`, `plan_source`
- `event_title`, `position`

Supabase production rows beat localStorage.
Do NOT change payment / Stripe / auth / admin / lead capture / Supabase schema
unless explicitly scoped in current task.
Payment architecture docs are reference only — do not implement payment changes
unless the current task explicitly says payment phase.

## 8.1 Independent challenge

For non-trivial work, verify material implementation and diagnosis premises before expensive changes.
When uncertainty, repeated failure, broad scope, irreversible risk, or competing approaches make it
useful, invoke `$polypropicks-independent-challenge`. Resolve recoverable uncertainty autonomously;
do not return it to Founder. The Skill is optional and must not inflate routine review.

## 9. Stop conditions

Stop immediately and output STOP CONDITION response if:

1. The selected isolated worktree is dirty unexpectedly, or the dirty Founder root overlaps an
   explicitly allowed write path
2. Build fails (treat as FAIL, not partial success)
3. Expected file or code block is missing from repo
4. Forbidden file must be edited to continue
5. Task expands beyond allowed files
6. Env/secrets are needed
7. Payment/auth boundary is unclear
8. Source/context files conflict with each other
9. Broad refactor becomes necessary
10. UI changes become necessary during backend-only task
11. Backend changes become necessary during UI-only task
12. Cached API output is being treated as fresh-generation proof
13. Screenshot unchanged after claimed UI fix
14. After one failed Claude Code attempt — evaluate direct-source check before another prompt
15. A small task exceeds two executor iterations or 30 minutes without shipped value
16. Operator-cycle budget is exhausted without a BUDGET OVERRUN REPORT
17. Review criteria are being discovered one-by-one after implementation
18. A new defect outside the frozen DoD is being silently absorbed into the current task
19. Two consecutive Founder cycles produce neither a repository artifact nor decision-changing runtime evidence
20. A service state is asserted or changed without exact current evidence and Founder authorization

### Stop condition response format

```
STOP CONDITION:
Why: [specific reason]
Unknown: [what is uncertain]
Verification needed: [exactly what]
Files/commands needed: [list]
Safe next action: [one action]
Do NOT: commit / push / continue patching
```

## 10. Targeted loading rules

| Artifact | When to load |
|---|---|
| CLAUDE.md | Entrypoint guardrail |
| AGENTS.md | Entrypoint guardrail |
| SMALL_TASK_EXECUTION_AND_VALUE_PROTOCOL.md | Founder-action task only |
| TASK_ROUTING_MATRIX.md | Task classification/routing only |
| CLAUDE_CODE_EXECUTION_PROTOCOL.md | Implementation procedure only |
| VERIFICATION_GATES.md | After a patch when its gate applies |
| 04_PRODUCT_DECISIONS_LOCKED.md | When product/UX/payment decisions arise |
| 02_CURRENT_TECH_STATE.md | When tech state uncertain |
| 03_CURRENT_SOURCE_ARCHITECTURE_MAP.md | When source wiring uncertain |
| 10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md | UI tasks only |
| 06_PREMVP_LESSONS | Failure investigation only — NOT at session start |
| 07_AI_AGENT_MIGRATION_CONTEXT.md | Archive — do not load routinely |

## 11. Context tier system

```
Tier 0: CLAUDE.md, AGENTS.md ← entrypoint guardrails
Tier 1: routing, execution and verification artifacts ← load when task-relevant
Tier 2: project context and canonical artifacts ← load when task-relevant
Tier 3: MONITORING, SCORECARD, DRIFT_LOG              ← load after task
Tier 4: 06, 07 /docs/ai-context/                     ← load at failure only
```

## 12. Compliance monitoring

All Claude/Code responses are audited by:
`/docs/ai-context/RULE_COMPLIANCE_MONITOR_AGENT.md`

Responses missing required fields will be scored as FAIL and trigger a ready-to-paste drift log entry.
