# CONTEXT_HANDOFF_TEMPLATE.md — PolyProPicks Chat Handoff

<!-- ACTIVATION POINT: Fill and paste at start of every new chat session -->
<!-- TOKEN LOADING RULE: Use as chat starter. Tier 0 for new sessions. -->
<!-- OWNER: Founder fills §1–3; Claude fills §4–6 at session end -->
<!-- REQUIRED OUTPUT FIELD: Next chat must confirm receipt of §1–3 before acting -->
<!-- STOP/REJECT CONDITION: New chat must not start implementation without confirmed handoff -->

---

## HOW TO USE

**Ending a chat:** ask Claude to fill §4–6, then save the completed block.
**Starting a new chat:** paste this entire filled block as your first message.
**New Claude must:** confirm each field before any implementation.

---

## § 1. Git state (verified — not summary)

```
Branch:
HEAD commit hash + message:
git status --short output:
Local ahead of origin by: [N commits / 0]
Last push: [done / not done]
```

## § 2. Active task state

```
Current phase/task:
Task type: [CMD-verification / inspect-only / exact-patch / backend-API / frontend-UI / docs-context]
Allowed files for next action:
Forbidden files:
Blocked by:
Next exact action:
```

## § 3. Open risks and pending verification

```
NEEDS VERIFICATION:
- [ ] [item]
- [ ] [item]

Known dirty/uncertain state:
Assumptions (not verified):
- ASSUMED: [what] because [why uncertain]
```

## § 4. Locked decisions relevant to next session

```
(copy exact lines from 04_PRODUCT_DECISIONS_LOCKED.md — no summaries)
-
```

## § 4b. Claude Design → Claude Code handoff (fill when handing off design output)

```
Claude Design session date:
Variant selected: [A / B / modified]
Copy changes annotated: [YES / NO — list changes]
New card name: [e.g. ProofOfResultsCard]
Allowed implementation files:
  - components/cards/ProofOfResultsCard.tsx  (CREATE)
  - components/cards/ProofOfResultsCard.module.css  (CREATE)
  - [optional: content/marketSources.ts — add card type]
  - [optional: lib/feed/types.ts — add card type]
  - [optional: app/reconstruction/page.tsx — wire render]
Forbidden files:
  - components/cards/MarketSourceCard.tsx
  - components/cards/PremiumEventCard.tsx
  - components/modals/PassOfferModal.tsx
  - lib/feed/buildLandingCards.ts
  - app/globals.css
Acceptance criteria:
  - npm run build passes
  - git diff --stat shows only new files
  - No gold/yellow introduced
  - No win rate % or profit claim in copy
  - Visual confirmed at 390px
```

## § 5. Forbidden changes for next session

```
Do NOT touch:
Do NOT push until:
Do NOT merge until:
Do NOT implement:
```

## § 6. Completed in this session

```
Commits made:
  - [hash] [message]
Files changed:
Build state: PASS / FAIL / NOT RUN
Runtime verified: YES / NO — [endpoint + result]
Gate 1: PASS / FAIL / NOT RUN
Gate 2 (visual): PASS / NOT REQUIRED / PENDING FOUNDER
Pushed to origin: YES / NO
```

---

> ⚠️ EXAMPLE ONLY — DO NOT USE AS CURRENT STATE.
> Claude must ignore this block unless founder explicitly says "use this as current state".
> This example reflects a past session. Always request fresh git output before acting.

## FILLED EXAMPLE (past session — 14.05.2026)

```
§ 1. Git state
Branch: main
HEAD: af4ed5e Cron: switch to buildLandingCards, persist marketSources in cache
git status --short: clean
Local ahead of origin: 0 (synced)
Last push: done

§ 2. Active task state
Current phase: PREMVP — cron switched to buildLandingCards; runtime verification pending
Task type: backend-API verification
Allowed files: scripts/generate-signals.ts, lib/feed/cacheGeneratedSignals.ts
Forbidden files: UI/CSS, payment, Supabase schema (already migrated)
Blocked by: runtime fresh-generation not yet verified
Next exact action: verify /api/feed/debug-evidence-generation returns cacheBypassed:true + pairCount>0

§ 3. Open risks
NEEDS VERIFICATION:
- [ ] Fresh generation via buildLandingCards confirmed (debug endpoint)
- [ ] market_sources column populated after cron run
- [ ] No futures/outrights in fresh output

ASSUMED: market_sources Supabase column exists (founder confirmed add)

§ 4. Locked decisions
- LandingPair is canonical unit
- PremiumEventCard is master signal card
- marketSource backward compatibility required
- marketSources[] evidence stack must be preserved
- Whop first, Stripe later, provider-neutral
- Free signal visible without forced login

§ 5. Forbidden changes
Do NOT touch: UI/CSS, PassOfferModal, payment/auth
Do NOT push until: runtime fresh-gen verified
Do NOT implement: Stripe/auth/admin

§ 6. Completed this session
Commits:
  - 39ab5aa Add enforcement contour backbone
  - 26fb50d Add gitignore for debug/cache json artifacts
  - af4ed5e Cron: switch to buildLandingCards, persist marketSources
Build: PASS (inferred from commit)
Runtime verified: NO — NEEDS VERIFICATION
Gate 1: PASS
Gate 2: NOT REQUIRED (no UI)
Pushed: YES
```

---

## NEW CHAT ACTIVATION RULES

New Claude must output before any action:

```
HANDOFF RECEIVED:
Branch confirmed: [branch]
HEAD confirmed: [hash]
Git status: clean / dirty — [files]
Next task confirmed: [task]
Allowed files confirmed: [list]
Forbidden files confirmed: [list]
Open risks noted: [list]
Ready to proceed: YES / NO — [if NO: what is missing]
```

If any §1–3 field is empty or says NEEDS VERIFICATION:
→ ask founder for the missing value before proceeding.
→ do NOT assume or infer missing git/runtime state.
