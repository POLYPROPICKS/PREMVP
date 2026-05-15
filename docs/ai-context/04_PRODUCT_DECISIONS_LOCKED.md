# **PRODUCT\_DECISIONS\_LOCKED.md**

---

## CURRENT ROADMAP OVERRIDE — 2026-05-15

> This section supersedes older roadmap/order sections where they conflict with current main.

- Current branch: `main`
- Current HEAD: `1d254cc` Score: selectedOdds banded confidence and anchored trust metrics
- Current active gate: Decision Card visual acceptance
- Signal Confidence scoring rebuild is already on main ✅
- Market Return / American odds direction is already on main, but not visually accepted yet
- Current blocker: Market Return tile overcrowding; the "Odds +160" chip/label visually collides inside the tile
- Next safe product patch: `app/reconstruction/page.tsx` only — simplify/remove the separate Odds chip inside profitCol while preserving +$ return and "per $100 stake"
- After visual acceptance: inspect/fix filterTags / one-card-across-filters issue
- MarketSourceCarousel evidence-stack UI: ON HOLD until Decision Card + filter/selection sanity accepted
- Whop readiness/integration: ON HOLD until card/feed/evidence sanity accepted
- Older PREMVP12 backend-only roadmap/order is HISTORICAL / SUPERSEDED where it conflicts with this override
- Locked decisions still active: no fake ML, no Win Probability label, no guaranteed profit claims, no independent MarketSourceCarousel browsing, no premature payment/auth/admin

---

## **1\. Purpose**

This file prevents product and architecture context drift for PolyProPicks / PolyPicks Current.

It defines locked or strongly active decisions that future LLMs must not casually reopen, override, or “improve” without explicit founder approval.

This file is the product decision ledger. It is not a technical state file, not a workflow file, and not a history dump.

Any future change to these decisions requires one of:

* explicit founder approval  
* a new accepted production result  
* a new merged implementation that intentionally supersedes a decision  
* a documented strategic decision replacing the current one

Future LLMs must treat these decisions as active constraints.

## **2\. Product Positioning Decisions**

### **DECISION: PolyProPicks is a sports / prediction-market signal product**

* Status: Locked  
* Decision: PolyProPicks is positioned as a premium sports and prediction-market signal feed for users who want fast, decision-ready market insights.  
* Reason: The product’s value is not raw data access; it is converting market noise into one clear decision card with supporting evidence.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: UI, copy, API feed, evidence stack, pass modal, and lead capture must all support the signal-feed positioning.

### **DECISION: Clarity-first decision cards beat complex trading UI for PreMVP**

* Status: Locked  
* Decision: The PreMVP should present simplified decision cards, not heavy order books, dense charts, or professional trading terminal complexity.  
* Reason: Target users need fast “what should I look at / what is the signal / why does it matter” clarity, not another raw market interface.  
* Do not change without: Explicit founder approval and evidence that advanced users are the immediate target.  
* Related implementation impact: PremiumEventCard remains the primary product surface; charts and market data are supporting evidence, not the main UI.

### **DECISION: PremiumEventCard is the main product surface**

* Status: Locked  
* Decision: The lower PremiumEventCard is the core signal/decision card.  
* Reason: It contains the event, position, profit/potential return, Signal Confidence, and CTA — the decision-making payload.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: PremiumEventCard drives the active signal; MarketSource evidence must depend on it.

### **DECISION: MarketSourceCard is supporting evidence, not the main feed**

* Status: Locked  
* Decision: MarketSourceCard exists to explain why the active PremiumEventCard signal appeared.  
* Reason: Evidence supports user trust and conversion but should not overtake the main decision card.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: MarketSourceCarousel must not become an unrelated independent feed.

### **DECISION: Product direction is Polymarket-first / Kalshi-compatible**

* Status: Active  
* Decision: Current API-lite direction uses official public Polymarket data first while preserving broader prediction-market/Kalshi positioning.  
* Reason: Polymarket public data is available now; Kalshi and other sources add complexity and should not block current validation.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Current backend formula must avoid unsupported data claims and keep future source expansion possible.

