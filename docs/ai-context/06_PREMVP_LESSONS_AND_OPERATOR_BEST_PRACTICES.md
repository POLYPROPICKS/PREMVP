v**PREMVP\_LESSONS\_AND\_OPERATOR\_BEST\_PRACTICES.md**

## **1\. Purpose**

This file preserves operational learning from PolyProPicks PreMVP1–13.

It prevents repeating expensive mistakes in the way ChatGPT, Windsurf, and the founder/operator work together. It defines the current execution doctrine for AI-assisted development on this project.

This file is a companion to `WINDSURF_WORKFLOW_RULES.md`.

It captures:

* what repeatedly failed  
* what improved speed and control  
* how to write Windsurf prompts  
* when to use inspect-only  
* when to stop using Windsurf and inspect source directly  
* how to avoid context drift, CSS churn, type churn, false acceptance, and founder overload

This is project-specific. It is not a generic AI coding guide.

## **2\. Operating Model Summary**

Current working model:

* **Founder is operator and final acceptor.**  
  * Runs commands/prompts.  
  * Provides screenshots/logs/diffs/API outputs.  
  * Gives final visual/business acceptance.  
* **ChatGPT is architect, prompt-writer, reviewer, and decision filter.**  
  * Chooses smallest safe next step.  
  * Writes exact Windsurf prompts.  
  * Interprets logs, diffs, screenshots, and API outputs.  
  * Prevents scope creep and stale-context revival.  
* **Windsurf is executor/inspector.**  
  * Performs bounded tasks.  
  * Must not decide architecture.  
  * Must not refactor broadly.  
  * Must return snippets and verification.

Truth hierarchy in daily work:

* Current source files beat memory.  
* Git diff beats summary.  
* Screenshot/browser behavior beats “implemented successfully.”  
* API/Supabase output beats assumption.  
* Build passing is necessary but not visual/product acceptance.  
* Windsurf self-report is not evidence unless backed by snippets, build, diff, and relevant runtime/visual checks.

Default rule:

* Keep changes small.  
* Bound every task.  
* Verify every step.  
* Do not merge/push/deploy until the exact current gate is passed.

## **3\. Evolution Timeline: PreMVP1 to PreMVP13**

Chronology approximate / NEEDS VERIFICATION for exact early stage numbering.

### **PreMVP1 / Early Landing and Visual Reconstruction**

* **Main focus:** Build the first mobile-first signal landing surface and visually reconstruct the target card-based experience.  
* **What worked:**  
  * Using concrete visual references.  
  * Mobile-first focus.  
  * Building around card hierarchy instead of generic landing blocks.  
* **What failed or caused friction:**  
  * Broad visual prompts caused layout regressions.  
  * Windsurf often claimed success while screenshots showed the opposite.  
  * CSS selectors and overrides became hard to reason about.  
* **Lesson extracted:**  
  * Visual work requires source-of-truth files, exact selectors, screenshots, and narrow changes.  
* **Current rule created:**  
  * Do not trust visual “success” from Windsurf. Screenshots and active selectors decide.

### **PreMVP2 / Reconstruction Stabilization and Content Extraction**

* **Main focus:** Stabilize `/reconstruction`, preserve visual baseline, and extract editable content into data files.  
* **What worked:**  
  * Treating `/reconstruction` as benchmark/source-of-truth.  
  * Moving daily-editable content into `content/signals.ts` and `content/marketSources.ts`.  
  * Keeping CSS/layout unchanged during data extraction.  
* **What failed or caused friction:**  
  * Asking Windsurf to restructure JSX/CSS together created unnecessary visual damage.  
  * Old overlay/reference artifacts confused debugging.  
* **Lesson extracted:**  
  * Separate data architecture from visual layout work.  
* **Current rule created:**  
  * If the task is data extraction, do not touch CSS or layout.

### **PreMVP3 / API Direction and Trusted Formula**

* **Main focus:** Define the API-lite strategy using official Polymarket public data.  
* **What worked:**  
  * Locking deterministic display-grade scoring instead of fake ML.  
  * Using official Polymarket sources first.  
  * Keeping Kalshi/news/ML integrations postponed.  
* **What failed or caused friction:**  
  * Too many possible external sources created architecture creep.  
  * Overclaiming “AI” or “smart money” was product-risky.  
* **Lesson extracted:**  
  * API-lite must be deterministic, explainable, and source-bounded.  
* **Current rule created:**  
  * Do not claim real ML, calibrated win probability, verified news, or institutional smart money without real sources.

### **PreMVP4 / Feed/API Wiring**

* **Main focus:** Connect generated feed/API data to landing card shape.  
* **What worked:**  
  * Preserving manual fallback.  
  * Keeping frontend compatible with existing content shape.  
  * Using formula/version metadata.  
* **What failed or caused friction:**  
  * Runtime behavior could be hidden by cache.  
  * Debug endpoints could use different mappers and not verify the intended path.  
