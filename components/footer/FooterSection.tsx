// components/footer/FooterSection.tsx
// Production_footer v1 — dark premium · mobile-first

import styles from './FooterSection.module.css';

const PRESS_LOGOS = [
  { label: 'yahoo!',          style: 'yahoo'    },
  { label: 'Barstool Sports', style: 'barstool' },
  { label: 'LINEUPS',         style: 'lineups'  },
  { label: 'PRESS WIRE',      style: 'presswire'},
  { label: 'Sports Media Review',  style: 'casino'   },
  { label: 'Sports Briefing Desk', style: 'betnews'  },
  { label: 'nola.com',        style: 'nola'     },
  { label: 'XCLS',            style: 'xcls'     },
] as const;

function IconX() {
  return (
    <svg viewBox="0 0 24 24" aria-label="X / Twitter" className={styles.socialSvg}>
      <defs>
        <linearGradient id="xGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#64e8ff" />
          <stop offset="100%" stopColor="#a0f0ff" />
        </linearGradient>
      </defs>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" fill="url(#xGrad)" />
    </svg>
  );
}

function IconTikTok() {
  return (
    <svg viewBox="0 0 24 24" aria-label="TikTok" className={styles.socialSvg}>
      {/* cyan layer */}
      <path
        d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.78a4.85 4.85 0 0 1-1.01-.09Z"
        fill="#18e7ff"
        opacity="0.9"
        transform="translate(-0.8, 0.6)"
      />
      {/* red/pink layer */}
      <path
        d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.78a4.85 4.85 0 0 1-1.01-.09Z"
        fill="#ff2d55"
        opacity="0.75"
        transform="translate(0.8, -0.6)"
      />
      {/* white core */}
      <path
        d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.78a4.85 4.85 0 0 1-1.01-.09Z"
        fill="#ffffff"
        opacity="0.95"
      />
    </svg>
  );
}

export default function FooterSection() {
  return (
    <footer className={styles.footer} id="footer-legal">
      <div className={styles.inner}>

        {/* ── 1. Press header ── */}
        <div className={styles.pressHeader}>
          <h2 className={styles.pressTitle}>Press</h2>
          <div className={styles.pressDivider} />
          <p className={styles.pressSub}>Stories and mentions from the press</p>
        </div>

        {/* ── 2. Press logo grid 2×4 ── */}
        <div className={styles.pressGrid} role="list">
          {PRESS_LOGOS.map(({ label, style }) => (
            <div key={label} className={`${styles.pressTile} ${styles[style]}`} role="listitem">
              <span className={styles.pressTileLabel}>{label}</span>
            </div>
          ))}
        </div>

        {/* ── 3. Social / links panel ── */}
        <div className={styles.panel}>
          {/* left: social icons */}
          <div className={styles.socials}>
            <a href="https://x.com/polypropicks" target="_blank" rel="noopener noreferrer" className={styles.socialBtn} aria-label="X">
              <IconX />
            </a>
            <a href="https://tiktok.com/@polypropicks" target="_blank" rel="noopener noreferrer" className={styles.socialBtn} aria-label="TikTok">
              <IconTikTok />
            </a>
            <a href="/" className={styles.socialBtn} aria-label="PolyProPicks">
              <img src="/brand/polypropicks-mark.png" alt="PP" className={styles.brandMark} />
            </a>
          </div>

          {/* divider */}
          <div className={styles.panelDivider} />

          {/* right: legal links */}
          <nav className={styles.links} aria-label="Footer navigation">
            {[
              { label: 'Terms of Use',  href: '/terms-of-use'   },
              { label: 'Privacy Policy',href: '/privacy-policy' },
              { label: 'FAQ',           href: '/faq'          },
              { label: 'Legal',         href: '/legal'        },
              { label: 'Contact',       href: 'mailto:alex_ceo@polypropicks.com' },
            ].map(({ label, href }) => (
              <a key={label} href={href} className={styles.link}>
                {label}
                <svg viewBox="0 0 8 14" className={styles.chevron} aria-hidden="true">
                  <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                </svg>
              </a>
            ))}
          </nav>
        </div>

        {/* ── 4. Legal disclaimer ── */}
        <div className={styles.legal}>
          <p>
            © 2026 Benefitpoint Alexander Grushin. All rights reserved. All opinions, picks, and predictions on PolyProPicks are for informational and entertainment purposes only and do not constitute betting advice, financial advice, or a guarantee of any outcome or profit. Past performance is not indicative of future results.
          </p>
          <p>
            PolyProPicks does not offer or accept wagers and is not a sportsbook, bookmaker, or gambling operator. Users are responsible for complying with applicable laws in their jurisdiction. By using this site, users agree that Benefitpoint Alexander Grushin is not liable for losses arising from use of the site.
          </p>
          <p>
            If you or someone you know has a gambling problem, call 1-800-GAMBLER or visit{' '}
            <a href="https://www.ncpgambling.org" target="_blank" rel="noopener noreferrer" className={styles.legalLink}>
              www.ncpgambling.org
            </a>
            {' '}for confidential help.
          </p>
        </div>

      </div>
    </footer>
  );
}
