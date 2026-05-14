# **12\_AGENT\_STARTUP\_PROTOCOL.md**

## **1\. Purpose**

This file defines the mandatory startup protocol every AI agent must follow before doing any work on the PolyProPicks / PolyPicks Current repository.

It exists to prevent:

* Stale-context mistakes.  
* Wrong branch edits.  
* Dirty working tree corruption.  
* Broad refactors.  
* Frontend/design regressions.  
* Payment provider lock-in.  
* Supabase/Railway/env mistakes.  
* Accidental source edits before verification.  
* Agents relying only on Git without reading project context.  
* Agents relying on ChatGPT Saved Memory.  
* Agents pushing/deploying without approval.

This protocol is mandatory before implementation.

It complements all files under:

/docs/ai-context/

External Git/GitHub access is useful but not sufficient. Git can show source files, commits, branches, and diffs, but it does not show locked product decisions, rejected approaches, frontend preservation rules, payment architecture constraints, or latest verification caveats. Every agent must read `/docs/ai-context/` before proposing or making changes.

## **2\. Applies To**

This protocol applies to:

* ChatGPT  
* OpenAI Codex  
* Claude  
* Claude Code  
* Windsurf  
* Cursor  
* Future coding agents  
* Human founder/operator

Every agent must follow the same startup gate before code changes.

The founder is the operator and final acceptor, not a manual multi-file code editor. Agents should reduce operator burden, not create more manual editing work.

## **3\. Why Git Alone Is Not Enough**

Git gives:

* Current source tree.  
* Commits.  
* Diffs.  
* Branches.  
* Tracked/untracked file state.  
* Recent implementation history.

Git does not give:

* Locked product decisions.  
* Rejected paths.  
* Founder/operator workflow.  
* Payment architecture constraints.  
* Frontend/design preservation rules.  
* Context from Supabase/Railway/Whop/Stripe planning.  
* Latest verification caveats.  
* Which previous ideas were postponed or rejected.  
* Which AI-agent workflows caused source corruption.  
* Which UI behaviors are product-critical.  
* Which connector/env details must not be touched.  
* Which cached API responses did or did not prove fresh generation.

Conclusion:

Every agent must read both:

1. Repo source.  
2. `/docs/ai-context/`.

Agents that only inspect GitHub/source files will miss critical product, workflow, and architecture constraints.

## **4\. Required Context Files To Read First**

Every agent must read or request the relevant files under `/docs/ai-context/` before planning implementation.

### **`/docs/ai-context/01_PROJECT_CONTEXT_CURRENT.md`**

Purpose:

* Overall project context.  
* Current product/business direction.  
* Current roadmap and strategic constraints.

When to update:

* After major phase changes.  
* After roadmap changes.  
* After product direction changes.

Why agents must read it:

* It explains what PolyProPicks is and why current work matters.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/02_CURRENT_TECH_STATE.md`**

Purpose:

* Latest technical state.  
* Current implementation status.  
* Verified build/API/deploy notes.

When to update:

* After commits.  
* After successful build/API verification.  
* After deploy verification.  
* After source/runtime state changes.

Why agents must read it:

* It prevents agents from assuming old technical state.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/03_CURRENT_SOURCE_ARCHITECTURE_MAP.md`**

Purpose:

* Source architecture map.  
* Route/component/data-flow overview.  
* Important source files and dependencies.

When to update:

* After route changes.  
* After new backend/feed/payment files.  
* After source architecture changes.

Why agents must read it:

* It helps agents avoid editing the wrong files or inventing paths.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/04_PRODUCT_DECISIONS_LOCKED.md`**

Purpose:

* Locked product decisions.  
* Payment/CTA/feed/design/product constraints.

When to update:

* After product/payment/pricing/CTA decisions become locked.

Why agents must read it:

* It prevents agents from overriding product decisions casually.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/05_WINDSURF_WORKFLOW_RULES.md`**

Purpose:

