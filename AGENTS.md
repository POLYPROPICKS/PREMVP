# AGENTS.md — PolyProPicks AI Agent Constitution

<!-- ACTIVATION POINT: Read after CLAUDE.md, before any implementation -->
<!-- TOKEN LOADING RULE: ALWAYS load. Tier 0. Repo root. -->
<!-- OWNER: Founder/Operator -->
<!-- MONITORING CHECK: Agent behavior audited against §3 forbidden list and §5 stop conditions -->

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
- Do NOT continue when git status is unexpectedly dirty
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

## 9. Stop conditions

Stop immediately and output STOP CONDITION response if:

1. `git status --short` is dirty unexpectedly
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

## 10. Token loading rules

| Artifact | When to load |
|---|---|
| CLAUDE.md | Always — first |
| AGENTS.md | Always — second |
| TASK_ROUTING_MATRIX.md | Before every task classification |
| CLAUDE_CODE_EXECUTION_PROTOCOL.md | Before every implementation task |
| VERIFICATION_GATES.md | After every patch |
| 04_PRODUCT_DECISIONS_LOCKED.md | When product/UX/payment decisions arise |
| 02_CURRENT_TECH_STATE.md | When tech state uncertain |
| 03_CURRENT_SOURCE_ARCHITECTURE_MAP.md | When source wiring uncertain |
| 10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md | UI tasks only |
| 06_PREMVP_LESSONS | Failure investigation only — NOT at session start |
| 07_AI_AGENT_MIGRATION_CONTEXT.md | Archive — do not load routinely |

## 11. Context tier system

```
Tier 0: CLAUDE.md, AGENTS.md                         ← always load
Tier 1: TASK_ROUTING_MATRIX, EXECUTION_PROTOCOL,     ← load at task start
        VERIFICATION_GATES, FAILURE_MODES
Tier 2: 01–04, 08, 10, 11 /docs/ai-context/          ← load when task-relevant
Tier 3: MONITORING, SCORECARD, DRIFT_LOG              ← load after task
Tier 4: 06, 07 /docs/ai-context/                     ← load at failure only
```

## 12. Compliance monitoring

All Claude/Code responses are audited by:
`/docs/ai-context/RULE_COMPLIANCE_MONITOR_AGENT.md`

Responses missing required fields will be scored as FAIL and trigger a ready-to-paste drift log entry.

## 13. Premium production QA gate

For `/premium` production-only UI patches:
- Do NOT request founder visual acceptance until: build PASS + committed + pushed + Railway PREMVP `Deployment successful` for that exact commit.
- Localhost `/premium` is **not** a valid visual surface unless local founder-preview env/session is confirmed configured.
- Production visual check must use founder-preview route after deploy.
- Required flow: `patch → build PASS → commit/push → Railway deploy proof → founder-preview URL visual check`
- No deploy proof = no production visual check request.

## 14. CONTUR3 24H LOG-FIRST RULE (canonical)

Before diagnosing or patching Contur3 / night reservations / event rebalance /
Ireland execution, inspect the last-24h canonical live funnel log:

- Read `reports/contur3/live_funnel_latest.md` (and `live_funnel_latest.json`).
- If missing OR older than 30 minutes during an active battle window, rerun:
  `npm run contur3:live-funnel-log`
- If the log is missing entirely, **creating/fixing the logging layer is P0**
  before any new diagnosis.

No Claude / Cascade / ChatGPT answer may claim readiness without referencing:
latest log path, `generated_at`, `machine_verdict`, `hard_anomaly_count`,
next due (Minsk), queue count, Ireland status.

Every suspicious situation must be written to the log with an anomaly code and a
recommended next command. One final `*_latest` log must always exist even if many
timestamped logs exist — the founder should never have to infer state from
scattered one-off scripts.

The single source of funnel definitions (normalization, market classification,
pagination, schema) is `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs`.
Companion commands: `contur3:g2-log`, `contur3:preflight24h`, `contur3:battle-ready`.
