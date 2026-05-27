# PolyProPicks — Unified Brand Logo Drop-in

**For Claude Code:** install this folder once. Then use the React helpers + tags below in **every** place the app currently renders a "PP" placeholder, an inline letter mark, or a missing favicon. No design exceptions — one logo, all surfaces.

---

## What's in this package

| File                      | Size       | Use                                                |
|---------------------------|------------|----------------------------------------------------|
| `favicon-16.png`          | 16×16      | Browser tab icon (legacy / small)                  |
| `favicon-32.png`          | 32×32      | Browser tab icon (modern)                          |
| `favicon-48.png`          | 48×48      | Windows / pinned-tab icon                          |
| `apple-touch-icon.png`    | 180×180    | iOS home-screen icon                               |
| `icon-192.png`            | 192×192    | PWA / Android home-screen                          |
| `icon-512.png`            | 512×512    | PWA splash, Android adaptive                       |
| `logo-24.png`             | 24×24      | Tooltip / inline body icon                         |
| `logo-header-32.png`      | 32×32      | Mobile header (1×)                                 |
| `logo-header-64.png`      | 64×64      | Mobile header (2× — display at 32 px)              |
| `logo-header-128.png`     | 128×128    | Desktop header / 3× phones                         |
| `logo-128.png`            | 128×128    | Premium / Referral inline (1×)                     |
| `logo-256.png`            | 256×256    | Premium / Referral hero (display ~96 px)           |
| `logo-512.png`            | 512×512    | Premium / Referral hero (3× retina)                |
| `logo-master-1024.png`    | 1024×1024  | Master export — use for any new derivative size    |
| `_source-1254.png`        | 1254×1254  | Untouched original — keep for archival only        |
| `manifest.webmanifest`    | —          | PWA manifest with all icon refs wired up           |

All PNGs share the same square circular-glow design on a black field — safe on any dark surface.

---

## 1) Drop the files in

Move every file **except** `_source-1254.png` (archival) into `public/brand/` (or whatever your static-assets folder is). Final paths should be:

```
public/
  brand/
    favicon-16.png
    favicon-32.png
    favicon-48.png
    apple-touch-icon.png
    icon-192.png
    icon-512.png
    logo-24.png
    logo-header-32.png
    logo-header-64.png
    logo-header-128.png
    logo-128.png
    logo-256.png
    logo-512.png
    logo-master-1024.png
    manifest.webmanifest
```

Update `manifest.webmanifest` paths if your static prefix isn't `/brand/`.

---

## 2) Wire the favicon + PWA manifest into `<head>`

In the root layout (Next.js `app/layout.tsx`, `_document.tsx`, or whatever the host uses), add:

```tsx
<link rel="icon"             type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
<link rel="icon"             type="image/png" sizes="16x16" href="/brand/favicon-16.png" />
<link rel="apple-touch-icon" sizes="180x180"               href="/brand/apple-touch-icon.png" />
<link rel="manifest" href="/brand/manifest.webmanifest" />
<meta name="theme-color" content="#02060d" />
```

If using Next.js App Router, prefer the file-based convention:
- `app/icon.png` ← rename `favicon-32.png`
- `app/apple-icon.png` ← rename `apple-touch-icon.png`
…and delete the corresponding `<link>` tags. Next will inject the right markup.

---

## 3) Replace **every** existing brand mark with the React component below

Create `src/components/brand/Logo.tsx`:

```tsx
import Image from "next/image"; // or a plain <img> if not Next

type LogoSize = "tooltip" | "header" | "default" | "hero";

const VARIANTS: Record<LogoSize, { px: number; src1x: string; src2x: string }> = {
  tooltip: { px: 16, src1x: "/brand/logo-24.png",        src2x: "/brand/logo-24.png"        },
  header:  { px: 28, src1x: "/brand/logo-header-32.png", src2x: "/brand/logo-header-64.png" },
  default: { px: 56, src1x: "/brand/logo-128.png",       src2x: "/brand/logo-256.png"       },
  hero:    { px: 96, src1x: "/brand/logo-256.png",       src2x: "/brand/logo-512.png"       },
};

interface Props {
  size?: LogoSize;
  className?: string;
  withWordmark?: boolean;
}

export function Logo({ size = "header", className, withWordmark = false }: Props) {
  const v = VARIANTS[size];
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 10 }}
    >
      <img
        src={v.src1x}
        srcSet={`${v.src1x} 1x, ${v.src2x} 2x`}
        alt="PolyProPicks"
        width={v.px}
        height={v.px}
        style={{ display: "block", borderRadius: "50%" }}
        draggable={false}
      />
      {withWordmark && (
        <span
          style={{
            fontWeight: 900,
            letterSpacing: "-0.03em",
            color: "#fff",
            fontSize: size === "hero" ? 28 : size === "default" ? 20 : 16,
            lineHeight: 1,
          }}
        >
          PolyProPicks
        </span>
      )}
    </span>
  );
}
```

### Where to use each variant

| Variant   | Where                                                                              |
|-----------|------------------------------------------------------------------------------------|
| `tooltip` | Tooltip body, inline help cards, table-cell badges, autocomplete suggestions       |
| `header`  | Every page's top app bar / mobile header — replace `BrandMark`/`<PP>` placeholders |
| `default` | Premium upsell modal, Referral page header, settings → about, share-card preview   |
| `hero`    | Premium landing hero, Referral page hero, splash / onboarding intro                |

---

## 4) Find-and-replace targets

Search the codebase for these patterns and replace each with `<Logo size="…" />`:

- Any literal `PP` text rendered as a logo placeholder
- Any component named `BrandMark`, `LogoMark`, `PPMark`, `Brand`, `AppIcon`
- Inline SVGs labelled "PolyProPicks placeholder" / "PP placeholder"
- `<div style={{ background: "linear-gradient(…, #0c2236, #040b16)" }}>` with `P` text — the typographic placeholder shipped in earlier builds
- Anywhere `<head>` references `favicon.ico` or a default Next favicon

In our reference design system the placeholder lives in `ui_kits/mobile/icons.jsx` (`function BrandMark`) and is consumed in `ui_kits/mobile/chrome.jsx`. Swap both to the new `<Logo />` component.

---

## 5) Acceptance checklist

- [ ] Browser tab shows the neon-circle PP icon on light **and** dark OS themes (no white square halo)
- [ ] iOS "Add to Home Screen" preview uses the 180×180 apple-touch-icon
- [ ] PWA install prompt shows the 512×512 icon on Android
- [ ] Every page header — feed, premium, referral, settings, paywall — renders the exact same logo at the exact same size
- [ ] Tooltips and inline cards use the 16-px tooltip variant, not a scaled-down header
- [ ] Premium / Referral hero uses the `hero` variant (96 px logical, 512 px source)
- [ ] No `BrandMark`, `PP` or typographic placeholder remains in the codebase
- [ ] Light-DOM `<img>` tags use `srcSet` 1x/2x so retina renders crisp
- [ ] `manifest.webmanifest` is fetched without 404
- [ ] Lighthouse PWA audit passes "icon" checks

---

## Notes / caveats

- The source artwork has a **black square** background (the design lives inside a neon circle on black). It is **not** transparent. That is intentional: every surface in the product is dark, and a transparent SVG would lose the glow. If a future light surface needs a transparent variant, mask with `border-radius: 50%` and place on a dark card — never on white.
- Do **not** colour-shift the logo. No tinting, hue rotations, or duotone treatments. Single source of truth.
- Do **not** crop the circle. Always render square.
- If you need an arbitrary new size, downscale from `logo-master-1024.png`. Do not upscale from a smaller variant.