* Windsurf-specific execution rules.  
* Prompting rules.  
* Operator workflow constraints.  
* AI patch safety constraints.

When to update:

* After workflow/tooling changes.  
* After Windsurf/Cascade lessons.  
* After new execution rules.

Why agents must read it:

* It explains why broad agent prompts and uncontrolled patches are forbidden.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/06_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`**

Purpose:

* Lessons from previous PreMVP iterations.  
* Operator best practices.  
* Known failure modes.  
* Recovery patterns.

When to update:

* After important AI/tool/source failures.  
* After new process lessons.  
* After best-practice changes.

Why agents must read it:

* It prevents repeated mistakes and source corruption.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/07_AI_AGENT_MIGRATION_CONTEXT.md`**

Purpose:

* Multi-agent migration context.  
* Roles of ChatGPT, Codex, Claude, Windsurf, CMD/Git.  
* Rules for safe agent handoff.

When to update:

* After tool workflow changes.  
* After Codex/Claude/Windsurf usage changes.  
* After agent role decisions change.

Why agents must read it:

* It defines how different AI agents should collaborate safely.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/08_ENVIRONMENT_AND_CONNECTORS.md`**

Purpose:

* Environment/connectors context.  
* Git, Supabase, Railway, API routes, env var names, external services.  
* Secret-handling rules.

When to update:

* After Supabase/Railway/payment/env/deploy changes.  
* After connector changes.  
* After new env var names are introduced.

Why agents must read it:

* It prevents secret exposure and connector misconfiguration.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/09_CONTEXT_DELTA_LOG.md`**

Purpose:

* Latest context delta log.  
* Changes since baseline context snapshot.  
* Latest verification and pending verification.

When to update:

* After important commits.  
* After verification decisions.  
* After major context/tooling/product changes.

Why agents must read it:

* It shows what changed after older baseline docs.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md`**

Purpose:

* Frontend/design baseline.  
* UI preservation rules.  
* Component roles.  
* Visual acceptance requirements.

When to update:

* After accepted frontend/design baseline changes.  
* After major card/modal/carousel changes.

Why agents must read it:

* It prevents UI regressions and casual redesign.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/11_SOURCE_FILES_AND_REPO_INVENTORY.md`**

Purpose:

* Current source file inventory.  
* Active/legacy/uncertain file mapping.  
* High-risk file list.  
* Likely files for next phases.

When to update:

* After major source changes.  
* After new routes/files/components.  
* After payment/auth/provider additions.

Why agents must read it:

* It prevents path invention and stale source assumptions.

Status:

NEEDS VERIFICATION

### **`/docs/ai-context/12_AGENT_STARTUP_PROTOCOL.md`**

Purpose:

* This mandatory startup protocol.  
* Defines precheck, classification, approval, and stop conditions.

When to update:

* After agent startup workflow changes.  
* After new multi-agent rules.  
* After new safety gates.

Why agents must read it:

* It tells agents exactly how to start safely.

Status:

NEEDS VERIFICATION

## **5\. First 5 Minutes Protocol**

Every new agent must do this before editing:

1. Read `/docs/ai-context/`.  
2. Identify current task type.  
3. Verify current Git state.  
4. Verify whether source inventory is fresh.  
5. Identify locked decisions relevant to the task.  
6. Identify high-risk files.  
7. Decide whether the task is:  
   * inspect-only  
   * exact patch  
   * architecture review  
   * frontend/UI change  
   * backend/API change  
   * payment/auth change  
   * env/deploy change  
   * docs/context update  
8. Ask for missing verification.  
9. Produce first operational summary.  
10. Wait for approval before edits if task is risky.

The first response must not jump directly into implementation unless the user explicitly provided verified source state, exact file, exact change, and acceptance criteria.

If the agent cannot access the repo directly, it must request:

* Git status.  
* Recent commits.  
* Relevant source file snippets.  
* Relevant runtime/API output.  
* Relevant build output.

## **6\. Required Git Precheck**