### **DECISION: World Cup / sports-event timing remains a strategic growth context**

* Status: Active  
* Decision: Sports events, including World Cup 2026-style traffic, remain relevant positioning and acquisition context.  
* Reason: Event-driven sports traffic can create urgency and search/social demand.  
* Do not change without: Founder-level product/growth decision.  
* Related implementation impact: Sports categories, teams, odds movement, and event-specific cards should remain central.

### **DECISION: Premium fintech / betting visual language is active**

* Status: Locked  
* Decision: The product uses a dark, premium, mobile-first fintech/betting visual language.  
* Reason: The product must feel paid, sharp, and signal-driven, not like a generic blog or free picks page.  
* Do not change without: Explicit visual/product approval.  
* Related implementation impact: UI changes must preserve premium dark mode, high-contrast CTAs, card hierarchy, and mobile readability.

## **3\. Core UX Decisions**

### **DECISION: Mobile-first landing is the primary experience**

* Status: Locked  
* Decision: The landing must be optimized first for mobile adaptive viewports.  
* Reason: The product is intended for fast mobile consumption, social traffic, and sports-event contexts.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Primary testing viewports include `390×700` and `428×760`; secondary checks include `390×844` and `428×926`.

### **DECISION: One visible free signal is the current free product unit**

* Status: Locked  
* Decision: Users should see one strong free signal/card before encountering the locked premium feed.  
* Reason: The free signal demonstrates product value while creating a clear locked-feed upsell.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: First-screen PremiumEventCard remains readable and CTA-visible.

### **DECISION: Premium feed is locked behind interaction**

* Status: Locked  
* Decision: Attempting to access additional PremiumEventCards opens the pass/paywall modal.  
* Reason: The locked feed communicates scarcity and premium value without requiring immediate checkout infrastructure.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Swipe/tap on peek/locked next card should open PassOfferModal.

### **DECISION: Right-edge peek-card concept remains active**

* Status: Locked  
* Decision: The next PremiumEventCard should be visible as a right-edge peek/sliver to invite swipe/tap.  
* Reason: The peek makes locked premium depth visible without exposing the full feed.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: PremiumEventCarousel should preserve active card \+ visible next-card peek.

### **DECISION: Locked attempt must not change the active pair before unlock**

* Status: Locked  
* Decision: Before unlock, attempting to swipe/tap the next premium card opens the pass modal and must not change `activePair`.  
* Reason: Changing active signal while locked would desync evidence and confuse the free/premium boundary.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Locked feed handler must open modal without changing activePairId/activePremiumIndex.

### **DECISION: Filters are free controls**

* Status: Active  
* Decision: Filters should remain free controls / jump-controls, not paywall triggers.  
* Reason: Locking filters adds unnecessary friction and weakens the landing’s exploratory value.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Filter interactions should not open paywall unless a later explicit monetization decision changes this.

### **DECISION: No independent MarketSource browsing**

* Status: Locked  
* Decision: MarketSourceCarousel must not browse unrelated evidence from other events while the PremiumEventCard remains unchanged.  
* Reason: That creates proof/signal mismatch and destroys trust.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Future MarketSourceCarousel rotation must use `activePair.marketSources[]`.

### **DECISION: No heavy charts/order books for MVP**

* Status: Locked  
* Decision: Heavy trading charts/order books are out of scope for the PreMVP landing.  
* Reason: The product is a decision layer, not a professional trading dashboard.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Chart visuals can exist inside evidence cards, but must not dominate the interface.

## **4\. Feed / Data Architecture Decisions**

### **DECISION: LandingPair is the canonical product unit**

* Status: Locked  
* Decision: `LandingPair` is the canonical unit connecting one `premiumSignal` with its primary `marketSource` and future `marketSources[]`.  
* Reason: It prevents desync between signal and evidence.  
* Do not change without: Explicit architecture approval.  
* Related implementation impact: UI, API, filters, carousels, and evidence stack must respect LandingPair as source of truth.

### **DECISION: PremiumEventCard is master, MarketSourceCard is dependent**

