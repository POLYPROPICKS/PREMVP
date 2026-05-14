# **11\_SOURCE\_FILES\_AND\_REPO\_INVENTORY.md**

> ⚠️ DELTA OVERRIDE — 14.05.2026
> Verified from: `git log --oneline -10`, `git status --short`, `dir` output.
> Inventory below reflects 10.05.2026 baseline. This block supersedes stale entries.

## VERIFIED STATUS CHANGES

### Git state
```
HEAD:    1b36f07 UI: add see on polymarket label to link icon
Origin:  synced
Working tree: NOT CLEAN — untracked debug files present: recon-css.txt, recon-full.txt
Do not commit/push until these files are deleted or intentionally ignored.
```

### lib/feed/ — verified file list (14.05.2026)
| File | Status | Notes |
|---|---|---|
| `buildLandingCards.ts` | ✅ ACTIVE — PRIMARY | Confirmed primary generator |
| `buildSportsLandingCards.ts` | ⚠️ SUPERSEDED — exists, not deleted | Not called by cron: CONFIRMED. Not imported elsewhere: NOT VERIFIED. Safe to delete: NOT VERIFIED. Do not delete without import graph inspection. |
| `cacheGeneratedSignals.ts` | ✅ ACTIVE — MODIFIED | marketSources field added af4ed5e |
| `discoverSportsMarkets.ts` | present — NEEDS CONTENT INSPECTION | |
| `landingPairs.ts` | present — active | |
| `normalizePolymarket.ts` | present — active | |
| `polymarketClient.ts` | present — active | |
| `scorePolymarket.ts` | present — active | |
| `types.ts` | present — active | New types possible after af4ed5e — inspect before use |

### scripts/ — verified
| File | Status |
|---|---|
| `generate-signals.ts` | ✅ ACTIVE — uses buildLandingCards |