* **Lesson extracted:**  
  * Build passing is not runtime API verification. Cache status matters.  
* **Current rule created:**  
  * Always distinguish build, local API, production API, cache hit, and fresh generation.

### **PreMVP5 / Exact Replacement Mode**

* **Main focus:** Reduce Windsurf ambiguity by replacing exact blocks/files instead of broad instructions.  
* **What worked:**  
  * “Replace this exact block with this exact block.”  
  * Full-file source-of-truth replacement for messy CSS/UI files.  
* **What failed or caused friction:**  
  * General prompts like “fix layout” or “implement logic” led to wide changes and regressions.  
* **Lesson extracted:**  
  * Windsurf performs better with exact replacement than open-ended implementation.  
* **Current rule created:**  
  * Exact replacement first when target code is known.

### **PreMVP6 / Mandatory Snippet Reports**

* **Main focus:** Force Windsurf to return concrete old/new code snippets.  
* **What worked:**  
  * Requiring exact changed snippets.  
  * Reviewing before/after blocks instead of summaries.  
* **What failed or caused friction:**  
  * Windsurf summaries hid unintended changes.  
* **Lesson extracted:**  
  * Snippets are mandatory for review.  
* **Current rule created:**  
  * Do not accept “implemented successfully” without file paths and old/new snippets.

### **PreMVP7 / Terminal Verification Requirement**

* **Main focus:** Require Windsurf to run routine checks itself.  
* **What worked:**  
  * `git status --short`  
  * `git diff --stat`  
  * `npm run build`  
  * returning verification in response  
* **What failed or caused friction:**  
  * Founder manually ran too many repetitive checks.  
* **Lesson extracted:**  
  * Windsurf should carry routine verification load when possible.  
* **Current rule created:**  
  * Every execution prompt requires terminal verification unless explicitly inspect-only.

### **PreMVP8–10 / Locked Feed and Mobile Layout Stabilization**

* **Main focus:** Implement locked premium feed concept with visible next-card peek and mobile layout.  
* **What worked:**  
  * Active PremiumEventCard as master.  
  * Locked attempt opens modal.  
  * Next-card peek communicates premium depth.  
* **What failed or caused friction:**  
  * Several CSS patches overcompressed or overexpanded layout.  
  * Header/card/CTA fold-fit was sensitive.  
  * Changes based on intuition rather than measurement caused loops.  
* **Lesson extracted:**  
  * Mobile layout must be verified visually at target viewports.  
* **Current rule created:**  
  * For visual work, test actual target adaptive sizes and inspect selectors if screenshot does not change.

### **PreMVP11 / Inspect-First and Source-of-Truth Visual Work**

* **Main focus:** Stop uncontrolled visual patching and use inspect-only/source-of-truth replacement.  
* **What worked:**  
  * Inspect-only before execution when uncertain.  
  * Full file replacement for PassOfferModal visual design.  
  * Isolating modal CSS in modal module.  
* **What failed or caused friction:**  
  * Large inspect+implement prompts caused hangs.  
  * Micro-patches created CSS override stacks.  
  * Some instructions were split across messages and confused operator workflow.  
* **Lesson extracted:**  
  * Separate inspect from implementation. Use one bounded prompt. Keep modal styling isolated.  
* **Current rule created:**  
  * All Windsurf commands must be one complete block with boundary markers.

### **PreMVP12 / Evidence Stack Architecture**

* **Main focus:** Define and implement `marketSources[]` as evidence stack while preserving `marketSource`.  
* **What worked:**  
  * Foundation first, no UI changes.  
  * `marketSource` backward compatibility.  
  * `marketSources[0]` corresponding to `marketSource`.  
  * Feature branches for backend changes.  
* **What failed or caused friction:**  
  * Windsurf edited the wrong type source during TypeScript errors.  
  * Duplicate type definitions caused churn.  
  * Runtime generation was difficult to verify because endpoint returned cache hit.  
* **Lesson extracted:**  
  * Type errors require source-of-truth type inspection, not repeated patching.  
  * Cache-hit responses can hide new generation logic.  
* **Current rule created:**  
  * After one failed Windsurf attempt, perform direct-source option check.

### **PreMVP13 / Direct-Source Option Check and Operator Simplification**

* **Main focus:** Formalize response to Windsurf failure and reduce founder operator load.  
* **What worked:**  
  * Checking source files directly after one failed attempt.  
  * Avoiding repeated Windsurf fixes when it misunderstood root cause.  
  * Limiting founder commands.  
* **What failed or caused friction:**  
  * Multi-terminal instructions confused the founder.  
  * Long raw CMD blocks overloaded operator workflow.  
* **Lesson extracted:**  
  * Founder must receive short, linear actions.  
* **Current rule created:**  
  * After one failed Windsurf attempt, evaluate direct-source approach.  
  * If more than 5 CMD commands are needed, package them as one bounded Windsurf prompt.  
  * Avoid multi-terminal choreography unless unavoidable.