Before implementation, run or request:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--stat

Interpretation rules:

* `git status --short` must be clean or fully understood.  
* Dirty files must be listed before edits.  
* Untracked junk files must be removed or explained.  
* Branch must be confirmed.  
* Push status must be known.  
* If the repo has untracked docs only and the task is docs-only, state that explicitly.  
* If the repo has source dirty files and the task is not about those files, stop and ask for verification.  
* Do not edit source when dirty state is unexplained.  
* Do not commit or push without explicit approval.

## **7\. Optional Build / Runtime Precheck**

When implementation is planned, run or request:

npm run build

For API/feed work, run relevant curl checks.

Known examples:

curl "http://localhost:3000/api/feed/landing-cards?limit=5\&category=sports\&minDataCoverage=40\&excludeEnded=true"  
curl "http://localhost:3000/api/feed/debug-evidence-generation?limit=10"

Runtime rules:

* Cached endpoint is not fresh-generation proof.  
* `cacheStatus: hit` proves current cached contract only.  
* Debug/cache-bypass endpoint is needed for fresh generation.  
* Local check is not production verification.  
* Production verification is separate from local verification.  
* Build success is not UI acceptance.  
* API HTTP 200 is not enough; response shape must match expected contract.

For feed work, inspect:

* `cacheStatus`  
* `cacheBypassed`  
* `formulaVersion`  
* `pairs.length`  
* `rejected.length`  
* `premiumSignal`  
* `marketSource`  
* `marketSources[]`  
* `marketSources[].type`  
* diagnostics fields relevant to the task

## **8\. Task Classification**

Every agent must classify the task before acting.

### **Inspect-only**

Use when:

* Source state unclear.  
* Architecture unclear.  
* New agent onboarding.  
* Dirty Git state.  
* Payment/auth/API boundary unknown.  
* File path uncertain.  
* User asks for diagnosis.  
* Multiple agents gave conflicting opinions.  
* Runtime/API behavior contradicts expectation.

Allowed:

* Read files.  
* Run Git/status/build/API checks if authorized.  
* Summarize findings.  
* Identify next safe action.

Not allowed:

* Source edits.  
* Commits.  
* Push/deploy.

### **Exact patch**

Use when:

* File path known.  
* Old/new block known.  
* Scope is one small change.  
* Acceptance criteria clear.  
* Dirty state is clean or fully understood.  
* The change does not cross subsystem boundaries.

Required:

* Allowed files.  
* Forbidden files.  
* Build check.  
* Diff check.  
* Runtime/UI check if relevant.

### **Architecture review**

Use when:

* Whop/Stripe/Auth/API sequence is being designed.  
* Provider-neutrality must be checked.  
* Multiple subsystems involved.  
* Payment/security/entitlement boundaries are unclear.  
* A decision may lock future architecture.

Output should be review, risks, gates, and next safe inspect/patch prompt, not broad code edits.

### **Frontend/UI change**

Use when:

* Card/modal/carousel/CSS involved.  
* Visual acceptance required.  
* Screenshot/browser check required.  
* CTA/copy/pricing/locked feed behavior may be affected.

Required:

* Read `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md`.  
* Identify affected component.  
* Identify CSS file.  
* Preserve DOM/classNames/wrappers unless approved.  
* Run build.  
* Browser/screenshot check.  
* Founder visual acceptance.

### **Backend/API change**

Use when:

* Feed route touched.  
* Polymarket/provider adapter touched.  
* Cache touched.  
* Debug endpoint touched.  
* Server route touched.  
* Formula/data contract touched.

Required:

* Preserve `LandingPair`.  
* Preserve `marketSource`.  
* Preserve `marketSources[]`.  
* Preserve manual fallback.  
* Distinguish cached vs fresh generation.  
* Run build and runtime curl check.

### **Payment/Auth change**

Use when:

* Checkout.  
* Webhook.  
* Entitlement.  
* Supabase Auth.  
* Lead-to-user linking.  
* Premium access logic.  
* Session/cookie logic.