* Status: Locked  
* Decision: PremiumEventCard controls the active signal; MarketSourceCard evidence depends on it.  
* Reason: Evidence must support the selected event/outcome, not compete with it.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: ActivePremiumIndex/activePair controls evidence context.

### **DECISION: Preserve `marketSource` for backward compatibility**

* Status: Locked  
* Decision: The existing `marketSource` field remains primary and must not be removed.  
* Reason: Current UI and cache behavior depend on it.  
* Do not change without: Explicit migration plan.  
* Related implementation impact: New evidence-stack work must be additive.

### **DECISION: `marketSources[]` is the future evidence stack**

* Status: Locked  
* Decision: `marketSources[]` contains 1–4 evidence cards for the same active market/outcome.  
* Reason: Multiple proof angles create a premium terminal feel while preserving canonical pair architecture.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Future MarketSourceCarousel should rotate `activePair.marketSources[]`.

### **DECISION: `marketSources[0]` must correspond to `marketSource`**

* Status: Locked  
* Decision: The first evidence card must match or derive from the primary `marketSource`.  
* Reason: Prevents primary proof drift and backwards-compatibility bugs.  
* Do not change without: Explicit migration approval.  
* Related implementation impact: `marketSources[0].id === marketSource.id` should remain true where possible.

### **DECISION: Evidence cards are generated per selected market/outcome**

* Status: Locked  
* Decision: Evidence stack cards must be generated for the same selected market/outcome as the PremiumEventCard.  
* Reason: Evidence from other events is misleading.  
* Do not change without: Explicit architecture decision.  
* Related implementation impact: Evidence-generation helper must use selected outcome, diagnostics, and marketSource for the same pair.

### **DECISION: API-lite/cache-first feed remains active**

* Status: Active  
* Decision: `/api/feed/landing-cards` remains cache-first and API-lite for now.  
* Reason: It stabilizes production and avoids overbuilding before validation.  
* Do not change without: Explicit technical/product decision.  
* Related implementation impact: Cache-hit responses may not prove fresh generation; runtime verification may need a separate debug/cache-bypass path later.

### **DECISION: Manual fallback remains possible**

* Status: Locked  
* Decision: Manual/static fallback content must remain.  
* Reason: Production landing should not break if API/cache fails.  
* Do not change without: Explicit reliability decision.  
* Related implementation impact: Do not remove `content/signals.ts` / `content/marketSources.ts` fallback behavior.

### **DECISION: No real ML claims yet**

* Status: Locked  
* Decision: The current formula is deterministic/display-grade, not a calibrated predictive ML model.  
* Reason: Claiming real ML/win probability without validation is misleading and legally/product-risky.  
* Do not change without: Verified model and explicit founder approval.  
* Related implementation impact: Use “Signal Confidence” / display score language; do not promise predictive certainty.

### **DECISION: `winProbability` is internally a display signal score**

* Status: Locked  
* Decision: Existing field `winProbability` is effectively internal `displaySignalScore`; UI label should be `Signal Confidence`.  
* Reason: “Win Probability” overclaims calibrated predictive accuracy.  
* Do not change without: Explicit founder/product approval.  
* Related implementation impact: Do not revert UI copy to old “Win Probability” label.

### **DECISION: Current formula version is `trusted-initial-formula-v1.1`**

* Status: Active  
* Decision: Current API-lite formula version is `trusted-initial-formula-v1.1`.  
* Reason: This version reflects official Polymarket public data and deterministic scoring foundation.  
* Do not change without: Explicit formula/version migration.  
* Related implementation impact: API responses and diagnostics should preserve formulaVersion.

## **5\. Monetization / Paywall Decisions**

### **DECISION: Locked premium feed opens full-screen PassOfferModal**

* Status: Locked  
* Decision: Locked feed attempt opens a full-screen pricing/pass modal.  
* Reason: The modal communicates premium feed value and collects intent before full payment infrastructure.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: PassOfferModal remains the premium access surface.

### **DECISION: Main free CTA does not open paid pass modal**

