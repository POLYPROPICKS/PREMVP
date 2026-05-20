# **08\_ENVIRONMENT\_AND\_CONNECTORS.md**

## **1\. Purpose**

This file documents the environment, connectors, deployment assumptions, runtime routes, external services, and secure configuration boundaries for PolyProPicks / PolyPicks Current.

It exists to:

* Prevent loss of Git/Supabase/Railway/env context during migration from Windsurf-only work to a multi-agent workflow.  
* Help ChatGPT, Codex, Claude, Windsurf, and future coding agents understand the local environment and integration boundaries.  
* Keep environment knowledge separate from secrets.  
* Make agents verify connector state instead of guessing.  
* Protect production, database, and payment infrastructure from unsafe AI edits.  
* Ensure future agents consult project context before touching integration code.

This file must not contain secrets. It should store env var names, service purpose, verification commands, and connector rules only.

Future agents must consult this file before modifying:

* API routes.  
* Feed generation.  
* Supabase code.  
* Payment/checkout code.  
* Webhook handlers.  
* Railway/deployment configuration.  
* Environment variable usage.  
* Auth/session/access logic.

## **2\. Security Rule: No Secrets In Context Files**

Never include actual secret values in this file or any `/docs/ai-context/*.md` file.

Forbidden secret types:

* API keys.  
* Supabase service role key values.  
* Supabase anon key values.  
* Database passwords.  
* Railway tokens.  
* Whop secrets.  
* Whop API keys.  
* Whop webhook signing secrets.  
* Stripe secret keys.  
* Stripe webhook secrets.  
* OpenAI keys.  
* Polymarket credentials, if any.  
* Private URLs containing tokens.  
* Production tokens.  
* Session cookie values.  
* JWTs.  
* OAuth client secrets.  
* Any `.env.local` values.

Allowed information:

* Env var names.  
* Which service each variable belongs to.  
* Whether the variable is client-side or server-only.  
* Which code area likely uses it.  
* Whether it is required now or later.  
* How to verify presence safely.  
* Which files may contain it locally.  
* Which files must never be committed.

Rules:

* `.env.local` must not be committed.  
* Agents must never print secret values.  
* Agents must not ask the founder to paste secret values into chat.  
* If a value is unknown, write `VALUE NOT STORED / NEEDS VERIFICATION`.  
* If a connector is not yet implemented, write `NEEDS VERIFICATION`.

## **3\. Local Development Environment**

Known local repo path:

C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1

OS assumptions:

* Windows local development environment.  
* CMD preferred over PowerShell for project commands.  
* PowerShell may be used for isolated archive/compression tasks when explicitly scoped, but CMD is the default for Git/npm verification.

Preferred terminal:

CMD

Likely stack:

Next.js / TypeScript

Package manager:

npm

Main commands:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
npm run dev  
npm run build

Common verification commands:

git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--stat  
git diff \--check

Local dev server behavior:

* Next dev server usually runs on port `3000`.  
* If port `3000` is busy, Next may try `3001`.  
* A warning may appear if another dev server is already running.  
* Existing server PID example seen in previous work: `PID 7448` on `localhost:3000`.  
* Do not kill an existing dev server unless needed.  
* Always verify which port is active before using browser/curl.  
* If multiple servers are running, API/browser results may not reflect the newest source state.

Start dev server:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
npm run dev

Build:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
npm run build

Only if needed, stop a stuck dev server by PID:

taskkill /PID \<PID\> /F

Do not kill a process unless the active port/PID has been verified.

## **4\. Git / GitHub Context**

Known facts:

* Git is used.  
* GitHub remote likely exists.  
* Main branch is active in recent work.  
* Current branch must always be verified with `git branch --show-current`.  
* Git status must be clean before push.  
* Push requires explicit founder approval.  
* No push with dirty tree.  
* No commit with unexpected files.  
* Docs-only commits must change only `/docs/ai-context/` files.

Recent commit facts from prior context:

* `2875d89 Tighten sports futures and relegation market filtering`  
* `43677cf Merge Polymarket API mapping fix`  
* Local main may have been ahead of origin/main after `2875d89`.  
* Push of `2875d89` was not approved until fresh verification.  
* Later recovery/feed checkpoint commits may exist, including `966f6c2 Stabilize PREMVP15 feed contract and evidence stack`. `NEEDS VERIFICATION` against current Git log.

Verify current branch/state:

git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--stat

Before commit:

npm run build  
git diff \--check  
git status \--short  
git diff \--stat

Before push:

git status \--short  
git log \--oneline \-5  
npm run build

Rules:

* Commit only intended files.  
* Do not commit generated junk, backup files, temp scripts, or source export archives.  
* Do not push without explicit approval.  
* Do not deploy without explicit approval.  
* If a context/doc update is the task, no source files should be modified.

## **5\. Project Context Files In Repo**

Expected shared context files:

/docs/ai-context/01\_PROJECT\_CONTEXT\_CURRENT.md  
/docs/ai-context/02\_CURRENT\_TECH\_STATE.md  
/docs/ai-context/03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md  
/docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md  
/docs/ai-context/05\_WINDSURF\_WORKFLOW\_RULES.md  
/docs/ai-context/06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md  
/docs/ai-context/07\_AI\_AGENT\_MIGRATION\_CONTEXT.md  
/docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md  
/docs/ai-context/09\_CONTEXT\_DELTA\_LOG.md

Rules:

* These files should be committed to the repo and used by all agents.  
* These files are onboarding context, not a substitute for source inspection.  
* If a context file conflicts with current source/Git/build/runtime output, the current source/Git/build/runtime output wins.  
* Agents must not rely on ChatGPT Saved Memory as project source of truth.  
* Saved Memory is full and should not be used as the operational source of truth.  
* `/docs/ai-context/` should become the shared context layer for Codex, Claude, Windsurf, ChatGPT, and future agents.

## **6\. Supabase Context**

Known Supabase usage (refreshed 2026-05-21):

* Supabase is used for lead capture, feed cache, and signal tracking.

Active tables:

* `public.lead_intents` — free lead + premium reserve intent
* `public.generated_signal_pairs` — feed cache (includes `market_sources` jsonb column)
* `public.signal_snapshots` — signal performance snapshots (added 61afd67, schema NEEDS VERIFICATION)

LocalStorage may exist as fallback/debug but is not production source of truth.

Known `public.lead_intents` fields/values from project context:

created\_at  
email  
source  
intent\_type  
plan\_id  
plan\_name  
plan\_price  
plan\_source  
event\_title  
position

Known usage:

* Pass offer / premium reserve lead capture.  
* Example values:  
  * `source = pass_offer_modal`  
  * `intent_type = premium_reserve`

Verification SQL:

select  
  created\_at,  
  email,  
  source,  
  intent\_type,  
  plan\_id,  
  plan\_name,  
  plan\_price,  
  plan\_source,  
  event\_title,  
  position  
from public.lead\_intents  
order by created\_at desc  
limit 20;

How to use:

* Run this in Supabase SQL Editor.  
* Do not expose database credentials.  
* Do not paste secret configuration.  
* If sharing output with an AI agent, paste only row/result shape and non-sensitive sample rows.  
* Do not paste private user data unless necessary and approved.

Future planned tables:

plan\_catalog  
checkout\_sessions  
payment\_events  
user\_entitlements  
external\_accounts optional

Payment/access rule:

* `user_entitlements` should become the internal source of truth for premium access.  
* Payment provider state should be normalized into internal tables.  
* Frontend must not trust provider redirect alone.  
* LocalStorage must not be used as production entitlement.

Supabase security caveats:

* `SUPABASE_SERVICE_ROLE_KEY` must be server-only.  
* Do not expose service role key to client components.  
* RLS/server-only logic must be verified before production payment/auth rollout.  
* Any destructive SQL requires explicit approval.

## **7\. Railway / Deployment Context**

Refreshed 2026-05-21.

Known facts:

* Railway is the deployment platform.
* Production domain: `https://polypropicks.com`
* Deploy trigger: git push to main triggers auto-deploy.
* Production status: NOT VERIFIED — blocked by RAILPACK V3 config issue AND Railway external incident.
* Never store Railway tokens in repo docs.
* Never paste Railway tokens into chat.

Current known issue 1 — RAILPACK V3 (config problem):

* Railway RAILPACK V3 builder generates a Caddy-only container for Next.js apps.
* This causes Caddy 404 responses instead of Node.js serving the app.
* Fix committed: `next.config.ts output: "standalone"` at 264500d.
* Manual action still required: Railway Dashboard → PREMVP service → Settings → Build
  → Change builder from RAILPACK to Nixpacks → Save → Redeploy.
* This is a Railway builder configuration issue, not an application code regression.

Current known issue 2 — Railway external incident (platform event):

* Commit `eb7fe40 Deploy: retrigger PREMVP after Railway incident` (2026-05-18) confirms
  a Railway external platform incident occurred around 2026-05-18.
