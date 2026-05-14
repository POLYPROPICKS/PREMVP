# **WINDSURF\_WORKFLOW\_RULES.md**

## **1\. Purpose**

This file defines the active AI-assisted engineering workflow for PolyProPicks / PolyPicks Current.

It exists to prevent context loss, uncontrolled Windsurf changes, broad refactors, CSS churn, type-system drift, and production regressions.

Core operating model:

* **Windsurf is executor, not decision-maker.**  
* **ChatGPT is architect, prompt-writer, reviewer, and scope controller.**  
* **Founder is operator and final visual/business acceptor.**  
* **Source files, screenshots, build output, Git diff, API responses, Supabase rows, and production behavior are more reliable than Windsurf summaries.**

Windsurf output is never accepted just because it says “implemented successfully.” Acceptance requires evidence.

## **2\. Roles**

### **Founder / Operator**

Responsibilities:

* Copy-paste bounded Windsurf prompts or exact CMD commands.  
* Run/check the specified environment:  
  * local repo  
  * localhost  
  * production domain  
  * Supabase  
  * Railway  
* Provide screenshots, logs, command output, API output, or Supabase query output.  
* Perform final visual/business acceptance.  
* Avoid manual multi-file editing unless explicitly unavoidable.  
* Do not infer architecture decisions.  
* Do not accept broad Windsurf changes without ChatGPT review.  
* Do not commit/push/deploy unless explicitly told the step is ready.

Founder should not be asked to:

* Manually patch several snippets across files.  
* Coordinate complicated multi-terminal flows unless unavoidable.  
* Decide which technical files to edit.  
* Interpret large diffs alone.

### **ChatGPT / Architect**

Responsibilities:

* Decide the smallest safe next step.  
* Decide whether to use:  
  * Windsurf prompt  
  * direct CMD  
  * direct source-file review  
  * full-file/source-of-truth replacement  
* Write exact bounded Windsurf prompts.  
* Provide operational instructions:  
  * where to run  
  * what to check  
  * whether server must run  
  * what output to paste back  
* Define acceptance criteria.  
* Interpret logs, diffs, screenshots, API responses, and Supabase results.  
* Stop scope creep.  
* Protect stable production state.  
* Preserve current architecture.  
* Avoid stale-context revival.  
* Use direct-source review after one failed Windsurf attempt if it reduces uncertainty.  
* Tell the founder when not to commit/push/deploy.

### **Windsurf / Executor**

Responsibilities:

* Perform only the requested change.  
* Stay within allowed files.  
* Avoid broad refactors.  
* Avoid “cleanup for cleanliness.”  
* Return exact changed snippets.  
* Run required verification.  
* Stop if the task requires changing forbidden structure.  
* Stop if expected blocks/files are missing.  
* Not claim success without evidence.  
* Not infer product/architecture decisions beyond the prompt.

Windsurf must not:

* Redesign UI unless explicitly instructed.  
* Rename classNames/props/types casually.  
* Rewrite working layout.  
* Modify unrelated files.  
* Add dependencies without explicit instruction.  
* Change production/deploy settings unless explicitly asked.  
* Continue after build failure as if task succeeded.

## **3\. Default Execution Model**

Standard flow:

1. Inspect current state if uncertain.  
2. Decide exact patch strategy.  
3. Use one bounded Windsurf prompt.  
4. Require exact changed snippets.  
5. Require terminal verification.  
6. Founder checks visual/business result when relevant.  
7. Commit only after acceptance.  
8. Push/deploy only when explicitly ready.

Acceptance hierarchy:

1. Actual source code.  
2. Git diff.  
3. Build output.  
4. API/DB output.  
5. Browser screenshot / behavior.  
6. Production verification.  
7. Windsurf summary.

Rules:

* `npm run build` is not visual acceptance.  
* Windsurf success text is not acceptance.  
* Screenshot/browser behavior beats summary.  
* API response beats assumed backend behavior.  
* Supabase rows beat localStorage.  
* Production check is separate from local build.