* Status: Locked  
* Decision: Main CTA opens free signal lead capture, not paid pass checkout.  
* Reason: Free lead capture is the first conversion layer; paid/reserve modal is triggered by locked-feed intent.  
* Do not change without: Explicit funnel decision.  
* Related implementation impact: Preserve separate modal flows.

### **DECISION: Current plan model uses three plan cards**

* Status: Active  
* Decision: The pass modal uses three plan options:  
  * `24-Hour Pass — $4.99`  
  * `7-Day Premium — $15`  
  * `Monthly Pro — $49`  
* Reason: Offers low-commitment entry, short premium test, and monthly upside.  
* Do not change without: Explicit pricing decision.  
* Related implementation impact: Premium reserve capture should preserve plan\_id, plan\_name, and plan\_price.

### **DECISION: Default highlighted plan is 7-Day Premium**

* Status: Active  
* Decision: The visually selected/default plan is `7-Day Premium — $15`.  
* Reason: It balances price, duration, and perceived value better than 24-hour or monthly entry.  
* Do not change without: Explicit pricing/funnel decision.  
* Related implementation impact: Modal CTA should align with selected 7-day plan unless user changes selection.

### **DECISION: Current modal CTA wording**

* Status: Active  
* Decision: Current accepted pass CTA wording:  
  * `Unlock 7-Day Premium — $15`  
* Reason: Clear paid-access framing for selected plan.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Do not replace with generic “Subscribe” or “Continue” without approval.

### **DECISION: Secondary action wording**

* Status: Active  
* Decision: Secondary modal action:  
  * `Keep only 1 free signal`  
* Reason: Reinforces free/premium boundary and loss of additional feed access.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Secondary action should close modal / return to free signal.

### **DECISION: Active modal headline direction**

* Status: Active  
* Decision: Active headline direction:  
  * `Live edge is moving. The next signal is locked.`  
* Reason: Communicates urgency without fake countdowns or guaranteed outcomes.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Paywall copy should maintain urgency based on real live/feed context.

### **DECISION: No fake countdowns**

* Status: Locked  
* Decision: Do not use fake countdowns.  
* Reason: Fake urgency reduces trust and increases compliance/product risk.  
* Do not change without: Explicit founder approval and real timer logic.  
* Related implementation impact: Urgency copy must be based on real freshness/market movement.

### **DECISION: No hidden renewal / misleading payment terms**

* Status: Locked  
* Decision: Payment/subscription terms must be explicit once payment is active.  
* Reason: Hidden renewal patterns are high-risk and bad for trust.  
* Do not change without: Explicit legal/product decision.  
* Related implementation impact: If Stripe/subscriptions are added, CTA and footer must clearly state terms.

### **DECISION: Stripe/payment is not current foundation blocker**

* Status: Active  
* Decision: Stripe/payment should not be added before current feed, lead, reserve, and evidence-stack foundations are stable.  
* Reason: Payment without a credible signal/feed foundation adds complexity too early.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Reserve intent can precede actual payment.

## **6\. Lead Capture Decisions**

### **DECISION: Real lead capture is required before serious marketing**

* Status: Locked  
* Decision: The product must capture real leads/intents before traffic is driven seriously.  
* Reason: Marketing without capture loses validation data.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Supabase capture must remain functional.

### **DECISION: Supabase `lead_intents` is active capture table**

* Status: Locked  
* Decision: Lead and premium reserve intents are captured in Supabase `public.lead_intents`.  
* Reason: It provides production-visible validation.  
* Do not change without: Explicit data model decision.  
* Related implementation impact: Do not treat localStorage as production capture.

### **DECISION: Premium reserve intent is separate from free signal lead**

* Status: Locked  
* Decision: Premium reserve interactions must be captured as premium reserve intent with plan metadata.  
* Reason: Paid-intent behavior is more valuable than generic email capture.  
* Do not change without: Explicit funnel decision.  
* Related implementation impact: Preserve fields such as `source`, `intent_type`, `plan_id`, `plan_name`, `plan_price`.

### **DECISION: localStorage-only capture is not production acceptance**