Required:

* Preserve provider-neutral architecture.  
* Whop first, Stripe later.  
* Internal Supabase entitlement source of truth.  
* No frontend trust of provider checkout success.  
* No localStorage-only premium access.

### **Env/Deploy change**

Use when:

* Railway.  
* `.env`.  
* Supabase config.  
* Production domain.  
* Webhook secrets.  
* Provider keys.  
* Deployment settings.

Required:

* Read `08_ENVIRONMENT_AND_CONNECTORS.md`.  
* Do not print secrets.  
* Do not commit env files.  
* Verify with safe dashboard/CLI output only.

### **Docs/context update**

Use when:

* `/docs/ai-context/` files change.  
* Migration state changes.  
* Decisions change.  
* Verification state changes.

Required:

* Do not touch source files unless explicitly scoped.  
* Keep updates delta-based.  
* Mark unknowns as `NEEDS VERIFICATION`.

## **9\. Allowed Without Explicit Approval**

Agents may:

* Read files.  
* Inspect repo structure.  
* Run/report Git status/log/diff if locally authorized.  
* Summarize context.  
* Propose plan.  
* Write Windsurf/Codex/Claude prompts.  
* Identify risks.  
* Draft patches without applying.  
* Ask for verification.  
* Update docs only if explicitly asked.  
* Generate checklists.  
* Explain stop conditions.  
* Review pasted logs.  
* Compare output against acceptance criteria.

## **10\. Forbidden Without Explicit Approval**

Agents must not:

* Edit source code.  
* Commit.  
* Push.  
* Deploy.  
* Change env files.  
* Print secrets.  
* Alter Supabase/Railway config.  
* Run destructive DB commands.  
* Add payment provider config.  
* Change auth behavior.  
* Rewrite UI.  
* Refactor architecture.  
* Rename components/classes.  
* Change DOM nesting.  
* Alter CTA/pricing/copy.  
* Remove fallback/manual content.  
* Modify premium access logic.  
* Hardcode provider-specific access in UI.  
* Change payment provider architecture.  
* Make Whop or Stripe internal access source of truth.  
* Use localStorage as production entitlement.  
* Force registration before free signal visibility.  
* Touch UI/CSS during backend-only task.  
* Touch backend/payment during visual-only task.  
* Push/deploy after only AI summary without verification.

## **11\. Frontend Protection Protocol**

Before any UI work:

1. Read `10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md`.  
2. Identify affected component.  
3. Identify CSS file.  
4. Identify active selector/className.  
5. Preserve DOM/classNames/wrapper structure unless explicitly approved.  
6. Run build.  
7. Require browser/screenshot visual check.  
8. Founder performs final visual acceptance.

Build passing is not visual acceptance.

High-risk frontend areas:

* PremiumEventCard  
* MarketSourceCard  
* MarketSourceCarousel  
* PremiumEventCarousel  
* PassOfferModal  
* Reconstruction/landing page  
* CSS modules  
* Global CSS

Rules:

* Do not redesign casually.  
* Do not add a new design system library.  
* Do not rename classes or restructure DOM unless explicitly scoped.  
* Do not change locked feed behavior during visual tweaks.  
* Do not change CTA/pricing/copy unless explicitly scoped.  
* Do not make evidence carousel independent from active PremiumEventCard.  
* Do not make UI changes during backend/payment tasks.

## **12\. Backend/API Protection Protocol**

Before backend/API work:

1. Read current tech state.  
2. Inspect relevant route/builder/cache file.  
3. Identify whether endpoint is cached.  
4. Preserve `LandingPair` shape.  
5. Preserve `marketSource` compatibility.  
6. Preserve `marketSources[]`.  
7. Preserve fallback/manual content.  
8. Run build.  
9. Run runtime curl check.  
10. Distinguish fresh vs cached output.

Known risk:

* PREMVP15 feed filtering work must not accidentally become broad feed refactor.

Backend/API agents must not:

* Change UI/CSS.  
* Remove fallback content.  
* Break manual override.  
* Conflate cache hit with fresh generation.  
* Change external provider mapping without proving endpoint/ID contract.  
* Add fake evidence data to satisfy UI.

## **13\. Payment/Auth Protection Protocol**

Before payment/auth work:

1. Read `04_PRODUCT_DECISIONS_LOCKED.md`.  
2. Read `08_ENVIRONMENT_AND_CONNECTORS.md`.  
3. Preserve Whop-first / Stripe-later provider-neutral architecture.  
4. Do not create Whop-only architecture.  
5. Do not create Stripe-only architecture.  
6. Do not make provider customer ID app user ID.  
7. Do not trust frontend checkout success.  
8. Do not store premium access only in localStorage.  
9. Do not block free signal with login.

Target flow:

PassOfferModal  
→ /api/checkout/create  
→ Whop/Stripe checkout  
→ provider webhook  
→ payment\_events  
→ user\_entitlements  
→ getPremiumAccess()  
→ premium feed unlocked

Payment/auth agents must preserve:

* Provider-neutral internal model.  
* Supabase entitlement as source of truth.  
* Future Stripe compatibility after Whop.  
* Anonymous lead → buyer → registered user linking path.  
* Free signal visibility before forced login.

## **14\. Environment / Connector Protection Protocol**

Before env/connector work:

1. Read `08_ENVIRONMENT_AND_CONNECTORS.md`.  
2. Never print secrets.  
3. Never commit `.env.local`.  
4. Never change Railway/Supabase/Whop/Stripe config without approval.  
5. List env var names only.  
6. Verify connector state with safe commands or dashboard checks.  
7. Paste only non-secret results.

Important connectors:

* Git/GitHub  
* Supabase  
* Railway  
* Polymarket/public APIs  
* Whop planned  
* Stripe planned  
* ChatGPT/Codex/Claude context files

Agents must not:

* Paste API keys.  
* Paste service role keys.  
* Paste webhook secrets.  
* Paste Railway tokens.  
* Change production env vars without explicit approval.  
* Run destructive SQL without explicit approval.  
* Assume local env matches production env.

## **15\. Required First Response From Any New Agent**

Every new agent’s first response should include:

* Files/context read.  
* Current assumed phase.  
* Git state known/unknown.  
* Dirty/clean status known/unknown.  
* Current task classification.  
* Locked decisions relevant to task.  
* High-risk files/areas.  
* Missing verification.  
* Recommended next action.  
* Stop condition.

If the agent cannot access repo directly, it must request:

* `git status --short`  
* `git log --oneline -5`  
* Relevant files.  
* Relevant runtime output.  
* Relevant build output.

The first response must not claim implementation readiness if context or Git state is unknown.

## **16\. Handoff Back To Founder**

After any action, agent must report:

* What was inspected.  
* What changed.  
* Files changed.  
* Old/new snippets if code changed.  
* Build result.  
* Git status.  
* Runtime/API/browser verification.  
* Unresolved risks.  
* Next action.  
* Exact output founder should paste back.

If code changed, report must include:

Files changed:  
Exact changed snippets:  
Verification run:  
Acceptance criteria:  
Risks:  
Stop conditions:

If nothing changed, report must say:

No files edited.  
No commit.  
No push.  
No deploy.

## **17\. Handoff Between Agents**

When passing work from ChatGPT to Codex/Claude/Windsurf or back, include:

* Branch.  
* Latest commit.  
* Git status.  
* Files touched.  
* Verification completed.  
* Verification pending.  
* Accepted decisions.  
* Forbidden changes.  
* Next exact task.  
* Stop condition.

Minimum handoff format:

Project:  
Current phase:  
Branch:  
Latest commit:  
Git status:  
Files changed:  
Build result:  
Runtime/API result:  
Browser/UI result:  
Supabase/Railway result:  
Accepted decisions:  
Forbidden changes:  
Open risks:  
Next exact task:  
Stop condition:

## **18\. Startup Prompt For Codex**

You are onboarding into the PolyProPicks / PolyPicks Current repo as a repo-aware coding agent, code reviewer, and patch planner.

Before editing anything, read /docs/ai-context/:

\- 01\_PROJECT\_CONTEXT\_CURRENT.md  
\- 02\_CURRENT\_TECH\_STATE.md  
\- 03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md  
\- 04\_PRODUCT\_DECISIONS\_LOCKED.md  
\- 05\_WINDSURF\_WORKFLOW\_RULES.md  
\- 06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md  
\- 07\_AI\_AGENT\_MIGRATION\_CONTEXT.md  
\- 08\_ENVIRONMENT\_AND\_CONNECTORS.md  
\- 09\_CONTEXT\_DELTA\_LOG.md  
\- 10\_DESIGN\_SYSTEM\_AND\_FRONTEND\_BASELINE.md  
\- 11\_SOURCE\_FILES\_AND\_REPO\_INVENTORY.md  
\- 12\_AGENT\_STARTUP\_PROTOCOL.md

Then run or request:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git log \--oneline \-5  
git diff \--stat

If implementation is planned, also run or request:

npm run build

Do not edit files in your first response.

Summarize:  
1\. Current project state.  
2\. Current branch.  
3\. Dirty/clean status.  
4\. Latest commits.  
5\. Current likely phase.  
6\. Locked product decisions relevant to the task.  
7\. Frontend preservation constraints.  
8\. Provider-neutral payment constraints.  
9\. Environment/connector constraints.  
10\. High-risk files.  
11\. Missing verification.  
12\. Safest next action.  
13\. Stop condition.

Project facts to preserve:  
\- PolyProPicks is a mobile-first betting / prediction-market signal product.  
\- LandingPair is the canonical source-of-truth unit.  
\- PremiumEventCard is the master signal card.  
\- MarketSourceCard / MarketSourceCarousel is dependent evidence.  
\- marketSource backward compatibility must be preserved.  
\- marketSources\[\] evidence stack must stay compatible.  
\- Feed is display-grade deterministic signal generation, not guaranteed predictive ML.  
\- Supabase is used.  
\- Railway/deployment context exists.  
\- Whop is likely first payment provider.  
\- Stripe may be added later.  
\- Payment architecture must be provider-neutral.  
\- Internal Supabase entitlement must be source of truth.  
\- UI must not directly trust Whop/Stripe.  
\- Free signal must remain visible without forced login.  
\- ChatGPT Saved Memory is full and must not be treated as project truth.  
\- /docs/ai-context/ is the shared context package.

Strict rules:  
\- Do not suggest a rewrite.  
\- Do not suggest broad refactor.  
\- Do not edit before source/context verification.  
\- Do not push/deploy without explicit approval.  
\- Do not change env/secrets.  
\- Do not print secrets.  
\- Do not rely only on GitHub file tree.  
\- Do not rely on old chat memory.  
\- Do not treat Whop or Stripe as internal access source of truth.  
\- Do not allow localStorage-only premium entitlement.  
\- Do not allow registration to block the free signal.  
\- Do not redesign frontend unless explicitly requested.  
\- Do not change DOM/className/CSS structure without clear UI scope.  
\- Do not change source when git status is dirty unless dirty state is understood.

Your first response must be inspect-only.

## **19\. Startup Prompt For Claude**

You are onboarding as architecture reviewer for PolyProPicks / PolyPicks Current.

Treat /docs/ai-context/ as source of truth. You are not the executor unless explicitly asked later. Do not propose a rewrite.

Read these context files first:

\- /docs/ai-context/01\_PROJECT\_CONTEXT\_CURRENT.md  
\- /docs/ai-context/02\_CURRENT\_TECH\_STATE.md  
\- /docs/ai-context/03\_CURRENT\_SOURCE\_ARCHITECTURE\_MAP.md  
\- /docs/ai-context/04\_PRODUCT\_DECISIONS\_LOCKED.md  
\- /docs/ai-context/05\_WINDSURF\_WORKFLOW\_RULES.md  
\- /docs/ai-context/06\_PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md  
\- /docs/ai-context/07\_AI\_AGENT\_MIGRATION\_CONTEXT.md  
\- /docs/ai-context/08\_ENVIRONMENT\_AND\_CONNECTORS.md  
\- /docs/ai-context/09\_CONTEXT\_DELTA\_LOG.md  
\- /docs/ai-context/10\_DESIGN\_SYSTEM\_AND\_FRONTEND\_BASELINE.md  
\- /docs/ai-context/11\_SOURCE\_FILES\_AND\_REPO\_INVENTORY.md  
\- /docs/ai-context/12\_AGENT\_STARTUP\_PROTOCOL.md

Audit the current planned work against:

1\. Locked product decisions.  
2\. Frontend preservation constraints.  
3\. Provider-neutral payment architecture.  
4\. Supabase/Railway/env constraints.  
5\. Current Git/runtime state.  
6\. Known failed approaches.  
7\. Founder/operator workflow limitations.

Project facts:  
\- PolyProPicks is a mobile-first betting / prediction-market signal product.  
\- PremiumEventCard is the master signal card.  
\- MarketSourceCard / MarketSourceCarousel is dependent evidence.  
\- LandingPair is canonical.  
\- marketSource compatibility and marketSources\[\] evidence stack must be preserved.  
\- Feed is display-grade deterministic signal generation, not guaranteed predictive ML.  
\- Whop is first payment provider direction.  
\- Stripe may be added later.  
\- Internal Supabase entitlement is source of truth.  
\- UI must not trust provider checkout directly.  
\- Free signal must remain visible without forced login.

Do not:  
\- Propose full rewrite.  
\- Propose broad refactor.  
\- Invent file paths.  
\- Override locked decisions casually.  
\- Recommend Whop-only or Stripe-only internal architecture.  
\- Recommend localStorage-only premium access.  
\- Recommend frontend redesign without request.  
\- Recommend edits before Git/source verification.

Produce:  
1\. Architecture readiness verdict.  
2\. Current highest risks.  
3\. Decision gates.  
4\. Required verification before implementation.  
5\. Files/areas to inspect.  
6\. First safe inspect-only prompt for Codex/Windsurf.  
7\. Stop conditions.  
8\. Clear recommendation: proceed / pause / verify first.

Your output should be review and risk control, not implementation.

## **20\. Stop Conditions**

Agents must stop if:

* Git status is dirty unexpectedly.  
* Source inventory is stale.  
* Context files conflict.  
* Env/secrets are requested.  
* User asks to push/deploy without verification.  
* Build fails.  
* Runtime output contradicts assumptions.  
* UI screenshot does not match claimed fix.  
* Task expands beyond scope.  
* Broad refactor becomes necessary.  
* Agent cannot identify files safely.  
* Payment/auth boundary is unclear.  
* Agent cannot distinguish cached vs fresh API output.  
* Agent cannot verify active route/port.  
* Agent sees untracked junk files.  
* Agent sees unexpected modified source files.  
* Agent needs to touch secrets/env to continue.  
* Agent would need to change DOM/classNames/CSS structure without explicit UI scope.  
* Agent would need to change payment provider architecture without locked decision.  
* Agent would need to break free-signal access to add auth.  
* Agent would need to trust frontend payment success as entitlement.

Stop response must include:

STOP CONDITION:  
Why stopped:  
What is unknown:  
What verification is needed:  
Which files/commands are needed:  
Safe next action:

## **21\. Final Startup Rule**

No agent may edit before proving it understands:

* Current Git state.  
* Source inventory.  
* Locked product decisions.  
* Frontend baseline.  
* Environment/connectors constraints.  
* Provider-neutral payment architecture.  
* Exact task scope.  
* Stop condition.