## **4\. Mandatory Windsurf Prompt Boundary Format**

Every Windsurf command must be one complete copy-paste block.

Required boundaries:

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

\[full prompt\]

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

Rules:

* No split prompts.  
* No fragmented commands.  
* No mixed commentary inside the command block.  
* No second fragment later unless it is a new command with new boundaries.  
* If multiple files are involved, still use one coherent block.  
* If exact replacement is required, include:  
  * exact file path  
  * exact old block  
  * exact new block  
  * stop condition if old block is not found

ChatGPT must clearly separate explanation from the Windsurf command.

## **5\. Mandatory Windsurf Prompt Structure**

Every Windsurf prompt must include these sections:

* TASK  
* GOAL  
* CONTEXT  
* PRECHECK  
* ALLOWED FILES  
* FORBIDDEN FILES / FORBIDDEN CHANGES  
* EXACT TASKS  
* PRESERVATION RULES  
* ACCEPTANCE CRITERIA  
* TERMINAL VERIFICATION REQUIRED  
* RESPONSE FORMAT REQUIRED  
* STOP CONDITIONS

Mandatory preservation clause:

CRITICAL PRESERVATION RULES:  
Do not rename existing classNames.  
Do not change existing DOM nesting.  
Do not remove or add wrapper divs around existing visual blocks.  
Do not refactor JSX structure for cleanliness.  
Do not rewrite working layout.  
Only perform the requested targeted change.  
If the requested change requires changing DOM structure, STOP and report exactly why before editing.

Reusable internal prompt skeleton:

TASK:  
\[Exact task name\]

GOAL:  
\[One concrete outcome\]

CONTEXT:  
\[Current branch/state/product context\]

PRECHECK:  
Run:  
\- git branch \--show-current  
\- git status \--short  
\- git diff \--stat  
\- npm run build if required

EXPECTED:  
\[Expected branch, clean/dirty files, known state\]

ALLOWED FILES:  
\- \[file path\]

FORBIDDEN FILES / FORBIDDEN CHANGES:  
\- Do not edit \[file/path\]  
\- Do not change UI/CSS/API/etc.  
\- Do not refactor  
\- Do not commit/push/deploy

EXACT TASKS:  
1\. \[Task\]  
2\. \[Task\]

CRITICAL PRESERVATION RULES:  
Do not rename existing classNames.  
Do not change existing DOM nesting.  
Do not remove or add wrapper divs around existing visual blocks.  
Do not refactor JSX structure for cleanliness.  
Do not rewrite working layout.  
Only perform the requested targeted change.  
If the requested change requires changing DOM structure, STOP and report exactly why before editing.

ACCEPTANCE CRITERIA:  
1\. \[Binary criterion\]  
2\. \[Binary criterion\]

TERMINAL VERIFICATION REQUIRED:  
Run:  
\- npm run build  
\- git branch \--show-current  
\- git status \--short  
\- git diff \--stat

RESPONSE FORMAT REQUIRED:  
1\. Files changed  
2\. Exact old/new snippets  
3\. Terminal verification  
4\. Acceptance criteria status  
5\. Human visual check required  
6\. Risks / assumptions  
7\. Stop conditions encountered

STOP CONDITIONS:  
\- If branch is wrong, STOP.  
\- If expected file/block is missing, STOP.  
\- If forbidden file must be edited, STOP.  
\- If build fails, STOP.  
\- Do not commit/push/deploy unless explicitly requested.

## **6\. Required Windsurf Response Format**

Windsurf must return:

1. **Files changed**  
   * file path  
   * whether file was allowed  
2. **Exact code changed for each changed block**  
   * file path  
   * old code snippet  
   * new code snippet  
3. **Terminal verification**  
   * `git status --short`  
   * `git diff --stat`  
   * `npm run build` result  
   * branch name if relevant  
4. **Acceptance criteria**  
   * satisfied  
   * not verified  
   * failed  
