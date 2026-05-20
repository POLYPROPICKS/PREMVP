# 02_CURRENT_TECH_STATE.md — PolyProPicks

> Refreshed: 2026-05-21
> Source of truth: git log + current source files.
> Git output beats this file — always verify with: git log --oneline -3 && git status --short

---

## Current state

```
Branch:          main
HEAD:            264500d Deploy: force Next.js standalone runtime
Origin:          synced
Working tree:    clean (docs/design/ untracked — intentional)
```

## Recent commits (newest first, since 2026-05-15)

```
264500d  Deploy: force Next.js standalone runtime
9bd6b71  Feed: cache proactive upcoming gap-fill
6716f7d  Chore: remove Railway autodeploy smoke file
43b623d  Chore: test Railway autodeploy trigger
9359876  Feed: generate upcoming market pairs
9561daf  Chore: trigger Railway deploy
822f576  Feed: add upcoming pairs API contract
89a0cbe  Feed: add upcoming signal diagnostics fields
a11e383  Feed: add league names to fallback sports candidates
0c8f313  Landing: add sports-specific filters with empty teaser
df87213  Landing: add filter count badges
5b6de35  Premium: deduplicate live signal cards
39eb563  Premium: add signal details panel
ca59563  Feed: limit signal resolver write updates
831951e  Feed: add signal resolver script
e7436f6  Feed: add dry-run signal resolver debug endpoint
82fff99  Automation: add Claude Code verify command
61afd67  Data: store signal performance snapshots
e418020  Auth: add premium magic link restore access
295ea76  Premium: add feed-backed unlocked signal cards
5ef8811  Payment: add premium session access flow
38ec21a  Payment: add post-checkout entitlement verification
c663edb  Payment: wire pass offer modal to Whop checkout
b2b9909  Payment: add entitlement check endpoint
212cd1c  Payment: handle Whop membership deactivation
9f08f73  Payment: accept trialing Whop memberships
adffc56  Payment: fix Whop recurring initial price
0ab5872  Payment: add Whop checkout complete page
24b08ed  Payment: support Whop recurring weekly and monthly plans
afe5b4d  Payment: add Whop webhook entitlement sync
4aa56d9  Payment: add Whop SDK dependency
```

---

## Framework / runtime

```
Framework:      Next.js (App Router)
Language:       TypeScript
Styling:        CSS Modules
Runtime target: Node.js (Next.js standalone — output: "standalone" added 264500d)
Package mgr:    npm
```

## Build state

```
npm run build:  PASS — verified at commit 264500d
TypeScript:     no known errors at HEAD
next.config.ts: output: "standalone" (added for Railway RAILPACK fix)
package.json:   start script = "node .next/standalone/server.js"
```

---

## Deployment

```
Platform:         Railway
Production URL:   https://polypropicks.com
Deploy trigger:   git push to main → auto-deploy
Current status:   NOT VERIFIED — blocked by Railway external platform incident/recovery
                  AND RAILPACK V3 config issue. Do not treat last deploy as confirmed OK.

Known issue 1 — RAILPACK V3 (config):
  Railway RAILPACK V3 generates Caddy-only container for Next.js.
  Fix: output: "standalone" committed at 264500d.
  Manual action required: Railway Dashboard → Settings → Build
    → Change builder from RAILPACK to Nixpacks → Save → Redeploy.

Known issue 2 — Railway external incident (platform):
  eb7fe40 (2026-05-18): "Deploy: retrigger PREMVP after Railway incident"
  External Railway platform incident occurred on or around 2026-05-18.
  Recovery state unknown. Production verification unreliable while incident context unclear.
  Attribution: Railway platform behaviour, NOT PolyProPicks application code regression.

Last confirmed OK: NOT VERIFIED since standalone fix and Railway incident.
```

---

## Routes — active

| Route | File | Notes |
|---|---|---|
| `/` | `app/page.tsx` → `app/reconstruction/page.tsx` | Landing, thin wrapper |
| `/reconstruction` | `app/reconstruction/page.tsx` | Main landing implementation |
| `/premium` | `app/premium/page.tsx` | NEW — premium feed (auth-gated) |
| `/checkout/complete` | `app/checkout/complete/page.tsx` | NEW — post-Whop checkout |

