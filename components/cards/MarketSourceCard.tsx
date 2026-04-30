import { MarketSourceCard as MarketSourceCardType } from '@/lib/types';
import styles from './MarketSourceCard.module.css';

interface MarketSourceCardProps {
  data: MarketSourceCardType;
}

function EqualizerIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.eqIcon} aria-hidden="true">
      <path
        d="M3 12h2m3-4v8m4-12v16m4-10v4m4-7v10"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function PolymarketIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.platformIcon} aria-hidden="true">
      <path
        d="M4 7.5 13.5 3v8.5L4 21v-8.5L13.5 8M13.5 3 20 7v8.5l-6.5-4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function PolygonIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.platformIconPolygon} aria-hidden="true">
      <path
        d="M8.2 9.2c0-1.8 1.4-3.2 3.2-3.2 1.2 0 2.1.5 2.7 1.4l3.1 3.8a3.2 3.2 0 1 1-5.1 3.9l-1.1-1.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M15.8 14.8c0 1.8-1.4 3.2-3.2 3.2-1.2 0-2.1-.5-2.7-1.4l-3.1-3.8a3.2 3.2 0 1 1 5.1-3.9l1.1 1.4"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function MiniChart() {
  return (
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
  );
}

function PillIcon({ label }: { label: string }) {
  const normalized = label.trim().toLowerCase();

  if (normalized === 'polymarket') return <PolymarketIcon />;
  if (normalized === 'polygon') return <PolygonIcon />;

  return null;
}

export default function MarketSourceCard({ data }: MarketSourceCardProps) {
  const sourcePills = data.sourcePills ?? [];

  return (
    <article className={styles.card} aria-label="Market source signal card">
      <div className={styles.topRow}>
        <div className={styles.sourceMeta}>
          <EqualizerIcon />
          <div className={styles.sectionLabel}>{data.sectionLabel}</div>
        </div>

        <div className={styles.spacer} />

        {sourcePills.map((pill) => (
          <div key={pill} className={styles.pill}>
            <PillIcon label={pill} />
            <span>{pill}</span>
          </div>
        ))}

        {data.recencyPill ? (
          <div className={`${styles.pill} ${styles.recencyPill}`}>
            <span>{data.recencyPill}</span>
          </div>
        ) : null}
      </div>

      <div className={styles.contentRow}>
        <div className={styles.chartSide}>
          <MiniChart />
          <div className={styles.changeLabel}>{data.changeLabel}</div>
        </div>

        <div className={styles.copySide}>
          <h3 className={styles.headline}>{data.headline}</h3>
          <p className={styles.subline}>{data.subheadline}</p>
        </div>
      </div>

      <div className={styles.divider} />
    </article>
  );
}