5. **Human visual check required**  
   * yes/no  
   * exact viewport/environment  
   * exact behavior to check  
6. **Risks / unrelated changes / assumptions**  
   * any inferred decisions  
   * any changes outside requested block  
   * any unverified assumptions  
7. **Stop conditions encountered**  
   * if any

Do not accept:

Implemented successfully.

unless it includes snippets and verification.

Invalid Windsurf response examples:

* “Done.”  
* “Build should pass.”  
* “Acceptance met.”  
* “I fixed the issue.”  
* “No issues found.”  
* Any response without exact old/new snippets for code changes.

## **7\. Inspect-Only First Rule**

Use inspect-only when:

* Current wiring is uncertain.  
* Previous Windsurf attempt failed.  
* Multiple files may be involved.  
* CSS selector source is unclear.  
* Build passes but UI behavior is wrong.  
* Runtime/API behavior is uncertain.  
* There is a risk of broad refactor.  
* Stale context may conflict with actual source.  
* The task touches architecture, state, API/cache, or routing.  
* There are conflicting types or duplicate definitions.

Inspect-only prompt must:

* Not edit files.  
* Report current wiring.  
* Identify active files/selectors/states/types.  
* Identify exact data flow.  
* Recommend smallest next patch.  
* List exact blocks to replace if known.  
* Report risks and uncertainty.  
* Stop if tree is dirty unexpectedly.

Inspect-only is required before implementation when:

* MarketSource/PremiumEvent synchronization is unclear.  
* CSS active selector is unclear.  
* Supabase/cache/API shape is unclear.  
* A previous implementation attempt caused build failure.  
* A previous implementation attempt changed more files than expected.

## **8\. Exact Replacement First Rule**

Prefer exact old-block/new-block replacement over broad implementation prompts.

Use exact replacement when:

* A specific code block is known.  
* A previous Windsurf change was too broad.  
* Build error points to a narrow type/field issue.  
* A visual component has a known source-of-truth file.  
* CSS override layers became messy.

For visual-sensitive work:

* Prefer full source-of-truth file replacement over incremental CSS patches when the file has accumulated override blocks.  
* Do not append random CSS overrides unless there is no safe replacement target.  
* Do not let Windsurf “improve” or “clean up” working UI.

Avoid prompts like:

* “Fix the UI.”  
* “Improve layout.”  
* “Clean up the component.”  
* “Refactor this.”  
* “Make it better.”  
* “Implement the architecture.”  
* “Optimize CSS.”

Allowed only if explicitly framed as inspect-only or architecture-only and scoped tightly.

## **9\. Direct-Source Option Check After One Failure**

Active PreMVP13 rule:

After one failed Windsurf attempt, ChatGPT must explicitly evaluate whether it is better to stop prompting Windsurf and work from current source files directly.

Required output:

Direct-source option check: \[continue with Windsurf / request files / provide full-file replacement\] because \[reason\].

Use direct-source/source-of-truth strategy when:

* Windsurf changed wrong selectors.  
* Windsurf introduced type churn.  
* Windsurf misunderstood state architecture.  
* Windsurf fixed a symptom but not root cause.  
* Repeated micro-patches are creating risk.  
* Exact current source is needed.  
* Visual/CSS state became unreliable.  
* Build errors involve duplicate types/imports.  
* The diff must be reviewed before another prompt.  
* Windsurf produced contradictory output.

Direct-source strategy may mean:

* Request/upload current source files.  
* Review uploaded diff/source directly.  
* Provide corrected whole file(s).  
* Provide a smaller exact replacement prompt after reviewing source.  
* Stop current branch and reset if patch is too risky.

Do not keep prompting Windsurf blindly after one failure.

## **10\. CMD vs Windsurf Command Rule**

Direct CMD block is acceptable only if:

* It requires 5 or fewer simple commands.  
* It is linear.  
* It does not require the founder to coordinate multiple terminal windows.  
* It does not require complex interpretation.

