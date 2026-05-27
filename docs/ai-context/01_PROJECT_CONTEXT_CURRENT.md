# **PROJECT\_CONTEXT\_CURRENT.md**
> ⚠️ CURRENT STATE OVERRIDE — 2026-05-28
> Previous override (14.05.2026) superseded. Use this block.
>
> ACTIVE BRANCH: main
> HEAD: fe5e0de (Repo: ignore local portrait source artifacts)
> WORKING TREE: clean (only docs/design/ untracked intentionally)
>
> CURRENT PHASE: Pre-audience onboarding — operational readiness
>
> COMPLETED FEATURES:
>   ✅ Top carousel: Shark Flow portrait medallion + Weekly Resolved Proof card
>   ✅ Portrait system: 24 normalized WebP, manifest, deterministic picker, diversity fix
>   ✅ Resolver cron: 6h UTC, processes newest signals first, wider window
>   ✅ Cache cron: ~30 min refresh cycle
>   ✅ Weekly proof card: real resolved data, cyan color family
>   ✅ Repo hygiene: .gitignore cleaned for portrait artifacts
>
> NEXT PRIORITY:
>   → Daily morning GMT+3 automated ops report (NOT YET IMPLEMENTED)
>   → See .claude/commands/daily-ops-report-plan.md for spec
>   → Do NOT redesign top proof cards without explicit P0 regression
>
> See 09_CONTEXT_DELTA_LOG.md (entry 2026-05-28) for full detail.
## **1\. Project Identity**

* **Product name:** PolyProPicks  
* **Alternative/internal names:** PolyPicks, PolyProPicks PreMVP, PREMVP  
* **One-sentence product definition:** A mobile-first sports / prediction-market signal product that turns noisy Polymarket-style market data into one clear decision card with supporting market evidence.  
* **Target product category:** Prediction-market intelligence, sports signal feed, premium betting/prediction-market decision layer.  
* **Core user problem:** Users see noisy odds, markets, trades, volumes, and fragmented “capper/influencer” signals but lack a fast, credible reason to act.  
* **Core user promise:** “See one clear signal, the suggested position, the confidence score, the potential return, and the market evidence behind it.”  
* **Current development mode:** PreMVP / production prototype.  
* **Primary user segment:** Sports prediction-market users and bettors who want fast signal cards before odds move.  
* **Secondary user segments:**  
  * Polymarket / Kalshi users.  
  * Telegram/X/Discord signal consumers.  
  * Users buying or following capper/influencer picks.  
  * World Cup 2026 / major sports-event traffic.  
  * Sports bettors who want simplified “enter / wait / skip”-style decisions.

## **2\. Product Concept**

The user lands on a mobile-first page and sees:

* An upper **MarketSourceCard / MarketSourceCarousel** proof layer.  
* A lower **PremiumEventCard / PremiumEventCarousel** signal layer.  
* A clear CTA for free signal capture.  
* A locked premium feed interaction that opens a full-screen pass/paywall modal.

What the user gets for free:

* One visible premium-style signal.  
* Current event title.  
* Suggested position.  
* Profit / potential return display.  
* Signal Confidence.  
* Trust metrics / market evidence.  
* CTA to get free signals via email capture.

What is locked/premium:

* Access to additional premium signal cards.  
* Premium feed browsing.  
* More evidence cards and premium context.  
* Future paid pass/subscription access.

What triggers the premium/pass modal:

* Tap on the right-edge peek of the next PremiumEventCard.  
* Locked feed attempt.  
* Swipe attempt on the premium card feed if implemented/active.  
* Main CTA does **not** open the paid pass modal; it opens the free signal capture flow.

What “signal” means in this product:

* A deterministic display-grade recommendation produced from current market/proxy data.  
* It includes event, selected outcome/position, Signal Confidence, profit/potential return, trust metrics, and CTA.  
* It is not a calibrated ML prediction or guaranteed betting outcome.

What “market source/evidence” means:

* A supporting proof card explaining why the signal exists.  
* It must be tied to the same event / market / selected outcome as the active PremiumEventCard.  
* It is not a random separate news/market carousel.

Product positioning:

* Premium sports signal feed for prediction-market users.  
* Fast decision cards instead of order books/charts.  
* Polymarket-first / Kalshi-direction compatible.  
* Uses official public Polymarket data for the current API-lite phase.  
* “Smart-money / sharp-flow / market momentum” must be treated as proxy language unless verified data sources exist.

