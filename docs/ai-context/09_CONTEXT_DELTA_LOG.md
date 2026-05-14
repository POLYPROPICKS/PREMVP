# **09\_CONTEXT\_DELTA\_LOG.md**

## **1\. Purpose**

This file tracks important context changes since the previous baseline context snapshot.

It does not replace the other context files. It is a delta log that helps ChatGPT, Codex, Claude, Windsurf, and future coding agents avoid stale context when continuing work on PolyProPicks / PolyPicks Current.

This file should be appended or updated after important project events, including:

* New commits.  
* Verification results.  
* Deployment changes.  
* Feed/API behavior changes.  
* Payment/auth architecture decisions.  
* AI-agent workflow changes.  
* Source architecture changes.  
* Tooling/environment changes.

The goal is to preserve only the latest meaningful deltas, not to rewrite full project history.

## **2\. Context Snapshot Baseline**

Baseline context date:

around 10.05.2026

Baseline files copied into the repo:

/docs/ai-context/01\_PROJECT\_CONTEXT\_CURRENT.md

/docs/ai-context/02\_CURRENT\_TECH\_STATE.md

/docs/ai-context/03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md

/docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md

/docs/ai-context/05\_WINDSURF\_WORKFLOW\_RULES.md

/docs/ai-context/06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md

Newer context files added after the original baseline:

/docs/ai-context/07\_AI\_AGENT\_MIGRATION\_CONTEXT.md

/docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md

/docs/ai-context/09\_CONTEXT\_DELTA\_LOG.md

Current context folder:

/docs/ai-context/

Known context-source facts:

* A new ChatGPT Project/folder named `PolyProPicks2` exists.  
* Six baseline source files were uploaded to ChatGPT Project Sources:  
  * `_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`  
  * `CURRENT_TECH_STATE.md`  
  * `PROJECT_CONTEXT_CURRENT.md`  
  * `WINDSURF_WORKFLOW_RULES.md`  
  * `PRODUCT_DECISIONS_LOCKED.md`  
  * `CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
* These files do not auto-update from chat.  
* They were copied into the repo as files `01`–`06`.  
* Two new files were created later:  
  * `07_AI_AGENT_MIGRATION_CONTEXT.md`  
  * `08_ENVIRONMENT_AND_CONNECTORS.md`  
* As of the latest directory listing, `/docs/ai-context/` contained 8 files totaling `212,802` bytes.  
* `09_CONTEXT_DELTA_LOG.md` is being created to record the latest delta.

If this file count or byte count is outdated, current repo output wins.

## **3\. Current Source-of-Truth Rule**

Source-of-truth priority:

1. Current repo source files.  
2. Git branch/status/log/diff/build output.  
3. Runtime API/browser/Supabase/Railway verification.  
4. `/docs/ai-context/*.md`.  
5. Current user message.  
6. Recent accepted confirmations.  
7. Old chat history.  
8. Saved Memory.

Rules:

* Repo source files \+ Git/runtime output beat old context.  
* `/docs/ai-context/` beats Saved Memory.  
* ChatGPT Saved Memory is full.  
* Saved Memory is not project source of truth.  
* ChatGPT Project Sources must be refreshed manually after context files change.  
* If a source of truth conflicts with another source, use the hierarchy above.  
* If current state is uncertain, write `NEEDS VERIFICATION`.

## **4\. Latest Context Delta Summary**

Latest known deltas after the baseline context snapshot:

* `PolyProPicks2` ChatGPT Project/folder was created.  
* Six baseline context files were copied into the repo under `/docs/ai-context/`.  
* `07_AI_AGENT_MIGRATION_CONTEXT.md` was added to support safe migration from Windsurf-only workflow to multi-agent workflow.  
* `08_ENVIRONMENT_AND_CONNECTORS.md` was added to preserve environment, Git, Supabase, Railway, API, connector, and secret-handling context.  
* `09_CONTEXT_DELTA_LOG.md` is being created as the latest delta tracker.  
* ChatGPT Saved Memory is full and must not be used as project source of truth.  
* `/docs/ai-context/` should become the shared source context for ChatGPT, Codex, Claude, Windsurf, and future agents.  
* AI-agent role split was clarified:  
  * ChatGPT: architect, context engineer, reviewer, operator guide.  
  * Windsurf: narrow patch executor / inspect-only source reader.  
  * Codex: repo-aware code reviewer / patch planner / coding agent.  
  * Claude: architecture reviewer / second-opinion LLM.  
  * CMD/Git: objective verification.  
* Payment direction was clarified:  
  * Whop first.  
  * Stripe later.  
  * Provider-neutral internal architecture.  
  * Supabase entitlement source of truth.  
* PREMVP15 broad Sports Discovery \+ Feed Pipeline Refactor remains a later/large phase.  
* Current narrow work included a safe sports/futures filtering commit:  
  * `2875d89 Tighten sports futures and relegation market filtering`  
* Cached `/api/feed/landing-cards` verification showed contract-level sanity.  
* Fresh-generation verification is still pending:  
  * `NEEDS VERIFICATION`

## **5\. Latest Git State Known**

Latest known commit facts:

2875d89 Tighten sports futures and relegation market filtering

43677cf Merge Polymarket API mapping fix

ea3b145 Fix Polymarket API mapping and add fresh evidence debug endpoint

b742de8 Merge PREMVP12 evidence generation

95736fc Generate PREMVP12 evidence stack cards

Recent log observed:

2875d89 (HEAD \-\> main) Tighten sports futures and relegation market filtering

43677cf (origin/main) Merge Polymarket API mapping fix

ea3b145 (premvp12-fresh-generation-debug) Fix Polymarket API mapping and add fresh evidence debug endpoint

b742de8 Merge PREMVP12 evidence generation

95736fc (premvp12-evidence-generation) Generate PREMVP12 evidence stack cards

Known state:

* Local commit created:  
  * `2875d89 Tighten sports futures and relegation market filtering`  
* Previous origin/main:  
  * `43677cf Merge Polymarket API mapping fix`  
* Local `main` is/was ahead of `origin/main` by one commit after `2875d89`.  
* Push was not approved yet after `2875d89` until fresh verification.  
* Exact latest clean/dirty state must be verified with:

git status \--short

Current status:

NEEDS VERIFICATION

Important caveat:

* Later local commits may exist after this snapshot.  
* Current Git output beats this log.

## **6\. Latest Runtime Verification State**

Cached endpoint checked:

/api/feed/landing-cards?limit=5\&category=sports\&minDataCoverage=40\&excludeEnded=true

Cached result included:

cacheStatus: "hit"

formulaVersion: "trusted-initial-formula-v1.1"

pairsGenerated: 5

marketSource present

marketSources\[\] present

normal game markets present

no obvious futures/outrights in cached response

Limitation:

* `cacheStatus: "hit"` means this did not prove fresh-generation filtering.  
* Cached response sanity is useful but not sufficient.  
* Fresh generation must be checked with debug/cache-bypass route.

Debug endpoints discovered:

/api/feed/debug-evidence-generation

/api/feed/debug-sports-cards

/api/feed/debug-sports-discovery

/api/feed/landing-cards

`debug-evidence-generation` contains:

debug: "fresh-evidence-generation"

cacheBypassed: true

Fresh-generation verification status:

NEEDS VERIFICATION

## **7\. Payment/Auth/API Architecture Delta**

Payment architecture clarified:

* Whop first.  
* Stripe later.  
* Provider-neutral internal payment architecture required.  
* Internal Supabase entitlement must be source of truth.  
* UI must not directly trust Whop or Stripe.  
* Provider customer ID must not become app user ID.  
* LocalStorage-only premium access is not acceptable for production.  
* Free signal must remain visible without forced login.  
* Registration/auth should not be blindly implemented before entitlement/payment boundary is clear.  
* Future new API provider should be adapter-based.  
* Future provider-specific API shapes must not leak directly into UI.

Correct access direction:

payment provider checkout

→ provider-specific webhook

→ normalized payment\_events

→ normalized user\_entitlements

→ getPremiumAccess()

→ UI unlock

Payment/auth implementation remains:

NEEDS VERIFICATION

## **8\. AI Tooling / Migration Delta**

Current tool migration facts:

* User is considering moving from Windsurf toward Codex and/or Claude.  
* Windsurf remains useful as:  
  * narrow patch executor  
  * inspect-only source reader  
  * local IDE/terminal assistant  
* Windsurf should not act as architect.  
* ChatGPT remains:  
  * architect  
  * context engineer  
  * operator guide  
  * prompt writer  
  * reviewer  
* Codex may be introduced as:  
  * repo-aware coding agent  
  * code reviewer  
  * patch planner  
  * backend/API/payment implementation assistant  
* Claude may be introduced as:  
  * architecture reviewer  
  * second-opinion LLM  
  * long-context critic  
* `/docs/ai-context/` is the shared context package for all future agents.  
* Future agents must not rewrite architecture.  
* Future agents must not treat old Saved Memory as source of truth.

Tooling caveats:

* Current Windsurf Free/Cascade setup appears limited to free SWE models.  
* Premium Windsurf models require Pro.  
* ChatGPT Plus is not an API key for Windsurf/Cursor.  
* Codex may be used via ChatGPT Plus depending on current OpenAI Codex availability/account.  
* Actual Codex/Claude availability and limits:  
  * `NEEDS VERIFICATION`

## **9\. Lessons From Latest Work**

Latest operational lessons:

* Build pass is not enough.  
* Cached response is not fresh-generation verification.  
* Debug/cache-bypass endpoint matters.  
* Always check Git status before push.  
* Remove junk untracked files immediately.  
* Reject broad unscoped logic.  
* Do not mix a narrow filtering patch with a broad game-gate refactor.  
* Verify source cleanliness after accidental CMD commands.  
* Do not rely on AI summaries without Git/build/runtime output.  
* Do not push while fresh-generation verification is pending.  
* Do not let an agent modify files before precheck.  
* Do not let an agent continue if unexpected dirty files appear.  
* Do not use broad prompts like “fix feed” or “clean everything.”  
* Treat `/api/feed/landing-cards` cache hit as a separate state from fresh generation.  
* Inspect-only mode must be used when the source path or runtime behavior is uncertain.

Accidental dirty-state lesson:

* Accidental untracked junk files appeared during CMD work:  
  * `tatus --short`  
  * `0`  
  * `regex.test(normalizedText))`  
* Accidental post-commit source changes were detected in:  
  * `lib/feed/buildLandingCards.ts`  
* The broad accidental positive game-market gate was rejected as too broad.  
* It was rolled back with:

git restore lib/feed/buildLandingCards.ts

* Junk files were deleted.  
* Clean state was confirmed afterward.  
* Before any push, run:

git status \--short

Current cleanliness:

NEEDS VERIFICATION

## **10\. Current Immediate Next Action**

Immediate next action: run fresh-generation verification before deciding whether to push or patch.

Run from CMD:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1

git status \--short

git log \--oneline \-5

curl "http://localhost:3000/api/feed/debug-evidence-generation?limit=10" \> premvp15-debug-evidence-check.json

node \-e "const fs=require('fs');const p='premvp15-debug-evidence-check.json';const raw=fs.readFileSync(p,'utf8');console.log('bytes',raw.length);try{const d=JSON.parse(raw);console.log(JSON.stringify({debug:d.debug,cacheBypassed:d.cacheBypassed,formulaVersion:d.formulaVersion,pairCount:d.pairs?.length,rejectedCount:d.rejected?.length,firstPairIds:d.pairs?.slice(0,10).map(x=\>x.id),firstTitles:d.pairs?.slice(0,10).map(x=\>x.premiumSignal?.eventTitle),firstRejected:d.rejected?.slice(0,10)},null,2));}catch(e){console.log(raw.slice(0,1000));}"

git status \--short

Paste back:

1\. First git status \--short output.

2\. git log \--oneline \-5 output.

3\. node summary output:

   \- debug

   \- cacheBypassed

   \- formulaVersion

   \- pairCount

   \- rejectedCount

   \- firstPairIds

   \- firstTitles

   \- firstRejected

4\. Final git status \--short output.

Decision after output:

If fresh-generation check passes:

  decide whether to push 2875d89.

If fresh-generation check fails:

  hold push and patch.

If Git status becomes dirty unexpectedly:

  stop and inspect.

No push until this decision is made.

## **11\. Stop Conditions**

Stop immediately if:

* `git status --short` is dirty unexpectedly.  
* Build fails.  
* Debug endpoint returns non-JSON.  
* `pairCount = 0` without explanation.  
* Futures/outrights appear in fresh output.  
* Unexpected source changes appear.  
* Codex/Claude proposes broad rewrite.  
* An agent attempts env/secrets changes.  
* An agent edits UI/CSS during backend-only work.  
* An agent edits backend/feed/payment during docs-only work.  
* An agent asks to commit/push without clean verification.  
* An agent suggests localStorage-only entitlement.  
* An agent suggests provider-specific payment lock-in.  
* An agent suggests forcing registration before one free signal is visible.

If any stop condition happens:

1. Do not push.  
2. Do not continue patching.  
3. Record the exact output.  
4. Ask for targeted recovery plan.

## **12\. Files To Update Later**

After fresh-generation check and push/no-push decision, update:

/docs/ai-context/02\_CURRENT\_TECH\_STATE.md

/docs/ai-context/09\_CONTEXT\_DELTA\_LOG.md

After payment/auth architecture audit, update:

/docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md

/docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md

/docs/ai-context/07\_AI\_AGENT\_MIGRATION\_CONTEXT.md

Update `07_AI_AGENT_MIGRATION_CONTEXT.md` only if tool workflow changes.

After source architecture changes, update:

/docs/ai-context/03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md

After new process lessons, update:

/docs/ai-context/06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md

After environment/connector/deploy changes, update:

/docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md

Rules:

* Keep updates delta-based.  
* Do not duplicate full existing context.  
* Include commit hash when available.  
* Include verification status.  
* Mark unverified items as `NEEDS VERIFICATION`.  
* Do not include secrets.

## **13\. Final Delta Handoff Summary**

PolyProPicks has moved from the original 10.05.2026 baseline context into a multi-agent migration phase. Six baseline context files were copied into `/docs/ai-context/`, and new files `07_AI_AGENT_MIGRATION_CONTEXT.md` and `08_ENVIRONMENT_AND_CONNECTORS.md` were added to support Codex/Claude migration and connector safety. Payment direction is now Whop first, Stripe later, with provider-neutral Supabase entitlement as source of truth. A narrow PREMVP15 filtering commit `2875d89 Tighten sports futures and relegation market filtering` exists locally, with previous origin/main at `43677cf`; push is not approved until fresh-generation verification is complete. Cached `/api/feed/landing-cards` looked sane, but cache hit does not prove fresh generation. The immediate next action is to run `/api/feed/debug-evidence-generation?limit=10`, parse pair/rejected output, verify Git status, then decide whether to push or hold and patch.

