'use client';

import { useState, useEffect, useMemo } from 'react';
import styles from './WhyTrustSection.module.css';

interface LedgerRow {
  date: string;
  eventTitle: string;
  status: 'Hit' | 'Miss';
  returnLabel: string;
  returnPct: number;
  resolvedAt: string;
  metricFormulaVersion: string | null;
}

interface TotalStats {
  resolvedCount: number;
  wonCount: number;
  lostCount: number;
  pushCount: number;
  winRatePct: number | null;
  totalReturnPct: number | null;
}

interface ChartPoint {
  index: number;
  resolvedAt: string;
  result: 'won' | 'lost';
  returnPct: number;
  cumulativeReturnPct: number;
  label: string;
}

interface WeekCard {
  window: { label: string; days: number };
  totalStats: TotalStats;
  ledgerPreview: LedgerRow[];
  ledgerPreviewLabel: string;
  ledgerAll: LedgerRow[];
  ledgerAllLabel: string;
  paywallChart: {
    points: ChartPoint[];
    finalReturnPct: number | null;
  };
}

// ── Mini SVG chart ────────────────────────────────────────────────────────────

const SVG_W = 280;
const SVG_H = 72;
const PAD_X = 10;
const PAD_Y_TOP = 10;
const PAD_Y_BOT = 10;
const MARGIN = 0.15;

function buildChartFromRows(rows: LedgerRow[]): { d: string; isPos: boolean }[] {
  if (rows.length === 0) return [];
  let running = 0;
  const pts: { x: number; y: number; isPos: boolean }[] = [{ x: 0, y: 0, isPos: true }];
  rows.forEach((r, i) => {
    running += r.returnPct;
    pts.push({ x: i + 1, y: running, isPos: running >= 0 });
  });

  const vals = pts.map((p) => p.y);
  const rawMin = Math.min(0, ...vals);
  const rawMax = Math.max(0, ...vals);
  const rng = rawMax - rawMin || 1;
  const dMin = rawMin - rng * MARGIN;
  const dMax = rawMax + rng * MARGIN;
  const dRng = dMax - dMin;
  const n = pts.length;

  const toX = (i: number) => PAD_X + (i / Math.max(n - 1, 1)) * (SVG_W - PAD_X * 2);
  const toY = (v: number) =>
    SVG_H - PAD_Y_BOT - ((v - dMin) / dRng) * (SVG_H - PAD_Y_TOP - PAD_Y_BOT);

  const vis = pts.map((p, i) => ({ ...p, vx: toX(i), vy: toY(p.y) }));

  const segments: { d: string; isPos: boolean }[] = [];
  for (let i = 1; i < vis.length; i++) {
    const prev = vis[i - 1];
    const cur = vis[i];
    segments.push({
      d: `M${prev.vx.toFixed(1)} ${prev.vy.toFixed(1)} L${cur.vx.toFixed(1)} ${cur.vy.toFixed(1)}`,
      isPos: cur.isPos,
    });
  }
  return segments;
}

function MiniChart({ rows }: { rows: LedgerRow[] }) {
  const segments = useMemo(() => buildChartFromRows(rows), [rows]);
  if (segments.length === 0) {
    return <div className={styles.chartEmpty}>Building chart…</div>;
  }
  return (
    <svg
      className={styles.chartSvg}
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {segments.map((seg, i) => (
        <path
          key={i}
          d={seg.d}
          className={seg.isPos ? styles.linePos : styles.lineNeg}
        />
      ))}
    </svg>
  );
}

// ── Metrics strip ─────────────────────────────────────────────────────────────

interface MetricCardProps {
  label: string;
  value: string;
  isPositive?: boolean;
}

function MetricCard({ label, value, isPositive }: MetricCardProps) {
  return (
    <div className={styles.metricCard}>
      <span className={styles.metricLabel}>{label}</span>
      <span
        className={[
          styles.metricValue,
          isPositive === true ? styles.metricPos : '',
          isPositive === false ? styles.metricNeg : '',
        ]
          .join(' ')
          .trim()}
      >
        {value}
      </span>
    </div>
  );
}

// ── Ledger table ──────────────────────────────────────────────────────────────

