# CLAUDE_CHAT_UPLOAD_PACK_2026-05-21.md — PolyProPicks

> Compact single-file context for Claude Chat / Cowork advisory sessions.
> Upload this file (or paste its contents) at the start of a new session.
> Current as of: 2026-05-21 | HEAD: 264500d

---

## 1. Project summary

**PolyProPicks** — mobile-first sports/prediction-market signal product.
Shows one clear PremiumEventCard decision (event, position, profit, Signal Confidence, trust metrics, CTA)
with supporting MarketSourceCard evidence and a locked premium feed/paywall.

- Target: sports prediction-market users wanting fast signal cards before odds move
- Production URL: `https://polypropicks.com` (Railway)
- Phase: PreMVP production prototype
- Formula: `trusted-initial-formula-v1.1` — deterministic/display-grade, NOT real ML

**NOT a guaranteed-profit product. NOT a real ML prediction engine. NOT a full SaaS yet.**

---

## 2. Current architecture summary

### Routes
- `/` → `app/reconstruction/page.tsx` — main landing
- `/premium` — NEW — premium feed (session-gated)
- `/checkout/complete` — NEW — post-Whop checkout

### Key API routes
- `GET /api/feed/landing-cards` — cache-first feed, returns `pairs[]` + `upcomingPairs[]`
- `POST /api/checkout/create` — Whop checkout creation
- `POST /api/webhooks/whop` — Whop membership webhook
- `GET /api/entitlement/check` — entitlement check
- `POST /api/auth/magic-link/request` + `/verify` — magic link auth
- `GET /api/auth/session` — session check

### Key lib files
- `lib/feed/buildLandingCards.ts` — PRIMARY signal generator
- `lib/feed/resolveSignalOutcome.ts` — NEW outcome resolution
- `lib/auth/premiumSession.ts` — NEW session cookie
- `lib/payments/whopCheckout.ts` — NEW Whop helpers

### Key types
```typescript
LandingCardPair { id, premiumSignal, marketSource, marketSources?, diagnostics }
LandingCardsResponse { pairs, upcomingPairs?, rejected, ... }
LandingCardDiagnostics { signalStatus?: "qualified" | "upcoming_candidate", ... }
```

### Supabase tables
- `generated_signal_pairs` — feed cache (market_sources jsonb)
- `lead_intents` — free lead + premium reserve
- `signal_snapshots` — NEW signal performance snapshots

---

## 3. Current state (2026-05-21)

| Area | Status |
|---|---|
| Branch | main, HEAD 264500d, clean |
| Production | NOT VERIFIED — blocked by Railway RAILPACK V3 config (Caddy-only container) AND Railway external platform incident (eb7fe40, 2026-05-18/20/21). Attribution: Railway platform, not app code. Manual Nixpacks switch required in Railway Dashboard. |
| Whop payment | SHIPPED — not production-verified |
| Magic-link auth | SHIPPED — not production-verified |
| Premium page | SHIPPED |
| Signal resolver | SHIPPED |
| Upcoming pairs | SHIPPED |
| Proof of Results card | Pending Claude Design session |
| MarketSourceCarousel rotation | ON HOLD |
| filterTags bug | DEFERRED |

---

## 4. Advisors / skills routing

| Role | When to use |
|---|---|
| **Claude Chat (this session)** | Architecture, product decisions, roadmap, design review, context handoff, task prep |
| **Claude Code** | Bounded patches only — receives execution spec, not full context |
| **Claude Design** | Visual card design exploration — upload design pack ZIP |
| **Direct CMD** | ≤5 simple git/build/curl commands |
| **Founder only** | Push/deploy, visual acceptance, payment/pricing decisions, Railway Dashboard actions |

---

## 5. Current next work

**Priority 1 — Production recovery (BLOCKED on founder manual action):**
- Railway Dashboard → PREMVP service → Settings → Build → Change builder to Nixpacks → Save → Redeploy
- Verify `https://polypropicks.com` returns 200
- Verify `/api/feed/landing-cards?limit=1` returns JSON
- Redeploy signal-cache-cron after production confirmed

**Priority 2 — Proof of Results card (Claude Design):**
- Upload `docs/design/polypropicks-claude-design-source-pack-2026-05-20.zip` to Claude Design
- Paste prompt from `docs/design/claude-design-source-pack/07_CLAUDE_DESIGN_PROMPT_PROOF_OF_RESULTS.md`
- Review Variant A (compact trust) + Variant B (analytical 5-dot)
- Annotate selected variant
- Hand off to Claude Code per `docs/design/claude-design-source-pack/08_CLAUDE_CODE_HANDOFF_AFTER_DESIGN.md`

**Priority 3 — Production verification of payment + auth:**
- After production is confirmed: verify Whop checkout end-to-end
- Verify magic-link auth flow

---

## 6. What NOT to do

- Do NOT touch `PremiumEventCard`, `MarketSourceCard`, `PassOfferModal` without explicit approval
- Do NOT add win rate %, guaranteed profit, or fake ROI to any copy
- Do NOT use gold/yellow in new evidence cards (reserved for PremiumEventCard)
- Do NOT revert Signal Confidence label back to "Win Probability"
- Do NOT route Railway Dashboard builder change to Claude Code — founder must do it manually
- Do NOT commit or push without explicit founder approval
- Do NOT add Stripe (Whop is the payment provider)
- Do NOT treat Claude Code output as visual acceptance
- Do NOT treat build passing as product acceptance

---

## 7. How to ask Claude Chat for review

For architecture decisions, paste:
```
Current git state:
  Branch: main | HEAD: [run git log --oneline -1] | Status: [run git status --short]

Task I'm considering:
  [describe task]

Question:
  [specific question]

Relevant locked decisions:
  [paste from 04_PRODUCT_DECISIONS_LOCKED.md if applicable]
```

For Claude Code task prep, paste this file + describe the patch. Ask Claude Chat to produce a bounded execution spec (allowed files, exact changes, forbidden files, acceptance criteria). Paste spec to Claude Code — NOT this whole file.

---

## 8. Locked design principles (quick ref)

- PremiumEventCard is the master signal surface — MarketSource is dependent evidence
- MarketSourceCarousel must not become independent random feed
- Filters are free controls — do not trigger paywall
- Main CTA opens free lead capture, NOT paywall
- Paywall (PassOfferModal) triggered only by locked feed attempt
- LandingPair is canonical data unit — activePairId drives both premium + evidence
- Evidence rotation resets to index 0 when activePremiumIndex changes
