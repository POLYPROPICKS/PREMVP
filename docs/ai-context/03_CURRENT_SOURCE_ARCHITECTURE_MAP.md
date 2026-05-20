# 03_CURRENT_SOURCE_ARCHITECTURE_MAP.md — PolyProPicks

> Refreshed: 2026-05-21
> Source of truth: git log + file system inspection.
> Prior override blocks (2026-05-14) superseded by this refresh.

---

## Git state at refresh

```
HEAD:    264500d Deploy: force Next.js standalone runtime
Origin:  synced
Working tree: clean (docs/design/ untracked — intentional)
```

---

## App routes

| Route | File | Status |
|---|---|---|
| `/` | `app/page.tsx` | ✅ ACTIVE — thin wrapper rendering ReconstructionPage |
| `/reconstruction` | `app/reconstruction/page.tsx` | ✅ ACTIVE — main landing implementation |
| `/premium` | `app/premium/page.tsx` | ✅ ACTIVE NEW — premium feed (session-gated) |
| `/checkout/complete` | `app/checkout/complete/page.tsx` | ✅ ACTIVE NEW — post-Whop checkout |

---

## Active components

### Cards
| File | Status | Notes |
|---|---|---|
| `components/cards/PremiumEventCard.tsx` | ✅ ACTIVE — DO NOT MODIFY | Main decision card |
| `components/cards/PremiumEventCard.module.css` | ✅ ACTIVE — DO NOT MODIFY | |
| `components/cards/MarketSourceCard.tsx` | ✅ ACTIVE — DO NOT MODIFY | Evidence card |
| `components/cards/MarketSourceCard.module.css` | ✅ ACTIVE — DO NOT MODIFY | |

### Carousels
| File | Status | Notes |
|---|---|---|
| `components/carousels/PremiumEventCarousel.tsx` | ✅ ACTIVE | Locked peek behavior |
| `components/carousels/MarketSourceCarousel.tsx` | ✅ ACTIVE | Evidence carousel, rotate on future phase |

### Modals
| File | Status | Notes |
|---|---|---|
| `components/modals/PassOfferModal.tsx` | ✅ ACTIVE — DO NOT TOUCH | Paywall modal |
| `components/modals/PassOfferModal.module.css` | ✅ ACTIVE — DO NOT TOUCH | |

---

## Feed / data builder files

| File | Status | Notes |
|---|---|---|
| `lib/feed/buildLandingCards.ts` | ✅ PRIMARY GENERATOR | Main signal + evidence generation |
| `lib/feed/cacheGeneratedSignals.ts` | ✅ ACTIVE | Cache read/write, market_sources field |
| `lib/feed/resolveSignalOutcome.ts` | ✅ ACTIVE NEW | Outcome resolution (YES/NO/VOID) |
| `lib/feed/discoverSportsMarkets.ts` | ✅ ACTIVE | Sports market discovery |
| `lib/feed/landingPairs.ts` | ✅ ACTIVE | LandingPair canonical helpers |
| `lib/feed/normalizePolymarket.ts` | ✅ ACTIVE | Polymarket data normalization |
| `lib/feed/polymarketClient.ts` | ✅ ACTIVE | Polymarket API client |
| `lib/feed/scorePolymarket.ts` | ✅ ACTIVE | Signal scoring |
| `lib/feed/types.ts` | ✅ ACTIVE | Shared feed types |
| `lib/feed/buildSportsLandingCards.ts` | ⚠️ SUPERSEDED | Not called by cron. Import graph NOT VERIFIED. Do NOT delete without verifying no imports. |

## Auth / payment files

| File | Status | Notes |
|---|---|---|
| `lib/auth/premiumSession.ts` | ✅ ACTIVE NEW | Session cookie helpers |
| `lib/payments/whopCheckout.ts` | ✅ ACTIVE NEW | Whop API helpers |

---

## Scripts

| File | Status | Notes |
|---|---|---|
| `scripts/generate-signals.ts` | ✅ ACTIVE | Cron job — uses buildLandingCards |
| `scripts/resolve-signals.ts` | ✅ ACTIVE NEW | Batch signal outcome resolution |

---

## Content / static data

| File | Status | Notes |
|---|---|---|
| `content/signals.ts` | ✅ ACTIVE — fallback | Static signal fallback |
| `content/marketSources.ts` | ✅ ACTIVE — fallback | MarketSource types + static fallback |
| `content/section-headings.ts` | ✅ ACTIVE | Section heading strings (used in PremiumEventCard) |

---

## Design / source pack

| Path | Status | Notes |
|---|---|---|
| `docs/design/claude-design-source-pack/` | ✅ ARTIFACT — untracked | Design pack for Claude Design upload |
| `docs/design/polypropicks-claude-design-source-pack-2026-05-20.zip` | ✅ ARTIFACT — untracked | Ready-to-upload ZIP for Claude Design |
| `docs/design/polypropicks-claude-design-source-pack-FULL-BACKUP-2026-05-20.zip` | ✅ ARTIFACT — untracked | Full backup |

---

## app/reconstruction/ backup files

| File | Status |
|---|---|
| `page.tsx` | ✅ ACTIVE |
| `Reconstruction.module.css` | ✅ ACTIVE |
| `page.before-forced-icons.tsx` | 📦 BACKUP — do not edit |
| `page.before-icons.tsx` | 📦 BACKUP — do not edit |
| `page.broken.tsx` | 📦 BACKUP — do not edit |
| `page.phase1-trust-before.tsx` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-forced-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.before-icons.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.broken.css` | 📦 BACKUP — do not edit |
| `Reconstruction.module.phase1-trust-before.css` | 📦 BACKUP — do not edit |

---

## Root config files

| File | Notes |
|---|---|
| `next.config.ts` | `output: "standalone"` added 264500d |
| `package.json` | start = `node .next/standalone/server.js` |
| `.railwayignore` | added 264500d — excludes .next, node_modules, debug files |
| `CLAUDE.md` | Repo-level Claude Code instructions |
| `AGENTS.md` | Agent startup instructions |
| `AUTOMATION_MODE_HANDOFF.md` | Automation mode handoff doc |

---

## Supabase tables

| Table | Status | Notes |
|---|---|---|
| `public.generated_signal_pairs` | ✅ ACTIVE | Signal cache; includes market_sources jsonb |
| `public.lead_intents` | ✅ ACTIVE | Free lead + premium reserve intent |
| `public.signal_snapshots` | ✅ ACTIVE NEW | Signal performance snapshots (inferred from 61afd67) |

---

## Do NOT touch without explicit approval

- `components/cards/PremiumEventCard.tsx` + CSS
- `components/cards/MarketSourceCard.tsx` + CSS
- `components/modals/PassOfferModal.tsx` + CSS
- `components/carousels/MarketSourceCarousel.tsx` (unless evidence rotation phase opens)
- `app/globals.css`
- Any Supabase/Railway config
- Any `.env` files