## **4\. Top Failure Patterns**

### **Failure Pattern: Broad rebuild/refactor when only targeted fix was needed**

* **What happened:** Windsurf was asked to rebuild or restructure when only a small CSS/data/type fix was needed.  
* **Why it was expensive:** It broke previously accepted layout, created extra diffs, and increased review cost.  
* **Root cause:** Prompt was too broad and gave Windsurf design/architecture discretion.  
* **Current prevention rule:** One zone per prompt. Exact allowed files. Exact forbidden files. No refactor unless explicitly scoped.  
* **Example application:** Backend evidence generation must touch only `lib/feed/buildLandingCards.ts`.  
* **Stop condition:** If Windsurf says another file must change, stop and report why.

### **Failure Pattern: Windsurf claiming success despite screenshot mismatch**

* **What happened:** Windsurf reported acceptance met, but screenshots showed UI still broken.  
* **Why it was expensive:** Time was wasted trusting summaries instead of visible behavior.  
* **Root cause:** Windsurf evaluates formal criteria, not actual product perception.  
* **Current prevention rule:** Visual work requires founder screenshot/browser acceptance.  
* **Example application:** CTA fold-fit cannot be accepted by build passing.  
* **Stop condition:** If screenshot does not match, do not continue patching blindly; inspect active selectors.

### **Failure Pattern: CSS selector mismatch / invisible changes**

* **What happened:** CSS changes did not affect the visible UI because the wrong selector or overridden layer was edited.  
* **Why it was expensive:** Repeated patches accumulated without moving the actual UI.  
* **Root cause:** Active JSX classNames and final winning CSS selectors were not inspected first.  
* **Current prevention rule:** Inspect active className and all affecting selectors before CSS patch.  
* **Example application:** For Trust Metrics or CTA spacing, first identify the JSX class and final CSS override.  
* **Stop condition:** If screenshot unchanged after one attempt, inspect selector source before another patch.

### **Failure Pattern: Accumulated CSS overrides/churn**

* **What happened:** Multiple emergency/final/rescue CSS blocks stacked at the end of files.  
* **Why it was expensive:** Later changes were unpredictable and hard to reason about.  
* **Root cause:** Repeated append-overrides instead of source-of-truth replacement.  
* **Current prevention rule:** For messy CSS, prefer consolidated replacement of the active block or full source-of-truth file replacement.  
* **Example application:** PassOfferModal visual design was better handled by full TSX/CSS replacement.  
* **Stop condition:** If the same CSS zone needs more than one failed patch, stop and review source.

### **Failure Pattern: Encoding/mojibake bugs from command-line replacements**

* **What happened:** Windows/CMD output sometimes showed mojibake; automated replacements risked encoding/line-ending noise.  
* **Why it was expensive:** It could introduce invisible file changes or confusing logs.  
* **Root cause:** Windows terminal encoding and node/script replacements.  
* **Current prevention rule:** Use CMD, inspect diffs, and run `git diff --check`.  
* **Example application:** Clean trailing whitespace before commit; ignore LF/CRLF warnings only if no whitespace errors.  
* **Stop condition:** If `git diff --check` shows trailing whitespace, do not commit.

### **Failure Pattern: Repeated node replace hacks**

* **What happened:** Node one-liners were used to patch files repeatedly.  
* **Why it was expensive:** They were fast but easy to misapply and hard for founder to audit.  
* **Root cause:** Trying to avoid source review with command-line edits.  
* **Current prevention rule:** Use node one-liners only for simple safe cleanup, not logic changes.  
* **Example application:** Whitespace cleanup is acceptable; architecture/type fixes should use source review or Windsurf exact patch.  
* **Stop condition:** If the node command modifies logic or multiple files, stop.

### **Failure Pattern: Multi-terminal confusion**

* **What happened:** Founder had to manage dev server in one CMD and API checks in another.  
* **Why it was expensive:** It caused confusion and command/output mixing.  
* **Root cause:** Instructions assumed engineering terminal habits.  
* **Current prevention rule:** Prefer single-window linear operations; if more than 5 commands, use Windsurf prompt.  
* **Example application:** Do not tell founder to run long multi-window localhost checks unless unavoidable.  
* **Stop condition:** If dev server occupies terminal, explicitly say whether to stop with Ctrl+C or open another CMD.

### **Failure Pattern: Founder forced into manual multi-file edits**

* **What happened:** Founder was asked to manually edit or replace several snippets/files.  
* **Why it was expensive:** It increased human error and slowed execution.  
* **Root cause:** ChatGPT offloaded implementation instead of packaging it for Windsurf/source replacement.  
* **Current prevention rule:** Founder is operator, not manual patcher.  
* **Example application:** Provide one Windsurf prompt or full corrected file replacement, not scattered snippets.  
* **Stop condition:** If instructions require manual edits in multiple files, repackage as Windsurf prompt.