* Recovery state and whether the incident is fully resolved: NEEDS VERIFICATION.
* Production verification results may be unreliable until Railway platform state is confirmed stable.
* Attribution: Railway platform behaviour, NOT PolyProPicks application code.

Production verification after Railway fix should include:

* Confirm Railway Dashboard shows Nixpacks builder (not RAILPACK).
* Confirm latest deploy logs are clean (no Caddy config generated).
* Production `/` browser check — must return landing page, not Caddy 404.
* Production `/api/feed/landing-cards?limit=1` — must return JSON, not HTML error.
* Lead capture endpoint if touched.
* Payment/webhook route if touched.
* Supabase write/read if touched.

Verification questions:

What Railway project?  
Which Railway environment?  
Which branch deploys?  
What env vars are configured?  
What production domain is active?  
What deploy logs show?  
Which commit is deployed?  
Does production /api/feed/landing-cards match local behavior?  
Does production / route show the expected landing?

Production verification after deploy should include:

* Build/deploy logs.  
* Production `/` browser check.  
* Production `/api/feed/landing-cards` response.  
* Lead capture endpoint behavior if touched.  
* Payment/webhook route behavior if touched.  
* Supabase write/read behavior if touched.

Do not deploy/push without explicit approval.

## **8\. API Routes And Runtime Verification**

Known routes (refreshed 2026-05-21):

/api/feed/landing-cards
/api/feed/debug-evidence-generation
/api/feed/debug-sports-cards
/api/feed/debug-sports-discovery
/api/feed/debug-resolve-signals
/api/leads
/api/checkout/create
/api/webhooks/whop
/api/entitlement/check
/api/auth/session
/api/auth/magic-link/request
/api/auth/magic-link/verify

### **/api/feed/landing-cards**

Purpose:

* Main landing feed API.  
* Returns LandingPair-style feed data for the landing page.  
* Source is Polymarket direction.  
* Expected formula version: `trusted-initial-formula-v1.1`.

Known behavior:

* Uses cache first.  
* Cached response may return `cacheStatus: hit`.  
* `cacheStatus: hit` does not prove fresh-generation logic.  
* Response may include:  
  * `generatedAt`  
  * `source`  
  * `formulaVersion`  
  * `pairs`  
  * `rejected`  
  * `filters`  
  * `inspected`  
  * `cacheStatus`  
  * `cacheBypassed`

Important fields to inspect:

pairs.length  
pairs\[\].premiumSignal  
pairs\[\].marketSource  
pairs\[\].marketSources\[\]  
pairs\[\].marketSources\[\].type  
pairs\[\].diagnostics  
cacheStatus  
cacheBypassed  
formulaVersion  
rejected.length

Expected evidence architecture:

* `marketSource` backward compatibility preserved.  
* `marketSources[]` evidence stack preserved.  
* Valid evidence cards:  
  * `market-source`  
  * `market-momentum`  
  * `sharp-flow` when real trade-size data exists.

Cached response is not fresh-generation proof. Use debug route when fresh generation must be verified.

Example curl:

curl "http://localhost:3000/api/feed/landing-cards?limit=5\&category=sports\&minDataCoverage=40\&excludeEnded=true"

### **/api/feed/debug-evidence-generation**

Purpose:

* Debug/fresh-generation verification route.  
* Should be used to inspect fresh feed generation when available.  
* May bypass cache.  
* Often expected to return `cacheBypassed: true` or fresh diagnostic data.  
* Likely disabled or restricted in production: `NEEDS VERIFICATION`.

Example curl:

curl "http://localhost:3000/api/feed/debug-evidence-generation?limit=10"

Inspect:

cacheBypassed  
pairs.length  
marketSources.length  
evidence types  
conditionId  
selectedTokenId  
maxTradeCash  
price  
delta  
rejected  
diagnostics

### **/api/feed/debug-sports-cards**

Purpose:

* Debug sports card generation.  
* Useful for sports feed diagnostics.  
* Exact current output shape: `NEEDS VERIFICATION`.

### **/api/feed/debug-sports-discovery**

Purpose:

* Debug sports discovery pipeline.  
* Useful for identifying why sports candidates are accepted/rejected.  
* Exact current output shape: `NEEDS VERIFICATION`.

### **/api/leads**

Purpose:

* Lead capture endpoint.  
* Used by CTA modal / pass offer / premium reserve flows.  
* Writes to Supabase `public.lead_intents`.

Known usage:

* Email capture.  
* Pass offer / premium reserve capture.  
* LocalStorage may exist as fallback/debug.  
* Supabase table is the business source for lead tracking.

Verification:

* Submit local lead via UI or API.  
* Check Supabase `public.lead_intents` with SQL.  
* Do not paste secrets.

## **9\. External Data Providers**

Current data direction:

* Polymarket public API / Gamma / Data API / CLOB direction.  
* Current feed route source is Polymarket.  
* Internal model should normalize external data into `LandingPair`.  
* Future provider integration must be adapter-based.  
* External provider-specific shapes must not leak directly into UI.

Known provider concepts:

Gamma API  
Polymarket Data API  
CLOB API  
conditionId  
selectedTokenId / clobTokenId  
market id  
event id  
outcome prices  
trades  
holders  
open interest  
price history  
orderbook/spread

Rules:

* Normalize provider data into internal shape.  
* Do not make UI depend on raw Polymarket response shape.  
* Do not hardcode one provider as internal business model.  
* New API provider integration should wait until entitlement/payment boundary is clear unless explicitly prioritized.  
* API-lite/cached feed should normalize provider data into internal `LandingPair` shape.  
* If using public APIs, verify rate limits and cache behavior.  
* Do not cache large responses through Next.js data cache if they exceed limits. Use no-store or controlled cache strategy when needed.

Known issue area:

* Sharp Flow requires real trade-size data.  
* Market Momentum requires price/delta/current price data.  
* Market Source requires volume/source data.  
* If `sharp-flow` is not present in `/api/feed/landing-cards`, verify whether trades/maxTradeCash/selectedTokenId are fetched, preserved in diagnostics, and passed through cache/route response.

## **10\. Payment Provider Connectors**

Current direction:

* Whop first.  
* Stripe later.  
* Provider-neutral architecture.  
* Supabase entitlement is source of truth.

Payment providers are not the internal source of truth. Provider checkout/webhook events must be normalized into internal tables.

Target flow:

PassOfferModal  
→ /api/checkout/create  
→ provider checkout  
→ /api/webhooks/whop or /api/webhooks/stripe  
→ payment\_events  
→ user\_entitlements  
→ getPremiumAccess()  
→ unlocked premium feed

Likely env var names:

WHOP\_API\_KEY=VALUE NOT STORED  
WHOP\_WEBHOOK\_SECRET=VALUE NOT STORED  
WHOP\_PRODUCT\_ID=VALUE NOT STORED / NEEDS VERIFICATION  
WHOP\_PLAN\_ID=VALUE NOT STORED / NEEDS VERIFICATION

STRIPE\_SECRET\_KEY=VALUE NOT STORED  
STRIPE\_WEBHOOK\_SECRET=VALUE NOT STORED  
STRIPE\_PRICE\_ID\_24H=VALUE NOT STORED / NEEDS VERIFICATION  
STRIPE\_PRICE\_ID\_7DAY=VALUE NOT STORED / NEEDS VERIFICATION  
STRIPE\_PRICE\_ID\_MONTHLY=VALUE NOT STORED / NEEDS VERIFICATION

NEXT\_PUBLIC\_APP\_URL=VALUE NOT STORED / NEEDS VERIFICATION

Rules:

* UI must check internal access only.  
* Webhooks must create normalized `payment_events`.  
* Entitlement resolver must read `user_entitlements`.  
* Whop-specific fields must be stored as external/provider metadata, not app identity.  
* Stripe can be added later by adding provider adapter/webhook mapping, not rewriting access logic.  
* Provider customer ID must not become app user ID.  
* Checkout success redirect is not sufficient proof of access.  
* Webhook verification must be implemented before production entitlement.

## **11\. Auth / Registration Connector**

Current auth state (refreshed 2026-05-21):

SHIPPED — magic-link + session (e418020, 5ef8811)

Active implementation:
* `app/api/auth/magic-link/request/route.ts` — request magic link email
* `app/api/auth/magic-link/verify/route.ts` — verify token, grant session
* `app/api/auth/session/route.ts` — session check/set
* `lib/auth/premiumSession.ts` — session cookie helpers

Auth mechanism: magic-link email → verified entitlement → secure server-set cookie → `/premium` access.
Production verification: NEEDS VERIFICATION.

Rules:

* Registration does not block the free signal.
* Free signal remains visible without forced login.
* Premium access is based on internal entitlement, not localStorage or provider redirect.
* `lib/auth/premiumSession.ts` manages session cookies — server-only.
* Full OAuth (Google, GitHub) is deliberately postponed.

