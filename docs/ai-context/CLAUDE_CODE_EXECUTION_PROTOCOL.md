# CLAUDE_CODE_EXECUTION_PROTOCOL.md — PolyProPicks Claude Code Execution Protocol

<!-- ACTIVATION POINT: Before every Claude Code implementation task -->
<!-- TOKEN LOADING RULE: Load at task start. Tier 1. -->
<!-- STOP/REJECT: response missing any required field → FAIL, not PASS -->

## 1. Token-saving executor mode (P0)

Claude Code is executor only, on small/medium patches:
- No long architecture prompts, no repeated project context
- No dev server start; no curl/API/production/debug-route checks unless explicitly requested
- No unrelated file reads; no broad investigation without explicit approval
- No commit/push by default; never touch files outside ALLOWED FILES
- STOP after ~5 min / ~5k tokens if the patch is incomplete; final output under 1200 characters unless explicitly requested otherwise

**STOP status format:**
```
STOP: [reason]
Files inspected: [list]
Blocker: [one line]
No edits / no commit / no push
```

## 2. Inspect-before-patch rule

Inspect-only FIRST when source is uncertain — any of: active CSS selector unknown, target file unknown, previous attempt failed, API/cache state unknown, type source unknown, component state wiring unknown, or no prior confirmed inspection for this task.

Inspect-only task: read files, return evidence, NO edits, recommend the smallest safe patch.

## 3. One zone per task

Zone allow/forbid rules are canonical in `TASK_ROUTING_MATRIX.md §3`. If a task requires crossing zones → STOP, split into separate tasks. Never rename existing classNames/props/types, change DOM nesting, or refactor JSX/CSS for cleanliness — only the requested targeted change.

## 4. Claude Code task prompt template (reusable)

```
TASK TYPE: [inspect-only / exact-patch / backend-API / frontend-UI / docs-context]
GOAL: [one concrete measurable outcome]
CURRENT VERIFIED STATE: branch / git status / last commit / build state
PRECHECK: git branch --show-current; git status --short; git log --oneline -3; [npm run build if implementation planned]
ALLOWED FILES: [exact paths]
FORBIDDEN FILES/CHANGES: [paths + reason]; no refactor; no renaming classNames/props/types; no commit/push/deploy
EXACT STEPS: [precheck → action → action → verification]
STOP CONDITIONS: branch unexpected; expected file/block missing; forbidden file must be edited; build fails (FAIL total); unexpected dirty files; scope exceeds allowed files
VERIFICATION COMMANDS: git status --short; git diff --stat; git diff --check; npm run build; [task-specific curl/Supabase check]
```

## 5. Required response schema (every patch task)

```
TASK TYPE: [classification]
PRECHECK: branch / status / log
FILES CHANGED: [path — allowed ✓ / NOT in allowed list ✗]
OLD SNIPPET ([path]): [exact code]
NEW SNIPPET ([path]): [exact code]
VERIFICATION: git status --short / git diff --stat / git diff --check / npm run build: PASS/FAIL / [api/curl if relevant]
ACCEPTANCE CRITERIA: [criterion]: met / failed / not verified
FOUNDER VISUAL CHECK REQUIRED: YES [action + viewport] / NO
RISKS: [risk or assumption]
STOP CONDITIONS ENCOUNTERED: none / [list]
GATE 1 VERDICT: PASS / FAIL / STOP
```

## 6. Inspect-only response schema

```
TASK TYPE: inspect-only
PRECHECK: branch / status
FILES INSPECTED: [path]
CURRENT STATE FOUND: [key findings]
ACTIVE WIRING: [data flow / selector / type / state]
SMALLEST SAFE NEXT PATCH: target file / target block / change
RISKS/UNCERTAINTIES: [...]
NO FILES EDITED. NO COMMIT. NO PUSH.
STOP CONDITIONS ENCOUNTERED: none / [list]
```

Required line after any Claude Code FAIL (do NOT send another broad prompt without it):
```
DIRECT-SOURCE OPTION CHECK:
[continue with Claude Code / request files for direct review / provide full-file replacement / inspect diff first]
because [specific reason].
```

## 7. Autopilot commit/push authorization

Prompt authorization pattern (include verbatim in non-visual task prompts):
```
FOUNDER AUTHORIZATION: For this non-visual task, if Gate 1 passes and only allowed files changed, you are authorized to commit. Do not push.
```
Non-visual: may commit if prompt authorizes + Gate 1 PASS + only allowed files changed. UI/visual: patch + verify only, commit requires founder Gate 2 acceptance. Push/deploy: explicit founder authorization per push. Proof package (status/diff stat/diff check/build/snippets/commit hash if committed) always required.

## 8. Production Programming / TDD Rule

For backend, API, parser, scoring, model, integration, script, reusable utility, and data-transform work — especially battle/production contours:
- Inspect existing tests and define expected behavior before editing.
- New or changed programmable logic must have unit or regression test coverage where a safe test target exists.
- Add/update the failing unit or regression test first, then implement the minimal passing change.
- Decompose core logic into named functions/modules/scripts.
- Core battle/production logic must live in versioned repo files, not only in prompts, terminal one-liners, ad-hoc snippets, or inline route/component bodies.
- Reusable scripts must be stored in the repo filesystem.
- Add safe structured logging for important failure paths and production/battle decisions.
- Logs must include useful context but never secrets, raw env values, private keys, tokens, or sensitive user data.
- Validate inputs at boundaries and never swallow errors silently.
- Run targeted tests, `npx tsc --noEmit`, and `npm run build` before Gate 1.
- If no safe test harness exists, STOP and propose the smallest harness; do not fake TDD.

## 9. Invalid response examples (rejected by monitoring agent)

❌ "Done." / "Build should pass." / "Acceptance criteria met." / "I fixed the issue."
❌ Any response without old/new snippets for code changes
❌ Any response without git status/build for patch tasks
❌ "Open the file and replace this block:" (manual edit instruction)