## API routes — active

| Route | File | Notes |
|---|---|---|
| `/api/feed/landing-cards` | `app/api/feed/landing-cards/route.ts` | Cache-first feed, returns pairs + upcomingPairs |
| `/api/feed/debug-evidence-generation` | debug route | Force-fresh generation bypass |
| `/api/feed/debug-sports-cards` | debug route | Sports mapper debug |
| `/api/feed/debug-sports-discovery` | debug route | Sports discovery debug |
| `/api/feed/debug-resolve-signals` | debug route | Dry-run signal resolver |
| `/api/cron/generate-signals` | cron trigger | Signal cache generation |
| `/api/leads` | `app/api/leads/route.ts` | Lead intent capture |
| `/api/checkout/create` | `app/api/checkout/create/route.ts` | NEW — Whop checkout creation |
| `/api/webhooks/whop` | `app/api/webhooks/whop/route.ts` | NEW — Whop membership events |
| `/api/entitlement/check` | `app/api/entitlement/check/route.ts` | NEW — membership status check |
| `/api/auth/session` | `app/api/auth/session/route.ts` | NEW — session check/set |
| `/api/auth/magic-link/request` | `app/api/auth/magic-link/request/route.ts` | NEW — request magic link |
| `/api/auth/magic-link/verify` | `app/api/auth/magic-link/verify/route.ts` | NEW — verify magic link token |

---

## Feed / cron state

```
Cron script:        scripts/generate-signals.ts (uses buildLandingCards)
Generator:          lib/feed/buildLandingCards.ts ← PRIMARY ACTIVE
Cache writer:       lib/feed/cacheGeneratedSignals.ts
Signal resolver:    lib/feed/resolveSignalOutcome.ts (NEW — batch outcome resolution)
Resolve script:     scripts/resolve-signals.ts (NEW)
Upcoming pairs:     Generated and cached; returned as upcomingPairs[] in API response
Cache gap-fill:     Proactive upcoming generation if active pairs < threshold (9bd6b71)
Formula version:    trusted-initial-formula-v1.1
```

## Supabase state

```
Active tables:
  public.generated_signal_pairs    — feed cache (includes market_sources jsonb column)
  public.lead_intents              — free lead + premium reserve intent
  public.signal_snapshots          — NEW — signal performance snapshots (61afd67)

Auth:
  Magic-link tokens stored in Supabase
  Premium session verified against entitlement

Schema changes since 2026-05-15:
  signal_snapshots table: added (NOT VERIFIED — inferred from commit 61afd67)
```

## Payment / auth state

```
Payment provider:   Whop
Plans:              Weekly recurring, monthly recurring
Trialing:           accepted (9f08f73)
Deactivation:       handled (212cd1c)
Webhook:            afe5b4d — handles membership events
Checkout:           app/api/checkout/create/route.ts
Entitlement:        app/api/entitlement/check/route.ts
Session:            lib/auth/premiumSession.ts — secure cookie
Magic link:         request + verify endpoints (e418020)
End-to-end status:  NOT VERIFIED in production
```

---

## Known blockers / open

```
[ ] Production Railway deployment — manual Nixpacks switch required
[ ] signal-cache-cron — not redeployed after Railway incident
[ ] Whop payment end-to-end — not production-verified
[ ] Magic-link auth — not production-verified
[ ] Proof of Results card — Claude Design phase pending
[ ] filterTags one-card-across-filters bug — deferred
[ ] buildSportsLandingCards.ts — exists, superseded, import graph NOT VERIFIED (safe to delete: NOT VERIFIED)
```

---

## Environment / connectors

```
.env.local:     present, not committed
.env:           gitignored
Railway env:    set in Railway Dashboard
Whop:           API key required in env (WHOP_API_KEY or similar)
Supabase:       SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
See 08_ENVIRONMENT_AND_CONNECTORS.md for full list (needs refresh — Whop vars not documented there yet).
```
