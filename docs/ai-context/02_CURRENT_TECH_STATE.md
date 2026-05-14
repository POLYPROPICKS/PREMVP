# **CURRENT\_TECH\_STATE.md**

## **1\. Repository / Environment**

| Item | Value |
| ----- | ----- |
| Project | PolyProPicks / PolyPicks Current |
| Repo name | PREMVP |
| GitHub remote | `https://github.com/POLYPROPICKS/PREMVP.git` |
| Local path | `C:\WORK\KalshiProPulse\sipropicks-premvp1-1` |
| OS/tooling assumption | Windows |
| Preferred terminal | CMD, not PowerShell |
| Package manager | npm |
| Framework | Next.js 16.2.4 with Turbopack |
| Main production domain | `https://polypropicks.com` |
| Deployment provider | Railway |
| Database provider | Supabase |
| Primary local dev route | `/` and `/reconstruction` |
| Main API route | `/api/feed/landing-cards` |

Expected base commands:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
npm run dev  
npm run build  
git status \--short  
git log \--oneline \-5

Core verification commands:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git diff \--stat  
git diff \--check  
npm run build

## **2\. Current Branch / Commit State**

| Item | Latest known value | Confidence | Notes |
| ----- | ----- | ----- | ----- |
| Latest known main commit | `8e96225 Merge PREMVP12 evidence stack foundation` | Confirmed | Merged and pushed to `origin/main`. |
| Latest known origin/main before PREMVP12 Step 3 | `8e96225` | Confirmed | Production Step 2 eventually confirmed OK by user. |
| Previous main commit | `dd9a578 Capture premium reserve intent` | Confirmed | Premium reserve capture after pass modal merge. |
| Pass modal visual merge | `7294840 Merge pass offer modal visual design` | Confirmed | Full-screen pass offer modal v1 merged/pushed. |
| PREMVP12 evidence foundation feature branch | `premvp12-evidence-stack-foundation` | Confirmed | Merged into main. |
| PREMVP12 evidence foundation commit | `6f55875 Add PREMVP12 evidence stack foundation` | Confirmed | Build passed before merge. |
| Active/unmerged feature branch | `premvp12-evidence-generation` | Confirmed | Backend evidence generation branch. |
| Active/unmerged commit | `18e3dc2 Generate PREMVP12 evidence stack cards` | Confirmed | Local feature-branch commit only. |
| Known dirty files after `18e3dc2` | Working tree was clean after commit | Confirmed | But commit included trailing whitespace warnings before commit. Needs cleanup/amend before merge. |
| Build status for `18e3dc2` | Passed | Confirmed | Build passed before commit. |
| Runtime verification for `18e3dc2` | Not fully verified | Confirmed | `/api/feed/landing-cards` returned cache hit; debug route uses different mapper. |
| Push status for `18e3dc2` | Not pushed / not merged | Confirmed | Feature branch local state only. |
| Production status for `18e3dc2` | Not deployed | Confirmed | Not merged to main. |

If exact current state is uncertain, run:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-5  
npm run build  
git diff \--check

## **3\. Deployment / Production State**

| Item | Latest known state |
| ----- | ----- |
| Production domain | `https://polypropicks.com` |
| Deployment provider | Railway |
| Production HTTP status | Previously returned `200 OK` |
| Production `/api/feed/landing-cards` | Active |
| Production formula version | `trusted-initial-formula-v1.1` |
| Production cache behavior | Can return `cacheStatus: "hit"` |
| Latest production-verified backend shape | PREMVP12 Step 2 `marketSources[]` foundation eventually confirmed OK by user |
| Latest production UI state | Mobile landing \+ pass offer modal v1 deployed |
| Latest unmerged code | PREMVP12 Step 3B backend evidence generation is not production deployed |

Known production checks already seen in context:

cmd /c curl.exe \-I https://polypropicks.com

Expected production API check shape:

curl "https://polypropicks.com/api/feed/landing-cards?limit=1\&category=sports\&minDataCoverage=40\&excludeEnded=true" \> C:\\WORK\\KalshiProPulse\\backups\\premvp12-prod-feed.json

Production verification caveat:

* Production may return cached API data.  
* Cached responses may not prove fresh generation behavior.  
* Railway deployment may lag after push.  
* Closed client-side modal text may not appear in server-rendered HTML; manual trigger/client bundle checks may be needed for modal behavior.

