# **07\_AI\_AGENT\_MIGRATION\_CONTEXT.md**

## **1\. Purpose**

This file exists to preserve operational continuity as PolyProPicks transitions from a Windsurf-only workflow into a safer multi-agent development workflow using ChatGPT, Claude, Codex, Windsurf, CMD/Git, and possibly other coding agents later.

The purpose is to:

* Preserve project context across AI tools.  
* Prevent tool-specific context drift.  
* Let Codex, Claude, Windsurf, and ChatGPT share one repo-level source of truth.  
* Reduce reliance on ChatGPT Saved Memory, which is full and must not be treated as current project truth.  
* Support a safe transition from Windsurf-only agentic development to a controlled multi-agent workflow.  
* Protect the current PolyProPicks architecture from broad refactors, accidental source corruption, stale assumptions, and payment/auth overbuild.  
* Make future coding agents inspect the actual repo state before editing.  
* Keep the founder/operator out of manual source editing. The founder is the operator, verifier, and final visual/business acceptor.

PolyProPicks is a mobile-first betting / prediction-market signal platform. It uses premium signal cards and market evidence cards. The current feed is display-grade deterministic signal generation, not guaranteed predictive ML. The system must preserve manual fallback/override paths while gradually adding API-assisted data and paid access.

## **2\. Source-of-Truth Hierarchy**

When sources conflict, agents must use this hierarchy:

1. Current source files in the repo.  
2. Git branch/status/log/diff/build output.  
3. Runtime API/browser/Supabase/Railway verification.  
4. `/docs/ai-context/*.md` files.  
5. Current user message.  
6. Recent accepted confirmations.  
7. Old chat history.  
8. Saved Memory.

Rules for conflict resolution:

* Current source files beat old chat summaries.  
* Git status, build output, and runtime API/browser verification beat AI summaries.  
* `/docs/ai-context/*.md` files are onboarding context, not proof that the repo currently matches that state.  
* If a context file says one thing and the repo says another, the repo wins.  
* If Git/build/API output contradicts an AI’s report, Git/build/API output wins.  
* If the current state is not verified, write `NEEDS VERIFICATION`.  
* Do not use Saved Memory as the source of truth for current implementation details.  
* Do not assume that old accepted plans were actually implemented unless verified in source, Git diff, build output, API output, browser behavior, Supabase, Railway, or production.

## **3\. AI Tool Roles**

### **ChatGPT**

Role:

* Architect.  
* Context engineer.  
* Prompt writer.  
* Reviewer.  
* Operator guide.  
* Product decision filter.  
* Workflow controller.

Should do:

* Read and compress project context.  
* Use `/docs/ai-context/` as the project source of truth.  
* Define the smallest safe next action.  
* Write exact prompts for Codex, Claude, Windsurf, or CMD.  
* Review tool outputs against source-of-truth constraints.  
* Convert messy logs into actionable next steps.  
* Challenge unsafe assumptions.  
* Protect product architecture and payment architecture.  
* Tell the founder exactly what to check, where to check it, and what output to paste back.

Should not do:

* Pretend current source state is known without verification.  
* Over-rely on old chat memory or Saved Memory.  
* Produce broad refactor prompts.  
* Ask Windsurf/Codex/Claude to “fix everything.”  
* Mix backend, UI, CSS, payment, auth, and deploy in one patch.  
* Treat build success as proof of business correctness.  
* Treat localStorage premium access as production entitlement.  
* Hide uncertainty. Unknown state must be marked `NEEDS VERIFICATION`.

### **Windsurf**

Role:

* Code executor.  
* Inspect-only source reader.  
* Narrow patch tool.  
* Local IDE/terminal assistant when stable.  
* Not the architect.

Should do:

* Exact replacements.  
* Small one/two-file patches.  
* Targeted inspection.  
* Build/diff reporting.  
* Browser preview checks when explicitly requested.  
* Run CMD/Git/npm commands when the operator delegates execution.  
* Follow exact allowed files and forbidden files.

Should not do:

* Make broad architecture decisions.  
* Perform repo-wide refactors.  
* Design payment/auth architecture.  
* Invent source paths.  
* Modify environment/secrets files.  
* Touch CSS/layout unless explicitly scoped.  
* Rewrite JSX/DOM structure for “cleanliness.”  
* Push/deploy without explicit approval.  
* Claim acceptance without build/API/browser/Git evidence.  
* Continue after a stop condition.

Current tooling note:

* Windsurf is currently used as code executor/inspector.  
* Windsurf Free/Cascade may have quota/model/provider limitations.  
* If Windsurf shows provider errors, permission errors, model limits, or unstable behavior, stop using it as an agent and use it only as an editor/terminal.

### **Codex**

Role:

* Coding agent.  
* Code reviewer.  
* Patch planner.  
* Repo-aware backend/API/payment/auth implementation assistant.

Useful for:

* Backend/API tasks.  
* Payment flow implementation.  
* Supabase schema review.  
* TypeScript build issues.  
* Source-level diff review.  
* Small and medium controlled patches.

Should do:

* Read `/docs/ai-context/` before planning.  
* Inspect Git state before editing.  
* Work from current source files, not old chat assumptions.  
* Propose narrow patches.  
* Explain exact files to change.  
* Preserve locked architecture decisions.  
* Review implementation risks before edits.  
* Run or request build/API verification.  
* Stop when source state is inconsistent.

Should not do:

* Rewrite architecture.  
* Ignore locked decisions.  
* Edit files before precheck.  
* Touch UI/CSS during backend-only tasks.  
* Push/deploy without explicit approval.  
* Modify `.env`, secrets, tokens, webhook secrets, API keys, or service role keys.  
* Introduce provider lock-in.  
* Force auth/registration before the payment/entitlement boundary is clear.  
* Treat provider customer ID as app user ID.

### **Claude**

Role:

* Architecture reviewer.  
* Second-opinion LLM.  
* Long-context critic.  
* Risk auditor.  
* Sequencing advisor.

Useful for:

* Auditing architecture readiness.  
* Evaluating Whop-first / Stripe-later payment sequence.  
* Reviewing auth/entitlement boundaries.  
* Critiquing implementation plans before code.  
* Identifying risk, missing contracts, and unsafe assumptions.  
* Producing decision gates.

Should do:

* Use uploaded/repo context files as source of truth.  
* Act as reviewer first, executor only if repo-connected and explicitly instructed.  
* Identify what must be verified before implementation.  
* Challenge broad or unsafe plans.  
* Produce narrow inspect-only prompts for Windsurf/Codex when needed.  
* Preserve LandingPair / PremiumEventCard / MarketSource architecture.

Should not do:

* Execute code directly unless repo-connected and explicitly instructed.  
* Invent file paths.  
* Propose full rebuilds.  
* Override locked decisions casually.  
* Recommend new stack unless asked.  
* Treat old memory/chat as more reliable than repo files.  
* Give implementation instructions without stating verification requirements.

### **CMD / Git**

Role:

* Objective verification.  
* Ground truth for branch, diff, build, and runtime checks.

Should do:

* `git branch --show-current`  
* `git status --short`  
* `git log --oneline -5`  
* `git diff --stat`  
* `git diff --check`  
* `npm run build`  
* `npm run dev`  
* `curl` / browser API endpoint checks.  
* Verify clean working tree before commit/push.  
* Verify intended files only.  
* Confirm runtime behavior locally and, when relevant, production/Railway/Supabase.

CMD/Git output beats AI summaries.

## **4\. Default Multi-Agent Workflow**

The standard workflow is:

1. ChatGPT reads `/docs/ai-context/`.  
2. CMD verifies Git state:  
   * `git branch --show-current`  
   * `git status --short`  
   * `git log --oneline -5`  
3. If the source map is stale or uncertain, Windsurf/Codex performs inspect-only.  
4. ChatGPT defines the smallest safe next action.  
5. Codex/Claude reviews if the task is architecture-sensitive.  
6. Windsurf/Codex executes a narrow patch.  
7. CMD/build/runtime verifies:  
   * `npm run build`  
   * `git diff --check`  
   * relevant API/browser/Supabase/Railway check  
8. Founder accepts visually/business-wise.  
9. Commit only intended files.  
10. Update `/docs/ai-context/` after meaningful state change.

Default patch size:

* One change zone per patch.  
* One to three files when possible.  
* Backend/API changes must not include UI/CSS unless explicitly scoped.  
* UI/card visual changes must not include payment/auth/backend rewrites.  
* Payment/auth changes must not redesign feed or card UI.

## **5\. Context Drift Prevention Rules**

Rules:

* Do not trust memory over files.  
* Do not trust old branch assumptions.  
* Do not infer current source paths from old chat.  
* Refresh source map if structure changed.  
* Use `NEEDS VERIFICATION` for unknowns.  
* Do not copy old rejected ideas into current plan.  
* Keep context updates delta-based.  
* Do not restate entire old documents into new context files.  
* Do not assume a prior patch was applied unless Git/source confirms it.  
* Do not assume production matches local unless production is checked.  
* Do not assume Supabase schema matches code unless verified.  
* Do not treat AI-generated reports as acceptance criteria without source/build/runtime evidence.  
* Do not mix old Windsurf summaries with current repo truth unless verified.

