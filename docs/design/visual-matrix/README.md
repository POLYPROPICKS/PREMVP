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

### Production snapshot — default (mobile preset, most common)

```bash
npm run visual:matrix -- --url=https://polypropicks.com --label=prod-home
```

### Production snapshot — explicit mobile preset

```bash
npm run visual:matrix -- --url=https://polypropicks.com --label=prod-mobile-v2 --preset=mobile
```

Both commands are equivalent. `--preset=mobile` is the default and can be omitted.

### Local dev snapshot

Start the dev server first (`npm run dev`), then:

```bash
npm run visual:matrix -- --url=http://localhost:3000 --label=local-home
```

Or with explicit preset:

```bash
npm run visual:matrix -- --url=http://localhost:3000 --label=local-home --preset=mobile
```

### Custom page

```bash
npm run visual:matrix -- --url=https://polypropicks.com/premium --label=prod-premium --preset=mobile
```

---

## CLI arguments

| Argument | Default | Description |
|---|---|---|
| `--url` | `https://polypropicks.com` | Target URL to capture |
| `--label` | `prod-home` | Run label (used in output folder name) |
| `--preset` | `mobile` | Viewport preset. Only `mobile` is supported. See note below. |

> **Note — desktop/full presets are intentionally deferred.**
> Only `mobile` is currently implemented. Desktop and full-page presets may be
> added in a future task once mobile coverage is stable.
> **Unsupported presets fail intentionally** — passing `--preset=desktop` or
> `--preset=full` will print a clear error and exit non-zero rather than
> silently generating mobile screenshots with misleading metadata.

---

## Output folder

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

| File | Purpose |
|---|---|
| `01_360x780.png` … `09_432x960.png` | Individual viewport screenshots |
| `contact-sheet.html` | Open in browser — shows all viewports in a grid with run metadata |
| `metadata.json` | Machine-readable run metadata (preset, viewport list, timestamps, paths) |

### Opening the contact sheet

Double-click `contact-sheet.html` or open it in a browser.
Images are referenced by relative path — keep them in the same folder.
The contact sheet displays: URL, preset, viewport count, timestamp, and each
viewport label clearly.

---

## Viewports captured (mobile preset)

| # | Size | Device reference |
|---|---|---|
| 01 | 360×780 | Android (common) |
| 02 | 375×667 | iPhone SE / 8 — legacy small-height canary |
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

## visual-runs/ folder

`visual-runs/` is in `.gitignore` — screenshots are local artifacts and are
not committed to the repo.
