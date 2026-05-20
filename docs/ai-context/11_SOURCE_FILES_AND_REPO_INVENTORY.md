# 11_SOURCE_FILES_AND_REPO_INVENTORY.md — PolyProPicks

> Refreshed: 2026-05-21
> Source of truth: git log + file system.
> Prior 2026-05-14 delta override superseded by this refresh.

---

## Git state at refresh

```
HEAD:    264500d Deploy: force Next.js standalone runtime
Origin:  synced
Working tree: clean (docs/design/ untracked — intentional)
```

---

## app/ routes

| File | Status |
|---|---|
| `app/page.tsx` | ✅ ACTIVE — thin wrapper |
| `app/reconstruction/page.tsx` | ✅ ACTIVE — main landing |
| `app/reconstruction/Reconstruction.module.css` | ✅ ACTIVE |
| `app/premium/page.tsx` | ✅ ACTIVE NEW |
| `app/premium/Premium.module.css` | ✅ ACTIVE NEW |
| `app/checkout/complete/page.tsx` | ✅ ACTIVE NEW |
| `app/checkout/complete/CheckoutComplete.module.css` | ✅ ACTIVE NEW |
| `app/globals.css` | ✅ ACTIVE — DO NOT TOUCH |
| `app/layout.tsx` | ✅ ACTIVE |

## app/reconstruction/ backup files

