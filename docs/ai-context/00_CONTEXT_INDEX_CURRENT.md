# 00_CONTEXT_INDEX_CURRENT.md — PolyProPicks AI Context Index

> Last refreshed: 2026-05-21
> Branch: main
> HEAD: 264500d Deploy: force Next.js standalone runtime
> git status: clean (except `?? docs/design/` — untracked design artifacts, intentional)

---

## Quick state summary

```
Product phase:   PREMVP — Payment + Feed + Evidence stack + Upcoming signals
Payment status:  Whop integration SHIPPED (not yet verified in production)
Auth status:     Magic-link + session SHIPPED
Premium page:    /premium route SHIPPED
Production:      NEEDS VERIFICATION — Railway RAILPACK/Caddy issue (see §Risks)
Next work:       Verify production, then Proof of Results card (Claude Design handoff)
```

---

## Context loading order for Claude Code

Load only what the task needs. Do not load all docs by default.

| Priority | File | When to load |
|---|---|---|
| Always | This file | Any session start |
| Always | `02_CURRENT_TECH_STATE.md` | Any code/API/deploy task |
| Always | `CLAUDE_CODE_EXECUTION_PROTOCOL.md` | Any Claude Code session |
| Always | `TASK_ROUTING_MATRIX.md` | Before routing any task |
| For product decisions | `04_PRODUCT_DECISIONS_LOCKED.md` | Before touching product copy, UI copy, signal copy |
| For architecture | `03_CURRENT_SOURCE_ARCHITECTURE_MAP.md` | Before touching feed, routes, components |
| For context handoff | `CONTEXT_HANDOFF_TEMPLATE.md` | Starting a new chat from prior session |
| For delta history | `09_CONTEXT_DELTA_LOG.md` | When catching up from a gap |
| For design work | `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md` | Any UI/CSS/card work |
| For file safety | `11_SOURCE_FILES_AND_REPO_INVENTORY.md` | Before touching any file outside normal scope |

---

## Which docs are current (as of 2026-05-21 refresh)

| File | Status | Last verified |
|---|---|---|
| `00_CONTEXT_INDEX_CURRENT.md` | ✅ CURRENT | 2026-05-21 |
| `01_PROJECT_CONTEXT_CURRENT.md` | ✅ REFRESHED | 2026-05-21 |
| `02_CURRENT_TECH_STATE.md` | ✅ REFRESHED | 2026-05-21 |
| `03_CURRENT_SOURCE_ARCHITECTURE_MAP.md` | ✅ REFRESHED | 2026-05-21 |
| `04_PRODUCT_DECISIONS_LOCKED.md` | ✅ REFRESHED | 2026-05-21 |
| `09_CONTEXT_DELTA_LOG.md` | ✅ APPENDED | 2026-05-21 |
| `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md` | ✅ REFRESHED | 2026-05-21 |
| `11_SOURCE_FILES_AND_REPO_INVENTORY.md` | ✅ REFRESHED | 2026-05-21 |
| `TASK_ROUTING_MATRIX.md` | ✅ REFRESHED | 2026-05-21 |
| `CLAUDE_CODE_EXECUTION_PROTOCOL.md` | ✅ CURRENT (no change needed) | 2026-05-15 |
| `CONTEXT_HANDOFF_TEMPLATE.md` | ✅ REFRESHED | 2026-05-21 |
| `AI_CONTEXT_REFRESH_REPORT_2026-05-21.md` | ✅ NEW | 2026-05-21 |
| `CLAUDE_CHAT_UPLOAD_PACK_2026-05-21.md` | ✅ NEW | 2026-05-21 |

---

## Which docs are historical/reference

| File | Status | Notes |
|---|---|---|
| `05_WINDSURF_WORKFLOW_RULES.md` | ⚠️ HISTORICAL | Windsurf replaced by Claude Code |
| `06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md` | 📖 REFERENCE | Lessons valid, phase context stale |
| `07_AI_AGENT_MIGRATION_CONTEXT.md` | 📖 REFERENCE | Migration complete |
| `08_ENVIRONMENT_AND_CONNECTORS.md` | ✅ REFRESHED — 2026-05-21 | Connectors/env updated for Whop/auth/session/Railway context |
| `12_AGENT_STARTUP_PROTOCOL.md` | 📖 REFERENCE | Still valid protocol |
| `CHAT_STARTER_PROMPT.md` | ⚠️ STALE | Product phase has changed significantly |
| `VERIFICATION_GATES.md` | 📖 REFERENCE | Gates still valid |
| `OPERATOR_ACCEPTANCE_CHECKLIST.md` | 📖 REFERENCE | Checklist still valid |
| `AUTOMATION_SCORECARD.md` | 📖 REFERENCE | Not yet scored |
| `DRIFT_MONITORING_LOG.md` | 📖 REFERENCE | Append on new drift events |
| `FAILURE_MODES_AND_STOP_CONDITIONS.md` | 📖 REFERENCE | Still valid |
| `MARKETSOURCECAROUSEL_INSPECT_PROMPT.md` | 📖 REFERENCE | Valid for that inspection phase |
| `RULE_COMPLIANCE_MONITOR_AGENT.md` | 📖 REFERENCE | Still valid |

---

## What to upload to Claude Chat / Cowork

Minimal context pack for a new advisory session:

1. `00_CONTEXT_INDEX_CURRENT.md` ← this file
2. `01_PROJECT_CONTEXT_CURRENT.md`
3. `02_CURRENT_TECH_STATE.md`
4. `04_PRODUCT_DECISIONS_LOCKED.md`
5. `CLAUDE_CHAT_UPLOAD_PACK_2026-05-21.md` (compact single-file summary)

Or use the compact pack only (`CLAUDE_CHAT_UPLOAD_PACK_2026-05-21.md`) for short advisory sessions.

---

## What feeds Claude Design

Upload from `docs/design/claude-design-source-pack/`:

- `polypropicks-claude-design-source-pack-2026-05-20.zip` (ready to upload)
- Contains: style baseline, card specs, design tokens, Proof of Results brief, prompt, source snippets

Do NOT upload `docs/ai-context/` files to Claude Design — they contain technical/workflow context not needed for visual design.

---

## Known risks at refresh time

- **Production railway deployment**: NOT VERIFIED — blocked by combination of Railway RAILPACK V3 config issue AND Railway external platform incident/recovery (2026-05-18/2026-05-20/21). RAILPACK V3 generates Caddy-only runtime; fix (`output: "standalone"`) committed at 264500d. Railway external incident: `eb7fe40 Deploy: retrigger PREMVP after Railway incident` (2026-05-18). Manual action required: Railway Dashboard → Change builder to Nixpacks → Redeploy. Production URL `https://polypropicks.com` status UNKNOWN. Attribution: Railway platform behaviour, not PolyProPicks application code.
- **Whop payment**: Integrated in code, not verified in production end-to-end.
- **Magic link auth**: Implemented, not verified in production.
- **signal-cache-cron**: Not redeployed after Railway incident — needs redeploy after production is verified.