If an agent detects stale context:

1. Stop.  
2. State the mismatch.  
3. Identify exact files/commands needed for verification.  
4. Do not edit until the mismatch is resolved.

## **6\. Agent Safety Rules**

Hard rules:

* Inspect before edit when uncertain.  
* One change zone per patch.  
* No broad refactors.  
* No unrequested CSS/DOM changes.  
* No environment/secrets changes.  
* No payment provider lock-in.  
* No production deploy without approval.  
* No Git push without clean status/build verification.  
* No direct trust of provider checkout success on frontend.  
* No localStorage-only entitlement.  
* No full rewrite.  
* No new stack proposal unless explicitly asked.  
* No silent route changes.  
* No deletion of manual fallback/override.  
* No fake predictive ML claims.  
* No guaranteed profit language.  
* No fake institutional/smart-money claims unless verified by data source.  
* No provider customer ID as app user ID.  
* No forced registration before one free signal is visible.  
* No auth implementation before entitlement/payment boundary is clear.  
* No mutation of payment/session logic without acceptance tests or explicit verification steps.  
* No editing `.env`, `.env.local`, API keys, tokens, service role keys, webhook secrets, or passwords.  
* No push/deploy without explicit founder approval.

Stop conditions:

* Build fails and root cause is unclear.  
* Git status contains unexpected files.  
* Requested file path cannot be found.  
* Source contract conflicts with context documents.  
* Runtime API output contradicts expected shape.  
* Supabase/Railway/env state is required but not verified.  
* Agent output starts expanding beyond scoped files.  
* Agent proposes broad cleanup/refactor during a targeted fix.

## **7\. Provider-Neutral Payment Architecture For Agents**

Current payment direction:

* Whop first.  
* Stripe later.  
* Provider-neutral internal architecture.  
* Supabase entitlement is the source of truth.  
* UI must not directly trust Whop or Stripe.  
* Provider customer ID must not become app user ID.  
* Free signal should remain visible without forced login.  
* Registration/Auth must not be blindly added before entitlement/payment boundary is clear.

Target payment flow:

PassOfferModal  
→ /api/checkout/create  
→ provider checkout  
→ /api/webhooks/whop or /api/webhooks/stripe  
→ payment\_events  
→ user\_entitlements  
→ getPremiumAccess()  
→ unlocked premium feed

Correct normalized architecture:

payment provider checkout  
→ provider-specific webhook  
→ normalized payment\_events  
→ normalized user\_entitlements  
→ getPremiumAccess()  
→ UI unlock

Conceptual entities:

* `lead_intents`: captures anonymous user interest before checkout.  
* `checkout_sessions`: tracks checkout attempt and provider checkout session.  
* `payment_events`: normalized provider webhook events.  
* `user_entitlements`: source of truth for premium access.  
* `getPremiumAccess()`: internal access resolver used by UI/server routes.  
* Future account/user linking: anonymous lead → buyer → registered user.

What may be hardcoded for speed:

* Initial provider: Whop.  
* Initial plan IDs or offer IDs if stored in config and not secrets.  
* Initial pass names/prices for UI display, if matching provider setup.  
* Initial entitlement type such as `premium_feed`.  
* Initial unlock scope such as next 5 premium signals / premium feed access.  
* Minimal provider adapter interface if only Whop is active.

What must never be hardcoded:

* API keys.  
* Webhook secrets.  
* Service role keys.  
* Provider customer IDs as app user IDs.  
* Entitlement truth in frontend.  
* Premium access in localStorage as production logic.  
* Provider-specific fields as canonical business identity.  
* Whop-only entitlement model that prevents Stripe migration.  
* Stripe-only assumptions before Stripe phase.  
* Payment success from frontend redirect alone.  
* Claims of guaranteed results/profit.

Whop-first / Stripe-later rule:

* Whop integration may be implemented first for speed.  
* Internal database and entitlement logic must remain provider-neutral.  
* Stripe should be addable later by adding a provider adapter and webhook route, not by rewriting app access logic.

## **8\. Current Agent Onboarding Checklist**

Every new agent must first:

1. Read `/docs/ai-context/`:  
   * `/docs/ai-context/01_PROJECT_CONTEXT_CURRENT.md`  
   * `/docs/ai-context/02_CURRENT_TECH_STATE.md`  
   * `/docs/ai-context/03_CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
   * `/docs/ai-context/04_PRODUCT_DECISIONS_LOCKED.md`  
   * `/docs/ai-context/05_WINDSURF_WORKFLOW_RULES.md`  
   * `/docs/ai-context/06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`  
   * `/docs/ai-context/07_AI_AGENT_MIGRATION_CONTEXT.md`  
2. Run or request:  
   * `git branch --show-current`  
   * `git status --short`  
   * `git log --oneline -5`  
   * `npm run build` if implementation is planned  
3. Summarize:  
   * Current phase.  
   * Current branch/commit state.  
   * Dirty/clean state.  
   * Current risk.  
   * Exact next recommended action.  
4. Ask for missing verification if needed.  
5. Do not edit until accepted.

If the agent cannot access terminal/source files:

* Ask for the required file snippets or bundle.  
* Do not infer.  
* Mark unknowns as `NEEDS VERIFICATION`.

## **9\. First Codex Onboarding Prompt**

You are joining the PolyProPicks / PolyPicks Current repo as a coding agent, code reviewer, and patch planner.

Your first task is INSPECT-ONLY. Do not edit files yet.

Before doing anything:  
1\. Read all files under /docs/ai-context/:  
   \- 01\_PROJECT\_CONTEXT\_CURRENT.md  
   \- 02\_CURRENT\_TECH\_STATE.md  
   \- 03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md  
   \- 04\_PRODUCT\_DECISIONS\_LOCKED.md  
   \- 05\_WINDSURF\_WORKFLOW\_RULES.md  
   \- 06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md  
   \- 07\_AI\_AGENT\_MIGRATION\_CONTEXT.md  
2\. Run:  
   \- git branch \--show-current  
   \- git status \--short  
   \- git log \--oneline \-5  
3\. If implementation is likely, run:  
   \- npm run build

Project facts to preserve:  
\- PolyProPicks is a mobile-first betting / prediction-market signal platform.  
\- LandingPair is the canonical unit.  
\- PremiumEventCard is the master signal card.  
\- MarketSourceCard / MarketSourceCarousel is dependent evidence.  
\- marketSource backward compatibility must be preserved.  
\- marketSources\[\] evidence stack must remain compatible.  
\- Current feed is display-grade deterministic signal generation, not guaranteed predictive ML.  
\- Manual fallback/override must remain possible.  
\- Payment architecture is Whop first, Stripe later, provider-neutral internally.  
\- Supabase user\_entitlements is the source of truth for premium access.  
\- UI must not directly trust Whop/Stripe.  
\- Provider customer ID must not become app user ID.  
\- One free signal must remain visible without forced login.  
\- Do not add registration/Auth before entitlement/payment boundaries are clear.

Strict rules:  
\- Do not rewrite the architecture.  
\- Do not edit before precheck.  
\- Do not modify .env, secrets, API keys, service role keys, webhook secrets, or passwords.  
\- Do not push or deploy.  
\- Do not change UI/CSS unless explicitly scoped.  
\- Do not break LandingPair / PremiumEventCard / MarketSource evidence architecture.  
\- Do not introduce Whop-only or Stripe-only internal architecture.  
\- Do not treat localStorage as production entitlement.

Output only:  
1\. Current branch.  
2\. Last 5 commits.  
3\. Git dirty/clean state.  
4\. Build status if run.  
5\. Short architecture summary based on current repo \+ docs.  
6\. Current likely phase.  
7\. Exact current risk.  
8\. Exact next recommended action.  
9\. Files you would inspect next before editing.  
10\. Stop conditions.

Do not edit files in this first response.

## **10\. First Claude Onboarding Prompt**

You are joining PolyProPicks / PolyPicks Current as an architecture reviewer and second-opinion LLM, not as an executor.

Your role is to audit readiness, sequencing, and risk. Do not write implementation patches unless explicitly asked later.

Use the uploaded/repo context files as source of truth:  
\- /docs/ai-context/01\_PROJECT\_CONTEXT\_CURRENT.md  
\- /docs/ai-context/02\_CURRENT\_TECH\_STATE.md  
\- /docs/ai-context/03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md  
\- /docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md  
\- /docs/ai-context/05\_WINDSURF\_WORKFLOW\_RULES.md  
\- /docs/ai-context/06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md  
\- /docs/ai-context/07\_AI\_AGENT\_MIGRATION\_CONTEXT.md

Project facts:  
\- PolyProPicks is a mobile-first betting / prediction-market signal platform.  
\- LandingPair is canonical.  
\- PremiumEventCard is the master signal card.  
\- MarketSource evidence is dependent on the active PremiumEventCard.  
\- marketSource backward compatibility and marketSources\[\] evidence stack must remain compatible.  
\- Current feed is deterministic display-grade signal generation, not guaranteed predictive ML.  
\- Payment direction is Whop first, Stripe later, provider-neutral internal architecture.  
\- Supabase entitlement is the source of truth.  
\- UI must not trust provider checkout directly.  
\- Provider customer ID must not become app user ID.  
\- Free signal remains visible without forced login.

Audit these areas:  
1\. Readiness for Whop-first / Stripe-later payment architecture.  
2\. Whether Auth/registration should be introduced now or later.  
3\. Whether the current API/feed/evidence architecture is safe to extend.  
4\. Sequencing of:  
   \- feed/evidence stabilization  
   \- Whop checkout v0.1  
   \- entitlement tables  
   \- webhook  
   \- premium unlock  
   \- magic-link restore  
5\. Missing boundaries or dangerous coupling.  
6\. What must be verified before implementation.  
7\. What files/functions should Codex/Windsurf inspect before editing.

Do not:  
\- Propose a full rebuild.  
\- Propose a new stack.  
\- Override locked decisions casually.  
\- Invent file paths.  
\- Recommend provider-specific lock-in.  
\- Recommend forced login before one free signal.  
\- Recommend localStorage entitlement.

Output:  
1\. Architecture readiness verdict.  
2\. Highest-risk boundary.  
3\. Correct implementation sequence.  
4\. Decision gates before coding.  
5\. Files/areas that need inspect-only verification.  
6\. First safe Windsurf/Codex inspect-only prompt.  
7\. Stop conditions.  
8\. Clear recommendation: proceed / pause / verify first.

## **11\. Handoff Format Between Agents**

Every agent handoff must include:

Project:  
Current phase:  
Current branch:  
Last commit(s):  
Git status:  
Files touched:  
Build result:  
Runtime/API result:  
Browser result:  
Supabase result:  
Railway/production result:  
Unresolved risks:  
Known stop conditions:  
Exact next action:  
Files allowed for next action:  
Files forbidden for next action:  
Whether commit is allowed:  
Whether push/deploy is allowed:

Minimum required handoff after any implementation:

* Current branch.  
* `git status --short`  
* `git diff --stat`  
* `git diff --check`  
* `npm run build` result.  
* Files changed.  
* Whether changed files match scope.  
* Runtime/API/browser verification result.  
* Unresolved risks.  
* Next action.  
* Stop condition.

No handoff should say “done” unless build and required runtime checks were run or explicitly marked `NEEDS VERIFICATION`.

## **12\. What Must Be Updated After Work**

Update context docs after meaningful state changes:

* `02_CURRENT_TECH_STATE.md`  
  * After commits, verification, deployed changes, API behavior changes, build state changes.  
* `03_CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
  * After source architecture changes, new routes, new files, changed data flow, changed cache/feed/payment architecture.  
