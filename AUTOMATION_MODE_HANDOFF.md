> STATUS: Tier 4 — Archive/Reference. Superseded by CLAUDE.md + AGENTS.md backbone.
> Executor updated from Windsurf to Claude Code. Rules remain compatible.
> Read only when working with Windsurf-specific features (worktree, browser preview).# PolyProPicks Automation Mode Handoff

## Purpose

This file informs future LLM architects and coding agents about the updated PolyProPicks development workflow.

The goal is to reduce founder/operator load and avoid repeating long manual CMD/check/build/commit loops.

This file complements:
- `AGENTS.md` 
- `PROJECT_CONTEXT_CURRENT.md` 
- `WINDSURF_WORKFLOW_RULES.md` 
- `CURRENT_TECH_STATE.md` 
- `PRODUCT_DECISIONS_LOCKED.md` 
- `CURRENT_SOURCE_ARCHITECTURE_MAP.md` 
- `_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md` 

`AGENTS.md` is the always-on Windsurf/Cascade rule file.
This file is the human/LLM architect handoff for the new automation workflow.

## Current Automation Baseline

Root-level `AGENTS.md` has been created and committed locally.

Commit:
`5d091e8 Add project agent instructions` 

Known result:
- branch: `main` 
- working tree was clean after commit
- product source files were not changed
- push/deploy were not performed

## New Operating Mode

Use:

**Windsurf Automation-First Mode**

Primary goal:

Reduce founder/operator actions by grouping repetitive CMD checks, build checks, diff checks, verification gates, and commit gates into bounded Windsurf prompts instead of asking the founder to manually run command chains.

Core rule:

The founder is the final visual/business acceptor, not a terminal operator and not a manual code editor.

## Role Model

Founder:
- provides design/product input;
- copies one bounded prompt when needed;
- pastes one structured Windsurf report;
- performs final visual/business/API/Supabase acceptance;
- does not manually edit many files;
- does not run long raw CMD chains unless unavoidable.

ChatGPT / LLM Architect:
- decides smallest safe step;
- writes one bounded Windsurf prompt;
- defines allowed/forbidden files;
- defines acceptance criteria;
- reviews Windsurf output;
- prevents scope creep;
- decides inspect vs execute vs commit vs worktree.

Windsurf/Cascade:
- executor/inspector;
- runs precheck/build/diff/status itself;
- must return exact snippets, build result, git status, diff stat, risks, and stop conditions;
- must not decide product architecture;
- must not refactor broadly.

## Current Windsurf Settings Direction

Use safe automation, not blind unrestricted automation.

Recommended:
- Auto Execution: Allowlist mode by default.
- Turbo only on safe/isolated feature branches or worktrees, not blindly on production/main.
- Deny destructive commands by default.
- Auto-Continue: enable only during bounded prompts, not permanently.
- Cascade Auto-Fix Lints: OFF.
- Windsurf Preview: ON.
- Devin for Terminal Allow/Deny: do not touch unless explicitly using Devin.

## Why Workflows Are Not the Main Solution

Windsurf Workflows can be useful shortcuts, but they do not by themselves reduce founder touches enough.

Do not force the founder to manually run:
- `/premvp-inspect-gate` 
- `/premvp-build-diff-gate` 
- `/premvp-commit-gate` 

for every phase.

The real efficiency gain comes from one bounded task prompt per stage:

precheck → inspect/patch → verify → report

Workflows are optional fallback tools, not the core operating model.

## Worktree Policy

Use Worktree mode for risky UI tasks:
- MarketSourceCarousel UI
- 4 MarketSourceCard designs
- new modal designs
- testimonials sections
- CSS-heavy changes

Do not use Worktree for:
- tiny backend cleanup
- simple git verification
- small one-file non-UI patches
- production/API checks

A Worktree Cascade session must be started in Worktree mode before the first prompt.

Do not merge worktree output back without review.

## Browser Preview / Send Element Policy

Use Windsurf Preview and Send Element to Cascade for UI debugging.

For visual issues:
- do not make the founder describe the DOM in long text;
- use Preview;
- select the exact card/modal/element;
- send it to Cascade as context;
- still require founder visual acceptance.