### **Failure Pattern: Long prompts causing Windsurf hangs**

* **What happened:** Large inspect+implement prompts took too long or hung.  
* **Why it was expensive:** They created partial execution and more repair work.  
* **Root cause:** Overloaded prompt scope.  
* **Current prevention rule:** Split into inspect-only, then one narrow execution prompt.  
* **Example application:** PREMVP12 Step 3A inspect, then Step 3B backend-only patch.  
* **Stop condition:** If prompt mixes broad inspection, implementation, build, deploy, and visual acceptance, split it.

### **Failure Pattern: Inspect+implement mixed into one overloaded prompt**

* **What happened:** Windsurf was asked to discover wiring and change code in the same step.  
* **Why it was expensive:** It guessed and edited based on incomplete understanding.  
* **Root cause:** Lack of inspect-only gate.  
* **Current prevention rule:** Use inspect-only when wiring/source ownership is uncertain.  
* **Example application:** Before changing carousel state, inspect current activePair/activeIndex wiring.  
* **Stop condition:** If Windsurf must inspect multiple domains before deciding patch, do not allow edit in same prompt.

### **Failure Pattern: Context drift from old phases**

* **What happened:** Old decisions, old CTA wording, old layout assumptions, or old architecture resurfaced.  
* **Why it was expensive:** It caused wrong prompts and stale implementation.  
* **Root cause:** Chat memory was treated as current source of truth.  
* **Current prevention rule:** Use project source-of-truth files and current repo inspection.  
* **Example application:** Current label is Signal Confidence, not old Win Probability.  
* **Stop condition:** If memory conflicts with source or latest accepted state, inspect source and ask founder if needed.

### **Failure Pattern: Hardcoded content blocking product evolution**

* **What happened:** UI depended on hardcoded signal/source content.  
* **Why it was expensive:** Daily editing and API integration became harder.  
* **Root cause:** Content was mixed with layout.  
* **Current prevention rule:** Keep content/data in content files or feed API shapes where possible.  
* **Example application:** Use `content/signals.ts`, `content/marketSources.ts`, and feed builders.  
* **Stop condition:** If routine content changes require layout file edits, architecture should be corrected.

### **Failure Pattern: Treating build pass as product acceptance**

* **What happened:** Build passed but UI/API/product behavior was wrong or unverified.  
* **Why it was expensive:** Broken experiences could reach production.  
* **Root cause:** Confusing technical compilation with user-visible acceptance.  
* **Current prevention rule:** Build is one gate only.  
* **Example application:** Pass modal must be visually checked; Supabase rows must prove lead capture.  
* **Stop condition:** If only build passed, do not claim product acceptance.

### **Failure Pattern: Local verification confused with production verification**

* **What happened:** Local success was assumed to mean production success.  
* **Why it was expensive:** Railway/cache/client-side behavior could differ.  
* **Root cause:** No separation between localhost, production, cache, and deployment state.  
* **Current prevention rule:** State exact environment for every check.  
* **Example application:** Production API may return cache hit even after local generation works.  
* **Stop condition:** If production differs from local, verify deploy/cache before coding more.

### **Failure Pattern: Premature Stripe/Auth/Admin/Test infrastructure**

* **What happened:** Bigger platform features were considered before product/feed validation was stable.  
* **Why it was expensive:** It increased complexity before proving demand.  
* **Root cause:** Overbuilding.  
* **Current prevention rule:** Postpone Stripe/auth/admin/heavy tests until current phase needs them.  
* **Example application:** Premium reserve intent before Stripe.  
* **Stop condition:** If a task adds platform infrastructure without immediate phase requirement, stop.

### **Failure Pattern: Over-optimizing process too early**

* **What happened:** Full screenshot naming, text regression scripts, rollback protocols, and heavier QA were proposed.  
* **Why it was expensive:** They added overhead before the product stabilized.  
* **Root cause:** Importing mature-team processes too early.  
* **Current prevention rule:** Use lightweight verification gates first.  
* **Example application:** Build/diff/API/Supabase/screenshot checks before full CI.  
* **Stop condition:** If process cost exceeds current PreMVP value, postpone.

## **5\. Best Practices That Are Now Active**

### **Best Practice: Inspect-only first for uncertain wiring**

* **Rule:** If source wiring is uncertain, use inspect-only before implementation.  
* **Why it exists:** Prevents wrong-file and wrong-selector edits.  
* **When to use:** UI state, carousel logic, API route, Supabase write path, CSS selector ownership.  
* **How to apply:** Windsurf returns active files, snippets, and recommended smallest patch.  
* **What to avoid:** Inspect+implement in one prompt.

### **Best Practice: Exact replacement second**

