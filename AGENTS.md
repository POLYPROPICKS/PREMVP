# PolyProPicks Agent Instructions

These instructions apply to the entire repository.

## Project Identity

PolyProPicks is a mobile-first sports / prediction-market signal product.

The product turns noisy Polymarket-style market data into one clear decision card with supporting market evidence.

Current mode: PreMVP / production prototype.

Primary stack:
- Next.js / React / TypeScript / CSS Modules
- Supabase for lead/reserve/cache data
- Railway production deploy
- Windows CMD preferred over PowerShell

Known repo path:
`C:\WORK\KalshiProPulse\sipropicks-premvp1-1`

Production domain:
`https://polypropicks.com`

## Always Respect Source of Truth

Use current source files, git state, build output, API output, browser behavior, and Supabase rows as truth.

Do not rely on old chat memory or summaries.

If source and memory conflict, inspected source wins.

Useful source-of-truth docs may exist in repo root:
- `PROJECT_CONTEXT_CURRENT.md`
- `WINDSURF_WORKFLOW_RULES.md`
- `CURRENT_TECH_STATE.md`
- `PRODUCT_DECISIONS_LOCKED.md`
- `CURRENT_SOURCE_ARCHITECTURE_MAP.md`
- `_PREMVP_LESSONS_AND_OPERATOR_BEST_PRACTICES.md`

Read them when relevant, but do not edit them unless explicitly asked.

## Roles

Founder:
- Operator and final visual/business acceptor.
- Should not manually edit many files.
- Should not be asked to run long command chains when Cascade can run them.
- Should receive exact outputs to paste back.

ChatGPT / Architect:
- Defines scope, allowed files, forbidden files, acceptance, and next safe step.

Cascade / Windsurf:
- Executor/inspector only.
- Must not decide product architecture.
- Must not broaden scope.
- Must return snippets, diff, build result, risks, and stop conditions.

## Core Product Architecture

`LandingPair` is the canonical product unit.

PremiumEventCard is the master signal card.

MarketSourceCard is dependent evidence.

MarketSourceCarousel must never become an independent random feed.

MarketSource evidence must always match the active PremiumEventCard / active LandingPair.

Do not create proof/signal mismatch.

Correct direction:
- active PremiumEventCard controls active pair.
- active pair controls MarketSource evidence stack.
- `marketSource` remains backward-compatible.
- `marketSources[]` is the evidence stack.
- `marketSources[0]` should correspond to `marketSource` where possible.

## Product Copy / Claims

Do not claim guaranteed profit.

Do not claim real calibrated ML.

Do not call current score a real win probability.

Preferred UI label:
- `Signal Confidence`

Do not revive:
- `Win Probability`

Main landing CTA must remain:
- `Get 5 Free Signals NOW`

Do not change CTA/pricing/copy unless explicitly requested.

Do not generate or display fake verified news evidence.

Do not claim verified institutional smart money.

`news-pulse` is future-only unless a verified news/context source is implemented.

Sharp/whale language must remain proxy-safe.

## Current Approved MarketSource Evidence Types

Only these current visible card types are approved unless explicitly changed:

1. `market-source`
2. `news-pulse` — future-only unless verified source exists
3. `market-momentum`
4. `sharp-flow`

Do not add new visible P0 evidence types casually.

## UI / CSS Rules

Mobile-first checks matter.

Primary target viewports:
- `390x700`
- `428x760`

Secondary:
- `390x844`
- `428x926`

Build passing is not visual acceptance.

Screenshot/browser behavior beats self-report.

Do not redesign UI from scratch.

Do not rename classNames casually.

Do not change DOM nesting for cleanliness.

Do not add/remove wrapper divs unless explicitly required.

Do not rewrite working layout.

For CSS changes:
- identify active JSX className first;
- identify active CSS selector;
- modify only active source selector;
- return old/new snippets;
- run build;
- require visual check.

If screenshot is unchanged after a claimed CSS fix, inspect selectors instead of appending random overrides.

Keep modal styles isolated in:
- `components/modals/PassOfferModal.module.css`

Do not style modal via `app/reconstruction/Reconstruction.module.css` unless explicitly required.

## Feed / API Rules

Backend feed work must not touch UI/CSS unless explicitly scoped.

UI work must not touch feed/Supabase/payment unless explicitly scoped.

Current formula direction:
- deterministic display-grade
- API-lite / cache-first
- Polymarket public data first
- no fake ML

Preserve fallback/manual content.

Do not remove `marketSource`.

Do not make `marketSources[]` required without fallback unless explicitly approved.

Cache hit may hide fresh generation behavior.

Do not treat cache-hit response as proof of fresh generation.

Debug endpoints may use different mappers; verify the actual path being changed.

## Supabase / Lead / Payment Rules

Supabase production rows beat localStorage.

`public.lead_intents` is the active table for lead and premium reserve capture.

Premium reserve fields may include:
- `source`
- `intent_type`
- `plan_id`
- `plan_name`
- `plan_price`
- `plan_source`
- `event_title`
- `position`

Do not change payment, Stripe, auth, admin, lead capture, or Supabase schema unless explicitly scoped.

Payment architecture/audit docs are reference material only.
Do not implement payment changes unless the current task explicitly says payment phase.

## Git / Build / Commit Rules

Before any commit, run:
- `git branch --show-current`
- `git status --short`
- `git diff --stat`
- `git diff --check`
- `npm run build`

Do not commit if build fails.

Do not commit if `git diff --check` reports trailing whitespace.

Do not commit unexpected files.

Do not push unless explicitly instructed.

Do not deploy unless explicitly instructed.

Main branch is a stable checkpoint.

Use feature branches or worktrees for AI-risky UI work.

Commit only after bounded verified milestone.

## Default Verification Commands

Run from repo root:

```cmd
cd /d C:\WORK\KalshiProPulse\sipropicks-premvp1-1
git branch --show-current
git status --short
git diff --stat
git diff --check
git log --oneline -5
npm run build
```

Required Response Format After Code Changes

Return:

Files changed
Whether every changed file was allowed
Exact old/new snippets for changed code
git status --short
git diff --stat
git diff --check
npm run build result
Acceptance criteria status
Human visual/API/Supabase check required
Risks / assumptions
Stop conditions encountered

Do not say "done" or "implemented successfully" without evidence.

Stop Immediately If

Stop and report if:

branch is wrong;
unexpected product files are dirty;
required source block is missing;
forbidden file would need editing;
build fails;
diff check fails;
screenshot contradicts claimed UI result;
source differs from assumed architecture;
task starts growing beyond one zone;
implementation touches payment/Supabase/deploy without explicit scope;
UI task starts touching backend/API;
backend task starts touching CSS/UI;
user has not explicitly authorized commit/push/deploy.

Preferred Working Pattern

For uncertain wiring:

inspect-only first;
report active files/snippets/data flow;
recommend smallest patch;
wait for bounded execution task.

For known narrow patch:

exact replacement preferred;
allowed files only;
no broad refactor;
snippets + build + diff required.

After one failed Windsurf attempt:

perform direct-source option check;
do not keep prompting blindly.

For risky UI work:

prefer Worktree mode;
use Browser Preview / Send Element to Cascade;
still require founder visual acceptance.

For repetitive verification:

Cascade should run checks itself.
Do not force founder to manually run long CMD sequences.
