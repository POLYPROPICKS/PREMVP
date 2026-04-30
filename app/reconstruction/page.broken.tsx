'use client';

import styles from './Reconstruction.module.css';

export default function ReconstructionPage() {
  return (
    <main className={styles.page}>
      <div className={styles.proofMarker}>
        RECONSTRUCTION_RESET_ACTIVE
      </div>
      
      <section className={styles.viewport}>
        <div className={styles.screen}>
          <StatusBar />
          <Header />
          <MarketSourceCard />
          <PillsRow />
          <PremiumSignalCard />
        </div>
      </section>
    </main>
  );
}

function StatusBar() {
  return (
    <div className={styles.statusBar}>
      <div className={styles.statusTime}>9:41</div>
      <div className={styles.statusIcons}>
        <div className={styles.cellular}>
          <span />
          <span />
          <span />
          <span />
        </div>
        <svg viewBox="0 0 20 14" className={styles.wifi} aria-hidden="true">
          <path
            d="M2 5.5C6.8 1.5 13.2 1.5 18 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M5 8.5C8.3 5.8 11.7 5.8 15 8.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M8.2 11.2c1.2-1 2.4-1 3.6 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
        <div className={styles.battery}>
          <div className={styles.batteryFill} />
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.brandWrap}>
        <svg viewBox="0 0 64 64" className={styles.gem} aria-hidden="true">
          <path
            d="M16 18h32l10 14-26 18L6 32l10-14Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinejoin="round"
          />
          <path
            d="M16 18 24 8h16l8 10M6 32h52M24 8l8 24 8-24M16 18l16 14 16-14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <div className={styles.brandText}>PolyProPicks</div>
      </div>
      <div className={styles.livePill}>
        <span className={styles.liveDot} />
        <span className={styles.liveText}>Live shark flow</span>
      </div>
    </header>
  );
}

function MarketSourceCard() {
  return (
    <section className={styles.marketSourceCard}>
      <div className={styles.marketTop}>
        <div className={styles.marketSourceLabel}>
          <svg viewBox="0 0 24 24" className={styles.eq} aria-hidden="true">
            <path
              d="M3 12h2m3-4v8m4-12v16m4-10v4m4-7v10"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          <span>Market Source</span>
        </div>
        <div className={styles.marketPill}>
          <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
            <path
              d="M4 7.5 13.5 3v8.5L4 21v-8.5L13.5 8M13.5 3 20 7v8.5l-6.5-4"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>Polymarket</span>
        </div>
        <div className={styles.marketPill}>
          <svg viewBox="0 0 24 24" className={styles.marketPillIcon} aria-hidden="true">
            <path
              d="M8.2 9.2c0-1.8 1.4-3.2 3.2-3.2 1.2 0 2.1.5 2.7 1.4l3.1 3.8a3.2 3.2 0 1 1-5.1 3.9l-1.1-1.4"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>Polygon</span>
        </div>
        <div className={`${styles.marketPill} ${styles.marketPillTime}`}>
          <span>8 min ago</span>
        </div>
      </div>
      <div className={styles.marketBody}>
        <div className={styles.marketChartWrap}>
          <svg viewBox="0 0 180 72" className={styles.chart} aria-hidden="true">
            <path
              d="M4 60 L14 57 L24 59 L34 52 L44 55 L54 49 L64 52 L74 44 L84 37 L94 43 L104 34 L114 39 L124 30 L134 17 L145 6"
              className={styles.chartLine}
            />
            <path
              d="M4 60 L14 57 L24 59 L34 52 L44 55 L54 49 L64 52 L74 44 L84 37 L94 43 L104 34 L114 39 L124 30 L134 17 L145 6 L145 72 L4 72 Z"
              className={styles.chartFill}
            />
            <circle cx="145" cy="6" r="3.7" className={styles.chartDot} />
          </svg>
          <div className={styles.marketDelta}>+7% ↗</div>
        </div>

        <div className={styles.marketCopy}>
          <div className={styles.marketHeadline}>$13K whale flow</div>
          <div className={styles.marketSubline}>Barcelona odds moved +7%</div>
        </div>
      </div>
    </section>
  );
}

function PillsRow() {
  return (
    <div className={styles.pillsRow}>
      <button className={styles.pill}>Live</button>
      <button className={styles.pill}>WC2026</button>
      <button className={`${styles.pill} ${styles.pillActive}`}>Sports</button>
      <button className={styles.pill}>Econ</button>
    </div>
  );
}

