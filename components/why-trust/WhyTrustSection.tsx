'use client';

// components/why-trust/WhyTrustSection.tsx
// Verified Track Record — client component · 7D/14D toggle · REAL resolved-signal data.
// Fetches /api/signals/resolved (mode=latest) for both windows; no curated/fake rows.

import { useEffect, useState } from 'react';
import styles from './WhyTrustSection.module.css';

// ── Types ───────────────────────────────────────────────────────────────────────

type TrackWindow = '7D' | '14D';
type LedgerStatus = 'Hit' | 'Miss';

type ChartPoint = { day: string; value: number };

// Subset of /api/signals/resolved → weekResultsCard that this section consumes.
type ApiLedgerRow = {
  date: string;
  eventTitle: string;
  status: LedgerStatus;
  returnLabel: string;
  resolvedAt: string;
  metricFormulaVersion: string | null;
};

type ApiCard = {
  totalStats: {
    resolvedCount: number;
    wonCount: number;
    lostCount: number;
    totalReturnPct: number | null;
  };
  paywallChart: {
    points: Array<{ index: number; cumulativeReturnPct: number }>;
    finalReturnPct: number | null;
  };
  ledgerPreview: ApiLedgerRow[];
  ledgerPreviewLabel: string;
};

type WindowState = { loading: boolean; error: boolean; data: ApiCard | null };

const WINDOW_DAYS: Record<TrackWindow, number> = { '7D': 7, '14D': 14 };

const METHODOLOGY_RULES: string[] = [
  'Predictions are locked before the event settles.',
  'Wins and losses are tracked across the selected window.',
  'Performance is normalized using a flat $100 stake model.',
  'Losses remain visible in the selected window.',
  'Market context uses price movement, flow proxies, and risk filters.',
  'Past performance does not guarantee future results.',
];

// ── Derivations ───────────────────────────────────────────────────────────────

function formatPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

type Metric = { label: string; value: string; sub?: string; accent?: boolean };

const PLACEHOLDER_METRICS: Metric[] = [
  { label: 'Net Return', value: '—', sub: 'Flat $100 stake model', accent: true },
  { label: 'Signals Tracked', value: '—' },
  { label: 'Wins', value: '—' },
  { label: 'Losses', value: '—' },
];

function deriveMetrics(card: ApiCard): Metric[] {
  const ts = card.totalStats;
  return [
    {
      label: 'Net Return',
      value: ts.totalReturnPct == null ? '—' : formatPct(ts.totalReturnPct),
      sub: 'Flat $100 stake model',
      accent: true,
    },
    { label: 'Signals Tracked', value: String(ts.resolvedCount) },
    { label: 'Wins', value: String(ts.wonCount) },
    { label: 'Losses', value: String(ts.lostCount) },
  ];
}

function toChartPoints(card: ApiCard): ChartPoint[] {
  const pts = card.paywallChart?.points ?? [];
  if (pts.length === 0) return [];
  return [
    { day: 'Start', value: 0 },
    ...pts.map((p) => ({ day: `#${p.index}`, value: p.cumulativeReturnPct })),
  ];
}

// ── Chart geometry ────────────────────────────────────────────────────────────────

const CHART = { vbW: 320, vbH: 184, left: 44, right: 306, top: 18, bottom: 150 };

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

