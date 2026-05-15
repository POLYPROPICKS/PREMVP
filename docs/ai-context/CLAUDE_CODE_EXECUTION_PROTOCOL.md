# CLAUDE_CODE_EXECUTION_PROTOCOL.md — PolyProPicks Claude Code Execution Protocol

---

## CRITICAL TOKEN ECONOMY OVERRIDE — 2026-05-15

Claude Pro session capacity is scarce.
Claude Code is executor only.

- Must NOT receive long architecture prompts
- Must NOT repeat project context
- Must NOT perform broad investigation unless explicitly approved
- Must NOT run dev server, curl/API checks, production checks, or debug route archaeology unless explicitly requested
- Must NOT commit or push by default
- Must NOT touch files outside ALLOWED FILES
- Final output must be under 1200 characters unless explicitly requested

**Default Claude Code mode:**
```
MODEL: Sonnet 4.6 Adaptive.
MODE: token-saving executor.
Answer in Russian. Code in English.
No architecture explanation.
No commit/push.
No broad search.
Stop if more than allowed files are needed.
Stop if target block is not found.
Stop if source shape is uncertain.
Stop if task exceeds ~5 minutes without patch completion.
Stop if token use would exceed ~5k on a small/medium patch.
Return short status only when stopped.
```

---

<!-- ACTIVATION POINT: Before every Claude Code implementation task -->
<!-- TOKEN LOADING RULE: Load at task start. Tier 1. -->
<!-- OWNER: Claude Chat (generates prompts); Claude Code (executes) -->
<!-- REQUIRED OUTPUT FIELD: Full response format §4 — no exceptions for patch tasks -->
<!-- STOP/REJECT CONDITION: Response missing any critical field → FAIL, not PASS -->
<!-- MONITORING CHECK: Audited by RULE_COMPLIANCE_MONITOR_AGENT after significant tasks -->

## 1. Inspect-before-patch rule

**When source is uncertain → inspect-only task FIRST.**

Uncertain = any of these:
- Active CSS selector unknown
- Which file contains the target block is unknown
- Previous attempt failed
- API/cache state unknown
- TypeScript type source unknown
- State wiring between components unknown
- No previous confirmed source inspection for this task

Inspect-only task: read files, return evidence, NO edits, recommend smallest patch.

## 2. One zone per task rule

| If task is... | Allowed zone | Forbidden zones |
|---|---|---|
| UI/CSS | components/, CSS modules, app/globals.css | lib/feed/, app/api/, payment |
| Backend/feed | lib/feed/, app/api/feed/ | components/, CSS, payment |
| Payment/auth | explicitly scoped files only | UI, feed, unrelated Supabase |
| Docs | /docs/ai-context/ | all source files |

If task requires crossing zones → STOP, split into separate tasks.

## 3. Reusable Claude Code task prompt template

