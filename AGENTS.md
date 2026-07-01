# AGENTS.md — PolyProPicks AI Agent Constitution

<!-- ACTIVATION POINT: Read after CLAUDE.md, before any implementation -->
<!-- TOKEN LOADING RULE: ALWAYS load. Tier 0. Repo root. -->
<!-- MONITORING CHECK: Agent behavior audited against §3 forbidden list and §8 stop conditions -->

## 1. Source-of-truth hierarchy
```
1. Repo source files + git output   ← beats everything
2. /docs/ai-context/*.md            ← beats memory
3. CLAUDE.md + AGENTS.md            ← active rules
4. Current user message
5. Old chat history                 ← lowest priority
```
ChatGPT Saved Memory is NOT project source of truth.

Token loading tiers — load only what the task needs, never paste long historical context into executor prompts:
```
Tier 0: CLAUDE.md, AGENTS.md                              → always load
Tier 1: TASK_ROUTING_MATRIX.md, CLAUDE_CODE_EXECUTION_PROTOCOL.md → load at task start
Tier 2: VERIFICATION_GATES.md / UI/production QA gates    → load when relevant
Tier 3: product/tech/source-architecture context docs     → load when task-relevant
Tier 4: archive/lessons/handoff docs                       → load only after failure/recovery/postmortem, never at session start
```

## 2. Role split

| Agent | Role | Must NOT do |
|---|---|---|
| Claude Chat | Classify, plan, review, generate Claude Code prompts | Directly edit local repo files |
| Claude Code | Inspect source, apply narrow patches, verify, report evidence | Commit/push without approval; broad refactor |
| CMD/Terminal | Cheap verification: git/build/curl ≤5 commands | Multi-step complex verification |
| Founder | Product intent, visual acceptance, business decisions, deploy approval | Manual code editing, multi-file snippet replacement |
| ChatGPT | External strategic backup; may flag stale `/docs/ai-context/` entries to founder | Must NOT silently override `/docs/ai-context/` decisions — state as "I believe [file X] may be stale because [reason] — founder to decide" |

## 3. Forbidden behaviors — hard rules (gates, not preferences)

### 3.1 Code, source and file paths
- No full rewrite / broad refactor; no edit before git/source state is verified
- No patch when source is uncertain — inspect first
- No zone mixing: UI task → no backend; backend task → no UI/CSS
- No "open file X, replace snippet Y" instructions to founder
- No invented file paths — primary source `/docs/ai-context/11_SOURCE_FILES_AND_REPO_INVENTORY.md`; if missing or >7 days stale, treat as STALE and verify directly via `ls`/repo tree
- If a path cannot be confirmed → mark NEEDS VERIFICATION, do not patch

### 3.2 Product, architecture and payment/auth
- No override of locked decisions in `04_PRODUCT_DECISIONS_LOCKED.md`
- No localStorage-only premium entitlement; no forced login before one free signal is visible
- No Whop-only or Stripe-only internal architecture — Supabase entitlement is internal source of truth; UI must not trust Whop/Stripe directly; Whop first, Stripe later
- No frontend redesign without explicit founder request; no DOM/className/CSS structure change without explicit UI scope
- No payment/auth changes without a locked decision in `04_PRODUCT_DECISIONS_LOCKED.md`

### 3.3 Verification and completion
- No "done"/"success" claims without full proof package
- Build pass ≠ visual/product acceptance; cached API response ≠ fresh-generation proof
- git status / git diff --stat / build result required in every patch response
- Old/new snippets required for code-changing tasks

### 3.4 Git, deploy, env/secrets
- No commit without explicit gate check; no push/deploy without explicit founder approval
- No continuing when git status is unexpectedly dirty; no commit when `git diff --check` reports trailing whitespace
- No exposing/printing env vars or secrets; no requesting secrets unless absolutely required
- No Railway/Supabase/connector config changes without explicit scope

