#!/usr/bin/env node
/**
 * capture-visual-matrix.mjs
 * Visual Matrix Runner — captures screenshots across mobile viewports and
 * generates a contact-sheet HTML for visual QA review.
 *
 * Usage:
 *   node scripts/visual/capture-visual-matrix.mjs [--url=<url>] [--label=<label>]
 *
 * Defaults:
 *   --url   https://polypropicks.com
 *   --label prod-home
 *
 * Output:
 *   visual-runs/YYYY-MM-DD_HH-mm-ss_LABEL/
 *     01_360x780.png  ... 09_432x960.png
 *     contact-sheet.html
 *     metadata.json
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// --- CLI arg parsing ---
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || 'true'];
    })
);

const TARGET_URL = args.url || 'https://polypropicks.com';
const LABEL     = (args.label || 'prod-home').replace(/[^a-zA-Z0-9_-]/g, '_');

// --- Viewports ---
const VIEWPORTS = [
  { name: '01_360x780',  width: 360,  height: 780  },
  { name: '02_375x667',  width: 375,  height: 667  },
  { name: '03_375x812',  width: 375,  height: 812  },
  { name: '04_390x844',  width: 390,  height: 844  },
  { name: '05_393x852',  width: 393,  height: 852  },
  { name: '06_414x896',  width: 414,  height: 896  },
  { name: '07_428x926',  width: 428,  height: 926  },
  { name: '08_430x932',  width: 430,  height: 932  },
  { name: '09_432x960',  width: 432,  height: 960  },
];

// --- Animation suppression CSS ---
const ANIMATION_KILL_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
}
`;

// --- Output folder ---
function makeTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const ts = makeTimestamp();
const outDir = path.join(ROOT, 'visual-runs', `${ts}_${LABEL}`);
fs.mkdirSync(outDir, { recursive: true });

console.log(`\n[visual-matrix] URL: ${TARGET_URL}`);
console.log(`[visual-matrix] Label: ${LABEL}`);
console.log(`[visual-matrix] Output: ${outDir}\n`);

// --- Main capture ---
const generatedAt = new Date().toISOString();
const screenshots = [];

const browser = await chromium.launch({ headless: true });

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });

    const page = await context.newPage();

    // Inject animation-kill CSS before navigation
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          scroll-behavior: auto !important;
        }
      `;
      document.head?.appendChild(style) ?? document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    });

    try {
      await page.goto(TARGET_URL, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } catch (navErr) {
      // Fallback: domcontentloaded only
      console.warn(`  [warn] networkidle timeout for ${vp.name}, retrying with domcontentloaded`);
      await page.goto(TARGET_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(2000);
    }

    // Inject CSS post-load as well (belt-and-suspenders)
    await page.addStyleTag({ content: ANIMATION_KILL_CSS }).catch(() => {});

    const filename = `${vp.name}.png`;
    const filePath = path.join(outDir, filename);

    await page.screenshot({
      path: filePath,
      fullPage: false,  // visible viewport only
      type: 'png',
    });

    screenshots.push({ viewport: vp.name, width: vp.width, height: vp.height, filename });
    console.log(`  [ok] ${vp.name} (${vp.width}x${vp.height}) → ${filename}`);

    await context.close();
  }
} finally {
  await browser.close();
}

// --- metadata.json ---
const metadata = {
  url: TARGET_URL,
  label: LABEL,
  generatedAt,
  viewports: screenshots.map(s => ({ name: s.viewport, width: s.width, height: s.height })),
  screenshots: screenshots.map(s => s.filename),
};
fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log('\n[visual-matrix] metadata.json written');

// --- contact-sheet.html ---
const imgCards = screenshots.map(s => /* html */`
  <div class="card">
    <div class="vp-label">${s.viewport.replace(/_/g, ' ')}&nbsp;&nbsp;<span class="dims">${s.width}×${s.height}</span></div>
    <img src="${s.filename}" alt="${s.viewport}" loading="lazy" />
  </div>
`).join('\n');

const html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Visual Matrix — ${LABEL} — ${ts}</title>
<style>
  :root { --bg: #0f0f12; --card-bg: #1a1a20; --border: #2a2a35; --text: #e0e0e8; --dim: #888; --accent: #7c5cfc; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px 24px; }
  h1 { font-size: 1.3rem; font-weight: 700; color: var(--accent); margin-bottom: 6px; }
  .meta { font-size: 0.78rem; color: var(--dim); margin-bottom: 28px; line-height: 1.8; }
  .meta strong { color: var(--text); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .vp-label { padding: 10px 14px; font-size: 0.82rem; font-weight: 600; color: var(--text); border-bottom: 1px solid var(--border); }
  .dims { color: var(--dim); font-weight: 400; font-size: 0.75rem; }
  .card img { display: block; width: 100%; height: auto; }
  footer { margin-top: 36px; font-size: 0.73rem; color: var(--dim); text-align: center; }
  .badge { display: inline-block; background: #1e1e2e; border: 1px solid var(--border); border-radius: 4px; padding: 2px 7px; font-size: 0.7rem; color: var(--accent); margin-left: 8px; vertical-align: middle; }
</style>
</head>
<body>
<h1>PolyProPicks Visual Matrix <span class="badge">${LABEL}</span></h1>
<div class="meta">
  <strong>URL:</strong> ${TARGET_URL}<br/>
  <strong>Generated:</strong> ${generatedAt}<br/>
  <strong>Viewports:</strong> ${screenshots.length} mobile breakpoints<br/>
  <strong>Run ID:</strong> ${ts}_${LABEL}
</div>
<div class="grid">
${imgCards}
</div>
<footer>Visual review support only. Gate 2 requires explicit founder decision. No commit or deploy is automated by this script.</footer>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), html);
console.log('[visual-matrix] contact-sheet.html written');
console.log(`\n[visual-matrix] Done — ${screenshots.length} screenshots captured.`);
console.log(`[visual-matrix] Open: ${path.join(outDir, 'contact-sheet.html')}\n`);