function PremiumSignalCard() {
  return (
    <article className={styles.premiumSignalCard}>
      <div className={styles.premiumTop}>
        <div className={styles.leagueMeta}>
          <svg viewBox="0 0 24 24" className={styles.ball} aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="#F4F6FA" />
            <path d="M12 7.1 8.8 9.4 10 13.1h4L15.2 9.4 12 7.1Z" fill="#11161E" />
            <path d="M8.2 10.1 6.1 9.3 4.7 12l1.8 2.5 2.4-.6.9-3.8Z" fill="#11161E" />
            <path d="M15.8 10.1 17.9 9.3 19.3 12l-1.8 2.5-2.4-.6-.9-3.8Z" fill="#11161E" />
            <path d="M8 15.1 6.8 17.7 10 19.2l2-1.5V15H8Z" fill="#11161E" />
            <path d="M16 15.1 17.2 17.7 14 19.2l-2-1.5V15h4Z" fill="#11161E" />
          </svg>
          <span>La Liga • 10:00 PM</span>
        </div>
        <div className={styles.confidencePill}>
          <svg viewBox="0 0 24 24" className={styles.shield} aria-hidden="true">
            <path
              d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z"
              fill="currentColor"
            />
            <path
              d="m8.7 12.2 2.1 2.1 4.5-4.7"
              stroke="#06220B"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
          <span>HIGH CONFIDENCE</span>
        </div>
      </div>
      <h1 className={styles.eventTitle}>Barcelona vs Real Madrid</h1>
      <div className={styles.positionProfit}>
        <div className={styles.positionCol}>
          <div className={styles.label}>Position</div>
          <div className={styles.positionValue}>Barcelona</div>
          <svg viewBox="0 0 120 120" className={styles.target} aria-hidden="true">
            <circle cx="60" cy="60" r="34" fill="none" stroke="currentColor" strokeWidth="2.4" />
            <circle cx="60" cy="60" r="19" fill="none" stroke="currentColor" strokeWidth="2.1" />
            <circle cx="60" cy="60" r="4.8" fill="#8bff4d" />
            <path d="M60 18v22M60 80v22M18 60h22M80 60h22" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </div>
        <div className={styles.positionProfitDivider} />
        <div className={styles.profitCol}>
          <div className={styles.label}>Profit</div>
          <div className={styles.profitValue}>317%</div>
          <svg viewBox="0 0 24 24" className={styles.trend} aria-hidden="true">
            <path
              d="M5 17.5 11.2 11.3l3.2 3.2L20 8.9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M15.8 8.9H20v4.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
      <div className={styles.analyticsRow}>
        <div className={styles.winCard}>
          <div className={styles.winTitle}>WIN PROBABILITY</div>
          <div className={styles.ring}>
            <div className={styles.ringInner}>
              <span className={styles.ringNumber}>78</span>
            </div>
          </div>
        </div>
        <div className={styles.trustCard}>
          <div className={styles.metricsTitleWrap}>
            <div className={styles.metricsTitle}>TRUST METRICS</div>
            <svg viewBox="0 0 24 24" className={styles.info} aria-hidden="true">
              <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M12 10.2v5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="12" cy="7.2" r="1.1" fill="currentColor" />
            </svg>
          </div>
          <MetricRow icon={<WhaleIcon />} label="Smart Money" value="82%" width="82%" />
          <MetricRow icon={<BrainIcon />} label="Public vs Whale Money" value="74%" width="74%" />
          <MetricRow icon={<AiChipIcon />} label="PreEventScore AI" value="93%" width="93%" />
        </div>
      </div>
      <button className={styles.cta}>Unlock Full Signal — $1.99</button>
    </article>
  );
}

function MetricRow({ icon, label, value, width }: { icon: React.ReactNode; label: string; value: string; width: string }) {
  return (
    <div className={styles.metricRow}>
      <div className={styles.metricIcon}>{icon}</div>
      <div className={styles.metricLabel}>{label}</div>
      <div className={styles.metricValue}>{value}</div>
      <div className={styles.metricBarTrack}>
        <div className={styles.metricBarFill} style={{ width }} />
      </div>
    </div>
  );
}

function WhaleIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <path
        d="M5 14c1.5-3.5 5.5-5.5 10-5 2 .2 3.4-.6 4-2 1.4 2.6 1.3 5.8-.2 8.3-1.9 3.1-5.4 5-9 4.7-2.5-.1-4.3.7-5.3 2.3-.8-2.2-.6-4.8.5-7.3Z"
        fill="currentColor"
      />
      <circle cx="16.8" cy="8.5" r="1.1" fill="rgba(2,7,13,.85)" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <path
        d="M12 3c-1.8 0-3.5.7-4.8 1.9A6.7 6.7 0 0 0 5 9.7c0 .7.1 1.4.3 2A4.7 4.7 0 0 0 3 16c0 2.8 2.2 5 5 5 1.3 0 2.6-.5 3.5-1.4.3-.3.8-.3 1.1 0A4.9 4.9 0 0 0 16 21a5 5 0 0 0 4.7-6.8c.2-.5.3-1.1.3-1.7 0-2-1-3.8-2.7-4.9A6.8 6.8 0 0 0 12 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AiChipIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <text x="12" y="15" textAnchor="middle" fontSize="6.5" fontWeight="700" fill="currentColor">
        AI
      </text>
    </svg>
  );
}
