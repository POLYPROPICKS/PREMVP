# refresh-ai-context

## Purpose

Refresh all docs/ai-context files to match current git history and current source files.
Prevents stale context from accumulating between Claude Code sessions.
Produces a dated refresh report and a compact Claude Chat upload pack.

This command is safe by design: it reads git history and source files, writes only to docs/ai-context/, and never touches app code, commits, deploys, or secrets.

---

## Inputs / $ARGUMENTS handling

`$ARGUMENTS` is an optional since-date in YYYY-MM-DD format.

- If `$ARGUMENTS` is provided (e.g. `2026-05-21`): use it as the since-date for `git log --since`.
- If `$ARGUMENTS` is empty: read `docs/ai-context/00_CONTEXT_INDEX_CURRENT.md` and extract the "Refreshed" or "Current as of" date from the file header. Use that date as the since-date.
- If no date can be inferred from `00_CONTEXT_INDEX_CURRENT.md`: fall back to `--oneline -30` (last 30 commits, no date filter).

Set `TODAY` = current date in YYYY-MM-DD format. All output files use `TODAY` in their names.

---

## Source of truth rule

**Git history and current source files are the ONLY source of truth.**

Existing docs/ai-context files are reference only — read them for prior decisions and locked rules, but never copy stale status, stale HEAD, stale routes, or stale deployment state into the refreshed output.

If a source file contradicts an existing doc, the source file wins.
If git log contradicts an existing doc, git log wins.

---

## Step 1 — Precheck

Run all of the following before making any edits:

```
git branch --show-current
git status --short
git log --oneline --decorate -30
git log --since="[SINCE_DATE] 00:00" --oneline --decorate
git diff --name-only HEAD~30..HEAD
```

Record the outputs. Use them as the basis for all doc updates.

Extract from precheck:
- Current branch
- HEAD commit hash and message
- Working tree status (clean / dirty / untracked)
- All commits since since-date (full list — do not summarize or truncate)
- All files changed since HEAD~30

---

## Step 2 — Inspect key source files

Read the following files to verify current state. Do not skip. Do not infer from memory.

**Feed and types:**
- `lib/feed/buildLandingCards.ts`
- `lib/feed/types.ts`
- `lib/feed/cacheGeneratedSignals.ts`
- `lib/feed/resolveSignalOutcome.ts` (if exists)

**Auth and payments:**
- `lib/auth/premiumSession.ts` (if exists)
- `lib/payments/whopCheckout.ts` (if exists)

**API routes — enumerate with Glob:**
- `app/api/**/*.ts`
- `app/**/page.tsx`

**Config:**
- `next.config.ts`
- `package.json` (start script only)
- `.railwayignore` (if exists)

**Existing context (reference only):**
- `docs/ai-context/04_PRODUCT_DECISIONS_LOCKED.md` — carry forward all locked decisions unchanged
- `docs/ai-context/00_CONTEXT_INDEX_CURRENT.md` — for prior refresh date only

---

## Step 3 — Refresh docs/ai-context

Update or rewrite each of the following files. Use git log and source file inspection as input. Do not copy stale status from existing docs.

### Files to refresh

| File | Action |
|---|---|
| `docs/ai-context/00_CONTEXT_INDEX_CURRENT.md` | Update header date, HEAD, all "current" table entries, known risks section |
| `docs/ai-context/01_PROJECT_CONTEXT_CURRENT.md` | Full rewrite from current source/git state |
| `docs/ai-context/02_CURRENT_TECH_STATE.md` | Full rewrite: routes, HEAD, build state, deployment, feed, Supabase, payment/auth |
| `docs/ai-context/03_CURRENT_SOURCE_ARCHITECTURE_MAP.md` | Full rewrite: all lib/, app/api/, app/pages, scripts, config |
| `docs/ai-context/04_PRODUCT_DECISIONS_LOCKED.md` | Carry forward all locked decisions verbatim. Append new decisions only if clear evidence in git. Do NOT remove or soften existing locked decisions. |
| `docs/ai-context/08_ENVIRONMENT_AND_CONNECTORS.md` | Update: Railway section, Supabase tables, API routes, env vars, auth/payment state |
| `docs/ai-context/09_CONTEXT_DELTA_LOG.md` | Prepend new dated section with full commit list, architecture changes, stale corrections, open items |
| `docs/ai-context/10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md` | Update active design tokens if changed. Do not modify Claude Design role or card lock rules. |
| `docs/ai-context/11_SOURCE_FILES_AND_REPO_INVENTORY.md` | Full rewrite: all source files, docs/ai-context inventory (current/reference/stale labels) |
| `docs/ai-context/TASK_ROUTING_MATRIX.md` | Update header date, fix any stale executor routing |
| `docs/ai-context/CONTEXT_HANDOFF_TEMPLATE.md` | Update date, verify handoff sections are complete |