The product is **not**:

* A full SaaS platform yet.  
* A real calibrated ML prediction engine yet.  
* A guaranteed-profit betting product.  
* A generic sports news site.  
* A fully live trading terminal.  
* A fully paid product with active Stripe/auth/admin yet.

## **3\. Current Strategic Goal**

Current near-term milestone:

**Build a production-facing, mobile-first, indexable, lead-capturing, API-assisted landing with a locked premium feed and backend evidence-stack foundation.**

Why this matters:

* The landing must be credible enough to capture real demand.  
* The premium feed interaction must make users understand that more value is locked.  
* Evidence cards must explain why a signal exists without fake ML/news/smart-money claims.  
* The backend shape must be ready for multiple evidence cards before the UI carousel starts rotating them.

Must be shipped before adding complexity:

* Stable production landing.  
* Real lead capture.  
* Premium reserve intent capture.  
* API-fed signal cards.  
* Supabase cache foundation.  
* Backward-compatible `marketSources[]` evidence stack.  
* Backend generation of 1–3 evidence cards.  
* Verification that current UI does not regress.

Deliberately postponed:

* Stripe/payment activation.  
* Full auth.  
* Admin dashboard.  
* Full subscription system.  
* Kalshi integration.  
* Real news API.  
* Real ML prediction model.  
* Complex visual regression/test suite.  
* MarketSourceCarousel evidence rotation UI until backend/data foundation is stable.  
* Additional card types beyond the approved four.

## **4\. Current Product Surface**

### **Landing page**

* Production domain: `https://polypropicks.com`  
* Hosted on Railway.  
* Main route `/` renders the landing.  
* `/reconstruction` remains a reference/debug visual route.  
* Mobile-first, premium dark fintech/sports-prediction visual style.

### **PremiumEventCard**

* Main decision card.  
* Shows active event, position, profit, Signal Confidence, trust metrics, and CTA.  
* It is the **master** signal surface.  
* It controls which evidence stack is relevant.

### **MarketSourceCard / MarketSourceCarousel**

* Upper evidence/proof layer.  
* Current UI still uses primary `marketSource`.  
* Future PREMVP12 direction: rotate `marketSources[]` for the active PremiumEventCard only.  
* Must not drift to unrelated event evidence.

### **PremiumEventCarousel**

* Displays active PremiumEventCard and right-edge peek of next card.  
* Locked behavior opens paywall/pass modal instead of changing active pair.  
* Future unlocked state may allow browsing.

### **PassOfferModal**

* Full-screen pass/paywall modal.  
* Triggered by locked premium feed attempt.  
* Current paywall model:  
  * `7-Day Premium — $15`  
  * `24-Hour Pass — $4.99`  
  * `Monthly Pro — $49`  
* Current intended CTA:  
  * `Unlock 7-Day Premium — $15`  
* Secondary:  
  * `Keep only 1 free signal`  
* Reserve flow is separate from the free-signal email modal.

### **CTA/modal behavior**

* Main landing CTA:  
  * `Get 5 Free Signals NOW`  
* Main CTA opens free-signal lead capture.  
* Locked feed attempt opens PassOfferModal.  
* Premium reserve intent has been implemented and production-accepted.

### **Filters**

* Filters are free controls.  
* They should not open paywall.  
* They should act as jump-controls / selection controls, not paid locks.

### **Locked feed behavior**

* Before payment/unlock, user can see one signal and a next-card peek.  
* Attempting to access next card opens paywall/pass modal.  
* Active PremiumEventCard should not change on locked attempt.  
* MarketSource should remain synced with active PremiumEventCard.

### **Mobile-first target**

Primary adaptive browser test targets:

* `390×700`  
* `428×760`

Secondary viewport checks:

* `390×844`  
* `428×926`

## **5\. Locked Architecture Summary**

### **Canonical unit**

`LandingPair` is the canonical source of truth.

Conceptual shape:

{  
  id: string;  
  premiumSignal: PremiumSignal;  
  marketSource: MarketSource;  
  marketSources?: MarketSource\[\];  
  filterTags: FilterTag\[\];  
  isDefaultToday?: boolean;  
  priority?: number;  
  sortScore?: number;  
  volumeUsd?: number;  
  source?: LandingPairSource;  
}

### **Master/dependent relationship**