### app/reconstruction/ — verified (10 files)
| File | Status |
|---|---|
| `page.tsx` | ✅ ACTIVE — modified by UI phase (3 commits) |
| `Reconstruction.module.css` | ✅ ACTIVE |
| `page.before-forced-icons.tsx` | 📦 BACKUP — do not edit |
| `page.before-icons.tsx` | 📦 BACKUP — do not edit |
| `page.broken.tsx` | 📦 BACKUP — do not edit |
| `page.phase1-trust-before.tsx` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-forced-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.broken.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.phase1-trust-before.css` | 📦 BACKUP — do not edit |

### docs/ai-context/ — new files (all committed 39ab5aa+)
```
CLAUDE_CODE_EXECUTION_PROTOCOL.md  ✅ NEW
TASK_ROUTING_MATRIX.md             ✅ NEW
VERIFICATION_GATES.md              ✅ NEW
OPERATOR_ACCEPTANCE_CHECKLIST.md   ✅ NEW
RULE_COMPLIANCE_MONITOR_AGENT.md   ✅ NEW
FAILURE_MODES_AND_STOP_CONDITIONS.md ✅ NEW
CHAT_STARTER_PROMPT.md             ✅ NEW
CONTEXT_HANDOFF_TEMPLATE.md        ✅ NEW
AUTOMATION_SCORECARD.md            ✅ NEW
DRIFT_MONITORING_LOG.md            ✅ NEW
```

### Untracked — add to .gitignore
```
recon-css.txt
recon-full.txt
```

### NEEDS CONTENT INSPECTION before next patch
```
- buildSportsLandingCards.ts: any active imports? safe to delete?
- page.tsx: exact changes from 3 UI commits (Polymarket link icon)
- lib/feed/types.ts: new types after cron switch?
```

## CURRENT STATE SUMMARY — MarketSourceCarousel phase

### Active next-touch files (inspect before edit)
```
app/reconstruction/page.tsx               ← primary UI — modified by 3 icon commits
app/reconstruction/Reconstruction.module.css ← active styles
components/carousels/MarketSourceCarousel.tsx ← NEEDS CONTENT INSPECTION
components/cards/MarketSourceCard.tsx         ← NEEDS CONTENT INSPECTION
lib/feed/landingPairs.ts                     ← LandingPair/marketSources wiring
lib/feed/types.ts                            ← type source of truth
```

### Do NOT edit — backup files
```
page.before-forced-icons.tsx
page.before-icons.tsx
page.broken.tsx
page.phase1-trust-before.tsx
Reconstruction.module.before-forced-icons.css
Reconstruction.module.before-icons.css
Reconstruction.module.broken.css
Reconstruction.module.phase1-trust-before.css
```

### Requires content inspection before patch
```
- MarketSourceCarousel: activePairId, activeEvidenceIndex wiring
- page.tsx: current import list and component structure
- buildSportsLandingCards.ts: import graph — is anything importing it?
- lib/feed/types.ts: complete type list after af4ed5e changes
```

---

> ⚠️ HISTORICAL BASELINE — SUPERSEDED
> Everything below this line reflects the older inventory from 10.05.2026.
> Do not use old Git status, old commit references, or old docs tracking state as current truth.
> Use the DELTA OVERRIDE and CURRENT STATE SUMMARY sections above instead.

---




## KNOWN STATUS CHANGES SINCE BASELINE

### Feed files

| File | Old status | New status |
|---|---|---|
| `scripts/generate-signals.ts` | "Likely active / NEEDS VERIFICATION" | ✅ ACTIVE — uses buildLandingCards |
| `lib/feed/cacheGeneratedSignals.ts` | Active | ✅ ACTIVE — marketSources field added |
| `lib/feed/buildLandingCards.ts` | Active | ✅ PRIMARY GENERATOR — confirmed |
| `lib/feed/buildSportsLandingCards.ts` | "Unknown / likely active or legacy" | ⚠️ LEGACY — no longer called by cron |

### Docs / contour files (all new — committed 39ab5aa+)

```
docs/ai-context/CLAUDE_CODE_EXECUTION_PROTOCOL.md   NEW ✅
docs/ai-context/TASK_ROUTING_MATRIX.md               NEW ✅
docs/ai-context/VERIFICATION_GATES.md                NEW ✅
docs/ai-context/OPERATOR_ACCEPTANCE_CHECKLIST.md     NEW ✅
docs/ai-context/RULE_COMPLIANCE_MONITOR_AGENT.md     NEW ✅
docs/ai-context/FAILURE_MODES_AND_STOP_CONDITIONS.md NEW ✅
docs/ai-context/CHAT_STARTER_PROMPT.md               NEW ✅
docs/ai-context/CONTEXT_HANDOFF_TEMPLATE.md          NEW ✅
docs/ai-context/AUTOMATION_SCORECARD.md              NEW ✅
docs/ai-context/DRIFT_MONITORING_LOG.md              NEW ✅
CLAUDE.md                                            NEW ✅ (repo root)
AGENTS.md                                            UPDATED ✅ (repo root)
```

### UI files — IN PROGRESS ⚠️

```
app/reconstruction/page.tsx           MODIFIED — UI phase in progress
app/reconstruction/Reconstruction.module.css  POSSIBLY MODIFIED — verify
```

### NEEDS FRESH INSPECTION

```
- Exact content of modified feed files
- buildSportsLandingCards.ts: deleted or just unused?
- New UI files created by reconstruction phase
- MarketSourceCarousel: activePairId / activeEvidenceIndex wiring
- lib/feed/types.ts: any new types added?
```

---



This file maps actual current source files for PolyProPicks / PolyPicks Current so future ChatGPT, Codex, Claude, Windsurf, and other AI coding agents can work from repo reality instead of stale chat memory.

This inventory was generated from CMD/Git raw inspection output because Windsurf was unavailable.

It helps future agents understand:

* What source files exist.  
* What routes likely exist.  
* What frontend components likely exist.  
* What backend/feed files likely exist.  
* What content/static data files exist.  
* What docs/context files exist.  
* What config/env/deployment-related files exist.  
* Which files are likely active.  
* Which files require source verification.  
* Which files are high-risk to edit.  
* Which files are likely needed for Whop/Auth/Stripe-later/new API phases.

This file is an inventory, not an implementation plan. Do not use it to justify broad refactors.

## **2\. Inventory Source**

Source method:

CMD/Git raw inventory

Raw file:

/docs/ai-context/repo\_inventory\_raw.txt

Raw inventory file source:

repo\_inventory\_raw.txt

The raw inventory reports branch `main`, Git status `?? docs/`, recent commits, tracked files, app API route files, app page/layout files, and `package.json` scripts/dependencies.

Date:

NEEDS VERIFICATION

Branch from raw inventory:

main

Git status from raw inventory:

?? docs/

Recent commits from raw inventory:

966f6c2 Stabilize PREMVP15 feed contract and evidence stack  
808aaef Add automation mode handoff  
5d091e8 Add project agent instructions  
296c330 Dedupe generated landing feed pairs  
86c603d Cap fallback sports markets to middle confidence  
5b790c1 Guarantee market evidence stack cards  
2875d89 Tighten sports futures and relegation market filtering  
43677cf Merge Polymarket API mapping fix

Build status:

NEEDS VERIFICATION

## **3\. Precheck Result**

| Check | Value | Risk / notes |
| ----- | ----- | ----- |
| Branch | `main` | From raw inventory. Verify before edits. |
| Git status | `?? docs/` | Context docs are untracked in raw inventory. Must not push source work before deciding how to commit docs. |
| Latest commit | `966f6c2 Stabilize PREMVP15 feed contract and evidence stack` | From raw inventory. Verify with `git log --oneline -5`. |
| Origin/main | `NEEDS VERIFICATION` | Raw inventory does not show remote tracking labels. |
| Docs state | `?? docs/` | `/docs/ai-context/` likely newly created/untracked. |
| Build status | `NEEDS VERIFICATION` | Raw inventory did not include `npm run build` output. |
| Package stack | Next.js `16.2.4`, React `19.2.4`, TypeScript `^5`, Supabase JS `^2.105.1` | From `package.json` in raw inventory. |
| Dev command | `npm run dev` → `next dev` | From package scripts. |
| Build command | `npm run build` → `next build` | From package scripts. |
| Generate signals command | `npm run generate:signals` → `tsx scripts/generate-signals.ts` | Potential cron/feed generation entry. Needs source verification. |

## **4\. Top-Level Repo Structure**

| Path | Type | Purpose | Active status | Notes |
| ----- | ----- | ----- | ----- | ----- |
| `app/` | Next.js App Router | Pages, layout, API routes, globals, robots, sitemap | Active | Tracked files include app routes and pages. |
| `app/api/` | Next.js API routes | Feed APIs and leads capture | Active | Contains feed debug routes, landing-cards route, leads route. |
| `app/reconstruction/` | Frontend route/module | Main reconstruction/landing UI route and CSS variants | Likely active | Contains active `page.tsx` and multiple backup/legacy variants. |
| `components/` | React components | Cards, carousels, layout, modals, sections, UI controls | Likely active | Usage must be verified per component. |
| `content/` | Static/manual data/config | Hero/CTA/cards/signals/marketSources/fallback content | Likely active | Manual fallback/override content lives here. |
| `lib/` | Application/backend logic | Feed generation, normalization, Supabase server, shared types | Active | High-risk backend/data area. |
| `scripts/` | Scripts | Signal generation script | Likely active | `generate:signals` script references `scripts/generate-signals.ts`. |
| `public/` | Static assets | Brand, icons, reference images, SVGs | Active | Used by UI/assets. Usage per asset needs verification. |
| `docs/` | Documentation/context | AI context docs | Untracked in raw inventory | Must be committed intentionally if accepted. |
| `styles/` | Styling folder | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | No tracked `styles/` folder shown. |
| `types/` | Types folder | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | Shared types appear in `lib/types.ts` and `lib/feed/types.ts`. |
| root config files | Config | Next, TypeScript, ESLint, PostCSS, package | Active | See environment/config inventory. |

## **5\. App Routes Inventory**

| Route | File path | Purpose | Status | Notes |
| ----- | ----- | ----- | ----- | ----- |
| `/` | `app/page.tsx` | Main route/homepage | Active | Actual render path needs source verification. |
| `/reconstruction` | `app/reconstruction/page.tsx` | Reconstruction/reference/landing route | Active | High-risk UI route. Multiple historical backup page files exist. |
| `/api/feed/landing-cards` | `app/api/feed/landing-cards/route.ts` | Main feed API route | Active | Cache-first behavior likely. High-risk feed contract route. |
| `/api/feed/debug-evidence-generation` | `app/api/feed/debug-evidence-generation/route.ts` | Fresh/debug evidence generation route | Active locally / production status uncertain | Likely debug route. Production behavior NEEDS VERIFICATION. |
| `/api/feed/debug-sports-cards` | `app/api/feed/debug-sports-cards/route.ts` | Sports card debug route | Likely active | Exact output/usage NEEDS SOURCE VERIFICATION. |
| `/api/feed/debug-sports-discovery` | `app/api/feed/debug-sports-discovery/route.ts` | Sports discovery debug route | Likely active | Exact output/usage NEEDS SOURCE VERIFICATION. |
| `/api/leads` | `app/api/leads/route.ts` | Lead capture route | Active | Likely Supabase lead\_intents write path. High-risk for lead capture. |
| `/robots.txt` | `app/robots.ts` | Robots metadata route | Active | Generated route. |
| `/sitemap.xml` | `app/sitemap.ts` | Sitemap metadata route | Active | Generated route. |
| Global layout | `app/layout.tsx` | Root layout | Active | High impact if edited. |
| Global CSS | `app/globals.css` | Global styles | Active | High impact if edited. |

## **6\. Frontend Component Inventory**

| Component/file | Purpose | Likely used by | Touch risk | Status | Notes |
| ----- | ----- | ----- | ----- | ----- | ----- |
| `components/cards/PremiumEventCard.tsx` | Premium signal card | Landing/reconstruction pages or section components | High | Likely active | Master signal surface. Usage needs source verification. |
| `components/cards/PremiumEventCard.module.css` | PremiumEventCard styles | `PremiumEventCard.tsx` | High | Likely active | CSS changes require screenshot acceptance. |
| `components/cards/MarketSourceCard.tsx` | Market evidence card | MarketSourceCarousel / sections / pages | High | Likely active | Evidence visual surface. Preserve type/data behavior. |
| `components/cards/MarketSourceCard.module.css` | MarketSourceCard styles | `MarketSourceCard.tsx` | High | Likely active | Prior visual regressions occurred in evidence card area. |
| `components/carousels/PremiumEventCarousel.tsx` | Premium feed carousel | Landing/reconstruction | High | Likely active | Locked feed behavior risk. |
| `components/carousels/MarketSourceCarousel.tsx` | Evidence carousel | Landing/reconstruction | High | Likely active | Must remain dependent evidence, not independent feed. |
| `components/modals/PassOfferModal.tsx` | Premium/paywall modal | Locked feed attempts | High | Likely active | Payment/CTA behavior sensitive. |
| `components/modals/PassOfferModal.module.css` | PassOfferModal styles | `PassOfferModal.tsx` | High | Likely active | Full-screen/mobile paywall visual. |
| `components/cards/HeaderBar.tsx` | Header/card-level header | Unknown | Medium | Unknown | There is also `components/layout/HeaderBar.tsx`; usage must be verified. |
| `components/cards/HeaderBar.module.css` | HeaderBar styles | `components/cards/HeaderBar.tsx` | Medium | Unknown | Potential duplicate with layout HeaderBar. |
| `components/layout/HeaderBar.tsx` | Layout header | Unknown | Medium | Unknown | Usage must be verified. |
| `components/layout/HeaderBar.module.css` | Layout HeaderBar styles | `components/layout/HeaderBar.tsx` | Medium | Unknown | Potential duplicate with card HeaderBar. |
| `components/layout/StatusBar.tsx` | Status/mobile bar | Unknown | Medium | Unknown | Usage must be verified. |
| `components/sections/HeroSection.tsx` | Hero/landing section | `app/page.tsx` likely | Medium | Likely active | Usage needs source verification. |
| `components/sections/CTASection.tsx` | CTA section | Landing page likely | Medium | Likely active | CTA copy sensitive. |
| `components/sections/MarketSourcesSection.tsx` | Market sources section | Landing page likely | Medium | Likely active | May use `content/market-source-cards.ts`. |
| `components/sections/PremiumEventsSection.tsx` | Premium events section | Landing page likely | Medium | Likely active | May use `content/premium-event-cards.ts`. |
| `components/ui/CategoryTabs.tsx` | Category filter tabs | Sections/pages | Medium | Likely active | Filter behavior can affect feed. |
| `components/ui/PaginationDots.tsx` | Carousel pagination | Carousels/sections | Low/Medium | Likely active | Usage needs verification. |
| `app/reconstruction/page.tsx` | Route-level page and possibly inline UI | `/reconstruction` route | High | Active | High-risk: may contain inline card implementations. Inspect before edits. |
| `app/reconstruction/Reconstruction.module.css` | Reconstruction route styles | `/reconstruction` route | High | Active | Multiple historical CSS backups exist. Avoid broad changes. |

## **7\. Feed / Backend Inventory**

| File/function area | File path | Purpose | Input/output if inferable | Touch risk | Status |
| ----- | ----- | ----- | ----- | ----- | ----- |
| Main feed builder | `lib/feed/buildLandingCards.ts` | Builds landing card feed from Polymarket data | Likely returns LandingCardsResponse with pairs/rejected/inspected | Very High | Active |
| Legacy/sports builder | `lib/feed/buildSportsLandingCards.ts` | Sports-specific landing cards builder | NEEDS SOURCE VERIFICATION | High | Unknown / likely active or legacy |
| Cache generated signals | `lib/feed/cacheGeneratedSignals.ts` | Supabase/cache read/write for generated signal pairs | Likely caches premiumSignal/marketSource/marketSources/diagnostics | Very High | Active |
| Sports discovery | `lib/feed/discoverSportsMarkets.ts` | Sports market discovery pipeline | NEEDS SOURCE VERIFICATION | High | Active / needs verification |
| LandingPair helpers/types | `lib/feed/landingPairs.ts` | Canonical LandingPair normalization/helpers | LandingPair, marketSource/marketSources handling | Very High | Active |
| Polymarket normalization | `lib/feed/normalizePolymarket.ts` | Normalize Polymarket data | NEEDS SOURCE VERIFICATION | High | Likely active |
| Polymarket client/API mapping | `lib/feed/polymarketClient.ts` | External Polymarket API client | Gamma/Data/CLOB calls likely | Very High | Active |
| Scoring | `lib/feed/scorePolymarket.ts` | Score/probability/display metrics | NEEDS SOURCE VERIFICATION | High | Active |
| Feed types | `lib/feed/types.ts` | Feed and LandingCards types/constants | `FORMULA_VERSION`, response types likely | Very High | Active |
| Supabase server | `lib/supabase/server.ts` | Supabase server client/config | Server-side DB access | High | Active |
| General shared types | `lib/types.ts` | Shared frontend/domain types | NEEDS SOURCE VERIFICATION | Medium/High | Active |
| Generate signals script | `scripts/generate-signals.ts` | Signal generation/cron script | Uses feed builder/cache likely | High | Likely active |
| Formula version | `lib/feed/types.ts` | Defines current formulaVersion likely | Expected `trusted-initial-formula-v1.1` | High | Needs source verification |
| Market evidence stack | `lib/feed/buildLandingCards.ts`, `lib/feed/landingPairs.ts`, `lib/feed/cacheGeneratedSignals.ts`, `lib/feed/types.ts` | Maintains `marketSource` \+ `marketSources[]` contract | Input provider data → LandingPair/evidence cards | Very High | Active |

Exact functions are not fully visible from raw file list. Function-level claims need source verification.

## **8\. Content / Static Data Inventory**

| Path | Purpose | Status | Notes |
| ----- | ----- | ----- | ----- |
| `content/signals.ts` | Static/manual premium signal fallback content | Likely active | High-risk fallback content. Do not remove. |
| `content/marketSources.ts` | Static/manual market source fallback content | Likely active | Must preserve backward compatibility. |
| `content/market-source-cards.ts` | Market source card content | Unknown / likely active | Usage needs source verification. |
| `content/premium-event-cards.ts` | Premium event card content | Unknown / likely active | Usage needs source verification. |
| `content/category-tabs.ts` | Category tab/filter content | Unknown / likely active | Usage needs source verification. |
| `content/cta-content.ts` | CTA content | Unknown / likely active | CTA copy sensitive. |
| `content/hero-content.ts` | Hero content | Unknown / likely active | Landing page content. |
| `content/section-headings.ts` | Section headings content | Unknown / likely active | Landing page copy. |
| teams/leagues/sports content | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | No dedicated tracked files shown. |
| plan/pricing config | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | Payment phase may need new config. |

## **9\. Styling Inventory**

| Path | Affects likely UI | Touch risk | Notes |
| ----- | ----- | ----- | ----- |
| `app/globals.css` | Global app styles | High | Broad impact. Avoid unless explicitly scoped. |
| `app/reconstruction/Reconstruction.module.css` | Reconstruction/landing route | Very High | Main mobile UI styling likely. |
| `app/reconstruction/Reconstruction.module.before-forced-icons.css` | Historical CSS backup | High if edited | Likely legacy snapshot. Do not edit unless restoring. |
| `app/reconstruction/Reconstruction.module.before-icons.css` | Historical CSS backup | High if edited | Likely legacy snapshot. |
| `app/reconstruction/Reconstruction.module.broken.css` | Broken CSS snapshot | Do not edit | Likely legacy/broken. |
| `app/reconstruction/Reconstruction.module.phase1-trust-before.css` | Historical CSS backup | High if edited | Likely legacy snapshot. |
| `components/cards/HeaderBar.module.css` | HeaderBar card styles | Medium | Usage unknown. |
| `components/cards/MarketSourceCard.module.css` | MarketSourceCard visual | High | Evidence card UI sensitive. |
| `components/cards/PremiumEventCard.module.css` | PremiumEventCard visual | High | Main product card UI sensitive. |
| `components/layout/HeaderBar.module.css` | Layout header visual | Medium | Usage unknown. |
| `components/modals/PassOfferModal.module.css` | Paywall/pass modal | High | Full-screen mobile modal sensitive. |
| `tailwind.config.*` | Not visible | NEEDS SOURCE VERIFICATION | No tracked Tailwind config shown in raw inventory. |
| `postcss.config.mjs` | PostCSS/Tailwind pipeline | Medium | Config risk. |
| `next.config.ts` | Next config | High | Can affect build/runtime. |

## **10\. Public Assets Inventory**

| Path | Asset type | Likely purpose | Status | Notes |
| ----- | ----- | ----- | ----- | ----- |
| `public/brand/polypropicks-mark.png` | Brand image | Header/logo | Likely active | Used by brand UI likely. |
| `public/icons/position-target.png` | Icon | Position block | Likely active | PremiumEventCard asset likely. |
| `public/icons/profit-trend.png` | Icon | Profit block | Likely active | PremiumEventCard asset likely. |
| `public/icons/trust-ai-score.png` | Icon | Trust metric | Likely active | Trust metrics. |
| `public/icons/trust-public-whale.png` | Icon | Trust metric | Likely active | Trust metrics. |
| `public/icons/trust-smart-money.png` | Icon | Trust metric | Likely active | Trust metrics. |
| `public/reference/PolyCARD1.3.png` | Reference image | UI/design reference | Likely documentation/reference | Do not assume used in UI. |
| `public/iconify-icon.min.js` | JS asset | Iconify runtime? | Unknown | Usage needs verification. |
| `public/file.svg` | SVG | Default/public asset | Unknown | May be unused default. |
| `public/globe.svg` | SVG | Default/public asset | Unknown | May be unused default. |
| `public/next.svg` | SVG | Default/public asset | Unknown | May be unused default. |
| `public/vercel.svg` | SVG | Default/public asset | Unknown | May be unused default. |
| `public/window.svg` | SVG | Default/public asset | Unknown | May be unused default. |

Sports/team/flag assets:

NEEDS SOURCE VERIFICATION

Fallback images:

NEEDS SOURCE VERIFICATION

## **11\. Supabase / Database Code Inventory**

| File path | DB/service likely used | Purpose | Status | Notes |
| ----- | ----- | ----- | ----- | ----- |
| `lib/supabase/server.ts` | Supabase | Server-side Supabase client/config | Active | High-risk secrets/server-only boundary. |
| `app/api/leads/route.ts` | Supabase | Lead capture route | Active | Likely writes to `lead_intents`. Verify source before changes. |
| `lib/feed/cacheGeneratedSignals.ts` | Supabase/cache | Generated feed pair cache | Active | High-risk cache/contract file. |
| `scripts/generate-signals.ts` | Supabase/cache possibly | Cron/manual signal generation | Likely active | Used by `npm run generate:signals`. Needs source verification. |
| `app/api/feed/landing-cards/route.ts` | Supabase/cache via cacheGeneratedSignals | Main landing feed API | Active | Cache-first route likely. |
| `app/api/feed/debug-evidence-generation/route.ts` | Feed generation, maybe no DB | Fresh generation debug | Active | Local/debug route. |
| `.env.example` | Env documentation | Lists env names | Active | Must not contain secrets. Needs inspection. |

Known table from project context:

public.lead\_intents

Other planned tables:

plan\_catalog  
checkout\_sessions  
payment\_events  
user\_entitlements  
external\_accounts optional

Actual schema:

NEEDS SOURCE/DB VERIFICATION

## **12\. Environment / Config Inventory**

| Path | Purpose | Risk | Notes |
| ----- | ----- | ----- | ----- |
| `.env.example` | Example env vars | Medium/High | Safe only if no secrets. Inspect before editing. |
| `.gitignore` | Git ignore rules | High | Must ensure `.env.local`, temp files, backups excluded. |
| `package.json` | Scripts/dependencies | High | Defines `dev`, `build`, `start`, `lint`, `generate:signals`; stack versions. |
| `package-lock.json` | Locked dependencies | Medium | Do not edit manually. |
| `next.config.ts` | Next.js config | High | Can affect runtime/build/caching. |
| `tsconfig.json` | TypeScript config | Medium/High | Affects compile behavior. |
| `eslint.config.mjs` | ESLint config | Medium | Lint behavior. |
| `postcss.config.mjs` | PostCSS/Tailwind config | Medium | Styling pipeline. |
| `AGENTS.md` | Agent rules | Medium | Context/instructions for agents. |
| `AUTOMATION_MODE_HANDOFF.md` | Automation workflow docs | Medium | Tool/process documentation. |
| `CLAUDE.md` | Claude agent instructions | Medium | Important for Claude Code onboarding. |
| `README.md` | Project readme | Low/Medium | Context may be stale. |
| Railway/deployment files | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | No `railway.toml`/Procfile visible in raw inventory. |
| Middleware | Not visible in raw inventory | NEEDS SOURCE VERIFICATION | No `middleware.ts` shown. |

## **13\. Context Docs Inventory**

| Context file | Purpose | Present in raw inventory? | Update responsibility |
| ----- | ----- | ----- | ----- |
| `docs/ai-context/01_PROJECT_CONTEXT_CURRENT.md` | Current project context | Not listed as tracked; `?? docs/` indicates untracked docs folder | Update after major phase/roadmap changes. |
| `docs/ai-context/02_CURRENT_TECH_STATE.md` | Current technical state | Not listed as tracked | Update after commits/build/API/deploy verification. |
| `docs/ai-context/03_CURRENT_SOURCE_ARCHITECTURE_MAP.md` | Source architecture map | Not listed as tracked | Update after route/source/data-flow changes. |
| `docs/ai-context/04_PRODUCT_DECISIONS_LOCKED.md` | Locked product decisions | Not listed as tracked | Update after payment/product/CTA/pricing/architecture decisions. |
| `docs/ai-context/05_WINDSURF_WORKFLOW_RULES.md` | Windsurf/tool workflow rules | Not listed as tracked | Update after workflow/tooling changes. |
| `docs/ai-context/06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md` | Lessons/operator rules | Not listed as tracked | Update after new failure patterns or best practices. |
| `docs/ai-context/07_AI_AGENT_MIGRATION_CONTEXT.md` | Multi-agent migration context | Not listed as tracked | Update after Codex/Claude/Windsurf workflow changes. |
| `docs/ai-context/08_ENVIRONMENT_AND_CONNECTORS.md` | Env/connectors handoff | Not listed as tracked | Update after env/Supabase/Railway/payment connector changes. |
| `docs/ai-context/09_CONTEXT_DELTA_LOG.md` | Latest delta log | Not listed as tracked | Update after significant events/commits/verification. |
| `docs/ai-context/10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md` | Frontend/design baseline | Not listed as tracked | Update after accepted design/frontend baseline changes. |
| `docs/ai-context/11_SOURCE_FILES_AND_REPO_INVENTORY.md` | This source inventory | Target file | Refresh after major source changes. |
| `docs/ai-context/12_AGENT_STARTUP_PROTOCOL.md` | Agent startup protocol | Not visible in raw inventory | NEEDS SOURCE VERIFICATION / create only if requested. |

Current docs tracking state:

?? docs/

Meaning:

* `/docs/` was untracked in raw inventory.  
* It must be intentionally added/committed when accepted.  
* Do not mix docs commit with source implementation unless explicitly approved.

## **14\. Active vs Legacy / Uncertain Files**

### **Active / likely active**

app/page.tsx  
app/layout.tsx  
app/globals.css  
app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
app/api/feed/landing-cards/route.ts  
app/api/feed/debug-evidence-generation/route.ts  
app/api/feed/debug-sports-cards/route.ts  
app/api/feed/debug-sports-discovery/route.ts  
app/api/leads/route.ts  
app/robots.ts  
app/sitemap.ts  
components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/cards/PremiumEventCard.tsx  
components/cards/PremiumEventCard.module.css  
components/carousels/MarketSourceCarousel.tsx  
components/carousels/PremiumEventCarousel.tsx  
components/modals/PassOfferModal.tsx  
components/modals/PassOfferModal.module.css  
content/signals.ts  
content/marketSources.ts  
lib/feed/buildLandingCards.ts  
lib/feed/cacheGeneratedSignals.ts  
lib/feed/discoverSportsMarkets.ts  
lib/feed/landingPairs.ts  
lib/feed/normalizePolymarket.ts  
lib/feed/polymarketClient.ts  
lib/feed/scorePolymarket.ts  
lib/feed/types.ts  
lib/supabase/server.ts  
scripts/generate-signals.ts  
package.json  
next.config.ts  
tsconfig.json

### **Likely legacy**

app/reconstruction/Reconstruction.module.before-forced-icons.css  
app/reconstruction/Reconstruction.module.before-icons.css  
app/reconstruction/Reconstruction.module.broken.css  
app/reconstruction/Reconstruction.module.phase1-trust-before.css  
app/reconstruction/page.before-forced-icons.tsx  
app/reconstruction/page.before-icons.tsx  
app/reconstruction/page.broken.tsx  
app/reconstruction/page.phase1-trust-before.tsx

Notes:

* These look like tracked backup/snapshot files.  
* Do not edit unless explicitly restoring from a known snapshot.  
* Their active usage is not proven.

### **Uncertain / needs verification**

components/cards/HeaderBar.tsx  
components/cards/HeaderBar.module.css  
components/layout/HeaderBar.tsx  
components/layout/HeaderBar.module.css  
components/layout/StatusBar.tsx  
components/sections/CTASection.tsx  
components/sections/HeroSection.tsx  
components/sections/MarketSourcesSection.tsx  
components/sections/PremiumEventsSection.tsx  
components/ui/CategoryTabs.tsx  
components/ui/PaginationDots.tsx  
content/category-tabs.ts  
content/cta-content.ts  
content/hero-content.ts  
content/market-source-cards.ts  
content/premium-event-cards.ts  
content/section-headings.ts  
lib/feed/buildSportsLandingCards.ts  
lib/types.ts  
public/iconify-icon.min.js  
public/reference/PolyCARD1.3.png

Usage cannot be proven from file list alone. Source import graph verification required.

## **15\. High-Risk Files To Edit**

High-risk files/areas:

lib/feed/buildLandingCards.ts  
lib/feed/cacheGeneratedSignals.ts  
lib/feed/landingPairs.ts  
lib/feed/polymarketClient.ts  
lib/feed/types.ts  
lib/feed/scorePolymarket.ts  
lib/feed/discoverSportsMarkets.ts  
app/api/feed/landing-cards/route.ts  
app/api/feed/debug-evidence-generation/route.ts  
app/api/leads/route.ts  
lib/supabase/server.ts  
app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
components/cards/PremiumEventCard.tsx  
components/cards/PremiumEventCard.module.css  
components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/carousels/PremiumEventCarousel.tsx  
components/carousels/MarketSourceCarousel.tsx  
components/modals/PassOfferModal.tsx  
components/modals/PassOfferModal.module.css  
next.config.ts  
package.json  
.env.example

Why high risk:

* Feed builders define product data quality and evidence stack.  
* LandingPair/types define API/frontend contract.  
* API routes affect runtime behavior and cache/fresh-generation distinction.  
* Polymarket client affects external API mapping/ID usage.  
* Supabase files affect DB writes and secrets boundary.  
* Reconstruction/page and card/carousel/modals affect product-critical UI.  
* CSS modules can cause mobile layout regressions.  
* Config files can break build/deploy.  
* Payment/auth/env work can expose secrets or corrupt access model.

Rules:

* Inspect before editing.  
* One change zone per patch.  
* Run build after edit.  
* Run API/browser verification when relevant.  
* Do not edit these files from stale memory.

## **16\. Files Likely Needed For Next Phases**

### **Whop-first / Stripe-later payment**

Likely files/routes to inspect or create:

app/api/leads/route.ts  
lib/supabase/server.ts  
app/api/checkout/create/route.ts NEEDS SOURCE VERIFICATION / likely new  
app/api/webhooks/whop/route.ts NEEDS SOURCE VERIFICATION / likely new  
app/api/webhooks/stripe/route.ts NEEDS SOURCE VERIFICATION / later likely new  
lib/payments/\* NEEDS SOURCE VERIFICATION / likely new  
lib/entitlements/\* NEEDS SOURCE VERIFICATION / likely new  
components/modals/PassOfferModal.tsx  
components/modals/PassOfferModal.module.css

Related context/config:

.env.example  
docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md  
docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md

### **Supabase entitlement/auth**

Likely files/routes/tables to inspect or create:

lib/supabase/server.ts  
app/api/leads/route.ts  
app/api/checkout/create/route.ts NEEDS SOURCE VERIFICATION / likely new  
app/api/webhooks/whop/route.ts NEEDS SOURCE VERIFICATION / likely new  
lib/entitlements/\* NEEDS SOURCE VERIFICATION / likely new  
middleware.ts NEEDS SOURCE VERIFICATION / not visible  
app/premium/page.tsx NEEDS SOURCE VERIFICATION / likely future new

Likely tables:

lead\_intents  
plan\_catalog  
checkout\_sessions  
payment\_events  
user\_entitlements  
external\_accounts optional

Actual DB schema:

NEEDS SOURCE/DB VERIFICATION

### **New external API provider**

Likely files:

lib/feed/polymarketClient.ts  
lib/feed/normalizePolymarket.ts  
lib/feed/buildLandingCards.ts  
lib/feed/discoverSportsMarkets.ts  
lib/feed/cacheGeneratedSignals.ts  
lib/feed/types.ts  
scripts/generate-signals.ts

Potential future structure:

lib/feed/providers/\* NEEDS SOURCE VERIFICATION / likely new  
lib/feed/normalizeProviderData.ts NEEDS SOURCE VERIFICATION / likely new

Rule:

* New provider must normalize into internal LandingPair/evidence shape.  
* Do not leak provider-specific response structure into UI.

### **MarketSource evidence stack UI**

Likely files:

components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/carousels/MarketSourceCarousel.tsx  
app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
content/marketSources.ts  
lib/feed/landingPairs.ts  
lib/feed/types.ts

Rule:

* UI work must not patch backend unless explicitly scoped.  
* Backend must prove data before UI renders evidence types.

### **Frontend visual changes**

Likely files:

app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
components/cards/PremiumEventCard.tsx  
components/cards/PremiumEventCard.module.css  
components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/carousels/PremiumEventCarousel.tsx  
components/carousels/MarketSourceCarousel.tsx  
components/modals/PassOfferModal.tsx  
components/modals/PassOfferModal.module.css  
public/icons/\*  
public/brand/polypropicks-mark.png

Rule:

* Visual acceptance requires screenshot/browser behavior checks.  
* Do not make visual changes during payment/backend tasks.

## **17\. Refresh Rules**

This inventory must be refreshed after:

* Major source changes.  
* New routes.  
* New payment/auth files.  
* New Supabase/cache files.  
* New provider/client files.  
* Major UI/card/carousel/modal changes.  
* Large merges.  
* Commit that changes architecture.  
* Tool migration changes.

Refresh method if Windsurf unavailable:

git branch \--show-current  
git status \--short  
git log \--oneline \-8  
git ls-files  
dir app\\api /s /b  
dir app /b  
type package.json

Rules:

* Use CMD/Git raw inventory when Windsurf unavailable.  
* Use Codex/Claude repo inspection if available.  
* Do not rely on old chat memory.  
* Regenerate raw inventory before architecture work.  
* Do not infer file paths from memory.  
* Mark unknowns as `NEEDS SOURCE VERIFICATION`.  
* Update this file after accepted source inventory changes.

## **18\. Agent Instructions**

Future agents must:

* Read this file before editing.  
* Read relevant `/docs/ai-context/` files before planning.  
* Verify Git status first.  
* Do not infer file paths from memory.  
* Ask for source snippets before editing high-risk files.  
* Inspect imports/usages before declaring a file active.  
* Do not edit env/secrets.  
* Do not rewrite architecture.  
* Do not touch UI/CSS during backend-only tasks.  
* Do not touch feed/backend/payment during visual-only tasks.  
* Do not commit/push without explicit approval.  
* Do not treat this inventory as proof of runtime behavior.  
* Use source/build/API/browser/Supabase/Railway verification for acceptance.

Required first commands before implementation:

git branch \--show-current  
git status \--short  
git log \--oneline \-5  
npm run build

If implementation depends on exact source behavior:

Inspect source first.  
Do not patch from inventory alone.

## **19\. Source Inventory Handoff Summary**

The repo is a Next.js 16.2.4 / TypeScript / React 19.2.4 project with App Router routes, feed APIs, Supabase integration, landing/reconstruction UI, card/carousel/modal components, static content files, Polymarket feed logic, and AI context docs. Raw inventory shows branch `main`, latest commit `966f6c2 Stabilize PREMVP15 feed contract and evidence stack`, and Git status `?? docs/`, meaning context docs were untracked at the time of inventory. Active high-risk areas are `lib/feed/*`, `app/api/feed/*`, `app/reconstruction/*`, card/carousel/modal components, and Supabase/server files. Multiple reconstruction backup/broken files exist and should be treated as legacy unless explicitly restored. Exact runtime behavior, active import graph, build status, production status, Supabase schema, Railway deployment context, and docs tracking status still require verification before implementation.