function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  if (rows.length === 0) {
    return <div className={styles.ledgerEmpty}>No resolved calls in this window yet.</div>;
  }
  return (
    <table className={styles.ledgerTable} aria-label="Signal ledger">
      <thead>
        <tr>
          <th>Date</th>
          <th>Event</th>
          <th>Result</th>
          <th>Return</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.status === 'Hit' ? styles.rowHit : styles.rowMiss}>
            <td className={styles.cellDate}>{r.date}</td>
            <td className={styles.cellEvent}>{r.eventTitle}</td>
            <td className={styles.cellStatus}>
              <span className={r.status === 'Hit' ? styles.tagHit : styles.tagMiss}>
                {r.status === 'Hit' ? '✓' : '✕'} {r.status}
              </span>
            </td>
            <td className={[styles.cellReturn, r.status === 'Hit' ? styles.metricPos : styles.metricNeg].join(' ')}>
              {r.returnLabel}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WhyTrustSection() {
  const [windowDays, setWindowDays] = useState<7 | 14>(7);
  const [ledgerMode, setLedgerMode] = useState<'preview' | 'all'>('preview');
  const [card, setCard] = useState<WeekCard | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setLedgerMode('preview');
    fetch(`/api/signals/resolved?mode=latest&days=${windowDays}&limit=25`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.ok && json.weekResultsCard) {
          setCard(json.weekResultsCard as WeekCard);
        } else {
          setCard(null);
        }
      })
      .catch(() => setCard(null))
      .finally(() => setLoading(false));
  }, [windowDays]);

  const visibleRows = useMemo(() => {
    if (!card) return [];
    return ledgerMode === 'all' ? card.ledgerAll : card.ledgerPreview;
  }, [card, ledgerMode]);

  // Metrics
  const metrics = useMemo(() => {
    if (!card) return null;
    if (ledgerMode === 'all') {
      const net = card.totalStats.totalReturnPct;
      return {
        wins: card.totalStats.wonCount,
        losses: card.totalStats.lostCount,
        netReturn: net !== null ? (net >= 0 ? `+${net}%` : `${net}%`) : '—',
        netIsPos: net !== null ? net >= 0 : undefined,
        signalsTracked: card.totalStats.resolvedCount,
      };
    }
    // Preview mode: compute from visible preview rows
    const wins = visibleRows.filter((r) => r.status === 'Hit').length;
    const losses = visibleRows.filter((r) => r.status === 'Miss').length;
    const sum = Math.round(visibleRows.reduce((acc, r) => acc + r.returnPct, 0) * 10) / 10;
    return {
      wins,
      losses,
      netReturn: sum >= 0 ? `+${sum}%` : `${sum}%`,
      netIsPos: sum >= 0,
      signalsTracked: card.totalStats.resolvedCount,
    };
  }, [card, ledgerMode, visibleRows]);

  const ledgerLabel = useMemo(() => {
    if (!card) return '';
    return ledgerMode === 'all' ? card.ledgerAllLabel : card.ledgerPreviewLabel;
  }, [card, ledgerMode]);

  return (
    <section className={styles.section} aria-label="Verified Track Record">
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.liveDot} aria-hidden="true" />
          <h2 className={styles.title}>Verified Track Record</h2>
        </div>
        <div
          className={styles.windowToggle}
          role="group"
          aria-label="Track record range"
        >
          <button
            className={[styles.toggleBtn, windowDays === 7 ? styles.toggleActive : ''].join(' ')}
            onClick={() => setWindowDays(7)}
            aria-pressed={windowDays === 7}
          >
            7D
          </button>
          <button
            className={[styles.toggleBtn, windowDays === 14 ? styles.toggleActive : ''].join(' ')}
            onClick={() => setWindowDays(14)}
            aria-pressed={windowDays === 14}
          >
            14D
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.skeleton}>
          <div className={styles.skeletonMetrics} />
          <div className={styles.skeletonChart} />
          <div className={styles.skeletonTable} />
        </div>
      ) : !card || !metrics ? (
        <div className={styles.empty}>
          No resolved signals in this window yet. Check back soon.
        </div>
      ) : (
        <>
          <div className={styles.metricsRow}>
            <MetricCard label="Wins" value={String(metrics.wins)} isPositive={metrics.wins > 0} />
            <MetricCard label="Losses" value={String(metrics.losses)} />
            <MetricCard
              label="Net Return"
              value={metrics.netReturn}
              isPositive={metrics.netIsPos}
            />
            <MetricCard label="Signals Tracked" value={String(metrics.signalsTracked)} />
          </div>

          <div className={styles.chartWrap}>
            <MiniChart rows={visibleRows} />
          </div>

          <div className={styles.ledgerHeader}>
            <span className={styles.ledgerTitle}>Recent Signal Ledger</span>
            <button
              className={styles.modeBtn}
              onClick={() => setLedgerMode((m) => (m === 'preview' ? 'all' : 'preview'))}
              aria-pressed={ledgerMode === 'all'}
            >
              {ledgerMode === 'preview' ? 'All' : 'Preview'}
            </button>
          </div>
          <p className={styles.ledgerMeta}>{ledgerLabel}</p>

          <div className={styles.ledgerWrap}>
            <LedgerTable rows={visibleRows} />
          </div>
        </>
      )}
    </section>
  );
}
