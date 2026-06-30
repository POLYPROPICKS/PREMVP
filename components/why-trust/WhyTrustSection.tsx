'use client';

// components/why-trust/WhyTrustSection.tsx
// Verified Track Record — client component · 7D/14D toggle · curated sample data
// Mobile-first marketing/sample section. Inline SVG only, no fetch, no backend.

import { useState } from 'react';
import styles from './WhyTrustSection.module.css';

// ── Types ───────────────────────────────────────────────────────────────────────

type TrackWindow = '7D' | '14D';

type LedgerStatus = 'Hit' | 'Miss' | 'Pending' | 'No Bet';
type LedgerAction = 'WATCH' | 'ENTER' | 'SKIP';

type LedgerRow = {
  date: string;
  match: string;
  action: LedgerAction;
  status: LedgerStatus;
  ret: string;
};

type ChartPoint = { day: string; value: number };

type Dataset = {
  chart: ChartPoint[];
  ledger: LedgerRow[];
};

// ── Curated sample datasets (static, per tracking window) ────────────────────────

const DATA_7D: Dataset = {
  chart: [
    { day: 'Day 1', value: 0 },
    { day: 'Day 2', value: -2.1 },
    { day: 'Day 3', value: 1.8 },
    { day: 'Day 4', value: 4.5 },
    { day: 'Day 5', value: 9.2 },
    { day: 'Day 6', value: 13.7 },
    { day: 'Day 7', value: 18.4 },
  ],
  ledger: [
    { date: 'Jun 24', match: 'Brazil vs England',        action: 'ENTER', status: 'Hit',     ret: '+$72'  },
    { date: 'Jun 24', match: 'Lakers vs Celtics',        action: 'ENTER', status: 'Hit',     ret: '+$61'  },
    { date: 'Jun 23', match: 'PSG vs Bayern',            action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 23', match: 'Yankees vs Astros',        action: 'SKIP',  status: 'No Bet',  ret: '—'     },
    { date: 'Jun 22', match: 'Real Madrid vs Barcelona', action: 'WATCH', status: 'Pending', ret: '—'     },
    { date: 'Jun 22', match: 'Maple Leafs vs Rangers',   action: 'ENTER', status: 'Hit',     ret: '+$83'  },
    { date: 'Jun 21', match: 'Chiefs vs Bills',          action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 21', match: 'Inter vs Juventus',        action: 'WATCH', status: 'Pending', ret: '—'     },
  ],
};

const DATA_14D: Dataset = {
  chart: [
    { day: 'D1',  value: 0 },
    { day: 'D3',  value: -3.2 },
    { day: 'D5',  value: -1.1 },
    { day: 'D7',  value: 3.4 },
    { day: 'D9',  value: 7.8 },
    { day: 'D11', value: 12.1 },
    { day: 'D13', value: 18.9 },
    { day: 'D14', value: 24.6 },
  ],
  ledger: [
    { date: 'Jun 24', match: 'Brazil vs England',        action: 'ENTER', status: 'Hit',     ret: '+$72'  },
    { date: 'Jun 24', match: 'Lakers vs Celtics',        action: 'ENTER', status: 'Hit',     ret: '+$61'  },
    { date: 'Jun 23', match: 'PSG vs Bayern',            action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 23', match: 'Yankees vs Astros',        action: 'SKIP',  status: 'No Bet',  ret: '—'     },
    { date: 'Jun 22', match: 'Real Madrid vs Barcelona', action: 'ENTER', status: 'Hit',     ret: '+$74'  },
    { date: 'Jun 22', match: 'Maple Leafs vs Rangers',   action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 21', match: 'Chiefs vs Bills',          action: 'ENTER', status: 'Hit',     ret: '+$83'  },
    { date: 'Jun 21', match: 'Inter vs Juventus',        action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 20', match: 'Arsenal vs Chelsea',       action: 'ENTER', status: 'Hit',     ret: '+$67'  },
    { date: 'Jun 19', match: 'Dodgers vs Mets',          action: 'ENTER', status: 'Hit',     ret: '+$79'  },
    { date: 'Jun 18', match: 'Oilers vs Stars',          action: 'ENTER', status: 'Miss',    ret: '-$100' },
    { date: 'Jun 17', match: 'France vs Germany',        action: 'WATCH', status: 'Pending', ret: '—'     },
  ],
};

const DATASETS: Record<TrackWindow, Dataset> = {
  '7D': DATA_7D,
  '14D': DATA_14D,
};

const METHODOLOGY_RULES: string[] = [
  'Predictions are locked before the event settles.',
  'Pending calls are not counted as wins.',
  'Performance is normalized using a flat $100 stake model.',
  'Losses remain visible in the selected window.',
  'Market context uses price movement, flow proxies, and risk filters.',
  'Past performance does not guarantee future results.',
];

// ── Derivations (metrics computed from the selected dataset) ─────────────────────

function formatPct(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function chartEndValue(ds: Dataset): number {
  return ds.chart[ds.chart.length - 1].value;
}

function deriveMetrics(ds: Dataset): Array<{ label: string; value: string; sub?: string; accent?: boolean }> {
  const signalsTracked = ds.ledger.length;
  const resolved = ds.ledger.filter((r) => r.status === 'Hit' || r.status === 'Miss').length;
  const pending = ds.ledger.filter((r) => r.status === 'Pending').length;
  return [
    { label: 'Net Return', value: formatPct(chartEndValue(ds)), sub: 'Flat $100 stake model', accent: true },
    { label: 'Signals Tracked', value: String(signalsTracked) },
    { label: 'Resolved', value: String(resolved) },
    { label: 'Pending', value: String(pending) },
  ];
}

// ── Chart geometry ────────────────────────────────────────────────────────────────

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

function chartX(index: number, count: number): number {
  const { left, right } = CHART;
  return left + (index / (count - 1)) * (right - left);
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

function CumulativeReturnChart({ points }: { points: ChartPoint[] }) {
  const count = points.length;
  const linePoints = points.map((p, i) => `${chartX(i, count)},${chartY(p.value)}`).join(' ');
  const areaPoints = `${chartX(0, count)},${CHART.bottom} ${linePoints} ${chartX(count - 1, count)},${CHART.bottom}`;
  const yLabels = [30, 15, 0, -15];
  const endIndex = count - 1;
  const endX = chartX(endIndex, count);
  const endY = chartY(points[endIndex].value);
  const endLabel = formatPct(points[endIndex].value);

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
      {points.map((p, i) => (
        <circle key={p.day} cx={chartX(i, count)} cy={chartY(p.value)} r="3.2" fill="#0a1320" stroke="#5eeab4" strokeWidth="2" />
      ))}

      {/* x labels */}
      {points.map((p, i) => (
        <text key={`x-${p.day}`} x={chartX(i, count)} y={CHART.bottom + 22} fontSize="10" fill="rgba(160,200,225,0.62)" textAnchor="middle">
          {p.day}
        </text>
      ))}

      {/* endpoint pill */}
      <g>
        <rect x={endX - 30} y={endY - 26} width="56" height="18" rx="9" fill="rgba(94,234,180,0.16)" stroke="rgba(94,234,180,0.55)" strokeWidth="1" />
        <text x={endX - 2} y={endY - 13} fontSize="11" fontWeight="700" fill="#7bf3c4" textAnchor="middle">
          {endLabel}
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
  const [active, setActive] = useState<TrackWindow>('7D');
  const dataset = DATASETS[active];
  const metrics = deriveMetrics(dataset);

  return (
    <section className={styles.section} aria-label="Verified track record">
      <div className={styles.container}>
        {/* Intro glass card */}
        <div className={styles.introCard}>
          <ShieldBadge />
          <h2 className={styles.title}>Verified Track Record</h2>
          <p className={styles.lead}>
            Every single prediction is locked and timestamped before the market settles.
          </p>
          <p className={styles.leadAccent}>
            Wins, losses, and pending calls stay visible across the selected tracking window.
          </p>
          <div className={styles.introDivider} />
          <div className={styles.introFooter}>
            <svg viewBox="0 0 24 24" className={styles.introFooterIcon} aria-hidden="true">
              <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
            <span>A structured performance view built for fast signal review.</span>
          </div>
        </div>

        {/* 7D / 14D segmented control */}
        <div className={styles.segControl} role="group" aria-label="Tracking window">
          {(['7D', '14D'] as TrackWindow[]).map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.seg} ${active === w ? styles.segActive : ''}`}
              aria-pressed={active === w}
              onClick={() => setActive(w)}
            >
              {w}
            </button>
          ))}
        </div>

        {/* 2×2 metrics */}
        <div className={styles.metricsGrid}>
          {metrics.map((m) => (
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
          <CumulativeReturnChart points={dataset.chart} />
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
            {dataset.ledger.map((row) => (
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