```
═══════════════ CLAUDE CODE TASK ═══════════════

TASK TYPE: [inspect-only / exact-patch / backend-API / frontend-UI / docs-context]
MODEL: Sonnet 4.6 Adaptive

GOAL:
[One concrete measurable outcome in one sentence]

CURRENT VERIFIED STATE:
Branch: [branch name]
Git status: [clean / list of known dirty files]
Last commit: [hash + message]
Build state: [PASS / FAIL / NOT RUN]

PRECHECK (run before any edit):
  git branch --show-current
  git status --short
  git log --oneline -3
  [npm run build — only if implementation planned]

EXPECTED PRECHECK OUTPUT:
  Branch: [expected]
  Status: [clean / list of expected dirty files]

ALLOWED FILES:
  - [exact/path/file.ts]
  - [exact/path/file.css]

FORBIDDEN FILES / FORBIDDEN CHANGES:
  - Do NOT edit [path] — [reason]
  - Do NOT touch UI/CSS — backend task
  - Do NOT touch lib/feed/ — UI task
  - Do NOT refactor
  - Do NOT rename classNames/props/types
  - Do NOT commit/push/deploy

EXACT STEPS:
  1. [Run precheck]
  2. [Specific action]
  3. [Specific action]
  4. [Run verification]

CRITICAL PRESERVATION RULES:
  - Do not rename existing classNames
  - Do not change existing DOM nesting
  - Do not refactor JSX/CSS structure for cleanliness
  - Do not rewrite working layout
  - Only perform the requested targeted change
  - If requested change requires DOM structure change: STOP and report why before editing

STOP CONDITIONS:
  - Branch unexpected → STOP
  - Expected file/block missing → STOP
  - Forbidden file must be edited → STOP
  - Build fails → FAIL total (not partial success)
  - Unexpected dirty files → STOP
  - Task requires changes outside allowed files → STOP
  - [task-specific stop condition]

VERIFICATION COMMANDS (run after edit):
  git status --short
  git diff --stat
  git diff --check
  npm run build
  [task-specific: curl / Supabase check if needed]

RESPONSE FORMAT REQUIRED:
  1. Precheck result
     - branch:
     - git status --short:
     - log:
  2. Files changed (each file: path + allowed/forbidden status)
  3. Old snippet (exact, with file path)
  4. New snippet (exact, with file path)
  5. Verification
     - git status --short:
     - git diff --stat:
     - git diff --check:
     - npm run build: PASS / FAIL
  6. Acceptance criteria: met / not verified / failed
  7. Founder visual check: YES — [exact what to check, which viewport] / NO
  8. Risks / unverified assumptions
  9. Stop conditions encountered: none / [list]
  10. Gate 1 verdict: PASS / FAIL / STOP

HUMAN ACCEPTANCE REQUIRED:
  [ ] Gate 1 (build + diff + code) — Claude Code verdict above
  [ ] Gate 2 (visual/business) — Founder acceptance [if relevant]

═══════════════ END CLAUDE CODE TASK ═══════════════
```

## 4. Required response schema (for every patch task)

```
TASK TYPE: [classification]

PRECHECK:
  branch: [output]
  status: [output]
  log: [output]

FILES CHANGED:
  - [path] — [allowed ✓ / NOT in allowed list ✗]

OLD SNIPPET ([path]):
  [exact code]

NEW SNIPPET ([path]):
  [exact code]

VERIFICATION:
  git status --short: [output]
  git diff --stat: [output]
  git diff --check: [output — or "clean"]
  npm run build: PASS / FAIL
  [api/curl if relevant]: [output]

ACCEPTANCE CRITERIA:
  [criterion 1]: met / failed / not verified
  [criterion 2]: met / failed / not verified

FOUNDER VISUAL CHECK REQUIRED: YES / NO
  [if YES: exact action + viewport]

RISKS:
  - [risk or assumption]

STOP CONDITIONS ENCOUNTERED: none / [list]

GATE 1 VERDICT: PASS / FAIL / STOP
```

## 5. Inspect-only response schema

```
TASK TYPE: inspect-only

PRECHECK:
  branch: [output]
  status: [output]

FILES INSPECTED:
  - [path]

CURRENT STATE FOUND:
  [key finding 1]
  [key finding 2]

ACTIVE WIRING:
  [data flow / selector / type / state]

SMALLEST SAFE NEXT PATCH:
  Target file: [path]
  Target block: [description or exact block]
  Change: [description]

RISKS / UNCERTAINTIES:
  -

NO FILES EDITED.
NO COMMIT. NO PUSH.

STOP CONDITIONS ENCOUNTERED: none / [list]
```

## 6. Direct-source check (after one failed attempt)

Required output line after any Claude Code FAIL:

```
DIRECT-SOURCE OPTION CHECK:
[continue with Claude Code / request files for direct review /
 provide full-file replacement / inspect diff first]
because [specific reason].
```

Do NOT send another broad prompt without this line.

## 7. Invalid response examples (will be rejected by monitoring agent)

❌ "Done."
❌ "Build should pass."
❌ "Acceptance criteria met."
❌ "I fixed the issue."
❌ Any response without old/new snippets for code changes
❌ Any response without git status/build for patch tasks
❌ "Open the file and replace this block:" (manual edit instruction)