* `PremiumEventCard` is the master feed.  
* `MarketSourceCard` is dependent evidence.  
* One active PremiumEventCard \= one active event / market / selected outcome.  
* That active signal may have 1–4 MarketSourceCards in `marketSources[]`.

### **State principles**

Preferred state architecture:

* `allPairs`  
* `activePairId`  
* `activeFilter`  
* modal state  
* loading/error state if needed

Derived values:

* `candidatePairs`  
* `activePair`  
* `activeSignal`  
* `activeMarketSource`  
* `peekPair`  
* `peekSignal`  
* future `activeEvidenceIndex`

Do not store duplicate state for:

* `activePair`  
* `filteredPairs`  
* `activeMarketSource`  
* independent MarketSource index detached from active pair

### **`marketSource` vs `marketSources[]`**

* `marketSource` remains the primary proof card for current UI/backward compatibility.  
* `marketSources[]` is the future evidence stack.  
* `marketSources[0]` should correspond to `marketSource`.  
* Current PREMVP12 Step 2 production foundation verified:  
  * `hasMarketSource: true`  
  * `hasMarketSources: true`  
  * `marketSourcesLength: 1`  
  * `firstEvidenceMatches: true`

### **MarketSourceCarousel rule**

Do not treat MarketSourceCarousel as an independent random market/news feed.

Correct model:

activePremiumIndex controls current signal.  
activeEvidenceIndex controls evidence card within activePair.marketSources\[\].

When `activePremiumIndex` changes:

* PremiumEventCard changes.  
* MarketSource evidence stack changes to that pair’s `marketSources[]`.  
* `activeEvidenceIndex` resets to `0`.

When `activeEvidenceIndex` changes:

* Only upper evidence card changes.  
* Lower PremiumEventCard remains unchanged.

### **Fallback/manual override principles**

* Manual fallback content must remain.  
* API/cache can fail without breaking landing.  
* Current UI must remain stable even if `marketSources[]` is missing.  
* Future backend/API should produce the same shape the frontend expects.

### **API-lite/cached feed principles**

* Current API direction is official public Polymarket data.  
* Current formula: `trusted-initial-formula-v1.1`.  
* Deterministic display-grade scoring.  
* No fake ML.  
* No real calibrated win-probability claim.  
* `Signal Confidence` is an internal display score.

## **6\. Current Completed Work**

### **Production landing / mobile rescue**

* **Completed:** Mobile landing rescue and locked premium feed mobile UI.  
* **Status:** Merged to main and production deployed.  
* **Relevant commits:**  
  * `72750e4 Finalize PREMVP11 mobile landing rescue`  
  * `85008c3 Merge locked premium feed mobile UI`  
* **Why it matters:** Landing is the production baseline and should not be casually refactored.

### **PassOfferModal / paywall shell**

* **Completed:** Full-screen pass/paywall modal shell and visual design.  
* **Status:** Merged to main and pushed.  
* **Relevant commits:**  
  * `1d7c025 Add locked feed pass offer modal shell`  
  * `143a461 Polish pass offer modal visual design`  
  * `7294840 Merge pass offer modal visual design`  
* **Why it matters:** Locked premium feed attempts now have a monetization/intent surface.

### **Premium reserve intent capture**

* **Completed:** Premium reserve intent capture.  
* **Status:** Production-accepted.  
* **Relevant commit:**  
  * `dd9a578 Capture premium reserve intent`  
* **Known production acceptance:** Supabase `public.lead_intents` showed premium reserve rows with `source = pass_offer_modal`, `intent_type = premium_reserve`, and plan fields.  
* **Why it matters:** Pass modal is not just visual; it captures plan intent.

### **PREMVP12 Step 2 — Evidence stack foundation**

* **Completed:** Backward-compatible `marketSources[]` foundation.  
* **Status:** Merged to main, pushed, production verified.  
* **Relevant commits:**  
  * `6f55875 Add PREMVP12 evidence stack foundation`  
  * `8e96225 Merge PREMVP12 evidence stack foundation`  
* **Changed files:**  
  * `app/api/feed/landing-cards/route.ts`  
  * `content/marketSources.ts`  
  * `lib/feed/buildLandingCards.ts`  
  * `lib/feed/cacheGeneratedSignals.ts`  
  * `lib/feed/landingPairs.ts`  
  * `lib/feed/types.ts`  
