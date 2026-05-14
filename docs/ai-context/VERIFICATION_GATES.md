# VERIFICATION_GATES.md — PolyProPicks Verification Gates

<!-- ACTIVATION POINT: After every patch task; before every commit/deploy -->
<!-- TOKEN LOADING RULE: Load after patch. Tier 1. -->
<!-- OWNER: Claude Code (runs gates); Founder (accepts Gate 2) -->
<!-- REQUIRED OUTPUT FIELD: Gate 1 verdict required in every patch response -->
<!-- STOP/REJECT CONDITION: Any FAIL field = task FAIL total, not partial pass -->
<!-- MONITORING CHECK: Missing gate fields = compliance violation -->

## Gate 0 — Pre-change gate (before any edit)

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| git branch --show-current | Claude Code | Branch = expected | STOP — wrong branch |
| git status --short | Claude Code | Clean OR expected dirty files only | STOP — explain dirty state |
| Expected file exists | Claude Code | File found at exact path | STOP — file missing |
| Expected old block found | Claude Code | Exact block located in file | STOP — cannot proceed with exact replacement |
| Build state known | Claude Code | Last build result available | Run build or note UNKNOWN |

**Gate 0 FAIL = do not start editing.**

## Gate 1 — Post-patch gate (after edit, before commit)

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| Only allowed files changed | Claude Code | `git diff --stat` matches allowed_files[] | FAIL — investigate extra changes |
| Old/new snippets present | Claude Code | Both provided in response | FAIL — required output missing |
| git status --short | Claude Code | Expected dirty files only | STOP — unexpected dirty |
| git diff --stat | Claude Code | Expected files/line counts | Review if unexpected |
| git diff --check | Claude Code | No trailing whitespace | Fix before commit |
| npm run build | Claude Code | Exit 0 | FAIL total — do not continue |
| API/curl check | Claude Code (if API task) | Expected response shape | FAIL if broken |
| cacheStatus noted | Claude Code (if API task) | "hit" → CACHED ONLY noted | Flag if not noted |

**Gate 1 PASS required before commit gate.**
**Gate 1 FAIL = task FAIL. Stop. Do not commit. Report.**

## Gate 1A — Fresh-generation check (API/backend tasks only)

| Check | Pass condition | Verdict |
|---|---|---|
| cacheStatus field present in response | Field exists | If absent → mark uncertain |
| cacheStatus value | "miss" or "bypassed" = fresh confirmed | "hit" → CACHED ONLY — not fresh proof |
| Fresh-generation verified | Debug endpoint exists AND verifies the same generation path as production | If endpoint missing or uses different mapper → NOT VERIFIED (not FAIL) |
| pairCount > 0 | At least one pair generated fresh | FAIL if 0 without explanation |
| No futures/outrights in fresh output | Not present | FAIL if present |

**Gate 1A verdicts:**
- `FRESH VERIFIED` — debug endpoint confirmed same path, cacheStatus miss/bypassed
- `CACHED ONLY` — cacheStatus "hit"; contract sanity only, not fresh proof
- `NOT VERIFIED` — debug endpoint missing, unavailable, or uses different mapper;
  note explicitly: "fresh generation not confirmed; proceed with caution"
- `FAIL` — pairCount = 0 or forbidden market types present in fresh output

`NOT VERIFIED` is **not** a blocker for commit if task scope was contract/filter only.
`NOT VERIFIED` **IS** a blocker if task specifically claimed to fix generation logic.

## Gate 2 — Visual/business acceptance (founder only)

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| UI renders correctly | Founder | Browser at target viewport | Fix CSS; do not re-patch blindly |
| Mobile viewport verified | Founder | 390×700 or 428×760 | Required for all UI changes |
| CTA visible without scroll | Founder | Above fold at target viewport | CSS fix required |
| Business copy correct | Founder | Matches locked product decisions | Revert if wrong |
| Free signal visible | Founder | First card visible without login | STOP if blocked |
| Modal behavior correct | Founder | Opens on locked-feed tap; closes on secondary CTA | Fix modal handler |

**Gate 2 is Founder-only. Claude cannot accept Gate 2.**

## Gate 3 — Commit gate (before git commit)

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| Gate 1 passed | Claude Code | PASS | No commit |
| git diff --check clean | Claude Code | No warnings | Fix trailing whitespace first |
| Only intended files staged | Founder CMD | `git diff --stat` matches scope | Unstage extra files |
| Build passes | Claude Code | PASS | No commit |
| Founder explicit approval | Founder | Stated in message | No commit |

**Commit command provided by Claude; executed by Founder in CMD.**
**No exceptions: no commit without explicit founder approval.**

## Gate 4 — Deploy gate (before push/Railway deploy)

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| Gate 3 passed | Both | PASS | No deploy |
| Local API verified | Claude Code or CMD | Expected JSON shape | Fix first |
| Production concern noted | Claude Chat | Noted or N/A | Flag if relevant |
| Founder explicit deploy approval | Founder | Stated in message | No deploy |

**Push is always Founder CMD. Claude provides command; Founder executes.**

## Gate D — Docs / workflow artifact gate (docs-context tasks only)

Applies when: updating `/docs/ai-context/` files, creating new contour artifacts,
updating `CLAUDE.md` / `AGENTS.md`.

| Check | Who | Pass condition | Action on fail |
|---|---|---|---|
| Only docs/ files changed | Claude Code/Chat | `git diff --stat` shows only `/docs/` or root md paths | FAIL — source files must not be touched |
| No source files staged | Founder CMD | `git status` shows no app/lib/components changes | Unstage source files |
| docs/ not mixed with source commit | Both | Separate commit for docs vs source | Split into two commits |
| Content does not expose secrets | Claude Chat review | No env vars, tokens, passwords in text | Remove before commit |
| Updated artifact references existing files | Claude Chat | All file paths cited exist in repo | Fix broken references |

**Gate D FAIL = docs commit blocked. Does not affect source Gates 1–4.**
**Gate D is independent — pass/fail does not propagate to Gate 1.**

## Gate verdict format

```
GATE 0: PASS / FAIL / STOP
GATE 1: PASS / FAIL / STOP
  - Only allowed files changed: YES / NO
  - Snippets present: YES / NO
  - git status clean: YES / NO — [output]
  - git diff --stat: [output]
  - git diff --check: CLEAN / [issues]
  - npm run build: PASS / FAIL
GATE 1A (if API task): FRESH VERIFIED / CACHED ONLY / NOT VERIFIED / FAIL
GATE 2: [Founder pending / PASS / FAIL]
GATE 3: [Pending founder approval / PASS]
GATE 4: [Pending founder approval / PASS]
GATE D (if docs task): PASS / FAIL

OVERALL: PASS — safe to commit / FAIL — stop / HOLD — awaiting gate
```
