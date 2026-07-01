'use client';

// components/why-trust/WhyTrustSection.tsx
// "Why Can I Trust This?" — client component · 7D/14D toggle.
// Fetches /api/signals/resolved (mode=latest) for both windows and renders the
// weekResultsCard contract, sourced from public.track_record_display_signals.
// Projected values only — no resolved won/lost ledger, no fake/model odds.

import { useEffect, useState } from 'react';
import styles from './WhyTrustSection.module.css';
import type { WeekResultsCard, TrackRecordRow } from '@/components/signal-week-results/types';

// ── Types ───────────────────────────────────────────────────────────────────────

type TrackWindow = '7D' | '14D';
type WindowState = { loading: boolean; error: boolean; data: WeekResultsCard | null };

const WINDOW_DAYS: Record<TrackWindow, number> = { '7D': 7, '14D': 14 };

const METHODOLOGY_RULES: string[] = [
  'Signals are locked and scored before the market resolves.',
  'Performance reflects a flat $100 stake per published signal.',
  'Metrics are aggregated across every published signal in the selected window.',
  'Return and win-rate figures are projected from entry odds, not resolved outcomes.',
  'Odds are sourced directly from Polymarket at signal publish time.',
  'Past performance does not guarantee future results.',
];

// ── Derivations ───────────────────────────────────────────────────────────────

function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function fmtUsd(value: number): string {
  const r = Math.round(value * 100) / 100;
  return (r >= 0 ? '+$' : '-$') + Math.abs(r).toFixed(2);
}

type Metric = { label: string; value: string; sub?: string; accent?: boolean };

const PLACEHOLDER_METRICS: Metric[] = [
  { label: 'Projected Return', value: '—', sub: 'Flat $100 stake model', accent: true },
  { label: 'Signals Published', value: '—' },
  { label: 'Projected Rate', value: '—' },
  { label: 'Avg Odds', value: '—' },
];

function deriveMetrics(card: WeekResultsCard): Metric[] {
  return [
    {
      label: 'Projected Return',
      value: fmtPct(card.projectedRoiPct),
      sub: 'Flat $100 stake model',
      accent: true,
    },
    { label: 'Signals Published', value: String(card.selectedSignals) },
    { label: 'Projected Rate', value: `${card.projectedWinRatePct.toFixed(1)}%` },
    { label: 'Avg Odds', value: card.avgDecimalOdds.toFixed(2) },
  ];
}

function getRows(card: WeekResultsCard): TrackRecordRow[] {
  const table = card.trackRecordDisplayTable as unknown;
  return Array.isArray(table)
    ? (table as TrackRecordRow[])
    : ((table as { rows?: TrackRecordRow[] } | null | undefined)?.rows ?? []);
}

type ChartPoint = { day: string; cumUsd: number };

