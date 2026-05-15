# TASK_ROUTING_MATRIX.md — PolyProPicks Task Routing

---

## Token Economy Routing — 2026-05-15

- ChatGPT compresses and formats the task into a bounded execution spec
- Claude Code receives only the bounded spec — no project history, no broad roadmap
- Research, architecture decisions, and roadmap planning stay in ChatGPT or scarce Claude Chat sessions
- Claude Code executes the final bounded prompt only
- Claude Code does not receive context it doesn't need to execute the patch

---

<!-- ACTIVATION POINT: Before every task — determines who executes and in what format -->
<!-- TOKEN LOADING RULE: Load at task start. Tier 1. -->
<!-- OWNER: Claude Chat (applies rules); Founder (approves routing) -->
<!-- MONITORING CHECK: Every response must state EXECUTION MODE explicitly -->
<!-- REQUIRED OUTPUT FIELD: TASK CLASSIFICATION + EXECUTION MODE in every response -->
<!-- STOP/REJECT CONDITION: If task type is ambiguous — classify as inspect-only before proceeding -->

## 1. Decision rule summary

```
≤5 simple git/build/curl commands           → Direct CMD
>5 commands OR multi-step verification      → Claude Code block
Source uncertain + patch planned            → inspect-only FIRST
UI/CSS work                                 → inspect-only FIRST, then patch
Product/visual decision                     → Founder only
Payment/auth architecture                   → Claude Chat review + Founder approval
Push/deploy                                 → Founder only (explicit approval)
Any code edit                               → Claude Code (not founder manual)
```

## 2. Routing table

| Task type | Direct CMD | Claude Code | Claude Chat | Founder only | Notes |
|---|:---:|:---:|:---:|:---:|---|
| `git status --short` | ✓ | | | | 1 command |
| `git log --oneline -5` | ✓ | | | | 1 command |
| `git branch --show-current` | ✓ | | | | 1 command |
| `npm run build` | ✓ | | | | 1 command |
| `git diff --stat` / `--check` | ✓ | | | | 1–2 commands |
| Simple curl to one endpoint | ✓ | | | | 1 command |
| git add + commit (command only) | ✓ | | | ✓ approval | Founder runs CMD, Claude provides exact command |
| git push | | | | ✓ | Founder explicit approval always |
| Source file inspection (uncertain) | | ✓ inspect-only | | | inspect-only mode — no edits |
| Single-file exact patch | | ✓ | ✓ plan | | Claude Chat plans, Claude Code executes |
| Multi-file patch | | ✓ | ✓ plan | | Must have explicit allowed_files[] per zone |
| CSS/UI debugging | | ✓ inspect first | ✓ | | ALWAYS inspect active selectors before patch |
| API response debugging | | ✓ | | | Cache vs fresh — cacheStatus required |
| TypeScript/type inspection | | ✓ inspect-only | | | Find source-of-truth type file first |
| Architecture review | | | ✓ | | Chat-only unless source files needed |
| Payment/auth architecture | | | ✓ | ✓ approval | High-risk; Founder decision required |
| Visual acceptance | | | | ✓ | Browser/screenshot only — not Claude judgment |
| Product/copy/pricing decisions | | | | ✓ | Business decision — not automatable |
| Context handoff | | | ✓ | | Claude Chat prepares using CONTEXT_HANDOFF_TEMPLATE |
| Claude Code prompt writing | | | ✓ | | Claude Chat produces prompt; Founder pastes |
| Monitoring-agent audit | | | ✓ | | Claude Chat runs RULE_COMPLIANCE_MONITOR_AGENT |
| Artifact update (docs) | | | ✓ | | Claude Chat updates /docs/ai-context/ content |
| Build + diff + commit flow (>5 cmds) | | ✓ | | ✓ approval | Package as Claude Code block |
| Production verification | ✓ curl | | | ✓ decision | Separate from local build check |
| Railway/Supabase config changes | | | | ✓ | Founder only; env-deploy scope |
| Regression check (multiple routes) | | ✓ | | | Inspect + curl in Claude Code block |

## 3. Zone rules

```
UI/frontend task    → allowed: components/, app/globals.css, CSS modules
                    → forbidden: lib/feed/, app/api/, Supabase

Backend/feed task   → allowed: lib/feed/, app/api/feed/
                    → forbidden: components/, CSS files, payment

Payment/auth task   → allowed: only explicitly scoped files
                    → forbidden: UI, feed, unrelated Supabase tables

Docs/context task   → allowed: /docs/ai-context/
                    → forbidden: all source files, no commits mixed with source
```

**Zone mixing = STOP.** If backend task starts requiring CSS changes → stop, split task.

## 4. Escalation path

```
CMD → fails or ambiguous         → Claude Code inspect-only
Claude Code inspect → no patch   → Claude Chat analysis
Claude Code patch → fails once   → Direct-source check (not another broad prompt)
Direct-source check → still fail → Founder decision + explicit scope reset
Product/visual boundary reached  → Founder only
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

Founder should run ≤2 CMD commands per task cycle.
If more are needed → package as Claude Code block.
Founder never manually edits source files.
Founder never interprets raw build logs — Claude provides verdict.
