# 10_DESIGN_SYSTEM_AND_FRONTEND_BASELINE.md — PolyProPicks

> Refreshed: 2026-05-21
> Source: current source files + design pack `docs/design/claude-design-source-pack/`
> Prior 2026-05-15 override block superseded by this refresh.

---

## CURRENT FRONTEND BASELINE — 2026-05-21

```
Active UI phase:         Stable — no active visual blocker known
Last confirmed visual:   NOT VERIFIED since 2026-05-15 (Market Return tile status unknown)
Design pack:             docs/design/claude-design-source-pack/ — ready for Claude Design
Next design task:        Proof of Results card — Claude Design brief + prompt ready
Forbidden during design: Touch PremiumEventCard, MarketSourceCard, PassOfferModal, carousel logic
```

---

## 1. Active Design System Baseline

### Colors (confirmed from source)

| Token | Value | Usage |
|---|---|---|
| Cyan `#18e7ff` | Evidence card stroke, subline, border | MarketSourceCard |
| Green `#8bff4d` / `#54e447` | Change label, trust metric value | MarketSourceCard, trust bar |
| Gold `#fff500` | Gauge, CTA gradient end | PremiumEventCard — DO NOT use in evidence cards |
| White `#f5f7fb` / `#fff` | Headline, primary text | Both cards |
| Dark navy | `linear-gradient(180deg, #071321, #040b16)` | MarketSourceCard background |
| Darker navy | `linear-gradient(180deg, rgba(10,23,38,0.96), rgba(2,9,16,0.98))` | PremiumEventCard background |

### Typography (confirmed from source CSS)

| Element | Size | Weight | Tracking |
|---|---|---|---|
| PremiumEventCard title | 31px | 900 | -0.055em |
| PremiumEventCard gauge number | 47px | 900 | -0.045em |
| PremiumEventCard CTA | 27px | 900 | -0.04em |
| MarketSourceCard headline | 32px | 800 | — |
| MarketSourceCard change label | 18px | 800 | — |
| MarketSourceCard subline | 18px | — | — |

### Borders / radius

| Component | Border | Radius |
|---|---|---|
| PremiumEventCard | `1.5px solid rgba(193,167,62,0.55)` — gold | 30px |
| MarketSourceCard | `1.5px solid rgba(24,231,255,0.62)` — cyan | 22px desktop / 18px mobile |

---

## 2. Claude Design Source Pack

**Location:** `docs/design/claude-design-source-pack/`
**Upload ZIP:** `docs/design/polypropicks-claude-design-source-pack-2026-05-20.zip`
**Backup ZIP:** `docs/design/polypropicks-claude-design-source-pack-FULL-BACKUP-2026-05-20.zip`

**Files in upload ZIP (what Claude Design gets):**
- `01_STYLE_BASELINE_2026-05-20.md`
- `03_MARKET_SOURCE_CARD_SPEC.md`
- `04_PREMIUM_EVENT_CARD_SPEC.md`
- `05_DESIGN_TOKENS_EXTRACTED.md`
- `06_PROOF_OF_RESULTS_CARD_BRIEF.md`
- `07_CLAUDE_DESIGN_PROMPT_PROOF_OF_RESULTS.md`
- `source-snippets/MarketSourceCard.tsx.txt`
- `source-snippets/MarketSourceCard.module.css.txt`
- `screenshots/README_REQUIRED_SCREENSHOTS.md`

**Screenshots still required:** 7 screenshots listed in `screenshots/README_REQUIRED_SCREENSHOTS.md`. Manual capture in Chrome DevTools. Not yet captured.

---

## 3. MarketSourceCard Status

- **Component:** `components/cards/MarketSourceCard.tsx` — DO NOT MODIFY
- **CSS:** `components/cards/MarketSourceCard.module.css` — DO NOT MODIFY
- **Current card types:** `market-source`, `market-momentum`, `sharp-flow` (active); `news-pulse` (defined, not generated)
- **Planned card type:** `proof-of-results` (NEW — pending Claude Design → Claude Code handoff)
- **Dimensions:** min-width 336px, max-width 782px, min-height 178px, border-radius 22px

---

## 4. PremiumEventCard Status

- **Component:** `components/cards/PremiumEventCard.tsx` — DO NOT TOUCH
- **CSS:** `components/cards/PremiumEventCard.module.css` — DO NOT TOUCH
- **Gold gauge:** CSS `--gauge-angle` var, `#fff500` conic-gradient
- **CTA:** `linear-gradient(100deg, #85e7a6, #d9ed60, #fff500)`, min-height 82px
- **Trust bar:** `linear-gradient(90deg, #23e6bb, #61ef4a, #fff500)`

---

## 5. How Claude Design Should Consume the Pack

1. Upload `polypropicks-claude-design-source-pack-2026-05-20.zip` to Claude Design
2. Paste prompt from `07_CLAUDE_DESIGN_PROMPT_PROOF_OF_RESULTS.md`
3. Claude Design produces Variant A (compact trust proof) and Variant B (analytical 5-dot)
4. Founder reviews, annotates preferred variant with any copy changes
5. Hand off to Claude Code using `08_CLAUDE_CODE_HANDOFF_AFTER_DESIGN.md`
6. Claude Code creates ONLY `ProofOfResultsCard.tsx` + `ProofOfResultsCard.module.css`
7. Claude Code does NOT modify `MarketSourceCard`, `PremiumEventCard`, `PassOfferModal`

---

## 6. What Must Not Change During Design/UI Work

- `app/globals.css` — do not touch
- `components/cards/PremiumEventCard.tsx` + CSS
- `components/cards/MarketSourceCard.tsx` + CSS
- `components/modals/PassOfferModal.tsx` + CSS
- `components/carousels/MarketSourceCarousel.tsx` (unless evidence rotation phase explicitly opens)
- Gold/yellow colors — reserved for PremiumEventCard only
- Any payment/auth/backend API files during frontend work

---

## 7. Visual Identity Summary

The product must feel like:
- Premium sports signal interface / prediction-market edge scanner
- Mobile-first, dark fintech/betting style
- High-value locked feed, not generic SaaS
- Cards are the product surface, not decoration
- Neon/cyan/green/gold accent language

Must not feel like:
- Generic blog or free picks site
- Heavy trading terminal
- News aggregator
