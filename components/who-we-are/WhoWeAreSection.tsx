'use client';
// components/who-we-are/WhoWeAreSection.tsx
// Production_Who_we_are v3 — source portrait assets · direct checkout flow

import { useState } from 'react';
import styles from './WhoWeAreSection.module.css';

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

const PLAN_META = {
  '7day':   { internalPlanId: 'premium_7day_weekly',  label: 'Unlock 7-Day Premium — $15' },
  monthly:  { internalPlanId: 'premium_monthly',       label: 'Unlock Monthly Pro — $49'   },
} as const;

type Plan = keyof typeof PLAN_META;

const BENEFITS: Record<Plan, string[]> = {
  '7day': [
    'Signals 2–4h before odds move',
    'Live Polymarket whale-flow evidence',
    'Injury + lineup risk layer',
    'Sharp market consensus checks',
    'ENTER · SKIP · WAIT per market',
  ],
  monthly: [
    'Everything in 7-Day Premium',
    'Full month of live signals',
    'Best for daily market users',
    'Ongoing edge monitoring',
    'More market coverage',
  ],
};

export default function WhoWeAreSection() {
  const [selectedPlan, setSelectedPlan] = useState<Plan>('7day');
  const [loading, setLoading]           = useState(false);

  async function handleCheckout() {
    if (loading) return;
    setLoading(true);
    const { internalPlanId } = PLAN_META[selectedPlan];
    const leadIntentId = crypto.randomUUID();
    try {
      const res = await fetch('/api/checkout/create', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ internalPlanId, leadIntentId, source: 'who_we_are_section' }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && typeof json.checkoutUrl === 'string') {
        window.location.href = json.checkoutUrl;
        return; // navigation in progress — keep loading state
      }
    } catch {
      // fall through to reset loading
    }
    setLoading(false);
  }

  const ctaLabel = loading ? 'Opening checkout…' : PLAN_META[selectedPlan].label;

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

        {/* ── 6. Paywall controls ── */}
        <div className={styles.paywallBlock}>

          {/* plan cards — click selects plan, does NOT open modal */}
          <div className={styles.plans}>

            {/* 7-Day Premium */}
            <button
              type="button"
              className={`${styles.planCard} ${selectedPlan === '7day' ? styles.planSelected : ''}`}
              onClick={() => setSelectedPlan('7day')}
              aria-pressed={selectedPlan === '7day'}
            >
              <span className={styles.radio}>{selectedPlan === '7day' ? '✓' : ''}</span>
              <span className={styles.planCopy}>
                <span className={styles.planBadge}>BEST FOR YOU</span>
                <span className={styles.planName}>7-Day Premium</span>
                <span className={styles.planSub}>Full week of live signals</span>
              </span>
              <span className={styles.priceBlock}>
                <strong>$15</strong>
                <span>$2.14/day</span>
              </span>
            </button>

            {/* Monthly Pro */}
            <button
              type="button"
              className={`${styles.planCard} ${selectedPlan === 'monthly' ? styles.planSelected : ''}`}
              onClick={() => setSelectedPlan('monthly')}
              aria-pressed={selectedPlan === 'monthly'}
            >
              <span className={styles.radio}>{selectedPlan === 'monthly' ? '✓' : ''}</span>
              <span className={styles.planCopy}>
                <span className={styles.planName}>Monthly Pro</span>
                <span className={styles.planSub}>Best for daily market users</span>
              </span>
              <span className={styles.priceBlock}>
                <strong>$49</strong>
                <span>$1.63/day</span>
              </span>
            </button>

          </div>

          {/* benefits list — below plan cards */}
          <div className={styles.benefitsList}>
            <div className={styles.benefitsTitle}>What do I get?</div>
            {BENEFITS[selectedPlan].map(txt => (
              <div key={txt} className={styles.benefitRow}>
                <svg className={styles.benefitCheck} viewBox="0 0 14 14" aria-hidden="true">
                  <circle cx="7" cy="7" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M4 7l2.2 2.2L10 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
                <span className={styles.benefitText}>{txt}</span>
              </div>
            ))}
          </div>

          {/* primary CTA — direct checkout */}
          <button
            type="button"
            className={styles.primaryCta}
            onClick={handleCheckout}
            disabled={loading}
          >
            {ctaLabel}
          </button>

        </div>

      </div>
    </section>
  );
}