* **Rule:** After inspection, use exact old/new block replacement where possible.  
* **Why it exists:** Reduces Windsurf interpretation.  
* **When to use:** Type fixes, route mapping fixes, known CSS blocks, helper changes.  
* **How to apply:** Prompt includes exact old snippet and exact new snippet.  
* **What to avoid:** “Fix the bug” without target code.

### **Best Practice: One zone per Windsurf prompt**

* **Rule:** Each execution prompt should touch one functional zone.  
* **Why it exists:** Prevents broad diffs and debugging ambiguity.  
* **When to use:** Always, unless an explicit coordinated change is required.  
* **How to apply:** Limit allowed files and forbid unrelated files.  
* **What to avoid:** UI \+ API \+ CSS \+ deploy in one prompt.

### **Best Practice: One complete copy-paste prompt block**

* **Rule:** Every Windsurf command must be one complete bounded block.  
* **Why it exists:** Split prompts caused confusion and lost structure.  
* **When to use:** Every Windsurf command.  
* **How to apply:** Use required `НАЧАЛО/КОНЕЦ` markers.  
* **What to avoid:** Sending partial instructions across multiple messages.

### **Best Practice: Required old/new snippets**

* **Rule:** Windsurf must return old/new snippets for every changed block.  
* **Why it exists:** Summaries hide incorrect changes.  
* **When to use:** Every code-changing task.  
* **How to apply:** Include response format requiring snippets.  
* **What to avoid:** Accepting “done” or “implemented.”

### **Best Practice: Required terminal verification**

* **Rule:** Windsurf must run `git status --short`, `git diff --stat`, and `npm run build` unless inspect-only or explicitly not needed.  
* **Why it exists:** Founder should not carry routine verification load.  
* **When to use:** Every patch.  
* **How to apply:** Prompt includes terminal verification section.  
* **What to avoid:** Relying on Windsurf assumptions.

### **Best Practice: Direct-source option check after one failed Windsurf attempt**

* **Rule:** After one failed attempt, evaluate whether direct source review is faster.  
* **Why it exists:** Prevents repeated wrong fixes.  
* **When to use:** Any failed Windsurf fix, build/type loop, or visual mismatch.  
* **How to apply:** State: `Direct-source option check: ...`.  
* **What to avoid:** Giving Windsurf another broad “fix” prompt immediately.

### **Best Practice: No manual multi-block edits for founder**

* **Rule:** Founder should not manually edit multiple blocks/files.  
* **Why it exists:** Founder is operator/final acceptor, not code patcher.  
* **When to use:** Always.  
* **How to apply:** Use Windsurf prompt or full-file replacement.  
* **What to avoid:** “Open these files and replace these 5 snippets.”

### **Best Practice: More than 5 CMD commands → use Windsurf prompt**

* **Rule:** If the next operation needs more than 5 CMD commands, package it for Windsurf.  
* **Why it exists:** Long CMD sequences confuse the operator.  
* **When to use:** Build+diff+stage+commit+verify flows, deploy verification, multi-step checks.  
* **How to apply:** One bounded Windsurf prompt.  
* **What to avoid:** Raw command walls.

### **Best Practice: Keep founder/operator commands linear**

* **Rule:** Founder instructions must be short, single-flow, and explicit.  
* **Why it exists:** Multi-terminal choreography caused confusion.  
* **When to use:** Every operator instruction.  
* **How to apply:** Say where to run, whether dev server is needed, and what to paste back.  
* **What to avoid:** Simultaneous CMD windows unless unavoidable.

### **Best Practice: Ask for screenshots/logs/diffs, not vague status**

* **Rule:** Founder should paste concrete output.  
* **Why it exists:** Vague “works/doesn’t work” is not enough.  
* **When to use:** After every verification step.  
* **How to apply:** Ask for exact command output or screenshot.  
* **What to avoid:** Asking “did it work?”

### **Best Practice: Commit small safe milestones**

* **Rule:** Commit after a bounded verified milestone.  
* **Why it exists:** Makes rollback/review manageable without heavy process.  
* **When to use:** After build/diff/API/visual gate passes.  
* **How to apply:** Feature branch commits, then merge when ready.  
* **What to avoid:** Huge mixed commits.

### **Best Practice: Main branch as stable checkpoint**

* **Rule:** Main should represent stable accepted progress.  
* **Why it exists:** Prevents production baseline damage.  
* **When to use:** Always.  
* **How to apply:** Feature branches for AI-risky work.  
* **What to avoid:** Pushing unverified changes to main.

### **Best Practice: Do not trust Windsurf “success” without proof**

* **Rule:** Success requires snippets, build, diff, and relevant runtime/visual evidence.  
* **Why it exists:** Windsurf success statements were often wrong.  
* **When to use:** Always.  
* **How to apply:** Required response format.  
* **What to avoid:** “Acceptance met” without external evidence.

### **Best Practice: If screenshot unchanged, inspect selectors instead of patching blindly**