### Files to create (dated)

- `docs/ai-context/AI_CONTEXT_REFRESH_REPORT_[TODAY].md` — precheck outputs, docs updated list, commits analyzed, source files inspected, stale assumptions corrected, unknowns table, next refresh triggers
- `docs/ai-context/CLAUDE_CHAT_UPLOAD_PACK_[TODAY].md` — compact single-file context: project summary, architecture summary, current state table, routing table, next work, what NOT to do, locked design principles

---

## Step 4 — Provider outage and deployment verification rules

Apply these rules to every deployment / production / Railway section written:

**Rule A — Never mark production as verified unless you performed a live verification in this task.**
Use wording: `NOT VERIFIED` or `VERIFIED — [date/command]`.

**Rule B — If Railway or any external provider is down or in recovery, do not blame PolyProPicks app code.**
Use wording: `NOT VERIFIED — blocked by [provider] external outage/recovery ([commit ref if available]).`
Add: `Attribution: [provider] platform, not PolyProPicks application code.`

**Rule C — Distinguish config issues from platform incidents.**
RAILPACK V3 is a Railway *config* issue (fixable by Nixpacks switch in Dashboard).
A Railway platform incident is a separate *external* event.
Document both separately. Do not merge them into one item.

**Rule D — Payment and auth states.**
Mark as `SHIPPED (on main)` only if source files exist and git commits prove it.
Mark production verification separately: `NOT VERIFIED in production` until live test confirms it.

**Rule E — Inferred Supabase schema.**
If a table was created by commit message inference only (no schema inspection): mark `INFERRED — NOT VERIFIED`.
If schema was directly inspected in this task: mark `VERIFIED — [date]`.

**Rule F — Signal Confidence / performance / win rate.**
Never add win rate %, guaranteed profit, ROI, or ML-grade language to any doc or card copy.
Formula version `trusted-initial-formula-v1.1` is deterministic/display-grade, NOT real ML.
Signal Confidence label must remain "Signal Confidence" — never "Win Probability".

---

## Step 5 — Verification

After all edits, run:

```
git status --short
git diff --stat
git diff --check
```

Expected:
- `git status --short`: only `M docs/ai-context/` and `?? docs/ai-context/` entries. No app/, lib/, components/, scripts/, docs/design/ changes.
- `git diff --stat`: only docs/ai-context/ files.
- `git diff --check`: EXIT 0. No trailing whitespace violations. (LF→CRLF warnings are acceptable — not whitespace errors.)

If `git diff --check` exits non-zero, identify the file and line, strip trailing whitespace, and re-run before reporting complete.

---

## Step 6 — Response format

Respond with exactly these items:

1. **Precheck outputs**: branch, HEAD, working tree status, commit count since since-date
2. **Docs updated**: table of file → action (CREATED / FULL REWRITE / UPDATED / UNCHANGED)
3. **Commits analyzed**: count, date range, first and last hash
4. **Source files inspected**: list
5. **Stale assumptions corrected**: table of old assumption → correction
6. **Unknowns / not verified**: table of item → status
7. **Verification**:
   - `git status --short` output
   - `git diff --stat` output
   - `git diff --check` result: EXIT 0 or FAIL + details
8. **Recommended next refresh triggers**: list of conditions

---

## Never do

- Edit `app/`, `components/`, `content/`, `lib/`, `scripts/`, `public/`
- Edit `docs/design/`
- Edit `.env`, `.env.local`, any secrets file
- Edit `CLAUDE.md`, `AGENTS.md` (read-only reference)
- Run `git commit`, `git push`, `railway up`, `railway deploy`, or any deploy command
- Run `npm run build` or `next build` as part of this command
- Modify Railway Dashboard settings (founder action only)
- Include secrets, API keys, token values in any doc
- Mark production verified without performing a live HTTP check in this task
- Remove or soften locked decisions in `04_PRODUCT_DECISIONS_LOCKED.md`
- Treat Claude Design output as source of truth for source files
- Treat this command's output as visual acceptance

---

## Stop conditions

Stop immediately and report if any of the following occur:

- Repo path cannot be resolved or is wrong
- `git status` shows unexpected changes in app/, lib/, components/, scripts/ before edits begin
- Any edit would require touching source files
- `git diff --check` exits non-zero and cannot be fixed by stripping trailing whitespace
- A locked decision in `04_PRODUCT_DECISIONS_LOCKED.md` would need to be removed to avoid contradiction — surface the contradiction instead, do not delete the decision
- Production is ambiguously described as "verified" without an actual live check in this task