* `04_PRODUCT_DECISIONS_LOCKED.md`  
  * After product/payment/UX decisions become locked.  
* `05_WINDSURF_WORKFLOW_RULES.md`  
  * After workflow/tool changes involving Windsurf/Cascade/CMD/operator process.  
* `06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`  
  * After new process lessons, AI failures, recovery patterns, or best practices.  
* `08_ENVIRONMENT_AND_CONNECTORS.md`  
  * After connector/env/deploy/payment/provider changes.  
  * Do not include secrets.  
* `CONTEXT_DELTA_LOG.md`  
  * After important context changes, commits, decisions, migrations, or handoffs.

Rules:

* Keep updates delta-based.  
* Do not duplicate entire files.  
* Do not store secrets.  
* Include commit hash when available.  
* Include verification status.  
* Mark unverified items as `NEEDS VERIFICATION`.

## **13\. Final Operating Doctrine**

One repo context.  
Many agents.  
Source beats memory.  
Git/build/runtime beats AI summaries.  
Verify before edit.  
Inspect before patch.  
One change zone at a time.  
LandingPair stays canonical.  
PremiumEventCard remains master.  
MarketSource evidence remains dependent.  
Whop first, Stripe later, provider-neutral internally.  
Supabase entitlement is the access source of truth.  
No localStorage-only premium access.  
No provider lock-in.  
No broad refactors.  
No secret exposure.  
No push/deploy without approval.  
Clean Git before push.