If more than 5 CMD commands are needed:

* Package the task as one bounded Windsurf prompt.  
* Use required Windsurf boundary markers.  
* Make Windsurf run the checks and return results.

Avoid multi-terminal complexity.

If dev server must run, explicitly state one of:

* “Keep this window occupied and open a second CMD.” Use only if unavoidable.  
* “Stop dev server with Ctrl+C and reuse this CMD.”  
* “Do not run dev server; use build/API checks instead.”  
* “Use production endpoint instead of localhost.”

Prefer single-window, linear operations.

Founder instructions must never assume the operator knows:

* whether server must be running  
* which port to use  
* where to run a command  
* whether output should be pasted back  
* whether a failed curl created an empty file  
* whether local vs production is being checked

## **11\. CSS / Visual Change Rules**

For CSS changes, acceptance requires:

1. Name the active className in JSX.  
2. Name all CSS selectors affecting the visible property.  
3. Modify the active source selector only.  
4. Return old/new snippets.  
5. Run build.  
6. Founder performs visual check.

If screenshot does not change:

* Assume wrong selector or overridden layer.  
* Inspect active selector in source/DevTools.  
* Do not keep random patching.  
* Do not append more CSS blindly.  
* Consider source-of-truth replacement.

Snippet review alone is not enough for CSS.

CSS prompt must include:

* viewport(s) to test  
* exact visual target  
* forbidden layout zones  
* exact file path  
* whether JSX changes are forbidden  
* acceptance criteria in visual terms

For PolyProPicks:

* `Reconstruction.module.css` is fragile and historically contains many overrides.  
* Do not modify it for modal styling unless explicitly required.  
* Prefer isolated component CSS modules for modal/component styling.  
* Build passing does not mean layout is correct.

## **12\. UI Preservation Rules**

General UI rules:

* Do not touch unrelated layout.  
* Do not change CTA wording unless explicitly required.  
* Do not rename classNames.  
* Do not alter DOM structure for “cleanliness.”  
* Do not add/remove wrapper divs around visual blocks unless required and approved.  
* Do not change carousel behavior unless task explicitly requires it.  
* Do not change modal behavior during CSS-only tasks.  
* Do not change feed/API/Supabase/Railway during UI-only tasks.  
* Do not rename props/types casually.

Project-specific rules:

* Do not alter `Reconstruction.module.css` for modal styling unless explicitly required.  
* Keep modal styling isolated in modal CSS modules when working on `PassOfferModal`.  
* Do not modify `PremiumEventCarousel.tsx`, `MarketSourceCarousel.tsx`, or `page.tsx` unless task explicitly requires it.  
* Do not change main CTA copy:  
  * `Get 5 Free Signals NOW`  
* Current label is:  
  * `Signal Confidence`  
  * not old `Win Probability`  
* `PremiumEventCard` is master.  
* `MarketSourceCard` is dependent evidence.  
* MarketSourceCarousel must not become an unrelated feed.  
* Filters remain free controls unless explicitly changed.  
* Locked feed attempts must open pass modal without changing active pair.

If uncertain:

NEEDS VERIFICATION

and preserve the general rule.

## **13\. Git / Build / Deploy Rules**

Before commit/push:

npm run build  
git status \--short  
git diff \--stat  
git diff \--check

Commit rules:

* Commit only intended files.  
* Do not commit if build fails.  
* Do not commit if unexpected files are dirty.  
* Do not commit if `git diff --check` reports trailing whitespace.  
* LF/CRLF warnings alone are not trailing whitespace blockers.  
* Use feature branch for AI-risky work.  
* Main remains stable checkpoint.  
* Commit messages should describe the product/technical step.

Push/deploy rules:

* Do not push if build fails.  
* Do not push if unexpected dirty files exist.  
* Push main only after merge/build.  
* Production verification is separate from local build.  
* Railway deploy status may lag Git push.  
* Production API may be cached; do not assume immediate response shape.  
* If production differs from local, verify deploy state before coding more.

