# FAILURE_MODES_AND_STOP_CONDITIONS.md — PolyProPicks

<!-- ACTIVATION POINT: When any stop condition is hit; when failure investigation needed -->
<!-- TOKEN LOADING RULE: Load at failure only. Tier 1. Do NOT load at session start. -->
<!-- OWNER: Claude Chat + Claude Code both enforce; Founder notified at STOP -->
<!-- REQUIRED OUTPUT FIELD: STOP CONDITION response format (see §3) mandatory when triggered -->
<!-- STOP/REJECT CONDITION: This file defines the stops — self-referential -->
<!-- MONITORING CHECK: Any stop condition hit must be logged in DRIFT_MONITORING_LOG -->

---

## § 1. Hard stop conditions — trigger immediately

Stop all work and output §3 format if ANY of these occur:

### Git / repo safety
1. `git status --short` shows unexpected dirty files (outside task scope)
2. `git diff --check` reports trailing whitespace before commit
3. Wrong branch detected in precheck
4. Build fails — treat as FAIL total, never partial success
5. Expected file or code block missing from repo

### Scope / zone violations
6. Task requires editing files outside `allowed_files[]`
7. UI changes become necessary during backend-only task
8. Backend changes become necessary during UI-only task
9. Payment/auth boundary unclear or changes needed without locked decision
10. Broad refactor becomes necessary to complete the task

### Evidence / verification failures
11. "Done" claimed without proof package (snippets + git status + build)
12. Cached API response being treated as fresh-generation proof (`cacheStatus: "hit"`)
13. Screenshot unchanged after claimed UI/CSS fix
14. Debug endpoint uses different mapper than code being verified
15. pairCount = 0 in fresh generation output without explanation

### Context / source failures
16. Source/context files conflict with each other
17. File path cannot be confirmed from repo — only from memory
18. `11_SOURCE_FILES_AND_REPO_INVENTORY.md` is stale (>7 days) and path unverifiable
19. `12_AGENT_STARTUP_PROTOCOL.md` not found in `/docs/ai-context/`
20. Env/secrets needed to continue

### Agent behavior failures
21. Founder asked to manually edit multiple source files
22. Second broad "fix it" prompt sent after one Claude Code failure without direct-source check
23. Mixed inspect + implement in same prompt for risky UI/CSS/data task
24. Monitoring audit skipped for significant patch task
25. Push/deploy attempted without explicit founder approval

---

## § 2. Failure modes — patterns that cause repeated waste

| Failure mode | Symptom | Root cause | Prevention |
|---|---|---|---|
| Patch before inspect | Wrong file or wrong block patched | Source assumed from memory | inspect-only task required first |
| Manual edit offload | "Open file X and replace..." | Claude offloads execution | Response validator — reject if manual edit instruction present |
| Raw CMD treadmill | Founder copies 5+ commands | Task not packaged as Claude Code | TASK_ROUTING_MATRIX: >5 commands → Claude Code block |
| False completion | "Done" without snippets/build | No required output gate | Gate 1 verdict mandatory in every patch response |
| Build = product acceptance | Build passes, UI still broken | Gates not separated | Gate 1 (technical) ≠ Gate 2 (visual/founder) |
| Cache confusion | `cacheStatus: hit` accepted as fresh proof | Not checking cacheStatus field | Gate 1A: always note cacheStatus; "hit" = CACHED ONLY |
| CSS blind patch | Wrong selector edited, screenshot unchanged | Active selector not inspected first | Inspect active className before any CSS patch |
| Type churn | TS errors patched in wrong type source | Source-of-truth type file not found | inspect-only for type errors first |
| Zone mixing | Backend task touches CSS or vice versa | allowed_files[] not enforced | STOP condition #6–8 |
| Scope creep | More files changed than expected | Prompt too broad | One zone per prompt; diff checked against allowed_files[] |
| Context drift | Claude stops following rules after long session | Passive context without enforcement gate | Paste CHAT_STARTER_PROMPT at session start; monitor agent after tasks |
| Repeated failed attempts | Same patch tried 3× without inspect | No direct-source check rule | After ONE failure: direct-source option check required |
| Stale context patch | Old memory used instead of current source | Source not inspected | Source beats memory — verify file before reference |

---

## § 3. Stop condition response format

When any §1 condition triggers, output exactly this:

```
STOP CONDITION: [condition number and name]

WHY STOPPED:
[specific reason — one sentence]

WHAT IS UNKNOWN:
[what cannot be confirmed without verification]

VERIFICATION NEEDED:
[exact command or file needed]

SAFE NEXT ACTION:
[one action only]

DO NOT:
- commit
- push
- continue patching
- send another broad prompt
```

---

## § 4. Recovery paths

| Stop condition | Recovery path |
|---|---|
| Unexpected dirty files | `git diff` to understand scope; explain to founder before continuing |
| Build fails | Read first error only; classify: type error / import error / logic error; inspect source-of-truth file |
| Wrong branch | `git checkout [correct branch]`; re-run precheck |
| Expected file missing | Verify path from repo tree directly; update `11_SOURCE_FILES_AND_REPO_INVENTORY.md` if stale |
| One failed Claude Code attempt | Direct-source option check — do NOT send another broad prompt |
| Cache hit blocking verification | Use debug/cache-bypass endpoint; note `NOT VERIFIED` if unavailable |
| Screenshot unchanged after CSS patch | Inspect active JSX className → find winning CSS selector → patch only that |
| Mixed zone needed | Split into two separate tasks; do backend first, UI second |
| Secrets needed | STOP; founder must provide via env only; never paste in chat |
| Monitoring skipped | Run `RULE_COMPLIANCE_MONITOR_AGENT.md` prompt before next task |

---

## § 5. Direct-source option check

Required output line after ANY Claude Code FAIL:

```
DIRECT-SOURCE OPTION CHECK:
[continue with Claude Code / request files for direct review /
 provide full-file replacement / inspect diff first]
because [specific reason].
```

Never send a second broad prompt without this line.

---

## § 6. Drift detection signals

If these patterns appear → paste `CHAT_STARTER_PROMPT.md` and name the violated rule:

- Response contains "Done" or "Fixed" without snippets
- Response contains "open file X and replace"
- Response missing `Gate 1 verdict`
- Response missing `git status --short`
- Task classified but wrong executor used
- Founder ran >2 CMD commands in one task cycle
- Same patch attempt made twice without inspect between
