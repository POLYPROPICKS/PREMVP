# /verify — PolyProPicks Gate Verification

This is a Claude Code custom slash command for PolyProPicks.
It is not a skill, not a hook, and not a deployment command.

## Usage

- `/verify full` — full Gate 1 verification, always runs `npm run build`
- `/verify docs` — docs/config verification, never runs build
- `/verify` — default; auto-detects changed paths and runs build only when source/runtime files changed

## Mode detection

Read `$ARGUMENTS`.

- If `$ARGUMENTS` contains `full`, run FULL mode.
- If `$ARGUMENTS` contains `docs`, run DOCS mode.
- Otherwise run DEFAULT mode.

## Rules

- Do not commit.
- Do not push.
- Do not deploy.
- Do not run dev server.
- Do not run curl/API/debug-route checks.
- Do not edit files.
- Do not claim PASS without command output.
- `git diff --check` errors mean FAIL regardless of mode.
- In FULL mode, `npm run build` failure means FAIL.
- In DOCS mode, never run build.
- In DEFAULT mode, auto-detect build requirement from changed paths (see below).
- Commit permission is YES only when OVERALL is PASS and working tree is dirty (changes exist to commit).
- Commit permission is NO when OVERALL is FAIL or HOLD, or when working tree is clean.

## Commands to run

Always run:

```cmd
git branch --show-current
git status --short
git log --oneline -3
git diff --stat
git diff --check
```

In FULL mode, also run:

```cmd
npm run build
```

In DEFAULT mode, inspect changed paths from `git status --short` output, then conditionally run:

```cmd
npm run build
```

## DEFAULT mode — auto-build detection

After running git checks, inspect every changed path.

### Run build automatically if any changed path matches:

- `app/` — Next.js app routes, pages, API routes
- `components/` — UI components
- `lib/` — shared libraries, feed logic, auth helpers
- `content/` — static content consumed at build time
- `scripts/` — generation scripts that affect cached data
- `public/` — only if file is a JS/JSON/manifest (skip pure images)
- `middleware.ts` or `middleware.js`
- `next.config.*`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `eslint.config.*`
- `.env` or `.env.local` (treat as config change, build may reflect new env vars)

### Do NOT run build if all changed paths are:

- `*.md` files anywhere
- `docs/` directory
- `.claude/commands/` directory
- `README*`
- `*.txt` workflow notes
- `AGENTS.md`, `CLAUDE.md`, `TASK*.md`

### Return HOLD if:

- Changed paths include a mix of build-required and docs-only files and intent is unclear
- A changed path does not match any known category above
- Working tree has untracked files with unknown extensions in root or source directories

## Verdict logic

### FULL mode

PASS if:
- `git diff --check` is clean
- `npm run build` passes

FAIL if:
- `git diff --check` reports errors
- `npm run build` fails
- unexpected command failure occurs

### DOCS mode

PASS if:
- `git diff --check` is clean
- changed files are docs/config/markdown/local automation only

HOLD if:
- source/runtime files appear changed
- build may be required

FAIL if:
- `git diff --check` reports errors
- unexpected command failure occurs

### DEFAULT mode

PASS if (build ran):
- `git diff --check` is clean
- `npm run build` passes

PASS if (build skipped — clean tree):
- working tree is clean
- `git diff --check` is clean

PASS if (build skipped — docs only):
- `git diff --check` is clean
- all changed paths are docs/markdown/local automation only

HOLD if:
- source/runtime files changed and build was not run (should not happen with auto-detection — only if path category was unclear)
- changed path category is unknown
- caller should use `/verify full` to be safe

FAIL if:
- `git diff --check` reports errors
- `npm run build` ran and failed
- unexpected command failure occurs

## Required response format

```
TASK CLASSIFICATION: verification
EXECUTION MODE: Claude Code custom slash command
MODE DETECTED: full / docs / default

AUTO BUILD DECISION: RUN / SKIP / HOLD
BUILD REASON: [why build ran, was skipped, or is held — list matched paths if applicable]

GATE 0 RETROSPECTIVE:
- branch:
- working tree before verification:
- latest commit:
- scope clarity: clear / unclear

GATE 1 FIELDS:
- git status --short:
- git diff --stat:
- git diff --check:
- npm run build: PASS / FAIL / NOT RUN

OVERALL: PASS / FAIL / HOLD
commit permission: YES / NO

FOUNDER NEXT ACTION:
- [one exact action]

NOTES:
- [only if needed]
```

## Founder next action examples

If PASS and changes exist:
- "Review changed files, then commit only intended files."

If PASS and clean:
- "No commit needed. Continue next task."

If HOLD:
- "Run `/verify full` before commit, or clarify this is docs/config-only."

If FAIL:
- "Fix the reported issue first. Do not commit."