Preferred environment:

* Windows CMD.  
* Avoid PowerShell unless explicitly necessary.

Known repo path:

C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1

Common commands:

cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
git branch \--show-current  
git status \--short  
git diff \--stat  
git diff \--check  
npm run build

## **14\. Localhost vs Production Verification**

Every instruction must specify:

* Where to check:  
  * localhost  
  * production domain  
  * Supabase  
  * Railway  
* Whether dev server must run.  
* Exact URL/API endpoint.  
* Exact expected result.  
* What founder should paste back.  
* Whether screenshot is required.  
* Whether Supabase/Railway/production logs are involved.

Local verification examples:

Check localhost at:  
http://localhost:3000

Dev server must be running.  
Paste back screenshot at 390×700.

API verification example:

Check:  
http://localhost:3000/api/feed/landing-cards?limit=1\&category=sports\&minDataCoverage=40\&excludeEnded=true

Expected:  
hasMarketSource: true  
hasMarketSources: true  
marketSourcesLength \>= 1  
firstEvidenceMatches: true

Production verification example:

Check:  
https://polypropicks.com/api/feed/landing-cards?limit=1\&category=sports\&minDataCoverage=40\&excludeEnded=true

Expected:  
HTTP 200  
valid JSON  
no API break

Cache warning:

* `cacheStatus: hit` may return old cached data.  
* Do not treat cache-hit data as proof of fresh generation.  
* If runtime generation must be verified, identify whether cache-bypass/debug route exists before modifying code.

## **15\. Common Failure Patterns to Avoid**

Project-specific failure patterns:

* Broad rebuilds that damage visual hierarchy.  
* CSS selector mismatch.  
* Editing overridden CSS layer instead of active selector.  
* Mojibake/encoding artifacts in CMD/build logs.  
* Repeated `node -e` replace hacks without source review.  
* Windsurf claiming success without visual match.  
* Windsurf saying acceptance met while screenshot shows the opposite.  
* Hardcoded content blocking daily operation.  
* localStorage-only capture treated as production acceptance.  
* Premature Stripe/Auth/Admin work.  
* Independent MarketSource browsing when architecture forbids it.  
* Changing DOM/classNames for cleanliness.  
* Multiple prompt fragments.  
* “Fix build” prompts after first failure without direct-source option check.  
* Duplicate type definitions across files.  
* Adding new type aliases in wrong source file.  
* Creating API/cache schema assumptions without DB verification.  
* Committing despite `git diff --check` trailing whitespace.  
* Trusting production API immediately after push without deploy/cache awareness.  
* Giving founder long CMD scripts with too many steps.  
* Asking founder to coordinate multiple CMD windows unnecessarily.

## **16\. Standard Windsurf Prompt Template**

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

You are working in the PolyProPicks / PolyPicks Current project.

TASK:  
\[Exact task name\]

GOAL:  
\[One concrete outcome. State what must be true after the task.\]

CONTEXT:  
Project: PolyProPicks / PolyPicks Current  
Current phase: \[PREMVP phase/step\]  
Current branch expected: \[branch\]  
Current production/stability context:  
\- \[facts\]  
\- \[what must be preserved\]

PRECHECK:  
Run:  
\- cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
\- git branch \--show-current  
\- git status \--short  
\- git diff \--stat  
\- git log \--oneline \-5

EXPECTED:  
\- branch: \[expected branch\]  
\- working tree: \[clean / specific dirty files\]  
\- latest commit: \[if known\]

ALLOWED FILES:  
\- \[file path 1\]  
\- \[file path 2\]

FORBIDDEN FILES / FORBIDDEN CHANGES:  
\- Do not edit \[file/path\].  
\- Do not edit UI/CSS/API/Supabase unless explicitly listed.  
\- Do not refactor.  
\- Do not rename classNames/props/types.  
\- Do not add dependencies.  
\- Do not stage.  
\- Do not commit.  
\- Do not push.  
\- Do not deploy.