function toChartPoints(rows: TrackRecordRow[]): ChartPoint[] {
  if (rows.length === 0) return [];
  const chronological = [...rows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  let running = 0;
  return [
    { day: 'Start', cumUsd: 0 },
    ...chronological.map((r, i) => {
      running = Math.round((running + r.projectedReturnUsd) * 100) / 100;
      return { day: `#${i + 1}`, cumUsd: running };
    }),
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

  const vals = points.map((p) => p.cumUsd);
  const vMax = Math.max(Math.max(0, ...vals) + 4, 4);
  const vMin = Math.min(Math.min(0, ...vals) - 4, -4);

  const x = (i: number) => left + (i / (count - 1)) * (right - left);
  const y = (v: number) => top + ((vMax - v) / (vMax - vMin)) * (bottom - top);

  const linePoints = points.map((p, i) => `${x(i)},${y(p.cumUsd)}`).join(' ');
  const areaPoints = `${x(0)},${bottom} ${linePoints} ${x(count - 1)},${bottom}`;
  const yLabels = [0, 1, 2, 3].map((k) => Math.round(vMax - (k / 3) * (vMax - vMin)));
  const endIdx = count - 1;
  const endX = x(endIdx);
  const endY = y(points[endIdx].cumUsd);
  const endLabel = fmtUsd(points[endIdx].cumUsd);

  return (
    <svg viewBox={`0 0 ${CHART.vbW} ${CHART.vbH}`} className={styles.chartSvg} role="img" aria-label="Cumulative return chart">
      <defs>
        <linearGradient id="wtChartFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(94,234,180,0.30)" />
          <stop offset="100%" stopColor="rgba(94,234,180,0.02)" />
        </linearGradient>
      </defs>

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
              ${v}
            </text>
          </g>
        );
      })}

      <polygon points={areaPoints} fill="url(#wtChartFill)" />
      <polyline
        points={linePoints}
        fill="none"
        stroke="#5eeab4"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {points.map((p, i) => (
        <circle key={p.day} cx={x(i)} cy={y(p.cumUsd)} r="3.2" fill="#0a1320" stroke="#5eeab4" strokeWidth="2" />
      ))}

      <g>
        <rect x={endX - 30} y={endY - 26} width="56" height="18" rx="9" fill="rgba(94,234,180,0.16)" stroke="rgba(94,234,180,0.55)" strokeWidth="1" />
        <text x={endX - 2} y={endY - 13} fontSize="11" fontWeight="700" fill="#7bf3c4" textAnchor="middle">
          {endLabel}
        </text>
      </g>
    </svg>
  );
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
        const card = json?.weekResultsCard as WeekResultsCard | undefined;
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
  const rows = card ? getRows(card) : [];
  const chartPoints = toChartPoints(rows);

  return (
    <section className={styles.section} aria-label="Why can I trust this">
      <div className={styles.container}>
        <div className={styles.introCard}>
          <ShieldBadge />
          <h2 className={styles.title}>Why Can I Trust This?</h2>
          <p className={styles.lead}>
            Every published signal is locked and timestamped before the market settles.
          </p>
          <p className={styles.leadAccent}>
            Projected performance stays visible across the selected tracking window.
          </p>
          <div className={styles.introDivider} />
          <div className={styles.introFooter}>
            <svg viewBox="0 0 24 24" className={styles.introFooterIcon} aria-hidden="true">
              <path d="M12 2.8 19 5.7v5.1c0 5-3 8.7-7 10.4-4-1.7-7-5.4-7-10.4V5.7L12 2.8Z" stroke="currentColor" strokeWidth="1.6" fill="none" />
            </svg>
            <span>A structured performance view built for fast signal review.</span>
          </div>
        </div>

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

        <div className={styles.metricsGrid}>
          {metrics.map((m) => (
            <div key={m.label} className={styles.metricCard}>
              <div className={styles.metricLabel}>{m.label}</div>
              <div className={`${styles.metricValue} ${m.accent ? styles.metricValueAccent : ''}`}>{m.value}</div>
              {m.sub && <div className={styles.metricSub}>{m.sub}</div>}
            </div>
          ))}
        </div>

        <div className={styles.chartCard}>
          <div className={styles.chartTitle}>Cumulative Return</div>
          <div className={styles.chartSub}>
            <span className={styles.chartSubDot} aria-hidden="true" />
            Flat $100 per published signal
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

        <div className={styles.ledgerCard}>
          <div className={styles.ledgerHead}>
            <div className={styles.ledgerTitle}>Recent Signal Ledger</div>
            {card && <span className={styles.ledgerViewAll}>{card.window.label}</span>}
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
            ) : rows.length === 0 ? (
              <div className={styles.ledgerEmpty} role="row">
                {cur.error ? 'Tracking data unavailable' : 'Tracking in progress'}
              </div>
            ) : (
              rows.map((row) => (
                <div key={row.id} className={styles.ledgerRow} role="row">
                  <span className={styles.colDate}>{row.createdAt}</span>
                  <span className={styles.colMatch} title={row.eventTitle}>{row.eventTitle}</span>
                  <span className={styles.colStatus}>
                    <span className={`${styles.statusPill} ${styles.stPublished}`}>{row.status}</span>
                  </span>
                  <span className={`${styles.colReturn} ${returnClass(row.returnLabel)}`}>{row.returnLabel}</span>
                </div>
              ))
            )}
          </div>
        </div>

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
