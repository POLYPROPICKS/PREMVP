// components/why-trust/WhyTrustSection.tsx
// Production_WhyCanITrustThis — static · no state · no fetch · inline SVG only
// Mobile-first transparency/trust ledger section. Server-safe (no 'use client').

import styles from './WhyTrustSection.module.css';

// ── Static data ────────────────────────────────────────────────────────────────

const METRICS: Array<{ label: string; value: string; sub?: string; accent?: boolean }> = [
  { label: 'Net Return', value: '+18.4%', sub: 'Flat $100 stake model', accent: true },
  { label: 'Signals Tracked', value: '43' },
  { label: 'Resolved', value: '31' },
  { label: 'Pending', value: '12' },
];

const CHART_POINTS: Array<{ day: string; value: number }> = [
  { day: 'Day 1', value: 0 },
  { day: 'Day 2', value: -2.1 },
  { day: 'Day 3', value: 1.8 },
  { day: 'Day 4', value: 4.5 },
  { day: 'Day 5', value: 9.2 },
  { day: 'Day 6', value: 13.7 },
  { day: 'Day 7', value: 18.4 },
];

type LedgerStatus = 'Hit' | 'Miss' | 'Pending' | 'No Bet';
type LedgerAction = 'WATCH' | 'ENTER' | 'SKIP';

const LEDGER_ROWS: Array<{
  date: string;
  match: string;
  action: LedgerAction;
  status: LedgerStatus;
  ret: string;
}> = [
  { date: 'Jun 24', match: 'Brazil vs England',        action: 'WATCH', status: 'Pending', ret: '—'     },
  { date: 'Jun 24', match: 'Lakers vs Celtics',        action: 'ENTER', status: 'Hit',     ret: '+$72'  },
  { date: 'Jun 23', match: 'PSG vs Bayern',            action: 'ENTER', status: 'Hit',     ret: '+$61'  },
  { date: 'Jun 23', match: 'Yankees vs Astros',        action: 'SKIP',  status: 'No Bet',  ret: '—'     },
  { date: 'Jun 22', match: 'Real Madrid vs Barcelona', action: 'ENTER', status: 'Miss',    ret: '-$100' },
  { date: 'Jun 22', match: 'Maple Leafs vs Rangers',   action: 'ENTER', status: 'Hit',     ret: '+$83'  },
  { date: 'Jun 21', match: 'Chiefs vs Bills',          action: 'WATCH', status: 'Pending', ret: '—'     },
  { date: 'Jun 21', match: 'Inter vs Juventus',        action: 'ENTER', status: 'Hit',     ret: '+$54'  },
];

const METHODOLOGY_RULES: string[] = [
  'Signals are logged before the event settles.',
  'Pending signals are never counted as wins.',
  'Performance is normalized using a flat $100 stake model.',
  'Losses remain visible in the ledger.',
  'Data is based on public market activity, price movement, flow proxies, and risk filters.',
  'Past performance does not guarantee future results.',
];

// ── Chart geometry (computed once, server-side) ─────────────────────────────────

const CHART = {
  vbW: 320,
  vbH: 184,
  left: 44,
  right: 306,
  top: 18,
  bottom: 150,
  vMax: 30,
  vMin: -15,
};

function chartX(index: number): number {
  const { left, right } = CHART;
  return left + (index / (CHART_POINTS.length - 1)) * (right - left);
}

function chartY(value: number): number {
  const { top, bottom, vMax, vMin } = CHART;
  return top + ((vMax - value) / (vMax - vMin)) * (bottom - top);
}

// ── Sub-components ───────────────────────────────────────────────────────────────

