# /refresh-ai-context — PolyProPicks AI Context Refresh Routine

## Purpose
Keep `docs/ai-context/` and `.claude/commands/` synchronized with the real production state after significant commits. Run after every multi-commit sprint or before starting a new phase.

## When to run
- After ≥3 significant commits land on main
- Before starting a new feature phase
- After any production incident or rollback
- After railway deploy state changes

## Steps

### 1. Capture git state
```bash
git branch --show-current
git status --short
git log --oneline -20
git diff --stat
```

### 2. Inspect current AI context docs
Read:
- `docs/ai-context/09_CONTEXT_DELTA_LOG.md` — check last entry date
- `docs/ai-context/01_PROJECT_CONTEXT_CURRENT.md` — check CURRENT STATE OVERRIDE date
- `docs/ai-context/02_CURRENT_TECH_STATE.md` — check "Last updated" header

### 3. Update delta log first
In `09_CONTEXT_DELTA_LOG.md`:
- Add a new `## ✅ [TOPIC] — YYYY-MM-DD` entry at the top (below the intro, above the previous entry)
- Include: HEAD, recent commits, feature state, accepted UI state, next priority

### 4. Update current state files
In `01_PROJECT_CONTEXT_CURRENT.md`:
- Replace or add `> ⚠️ CURRENT STATE OVERRIDE — YYYY-MM-DD` block
- Record HEAD, working tree state, completed features, next priority

In `02_CURRENT_TECH_STATE.md`:
- Update "Last updated" header date
- Update `## CURRENT STATE OVERRIDE` block
- Record recent commits, architecture changes, new system state

### 5. Update automation scorecard if session had ≥5 tasks
In `AUTOMATION_SCORECARD.md`:
- Add a new scored week block at top

### 6. Update product decisions if any locked decisions changed
In `04_PRODUCT_DECISIONS_LOCKED.md`:
- Add new locked items with date if founding product decisions were made

### 7. Verify docs-only diff
```bash
git diff --name-only
git diff --stat
git diff --check
```
STOP if any app/, components/, lib/, api/, public/assets, package.json, migrations appear.

### 8. Commit docs-only (if authorized)
```bash
git add docs/ai-context .claude/commands CLAUDE.md AGENTS.md
git diff --cached --name-only   # verify only docs
git commit -m "Docs: refresh AI context after [sprint name]"
git push origin main
```

## Stop conditions
- Any runtime source file in diff → STOP
- Cannot parse git log → STOP
- docs/ai-context/ directory missing → STOP, report to founder

## Notes
- Never delete existing delta log entries — only prepend
- "Git output beats this file" — always verify with live git commands
- This command file itself should be updated if the refresh routine changes
