import { PremiumEventCard as PremiumEventCardType } from '@/lib/types';
import { sectionHeadings } from '@/content/section-headings';
import styles from './PremiumEventCard.module.css';

interface PremiumEventCardProps {
  data: PremiumEventCardType;
}

function getMetricProgress(metric: { progress?: number; value: string }) {
  if (typeof metric.progress === 'number') return metric.progress;
  const parsed = parseInt(metric.value.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 100)) : 0;
}

function MetricIcon({ metricId }: { metricId: string }) {
  if (metricId === 'smart-money') {
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

  if (metricId === 'public-whale' || metricId === 'public-vs-whale') {
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

  return (
    <svg viewBox="0 0 24 24" className={styles.metricIcon} aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.2 14.7v-5.4h2.5c1.8 0 2.9.9 2.9 2.5 0 1.8-1.3 2.9-3.2 2.9H9.2Z" fill="currentColor" />
    </svg>
  );
}

function SoccerBallIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.leagueIcon} aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#F4F6FA" />
      <path
        d="M12 7.1 8.8 9.4 10 13.1h4L15.2 9.4 12 7.1Z"
        fill="#11161E"
      />
      <path
        d="M8.2 10.1 6.1 9.3 4.7 12l1.8 2.5 2.4-.6.9-3.8Z"
        fill="#11161E"
      />
      <path
        d="M15.8 10.1 17.9 9.3 19.3 12l-1.8 2.5-2.4-.6-.9-3.8Z"
        fill="#11161E"
      />
      <path
        d="M8 15.1 6.8 17.7 10 19.2l2-1.5V15H8Z"
        fill="#11161E"
      />
      <path
        d="M16 15.1 17.2 17.7 14 19.2l-2-1.5V15h4Z"
        fill="#11161E"
      />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.confidenceIcon} aria-hidden="true">
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
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.infoIcon} aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 10.2v5.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="7.2" r="1.1" fill="currentColor" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg viewBox="0 0 24 24" className={styles.profitWatermark} aria-hidden="true">
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
  );
}

function CrestWatermark() {
  return (
    <svg viewBox="0 0 120 120" className={styles.positionWatermark} aria-hidden="true">
      <path
        d="M60 9c14 10 28 12 40 12v30c0 30-17 49-40 60C37 100 20 81 20 51V21c12 0 26-2 40-12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path d="M34 38h52M60 24v28" stroke="currentColor" strokeWidth="4" />
      <text x="60" y="82" textAnchor="middle" fontSize="24" fontWeight="700" fill="currentColor">
        FCB
      </text>
    </svg>
  );
}

export default function PremiumEventCard({ data }: PremiumEventCardProps) {
  return (
    <article className={styles.card} aria-label="Premium event signal card">
      <div className={styles.inner}>
        <header className={styles.topRow}>
          <div className={styles.leagueMeta}>
            <SoccerBallIcon />
            <span>{data.leagueLabel} • {data.timeLabel}</span>
          </div>

          <div className={styles.confidencePill}>
            <ShieldCheckIcon />
            <span>{data.confidenceBadge}</span>
          </div>
        </header>

        <h3 className={styles.title}>{data.eventTitle}</h3>

        <section className={styles.splitPanel} aria-label="Position and profit">
          <div className={`${styles.metricHalf} ${styles.positionHalf}`}>
            <CrestWatermark />
            <div className={styles.metricLabel}>{data.positionLabel}</div>
            <div className={styles.metricValue}>{data.positionValue}</div>
          </div>

          <div className={`${styles.metricHalf} ${styles.profitHalf}`}>
            <TrendIcon />
            <div className={styles.metricLabel}>{data.profitLabel}</div>
            <div className={`${styles.metricValue} ${styles.profitValue}`}>{data.profitValue}</div>
          </div>
        </section>

        <section className={styles.lowerGrid} aria-label="Prediction and trust metrics">
          <article className={styles.probCard} aria-label="Win probability">
            <div className={styles.probPill}>{sectionHeadings.winProbability}</div>

            <div
              className={styles.gauge}
              style={{ ['--gauge-angle' as string]: `${Math.round((data.winProbability / 100) * 360)}deg` }}
            >
              <div className={styles.gaugeNumber}>{data.winProbability}</div>
            </div>
          </article>

          <article className={styles.trustCard} aria-label="Trust metrics">
            <div className={styles.trustHeader}>
              <div className={styles.trustTitle}>TRUST METRICS</div>
              <InfoIcon />
            </div>

            {data.trustMetrics.slice(0, 3).map((metric) => {
              const progress = getMetricProgress(metric);

              return (
                <div key={metric.id} className={styles.trustRow}>
                  <MetricIcon metricId={metric.id} />
                  <div className={styles.metricMain}>
                    <div className={styles.trustMetricName}>{metric.label}</div>
                  </div>
                  <div className={styles.trustMetricValue}>{metric.value}</div>
                  <div className={styles.bar}>
                    <div className={styles.fill} style={{ width: `${progress}%` }} />
                  </div>
                </div>
              );
            })}
          </article>
        </section>

        <button className={styles.cta} type="button">
          {data.ctaText}
        </button>
      </div>
    </article>
  );
}