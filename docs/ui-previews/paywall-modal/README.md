# Paywall Modal — UI Preview

Static HTML sandbox for testing layout changes before touching production React components.

## How to open

```
start docs\ui-previews\paywall-modal\index.html
```

Or double-click the file in Explorer. No server required — fully self-contained.

## Width switcher

Three buttons at the top: **390px** / **428px** / **auto** — click to switch shell width.

## What is being tested

| Area | Experimental change |
|---|---|
| Top area | Removed overlay top-cyan radial gradient and backdrop top-left radial that created a floating curved chrome arc above the LIVE EDGE LOCKED pill. Shell inner glow moved from `48% 32%` to `48% 58%` so it no longer bleeds into the header zone. |
| Benefits | Compact proof-strip chips with **full production phrases**: `ENTER · SKIP · WAIT per market`, `Signals 2–4h before odds move`, `Injury + lineup risk layer`, `Whale-flow evidence`, `Sharp market consensus checks`. 3 rows, 2-column where phrases fit, cyan dot per chip, no heavy bordered card. |
| Chart height | Reduced from `178px` → `154px` to give benefits section room without touching plan cards or headline. |

## Mock data used

- Hero: `1/2 WON` · `CUMULATIVE P&L +19.8%`
- Chart: baseline → `-100%` loss (red segment) → `+120%` recovery (cyan segment)
- Chips: `✕ −100%` · `✓ +120%` · `· —` (placeholder)
- Plans: 7-Day Premium $15 (selected) · Monthly Pro $49

## What is explicitly NOT being tested

- Headline typography or sizing
- Plan card sizes, heights, or selected-state glow
- CTA design or copy
- Chart data logic or API contract
- Pricing card selected border color (`#d9f04a`)
- Modal copy outside benefits section
- Any production React component, CSS Module, or API route
