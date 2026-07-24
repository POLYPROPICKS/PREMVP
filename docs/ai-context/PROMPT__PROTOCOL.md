# PROMPT__PROTOCOL

## Status
Mandatory operating protocol for PolyProPicks / PREMVP and Weather Model 1.

## Purpose
Reduce token waste, prevent repeated context loading, and continue executor work from verified checkpoints instead of restarting phases after every STOP.

## Rules

1. **New thread / new task**
   - Read the mandatory instruction layer once.
   - Load only task-relevant project context.

2. **Continuation after STOP**
   - Continue from the verified checkpoint.
   - Do not repeat the original long executor prompt.
   - Do not reread the full Markdown instruction layer.

3. **Continuation prompt must contain only**
   - verified repo, branch and base SHA;
   - completed gates;
   - current blocker;
   - newly authorized operation;
   - exact verification commands;
   - stop conditions;
   - commit / push / deploy mode.

4. **Selective rereading**
   - Reread only files that changed since the checkpoint or are directly relevant to the blocker.
   - Do not repeat roadmap, history, architecture or already accepted requirements.

5. **Worktree dependency rule**
   - A new worktree may not contain `node_modules`.
   - Permit `npm ci` only when explicitly authorized.
   - Use the existing lockfile.
   - Do not modify `package-lock.json`.
   - Do not add, remove or upgrade dependencies.

6. **Executor prompt minimum**
   - TASK CLASSIFICATION
   - EXECUTION MODE / MODEL
   - VALUE OF THIS STEP
   - CURRENT PHASE
   - NEXT TWO STEPS
   - ALLOWED FILES / ACTIONS
   - FORBIDDEN FILES / ACTIONS
   - STOP CONDITIONS
   - EVIDENCE / VERIFICATION
   - COMMIT / PUSH / DEPLOY / PR mode

7. **After executor STOP**
   - Authorize only the blocked operation.
   - Resume from the exact failed gate.
   - Do not restart inspection, reconciliation, TDD or implementation already completed.

8. **Handoff rule**
   - Include `PROMPT__PROTOCOL` in every relevant context handoff.
   - Preserve the exact protocol name: `PROMPT__PROTOCOL`.
   - Add it to the canonical project instruction layer or appropriate agent instructions.

9. **Founder and executor boundary**
   - The Founder does not manually edit repository files.
   - Repository changes use bounded executor prompts and atomic commits.

## REVIEW_COST_PROTOCOL

1. Independent review is mandatory for high-risk or milestone programming changes; use Luna by default for bounded review.
2. Use one full bounded review per milestone. After corrections, use targeted delta-review only.
3. A delta-review receives the previous rejected HEAD, corrected HEAD, exact blocking findings, exact changed files, and targeted tests only.
4. Do not reread the full roadmap or unrelated Markdown during delta-review. Do not rerun unaffected build, TypeScript, Liquidity, or other regression suites when writer evidence is retained, relevant files did not change, and Git evidence proves the boundary.
5. Prefer Git diff, commit boundaries, targeted tests, and explicit stop conditions. Never invent token counts or costs; when exact counters are unavailable, record `TOKEN_USAGE: NOT_MEASURED`.
6. The operator does not manually edit repo files, protocols, cost logs, or acceptance records. All repo updates use bounded executor prompts and atomic commits.
7. Route every executor instruction using only `ТЕКУЩИЙ ЧАТ` or `НОВЫЙ ЧАТ`; never tell the Founder to find or remember a prior thread by title.
8. Recommended delta-review budget: maximum 12 files, maximum two targeted test commands, no broad repo search, and a final response under 500 words. If more scope is required, return `BUDGET_EXCEEDED` with the exact additional evidence required.

## Weather workspace
`C:\WORK\KalshiProPulse\sipropicks-weather-model-1`