* **Verified behavior:**  
  * `marketSource` preserved.  
  * `marketSources[]` present.  
  * `marketSources[0]` matches `marketSource`.  
  * No UI/carousel/CSS/Supabase schema change.  
  * No `market_sources` DB query.  
* **Why it matters:** Creates safe backend/data foundation for future evidence-card rotation.

### **PREMVP12 Step 3B — Backend evidence generation**

* **Completed as feature-branch commit only:** Backend evidence generation added.  
* **Status:** Feature branch committed, not merged/pushed.  
* **Branch:** `premvp12-evidence-generation`  
* **Relevant commit:**  
  * `18e3dc2 Generate PREMVP12 evidence stack cards`  
* **Changed file:**  
  * `lib/feed/buildLandingCards.ts`  
* **Known issue:** Commit was created despite `git diff --check` trailing whitespace warnings. Must clean whitespace and amend before merge/push.  
* **Why it matters:** Starts generating 1–3 backend evidence cards:  
  * primary `market-source`  
  * optional `sharp-flow`  
  * optional `market-momentum`  
  * no `news-pulse` yet

## **7\. Current Active / Latest Known State**

### **Latest known main**

* **Main latest known commit:** `8e96225 Merge PREMVP12 evidence stack foundation`  
* **Main status:** Pushed to origin/main.  
* **Production status:** Production eventually confirmed OK by user for PREMVP12 Step 2 `marketSources[]`.  
* **Production API:** `trusted-initial-formula-v1.1`, cache can return `hit`.

### **Latest known active feature branch**

* **Branch:** `premvp12-evidence-generation`  
* **Latest known feature commit:** `18e3dc2 Generate PREMVP12 evidence stack cards`  
* **Status:** Committed on feature branch, not merged to main.  
* **Working tree after commit:** Reported clean before the cleanup instruction.  
* **Known unresolved issue:** trailing whitespace existed in `lib/feed/buildLandingCards.ts` before commit. A cleanup/amend step was instructed but not yet confirmed.

### **Current backend/API status**

* `/api/feed/landing-cards` exists.  
* It may return cached data (`cacheStatus: hit`).  
* No cache-bypass query parameter known.  
* `debug-sports-cards` exists but uses a different mapper and does not verify `buildLandingCards.ts` evidence generation.  
* Runtime generation of Step 3B could not be fully verified because landing-cards endpoint returned cached rows.

### **Current frontend/UI status**

* Landing and modal baseline are production-deployed.  
* No UI changes were made in PREMVP12 Step 2\.  
* No UI changes should be made for Step 3 until backend generation is clean and accepted.  
* MarketSourceCarousel still uses primary `marketSource` behavior.

### **Current production verification status**

* Production verified for PREMVP12 Step 2 foundation.  
* Production not yet updated with Step 3B evidence generation because branch is not merged.  
* Runtime output for Step 3B generation remains **NEEDS VERIFICATION**.

### **Current known unmerged work**

* `premvp12-evidence-generation`  
* Commit: `18e3dc2 Generate PREMVP12 evidence stack cards`  
* Must be cleaned/amended before merge.

### **Current technical debt / blockers**

* **Immediate blocker:** trailing whitespace in committed `buildLandingCards.ts` must be removed and commit amended.  
* **Verification blocker:** no cache-bypass endpoint to force fresh evidence generation.  
* **Potential future task:** add a narrow debug/cache-bypass verification path, but not as part of the current cleanup unless explicitly chosen.  
* **Do not merge Step 3B to main until cleanup is confirmed.**

If current Git state is unknown, verify with:

git branch \--show-current  
git status \--short  
git log \--oneline \-5  
npm run build  
git diff \--check

## **8\. Immediate Next Phase**

### **Name**

**PREMVP12 Step 3B Cleanup \+ Verification Gate**

### **Why it is next**

The backend evidence-generation feature exists on a feature branch but was committed with whitespace warnings. It must be cleaned before merge/push. The project cannot afford another messy type/CSS cycle.

### **Exact scope**

* Clean trailing whitespace in `lib/feed/buildLandingCards.ts`.  
* Amend existing commit `18e3dc2`.  
* Confirm build passes.  
* Confirm only intended file is in the amended commit.  
* Decide whether to:  
  * keep Step 3B as build-verified feature checkpoint, or  
  * add a separate narrow verification helper/cache-bypass later.

### **Out of scope**