function ShieldBadge() {
  return (
    <span className={styles.shieldBadge} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path
          d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z"
          fill="currentColor"
        />
        <path
          d="m8.7 12.2 2.1 2.1 4.5-4.7"
          stroke="#041018"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </span>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M12 7v5l3.2 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function CumulativeReturnChart() {
  const linePoints = CHART_POINTS.map((p, i) => `${chartX(i)},${chartY(p.value)}`).join(' ');
  const areaPoints = `${chartX(0)},${CHART.bottom} ${linePoints} ${chartX(CHART_POINTS.length - 1)},${CHART.bottom}`;
  const yLabels = [30, 15, 0, -15];
  const endIndex = CHART_POINTS.length - 1;
  const endX = chartX(endIndex);
  const endY = chartY(CHART_POINTS[endIndex].value);

  return (
    <svg viewBox={`0 0 ${CHART.vbW} ${CHART.vbH}`} className={styles.chartSvg} role="img" aria-label="Cumulative return chart">
      <defs>
        <linearGradient id="wtChartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(94,234,180,0.30)" />
          <stop offset="100%" stopColor="rgba(94,234,180,0.02)" />
        </linearGradient>
      </defs>

      {/* dashed horizontal grid + y labels */}
      {yLabels.map((v) => {
        const y = chartY(v);
        return (
          <g key={v}>
            <line
              x1={CHART.left}
              y1={y}
              x2={CHART.right}
              y2={y}
              stroke="rgba(150,200,225,0.14)"
              strokeWidth="1"
              strokeDasharray="3,4"
            />
            <text x={CHART.left - 8} y={y + 3.5} fontSize="10" fill="rgba(160,200,225,0.62)" textAnchor="end">
              {v}%
            </text>
          </g>
        );
      })}

      {/* area + line */}
      <polygon points={areaPoints} fill="url(#wtChartFill)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="#5eeab4"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* points */}
      {CHART_POINTS.map((p, i) => (
        <circle key={p.day} cx={chartX(i)} cy={chartY(p.value)} r="3.2" fill="#0a1320" stroke="#5eeab4" strokeWidth="2" />
      ))}

      {/* x labels */}
      {CHART_POINTS.map((p, i) => (
        <text key={`x-${p.day}`} x={chartX(i)} y={CHART.bottom + 22} fontSize="10" fill="rgba(160,200,225,0.62)" textAnchor="middle">
          {p.day}
        </text>
      ))}

      {/* endpoint pill */}
      <g>
        <rect x={endX - 30} y={endY - 26} width="56" height="18" rx="9" fill="rgba(94,234,180,0.16)" stroke="rgba(94,234,180,0.55)" strokeWidth="1" />
        <text x={endX - 2} y={endY - 13} fontSize="11" fontWeight="700" fill="#7bf3c4" textAnchor="middle">
          +18.4%
        </text>
      </g>
    </svg>
  );
}

function statusClass(status: LedgerStatus): string {
  if (status === 'Hit') return styles.stHit;
  if (status === 'Miss') return styles.stMiss;
  if (status === 'No Bet') return styles.stNoBet;
  return styles.stPending;
}

function returnClass(ret: string): string {
  if (ret.startsWith('+')) return styles.retPos;
  if (ret.startsWith('-')) return styles.retNeg;
  return styles.retMuted;
}

function MethodologyNum({ n }: { n: number }) {
  return <span className={styles.mNum} aria-hidden="true">{n}</span>;
}

// ── Main section ────────────────────────────────────────────────────────────────

export default function WhyTrustSection() {
  return (
    <section className={styles.section} aria-label="Why can I trust this">
      <div className={styles.container}>
        {/* Intro glass card */}
        <div className={styles.introCard}>
          <ShieldBadge />
          <h2 className={styles.title}>Why Can I Trust This?</h2>
          <p className={styles.lead}>
            Every signal is timestamped before the market settles — then tracked in a public ledger.
          </p>
          <p className={styles.leadAccent}>
            No cherry-picking. Wins, losses, and pending signals stay visible.
          </p>
          <div className={styles.introDivider} />
          <div className={styles.introFooter}>
            <svg viewBox="0 0 24 24" className={styles.introFooterIcon} aria-hidden="true">
              <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
            <span>Transparent tracking beats cherry-picked screenshots.</span>
          </div>
        </div>

        {/* 7D / 14D segmented control (decorative/static) */}
        <div className={styles.segControl} role="group" aria-label="Time range">
          <span className={`${styles.seg} ${styles.segActive}`}>7D</span>
          <span className={styles.seg}>14D</span>
        </div>

        {/* 2×2 metrics */}
        <div className={styles.metricsGrid}>
          {METRICS.map((m) => (
            <div key={m.label} className={styles.metricCard}>
              <div className={styles.metricLabel}>{m.label}</div>
              <div className={`${styles.metricValue} ${m.accent ? styles.metricValueAccent : ''}`}>{m.value}</div>
              {m.sub && <div className={styles.metricSub}>{m.sub}</div>}
            </div>
          ))}
        </div>

        {/* Updated row */}
        <div className={styles.updatedRow}>
          <ClockIcon className={styles.updatedIcon} />
          <span>Updated 12 minutes ago</span>
        </div>

        {/* Cumulative Return chart card */}
        <div className={styles.chartCard}>
          <div className={styles.chartTitle}>Cumulative Return</div>
          <div className={styles.chartSub}>
            <span className={styles.chartSubDot} aria-hidden="true" />
            Flat $100 per resolved signal
          </div>
          <CumulativeReturnChart />
          <div className={styles.chartDisclaimer}>Performance does not guarantee future results.</div>
        </div>

        {/* Recent Signal Ledger */}
        <div className={styles.ledgerCard}>
          <div className={styles.ledgerHead}>
            <div className={styles.ledgerTitle}>Recent Signal Ledger</div>
            <span className={styles.ledgerViewAll}>View all</span>
          </div>

          <div className={styles.ledgerTable} role="table">
            <div className={`${styles.ledgerRow} ${styles.ledgerColHead}`} role="row">
              <span className={styles.colDate}>Date</span>
              <span className={styles.colMatch}>Match</span>
              <span className={styles.colAction}>Action</span>
              <span className={styles.colStatus}>Status</span>
              <span className={styles.colReturn}>Return</span>
            </div>
            {LEDGER_ROWS.map((row) => (
              <div key={`${row.date}-${row.match}`} className={styles.ledgerRow} role="row">
                <span className={styles.colDate}>{row.date}</span>
                <span className={styles.colMatch} title={row.match}>{row.match}</span>
                <span className={`${styles.colAction} ${row.action === 'ENTER' ? styles.actEnter : styles.actMuted}`}>{row.action}</span>
                <span className={styles.colStatus}>
                  <span className={`${styles.statusPill} ${statusClass(row.status)}`}>{row.status}</span>
                </span>
                <span className={`${styles.colReturn} ${returnClass(row.ret)}`}>{row.ret}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Methodology panel (always expanded/static) */}
        <div className={styles.methodCard}>
          <div className={styles.methodHead}>
            <svg viewBox="0 0 24 24" className={styles.methodIcon} aria-hidden="true">
              <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
            <span className={styles.methodTitle}>How we track signals</span>
            <svg viewBox="0 0 24 24" className={styles.methodChevron} aria-hidden="true">
              <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>

          <div className={styles.methodGrid}>
            {METHODOLOGY_RULES.map((rule, i) => (
              <div key={i} className={styles.methodItem}>
                <MethodologyNum n={i + 1} />
                <span className={styles.methodText}>{rule}</span>
              </div>
            ))}
          </div>

          <div className={styles.methodMetaDivider} />
          <div className={styles.methodMeta}>
            <div className={styles.methodMetaCell}>
              <svg viewBox="0 0 24 24" className={styles.methodMetaIcon} aria-hidden="true">
                <path d="M5 19V10M10 19V5M15 19v-6M20 19V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
              <div>
                <div className={styles.methodMetaLabel}>Formula version</div>
                <div className={styles.methodMetaValue}>trusted signal score v1.1</div>
              </div>
            </div>
            <div className={styles.methodMetaCell}>
              <ClockIcon className={styles.methodMetaIcon} />
              <div>
                <div className={styles.methodMetaLabel}>Last sync</div>
                <div className={styles.methodMetaValue}>12 minutes ago</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