## 4. Project identity
```
Repo path:  C:\WORK\KalshiProPulse\sipropicks-premvp1-1        Stack:  Next.js / React / TypeScript / CSS Modules
Production: https://polypropicks.com                            Data:   Supabase (lead/reserve/cache)
Deploy:     Railway                                              Terminal: Windows CMD preferred over PowerShell
```

## 5. Product preservation
```
LandingPair          → canonical unit — preserve
PremiumEventCard     → master signal card — preserve
MarketSourceCard     → dependent evidence card — preserve
MarketSourceCarousel → dependent evidence carousel — preserve; must NOT become an independent random feed
marketSource         → backward compatibility required
marketSources[]      → evidence stack — preserve; [0] should match marketSource
Feed generation      → display-grade deterministic, not ML
```
Evidence must always match active PremiumEventCard/LandingPair. No proof/signal mismatch.

## 6. Evidence types and product copy

Approved MarketSource evidence types (no new ones without founder approval): `market-source`, `news-pulse` (future-only, unless a verified news/context source is implemented — do NOT display as live data), `market-momentum`, `sharp-flow`.
```
Signal Confidence    → approved label for display score
Win Probability      → DO NOT revive
Main landing CTA     → "Get 5 Free Signals NOW" — do not change
Sharp/whale language → must remain proxy-safe
```
Do NOT claim: guaranteed profit / real calibrated ML / verified news without source / verified institutional smart money.

## 7. Supabase / lead / payment

Active table: `public.lead_intents`. Premium reserve fields: `source`, `intent_type`, `plan_id`, `plan_name`, `plan_price`, `plan_source`, `event_title`, `position`.

Supabase production rows beat localStorage. No payment/Stripe/auth/admin/lead-capture/Supabase schema changes unless explicitly scoped in the current task. Payment architecture docs are reference only.

## 8. Stop conditions

Stop immediately and output the stop-condition format if: `git status --short` is dirty unexpectedly; build fails (FAIL, not partial); expected file/code block is missing from repo; a forbidden file must be edited to continue; task expands beyond allowed files; env/secrets are needed; payment/auth boundary is unclear; source/context files conflict; broad refactor becomes necessary; UI changes become necessary during a backend-only task (or vice versa); cached API output is treated as fresh-generation proof; screenshot unchanged after a claimed UI fix (inspect the active selector before further patching); or after one failed Claude Code attempt (evaluate direct-source check before another prompt).
```
STOP CONDITION:
Why: [specific reason]
Unknown: [what is uncertain]
Verification needed: [exactly what]
Files/commands needed: [list]
Safe next action: [one action]
Do NOT: commit / push / continue patching
```

## 9. Compliance monitoring

All Claude/Code responses are audited by `/docs/ai-context/RULE_COMPLIANCE_MONITOR_AGENT.md`. Responses missing required fields are scored FAIL and trigger a drift log entry.

## 10. Premium production QA gate

For `/premium` production-only UI patches: do NOT request founder visual acceptance until build PASS + committed + pushed + Railway PREMVP `Deployment successful` for that exact commit. Localhost `/premium` is **not** a valid visual surface unless a founder-preview env/session is confirmed configured. Required flow: `patch → build PASS → commit/push → Railway deploy proof → founder-preview URL visual check`. No deploy proof = no production visual check request.

## 11. CONTUR3 24H log-first rule (canonical)

Before diagnosing/patching Contur3 / night reservations / event rebalance / Ireland execution, read the last-24h canonical live funnel log: `reports/contur3/live_funnel_latest.md` (+ `.json`). If missing or older than 30 minutes during an active battle window, run `npm run contur3:live-funnel-log`; if missing entirely, fixing the logging layer is P0 before any new diagnosis.

No readiness claim without referencing: latest log path, `generated_at`, `machine_verdict`, `hard_anomaly_count`, next due (Minsk), queue count, Ireland status. Every suspicious situation gets an anomaly code + recommended next command in the log; one final `*_latest` log must always exist.

Single source of funnel definitions: `scripts/contur3/lib/contur3LiveFunnelMonitor.mjs`. Companion commands: `contur3:g2-log`, `contur3:preflight24h`, `contur3:battle-ready`.
