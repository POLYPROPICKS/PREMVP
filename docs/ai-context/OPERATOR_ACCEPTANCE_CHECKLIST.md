# OPERATOR_ACCEPTANCE_CHECKLIST.md — PolyProPicks

<!-- ACTIVATION POINT: After Gate 1 passes for any UI/frontend task -->
<!-- TOKEN LOADING RULE: Load for UI tasks only. Tier 1. Not needed for backend-only tasks. -->
<!-- OWNER: Founder only — Claude cannot accept Gate 2 -->
<!-- REQUIRED OUTPUT FIELD: Claude must end every UI patch with exact Gate 2 checklist for founder -->
<!-- STOP/REJECT CONDITION: Gate 2 not completed = task not done, regardless of Gate 1 -->
<!-- MONITORING CHECK: UI task accepted without Gate 2 = compliance violation -->

---

## Founder role (Autopilot mode — 2026-05-21)

Founder's role is **visual/business acceptance only**, not routine CMD operation.
For non-visual tasks: founder copy-pastes Claude Code prompts and reviews proof packages — no CMD required.
Routine git operations (add/commit) are handled by Claude Code when explicitly authorized in the prompt.
Founder CMD is reserved for: Gate 2 visual verification, Railway/Supabase manual gates, production checks, push authorization, emergency recovery.

---

## Gate 2 rule

**Gate 1 (technical) ≠ Gate 2 (visual/business).**

Build passing is not visual acceptance.
Claude Code verdict is not visual acceptance.
Screenshot from Claude is not visual acceptance.
Founder must open browser and verify personally.

---

## § 1. Viewport policy — US mobile coverage

### Tier A — Minimum daily UI check (every UI patch)

```
390×844   iPhone 12/13/14/15 standard
430×932   iPhone 14/15/16 Pro Max / Plus
360×780   Samsung Galaxy S / Android narrow
```

### Tier B — Full mobile acceptance (layout-sensitive tasks)

Use when: above-the-fold layout, CTA visibility, carousel swipe, paywall modal,
first-screen conversion elements are affected.

```
375×667   iPhone SE / small height
375×812   iPhone mini / X-style
390×844   iPhone 12–15 standard
393×852   iPhone 15 Pro / standard-adjacent
414×896   iPhone XR / 11 / older Max
428×926   iPhone 12/13 Pro Max
430×932   iPhone 14/15/16 Pro Max / Plus
360×780   Samsung Galaxy S / Android narrow
412×915   Pixel / Android large
432×960   Samsung Ultra / large Android
```

### Tier C — Launch readiness / Top-15 matrix

Use when: launch-readiness, paywall, lead capture, or conversion-critical task.

```
375×667   iPhone SE
375×812   iPhone mini / X
390×844   iPhone 12–15 standard
393×852   iPhone 15 Pro
414×736   iPhone 8 Plus
414×896   iPhone XR / 11
428×926   iPhone 12/13 Pro Max
430×932   iPhone 14/15/16 Pro Max / Plus
360×740   Samsung mid-range
360×780   Samsung Galaxy S
384×854   Android mid-range
393×873   Android standard
412×915   Pixel / Android large
432×960   Samsung Ultra
480×1040  Large Android / foldable cover
```

### Viewport selection rules

```
Rule 1: If UI patch affects above-the-fold layout, CTA visibility, carousel swipe,
        paywall modal, or first-screen conversion → use Tier B (Full), not Tier A.

Rule 2: If task is launch-readiness, paywall, lead capture, or conversion-critical
        → use Tier C (Top-15).

Rule 3: Do NOT optimize for one viewport alone.
        If fixing one viewport breaks another Tier A/B viewport → task is FAIL
        until reconciled across all affected viewports.
```

---

## § 2. MarketSourceCarousel — Gate 2 checklist

Use after any MarketSourceCarousel / MarketSourceCard UI change.

```
GATE 2 — MarketSourceCarousel

Gate 2 level: Full mobile acceptance (Tier B) — carousel swipe is layout-sensitive
Minimum check: 390×844 + 430×932 + 360×780
Full check: all Tier B viewports

[ ] Carousel renders without horizontal overflow
[ ] Active card is visually distinct (highlighted / selected state)
[ ] Evidence cards match active PremiumEventCard (not random)
[ ] Swiping evidence card does NOT change PremiumEventCard below
[ ] Changing PremiumEventCard resets evidence to card 1
[ ] No layout shift when switching cards
[ ] Card text not truncated unexpectedly
[ ] Locked premium swipe → PassOfferModal opens (does not change active pair)
[ ] No console errors visible in browser DevTools
[ ] If active signal has only one evidence card: carousel does not show fake/random extra cards
[ ] If marketSources[] is missing or empty: primary marketSource fallback renders correctly (no blank card, no crash)

GATE 2 VERDICT: PASS / FAIL — [describe what is wrong]
```