Future env var names:

NEXT\_PUBLIC\_SUPABASE\_URL=VALUE NOT STORED / NEEDS VERIFICATION  
NEXT\_PUBLIC\_SUPABASE\_ANON\_KEY=VALUE NOT STORED / NEEDS VERIFICATION  
SUPABASE\_SERVICE\_ROLE\_KEY=VALUE NOT STORED / NEEDS VERIFICATION

Security:

* `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` may be client-side if intended.  
* `SUPABASE_SERVICE_ROLE_KEY` is server-only.  
* Never expose service role key in client components or browser bundles.

## **12\. Environment Variable Inventory**

| Env var name | Service | Client/server | Required now? | Required later? | Used by | Value stored here? | Verification status |
| ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase | Client/server | NEEDS VERIFICATION | Yes | Supabase client/auth/lead capture | No | NEEDS VERIFICATION |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase | Client | NEEDS VERIFICATION | Yes | Supabase client/auth | No | NEEDS VERIFICATION |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | Server-only | NEEDS VERIFICATION | Yes | Server routes, privileged DB writes | No | NEEDS VERIFICATION |
| `NEXT_PUBLIC_APP_URL` | App / payments | Client/server public URL | NEEDS VERIFICATION | Yes | Checkout return/cancel URLs, links | No | NEEDS VERIFICATION |
| `WHOP_API_KEY` | Whop | Server-only | **YES (SHIPPED)** | Yes | `/api/checkout/create`, Whop API | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `WHOP_WEBHOOK_SECRET` | Whop | Server-only | **YES (SHIPPED)** | Yes | `/api/webhooks/whop` | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `WHOP_PRODUCT_ID` | Whop | Server/config | **YES (SHIPPED)** | Yes | Plan/product mapping | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `WHOP_PLAN_ID` | Whop | Server/config | **YES (SHIPPED)** | Yes | Plan/product mapping | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `STRIPE_SECRET_KEY` | Stripe | Server-only | No | Later | Stripe checkout/webhooks | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `STRIPE_WEBHOOK_SECRET` | Stripe | Server-only | No | Later | `/api/webhooks/stripe` | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `STRIPE_PRICE_ID_24H` | Stripe | Server/config | No | Later | Stripe price mapping | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `STRIPE_PRICE_ID_7DAY` | Stripe | Server/config | No | Later | Stripe price mapping | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `STRIPE_PRICE_ID_MONTHLY` | Stripe | Server/config | No | Later | Stripe price mapping | No | VALUE NOT STORED / NEEDS VERIFICATION |
| `POLYMARKET_API_KEY` | Polymarket/external | Server-only | NEEDS VERIFICATION | NEEDS VERIFICATION | External API if required | No | NEEDS VERIFICATION |
| `POLYMARKET_GAMMA_BASE_URL` | Polymarket/Gamma | Server/config | NEEDS VERIFICATION | NEEDS VERIFICATION | Feed provider config | No | NEEDS VERIFICATION |
| `POLYMARKET_DATA_API_BASE_URL` | Polymarket Data API | Server/config | NEEDS VERIFICATION | NEEDS VERIFICATION | Feed provider config | No | NEEDS VERIFICATION |
| `POLYMARKET_CLOB_API_BASE_URL` | Polymarket CLOB | Server/config | NEEDS VERIFICATION | NEEDS VERIFICATION | Feed provider config | No | NEEDS VERIFICATION |
| `RAILWAY_TOKEN` | Railway | Never in app env unless required by CI | No | No | Deployment automation only | No | Must not be stored |
| `OPENAI_API_KEY` | OpenAI | Server-only | NEEDS VERIFICATION | NEEDS VERIFICATION | AI features if added | No | NEEDS VERIFICATION |

If an env var is not actually used in source, do not add it to production just because it appears here. Verify source usage first.

## **13\. Connector Verification Checklist**

### **Before Supabase work**

* Verify relevant env vars exist locally/production without printing values.  
* Verify table exists.  
* Verify required columns exist.  
* Verify insert/select path.  
* Verify RLS/server-only logic if relevant.  
* Verify server routes do not expose service role key.  
* Verify local build passes.  
* Verify Supabase SQL query returns expected row shape.  
* Verify no destructive SQL is run without explicit approval.

### **Before Railway deploy**

* `npm run build` passes locally.  
* `git status --short` is clean after commit.  
* Intended branch/commit verified.  
* Railway env vars configured.  
* Deploy logs clean.  
* Production endpoint returns expected response.  
* Production browser route loads expected screen.  
* Production `/api/feed/landing-cards` returns expected `pairs`.  
* No Railway tokens stored in repo or context files.