Use especially for:
- MarketSourceCard
- PremiumEventCard
- PassOfferModal
- locked feed peek
- mobile viewport layout issues

## Quick Review Policy

Use Quick Review / SWE-check only before commit for UI/carousel changes.

It is not a replacement for visual acceptance.

Do not run Quick Review after every micro-change.

## Required Windsurf Prompt Format

Every implementation prompt should be one complete copy-paste block:

_______ НАЧАЛО КОМАНДЫ ДЛЯ WINDSURF _______

[full prompt]

_______ КОНЕЦ КОМАНДЫ ДЛЯ WINDSURF _______

Required sections:
- TASK
- GOAL
- CONTEXT
- PRECHECK
- EXPECTED STATE
- ALLOWED FILES
- FORBIDDEN FILES / FORBIDDEN CHANGES
- EXACT TASKS
- PRESERVATION RULES
- ACCEPTANCE CRITERIA
- TERMINAL VERIFICATION REQUIRED
- RESPONSE FORMAT REQUIRED
- STOP CONDITIONS

## Default Execution Pattern

For uncertain wiring:
1. inspect-only first;
2. return active files/snippets/data flow;
3. recommend smallest next patch;
4. do not edit in the same prompt.

For known implementation:
1. one bounded execution prompt;
2. one zone only;
3. allowed files only;
4. no broad refactor;
5. build/diff/status/checks required;
6. old/new snippets required;
7. human visual/API/Supabase check if relevant.

For commit:
1. commit only after build/diff/status/checks pass;
2. commit only expected files;
3. do not push/deploy without explicit approval.

## Current Product/Architecture Guardrails

Always preserve:

- `LandingPair` is the canonical product unit.
- `PremiumEventCard` is the master signal card.
- `MarketSourceCard` is dependent evidence.
- `MarketSourceCarousel` must not become an independent random feed.
- `marketSource` remains backward-compatible.
- `marketSources[]` is the evidence stack.
- `marketSources[0]` should correspond to `marketSource` where possible.
- Evidence must match active PremiumEventCard / active LandingPair.
- Do not create proof/signal mismatch.

## Copy / Claims Guardrails

Do not claim:
- guaranteed profit;
- real calibrated ML;
- real win probability;
- verified news without source;
- verified institutional smart money.

Use:
- `Signal Confidence` 

Do not revive:
- `Win Probability` 

Main CTA remains:
- `Get 5 Free Signals NOW` 

Do not change CTA/pricing/copy unless explicitly scoped.

## Current Recommended Next Step

Next technical/product direction:

MarketSourceCarousel evidence-stack UI.

Do not jump directly into implementation.

Recommended first step:
Use a new Cascade session in Worktree mode and run inspect-only for:
- activePair / activePairId
- activeEvidenceIndex if present
- MarketSourceCarousel props/state
- PremiumEventCarousel control flow
- `app/reconstruction/page.tsx` current state wiring
- `marketSource` / `marketSources[]` UI consumption

Then create one bounded implementation prompt.

## MarketSourceCarousel Target Behavior

MarketSourceCarousel should consume evidence cards from the active LandingPair only.

Changing evidence card:
- changes only upper MarketSource evidence;
- must not change lower PremiumEventCard.

Changing PremiumEventCard:
- changes active pair;
- resets evidence to the first evidence card for that pair.

Locked premium swipe/peek:
- still opens PassOfferModal;
- must not change active pair before unlock.

## Do Not Do

Do not:
- create independent MarketSource browsing;
- browse unrelated evidence from other events;
- touch payment/Supabase/auth/admin unless scoped;
- change CTA copy;
- revive fake ML/win-probability/news/smart-money claims;
- treat build success as visual acceptance;
- trust Windsurf success summary without snippets/build/diff;
- push/deploy without explicit approval.

## Operator Load Target

Target founder/operator load for a phase:

- 1 input/design/spec confirmation
- 1 bounded Windsurf prompt execution
- 1 structured report paste-back
- 1 visual/API/Supabase acceptance step if relevant
- 1 commit/merge/deploy approval step if relevant

Goal:
5–10 controlled interventions per phase, not 50–70 micro-actions.