* Status: Locked  
* Decision: localStorage can be used only as fallback/debug, not business acceptance.  
* Reason: It does not validate real user acquisition or intent in production data.  
* Do not change without: Explicit technical decision.  
* Related implementation impact: Traffic should not be driven to localStorage-only flows.

### **DECISION: Known premium reserve capture is production-accepted**

* Status: Locked  
* Decision: Premium reserve capture was accepted after Supabase rows appeared with `source = pass_offer_modal` and `intent_type = premium_reserve`.  
* Reason: This confirmed modal intent capture works beyond local UI.  
* Do not change without: Explicit new analytics/capture decision.  
* Related implementation impact: Preserve production reserve capture during modal/feed changes.

## **7\. CTA / Copy Decisions**

### **DECISION: Main landing CTA copy**

* Status: Locked  
* Decision: Current visible main CTA:  
  * `Get 5 Free Signals NOW`  
* Reason: It supports free lead capture and pre-payment validation.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Do not change CTA while working on backend/feed/CSS unless explicitly tasked.

### **DECISION: Signal score label is Signal Confidence**

* Status: Locked  
* Decision: UI copy should use `Signal Confidence`, not `Win Probability`.  
* Reason: `Win Probability` overclaims calibrated predictive power.  
* Do not change without: Explicit founder approval and model validation.  
* Related implementation impact: Do not revive old “Win Probability” label.

### **DECISION: No guaranteed profit claims**

* Status: Locked  
* Decision: Copy must not imply guaranteed profit or guaranteed outcomes.  
* Reason: Product is probabilistic and display-grade.  
* Do not change without: Never without verified legal/product approval.  
* Related implementation impact: Avoid phrases like “guaranteed win,” “sure profit,” “risk-free,” “always wins.”

### **DECISION: No fake verified news claims**

* Status: Locked  
* Decision: Do not claim verified news/source reaction unless a real news source/API is integrated.  
* Reason: Current news-pulse evidence is not active because no verified news API exists.  
* Do not change without: Real source integration and founder approval.  
* Related implementation impact: Do not generate `news-pulse` cards yet.

### **DECISION: No institutional smart-money claims**

* Status: Locked  
* Decision: Do not claim real institutional smart money without verified data source.  
* Reason: Current sharp/whale evidence is a proxy from public trade data.  
* Do not change without: Verified smart-money data source and explicit approval.  
* Related implementation impact: Use `Sharp Flow`, `whale flow`, or proxy wording carefully.

### **DECISION: Forbidden old copy/copy directions**

* Status: Active  
* Decision: Do not revive old or generic CTA/paywall copy unless explicitly requested.  
* Reason: Current copy was selected through visual/funnel iteration.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Avoid:  
  * old `Win Probability`  
  * generic “Subscribe now”  
  * fake countdowns  
  * checkout language if payment is not live  
  * guaranteed profit language  
  * unrelated free-signal modal text after paid reserve CTA

## **8\. Roadmap Order Decisions**

### **DECISION: Current roadmap priority is backend/feed stability before UI evidence rotation**

* Status: Locked  
* Decision: Finish PREMVP12 backend evidence generation cleanup/verification before MarketSourceCarousel evidence UI.  
* Reason: UI rotation without stable evidence data creates misleading/fragile UX.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Current active work stays backend-only until Step 3B is clean.

### **DECISION: Active current order**

* Status: Active  
* Decision:  
  1. Clean/amend current `premvp12-evidence-generation` commit.  
  2. Verify build/diff.  
  3. Decide whether runtime generation verification requires narrow cache-bypass/debug path.  
  4. Merge backend evidence generation when clean.  
  5. Then update MarketSourceCarousel to consume `activePair.marketSources[]`.  
  6. Then refine evidence-card UI/visuals if needed.  
  7. Then proceed toward payment/Stripe only when feed/lead/reserve evidence is stable.  
* Reason: Prevents UI and monetization complexity before core data behavior is stable.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Do not jump to UI carousel before backend Step 3B cleanup is accepted.