---

## § 3. PremiumEventCard — Gate 2 checklist

Use after any PremiumEventCard change.

```
GATE 2 — PremiumEventCard

Gate 2 level: Full mobile acceptance (Tier B) — CTA visibility is conversion-critical
Minimum check: 390×844 + 430×932 + 360×780
Full check: all Tier B viewports

[ ] Signal Confidence score visible and formatted correctly
[ ] Team names / event title not truncated
[ ] CTA button visible without scrolling
[ ] CTA text: "Get 5 Free Signals NOW" (unchanged)
[ ] Card swipe works (if applicable)
[ ] Locked state shows peek + blur correctly
[ ] Free signal (first card) visible WITHOUT login

GATE 2 VERDICT: PASS / FAIL — [describe what is wrong]
```

---

## § 4. PassOfferModal — Gate 2 checklist

Use after any PassOfferModal change.

```
GATE 2 — PassOfferModal

Gate 2 level: Launch readiness / Top-15 (Tier C) — paywall is conversion-critical
Minimum check: 390×844 + 430×932 + 360×780
Launch check: all Tier C viewports

[ ] Modal opens on locked feed tap
[ ] Modal does not open on free signal tap
[ ] Modal closes on secondary CTA / dismiss
[ ] Pricing copy unchanged (matches 04_PRODUCT_DECISIONS_LOCKED.md)
[ ] No layout overflow on small viewport
[ ] Active pair NOT changed by modal open/close
[ ] Free CTA / reserve flow NOT replaced by checkout (unless explicitly scoped in this task)
[ ] No payment/checkout language in free signal CTA flow (unless explicitly approved)
[ ] If task touches reserve submission logic: Supabase write verified separately — not part of this Gate 2

GATE 2 VERDICT: PASS / FAIL — [describe what is wrong]
```

---

## § 5. General UI — Gate 2 checklist

Use for any other UI/CSS change.

```
GATE 2 — General UI

Gate 2 level: Minimum daily check (Tier A) unless layout-sensitive
Minimum check: 390×844 + 430×932 + 360×780
Upgrade to Tier B if: above-fold layout, CTA, modal, or swipe affected

[ ] Changed element renders as expected
[ ] No unintended layout shifts in surrounding elements
[ ] No text truncation or overflow
[ ] Mobile scroll behavior unchanged
[ ] No console errors
[ ] Screenshot matches intended design

GATE 2 VERDICT: PASS / FAIL — [describe what is wrong]
```

---

## § 6. What Claude must output at end of every UI task

Claude must end every UI patch response with:

```
GATE 2 REQUIRED — Founder visual check:
Checklist: [§2 / §3 / §4 / §5]
Gate 2 level: [Minimum Tier A / Full Tier B / Launch Tier C]
Viewports to check: [list from selected tier]
Environment: LOCAL (http://localhost:3000) — before commit
             PRODUCTION (https://polypropicks.com) — after deploy, separate check
Check: [specific elements to verify for this task]
If screenshot unchanged after claimed CSS fix: inspect selectors, do not add overrides.
If one viewport fixed but another breaks: task is FAIL — reconcile before accepting.
```

**Local vs production Gate 2 rules:**
- Local Gate 2 = verify before commit (uncommitted changes on dev server)
- Production Gate 2 = verify after deploy (separate check, after push + Railway deploy)
- Do NOT use production check to approve uncommitted local changes
- Do NOT use local check as production proof after deploy
- Both gates may be required for launch-critical or paywall tasks

## § 6A. Founder paste-back result format

After Gate 2 check, paste this back to Claude Chat:

```
GATE 2 RESULT:
Gate 2 level used: [Minimum / Full / Launch Top-15]
Viewports checked: [list]
Failed viewport(s): [list or "none"]
Screenshot attached: YES / NO
Founder decision: [accept / rerun inspect-only / revert]
```

---

## § 7. If Gate 2 fails

```
IF: element wrong / layout broken / screenshot unchanged
THEN:
  1. Do NOT append random CSS overrides
  2. Run inspect-only task: identify active JSX className → active CSS selector
  3. Patch only confirmed active selector
  4. Re-run Gate 1 + Gate 2

IF: CTA copy changed / pricing changed / locked state broken
THEN:
  1. STOP — check 04_PRODUCT_DECISIONS_LOCKED.md
  2. Revert if locked decision violated
  3. Do not proceed without founder approval
```

---

## § 8. Worktree policy for risky UI tasks

Use Windsurf Worktree mode for:
- MarketSourceCarousel full redesign
- PassOfferModal redesign
- New card layout
- CSS-heavy multi-file changes

Do NOT use Worktree for:
- Single CSS property fix
- Small one-file component change
- Text/copy change only

Worktree session must be started before first prompt.
Do not merge worktree output without Gate 1 + Gate 2 both passing.
