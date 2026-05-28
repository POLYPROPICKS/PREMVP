// components/who-we-are/WhoWeAreSection.tsx
// Production_Who_we_are v3 — source portrait assets · dark shell card

import styles from './WhoWeAreSection.module.css';

type WhoWeAreSectionProps = { onCtaClick: () => void };

const PORTRAITS = [
  {
    src:    '/section-assets/who-we-are/portraits/artem-k-headshot.webp',
    name:   'Artem K.',
    school: 'MIT',
    field:  'Quantitative Finance',
  },
  {
    src:    '/section-assets/who-we-are/portraits/david-t-headshot.webp',
    name:   'David T.',
    school: 'Stanford',
    field:  'Economics',
  },
  {
    src:    '/section-assets/who-we-are/portraits/emily-c-headshot.webp',
    name:   'Emily C.',
    school: 'Harvard',
    field:  'Applied Mathematics',
  },
] as const;

const PILLARS = [
  { title: 'Analyze', sub: 'PhD-level market modeling',        icon: '/section-assets/who-we-are/icons/analyze-bars.svg'   },
  { title: 'Risk',    sub: 'Lineups, injury, timing pressure',  icon: '/section-assets/who-we-are/icons/risk-shield.svg'    },
  { title: 'Execute', sub: 'Betting discipline, not hype',      icon: '/section-assets/who-we-are/icons/execute-target.svg' },
] as const;

export default function WhoWeAreSection({ onCtaClick }: WhoWeAreSectionProps) {
  return (
    <section className={styles.section} aria-label="Who We Are">
      <div className={styles.shell}>

        {/* ── 1. Header ── */}
        <h2 className={styles.hdrTitle}>WHO WE ARE</h2>
        <p className={styles.hdrSub}>
          PhDs who analyze, bet, and build systems to find edge early.
        </p>

        {/* ── 2. Portrait row ── */}
        <div className={styles.portraits} role="list">
          {PORTRAITS.map(({ src, name, school, field }) => (
            <div key={name} className={styles.card} role="listitem">
              <div className={styles.cardImgWrap}>
                <img
                  src={src}
                  alt={`${name} PhD`}
                  className={styles.cardImg}
                  draggable={false}
                />
              </div>
              <div className={styles.cardTxt}>
                <div className={styles.cardName}>
                  {name}, PhD
                  <img
                    src="/section-assets/who-we-are/icons/academic-cap.svg"
                    alt="" aria-hidden="true"
                    className={styles.capBadge}
                  />
                </div>
                <div className={styles.cardSchool}>{school}</div>
                <div className={styles.cardField}>{field}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── 3. Manifesto block ── */}
        <div className={styles.manifest}>
          <div className={styles.eyebrow}>NOT ANOTHER PICKS PAGE</div>
          <h3 className={styles.headline}>A market signal lab built by bettors.</h3>
          <p className={styles.copy}>
            We read odds, risk, flow, and consensus the way serious players do — before the move becomes obvious.
          </p>
        </div>

        {/* ── 4. Three principle cards ── */}
        <div className={styles.pillars}>
          {PILLARS.map(({ title, sub, icon }) => (
            <div key={title} className={styles.pillarCard}>
              <img src={icon} alt="" aria-hidden="true" className={styles.pillarIcon} />
              <div className={styles.pillarTitle}>{title}</div>
              <div className={styles.pillarSub}>{sub}</div>
            </div>
          ))}
        </div>

        {/* ── 5. Conviction strip ── */}
        <div className={styles.conviction}>
          <img
            src="/section-assets/who-we-are/icons/spark-accent.svg"
            alt="" aria-hidden="true"
            className={styles.sparkIco}
          />
          <div className={styles.convLines}>
            <p className={styles.convLine}>We study <span className={styles.cyan}>movement.</span></p>
            <p className={styles.convLine}>We price <span className={styles.amber}>risk.</span></p>
            <p className={styles.convLine}>We take the <span className={styles.cyan}>edge.</span></p>
          </div>
        </div>

        {/* ── 6. CTA ── */}
        <button type="button" className={styles.cta} onClick={onCtaClick}>
          Get 5 Free Signals NOW
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

      </div>
    </section>
  );
}