### **DECISION: Stripe/auth/admin remain postponed**

* Status: Active  
* Decision: Stripe, auth, and admin are postponed until product/feed/reserve foundation is stable.  
* Reason: They increase complexity before validation.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Do not add these in feed/evidence tasks.

### **DECISION: Heavy tests/automation remain selective**

* Status: Active  
* Decision: Do not add heavyweight CI, screenshot naming systems, rollback protocols, or broad regression scripts unless the value is immediate.  
* Reason: Founder prioritizes speed and targeted verification.  
* Do not change without: Explicit process decision.  
* Related implementation impact: Use build/diff/API/screenshot checks first.

## **9\. Visual / Design Decisions**

### **DECISION: Premium dark fintech/betting style**

* Status: Locked  
* Decision: Preserve premium dark mobile visual system.  
* Reason: Product must feel paid, sharp, and signal-driven.  
* Do not change without: Explicit visual approval.  
* Related implementation impact: Do not redesign UI from scratch.

### **DECISION: Cards are the product surface, not decoration**

* Status: Locked  
* Decision: PremiumEventCard and MarketSourceCard are the core product interface.  
* Reason: User value is communicated through these cards.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Visual changes must preserve card hierarchy and readability.

### **DECISION: No broad visual redesign**

* Status: Locked  
* Decision: Avoid broad UI rebuilds during active backend/feed work.  
* Reason: Previous broad visual/CSS work caused churn and regressions.  
* Do not change without: Explicit visual phase decision.  
* Related implementation impact: Backend tasks must not touch CSS/UI.

### **DECISION: Modal styling stays isolated**

* Status: Locked  
* Decision: PassOfferModal styling stays in `PassOfferModal.module.css`.  
* Reason: Prevents landing CSS pollution and override fights.  
* Do not change without: Explicit technical/visual approval.  
* Related implementation impact: Do not style modal via `Reconstruction.module.css`.

### **DECISION: Avoid infinite visual polish loops**

* Status: Locked  
* Decision: Visual iterations must be narrow and acceptance-based.  
* Reason: Repeated micro-patching created wasted cycles and regressions.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Use inspect-only, exact replacement, or full source-of-truth files for visual work.

### **DECISION: Mobile viewport assumptions**

* Status: Active  
* Decision: Primary mobile adaptive checks:  
  * `390×700`  
  * `428×760`  
* Reason: These expose fold-fit and modal-fit issues.  
* Do not change without: Explicit testing decision.  
* Related implementation impact: Do not optimize blindly for only large iPhone Pro Max sizes.

## **10\. Content / MarketSource Decisions**

### **DECISION: Exactly four approved MarketSourceCard types for current stage**

* Status: Locked  
* Decision: The only approved current MarketSourceCard types are:  
  1. `market-source`  
  2. `news-pulse`  
  3. `market-momentum`  
  4. `sharp-flow`  
* Reason: Prevents type explosion and fake unsupported evidence categories.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Do not add holder concentration, liquidity, orderbook, generic Smart Money, or other visible P0 types.

### **DECISION: Type 1 — Market Source**

* Status: Locked  
* Decision:  
  * `cardType`: `market-source`  
  * Display name: `Market Source`  
  * Business meaning: baseline market proof  
  * Visual type: `chart`  
* Reason: Provides default proof card and backward-compatible primary marketSource behavior.  
* Do not change without: Explicit evidence architecture decision.  
* Related implementation impact: `marketSources[0]` should correspond to primary `marketSource`.

### **DECISION: Type 2 — News Pulse**

* Status: Locked as future type / Not active for generation yet  
* Decision:  
  * `cardType`: `news-pulse`  
  * Display name: `News Pulse`  
  * Business meaning: market reaction to narrative/headline/context  
  * Visual type: `news-image`  
* Reason: Useful future evidence angle, but must not fake verified news.  
* Do not change without: Real news/context source or explicit founder approval.  
* Related implementation impact: Do not generate in current Step 3B.

### **DECISION: Type 3 — Market Momentum**