function CumulativeReturnChart({ points }: { points: ChartPoint[] }) {
  const count = points.length;
  const { left, right, top, bottom } = CHART;

  // Dynamic vertical domain so real returns never overflow the canvas.
  const vals = points.map((p) => p.value);
  const vMax = Math.max(Math.max(0, ...vals) + 4, 4);
  const vMin = Math.min(Math.min(0, ...vals) - 4, -4);

  const x = (i: number) => left + (i / (count - 1)) * (right - left);
  const y = (v: number) => top + ((vMax - v) / (vMax - vMin)) * (bottom - top);

  const linePoints = points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const areaPoints = `${x(0)},${bottom} ${linePoints} ${x(count - 1)},${bottom}`;
  const yLabels = [0, 1, 2, 3].map((k) => Math.round(vMax - (k / 3) * (vMax - vMin)));
  const endIdx = count - 1;
  const endX = x(endIdx);
  const endY = y(points[endIdx].value);
  const endLabel = formatPct(points[endIdx].value);

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
        const gy = y(v);
        return (
          <g key={v}>
            <line
              x1={left}
              y1={gy}
              x2={right}
              y2={gy}
              stroke="rgba(150,200,225,0.14)"
              strokeWidth="1"
              strokeDasharray="3,4"
            />
            <text x={left - 8} y={gy + 3.5} fontSize="10" fill="rgba(160,200,225,0.62)" textAnchor="end">
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
        <circle key={p.day} cx={x(i)} cy={y(p.value)} r="3.2" fill="#0a1320" stroke="#5eeab4" strokeWidth="2" />
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
  return status === 'Hit' ? styles.stHit : styles.stMiss;
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
  const [store, setStore] = useState<Record<TrackWindow, WindowState>>({
    '7D': { loading: true, error: false, data: null },
    '14D': { loading: true, error: false, data: null },
  });

  useEffect(() => {
    let cancelled = false;
    const load = async (w: TrackWindow) => {
      try {
        const res = await fetch(
          `/api/signals/resolved?mode=latest&days=${WINDOW_DAYS[w]}&limit=25`,
          { cache: 'no-store' }
        );
        const json = await res.json();
        const card = json?.weekResultsCard as ApiCard | undefined;
        if (!res.ok || !json?.ok || !card) throw new Error('bad response');
        if (!cancelled) setStore((p) => ({ ...p, [w]: { loading: false, error: false, data: card } }));
      } catch {
        if (!cancelled) setStore((p) => ({ ...p, [w]: { loading: false, error: true, data: null } }));
      }
    };
    load('7D');
    load('14D');
    return () => { cancelled = true; };
  }, []);

  const cur = store[active];
  const card = cur.data;
  const metrics = card ? deriveMetrics(card) : PLACEHOLDER_METRICS;
  const chartPoints = card ? toChartPoints(card) : [];
  const ledger = card?.ledgerPreview ?? [];

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
            Wins and losses stay visible across the selected tracking window.
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

        {/* Cumulative Return chart card */}
        <div className={styles.chartCard}>
          <div className={styles.chartTitle}>Cumulative Return</div>
          <div className={styles.chartSub}>
            <span className={styles.chartSubDot} aria-hidden="true" />
            Flat $100 per resolved signal
          </div>
          {chartPoints.length >= 2 ? (
            <CumulativeReturnChart points={chartPoints} />
          ) : (
            <div className={styles.chartEmpty}>
              {cur.loading ? 'Loading tracking data…' : cur.error ? 'Tracking data unavailable' : 'Tracking in progress'}
            </div>
          )}
          <div className={styles.chartDisclaimer}>Performance does not guarantee future results.</div>
        </div>

        {/* Recent Signal Ledger */}
        <div className={styles.ledgerCard}>
          <div className={styles.ledgerHead}>
            <div className={styles.ledgerTitle}>Recent Signal Ledger</div>
            {card && <span className={styles.ledgerViewAll}>{card.ledgerPreviewLabel}</span>}
          </div>

          <div className={styles.ledgerTable} role="table">
            <div className={`${styles.ledgerRow} ${styles.ledgerColHead}`} role="row">
              <span className={styles.colDate}>Date</span>
              <span className={styles.colMatch}>Match</span>
              <span className={styles.colStatus}>Status</span>
              <span className={styles.colReturn}>Return</span>
            </div>

            {cur.loading ? (
              [0, 1, 2, 3].map((i) => (
                <div key={`sk-${i}`} className={`${styles.ledgerRow} ${styles.ledgerLoadingRow}`} role="row" aria-hidden="true">
                  <span className={styles.skBar} />
                  <span className={styles.skBar} />
                  <span className={styles.skBar} />
                  <span className={styles.skBar} />
                </div>
              ))
            ) : ledger.length === 0 ? (
              <div className={styles.ledgerEmpty} role="row">
                {cur.error ? 'Tracking data unavailable' : 'Tracking in progress'}
              </div>
            ) : (
              ledger.map((row) => (
                <div key={`${row.resolvedAt}-${row.eventTitle}`} className={styles.ledgerRow} role="row">
                  <span className={styles.colDate}>{row.date}</span>
                  <span className={styles.colMatch} title={row.eventTitle}>{row.eventTitle}</span>
                  <span className={styles.colStatus}>
                    <span className={`${styles.statusPill} ${statusClass(row.status)}`}>{row.status}</span>
                  </span>
                  <span className={`${styles.colReturn} ${returnClass(row.returnLabel)}`}>{row.returnLabel}</span>
                </div>
              ))
            )}
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
        </div>
      </div>
    </section>
  );
}
