# **10\_DESIGN\_SYSTEM\_AND\_FRONTEND\_BASELINE.md**

---

## CURRENT FRONTEND BASELINE OVERRIDE — 2026-05-15

- Current active UI gate: Decision Card visual acceptance
- Current visual blocker: Market Return tile is overcrowded
- Observed issue: separate "Odds +160" chip/label inside the Market Return tile visually collides/overloads the tile
- Accepted direction: Market Return / American odds concept remains, but the tile must prioritize readability
- Preferred next UI fix: remove or simplify the separate Odds chip; preserve "Market Return", "+$X", and "per $100 stake"
- Do not redesign the card
- Do not touch Signal Confidence, Trust Metrics, Position, filters, carousel, modal, backend scoring, or CTA during this fix
- No CSS broad refactor
- Allowed file for next patch: `app/reconstruction/page.tsx` only
- Founder visual acceptance required after patch

---

## **1\. Purpose**

This file documents the current frontend/design baseline for PolyProPicks / PolyPicks Current.

It exists to prevent AI coding agents from breaking the existing frontend while implementing backend, payment, auth, API, feed, or connector work.

The frontend is already partially/mostly built. It must not be casually redesigned, broadly refactored, or “cleaned up” by new agents.

This file should help ChatGPT, Codex, Claude, Windsurf, and future coding agents understand:

* The current visual/product direction.  
* Which UI surfaces are product-critical.  
* Which frontend behaviors are locked.  
* What must be preserved during backend/payment/API work.  
* How screenshot/browser acceptance works.  
* How to avoid CSS churn, DOM churn, layout regressions, and agent-driven visual drift.

Build passing is not visual acceptance. The founder/operator performs final visual and business acceptance.

## **2\. Current Visual Identity**

Known visual identity:

* Premium dark fintech / betting / prediction-market style.  
* Mobile-first landing page.  
* High-contrast card-based interface.  
* Sports/prediction-market signal product.  
* Dark glassy/terminal-like look.  
* Neon/cyan/green/yellow accents.  
* Premium signal / market intelligence feeling.  
* Cards are the product surface, not decoration.

The product should feel like:

* A premium sports signal interface.  
* A prediction-market edge scanner.  
* A mobile-first betting/market intelligence product.  
* A high-value paid feed, not a generic SaaS dashboard.

The product should not feel like:

* Generic SaaS template.  
* Light corporate dashboard.  
* Random web3 landing.  
* Casino/scam UI.  
* Unverified “guaranteed profit” product.  
* Fake institutional smart-money tool.  
* Overbuilt desktop dashboard before mobile landing is stable.

Exact color tokens / CSS variables:

NEEDS VERIFICATION

Exact typography system:

NEEDS VERIFICATION

Exact current class names:

NEEDS VERIFICATION

## **3\. Mobile-First Baseline**

The landing is mobile-first.

Known target viewports from prior work:

390×844  
428×926  
428×760 for full-screen modal/paywall checks

Primary design acceptance should happen on mobile-sized viewport first.

Desktop can exist, but desktop polish must not break mobile.

Mobile-first assumptions:

* The initial screen must remain readable without requiring desktop width.  
* PremiumEventCard must remain the main decision surface.  
* MarketSourceCard must remain supporting evidence above the signal card.  
* Locked feed behavior must work on mobile gestures/taps.  
* Full-screen modal/paywall must fit mobile viewport and avoid accidental scroll unless explicitly designed.  
* CTA must remain visible and clear.  
* Evidence cards must not overflow, overlap, or become unreadable on 390–428 px width.  
* Text should be readable and should not be blindly clipped for “clean layout.”

Known issue/risk:

* Previous visual work caused card readability problems, clipped text, fake charts, duplicated data, and unstable evidence-card behavior.  
* Any future UI work must be screenshot-verified.

## **4\. Core UI Surfaces**

Core frontend surfaces:

1. Landing page `/`  
2. Reconstruction/reference route `/reconstruction`  
3. PremiumEventCard / main signal card  
4. MarketSourceCard / evidence card  
5. PremiumEventCarousel / locked premium feed  
6. MarketSourceCarousel / evidence carousel  
7. PassOfferModal / premium unlock modal  
8. CTA email/free-signal modal  
9. Filter pills / category controls  
10. Trust metrics block  
11. Signal confidence ring/card  
12. Position/profit blocks

Product-critical surfaces:

* PremiumEventCard  
* MarketSourceCard  
* PremiumEventCarousel locked feed  
* MarketSourceCarousel evidence stack  
* PassOfferModal  
* CTA/free-signal capture flow

Cards are the product. They must not be treated as decorative layout blocks.

## **5\. Locked Component Roles**

### **LandingPair**

LandingPair is the canonical product/data unit.

Rules:

* One LandingPair represents one premium signal plus its market evidence.  
* PremiumEventCard and MarketSource evidence must remain synchronized.  
* `marketSource` backward compatibility must be preserved.  
* `marketSources[]` evidence stack must remain compatible.  
* Do not create an independent MarketSource feed detached from active PremiumEventCard.

### **PremiumEventCard**

Role:

* Master signal card.  
* Primary decision surface.  
* Shows event, position, price/profit, signal confidence, trust metrics, and CTA.  
* User decision starts here.

Rules:

* PremiumEventCard is the master.  
* MarketSource evidence depends on the active PremiumEventCard.  
* Evidence card changes must not change the active PremiumEventCard.  
* Active PremiumEventCard changes may reset evidence index.

### **MarketSourceCard / MarketSourceCarousel**

Role:

* Supporting evidence for the active PremiumEventCard.  
* Shows market-source, market-momentum, and sharp-flow style evidence when available.  
* It must not become an independent unrelated carousel.

Rules:

* Evidence belongs to the active LandingPair.  
* MarketSourceCarousel should consume active `LandingPair.marketSources[]`.  
* MarketSourceCard should render evidence type differences without inventing unsupported claims.  
* Sharp Flow must only be shown when backend provides real trade-size evidence.  
* Market Momentum must not duplicate Market Source data without context.

### **PremiumEventCarousel**

Role:

* Main locked premium feed.  
* Shows active PremiumEventCard and locked/peek behavior.  
* User attempts to browse locked feed should open pass/paywall modal.

Rules:

* Locked swipe/peek attempt opens PassOfferModal.  
* Locked attempt must not change active pair before unlock.  
* Filters are free controls unless explicitly changed by product decision.  
* Do not convert locked feed into free browsing unless approved.

### **PassOfferModal**

Role:

* Premium unlock/paywall modal.  
* Full-screen/mobile-first.  
* Triggered by locked feed attempts.  
* Separates paid unlock from free signal CTA.

Rules:

* PassOfferModal is not the same as free CTA email modal.  
* It should not be replaced by generic auth/register screen.  
* It should not hide renewal/payment terms when payment is active.  
* It must not claim guaranteed profit.

## **6\. Frontend Files Likely Involved**

Known likely files:

app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
components/carousels/MarketSourceCarousel.tsx  
components/carousels/PremiumEventCarousel.tsx  
components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/modals/PassOfferModal.tsx  
content/signals.ts  
content/marketSources.ts

Exact current paths/classes must be verified before editing.

Other possible files:

app/page.tsx  
app/layout.tsx  
public/icons/\*  
public/brand/\*

Status:

NEEDS VERIFICATION

Rules:

* Do not touch frontend files during backend-only tasks.  
* Do not touch backend/feed/payment files during visual-only tasks.  
* Do not edit `content/signals.ts` or `content/marketSources.ts` unless the task is explicitly manual fallback/content data.  
* Do not add a new UI library/design system without explicit approval.

## **7\. Styling / CSS Preservation Rules**

Hard preservation rules:

* Do not rename existing classNames unless explicitly required.  
* Do not change existing DOM nesting unless explicitly required.  
* Do not add/remove wrapper divs around visual blocks unless explicitly required.  
* Do not refactor JSX for cleanliness.  
* Do not rewrite working layout.  
* Do not perform broad CSS cleanup.  
* Do not append random override blocks to fight previous CSS.  
* Do not change card dimensions, z-index, overflow, transforms, or responsive behavior unless scoped.  
* Do not change modal positioning or locked-feed behavior during unrelated tasks.  
* Do not alter mobile breakpoints without screenshot verification.  
* Do not change CTA/paywall copy during visual layout work unless explicitly scoped.  
* Do not change backend/data logic from a CSS/UI patch.

If a UI change requires DOM structure change:

1. Stop.  
2. Explain exactly why DOM structure must change.  
3. Identify affected components.  
4. Get explicit approval.  
5. Proceed with smallest possible replacement.

Preferred visual patch style:

* Inspect active source.  
* Identify exact component and CSS selectors.  
* Make targeted replacement.  
* Run build.  
* Verify screenshot/browser behavior.  
* Avoid broad refactor.

Build passing is required but not sufficient.

## **8\. PassOfferModal Baseline**

Known baseline:

* Full-screen / mobile-first premium unlock modal.  
* Triggered by locked feed attempt:  
  * swipe attempt  
  * tap on locked/peek card  
  * locked premium action  
* Not triggered by normal free CTA email capture unless explicitly designed.  
* Should preserve premium dark fintech style.  
* Should explain paid unlock clearly.  
* Must not use fake countdowns.  
* Must not make guaranteed profit claims.  
* Must not hide terms/renewal details when real payment is enabled.  
* Must not force registration before access logic is designed.

Known pricing direction from prior context:

24-Hour Pass around $4.99  
7-Day Premium around $15  
Monthly Pro around $49

Exact current modal copy/prices:

NEEDS VERIFICATION

Rules:

* Do not replace PassOfferModal with generic login/auth modal.  
* Do not wire checkout directly from UI without `/api/checkout/create`.  
* Do not trust frontend payment success.  
* Do not make Whop/Stripe UI-specific access state the source of truth.  
* Paid unlock must eventually flow through provider webhook → internal entitlement.

## **9\. PremiumEventCard Baseline**

Role:

* Main product card.  
* Master signal card.  
* Shows the active signal in the locked feed.

Known content concepts:

* Event title.  
* League/time.  
* Position.  
* Profit / potential return.  
* Signal confidence.  
* Trust metrics.  
* CTA.  
* Price in cents.  
* Confidence label.

Known CTA:

Get 5 Free Signals NOW

Rules:

* Do not change the visible primary free CTA casually.  
* Do not reintroduce direct payment CTA on the free landing unless explicitly approved.  
* Do not rename “Signal Confidence” back to misleading “Win Probability” if product direction has changed.  
* Do not claim guaranteed probability/guaranteed profit.  
* Do not break trust metrics order or readability.  
* Do not let MarketSource evidence drive active PremiumEventCard changes.  
* Do not change active pair behavior during visual card tweaks.

Known trust metrics concepts:

Smart Money  
Whale/Public or Public vs Whale Money  
PreEventScore AI

Exact labels/current order:

NEEDS VERIFICATION

## **10\. MarketSourceCard / MarketSourceCarousel Baseline**

Role:

* Supporting evidence stack for the active PremiumEventCard.  
* Evidence types may include:  
  * `market-source`  
  * `market-momentum`  
  * `sharp-flow`  
  * `news-pulse` later only if verified news/data source exists.

P0 evidence types from locked product direction:

market-source  
market-momentum  
sharp-flow  
news-pulse later / disabled unless real source exists

Known current / desired behavior:

* Market Source: baseline market proof, volume/source/current price.  
* Market Momentum: odds movement / implied odds / market repricing context.  
* Sharp Flow: large trade / whale-sized trade evidence only when real data exists.  
* News Pulse: not to be faked; disabled unless verified external news integration exists.

Important rules:

* Do not show Sharp Flow unless backend provides real trade-size evidence.  
* Do not duplicate the same number across different evidence cards without context.  
* Do not show fake chart implying movement when delta is zero, unless clearly styled as generic market visualization.  
* Do not show `+0% up`.  
* Zero/flat movement must not be described as “up.”  
* If delta is zero, prefer copy such as “Odds holding” or hide directional delta.  
* Market Momentum copy must include context, not just “Odds holding 2.7”.  
* Labels/pills should match evidence type, not always show Polymarket/Polygon/Live market.  
* MarketSource evidence must change independently only within active pair evidence stack.  
* Evidence card change must not change PremiumEventCard.

Visual baseline/direction:

* Market Source should be chart-like.  
* Sharp Flow should use whale/shark/avatar-style visual or other clearly distinct large-trade visual.  
* Market Momentum should use matchup/team/odds-style visual.  
* Exact assets/source of logos/flags/images:  
  * `NEEDS VERIFICATION`

Current implementation state:

NEEDS VERIFICATION

Known risk:

* Prior iterations produced weak placeholders, static fake charts, duplicate data, missing Sharp Flow, and confusing left visuals.  
* Future visual work must start only after backend/API proves the required evidence types exist.

## **11\. PremiumEventCarousel / Locked Feed Baseline**

Role:

* Shows premium signal feed.  
* Locked feed should create paywall/pass-offer intent.  
* User should see at least one free signal.  
* Additional locked feed browsing should trigger PassOfferModal.

Rules:

* Attempting locked swipe/peek/navigation opens pass/paywall modal.  
* Locked attempt must not change active pair before unlock.  
* Feed lock should not block initial free signal.  
* Filters are free controls unless explicitly changed.  
* Do not make independent MarketSource carousel browsing change PremiumEventCard.  
* Do not remove right-edge peek/locked affordance without explicit approval.  
* Do not make the premium feed fully free by accident.

Exact current carousel implementation:

NEEDS VERIFICATION

## **12\. CTA / Copy / Pricing Preservation**

Known free CTA:

Get 5 Free Signals NOW

Rules:

* Preserve “Get 5 Free Signals NOW” unless explicitly approved.  
* Do not replace free CTA with direct checkout CTA on landing.  
* Do not use “guaranteed profit,” “guaranteed win,” or similar claims.  
* Do not claim real predictive ML if current feed is display-grade deterministic signal generation.  
* Do not call derived proxy metrics verified smart money unless source supports it.  
* Do not introduce payment copy without payment architecture verification.  
* Do not add forced sign-up language before auth/payment boundary is designed.  
* Do not change paywall pricing/copy during backend/API work.

Payment-related copy must remain consistent with provider and legal reality.

Known paid offer/pricing direction:

24-Hour Pass around $4.99  
7-Day Premium around $15  
Monthly Pro around $49

Exact current pricing/copy:

NEEDS VERIFICATION

## **13\. Visual Acceptance Rules**

Build passing is not visual acceptance.

UI acceptance requires:

1. `npm run build` passes.  
2. Browser renders the target route.  
3. Mobile viewport screenshot check.  
4. Behavior check:  
   * locked feed attempt opens modal  
   * evidence changes do not change active signal  
   * CTA opens correct flow  
   * modal closes/opens correctly  
5. Founder performs final visual/business acceptance.

Minimum visual checks:

http://localhost:3000  
http://localhost:3000/reconstruction

Viewport checks:

390×844  
428×926  
428×760 for modal/paywall

Screenshots should verify:

* No overlap.  
* No clipped important text.  
* No unreadable typography.  
* No fake/misleading `0% up`.  
* CTA visible and correct.  
* PremiumEventCard remains stable.  
* Evidence cards correspond to active PremiumEventCard.  
* PassOfferModal fits screen.  
* No layout regression on initial viewport.

Agents must not claim UI acceptance from build output alone.

## **14\. Forbidden UI Changes**

Forbidden without explicit approval:

* Full redesign.  
* New design system library.  
* New UI framework.  
* Broad CSS refactor.  
* DOM restructure.  
* Renaming classNames.  
* Removing wrappers.  
* Adding wrappers around existing visual blocks.  
* Rewriting card layout for “cleanliness.”  
* Changing CTA copy.  
* Changing pricing.  
* Changing pass/paywall behavior.  
* Changing locked feed behavior.  
* Making MarketSourceCarousel independent from PremiumEventCard.  
* Making evidence card navigation change PremiumEventCard.  
* Forcing login before free signal.  
* Removing manual fallback.  
* Removing mobile-first layout.  
* Adding fake charts/claims without data context.  
* Showing Sharp Flow without real backend evidence.  
* Showing News Pulse without real verified news/source.  
* Adding animations that affect layout stability without approval.  
* Touching backend/feed/payment in a visual-only patch.  
* Touching UI/CSS in a backend-only patch.

## **15\. Safe UI Patch Protocol**

Before a UI patch:

1. Read relevant context:  
   * `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md`  
   * `03_CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
   * `04_PRODUCT_DECISIONS_LOCKED.md`  
   * `05_WINDSURF_WORKFLOW_RULES.md`  
2. Run or request:  
   * `git branch --show-current`  
   * `git status --short`  
   * `git log --oneline -5`  
3. Identify exact UI issue.  
4. Identify exact allowed files.  
5. Identify forbidden files.  
6. Inspect current component source.  
7. Inspect current CSS source.  
8. Propose smallest patch.  
9. Stop for approval if DOM/class/wrapper structure must change.

During patch:

* Touch only scoped UI files.  
* Preserve classNames/DOM unless approved.  
* Avoid broad CSS overrides.  
* Avoid unrelated copy changes.  
* Avoid backend/data changes.  
* Keep manual fallback working.  
* Keep locked feed behavior working.

After patch:

npm run build  
git diff \--check  
git status \--short  
git diff \--stat

Then browser check:

http://localhost:3000  
http://localhost:3000/reconstruction

Then screenshot/mobile behavior check.

Commit only after:

* Build passes.  
* Diff scope is correct.  
* Browser behavior is acceptable.  
* Founder gives visual/business acceptance.

## **16\. What Agents Must Inspect Before UI Work**

Before touching UI, agents must inspect:

NEEDS VERIFICATION current file paths

Likely files to inspect:

app/reconstruction/page.tsx  
app/reconstruction/Reconstruction.module.css  
components/carousels/MarketSourceCarousel.tsx  
components/carousels/PremiumEventCarousel.tsx  
components/cards/MarketSourceCard.tsx  
components/cards/MarketSourceCard.module.css  
components/modals/PassOfferModal.tsx  
content/signals.ts  
content/marketSources.ts

Agents must answer before editing:

1. Which route is affected?  
2. Which component is affected?  
3. Which CSS file is affected?  
4. Which classNames/selectors are active?  
5. Is this visual-only or data/backend?  
6. Does this touch PremiumEventCard, MarketSourceCard, carousel, modal, CTA, or filter behavior?  
7. What must not change?  
8. What screenshots are required?  
9. What browser behavior must be tested?  
10. What are the stop conditions?

If exact source/class/DOM structure is unknown, write:

NEEDS VERIFICATION

## **17\. Design Handoff Summary**

PolyProPicks frontend is a mobile-first premium fintech / betting / prediction-market interface. The product surface is the card system: PremiumEventCard is the master signal card, and MarketSourceCard / MarketSourceCarousel is dependent evidence for the active LandingPair. PassOfferModal is the mobile-first premium unlock modal triggered by locked feed attempts. The free CTA must remain visible, and one free signal must remain accessible without forced registration. Future agents must not redesign casually, rename classNames, restructure DOM, rewrite CSS broadly, or change CTA/paywall/locked-feed behavior without approval. Build passing is not visual acceptance; mobile browser screenshots and founder visual/business acceptance are required.

