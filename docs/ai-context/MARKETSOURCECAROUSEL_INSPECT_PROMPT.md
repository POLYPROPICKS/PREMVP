# MARKETSOURCECAROUSEL_INSPECT_PROMPT.md

<!-- ACTIVATION POINT: Paste into Claude Code before any MarketSourceCarousel implementation -->
<!-- TOKEN LOADING RULE: Tier 1 — use once per UI phase start. Not a permanent artifact. -->
<!-- OWNER: Founder pastes into Claude Code; Claude Code returns inspect evidence only -->
<!-- STOP/REJECT CONDITION: Claude Code must NOT edit any files in this task -->

---

## HOW TO USE

Copy the block between ═══ lines and paste into Claude Code as the first message.
Claude Code must return inspect evidence only — no edits.

---

═══════════════════════════════════════════════════
CLAUDE CODE TASK

TASK TYPE: inspect-only
MODEL: Sonnet 4.6 Adaptive

GOAL:
Map current wiring of MarketSourceCarousel evidence-stack before any implementation.
Return evidence only. Do NOT edit any files.

PRECHECK (run first):
  git branch --show-current
  git status --short
  git log --oneline -3

STOP if:
  - Branch is not main
  - git status shows unexpected dirty files outside app/reconstruction/
  - Any file requires editing to answer the questions below

FILES TO INSPECT (read-only):
  app/reconstruction/page.tsx
  components/carousels/MarketSourceCarousel.tsx  (if exists)
  components/cards/MarketSourceCard.tsx           (if exists)
  lib/feed/landingPairs.ts
  lib/feed/types.ts
  lib/feed/buildLandingCards.ts                   (first 60 lines only)

DO NOT INSPECT (backup files — ignore entirely):
  page.before-*.tsx
  page.broken.tsx
  page.phase1-trust-before.tsx
  Reconstruction.module.before-*.css
  Reconstruction.module.broken.css
  Reconstruction.module.phase1-trust-before.css

FORBIDDEN:
  - Do NOT edit any file
  - Do NOT create any file
  - Do NOT commit or push
  - Do NOT touch lib/feed/buildSportsLandingCards.ts
  - Do NOT touch payment/auth/Supabase config

INSPECT AND ANSWER THESE QUESTIONS:

1. ACTIVE PAIR STATE
   - How is the active LandingPair selected in page.tsx?
   - What variable/state holds activePairId or active pair index?
   - What triggers a pair change (swipe, button, auto)?

2. EVIDENCE STACK WIRING
   - How is marketSources[] passed to MarketSourceCarousel?
   - Is there an activeEvidenceIndex or similar state?
   - Does evidence reset when active pair changes?

3. MARKETSOURCECAROUSEL CURRENT PROPS
   - List all current props of MarketSourceCarousel component
   - What data does it receive: marketSource (singular) or marketSources[] (array)?
   - Is backward-compatible marketSource prop still present?

4. MARKETSOURCECARD CURRENT PROPS
   - List all current props of MarketSourceCard
   - What evidence types are rendered: market-source / market-momentum / sharp-flow / news-pulse?

5. LOCK / PAYWALL STATE
   - How does locked state propagate to carousel/cards?
   - Does swipe on locked card open PassOfferModal?
   - Does locked swipe change the active pair?

6. POLYMARKET LINK (recent UI commits)
   - What was added in eb52988, a7c444e, 1b36f07?
   - Where exactly in page.tsx or Reconstruction.module.css?

7. IMPORT GRAPH CHECK
   - Is lib/feed/buildSportsLandingCards.ts imported anywhere in page.tsx or components?
   - (Check imports only — do not read full file)

REQUIRED RESPONSE FORMAT:

PRECHECK:
  branch: [output]
  status: [output]
  log: [output]

FILES INSPECTED:
  - [path] — [found / not found]

ANSWERS:
  1. Active pair state: [findings]
  2. Evidence stack wiring: [findings]
  3. MarketSourceCarousel props: [findings]
  4. MarketSourceCard props: [findings]
  5. Lock/paywall state: [findings]
  6. Polymarket link changes: [findings]
  7. buildSportsLandingCards imports: [found / not found]

SMALLEST SAFE NEXT PATCH:
  [one recommended first implementation step based on findings]

RISKS:
  [list]

NO FILES EDITED.
NO COMMIT. NO PUSH.

Gate 1: N/A — inspect-only
═══════════════════════════════════════════════════