## **4\. Supabase / Database State**

Supabase is used for:

* lead capture  
* premium reserve intent capture  
* generated signal pair cache

Known table:

| Table | Purpose | Status |
| ----- | ----- | ----- |
| `public.lead_intents` | Captures email leads and premium reserve intents | Production accepted |
| `generated_signal_pairs` | Cache for generated feed pairs | Used by `/api/feed/landing-cards` |

Known premium reserve fields in `public.lead_intents`:

| Field | Known use |
| ----- | ----- |
| `email` | Captured user email |
| `source` | Example: `pass_offer_modal` |
| `intent_type` | Example: `premium_reserve` |
| `plan_id` | Example values: `monthly`, `7day`, `24h` |
| `plan_name` | Example values: `Monthly Pro`, `7-Day Premium`, `24-Hour Pass` |
| `plan_price` | Example values: `$49`, `$15`, `$4.99` |
| `plan_source` | Plan source metadata |
| `event_title` | Active event context if captured |
| `position` | Active selected position if captured |
| `created_at` | Timestamp |

Known production acceptance:

* Premium reserve rows were confirmed in Supabase.  
* Test email observed in context: `tureckisun777@gmail.com`.  
* `source = pass_offer_modal`.  
* `intent_type = premium_reserve`.

Known cache behavior:

* `generated_signal_pairs` currently stores/reads single `market_source`.  
* PREMVP12 Step 2 deliberately did **not** add a `market_sources` DB column.  
* No Supabase schema migration was performed for PREMVP12 Step 2\.  
* No query for non-existing `market_sources` should exist.

Do not expose Supabase keys or secrets.

## **5\. Backend Feed Pipeline**

Main backend/API route:

| Route | Role |
| ----- | ----- |
| `/api/feed/landing-cards` | Main generated landing feed endpoint |
| `/api/feed/debug-sports-cards` | Debug sports card endpoint; uses different sports mapper |
| `/api/feed/debug-sports-discovery` | Sports discovery/debug endpoint |
| `/api/leads` | Lead and intent capture endpoint |

Current feed architecture:

* `lib/feed/buildLandingCards.ts` builds generated landing card pairs.  
* `lib/feed/landingPairs.ts` defines canonical `LandingPair` shape and evidence-stack normalization.  
* `lib/feed/types.ts` defines feed/API response types.  
* `lib/feed/cacheGeneratedSignals.ts` handles Supabase cache read/write.  
* `content/marketSources.ts` defines MarketSource/evidence card type compatibility.  
* `content/signals.ts` provides manual/static fallback signals.

Known formula/version:

trusted-initial-formula-v1.1

Known cache behavior:

* `/api/feed/landing-cards` is cache-first.  
* API may return `cacheStatus: "hit"`.  
* Cache hit may return previously cached pairs.  
* Cache hit can block runtime verification of new generation logic.  
* No cache-bypass query parameter is currently known.

PREMVP12 Step 2 state:

* `marketSource` remains primary proof card.  
* `marketSources[]` exists as backward-compatible optional evidence stack.  
* `marketSources[0]` corresponds to `marketSource`.  
* Production eventually confirmed OK by user for Step 2\.

PREMVP12 Step 3B feature-branch state:

* `buildLandingCards.ts` now includes backend evidence generation on branch `premvp12-evidence-generation`.  
* `buildEvidenceStack()` generates:  
  * primary `market-source`  
  * optional `sharp-flow`  
  * optional `market-momentum`  
* `news-pulse` intentionally not generated yet because there is no verified news API/source.  
* `marketSources[0]` was corrected to be initialized from the existing `marketSource` to avoid primary proof drift.  
* Runtime generation not fully verified due to cache hit/no cache bypass.

Known evidence card types:

"market-source" | "news-pulse" | "market-momentum" | "sharp-flow"

Known visual types:

"chart" | "news-image" | "team-crests" | "avatar"

Legacy visual compatibility values:

"shark-avatar" | "event-icon" | "news-icon"

## **6\. Frontend State**

Current frontend surface:

| Area | Status |
| ----- | ----- |
| `/` | Production landing route |
| `/reconstruction` | Reference/debug landing route |
| PremiumEventCard | Main signal/decision card |
| MarketSourceCard | Evidence/proof card |
| PremiumEventCarousel | Main premium feed carousel with locked peek behavior |
| MarketSourceCarousel | Upper proof/evidence carousel; current UI still uses primary `marketSource` behavior |
| PassOfferModal | Full-screen pass/paywall modal |
| Main CTA | `Get 5 Free Signals NOW` |
| Main CTA behavior | Opens free-signal lead capture |
| Locked feed attempt | Opens PassOfferModal |
| Filters | Free controls |

Current UI production status:

* Mobile landing and pass offer modal v1 are deployed.  
* Premium reserve capture is production accepted.  
* PREMVP12 Step 2 had no UI change.  
* PREMVP12 Step 3B is backend-only and must not change frontend.

Mobile viewport assumptions:

* Primary:  
  * `390×700`  
  * `428×760`  
* Secondary:  
  * `390×844`  
  * `428×926`

Files that should not be touched during backend feed phase unless explicitly required:

* `app/reconstruction/page.tsx`  
* `app/reconstruction/Reconstruction.module.css`  
* `components/carousels/MarketSourceCarousel.tsx`  
* `components/carousels/PremiumEventCarousel.tsx`  
* `components/modals/PassOfferModal.tsx`  
* `components/modals/PassOfferModal.module.css`

## **7\. Active Files and Their Roles**

| File path | Role | Current status | Touch rules |
| ----- | ----- | ----- | ----- |
| `app/api/feed/landing-cards/route.ts` | Main feed API route; cache-first response | Changed in PREMVP12 Step 2; merged to main | Do not touch during Step 3B cleanup unless API verification scope changes |
| `app/page.tsx` | Production root route | NEEDS VERIFICATION | Do not touch unless routing task requires it |
| `app/reconstruction/page.tsx` | Main landing UI/state wiring | Production baseline | Do not touch during backend-only work |
| `app/reconstruction/Reconstruction.module.css` | Landing CSS | Fragile historical file | Avoid unless explicit UI task |
| `components/carousels/MarketSourceCarousel.tsx` | Upper evidence carousel | Current UI not yet converted to evidence-stack rotation | Do not touch until PREMVP12 frontend evidence phase |
| `components/carousels/PremiumEventCarousel.tsx` | Premium signal carousel / locked feed attempts | Production baseline | Do not touch during backend-only work |
| `components/modals/PassOfferModal.tsx` | Full-screen pass/paywall modal | Production baseline | Do not touch during backend evidence work |
| `components/modals/PassOfferModal.module.css` | Modal-specific styling | Production baseline | Keep modal styling isolated here |
| `content/signals.ts` | Static/manual PremiumSignal fallback | Active fallback | Do not remove fallback |
| `content/marketSources.ts` | MarketSource/evidence types and fallback content | Changed in PREMVP12 Step 2; merged | Touch only for type/data-shape work |
| `lib/feed/buildLandingCards.ts` | Main Polymarket/API-lite generation function | Active unmerged Step 3B work | Current active cleanup/amend target |
| `lib/feed/cacheGeneratedSignals.ts` | Supabase cache read/write | Changed in PREMVP12 Step 2; merged | Do not query `market_sources` unless future schema exists |
| `lib/feed/buildSportsLandingCards.ts` | Sports-specific mapper/debug path | Relevant for debugging but not main Step 3B generation | Do not assume it verifies `buildLandingCards.ts` |
| `lib/feed/landingPairs.ts` | Canonical LandingPair and evidence-stack helpers | Changed in PREMVP12 Step 2; merged | Preserve canonical model |
| `lib/feed/types.ts` | Feed/API response types | Changed in PREMVP12 Step 2; merged | Touch only for type alignment |

## **8\. Latest Known Completed Technical Milestones**

