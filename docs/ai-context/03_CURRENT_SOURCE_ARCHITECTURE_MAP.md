# **CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md**

## **1\. Purpose**

This file exists to keep the new ChatGPT Project aligned with the real current repository structure.

Chat memory is not enough. The actual PolyProPicks source files may have changed through Windsurf, manual commands, merges, commits, deploys, or partial failed attempts. Future LLMs must not infer current architecture only from old chat history.

The only reliable source for the current source architecture is the current repo inspected directly by Windsurf in inspect-only mode.

This file should be updated after major source changes. It prevents:

* stale-file edits  
* wrong route assumptions  
* wrong selector edits  
* wrong component wiring assumptions  
* outdated carousel/state assumptions  
* duplicated type/source-of-truth mistakes  
* architecture drift  
* accidental edits to legacy/dead files

## **2\. When To Use This File**

Use this file:

* when starting a new ChatGPT Project  
* before architecture work  
* before carousel/feed/modal refactors  
* after a merge  
* after a failed Windsurf attempt  
* when actual active files are uncertain  
* when LLM context conflicts with source  
* before touching state/data-flow logic  
* before touching `LandingPair`, feed builders, API routes, carousel state, modal state, or Supabase write paths  
* before deciding whether a file is active, legacy, or unused  
* before giving Windsurf any prompt that touches more than one source area

Do not use old chat memory as the source of truth when this file is stale.

## **3\. Windsurf Inspect-Only Command**

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

You are working in the PolyProPicks / PolyPicks Current repository.

TASK:  
Inspect current PolyProPicks source architecture. Do not edit anything.

GOAL:  
Produce a precise source map of the current active files, routes, components, data flow, feed generation, API routes, modal/lead capture, carousel behavior, content/data files, config/deployment files, and known legacy/dead files.

CRITICAL RULES:

* INSPECT ONLY.  
* Do not edit files.  
* Do not create files.  
* Do not delete files.  
* Do not rename files.  
* Do not change imports.  
* Do not run formatters.  
* Do not refactor anything.  
* Do not stage.  
* Do not commit.  
* Do not push.  
* Do not deploy.  
* If a command is unavailable, report it and continue with available inspection.  
* If build fails, report the first error and continue source inspection if possible.

PRECHECK COMMANDS:  
Run from repo root:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-8  
npm run build

If `npm run build` is too slow or blocked, report it and continue with source inspection.

REPO STRUCTURE INSPECTION:  
Inspect and summarize these areas:

* `app/`  
* `components/`  
* `content/`  
* `lib/`  
* `scripts/`  
* `public/`  
* `styles/`  
* `types/`  
* `package.json`  
* `next.config.*`  
* `tailwind.config.*`  
* `middleware.*`  
* `.env.example` if present  
* `README` / `docs` if present

If some folders/files do not exist, report `not present`.

READ-ONLY COMMANDS ALLOWED:  
You may use read-only commands such as:

dir /s /b  
type  
findstr  
git status \--short  
git branch \--show-current  
git log \--oneline \-8  
npm run build

If a tree/grep equivalent is available, you may use it read-only. Do not use commands that modify files.

REQUIRED FILE DISCOVERY:

Identify all active files related to the following domains.

1. Routes/pages:  
* `/`  
* `/reconstruction`  
* API routes  
* lead capture routes  
* feed routes  
* debug routes  
2. Landing UI:  
* main page component  
* reconstruction page  
* layout/status/header components  
* PremiumEventCard  
* MarketSourceCard  
* PremiumEventCarousel  
* MarketSourceCarousel  
* PassOfferModal  
* filter components  
* CTA components  
3. Feed/data architecture:  
* LandingPair model  
* feed builders  
* sports feed builders  
* cache builders  
* cache readers/writers  
* `marketSource`  
* `marketSources[]`  
* `formulaVersion`  
* fallback/manual content  
4. Content/data files:  
* signals  
* market sources  
* teams/leagues/sports if any  
* static fallback data  
* CTA/pricing config if any  
5. Supabase/database:  
* `lead_intents` usage  
* generated signal/cache usage  
* client/server Supabase files  
* database insert/select functions  
* environment variable names, without secret values  
* API routes writing leads/intents  
6. Modal/paywall:  
* PassOfferModal  
* modal step/state machine  
* plan selection  
* premium reserve capture  
* success/error states  
* CTA text source  
* pricing text source  
7. Carousel/state:  
* `activePairId`  
* `activeFilter`  
* `activeEvidenceIndex`  
* `activePremiumIndex`  
* controlled props  
* independent vs dependent state  
* swipe/peek handlers  
* locked feed attempt handlers  
8. Styling:  
* CSS modules  
* global CSS  
* modal styles  
* card styles  
* responsive/mobile rules  
* selectors that must not be randomly changed  
9. Config/deployment:  
* `package.json` scripts  
* Next.js config  
* Railway/OpenNext/Cloudflare files if present  
* environment variable usage  
* production route assumptions

ARCHITECTURE QUESTIONS TO ANSWER:

Answer all of these from current source, not memory:

1. What is the current root page rendered at `/`?  
2. Does `/` render the reconstruction page or a separate component?  
3. What is the canonical data model for landing cards?  
4. Where is `LandingPair` defined?  
5. Where are `marketSource` and `marketSources[]` defined and produced?  
6. Is `marketSources[]` currently consumed by UI or only produced by backend?  
7. Does `MarketSourceCarousel` currently receive a flat source list or per-active-pair evidence list?  
8. Does `MarketSourceCarousel` have independent active index/state?  
9. Does `PremiumEventCarousel` control active pair/state?  
10. Where is pass/paywall modal opened?  
11. What function handles locked feed attempts?  
12. Where are plan cards/prices/CTA text defined?  
13. Where does lead capture / premium reserve insert into Supabase?  
14. What is still hardcoded?  
15. What is generated from API/feed?  
16. What is fallback/static?  
17. What active files are risky to edit?  
18. What files appear legacy/dead/unused?  
19. What files are likely next-touch files for PREMVP12/13 continuation?  
20. What exact source snippets prove the current architecture?

REQUIRED OUTPUT FORMAT FROM WINDSURF:

Return a complete architecture map with these sections.

1. Precheck results:  
* branch  
* git status  
* last 8 commits  
* build result  
2. Top-level repo map:  
* folder/file  
* purpose  
* active / legacy / unknown  
3. Route map:  
* route  
* file path  
* purpose  
* active status  
4. Component map:  
* component  
* file path  
* props/state  
* role  
* touch risk  
5. Data/feed map:  
* model/function  
* file path  
* input/output  
* source-of-truth role  
* active status  
6. API/database map:  
* route/function  
* file path  
* method  
* DB table/fields touched  
* env vars used, without values  
7. Carousel/modal state map:  
* state variable/function  
* file path  
* owner component  
* data flow  
* risk  
8. Styling map:  
* CSS file  
* classes/selectors  
* affects what UI  
* risk  
9. Active vs legacy files:  
* active files  
* likely legacy files  
* uncertain files needing human confirmation  
10. Next-touch recommendation:  
* exact files likely needed for next phase  
* files to avoid  
* safest first change  
11. Evidence snippets:  
    For every major architecture claim, include short snippets:  
* file path  
* snippet  
* what it proves  
12. Stop conditions / uncertainty:  
    List anything you could not inspect or verify.

RESPONSE FORMAT REQUIRED:

* Do not say “done” unless all sections above are returned.  
* Do not edit files.  
* Do not create commits.  
* Do not push.  
* Do not deploy.  
* If build fails, still return architecture inspection results where possible.  
* If a folder/file does not exist, write `not present`.  
* If active vs legacy status is uncertain, write `unknown / needs human confirmation`.

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

## **4\. Result Paste Area**

After Windsurf returns the architecture map, paste the result under this section.

Use this format:

## **4\. Current Inspected Source Architecture**

Date:  
Branch:  
Commit:  
Build result:  
Inspector: Windsurf inspect-only

\[PASTE WINDSURF OUTPUT HERE\]

## **5\. Update Rules**

Update this file:

* after major merge  
* after feed architecture change  
* after modal/paywall change  
* after carousel/state change  
* after route/API change  
* after Supabase/database change  
* after significant CSS/layout restructuring  
* after introducing/removing major components  
* after changing `/` or `/reconstruction` routing  
* after adding/changing a debug endpoint  
* before starting a new ChatGPT Project if source changed  
* after a failed Windsurf attempt that suggests source and memory are out of sync

Do not update from memory only.

If source changed, run the inspect-only command again.

If the inspected source contradicts chat memory, the inspected source wins.

If a section is uncertain, mark it:

UNKNOWN / NEEDS VERIFICATION

## **6\. Hard Rules for Future LLMs**

Future LLMs must:

* check this file before writing Windsurf prompts  
* not assume file paths from memory  
* not assume current route/component wiring from old chats  
* not edit files marked legacy unless explicitly required  
* not touch high-risk files without narrow scope  
* not infer current architecture from old conversations if this file contradicts them  
* ask for fresh inspect-only if this file is stale  
* use current source snippets as proof for architecture claims  
* distinguish active files from fallback/static/legacy files  
* avoid broad refactor prompts when source ownership is unclear  
* confirm whether `/` and `/reconstruction` share implementation before UI changes  
* confirm whether `marketSources[]` is consumed by UI before changing MarketSourceCarousel  
* confirm whether API responses are cached before treating runtime output as fresh generation  
* confirm Supabase write paths before changing lead/reserve capture  
* confirm CSS selector ownership before changing visual layout  
* preserve stable production behavior unless a task explicitly changes it

Future LLMs must not:

* revive stale file assumptions from old chats  
* change DOM/classNames based on guessed structure  
* modify feed builders based only on memory  
* touch modal, carousel, or CSS files during backend-only tasks  
* assume Windsurf summaries are accurate without source/diff evidence  
* create new files or refactors without inspect-only support

## **7\. One-Paragraph Summary**

This file is the live source architecture map protocol for PolyProPicks / PolyPicks Current. It does not claim to know the current architecture from chat memory; it defines how to obtain the current architecture from the real repo using a strict Windsurf inspect-only pass. Future LLMs must refresh this map after major source changes, use it before writing implementation prompts, and treat inspected source files, snippets, Git state, build output, and runtime behavior as more reliable than old conversation context.

