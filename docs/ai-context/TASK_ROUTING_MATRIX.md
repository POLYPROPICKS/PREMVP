# TASK_ROUTING_MATRIX.md — PolyProPicks Task Routing

<!-- ACTIVATION POINT: Before every task — determines executor + response format -->
<!-- TOKEN LOADING RULE: Load at task start. Tier 1. -->
<!-- REQUIRED OUTPUT FIELD: TASK CLASSIFICATION + EXECUTION MODE in every response -->
<!-- STOP/REJECT: ambiguous task type → classify inspect-only first -->

## 1. Decision rule summary

```
≤5 simple git/build/curl commands       → Direct CMD
>5 commands OR multi-step verification  → Claude Code block
Source uncertain + patch planned        → inspect-only FIRST
UI/CSS work                             → inspect-only FIRST, then patch
Product/visual decision                 → Founder only
Payment/auth architecture               → Claude Chat review + Founder approval
Push/deploy                             → Founder explicit approval always; Claude Code may execute when prompt authorizes
Any code edit                           → Claude Code (never founder manual)
```

## 2. Routing table

| Task type | Direct CMD | Claude Code | Claude Chat | Founder only | Notes |
|---|:---:|:---:|:---:|:---:|---|
| `git status/log/branch`, `npm run build`, `git diff --stat/--check`, single curl | ✓ | | | | ≤1–2 commands each |
| git commit (non-visual, authorized) | | ✓ | | ✓ approval | Commits when prompt authorizes + Gate 1 PASS |
| git commit (UI/visual task) | ✓ | | | ✓ approval | Founder runs after Gate 2 visual acceptance |
| git push | | ✓ (when authorized) | | ✓ | Founder explicit approval always |
| Source inspection (uncertain) | | ✓ inspect-only | | | No edits |
| Single-file exact patch | | ✓ | ✓ plan | | Claude Chat plans, Claude Code executes |
| Multi-file patch | | ✓ | ✓ plan | | Explicit `allowed_files[]` per zone required |
| CSS/UI debugging | | ✓ inspect first | ✓ | | Inspect active selectors before patch |
| API response debugging | | ✓ | | | Cache vs fresh — `cacheStatus` required |
| TypeScript/type inspection | | ✓ inspect-only | | | Find source-of-truth type file first |
| Architecture review | | | ✓ | | Chat-only unless source files needed |
| Payment/auth architecture | | | ✓ | ✓ approval | High-risk; Founder decision required |
| Visual acceptance | | | | ✓ | Browser/screenshot only, not Claude judgment |
| Product/copy/pricing decisions | | | | ✓ | Business decision — not automatable |
| Context handoff / prompt writing / monitoring audit / docs artifact update | | | ✓ | | Claude Chat prepares/executes |
| Production verification | ✓ curl | | | ✓ decision | Separate from local build check |
| Railway/Supabase config changes | | | | ✓ | Founder only; env-deploy scope |
| Regression check (multiple routes) | | ✓ | | | Inspect + curl in one Claude Code block |

## 3. Zone rules

```
UI/frontend   → allowed: components/, app/globals.css, CSS modules   forbidden: lib/feed/, app/api/, Supabase
Backend/feed  → allowed: lib/feed/, app/api/feed/                    forbidden: components/, CSS, payment
Payment/auth  → allowed: only explicitly scoped files                forbidden: UI, feed, unrelated Supabase
Docs/context  → allowed: /docs/ai-context/                           forbidden: all source files; no commits mixed with source
```
**Zone mixing = STOP.** If a backend task starts requiring CSS changes → stop, split the task.

## 4. Escalation path

```
CMD fails/ambiguous             → Claude Code inspect-only
Claude Code inspect, no patch   → Claude Chat analysis
Claude Code patch fails once    → Direct-source check (not another broad prompt)
Direct-source check still fails → Founder decision + explicit scope reset
Product/visual boundary reached → Founder only
```

## 5. Direct-source check rule

After ONE failed Claude Code attempt:
```
Direct-source option check:
[continue with Claude Code / request files for direct review / provide full-file replacement]
because [specific reason].
```
Do NOT send another broad "fix it" prompt after one failure.

## 6. Founder workload rule

Founder runs ≤2 CMD commands per task cycle; more than that → package as a Claude Code block. Founder never manually edits source files or interprets raw build logs — Claude provides the verdict.

## 7. Claude-Code Autopilot Operator Mode

Default: Claude Code handles patch + verify + commit for non-visual tasks when the prompt explicitly authorizes it (authorization pattern and Gate rules: `CLAUDE_CODE_EXECUTION_PROTOCOL.md §8`). UI/visual tasks: patch + verify only, commit requires founder Gate 2 acceptance. Railway/Supabase: founder-only manual gate. CMD to founder is reserved for visual checks, Railway/Supabase gates, production verification, and emergency recovery.