* Status: Locked  
* Decision:  
  * `cardType`: `market-momentum`  
  * Display name: `Market Momentum`  
  * Business meaning: odds/probability acceleration or demand gap  
  * Visual type: `team-crests`  
* Reason: Movement evidence is available from price delta/proxy fields.  
* Do not change without: Explicit evidence architecture approval.  
* Related implementation impact: Can be generated from movement triggers.

### **DECISION: Type 4 — Sharp Flow**

* Status: Locked  
* Decision:  
  * `cardType`: `sharp-flow`  
  * Display name: `Sharp Flow`  
  * Business meaning: large/concentrated money-flow proxy  
  * Visual type: `avatar`  
* Reason: Creates premium signal feeling while staying within public trade data.  
* Do not change without: Explicit evidence architecture approval.  
* Related implementation impact: Must not claim verified institutional smart money.

### **DECISION: Evidence must connect to active PremiumEventCard**

* Status: Locked  
* Decision: Every MarketSource evidence card must support the active event/market/outcome.  
* Reason: Desynced evidence destroys credibility.  
* Do not change without: Explicit architecture decision.  
* Related implementation impact: MarketSourceCarousel must eventually rotate only `activePair.marketSources[]`.

### **DECISION: Multiple evidence cards per signal are active direction**

* Status: Active  
* Decision: One PremiumEventCard may have 1–4 supporting MarketSourceCards.  
* Reason: Multiple proof angles increase perceived premium value.  
* Do not change without: Explicit founder approval.  
* Related implementation impact: Backend Step 3B currently targets 1–3 cards; future UI can rotate evidence stack.

## **11\. Technical/Product Do-Not-Change List**

Do not change casually:

* Do not replace LandingPair architecture.  
* Do not create independent MarketSource feed.  
* Do not let MarketSourceCarousel drift to unrelated events.  
* Do not rebuild UI from scratch.  
* Do not revert to hardcoded-only content.  
* Do not remove manual fallback.  
* Do not remove `marketSource`.  
* Do not make `marketSources[]` required without fallback.  
* Do not change CTA/pricing without explicit product decision.  
* Do not add auth/payment/admin prematurely.  
* Do not present heuristic score as guaranteed prediction.  
* Do not call current display score real ML.  
* Do not generate fake news evidence.  
* Do not claim verified smart money without source.  
* Do not add visible card types beyond the four approved types.  
* Do not use broad refactor prompts.  
* Do not modify UI/CSS during backend-only phases.  
* Do not modify Supabase schema during current evidence-generation cleanup.  
* Do not trust cache-hit API response as proof of fresh generation.  
* Do not merge `premvp12-evidence-generation` before whitespace cleanup/amend.

## **12\. Rejected / Postponed Ideas**

### **Google Auth**

* Status: Postponed  
* Reason: Not needed before current lead/feed validation.  
* Do not revive without: Explicit founder approval.

### **Stripe/payment activation**

* Status: Postponed  
* Reason: Reserve intent and feed credibility are current priorities.  
* Do not revive without: Explicit monetization-phase decision.

### **Full paid SaaS platform first**

* Status: Rejected for current stage  
* Reason: Too much complexity before proof of demand.  
* Do not revive without: Explicit roadmap reset.

### **Real ML prediction model**

* Status: Postponed  
* Reason: Current formula is deterministic display-grade.  
* Do not revive without: validated model/data plan.

### **Full smart-money backend beyond API-lite**

* Status: Postponed  
* Reason: Current phase uses official Polymarket public data/proxies.  
* Do not revive without: data-source decision.

### **Heavy tests/CI/visual automation**

* Status: Selectively postponed  
* Reason: Considered premature relative to speed/PreMVP constraints.  
* Do not revive without: clear immediate payoff.

### **Screenshot naming convention / text regression script**

* Status: Considered premature  
* Reason: Adds overhead without enough current value.  
* Do not revive without: explicit process decision.

### **Independent MarketSource browsing**

* Status: Rejected  
* Reason: Breaks signal/evidence sync.  
* Do not revive without: explicit architecture decision.

### **Fake countdown paywall**

