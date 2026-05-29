# Visual Matrix Runner

Captures screenshots of PolyProPicks across 9 mobile viewports and generates
a `contact-sheet.html` for rapid visual QA review before design decisions.

---

## What it is

The Visual Matrix Runner is a local development tool that:

1. Launches a headless Chromium browser via Playwright.
2. Visits a target URL at 9 common mobile viewport sizes.
3. Takes a visible-viewport screenshot at each size (no full-page scroll).
4. Injects animation-kill CSS so screenshots are stable and noise-free.
5. Generates a dark-mode `contact-sheet.html` with all viewports in a grid.
6. Generates `metadata.json` with run details for traceability.

Output lands in `visual-runs/YYYY-MM-DD_HH-mm-ss_LABEL/`.

---

## How to run

### Production snapshot (most common)

```bash
npm run visual:matrix -- --url=https://polypropicks.com --label=prod-home
```

### Local dev snapshot

Start the dev server first (`npm run dev`), then:

```bash
npm run visual:matrix -- --url=http://localhost:3000 --label=local-home
```

### Custom page

```bash
npm run visual:matrix -- --url=https://polypropicks.com/premium --label=prod-premium
```

---

## Output files

| File | Purpose |
|---|---|
| `01_360x780.png` … `09_432x960.png` | Individual viewport screenshots |
| `contact-sheet.html` | Open in browser — shows all viewports in a grid |
| `metadata.json` | Machine-readable run metadata |

### Opening the contact sheet

Double-click `contact-sheet.html` or open it in a browser.
Images are referenced by relative path — keep them in the same folder.

---

## Viewports captured

| # | Size | Device reference |
|---|---|---|
| 01 | 360×780 | Android (common) |
| 02 | 375×667 | iPhone SE / 8 |
| 03 | 375×812 | iPhone X / 11 Pro |
| 04 | 390×844 | iPhone 12 / 13 |
| 05 | 393×852 | iPhone 15 Pro |
| 06 | 414×896 | iPhone XR / 11 |
| 07 | 428×926 | iPhone 12 Pro Max |
| 08 | 430×932 | iPhone 14 Plus |
| 09 | 432×960 | Android (large) |

---

## Important: visual acceptance rules

- **This tool is visual review support only.**
- It captures what is currently deployed or running locally.
- It does NOT make product, design, or acceptance decisions.
- **Gate 2 (visual/business acceptance) still requires an explicit founder decision.**
- No commit, deploy, or approval is automated by this script.

After reviewing the contact sheet, the founder communicates the Gate 2 result:

```
GATE 2 RESULT:
contact sheet opened: YES/NO
obvious broken viewport(s): [list or none]
decision: accept tooling / rerun matrix / fix tooling
```

---

## Folder structure

```
visual-runs/
  2026-05-29_14-30-00_prod-home/
    01_360x780.png
    02_375x667.png
    ...
    09_432x960.png
    contact-sheet.html
    metadata.json
```

`visual-runs/` is in `.gitignore` (or should be added) — screenshots are
local artifacts and are not committed to the repo.