| File | Status |
|---|---|
| `page.before-forced-icons.tsx` | 📦 BACKUP — do not edit |
| `page.before-icons.tsx` | 📦 BACKUP — do not edit |
| `page.broken.tsx` | 📦 BACKUP — do not edit |
| `page.phase1-trust-before.tsx` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-forced-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.broken.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.phase1-trust-before.css` | 📦 BACKUP — do not edit |

---

## app/api/ routes

| File | Status |
|---|---|
| `app/api/feed/landing-cards/route.ts` | ✅ ACTIVE |
| `app/api/feed/debug-evidence-generation/route.ts` | ✅ ACTIVE (dev) |
| `app/api/feed/debug-sports-cards/route.ts` | ✅ ACTIVE (dev) |
| `app/api/feed/debug-sports-discovery/route.ts` | ✅ ACTIVE (dev) |
| `app/api/feed/debug-resolve-signals/route.ts` | ✅ ACTIVE NEW (dev) |
| `app/api/leads/route.ts` | ✅ ACTIVE |
| `app/api/checkout/create/route.ts` | ✅ ACTIVE NEW |
| `app/api/webhooks/whop/route.ts` | ✅ ACTIVE NEW |
| `app/api/entitlement/check/route.ts` | ✅ ACTIVE NEW |
| `app/api/auth/session/route.ts` | ✅ ACTIVE NEW |
| `app/api/auth/magic-link/request/route.ts` | ✅ ACTIVE NEW |
| `app/api/auth/magic-link/verify/route.ts` | ✅ ACTIVE NEW |

---

## components/

| File | Status |
|---|---|
| `components/cards/PremiumEventCard.tsx` | ✅ ACTIVE — DO NOT MODIFY |
| `components/cards/PremiumEventCard.module.css` | ✅ ACTIVE — DO NOT MODIFY |
| `components/cards/MarketSourceCard.tsx` | ✅ ACTIVE — DO NOT MODIFY |
| `components/cards/MarketSourceCard.module.css` | ✅ ACTIVE — DO NOT MODIFY |
| `components/carousels/PremiumEventCarousel.tsx` | ✅ ACTIVE |
| `components/carousels/MarketSourceCarousel.tsx` | ✅ ACTIVE |
| `components/modals/PassOfferModal.tsx` | ✅ ACTIVE — DO NOT TOUCH |
| `components/modals/PassOfferModal.module.css` | ✅ ACTIVE — DO NOT TOUCH |

---

## lib/feed/

| File | Status | Notes |
|---|---|---|
| `buildLandingCards.ts` | ✅ ACTIVE — PRIMARY GENERATOR | |
| `cacheGeneratedSignals.ts` | ✅ ACTIVE | market_sources field present |
| `resolveSignalOutcome.ts` | ✅ ACTIVE NEW | outcome resolution (YES/NO/VOID) |
| `discoverSportsMarkets.ts` | ✅ ACTIVE | sports market discovery |
| `landingPairs.ts` | ✅ ACTIVE | LandingPair canonical helpers |
| `normalizePolymarket.ts` | ✅ ACTIVE | |
| `polymarketClient.ts` | ✅ ACTIVE | |
| `scorePolymarket.ts` | ✅ ACTIVE | |
| `types.ts` | ✅ ACTIVE | includes upcomingPairs, signalStatus |
| `buildSportsLandingCards.ts` | ⚠️ SUPERSEDED | Not called by cron. Import graph NOT VERIFIED. Do NOT delete. |

## lib/auth/ + lib/payments/

| File | Status |
|---|---|
| `lib/auth/premiumSession.ts` | ✅ ACTIVE NEW |
| `lib/payments/whopCheckout.ts` | ✅ ACTIVE NEW |

---

## scripts/

| File | Status |
|---|---|
| `scripts/generate-signals.ts` | ✅ ACTIVE — cron job |
| `scripts/resolve-signals.ts` | ✅ ACTIVE NEW — batch signal resolution |

---

## content/

| File | Status |
|---|---|
| `content/signals.ts` | ✅ ACTIVE — static fallback |
| `content/marketSources.ts` | ✅ ACTIVE — static fallback + card type definitions |
| `content/section-headings.ts` | ✅ ACTIVE |

---

## config / root files

| File | Status | Notes |
|---|---|---|
| `next.config.ts` | ✅ ACTIVE | `output: "standalone"` added 264500d |
| `package.json` | ✅ ACTIVE | start = `node .next/standalone/server.js` |
| `.railwayignore` | ✅ ACTIVE NEW | excludes local artifacts |
| `CLAUDE.md` | ✅ ACTIVE | Claude Code repo-level instructions |
| `AGENTS.md` | ✅ ACTIVE | Agent startup instructions |
| `AUTOMATION_MODE_HANDOFF.md` | ✅ ACTIVE | Automation mode handoff doc |
| `.env.local` | 🔒 NOT COMMITTED | local env |
| `.env` | 🔒 GITIGNORED | |

---

## docs/ai-context/ — current inventory

| File | Status |
|---|---|
| `00_CONTEXT_INDEX_CURRENT.md` | ✅ CURRENT — 2026-05-21 |
| `01_PROJECT_CONTEXT_CURRENT.md` | ✅ REFRESHED — 2026-05-21 |
| `02_CURRENT_TECH_STATE.md` | ✅ REFRESHED — 2026-05-21 |
| `03_CURRENT_SOURCE_ARCHITECTURE_MAP.md` | ✅ REFRESHED — 2026-05-21 |
| `04_PRODUCT_DECISIONS_LOCKED.md` | ✅ REFRESHED — 2026-05-21 |
| `05_WINDSURF_WORKFLOW_RULES.md` | ⚠️ HISTORICAL — Windsurf replaced |
| `06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md` | 📖 REFERENCE — lessons valid |
| `07_AI_AGENT_MIGRATION_CONTEXT.md` | 📖 REFERENCE — migration complete |
| `08_ENVIRONMENT_AND_CONNECTORS.md` | ⚠️ STALE — Whop vars not documented |
| `09_CONTEXT_DELTA_LOG.md` | ✅ APPENDED — 2026-05-21 |
| `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md` | ✅ REFRESHED — 2026-05-21 |
| `11_SOURCE_FILES_AND_REPO_INVENTORY.md` | ✅ REFRESHED — 2026-05-21 (this file) |
| `12_AGENT_STARTUP_PROTOCOL.md` | 📖 REFERENCE |
| `AI_CONTEXT_REFRESH_REPORT_2026-05-21.md` | ✅ NEW — 2026-05-21 |
| `CLAUDE_CHAT_UPLOAD_PACK_2026-05-21.md` | ✅ NEW — 2026-05-21 |
| `CLAUDE_CODE_EXECUTION_PROTOCOL.md` | ✅ CURRENT |
| `TASK_ROUTING_MATRIX.md` | ✅ REFRESHED — 2026-05-21 |
| `CONTEXT_HANDOFF_TEMPLATE.md` | ✅ REFRESHED — 2026-05-21 |
| `CHAT_STARTER_PROMPT.md` | ⚠️ STALE — superseded by CLAUDE_CHAT_UPLOAD_PACK |
| `VERIFICATION_GATES.md` | 📖 REFERENCE — still valid |
| `OPERATOR_ACCEPTANCE_CHECKLIST.md` | 📖 REFERENCE — still valid |
| `AUTOMATION_SCORECARD.md` | 📖 REFERENCE — not yet scored |
| `DRIFT_MONITORING_LOG.md` | 📖 REFERENCE — append on drift |
| `FAILURE_MODES_AND_STOP_CONDITIONS.md` | 📖 REFERENCE — still valid |
| `MARKETSOURCECAROUSEL_INSPECT_PROMPT.md` | 📖 REFERENCE — valid for that phase |
| `RULE_COMPLIANCE_MONITOR_AGENT.md` | 📖 REFERENCE — still valid |

---

## docs/design/ — artifact inventory (untracked)

| File | Status |
|---|---|
| `docs/design/claude-design-source-pack/` | ✅ ARTIFACT — design pack for Claude Design |
| `docs/design/polypropicks-claude-design-source-pack-2026-05-20.zip` | ✅ ARTIFACT — upload ZIP |
| `docs/design/polypropicks-claude-design-source-pack-FULL-BACKUP-2026-05-20.zip` | ✅ ARTIFACT — full backup |
