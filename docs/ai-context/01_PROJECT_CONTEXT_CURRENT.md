# 01_PROJECT_CONTEXT_CURRENT.md — PolyProPicks

> ⚠️ REFRESHED — 2026-05-21
> Source of truth: git log + current source files.
> Prior override blocks from 2026-05-14/15 are superseded by this refresh.

---

## CURRENT STATE — 2026-05-21

```
Branch:          main
HEAD:            264500d Deploy: force Next.js standalone runtime
Origin:          synced
Working tree:    clean (docs/design/ untracked — intentional)
Commits since 2026-05-15: 52
```

### Current product phase

**PREMVP — Payment-gated premium feed + evidence stack + upcoming signals**

What shipped since 2026-05-15:
- Whop payment integration (checkout, webhook, entitlement sync)
- Magic-link auth + premium session access
- `/premium` page with feed-backed unlocked signal cards + signal details panel
- `/checkout/complete` page
- Signal resolver script (`resolveSignalOutcome.ts`, `scripts/resolve-signals.ts`)
- Signal performance snapshots (Supabase)
- Upcoming market pair generation + API contract (`upcomingPairs` field)
- Landing: filter count badges, sports-specific filters with empty teaser
- Feed: proactive upcoming gap-fill caching
- Deploy: Next.js `output: "standalone"` for Railway runtime fix

### Current production status

**NEEDS VERIFICATION** — Railway was serving Caddy 404 as of last confirmed check (2026-05-20).
Fix (`output: "standalone"`, commit 264500d) has been pushed. Whether Railway build now uses
Nixpacks or still RAILPACK requires manual verification in Railway Dashboard.

Production URL: `https://polypropicks.com` — **status unknown until manually verified**

### Accepted/done (merged to main, verified or build-verified)

- Whop payment stack: checkout, webhook, entitlement
- Auth: magic link + session
- Premium page `/premium` with locked feed
- Signal resolver (Supabase snapshot + resolve script)
- Upcoming pairs: generation + API contract + cache gap-fill
- Landing: filter badges, sports-specific filter teaser
- Premium: deduplication, signal details panel
- Deploy: Railway standalone runtime fix committed

### Not accepted / open

- **Production deployment** — NEEDS VERIFICATION (Railway RAILPACK/Caddy issue)
- **signal-cache-cron** — not redeployed after Railway incident
- **Whop end-to-end payment flow** — not verified in production
- **Magic-link auth** — not verified in production
- **Proof of Results card** — Claude Design phase pending (design pack ready)
- **MarketSourceCarousel evidence rotation UI** — ON HOLD
- **filterTags one-card-across-filters bug** — deferred

---

## 1. Project Identity

- **Product name:** PolyProPicks
- **Internal names:** PolyPicks, PREMVP
- **One-sentence definition:** A mobile-first sports/prediction-market signal product that turns Polymarket market data into one clear decision card with supporting evidence and a premium locked feed.
- **Current dev mode:** PreMVP production prototype
- **Primary user segment:** Sports prediction-market users wanting fast signal cards before odds move
- **Secondary segments:** Polymarket/Kalshi users, World Cup 2026 traffic, sports bettors

---

## 2. Product Surface

### Landing `/`
- Production domain: `https://polypropicks.com`
- Hosted on Railway
- Renders `<ReconstructionPage />` via `app/reconstruction/page.tsx`
- Mobile-first, dark fintech/sports-prediction style

### Premium `/premium`
- NEW — feed-backed unlocked signal cards for verified premium users
- Signal details panel
- Requires valid premium session cookie

### Checkout `/checkout/complete`
- NEW — post-Whop checkout landing page
- Verifies entitlement, redirects to `/premium`

### PremiumEventCard
- Main decision card: event, position, profit, Signal Confidence, trust metrics, CTA
- Master signal surface — evidence must depend on it

### MarketSourceCard / MarketSourceCarousel
- Upper evidence layer
- Currently consumes primary `marketSource`
- Future: rotate `marketSources[]` for active pair
- Must not become independent news/market feed

### PassOfferModal
- Full-screen paywall triggered by locked feed attempt
- Plans: 7-Day $15 / 24-Hour $4.99 / Monthly $49
- Main CTA does NOT open this modal — it opens free lead capture

### Filters
- Free controls, do not trigger paywall
- Filter count badges now shown
- Sports-specific empty teaser for empty filter states