* **Rule:** One failed visual patch triggers selector/source inspection.  
* **Why it exists:** Prevents CSS churn.  
* **When to use:** Any UI/CSS fix with no visible result.  
* **How to apply:** Inspect JSX className and final winning CSS selector.  
* **What to avoid:** Appending more overrides.

## **6\. Founder / Operator Rules**

Instructions to the founder must be written as operator instructions, not architecture discussions.

Rules:

* Founder should not be asked to architect.  
* Founder should not be asked to manually edit many file blocks.  
* Founder should receive exact copy-paste commands/prompts.  
* Instructions must say where to execute:  
  * CMD  
  * Windsurf  
  * browser  
  * Supabase  
  * Railway  
* Instructions must say whether dev server must be running.  
* Instructions must say what output to paste back.  
* Instructions must be short and linear.  
* Avoid multiple simultaneous terminals unless necessary.  
* If dev server occupies terminal, explicitly say one of:  
  * stop it with `Ctrl+C` and reuse CMD  
  * keep it running and open another CMD  
  * skip dev server and use build/API checks  
* After each step, define stop condition.

Founder instruction format:

This step does: \[objective\].  
Execute in: \[CMD / Windsurf / browser / Supabase / Railway\].  
Dev server: \[not needed / must be running / stop with Ctrl+C\].  
Paste back: \[exact outputs\].  
Stop if: \[condition\].

Do not send the founder:

* long unstructured command blocks  
* multi-window terminal choreography without explanation  
* vague “check it”  
* manual edit instructions across many files  
* prompts mixed with commentary that can be copied incorrectly

## **7\. ChatGPT Architect Rules**

Before giving any implementation instruction, ChatGPT must:

1. Identify the objective.  
2. Classify the task type:  
   * inspect  
   * patch  
   * verify  
   * commit  
   * deploy  
   * product decision  
3. Choose the smallest safe step.  
4. Check whether source state is known.  
5. Check whether Windsurf has failed once.  
6. Decide Windsurf vs direct-source approach.  
7. Define allowed files.  
8. Define forbidden files/changes.  
9. Define acceptance criteria.  
10. Define verification steps.  
11. Prevent scope creep.  
12. Ask for current files when source uncertainty is high.  
13. Not invent file paths.  
14. Not revive stale decisions.

Specific decision rules:

* If source wiring is unknown → inspect-only.  
* If Windsurf failed once → direct-source option check.  
* If more than 5 CMD commands → Windsurf prompt.  
* If visual screenshot unchanged → inspect selectors.  
* If API output is cache hit → do not claim fresh generation verified.  
* If build fails → stop and inspect first error.  
* If unexpected files changed → stop and review diff.

## **8\. Windsurf Prompting Rules**

Windsurf prompt style:

* one complete block  
* boundary markers  
* exact task  
* exact goal  
* exact context  
* exact precheck  
* exact allowed files  
* exact forbidden changes  
* preservation rules  
* old/new snippets required  
* terminal verification required  
* response format required  
* stop conditions required

Mandatory boundaries:

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

\[full prompt\]

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

Rules:

* Inspect-only means no edits.  
* Execution prompt means narrow patch only.  
* Do not allow “cleanup/refactor” unless explicitly scoped.  
* Preserve DOM/classNames unless explicitly allowed.  
* Do not rename props/types casually.  
* Do not stage/commit/push/deploy unless explicitly requested.  
* If target snippet not found, stop and report nearest snippet.  
* If forbidden file must be changed, stop.

Compact reusable prompt skeleton:

\_\_\_\_\_\_\_ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

TASK:  
\[Exact task\]

GOAL:  
\[Concrete outcome\]

CONTEXT:  
\[Branch/current phase/current known state\]

PRECHECK:  
Run:  
\- cd /d C:\\WORK\\KalshiProPulse\\sipropicks-premvp1-1  
\- git branch \--show-current  
\- git status \--short  
\- git diff \--stat  
\- git log \--oneline \-5

EXPECTED:  
\- branch: \[expected\]  
\- dirty files: \[expected\]

ALLOWED FILES:  
\- \[file\]

FORBIDDEN FILES / CHANGES:  
\- Do not edit \[file\]  
\- Do not refactor  
\- Do not stage/commit/push/deploy

EXACT TASKS:  
1\. \[task\]  
2\. \[task\]

PRESERVATION RULES:  
Do not rename classNames.  
Do not change DOM nesting.  
Do not rewrite working layout.  
Only perform requested change.  
If this requires forbidden changes, STOP.

ACCEPTANCE CRITERIA:  
1\. \[binary criterion\]  
2\. \[binary criterion\]

TERMINAL VERIFICATION REQUIRED:  
Run:  
\- npm run build  
\- git status \--short  
\- git diff \--stat  
\- git diff \--check

RESPONSE FORMAT REQUIRED:  
1\. Precheck  
2\. Files changed  
3\. Exact old/new snippets  
4\. Terminal verification  
5\. Acceptance status  
6\. Risks/assumptions  
7\. Stop conditions