* No UI work.  
* No MarketSourceCarousel behavior change.  
* No CSS.  
* No modal work.  
* No Supabase schema changes.  
* No `market_sources` DB column.  
* No merge to main until cleanup/amend is confirmed.  
* No production deploy of Step 3B until merge decision.

### **Files likely involved**

* `lib/feed/buildLandingCards.ts`

### **Acceptance criteria**

* Branch is `premvp12-evidence-generation`.  
* Working tree starts clean or only intended whitespace cleanup appears.  
* `git diff --check` has no trailing whitespace errors.  
* `npm run build` passes.  
* Commit is amended, not a separate cleanup commit.  
* Working tree clean after amend.  
* Latest commit remains semantically `Generate PREMVP12 evidence stack cards`.  
* No other files changed.

### **Verification steps**

Use Windsurf or direct operator commands depending on command count. Since cleanup has multiple steps, use a bounded Windsurf prompt if continuing from a fresh project.

Required checks:

git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--check  
npm run build

### **What should be done first**

Verify branch and clean/amend `lib/feed/buildLandingCards.ts`.

### **What must not be touched**

* `app/api/feed/landing-cards/route.ts`  
* `content/marketSources.ts`  
* `lib/feed/landingPairs.ts`  
* `lib/feed/types.ts`  
* `lib/feed/cacheGeneratedSignals.ts`  
* `app/reconstruction/page.tsx`  
* carousels  
* cards  
* CSS  
* modal files  
* Supabase/Railway settings

## **9\. Active Constraints**

### **Business / product constraints**

* PreMVP speed matters.  
* Do not build full SaaS prematurely.  
* Do not add Stripe/auth/admin before current validation infrastructure is stable.  
* Product must capture real lead/reserve intent before adding complex paid infrastructure.  
* Do not make fake predictive, news, or institutional smart-money claims.

### **Technical constraints**

* Next.js / React / TypeScript / CSS Modules.  
* Supabase for lead/cache.  
* Railway for deployment.  
* Windows CMD preferred over PowerShell.  
* Keep production main stable.  
* Small feature branches.  
* Build before commit/push.  
* Do not push if build fails.  
* Do not commit unexpected files.  
* Do not depend on stale local cache for acceptance.

### **Workflow constraints**

* No broad refactors.  
* No uncontrolled Windsurf “fix build” loops.  
* If Windsurf fails once, perform direct-source option check before another prompt.  
* If more than 5 CMD commands are needed, package them as a bounded Windsurf prompt.  
* Founder should not manually edit multiple snippets.  
* Avoid multi-CMD-window choreography unless absolutely necessary.  
* Use source-of-truth file replacement for visual work when fidelity matters.  
* Build passing is not visual/product acceptance.  
* Windsurf self-reported success is not acceptance.  
* Screenshots/behavior/API output/Git cleanliness are acceptance.

### **Mobile constraints**

* Primary adaptive test sizes:  
  * `390×700`  
  * `428×760`  
* Secondary:  
  * `390×844`  
  * `428×926`  
* Mobile CTA must remain visible where required.  
* Paywall offer screen should fit without unnecessary scroll unless explicitly changed.

## **10\. Current Source-of-Truth Files / Components**

### **Routes/pages**

* `app/page.tsx`  
  * Production root route; should render the landing/reconstruction experience.  
* `app/reconstruction/page.tsx`  
  * Main landing implementation and state wiring.  
  * Contains active pair/filter/modal logic.  
  * Do not modify casually.  
* `app/reconstruction/Reconstruction.module.css`  
  * Fragile landing CSS with many historical overrides.  
  * Do not touch for paywall or backend evidence work.

### **Carousels**

* `components/carousels/PremiumEventCarousel.tsx`  
  * Premium signal feed / right-edge peek / locked attempt behavior.  
  * Should not be modified during backend evidence generation.  
* `components/carousels/MarketSourceCarousel.tsx`  
  * Upper evidence carousel.  
  * Currently consumes flat sources / primary marketSource behavior.  
  * Future PREMVP12 UI phase will make it rotate `activePair.marketSources[]`.

### **Cards**

* `components/cards/MarketSourceCard.tsx`  
  * Renders a single market source/evidence card.  
  * Do not redesign in current backend phase.  
* `components/cards/PremiumEventCard.tsx`  
  * May exist depending on current structure.  
  * Main signal card if separated from page implementation.  
  * Do not modify in current backend phase.

### **Modals**