EXACT TASKS:  
1\. \[Specific task\]  
2\. \[Specific task\]  
3\. \[Specific task\]

CRITICAL PRESERVATION RULES:  
Do not rename existing classNames.  
Do not change existing DOM nesting.  
Do not remove or add wrapper divs around existing visual blocks.  
Do not refactor JSX structure for cleanliness.  
Do not rewrite working layout.  
Only perform the requested targeted change.  
If the requested change requires changing DOM structure, STOP and report exactly why before editing.

ACCEPTANCE CRITERIA:  
1\. \[Binary criterion\]  
2\. \[Binary criterion\]  
3\. \[Binary criterion\]  
4\. No forbidden files changed.  
5\. Build passes if build is required.  
6\. No commit/push/deploy unless explicitly requested.

TERMINAL VERIFICATION REQUIRED:  
Run:  
\- npm run build  
\- git branch \--show-current  
\- git status \--short  
\- git diff \--stat  
\- git diff \--check

RESPONSE FORMAT REQUIRED:  
1\. Precheck:  
   \- branch  
   \- git status \--short  
   \- git diff \--stat  
   \- git log \--oneline \-5

2\. Files changed:  
   \- file path  
   \- confirm allowed yes/no

3\. Exact code changed:  
   \- old snippet  
   \- new snippet

4\. Terminal verification:  
   \- npm run build result  
   \- git branch \--show-current  
   \- git status \--short  
   \- git diff \--stat  
   \- git diff \--check result

5\. Acceptance criteria:  
   \- satisfied / not verified / failed

6\. Human visual/business check required:  
   \- yes/no  
   \- exact viewport/URL/action if needed

7\. Risks / assumptions:  
   \- list any

8\. Stop conditions encountered:  
   \- list any

STOP CONDITIONS:  
\- If branch is not \[expected branch\], STOP.  
\- If working tree has unexpected dirty files, STOP.  
\- If exact target block/file cannot be found, STOP and show nearest snippet.  
\- If required fix needs forbidden files, STOP and report.  
\- If build fails, STOP and report first error only.  
\- Do not commit.  
\- Do not push.  
\- Do not deploy.

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

## **17\. Standard Founder Instruction Format**

Before a Windsurf prompt or CMD step, ChatGPT must state:

1. **What this step does**  
   * one sentence  
   * no theory dump  
2. **Where to execute it**  
   * Windsurf  
   * CMD  
   * browser  
   * Supabase  
   * Railway  
   * production  
3. **Whether Windsurf is involved**  
   * yes/no  
4. **Whether local server must run**  
   * yes/no  
   * if yes, specify whether to keep current terminal open or reuse same CMD  
5. **What to paste back**  
   * exact output needed  
   * screenshots if needed  
   * API JSON summary if needed  
6. **Stop condition**  
   * build fails  
   * unexpected dirty files  
   * wrong branch  
   * visual mismatch  
   * API mismatch  
   * Supabase row missing

Example:

This step only cleans the feature-branch commit. It does not change product logic.

Execute in Windsurf using the prompt below.  
Local dev server does not need to run.  
Paste back:  
1\. amended commit hash  
2\. git status \--short  
3\. git log \--oneline \-5

Stop if build fails or any file other than lib/feed/buildLandingCards.ts changes.

For direct CMD with 5 or fewer commands:

Run this in CMD from the repo root.  
No dev server needed.  
Paste back the full output.  
Stop if build fails.

## **18\. Final Rule**

When in doubt:

* Inspect first.  
* Patch smaller.  
* Preserve UI.  
* Verify with build/diff/screenshot/API/Supabase as appropriate.  
* Do not trust summaries.  
* Do not continue after one failed Windsurf attempt without direct-source option check.  
* Do not expand scope to “fix everything.”  
* Do not merge/push/deploy until the exact current gate is passed.