STOP CONDITIONS:  
\- Wrong branch  
\- Unexpected dirty files  
\- Target block missing  
\- Build fails  
\- Forbidden file required

\_\_\_\_\_\_\_ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF \_\_\_\_\_\_\_

## **9\. Source-of-Truth Rules**

Hierarchy of truth:

1. Actual current source files.  
2. Git branch/status/log.  
3. Build/API/browser/Supabase verification.  
4. Screenshots.  
5. Recently accepted user confirmation.  
6. Project source-of-truth files.  
7. Old chat memory.  
8. Windsurf summary.

Rules:

* Old chat memory is useful but not authoritative.  
* Current source map must be refreshed from Windsurf inspect-only when uncertain.  
* Project files must be updated after major phase changes.  
* Decisions must not be inferred from old branches.  
* If inspected source contradicts memory, source wins.  
* If production behavior contradicts local behavior, investigate deployment/cache/environment before coding more.  
* If an uploaded/project file is stale, refresh from source.

Active source-of-truth files:

* `PROJECT_CONTEXT_CURRENT.md`  
* `WINDSURF_WORKFLOW_RULES.md`  
* `CURRENT_TECH_STATE.md`  
* `PRODUCT_DECISIONS_LOCKED.md`  
* `CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
* `PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`

## **10\. Visual/UI Work Rules**

Mobile-first viewport assumptions:

* Primary:  
  * `390×700`  
  * `428×760`  
* Secondary:  
  * `390×844`  
  * `428×926`

Rules:

* Visual check required for UI work.  
* Build passing is not visual acceptance.  
* CSS Modules/global CSS must be handled carefully.  
* Inspect active JSX classNames before CSS patch.  
* Inspect final winning selector before changing CSS.  
* Avoid broad layout changes.  
* Preserve existing JSX structure.  
* Do not rename classNames.  
* Do not add/remove wrapper divs unless explicitly approved.  
* Modal styling should remain isolated unless task requires otherwise.  
* Do not degrade card readability for pixel-perfect pursuit.  
* 85–90% visual closeness \+ 100% readability beats fragile 100% copy.  
* If visual bug persists after one attempt, switch to source/selector inspection.

Specific project rules:

* Do not use `Reconstruction.module.css` for modal styling unless explicitly required.  
* PassOfferModal styling belongs in `PassOfferModal.module.css`.  
* Do not touch carousel/page/feed files during CSS-only task.  
* Do not change CTA copy unless explicitly requested.  
* Do not treat screenshot mismatch as minor if user flags it.

## **11\. Backend/API Work Rules**

Rules:

* Backend feed work should not touch UI unless scoped.  
* API route work should not touch CSS/components unless scoped.  
* Cache hit may hide new generation behavior.  
* Debug endpoint may use different mapper.  
* Local build is not runtime API verification.  
* Production API verification is separate.  
* If no cache-bypass exists, state limitation instead of pretending verified.  
* Keep `marketSource` backward compatibility while adding `marketSources[]`.  
* Preserve fallback/manual content.  
* Do not remove `marketSource`.  
* Do not require `marketSources[]` without fallback unless migration is explicit.  
* Do not generate `news-pulse` without verified news/context source.  
* Do not claim institutional smart money unless verified.  
* Do not change Supabase schema inside backend generation task unless explicitly scoped.

PREMVP12-specific backend rule:

* `marketSources[0]` must correspond to existing `marketSource`.  
* Evidence stack generation can add optional `sharp-flow` and `market-momentum`.  
* `news-pulse` remains future-only until source exists.

## **12\. Database/Supabase Work Rules**

Rules:

* Supabase verification requires actual SQL/API result.  
* Production lead capture is not proven by localStorage.  
* Do not expose secrets.  
* Identify exact table/fields before changing write path.  
* Verify `lead_intents` inserts when relevant.  
* Treat local and production DB paths separately if applicable.  
* Do not create schema assumptions without checking actual code/DB.  
* Do not query or write a non-existing field such as `market_sources` unless schema exists and is approved.

Known accepted Supabase pattern:

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

Expected premium reserve fields:

* `source = pass_offer_modal`  
* `intent_type = premium_reserve`  
* `plan_id`  
* `plan_name`  
* `plan_price`

## **13\. Git/Release Rules**

Before commit:

git branch \--show-current  
git status \--short  
git diff \--stat  
git diff \--check  
npm run build

Rules:

* Inspect diff before commit.  
* Commit only intended files.  
* Clean working tree before merge/push.  
* Do not push if unexpected files exist.  
* Do not commit if build fails.  
* Do not commit if `git diff --check` reports trailing whitespace.  
* LF/CRLF warnings alone are not trailing whitespace blockers.  
* Build before commit/push.  
* Production verification after deploy.  
* Record commit hash and result.  
* If warnings exist before merge, clean/amend first.  
* Feature branch for AI-risky work.  
* Main branch remains stable checkpoint.  
* Do not push feature work to main until gate is passed.  
* Do not deploy unverified UI changes.

If a commit was made with trailing whitespace:

* Clean whitespace.  
* Run `git diff --check`.  
* Run `npm run build`.  
* Amend existing commit.  
* Do not create a separate cleanup commit unless explicitly approved.  
* Do not merge until clean.

## **14\. Practices Considered Too Heavy / Postponed**

### **Full screenshot naming convention**

* **Why postponed:** Too much process overhead for current PreMVP pace.  
* **When to reconsider:** When UI stabilizes and frequent visual regression checks become valuable.

### **Text regression script**

* **Why postponed:** Current false-positive/edge-case cost is too high.  
* **When to reconsider:** When product copy/UI text becomes stable and releases become frequent.

### **Minimal rollback protocol**

* **Why postponed:** Considered too costly for current founder/operator speed.  
* **When to reconsider:** Before larger production releases or paid-traffic scale-up.

### **Heavy CI/test automation**

* **Why postponed:** Premature before product/feed architecture stabilizes.  
* **When to reconsider:** After feed, payment, and lead flows are stable and regression cost increases.

### **Broad automated QA**

* **Why postponed:** Current failures are better caught by targeted build/diff/API/screenshot checks.  
* **When to reconsider:** When release frequency increases and manual QA becomes bottleneck.

### **Premature admin/auth/payment complexity**

* **Why postponed:** Core feed/lead/evidence validation is still higher priority.  
* **When to reconsider:** After reliable premium intent and initial monetization path are validated.

## **15\. Current Best Workflow For New Phase**

Standard playbook:

1. Read project files:  
   * `PROJECT_CONTEXT_CURRENT.md`  
   * `CURRENT_TECH_STATE.md`  
   * `PRODUCT_DECISIONS_LOCKED.md`  
   * `WINDSURF_WORKFLOW_RULES.md`  
   * `CURRENT_SOURCE_ARCHITECTURE_MAP.md`  
   * this file  
2. If source uncertainty exists, run `CURRENT_SOURCE_ARCHITECTURE_MAP.md` Windsurf inspect-only command.  
3. Define phase objective:  
   * one concrete outcome  
   * active branch  
   * in-scope files  
   * out-of-scope files  
4. Ask Windsurf inspect-only for active files/selectors/data flow if needed.  
5. ChatGPT analyzes Windsurf output.  
6. ChatGPT writes one narrow Windsurf execution prompt.  
7. Windsurf returns:  
   * snippets  
   * build result  
   * git status  
   * diff stat  
   * risks  
8. Founder does visual/business/API/Supabase acceptance depending on task type.  
9. Commit only after gate passes.  
10. Update relevant project files after major accepted phase:  
* tech state  
* product decisions  
* source architecture map  
* workflow lessons if new lesson occurred

## **16\. Red Flags / Stop Immediately Conditions**

Stop and do not continue implementation prompts if:

* Windsurf failed once and source uncertainty remains.  
* Unexpected files changed.  
* Build failed.  
* Screenshot unchanged after claimed UI fix.  
* Dirty working tree contains unknown files.  
* Task grows beyond one zone.  
* Source file paths differ from memory.  
* Production differs from local.  
* User reports “still not changed.”  
* Windsurf output lacks snippets/verification.  
* Prompt would require founder manual multi-file edit.  
* `git diff --check` reports trailing whitespace before commit.  
* API output is cache hit but being treated as fresh generation.  
* Debug endpoint uses a different mapper than the code being verified.  
* Windsurf wants to edit forbidden files.  
* Implementation requires changing product decision not approved by founder.  
* A UI task starts touching backend/API/Supabase.  
* A backend task starts touching CSS/UI.  
* Prompt exceeds reasonable scope and mixes inspect/implementation/deploy.

Required response when stop condition appears:

Stop. Current blocker: \[specific blocker\].  
Next safest action: \[inspect source / upload file / review diff / clean working tree / verify environment\].  
Do not commit/push/deploy.

## **17\. One-Paragraph Operating Doctrine**

PolyProPicks PreMVP development must run as a controlled founder-operator system: the founder operates and accepts, ChatGPT architects and writes bounded prompts, and Windsurf executes or inspects within strict file limits. Current source, Git state, screenshots, API output, and Supabase rows beat memory and tool summaries. Every phase should move by small verified gates: inspect when uncertain, patch narrowly, require snippets and terminal verification, check visuals/API/database separately, commit only intended files, and protect main as a stable checkpoint. After one failed Windsurf attempt, do not continue blindly; perform a direct-source option check. Keep founder commands short and linear, use Windsurf for longer command sequences, and never let broad refactors, CSS churn, cache confusion, or premature platform work derail the current PreMVP objective.