* `components/modals/PassOfferModal.tsx`  
  * Full-screen pass/paywall modal.  
* `components/modals/PassOfferModal.module.css`  
  * Isolated paywall styling.  
  * Paywall styling must stay here, not in `Reconstruction.module.css`.

### **Feed/backend**

* `lib/feed/buildLandingCards.ts`  
  * Main API-lite signal generation.  
  * Current active unmerged Step 3B work is here.  
  * Generates `premiumSignal`, `marketSource`, and future `marketSources[]`.  
* `lib/feed/landingPairs.ts`  
  * LandingPair canonical type and evidence-stack normalization helpers.  
* `lib/feed/types.ts`  
  * Feed/API response types.  
* `lib/feed/cacheGeneratedSignals.ts`  
  * Supabase cache read/write types and logic.  
  * No `market_sources` DB column query should exist unless explicitly added in a future phase.  
* `app/api/feed/landing-cards/route.ts`  
  * Main feed endpoint.  
  * Cache-first behavior.  
  * No cache-bypass known.  
* `app/api/feed/debug-sports-cards/route.ts`  
  * Debug sports mapper endpoint.  
  * Does not verify `buildLandingCards.ts` Step 3B evidence generation.  
* `app/api/feed/debug-sports-discovery/route.ts`  
  * Sports discovery debug endpoint.

### **Content/data**

* `content/signals.ts`  
  * Manual/static signal fallback.  
* `content/marketSources.ts`  
  * MarketSource types/static fallback.  
  * PREMVP12 card type definitions include approved and legacy-compatible values.

### **Supabase**

* `lead_intents`  
  * Stores free lead and premium reserve intent.  
* `generated_signal_pairs`  
  * Cache table used for generated feed pairs.  
  * Current PREMVP12 Step 2 did not add `market_sources` column.

### **Deployment**

* Railway production deployment.  
* `main` pushed to origin triggers production deployment.  
* Use production checks after push.

## **11\. Current Acceptance Philosophy**

### **Visual acceptance**

* Screenshot and actual browser behavior are the source of truth.  
* Windsurf saying visual criteria are satisfied is not acceptance.  
* Build passing is not visual acceptance.

### **Build acceptance**

* `npm run build` must pass before commit/push.  
* TypeScript errors are hard blockers.  
* Lint/compat warnings may be tolerated only if they do not affect functionality and are understood.

### **API acceptance**

API changes must be verified with actual JSON output when possible.

For PREMVP12 evidence stack:

* `hasMarketSource: true`  
* `hasMarketSources: true`  
* `marketSourcesLength >= 1`  
* `firstEvidenceMatches: true`  
* `formulaVersion: trusted-initial-formula-v1.1`

Cache caveat:

* `cacheStatus: hit` may return old cached evidence count.  
* Lack of fresh generation path is a verification limitation, not necessarily code failure.

### **Production acceptance**

Production acceptance requires:

* push to main  
* Railway deployment complete  
* production HTTP/API check  
* client-side/manual trigger check if feature is client-only  
* not just static HTML string checks

### **Supabase acceptance**

For lead/reserve capture:

* actual rows in Supabase must exist.  
* localStorage fallback alone is not business acceptance.

### **Git cleanliness acceptance**

Before commit/push:

* `git status --short`  
* `git diff --stat`  
* `git diff --check`  
* `npm run build`  
* stage only intended files

### **Founder final acceptance**

Founder is final visual/business acceptor. The LLM/Windsurf can verify technical gates but cannot declare product acceptance without user confirmation.

## **12\. Obsolete / Do Not Revive**

Do not revive these unless explicitly requested:

* Old static-only PreMVP assumptions as active architecture.  
* Old `Win Probability` label; current label is `Signal Confidence`.  
* Direct payment-first main CTA.  
* Main CTA opening paid modal.  
* LocalStorage-only lead capture as business acceptance.  
* Independent MarketSourceCarousel browsing across unrelated events.  
* Random market/news upper carousel.  
* Broad “fix UI / improve layout / refactor” prompts.  
* Repeated CSS append/micro-patch loops.  
* Hidden arrows/dots as acceptable locked-feed UX.  
* Premature Google Auth.  
* Premature Stripe/payment activation.  
* Premature admin dashboard.  
* Premature full test suite / visual regression suite.  
* Fake news attribution without news API.  
* Fake institutional smart-money claims.  
* Adding visible Holder Concentration / Liquidity / Orderbook / generic Smart Money card types as P0.  
* Editing `Reconstruction.module.css` for paywall modal styling.  
* Treating Windsurf self-reports as final acceptance.  
* Multi-window CMD operator workflows unless unavoidable.