| Milestone | Branch/commit | Files changed | Verification passed | Production/local status | Remaining caveat |
| ----- | ----- | ----- | ----- | ----- | ----- |
| Pass offer modal shell | `1d7c025 Add locked feed pass offer modal shell` | `PassOfferModal`, carousel/page wiring | Build passed | Feature branch then merged later | Visual was later replaced/polished |
| Pass offer modal visual design | `143a461 Polish pass offer modal visual design`, merged via `7294840` | Modal TSX/CSS | Build passed | Pushed to main/prod | Server-rendered HTML did not show closed modal strings |
| Premium reserve capture | `dd9a578 Capture premium reserve intent` | Lead/intent capture logic | Supabase rows confirmed | Production accepted | None current |
| PREMVP12 evidence stack foundation | `6f55875`, merged via `8e96225` | 6 feed/type/API/cache files | Build passed; local API passed; production eventually confirmed OK | Merged/pushed to main | Runtime generation still separate |
| PREMVP12 backend evidence generation | `18e3dc2 Generate PREMVP12 evidence stack cards` | `lib/feed/buildLandingCards.ts` | Build passed | Feature branch only | Trailing whitespace committed; runtime generation not fully verified due cache hit |

## **9\. Current Known Risks / Blockers**

Current active risks:

1. **Trailing whitespace in `buildLandingCards.ts` commit**  
   * `git diff --check` showed trailing whitespace before commit `18e3dc2`.  
   * Must clean and amend before merge/push.  
2. **Runtime evidence generation not fully verified**  
   * `/api/feed/landing-cards` returned `cacheStatus: "hit"`.  
   * Cache hit showed only existing cached evidence data.  
   * No cache-bypass query param known.  
3. **Debug endpoint mismatch**  
   * `/api/feed/debug-sports-cards` uses `buildSportsLandingCards()`, not the main `buildLandingCards.ts` generation path.  
   * It cannot verify Step 3B evidence generation.  
4. **Do not accidentally edit UI during backend phase**  
   * Step 3B is backend-only.  
   * No frontend/carousel/CSS/modal changes should happen.  
5. **Broad Windsurf refactor risk**  
   * Windsurf previously caused type churn by editing the wrong type source.  
   * After one failed attempt, direct-source review is required before further Windsurf prompts.  
6. **Production cache/deploy delay**  
   * Production can return cached results after push.  
   * Railway deployment may lag Git push.  
7. **No fake evidence claims**  
   * `news-pulse` must not be generated until a verified news/context source exists.  
   * `sharp-flow` must remain proxy language, not verified institutional smart money.

## **10\. Verification Commands**

### **Local Git/build verification**

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--stat  
git diff \--check  
npm run build

### **Local API verification**

Dev server required.

Run dev server:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
npm run dev

If server is available on `localhost:3000`, check feed:

curl "http://localhost:3000/api/feed/landing-cards?limit=1\&category=sports\&minDataCoverage=40\&excludeEnded=true" \> C:\\WORK\\KalshiProPulse\\backups\\premvp12-local-feed.json

Parse response:

node \-e "const fs=require('fs'); const raw=fs.readFileSync('C:\\\\WORK\\\\KalshiProPulse\\\\backups\\\\premvp12-local-feed.json','utf8'); console.log('bytes',raw.length); const data=JSON.parse(raw); const p=data.pairs?.\[0\]; console.log({hasPairs:Array.isArray(data.pairs), pairCount:data.pairs?.length, hasMarketSource:\!\!p?.marketSource, hasMarketSources:Array.isArray(p?.marketSources), marketSourcesLength:p?.marketSources?.length, firstMarketSourceId:p?.marketSource?.id, firstEvidenceId:p?.marketSources?.\[0\]?.id, firstEvidenceMatches:p?.marketSources?.\[0\]?.id===p?.marketSource?.id, evidenceTypes:p?.marketSources?.map(s=\>s.type), evidenceVisualTypes:p?.marketSources?.map(s=\>s.visualType), cacheStatus:data.cacheStatus, formulaVersion:data.formulaVersion});"

Expected for PREMVP12 Step 2:

hasMarketSource: true  
hasMarketSources: true  
marketSourcesLength: 1  
firstEvidenceMatches: true

Expected for fresh Step 3B generation:

hasMarketSource: true  
hasMarketSources: true  
marketSourcesLength: 1-3  
firstEvidenceMatches: true  
evidenceTypes includes "market-source" and optionally "sharp-flow"/"market-momentum"

Caveat:

* Cache hit may still show old/one-card result.  
* This does not necessarily invalidate Step 3B code.

### **Production API verification**