### Locked feed behavior
- User sees one signal + right-edge peek of next card
- Locked attempt opens PassOfferModal
- Active PremiumEventCard does not change on locked attempt

---

## 3. Architecture Canonical Unit

`LandingCardPair` is the canonical source:
```
{
  id: string
  premiumSignal: PremiumSignal
  marketSource: MarketSource
  marketSources?: MarketSourceEvidenceCard[]
  diagnostics: LandingCardDiagnostics
}
```

API response also now includes:
```
upcomingPairs?: LandingCardPair[]  // upcoming market candidates
```

`LandingCardDiagnostics.signalStatus` = `"qualified" | "upcoming_candidate"`

### Master/dependent relationship
- PremiumEventCard = master
- MarketSourceCard = dependent evidence for active pair
- activeEvidenceIndex controls evidence card rotation (future)

---

## 4. Payment / Auth State

### Whop integration (SHIPPED — not production-verified)
- `app/api/checkout/create/route.ts` — creates Whop checkout
- `app/api/webhooks/whop/route.ts` — handles membership events
- `app/api/entitlement/check/route.ts` — checks membership status
- `lib/payments/whopCheckout.ts` — Whop API helpers
- Plans: weekly + monthly recurring, trialing accepted, deactivation handled

### Auth (SHIPPED — not production-verified)
- `app/api/auth/session/route.ts` — session check/set
- `app/api/auth/magic-link/request/route.ts` — request magic link
- `app/api/auth/magic-link/verify/route.ts` — verify token
- `lib/auth/premiumSession.ts` — session helpers
- Supabase-backed

### Premium session gate
- Verified entitlement → sets secure cookie → allows `/premium` access

---

## 5. Feed / Signal State

### Signal resolver (SHIPPED — not production-verified for outcome tracking)
- `lib/feed/resolveSignalOutcome.ts` — resolve YES/NO/VOID outcomes from Polymarket
- `scripts/resolve-signals.ts` — batch resolution script
- `61afd67` stores signal performance snapshots in Supabase

### Upcoming pairs (SHIPPED)
- `9359876` generates upcoming market pairs (lower confidence candidates)
- `822f576` adds `upcomingPairs` field to `/api/feed/landing-cards` response
- `9bd6b71` adds proactive cache gap-fill (auto-generates upcoming if active pairs < threshold)
- `diagnostics.signalStatus = "upcoming_candidate"` distinguishes from qualified signals

### Feed endpoint
- `/api/feed/landing-cards` — cache-first, now returns `upcomingPairs` in response
- `/api/feed/debug-evidence-generation` — fresh generation bypass (dev only)
- `/api/cron/generate-signals` — cron trigger

---

## 6. Locked Architecture Decisions (summary)

- No fake ML / no fake win probability claim
- `Signal Confidence` is the label (not "Win Probability")
- No win rate %, no guaranteed profit, no fake ROI
- MarketSourceCarousel must not become independent random feed
- LandingPair is canonical unit
- PremiumEventCard is master; MarketSource is dependent evidence
- Main CTA opens free lead capture, NOT paywall
- Paywall modal triggered by locked feed attempt only
- Filters are free controls, not locks

---

## 7. Immediate Next Phase

### Name: Production verification + Claude Design handoff

#### Production recovery
1. Manual Railway Dashboard intervention required:
   - Change builder from RAILPACK to Nixpacks in Railway Dashboard
   - Redeploy
   - Verify `https://polypropicks.com` returns 200
   - Verify `/api/feed/landing-cards?limit=1` returns JSON
2. Redeploy signal-cache-cron after production is confirmed

#### Claude Design: Proof of Results card
- Design pack ready at `docs/design/claude-design-source-pack/`
- Upload ZIP `polypropicks-claude-design-source-pack-2026-05-20.zip` to Claude Design
- Paste prompt from `07_CLAUDE_DESIGN_PROMPT_PROOF_OF_RESULTS.md`
- Review Variant A (compact) + Variant B (analytical 5-dot)
- Annotate and hand off to Claude Code per `08_CLAUDE_CODE_HANDOFF_AFTER_DESIGN.md`

---

## 8. Deliberately Postponed

- Stripe (Whop is active payment layer)
- Full admin dashboard
- Full subscription management UI
- Kalshi integration
- Real news API
- Real ML prediction model
- Complex visual regression/test suite
- MarketSourceCarousel evidence rotation UI (until Proof of Results card ships)