* Status: Rejected  
* Reason: Trust/compliance risk.  
* Do not revive.

### **localStorage-only lead/reserve capture**

* Status: Rejected as production acceptance  
* Reason: Does not validate real captured leads/intents.  
* Do not treat as final capture.

### **Old modal/free-signal cross-flow**

* Status: Rejected  
* Reason: Paid reserve CTA must not open the generic “Get 5 Free Signals” modal.  
* Do not revive.

### **Broad visual polish rabbit holes**

* Status: Rejected for current phase  
* Reason: Caused churn and delayed product progress.  
* Do not revive during backend/feed work.

## **13\. Current Product Acceptance Criteria**

Product-level acceptance requires:

* Landing shows one clear free PremiumEventCard.  
* Main CTA remains visible and opens free signal capture.  
* Locked premium feed attempt opens PassOfferModal.  
* Locked attempt does not change active pair before unlock.  
* Premium reserve captures plan intent in Supabase.  
* MarketSource evidence matches active PremiumEventCard.  
* `marketSource` remains present.  
* `marketSources[]` remains backward-compatible.  
* Evidence card types stay within approved four.  
* No fake news/smart-money/ML claims.  
* No old `Win Probability` label in UI.  
* No guaranteed profit copy.  
* No stale data mismatch between PremiumEventCard and MarketSourceCard.  
* No visual regression on mobile target viewports.  
* API feed remains healthy.  
* Cache behavior is understood and not misread as fresh-generation proof.  
* Git/build state is clean before merge/push.  
* Founder gives final visual/business acceptance.

## **14\. Needs Verification / Not Yet Locked**

### **Exact current state of `premvp12-evidence-generation` after cleanup/amend**

* Status: NEEDS VERIFICATION  
* Need to verify:  
  * branch  
  * working tree  
  * latest amended commit hash  
  * `git diff --check`  
  * `npm run build`

### **Runtime verification of Step 3B generated evidence cards**

* Status: NEEDS VERIFICATION  
* Reason: `/api/feed/landing-cards` returned cache hits and no cache-bypass is known.  
* Need to verify fresh generation path before or after merge decision.

### **Exact current production paywall visual after latest deploy**

* Status: NEEDS VERIFICATION  
* Reason: Modal is client-side/closed by default; server HTML checks may not show modal text.  
* Need manual trigger/browser check if working on paywall again.

### **Exact next UI phase timing**

* Status: NEEDS VERIFICATION  
* Likely next UI phase: MarketSourceCarousel evidence-card UI using `activePair.marketSources[]`.  
* Must wait until backend evidence generation is clean/accepted.

### **Exact Stripe/payment activation timing**

* Status: NEEDS VERIFICATION  
* Current decision: postponed.  
* Future timing requires founder approval.

### **Cache-bypass/debug strategy**

* Status: NEEDS VERIFICATION  
* Need to decide whether to add a narrow debug/cache-bypass endpoint or accept build-only confidence for Step 3B before merge.

## **15\. Decision Handoff Summary**

PolyProPicks is locked as a mobile-first premium sports/prediction-market signal feed: one visible free PremiumEventCard gives the decision, MarketSourceCard evidence explains why, and locked feed attempts open a full-screen pass modal. The architecture is LandingPair-first: PremiumEventCard is master, MarketSourceCard is dependent, `marketSource` stays backward-compatible, and `marketSources[]` is the future evidence stack tied to the same active market/outcome. Current monetization uses free signal capture plus premium reserve/pass modal with 24-hour, 7-day, and monthly options; main CTA remains `Get 5 Free Signals NOW`, while locked feed CTA direction is `Unlock 7-Day Premium — $15`. The current roadmap is backend/feed first: clean/amend PREMVP12 Step 3B evidence generation on `premvp12-evidence-generation`, then decide runtime verification/cache-bypass, then merge, then only later update MarketSourceCarousel UI. Do not revive independent MarketSource browsing, fake ML/news/smart-money claims, premature Stripe/Auth/Admin, or broad visual refactors without explicit founder approval.