curl "https://polypropicks.com/api/feed/landing-cards?limit=1\&category=sports\&minDataCoverage=40\&excludeEnded=true" \> C:\\WORK\\KalshiProPulse\\backups\\premvp12-prod-feed.json

node \-e "const fs=require('fs'); const raw=fs.readFileSync('C:\\\\WORK\\\\KalshiProPulse\\\\backups\\\\premvp12-prod-feed.json','utf8'); console.log('bytes',raw.length); const data=JSON.parse(raw); const p=data.pairs?.\[0\]; console.log({hasPairs:Array.isArray(data.pairs), pairCount:data.pairs?.length, hasMarketSource:\!\!p?.marketSource, hasMarketSources:Array.isArray(p?.marketSources), marketSourcesLength:p?.marketSources?.length, firstMarketSourceId:p?.marketSource?.id, firstEvidenceId:p?.marketSources?.\[0\]?.id, firstEvidenceMatches:p?.marketSources?.\[0\]?.id===p?.marketSource?.id, cacheStatus:data.cacheStatus, formulaVersion:data.formulaVersion});"

HTTP status check:

cmd /c curl.exe \-I https://polypropicks.com

### **Supabase verification**

Known non-sensitive query shape for recent lead intents:

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

Expected premium reserve row pattern:

source \= pass\_offer\_modal  
intent\_type \= premium\_reserve  
plan\_id \= monthly / 7day / 24h  
plan\_name \= Monthly Pro / 7-Day Premium / 24-Hour Pass  
plan\_price \= $49 / $15 / $4.99

## **11\. Safe Next Technical Step**

### **Objective**

Clean trailing whitespace in `lib/feed/buildLandingCards.ts`, amend the existing `premvp12-evidence-generation` commit, and verify build/diff before any merge or push.

### **Branch context**

Expected branch:

premvp12-evidence-generation

Latest known commit:

18e3dc2 Generate PREMVP12 evidence stack cards

### **Exact precheck**

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--check  
npm run build

### **Allowed files**

* `lib/feed/buildLandingCards.ts`

### **Forbidden files**

* `app/api/feed/landing-cards/route.ts`  
* `content/marketSources.ts`  
* `lib/feed/landingPairs.ts`  
* `lib/feed/types.ts`  
* `lib/feed/cacheGeneratedSignals.ts`  
* `app/reconstruction/page.tsx`  
* any carousel component  
* any modal file  
* any CSS file  
* Supabase/Railway config

### **Exact verification**

After cleanup:

git diff \--check  
npm run build  
git status \--short  
git diff \--stat

After amend:

git status \--short  
git log \--oneline \-5

### **Stop condition**

Stop if:

* branch is not `premvp12-evidence-generation`  
* working tree has unexpected dirty files  
* `git diff --check` still reports trailing whitespace  
* build fails  
* any file other than `lib/feed/buildLandingCards.ts` changes  
* Windsurf attempts to change logic while cleaning whitespace

### **Merge/push rule**

Do not merge/push Step 3B until:

* whitespace cleanup is amended  
* build passes  
* Git tree is clean  
* ChatGPT decides whether runtime verification blocker is acceptable or a narrow debug/cache-bypass step is needed

## **12\. Technical Handoff Summary**

PolyProPicks is a Next.js/Railway/Supabase production prototype at `C:\WORK\KalshiProPulse\sipropicks-premvp1-1`, with production at `https://polypropicks.com` and GitHub remote `https://github.com/POLYPROPICKS/PREMVP.git`. Main is latest known at `8e96225 Merge PREMVP12 evidence stack foundation`, which added production-verified backward-compatible `marketSources[]` while preserving `marketSource`. Supabase lead and premium reserve capture are production-accepted via `public.lead_intents`. The active unmerged technical work is branch `premvp12-evidence-generation`, commit `18e3dc2 Generate PREMVP12 evidence stack cards`, changing only `lib/feed/buildLandingCards.ts` to generate primary `market-source` plus optional `sharp-flow` and `market-momentum`; build passed, but the commit was made despite trailing whitespace warnings and runtime generation was not fully verified because `/api/feed/landing-cards` returned cache hits and the debug sports endpoint uses a different mapper. The safest next step is to clean whitespace in `buildLandingCards.ts`, amend `18e3dc2`, rerun `git diff --check` and `npm run build`, then decide whether to merge or add a narrow runtime verification path.