## **13\. Founder Operating Model**

The founder is the operator and visual/business acceptor, not the manual code editor.

The LLM must:

* Give exact commands or exact bounded Windsurf prompts.  
* State where commands run: local repo, localhost, production, Railway, Supabase.  
* State whether dev server must be running.  
* State whether Windsurf is involved.  
* State what output to paste back.  
* Keep operator actions linear.  
* Avoid multi-terminal instructions unless absolutely necessary.  
* If more than 5 CMD commands are needed, package them as a Windsurf prompt.  
* If Windsurf fails after one attempt, perform a direct-source option check before another Windsurf prompt.  
* Prefer full-file/source-of-truth replacements for visual components.  
* Do not ask founder to manually apply many snippets.  
* Use CMD, not PowerShell.  
* Distinguish:  
  * local build  
  * local API  
  * production API  
  * production UI  
  * Supabase database confirmation  
  * Git state

Mandatory Windsurf prompt boundaries:

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

\[full prompt\]

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

## **14\. Next 3 Recommended Actions**

### **Action 1 — Clean and amend PREMVP12 Step 3B commit**

* **Objective:** Remove trailing whitespace from `lib/feed/buildLandingCards.ts` and amend `18e3dc2`.  
* **Executor:** Windsurf preferred, because it is more than a trivial one-command step.  
* **Exact verification:**  
  * `git branch --show-current` \= `premvp12-evidence-generation`  
  * `git diff --check` clean  
  * `npm run build` passes  
  * `git status --short` clean after amend  
  * `git log --oneline -5` shows amended latest commit  
* **Expected output:** amended commit hash for `Generate PREMVP12 evidence stack cards`.  
* **Stop condition:** branch is not `premvp12-evidence-generation`, build fails, or cleanup changes logic.

### **Action 2 — Decide verification strategy for evidence generation**

* **Objective:** Decide whether Step 3B can be merged as build-verified backend generation or whether a narrow cache-bypass/debug verification path is required first.  
* **Executor:** ChatGPT after seeing amended commit status.  
* **Exact verification:**  
  * Review whether runtime generation can be forced without changing production behavior.  
  * Confirm `/api/feed/landing-cards` remains cache-hit.  
  * Confirm debug endpoint uses different mapper.  
* **Expected output:** decision:  
  * `merge later with build-only confidence`, or  
  * `create tiny debug/cache-bypass verification branch`.  
* **Stop condition:** any proposal that edits UI, CSS, Supabase schema, or production behavior unnecessarily.

### **Action 3 — Merge Step 3B only after cleanup and decision**

* **Objective:** Merge backend evidence generation to main only when cleanup is done and verification risk is accepted.  
* **Executor:** Founder/operator or Windsurf using bounded prompt.  
* **Exact verification:**  
  * merge without conflict  
  * `npm run build` passes on main  
  * `git status --short` clean  
  * push to `origin/main`  
  * production API remains healthy  
* **Expected output:** merge commit hash, push result, production API result.  
* **Stop condition:** build fails, unexpected dirty files, or production API breaks.

## **15\. One-Paragraph Handoff**

PolyProPicks is a mobile-first sports/prediction-market signal product that shows one clear PremiumEventCard decision with supporting MarketSourceCard evidence and a locked premium feed/paywall flow. The current production baseline has a live Railway landing, Supabase lead/reserve capture, pass offer modal, cached API feed, and PREMVP12 evidence-stack foundation merged to main at `8e96225`, with `marketSource` preserved and `marketSources[]` verified in production. The locked architecture is `LandingPair` as canonical source, PremiumEventCard as master, MarketSourceCard as dependent evidence, filters as free controls, and locked swipe/peek attempts opening the pass modal without changing active pair. The active unmerged work is PREMVP12 Step 3B backend evidence generation on branch `premvp12-evidence-generation`, commit `18e3dc2`, changing only `lib/feed/buildLandingCards.ts`; build passed, but trailing whitespace was committed and must be cleaned/amended before any merge/push. Current next step is cleanup/amend and then decide whether to merge Step 3B or add a narrow cache-bypass/debug verification path, with no UI/CSS/Supabase/schema changes.