### **Before Whop integration**

* Confirm Whop product/plan IDs.  
* Confirm webhook event names.  
* Confirm sandbox/test mode if available.  
* Confirm acceptable product category.  
* Confirm checkout return URL.  
* Confirm checkout cancel URL.  
* Confirm webhook signature verification method.  
* Confirm `WHOP_API_KEY` is server-only.  
* Confirm `WHOP_WEBHOOK_SECRET` is server-only.  
* Confirm `/api/checkout/create` creates provider checkout session and internal `checkout_sessions` record.  
* Confirm webhook writes normalized `payment_events`.  
* Confirm entitlement update writes `user_entitlements`.  
* Confirm frontend unlock checks internal access only.  
* Confirm no localStorage-only premium access.

### **Before Stripe integration**

* Confirm products/prices.  
* Confirm webhook events.  
* Confirm success URL.  
* Confirm cancel URL.  
* Confirm test mode.  
* Confirm subscription vs one-time model.  
* Confirm webhook signature verification.  
* Confirm Stripe customer ID is external account metadata, not app user ID.  
* Confirm Stripe integration writes normalized `payment_events`.  
* Confirm Stripe integration updates `user_entitlements`.

### **Before new API provider**

* Confirm provider endpoint.  
* Confirm auth requirements.  
* Confirm rate limits.  
* Confirm normalized output shape.  
* Confirm cache behavior.  
* Confirm fallback behavior.  
* Confirm provider-specific shape does not leak into UI.  
* Confirm API output maps to internal `LandingPair`.  
* Confirm manual fallback/override remains possible.  
* Confirm build and API acceptance checks pass.

## **14\. What Agents Must Not Do**

Agents must not:

* Print secrets.  
* Commit `.env.local`.  
* Commit `.env`, `.env.production`, `.env.*` files with secrets.  
* Change Railway/Supabase config blindly.  
* Hardcode secrets in source.  
* Create payment access in localStorage only.  
* Add provider-specific UI state as access truth.  
* Push without clean Git and explicit approval.  
* Deploy without explicit approval.  
* Run destructive DB commands without explicit approval.  
* Alter production env vars without approval.  
* Rotate or remove env vars without approval.  
* Paste service role keys into chat.  
* Expose webhook secrets in logs.  
* Treat provider checkout redirect as proof of access.  
* Force user registration before free signal visibility.  
* Make Whop-only or Stripe-only internal entitlement logic.  
* Store provider customer ID as internal user ID.  
* Remove manual fallback/override without approval.  
* Touch UI/CSS when task is backend connector work.  
* Touch backend/payment when task is visual card work.  
* Commit generated archive/temp/backup files.  
* Rely on AI summaries instead of Git/build/API/Supabase/Railway verification.

## **15\. Immediate Known Environment State**

Refreshed 2026-05-21 from git log + source files.

```
Branch:           main
HEAD:             264500d Deploy: force Next.js standalone runtime
Origin:           synced
Working tree:     clean (docs/design/ untracked — intentional)
```

Known facts:
* Whop payment stack: SHIPPED (11+ commits) — production env vars required
* Magic-link auth + session: SHIPPED — production env vars required
* Premium page /premium: SHIPPED
* Signal resolver + snapshots: SHIPPED
* Upcoming pairs API: SHIPPED
* Railway deploy: NEEDS VERIFICATION — RAILPACK/Caddy 404 issue; manual Nixpacks switch required in Railway Dashboard
* Production URL https://polypropicks.com: NEEDS VERIFICATION
* Whop product/plan/env config: NEEDS VERIFICATION (vars present in Railway env? UNKNOWN)
* Supabase signal_snapshots table schema: NEEDS VERIFICATION
* Sharp Flow real API presence: NEEDS VERIFICATION (check marketSources[].type in /api/feed/landing-cards)
* Stripe configuration: deferred / NEEDS VERIFICATION when added

If any of this is outdated by current command output, current command output wins.

## **16\. Final Operating Rule**

Environment/config context must be verified, not guessed.  
No secrets in context files.  
Repo docs are shared source of truth for all agents.  
Source files and Git/build/runtime output beat memory.  
Deployment/payment/auth changes require explicit verification gates.  
Supabase/Railway/env state must be checked safely without printing secrets.  
Provider-neutral architecture must be preserved.  
No localStorage-only premium access.  
No push/deploy without explicit approval.

